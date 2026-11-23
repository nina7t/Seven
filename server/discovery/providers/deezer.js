const axios = require('axios');
const CONFIG = require('../config');
const cache = require('../cache');
const { withRetry } = require('../retry');
const { createNormalizedArtist } = require('../normalize');

const { DEEZER } = CONFIG.sources;

function apiUrl(path) {
  return `${CONFIG.endpoints.deezer.apiBase}${path}`;
}

async function deezerGet(path) {
  const res = await withRetry(() => axios.get(apiUrl(path), { timeout: CONFIG.sourceTimeoutMs }));
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
      ids: { deezer: String(t.id), albumDeezer: t.album?.id ? String(t.album.id) : null }
    }));

  return cache.set('search', String(artistId), 'deezer-toptracks', results);
}

/**
 * Genres Deezer d'un album (ex. « Rap/Hip Hop »), en minuscules. Deezer ne
 * donne pas de genre par artiste ni par titre : l'album est la seule porte.
 * Tableau vide si inconnu (compilation, album sans genre) : l'appelant ne doit
 * alors rien en déduire.
 */
async function fetchAlbumGenres(albumId) {
  if (!albumId) return [];
  const cached = cache.get('search', String(albumId), 'deezer-album-genres');
  if (cached) return cached;

  // Deezer répond « quota dépassé » en HTTP 200 quand plusieurs radios
  // démarrent en même temps : withRetry ne le voit pas (il ne gère que 429).
  // On réessaie ici, et un échec n'est jamais mis en cache (sinon le genre
  // resterait vide pour une heure).
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await deezerGet(`/album/${albumId}`);
      const genres = (data?.genres?.data || [])
        .map(g => String(g.name || '').trim().toLowerCase())
        .filter(Boolean);
      return cache.set('search', String(albumId), 'deezer-album-genres', genres);
    } catch (e) {
      lastError = e;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Union des genres de plusieurs albums (3 au plus). Un seul album est trop
 * bruité : un rappeur y est parfois classé « pop », une compilation n'a aucun
 * genre. Les albums en échec sont ignorés.
 */
async function fetchGenresOfAlbums(albumIds) {
  const ids = [...new Set((albumIds || []).filter(Boolean))].slice(0, 3);
  const groups = await Promise.all(ids.map(id => fetchAlbumGenres(id).catch(() => [])));
  return [...new Set(groups.flat())];
}

/**
 * Genres d'un artiste, déduits des albums de ses top titres.
 */
async function fetchArtistGenres(artistId) {
  if (!artistId) return [];
  const tracks = await fetchTopTracks(artistId, 5);
  return fetchGenresOfAlbums(tracks.map(t => t.ids?.albumDeezer));
}

/**
 * Récupère l'ISRC d'un titre Deezer. La recherche ne le renvoie pas, il faut
 * interroger /track/{id}. C'est notre seule passerelle vers TIDAL, dont la
 * recherche texte n'est pas ouverte à notre palier d'API.
 */
async function fetchTrackIsrc(trackId) {
  if (!trackId) return null;
  const cached = cache.get('search', String(trackId), 'deezer-isrc');
  if (cached !== undefined) return cached; // null autorisé (titre sans ISRC)

  const data = await deezerGet(`/track/${trackId}`);
  const isrc = data?.isrc ? String(data.isrc).trim().toUpperCase() : null;
  return cache.set('search', String(trackId), 'deezer-isrc', isrc);
}

module.exports = { searchArtists, findArtist, findArtistById, fetchSimilarArtistsById, fetchSimilarArtists, fetchTopTracks, fetchAlbumGenres, fetchGenresOfAlbums, fetchArtistGenres, fetchTrackIsrc };
