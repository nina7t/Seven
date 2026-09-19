const axios = require('axios');
const CONFIG = require('./config');
const cache = require('./cache');
const deezer = require('./providers/deezer');
const lastfm = require('./providers/lastfm');
const { normalizeForDedupe } = require('./normalize');

const DEEZER = CONFIG.sources.DEEZER;
const LASTFM = CONFIG.sources.LASTFM;
const TIMEOUT = CONFIG.radio.sourceTimeoutMs;

/**
 * Clé de dédoublonnage titre + artiste.
 */
function trackTitleKey(title, artist) {
  return `${normalizeForDedupe(artist || '')}|${normalizeForDedupe(title || '')}`;
}

function normalizeSeed(input) {
  return {
    title: String(input.title || '').trim(),
    artist: String(input.artist || '').trim(),
    album: input.album ? String(input.album).trim() : null,
    year: input.year ? parseInt(input.year, 10) || null : null
  };
}

async function withTimeout(promise, ms = TIMEOUT) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
  return Promise.race([promise, timeout]);
}

function rankDeezerTrackMatch(track, seed) {
  const targetTitle = normalizeForDedupe(seed.title || '');
  const targetArtist = normalizeForDedupe(seed.artist || '');
  const trackTitle = normalizeForDedupe(track.title || '');
  const trackArtist = normalizeForDedupe(track.artist?.name || '');

  if (!targetTitle || !trackTitle || !trackArtist) return 0;

  const titleExact = trackTitle === targetTitle;
  const artistExact = trackArtist === targetArtist;
  const titleIncludes = targetTitle && trackTitle.includes(targetTitle);
  const artistIncludes = targetArtist && (trackArtist.includes(targetArtist) || targetArtist.includes(trackArtist));

  if (titleExact && artistExact) return 4;
  if (titleExact && artistIncludes) return 3;
  if (titleIncludes && artistExact) return 2;
  if (titleIncludes && artistIncludes) return 1;
  return 0;
}

function selectBestDeezerTrack(tracks, seed) {
  const ranked = tracks
    .map(t => ({ track: t, score: rankDeezerTrackMatch(t, seed) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (b.track.rank || 0) - (a.track.rank || 0));

  return ranked.length ? ranked[0].track : null;
}

/**
 * Recherche le titre sur Deezer pour obtenir ID, BPM, année, album.
 */
async function resolveDeezerTrack(seed) {
  const cacheKey = trackTitleKey(seed.title, seed.artist);
  const cached = cache.get('search', cacheKey, 'deezer-track');
  if (cached) return cached;

  try {
    // Syntaxe `track:"..." artist:"..."` est souvent vide côté Deezer ; on
    // utilise une requête simple classée par pertinence, puis on filtre localement.
    const q = `${seed.artist} ${seed.title}`;
    const url = `${CONFIG.endpoints.deezer.apiBase}/search/track?q=${encodeURIComponent(q)}&limit=20`;
    const res = await withTimeout(axios.get(url, { timeout: TIMEOUT }));
    const tracks = (res.data?.data || []).filter(t => t.title && t.artist?.name);
    if (!tracks.length) return null;

    const best = selectBestDeezerTrack(tracks, seed);
    if (!best) return null;

    const result = {
      source: DEEZER,
      title: best.title,
      artist: best.artist.name,
      album: best.album?.title || null,
      year: best.album?.release_date ? parseInt(best.album.release_date.split('-')[0], 10) || null : null,
      ids: {
        deezer: String(best.id),
        artistDeezer: best.artist?.id ? String(best.artist.id) : null,
        albumDeezer: best.album?.id ? String(best.album.id) : null
      },
      bpm: best.bpm ? parseInt(best.bpm, 10) || null : null,
      duration: best.duration || null,
      rank: best.rank || null,
      image: best.album?.cover_xl || best.album?.cover_big || best.album?.cover || null
    };
    return cache.set('search', cacheKey, 'deezer-track', result);
  } catch (e) {
    console.warn('[seed] Deezer track failed:', e.message);
    return null;
  }
}

/**
 * Résout l'artiste sur Deezer pour avoir un ID stable et une image.
 */
async function resolveDeezerArtist(artistName) {
  try {
    const found = await deezer.findArtist(artistName);
    if (!found) return null;
    return {
      name: found.name,
      id: found.id,
      image: found.picture,
      nbFan: found.nbFan || 0
    };
  } catch (e) {
    console.warn('[seed] Deezer artist failed:', e.message);
    return null;
  }
}

/**
 * Résout le MBID du titre via MusicBrainz (repli gratuit, pas de clé).
 */
async function resolveMusicBrainzId(seed) {
  const cacheKey = trackTitleKey(seed.title, seed.artist);
  const cached = cache.get('search', cacheKey, 'mbid');
  if (cached !== undefined) return cached; // null autorisé

  try {
    const q = `recording:${seed.title} AND artist:${seed.artist}`;
    const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(q)}&fmt=json&limit=1`;
    const res = await withTimeout(axios.get(url, {
      headers: { 'User-Agent': 'SevenzRadio/1.0 (contact@sevenz.app)' },
      timeout: TIMEOUT
    }));
    const rec = res.data?.recordings?.[0];
    const mbid = rec?.id || null;
    return cache.set('search', cacheKey, 'mbid', mbid);
  } catch (e) {
    console.warn('[seed] MusicBrainz failed:', e.message);
    return cache.set('search', cacheKey, 'mbid', null);
  }
}

function topTags(trackTags, artistTags, limit = 5) {
  const map = new Map();
  (trackTags || []).forEach((t, i) => {
    const score = (t.count || 100 - i) * 2; // les tags du titre comptent double
    map.set(t.name.toLowerCase(), (map.get(t.name.toLowerCase()) || 0) + score);
  });
  (artistTags || []).forEach((t, i) => {
    const score = t.count || 100 - i;
    map.set(t.name.toLowerCase(), (map.get(t.name.toLowerCase()) || 0) + score);
  });
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}

/**
 * Caractérise la graine en un objet normalisé.
 */
async function resolveTrackSeed(input) {
  const seed = normalizeSeed(input);
  if (!seed.title || !seed.artist) {
    throw new Error('title et artist sont requis');
  }

  const [dzTrack, dzArtist] = await Promise.all([
    resolveDeezerTrack(seed),
    resolveDeezerArtist(seed.artist)
  ]);

  const mbid = await resolveMusicBrainzId(seed);

  let trackTags = [];
  let artistTags = [];
  if (lastfm.isConfigured()) {
    [trackTags, artistTags] = await Promise.all([
      lastfm.getTrackTopTags(seed.artist, seed.title).catch(() => []),
      lastfm.getArtistTopTags(seed.artist).catch(() => [])
    ]);
  }

  const tags = topTags(trackTags, artistTags, 5);

  return {
    title: dzTrack?.title || seed.title,
    artist: dzTrack?.artist || seed.artist,
    album: dzTrack?.album || seed.album,
    year: dzTrack?.year || seed.year,
    bpm: dzTrack?.bpm || null,
    duration: dzTrack?.duration || null,
    rank: dzTrack?.rank || null,
    image: dzTrack?.image || dzArtist?.image || null,
    ids: {
      deezer: dzTrack?.ids?.deezer || (dzArtist?.id ? String(dzArtist.id) : null),
      // `deezer` retombe sur l'ID artiste quand le titre n'est pas résolu ;
      // on expose donc l'ID de piste à part, seul utilisable pour l'ISRC.
      deezerTrack: dzTrack?.ids?.deezer || null,
      artistDeezer: dzTrack?.ids?.artistDeezer || dzArtist?.id || null,
      mbid,
      tidal: null // résolu éventuellement par candidates.js
    },
    artistMeta: dzArtist ? { name: dzArtist.name, id: dzArtist.id, nbFan: dzArtist.nbFan } : null,
    tags,
    normalizedKey: trackTitleKey(seed.title, seed.artist)
  };
}

module.exports = {
  trackTitleKey,
  normalizeSeed,
  resolveTrackSeed,
  selectBestDeezerTrack,
  topTags
};
