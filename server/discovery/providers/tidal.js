const axios = require('axios');
const CONFIG = require('../config');
const { getAccessToken, authHeaders } = require('./tidal-auth');
const cache = require('../cache');
const { withRetry } = require('../retry');
const { createNormalizedArtist } = require('../normalize');

const { TIDAL } = CONFIG.sources;
const CC = CONFIG.countryCode;

function apiUrl(path) {
  return `${CONFIG.endpoints.tidal.apiBase}${path}`;
}

// TIDAL limite le débit assez bas : 8 appels lancés en parallèle déclenchent
// des 429, et le backoff de withRetry fait alors dépasser le budget de 4 s.
// On sérialise donc les requêtes avec un intervalle minimal — en série chaque
// appel tient en ~200 ms, ce qui reste largement dans le budget.
// 150 ms est le seuil mesuré : en dessous on récolte des 429, au-dessus on
// paie de la latence pour rien.
const MIN_INTERVAL_MS = 150;
let gate = Promise.resolve();
let lastCallAt = 0;

function schedule(fn) {
  const run = gate.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  // La file ne doit pas se rompre sur une erreur : on la relance à vide.
  gate = run.then(() => undefined, () => undefined);
  return run;
}

async function tidalGet(path) {
  const token = await getAccessToken();
  // withRetry enveloppe schedule, et non l'inverse : ainsi le backoff d'un 429
  // se fait hors du verrou, sans bloquer les requêtes qui attendent derrière.
  const res = await withRetry(() => schedule(() => axios.get(apiUrl(path), {
    headers: authHeaders(token),
    timeout: CONFIG.sourceTimeoutMs
  })));
  return res.data;
}

/**
 * L'API TIDAL est JSON:API : le document renvoie { data, included, links }.
 * Les relations vivent dans `data.relationships`, et les ressources liées
 * sont à plat dans `included` — à recoller par (type, id).
 */
function includedIndex(doc) {
  const map = new Map();
  (doc?.included || []).forEach(item => map.set(`${item.type}:${item.id}`, item));
  return map;
}

function relationIds(doc, relationName) {
  const rel = doc?.data?.relationships?.[relationName]?.data;
  if (!Array.isArray(rel)) return rel ? [rel] : [];
  return rel;
}

/**
 * Résout un artiste TIDAL à partir de l'ISRC d'un de ses titres.
 *
 * La recherche texte (`/searchResults/{query}`) répond 400 avec nos
 * credentials client-credentials, et `filter[handle]` ne marche que pour les
 * profils d'artistes revendiqués (Daft Punk n'a pas de handle). L'ISRC est
 * donc le seul point d'entrée fiable — il vient de Deezer.
 *
 * @param {string} isrc
 * @param {string} [preferredName] — pour choisir l'artiste principal parmi les crédités
 * @returns {Promise<{id: string, name: string, popularity: number}|null>}
 */
async function resolveArtistByIsrc(isrc, preferredName = '') {
  if (!isrc) return null;
  const cacheKey = `isrc:${isrc}`;
  const cached = cache.get('search', cacheKey, TIDAL);
  if (cached !== undefined) return cached; // null autorisé (ISRC inconnu de TIDAL)

  const doc = await tidalGet(`/tracks?countryCode=${CC}&filter[isrc]=${encodeURIComponent(isrc)}&include=artists`);
  const artists = (doc?.included || []).filter(i => i.type === 'artists');
  if (!artists.length) return cache.set('search', cacheKey, TIDAL, null);

  const wanted = String(preferredName || '').toLowerCase().trim();
  const exact = wanted && artists.find(a => String(a.attributes?.name || '').toLowerCase().trim() === wanted);
  // À défaut d'un nom exact, l'artiste le plus populaire est le principal :
  // les featurings et producteurs crédités sont systématiquement en dessous.
  const best = exact || artists
    .slice()
    .sort((a, b) => (b.attributes?.popularity || 0) - (a.attributes?.popularity || 0))[0];

  const result = {
    id: best.id,
    name: best.attributes?.name || preferredName,
    popularity: best.attributes?.popularity ?? null
  };
  return cache.set('search', cacheKey, TIDAL, result);
}

/**
 * Artistes similaires TIDAL pour un artiste identifié par son ID.
 */
async function fetchSimilarArtists(artistId) {
  if (!artistId) return [];
  const cached = cache.get('similar', artistId, TIDAL);
  if (cached) return cached;

  const doc = await tidalGet(`/artists/${encodeURIComponent(artistId)}?countryCode=${CC}&include=similarArtists`);
  const byId = includedIndex(doc);

  const results = relationIds(doc, 'similarArtists').map((ref, index) => {
    const attrs = byId.get(`${ref.type}:${ref.id}`)?.attributes || {};
    return createNormalizedArtist({
      name: attrs.name || `Artist ${ref.id}`,
      image: null, // les images TIDAL demandent un appel artworks supplémentaire
      source: TIDAL,
      ids: { tidal: ref.id },
      rank: index + 1,
      popularity: attrs.popularity ?? null
    });
  }).filter(a => a.name);

  return cache.set('similar', artistId, TIDAL, results);
}

/**
 * Titres d'un artiste, triés par popularité décroissante.
 * `collapseBy=NONE` est obligatoire : sans lui l'API répond 400.
 */
async function fetchTopTracks(artistId, limit = 5) {
  if (!artistId) return [];
  const cacheKey = `top:${artistId}`;
  const cached = cache.get('search', cacheKey, TIDAL);
  if (cached) return cached.slice(0, limit);

  const doc = await tidalGet(
    `/artists/${encodeURIComponent(artistId)}/relationships/tracks?countryCode=${CC}&collapseBy=NONE&include=tracks`
  );

  const tracks = (doc?.included || [])
    .filter(i => i.type === 'tracks' && i.attributes?.title)
    .sort((a, b) => (b.attributes?.popularity || 0) - (a.attributes?.popularity || 0))
    .map((t, index) => ({
      title: t.attributes.title,
      rank: index + 1,
      source: TIDAL,
      popularity: t.attributes.popularity ?? null,
      duration: isoDurationToSeconds(t.attributes.duration),
      ids: { tidal: t.id, isrc: t.attributes.isrc || null }
    }));

  cache.set('search', cacheKey, TIDAL, tracks);
  return tracks.slice(0, limit);
}

/**
 * Convertit une durée ISO 8601 (PT5M20S) en secondes.
 */
function isoDurationToSeconds(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
}

module.exports = {
  isConfigured: require('./tidal-auth').isConfigured,
  resolveArtistByIsrc,
  fetchSimilarArtists,
  fetchTopTracks,
  isoDurationToSeconds
};
