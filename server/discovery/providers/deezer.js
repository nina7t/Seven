const axios = require('axios');
const CONFIG = require('../config');
const cache = require('../cache');
const { createNormalizedArtist } = require('../normalize');

const { DEEZER } = CONFIG.sources;

function apiUrl(path) {
  return `${CONFIG.endpoints.deezer.apiBase}${path}`;
}

async function deezerGet(path) {
  const res = await axios.get(apiUrl(path), { timeout: CONFIG.sourceTimeoutMs });
  if (res.data?.error) throw new Error(res.data.error.message || 'Deezer API error');
  return res.data;
}

function rankArtistMatches(list, query) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const target = norm(query);
  const rank = a => {
    const n = norm(a.name);
    if (n === target) return 3;
    if (n.startsWith(target) || target.startsWith(n)) return 2;
    if (n.includes(target)) return 1;
    return 0;
  };
  return [...list].sort((a, b) => (rank(b) - rank(a)) || ((b.nbFan || 0) - (a.nbFan || 0)));
}

/**
 * Recherche un artiste par nom et retourne les meilleurs résultats.
 */
async function searchArtists(name) {
  const cacheKey = name.toLowerCase().trim();
  const cached = cache.get('search', cacheKey, DEEZER);
  if (cached) return cached;

  const data = await deezerGet(`/search/artist?q=${encodeURIComponent(name)}&limit=20`);
  let matches = (data?.data || [])
    .filter(a => a.name)
    .map(a => ({
      id: String(a.id),
      name: a.name,
      picture: a.picture_xl || a.picture_big || a.picture_medium || a.picture || null,
      nbFan: a.nb_fan || 0
    }));

  matches = rankArtistMatches(matches, name).slice(0, CONFIG.limits.search);

  return cache.set('search', cacheKey, DEEZER, matches);
}

/**
 * Récupère un artiste Deezer par son ID.
 */
async function findArtistById(id) {
  const cached = cache.get('search', String(id), 'deezer-by-id');
  if (cached) return cached;

  const data = await deezerGet(`/artist/${id}`);
  const result = {
    id: String(data.id),
    name: data.name,
    picture: data.picture_xl || data.picture_big || data.picture_medium || data.picture || null,
    nbFan: data.nb_fan || 0
  };

  return cache.set('search', String(id), 'deezer-by-id', result);
}

/**
 * Recherche l'artiste le plus probable par nom (même logique que le serveur
 * existant : correspondance exacte d'abord, puis notoriété).
 */
async function findArtist(name) {
  const matches = await searchArtists(name);
  if (!matches.length) return null;

  const target = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const rank = a => {
    const n = a.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (n === target) return 3;
    if (n.startsWith(target) || target.startsWith(n)) return 2;
    if (n.includes(target)) return 1;
    return 0;
  };

  return [...matches].sort((a, b) => (rank(b) - rank(a)) || (b.nbFan - a.nbFan))[0];
}

/**
 * Récupère les artistes apparentés d'un artiste Deezer par son ID.
 */
async function fetchSimilarArtistsById(artistId) {
  const cached = cache.get('similar', String(artistId), DEEZER);
  if (cached) return cached;

  const data = await deezerGet(`/artist/${artistId}/related?limit=${CONFIG.limits.similar}`);
  const results = (data?.data || [])
    .filter(a => a.name)
    .map((a, index) => createNormalizedArtist({
      name: a.name,
      image: a.picture_xl || a.picture_big || a.picture_medium || a.picture || null,
      source: DEEZER,
      ids: { deezer: String(a.id) },
      rank: index + 1,
      popularity: (a.nb_fan || 0) / 10_000_000 // normalisation grossière 0–1
    }));

  return cache.set('similar', String(artistId), DEEZER, results);
}

/**
 * Résout le nom d'artiste puis retourne ses similaires.
 */
async function fetchSimilarArtists(name) {
  const artist = await findArtist(name);
  if (!artist) return [];
  return fetchSimilarArtistsById(artist.id);
}

/**
 * Top tracks d'un artiste Deezer par ID.
 */
async function fetchTopTracks(artistId, limit = 5) {
  const cached = cache.get('search', String(artistId), 'deezer-toptracks');
  if (cached) return cached;

  const data = await deezerGet(`/artist/${artistId}/top?limit=${limit}`);
  const results = (data?.data || [])
    .filter(t => t.title && t.artist?.name)
    .map((t, index) => ({
      title: t.title,
      artist: t.artist.name,
      rank: index + 1,
      source: DEEZER,
      ids: { deezer: String(t.id) }
    }));

  return cache.set('search', String(artistId), 'deezer-toptracks', results);
}

module.exports = { searchArtists, findArtist, findArtistById, fetchSimilarArtistsById, fetchSimilarArtists, fetchTopTracks };
