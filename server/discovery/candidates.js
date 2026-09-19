const CONFIG = require('./config');
const deezer = require('./providers/deezer');
const lastfm = require('./providers/lastfm');
const tidal = require('./providers/tidal');
const { normalizeForDedupe } = require('./normalize');
const { trackTitleKey } = require('./seed');

const TIMEOUT = CONFIG.radio.sourceTimeoutMs;
const LIMIT = CONFIG.radio.candidateLimit;
const TAG_LIMIT = CONFIG.radio.tagTopTracksLimit;
const SIMILAR_LIMIT = CONFIG.radio.similarTracksLimit;
const TOP_LIMIT = CONFIG.radio.topTracksPerArtist;
const TIDAL_ARTISTS = CONFIG.radio.tidalSimilarArtists;
const TIDAL_CALL_TIMEOUT = CONFIG.radio.tidalCallTimeoutMs;
const DEPTH = CONFIG.radio.similarArtistsDepth;

function withTimeout(promise, ms = TIMEOUT) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
  return Promise.race([promise, timeout]);
}

function safeCall(fn, label = '', timeoutMs = TIMEOUT) {
  return Promise.resolve()
    .then(() => withTimeout(fn(), timeoutMs))
    .catch(err => {
      console.warn(`[candidates]${label ? ' ' + label + ':' : ''}`, err.message);
      return [];
    });
}

function normalizeCandidate(raw) {
  return {
    title: String(raw.title || '').trim(),
    artist: String(raw.artist || '').trim(),
    album: raw.album ? String(raw.album).trim() : null,
    year: raw.year ? parseInt(raw.year, 10) || null : null,
    bpm: raw.bpm ? parseInt(raw.bpm, 10) || null : null,
    duration: raw.duration ? parseInt(raw.duration, 10) || null : null,
    rank: typeof raw.rank === 'number' ? raw.rank : null,
    match: typeof raw.match === 'number' ? raw.match : null,
    rawScores: raw.rawScores || {},
    sources: Array.isArray(raw.sources) ? raw.sources : [raw.source].filter(Boolean),
    ids: raw.ids || {},
    tags: (raw.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean),
    normalizedKey: trackTitleKey(raw.title, raw.artist)
  };
}

function mergeCandidates(a, b) {
  const sources = Array.from(new Set([...a.sources, ...b.sources]));
  const ids = { ...a.ids, ...b.ids };
  const tags = Array.from(new Set([...a.tags, ...b.tags]));
  const rawScores = { ...a.rawScores, ...b.rawScores };
  // On garde le meilleur match / rank
  if (b.match != null && (a.match == null || b.match > a.match)) rawScores.match = b.match;
  if (b.rank != null && (a.rank == null || b.rank < a.rank)) rawScores.rank = b.rank;

  return {
    ...a,
    sources,
    ids,
    tags,
    rawScores,
    rank: rawScores.rank ?? a.rank,
    match: rawScores.match ?? a.match,
    // Les sources ne renseignent pas les mêmes métadonnées : Last.fm n'a ni
    // durée ni année, TIDAL donne la durée, Deezer le BPM. On complète les
    // trous plutôt que de garder aveuglément ceux de la première entrée.
    album: a.album ?? b.album,
    year: a.year ?? b.year,
    bpm: a.bpm ?? b.bpm,
    duration: a.duration ?? b.duration
  };
}

function dedupeCandidates(list) {
  const byKey = new Map();
  for (const c of list) {
    if (!c.title || !c.artist) continue;
    const key = c.normalizedKey;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, mergeCandidates(existing, c));
    } else {
      byKey.set(key, c);
    }
  }
  return [...byKey.values()];
}

async function lastfmSimilarTracks(seed) {
  if (!lastfm.isConfigured()) return [];
  const tracks = await safeCall(() => lastfm.getSimilarTracks(seed.artist, seed.title, SIMILAR_LIMIT), 'lastfm/similar-tracks');
  return tracks.map(t => normalizeCandidate({
    title: t.title,
    artist: t.artist,
    source: t.source,
    rank: t.rank,
    match: t.match,
    rawScores: { match: t.match, rank: t.rank },
    tags: [] // on n'a pas les tags ici
  }));
}

async function similarArtistsTopTracks(seed) {
  const out = [];
  const tasks = [];

  // Deezer related artists + top tracks
  const deezerArtistId = seed.artistMeta?.id || seed.ids?.artistDeezer;
  if (deezerArtistId) {
    tasks.push((async () => {
      const related = await safeCall(() => deezer.fetchSimilarArtistsById(deezerArtistId), 'deezer/similar');
      const topTasks = related.slice(0, 10).map(a => safeCall(() => deezer.fetchTopTracks(a.ids.deezer, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.DEEZER, rank: t.rank }))), `deezer/top:${a.name}`));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  } else {
    tasks.push((async () => {
      const related = await safeCall(() => deezer.fetchSimilarArtists(seed.artist), 'deezer/similar');
      const topTasks = related.slice(0, 8).map(a => safeCall(() => deezer.fetchTopTracks(a.ids.deezer, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.DEEZER, rank: t.rank }))), `deezer/top:${a.name}`));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  }

  // Last.fm similar artists + top tracks
  if (lastfm.isConfigured()) {
    tasks.push((async () => {
      const related = await safeCall(() => lastfm.fetchSimilarArtists(seed.artist), 'lastfm/similar');
      const topTasks = related.slice(0, 8).map(a => safeCall(() => lastfm.getTopTracks(a.name, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.LASTFM, rank: t.rank }))), `lastfm/top:${a.name}`));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  }

  // TIDAL : artistes similaires + leurs titres les plus populaires.
  // L'entrée se fait par l'ISRC du titre de départ (cf. resolveTidalArtist).
  if (tidal.isConfigured()) {
    tasks.push((async () => {
      const artist = await resolveTidalArtist(seed);
      if (!artist) return;
      seed.ids.tidal = artist.id;

      const related = await safeCall(() => tidal.fetchSimilarArtists(artist.id), 'tidal/similar');
      const topTasks = related.slice(0, TIDAL_ARTISTS).map(a => safeCall(() =>
        tidal.fetchTopTracks(a.ids.tidal, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({
          title: t.title,
          artist: a.name,
          source: CONFIG.sources.TIDAL,
          rank: t.rank,
          duration: t.duration,
          ids: t.ids,
          // La popularité TIDAL est déjà normalisée 0–1, soit exactement le
          // domaine attendu par popularityScore().
          rawScores: { popularity: t.popularity, tidalPopularity: t.popularity }
        })))
      // Ces appels sont sérialisés : le budget de 4 s du dernier de la file
      // serait déjà écoulé avant son émission. Un appel sain tient en ~200 ms,
      // donc on abandonne un traînard tôt plutôt que de retarder tout le lot.
      , `tidal/top:${a.name}`, TIDAL_CALL_TIMEOUT));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  }

  await Promise.all(tasks);
  return out;
}

/**
 * Résout l'artiste TIDAL du titre de départ.
 * TIDAL n'ouvre pas sa recherche texte à nos credentials et `filter[handle]`
 * ne couvre que les profils revendiqués : on passe donc par l'ISRC, que Deezer
 * nous donne sur /track/{id}.
 */
async function resolveTidalArtist(seed) {
  const trackId = seed.ids?.deezerTrack;
  if (!trackId) return null;
  try {
    const isrc = await withTimeout(deezer.fetchTrackIsrc(trackId));
    if (!isrc) return null;
    return await withTimeout(tidal.resolveArtistByIsrc(isrc, seed.artist));
  } catch (e) {
    console.warn('[candidates] résolution TIDAL impossible:', e.message);
    return null;
  }
}

async function tagTopTracks(seed) {
  if (!lastfm.isConfigured()) return [];
  const tags = seed.tags.slice(0, 3);
  const tasks = tags.map(tag => safeCall(() => lastfm.getTopTracksByTag(tag, TAG_LIMIT), `lastfm/tag:${tag}`));
  const groups = await Promise.all(tasks);
  const out = [];
  groups.forEach((tracks, idx) => {
    tracks.forEach((t, i) => {
      out.push(normalizeCandidate({
        title: t.title,
        artist: t.artist,
        source: t.source,
        rank: t.rank,
        rawScores: { tagRank: t.rank, tagIndex: idx },
        tags: [tags[idx]]
      }));
    });
  });
  return out;
}

async function neighborsOfNeighbors(seed, firstDegreeArtists) {
  if (DEPTH < 2 || !firstDegreeArtists.length) return [];
  const out = [];
  const pick = firstDegreeArtists.slice(0, 8);
  const tasks = pick.map(a => safeCall(async () => {
    const related = await lastfm.fetchSimilarArtists(a).catch(() => []);
    const topTasks = related.slice(0, 3).map(sim => safeCall(() => lastfm.getTopTracks(sim.name, 3).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.LASTFM, rank: t.rank }))), `lastfm/n2-top:${sim.name}`));
    const tops = await Promise.all(topTasks);
    tops.forEach(group => out.push(...group));
  }, `lastfm/n2:${a}`));
  await Promise.all(tasks);
  return out;
}

async function fetchMoreCandidates(seed, { excludeKeys = [], artists = [] } = {}) {
  const excluded = excludeKeys instanceof Set ? excludeKeys : new Set(excludeKeys);
  const expandedTags = seed.tags.slice(3);
  const tagTasks = expandedTags.map(tag => safeCall(() => lastfm.getTopTracksByTag(tag, TAG_LIMIT), `lastfm/tag:${tag}`));
  const tagGroups = await Promise.all(tagTasks);
  const tagTracks = [];
  tagGroups.forEach((tracks, idx) => {
    tracks.forEach(t => tagTracks.push(normalizeCandidate({
      ...t,
      source: t.source || CONFIG.sources.LASTFM,
      rawScores: { tagRank: t.rank, tagIndex: idx + 3 },
      tags: [expandedTags[idx]]
    })));
  });

  const uniqueArtists = artists
    .filter(Boolean)
    .filter((artist, index, all) => all.indexOf(artist) === index)
    .slice(-12);
  const neighbors = await neighborsOfNeighbors(seed, uniqueArtists);
  const fresh = dedupeCandidates([...tagTracks, ...neighbors])
    .filter(c => c.normalizedKey !== seed.normalizedKey && !excluded.has(c.normalizedKey));

  console.log(`[candidates] replenishment added ${fresh.length} candidates`);
  return fresh.slice(0, LIMIT);
}

async function fetchCandidates(seed) {
  const start = Date.now();
  const [similarTracks, artistTopTracks, tagTracks] = await Promise.all([
    lastfmSimilarTracks(seed),
    similarArtistsTopTracks(seed),
    tagTopTracks(seed)
  ]);

  const firstDegreeArtists = artistTopTracks
    .map(c => c.artist)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 8);

  const neighbors = await neighborsOfNeighbors(seed, firstDegreeArtists);

  const all = dedupeCandidates([
    ...similarTracks,
    ...artistTopTracks,
    ...tagTracks,
    ...neighbors
  ]);

  // Exclure la graine elle-même
  const seedKey = seed.normalizedKey;
  const filtered = all.filter(c => c.normalizedKey !== seedKey);

  console.log(`[candidates] ${filtered.length} candidats en ${Date.now() - start}ms`);
  return filtered.slice(0, LIMIT);
}

module.exports = {
  fetchCandidates,
  fetchMoreCandidates,
  normalizeCandidate,
  dedupeCandidates,
  lastfmSimilarTracks,
  similarArtistsTopTracks,
  trackTitleKey
};
