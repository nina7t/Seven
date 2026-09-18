const axios = require('axios');
const CONFIG = require('../config');
const { getAccessToken, authHeaders } = require('./tidal-auth');
const cache = require('../cache');
const { createNormalizedArtist } = require('../normalize');

const { TIDAL } = CONFIG.sources;

function apiUrl(path) {
  return `${CONFIG.endpoints.tidal.apiBase}${path}`;
}

/**
 * Résout un artiste TIDAL par son handle (nom sans espaces, sans majuscules accent).
 * Retourne { id, name } ou null.
 */
async function findArtist(name) {
  const token = await getAccessToken();
  const handle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const url = apiUrl(`/artists?filter[handle]=${encodeURIComponent(handle)}&countryCode=${CONFIG.countryCode}`);
  const res = await axios.get(url, { headers: authHeaders(token), timeout: CONFIG.sourceTimeoutMs });
  const data = res.data?.data || [];
  if (!data.length) return null;
  return { id: data[0].id, name: data[0].attributes?.name || name };
}

/**
 * Récupère les artistes similaires TIDAL pour un artiste identifié par son ID.
 * La documentation TIDAL v2 expose `similarArtists` via `?include=similarArtists`.
 */
async function fetchSimilarArtists(artistId) {
  const cached = cache.get('similar', artistId, TIDAL);
  if (cached) return cached;

  const token = await getAccessToken();
  const url = apiUrl(`/artists/${encodeURIComponent(artistId)}?countryCode=${CONFIG.countryCode}&include=similarArtists`);
  const res = await axios.get(url, { headers: authHeaders(token), timeout: CONFIG.sourceTimeoutMs });

  const similarData = res.data?.relationships?.similarArtists?.data || [];
  const included = res.data?.included || [];
  const includedById = new Map(included.map(item => [`${item.type}:${item.id}`, item]));

  const results = similarData.map((rel, index) => {
    const artist = includedById.get(`${rel.type}:${rel.id}`);
    const attrs = artist?.attributes || {};
    return createNormalizedArtist({
      name: attrs.name || `Artist ${rel.id}`,
      image: null, // les images TIDAL nécessitent un appel artworks supplémentaire
      source: TIDAL,
      ids: { tidal: rel.id },
      rank: index + 1,
      popularity: attrs.popularity != null ? attrs.popularity : null
    });
  });

  return cache.set('similar', artistId, TIDAL, results);
}

/**
 * Cherche un artiste par nom via les endpoints publics TIDAL, puis retourne
 * les similaires. Si la résolution échoue, retourne un tableau vide.
 */
async function searchAndSimilar(name) {
  const artist = await findArtist(name);
  if (!artist) return [];
  return fetchSimilarArtists(artist.id);
}

module.exports = { isConfigured: require('./tidal-auth').isConfigured, findArtist, fetchSimilarArtists, searchAndSimilar };
