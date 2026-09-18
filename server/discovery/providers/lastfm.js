const axios = require('axios');
const CONFIG = require('../config');
const cache = require('../cache');
const { createNormalizedArtist, normalizeForDedupe } = require('../normalize');

const API_KEY = process.env.LASTFM_API_KEY;
const { LASTFM } = CONFIG.sources;

function isConfigured() {
  return Boolean(API_KEY);
}

async function call(method, params) {
  if (!isConfigured()) throw new Error('LASTFM_API_KEY manquant');

  const url = new URL(CONFIG.endpoints.lastfm.apiBase);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('format', 'json');
  url.searchParams.set('autocorrect', '1');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await axios.get(url.toString(), { timeout: CONFIG.sourceTimeoutMs });
  if (res.data?.error) {
    throw new Error(`Last.fm error ${res.data.error}: ${res.data.message}`);
  }
  return res.data;
}

/**
 * Cherche des artistes par nom et retourne les plus probables.
 */
async function searchArtists(name) {
  const cacheKey = name.toLowerCase().trim();
  const cached = cache.get('search', cacheKey, LASTFM);
  if (cached) return cached;

  const data = await call('artist.search', { artist: name, limit: CONFIG.limits.search });
  const matches = (data?.results?.artistmatches?.artist || [])
    .filter(a => a.name)
    .map(a => ({
      name: a.name,
      mbid: a.mbid || null,
      listeners: parseInt(a.listeners || '0', 10) || 0
    }));

  return cache.set('search', cacheKey, LASTFM, matches);
}

/**
 * Retourne les artistes similaires à `name` (scoring Last.fm `match`).
 */
async function fetchSimilarArtists(name) {
  const cacheKey = name.toLowerCase().trim();
  const cached = cache.get('similar', cacheKey, LASTFM);
  if (cached) return cached;

  const data = await call('artist.getsimilar', { artist: name, limit: CONFIG.limits.similar });
  const artists = Array.isArray(data?.similarartists?.artist)
    ? data.similarartists.artist
    : data?.similarartists?.artist ? [data.similarartists.artist] : [];

  const results = artists
    .filter(a => a.name)
    .map((a, index) => createNormalizedArtist({
      name: a.name,
      image: null,
      source: LASTFM,
      ids: { mbid: a.mbid || null },
      rank: index + 1,
      match: parseFloat(a.match) || 0
    }));

  return cache.set('similar', cacheKey, LASTFM, results);
}

/**
 * Infos détaillées sur un titre (track.getInfo).
 */
async function getTrackInfo(artist, track) {
  const cacheKey = `${normalizeForDedupe(artist)}|${normalizeForDedupe(track)}`;
  const cached = cache.get('search', cacheKey, 'lastfm-trackinfo');
  if (cached) return cached;

  const data = await call('track.getInfo', { artist, track, autocorrect: 1 });
  const result = {
    title: data?.track?.name || track,
    artist: data?.track?.artist?.name || artist,
    album: data?.track?.album?.title || null,
    mbid: data?.track?.mbid || null,
    duration: parseInt(data?.track?.duration || '0', 10) || null,
    listeners: parseInt(data?.track?.listeners || '0', 10) || 0,
    playcount: parseInt(data?.track?.playcount || '0', 10) || 0,
    tags: (data?.track?.toptags?.tag || []).map(t => t.name).filter(Boolean)
  };
  return cache.set('search', cacheKey, 'lastfm-trackinfo', result);
}

/**
 * Top tags d'un titre (track.getTopTags).
 */
async function getTrackTopTags(artist, track) {
  const cacheKey = `${normalizeForDedupe(artist)}|${normalizeForDedupe(track)}`;
  const cached = cache.get('search', cacheKey, 'lastfm-tracktags');
  if (cached) return cached;

  const data = await call('track.getTopTags', { artist, track, autocorrect: 1 });
  const tags = (data?.toptags?.tag || [])
    .map(t => ({ name: t.name, count: parseInt(t.count || '0', 10) }))
    .filter(t => t.name);
  return cache.set('search', cacheKey, 'lastfm-tracktags', tags);
}

/**
 * Top tags d'un artiste (artist.getTopTags).
 */
async function getArtistTopTags(artist) {
  const cacheKey = normalizeForDedupe(artist);
  const cached = cache.get('search', cacheKey, 'lastfm-artisttags');
  if (cached) return cached;

  const data = await call('artist.getTopTags', { artist, autocorrect: 1 });
  const tags = (data?.toptags?.tag || [])
    .map(t => ({ name: t.name, count: parseInt(t.count || '0', 10) }))
    .filter(t => t.name);
  return cache.set('search', cacheKey, 'lastfm-artisttags', tags);
}

/**
 * Titres similaires à un titre (track.getSimilar).
 */
async function getSimilarTracks(artist, track, limit = 30) {
  const cacheKey = `${normalizeForDedupe(artist)}|${normalizeForDedupe(track)}`;
  const cached = cache.get('similar', cacheKey, 'lastfm-tracksimilar');
  if (cached) return cached;

  const data = await call('track.getSimilar', { artist, track, limit, autocorrect: 1 });
  const tracks = Array.isArray(data?.similartracks?.track)
    ? data.similartracks.track
    : data?.similartracks?.track ? [data.similartracks.track] : [];

  const results = tracks
    .filter(t => t.name && t.artist?.name)
    .map((t, index) => ({
      title: t.name,
      artist: t.artist.name,
      rank: index + 1,
      match: parseFloat(t.match) || 0,
      source: LASTFM
    }));
  return cache.set('similar', cacheKey, 'lastfm-tracksimilar', results);
}

/**
 * Top tracks d'un artiste (artist.getTopTracks).
 */
async function getTopTracks(artist, limit = 5) {
  const cacheKey = normalizeForDedupe(artist);
  const cached = cache.get('search', cacheKey, 'lastfm-toptracks');
  if (cached) return cached;

  const data = await call('artist.getTopTracks', { artist, limit, autocorrect: 1 });
  const tracks = Array.isArray(data?.toptracks?.track)
    ? data.toptracks.track
    : data?.toptracks?.track ? [data.toptracks.track] : [];

  const results = tracks
    .filter(t => t.name)
    .map((t, index) => ({
      title: t.name,
      artist: data?.toptracks?.['@attr']?.artist || artist,
      rank: index + 1,
      playcount: parseInt(t.playcount || '0', 10) || 0,
      listeners: parseInt(t.listeners || '0', 10) || 0,
      source: LASTFM
    }));
  return cache.set('search', cacheKey, 'lastfm-toptracks', results);
}

/**
 * Top tracks pour un tag (tag.getTopTracks).
 */
async function getTopTracksByTag(tag, limit = 30) {
  const cacheKey = normalizeForDedupe(tag);
  const cached = cache.get('search', cacheKey, 'lastfm-tagtracks');
  if (cached) return cached;

  const data = await call('tag.getTopTracks', { tag, limit });
  const tracks = Array.isArray(data?.tracks?.track)
    ? data.tracks.track
    : data?.tracks?.track ? [data.tracks.track] : [];

  const results = tracks
    .filter(t => t.name && t.artist?.name)
    .map((t, index) => ({
      title: t.name,
      artist: t.artist.name,
      rank: index + 1,
      source: LASTFM
    }));
  return cache.set('search', cacheKey, 'lastfm-tagtracks', results);
}

module.exports = {
  isConfigured,
  call,
  searchArtists,
  fetchSimilarArtists,
  getTrackInfo,
  getTrackTopTags,
  getArtistTopTags,
  getSimilarTracks,
  getTopTracks,
  getTopTracksByTag
};
