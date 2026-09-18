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
const DEPTH = CONFIG.radio.similarArtistsDepth;

function withTimeout(promise, ms = TIMEOUT) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
  return Promise.race([promise, timeout]);
}

function safeCall(fn) {
  return withTimeout(fn()).catch(err => {
    console.warn('[candidates]', err.message);
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
    match: rawScores.match ?? a.match
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
  const tracks = await lastfm.getSimilarTracks(seed.artist, seed.title, SIMILAR_LIMIT);
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
  if (seed.ids?.deezer) {
    tasks.push((async () => {
      const related = await safeCall(() => deezer.fetchSimilarArtistsById(seed.ids.deezer));
      const topTasks = related.slice(0, 10).map(a => safeCall(() => deezer.fetchTopTracks(a.ids.deezer, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.DEEZER, rank: t.rank })))));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  } else {
    tasks.push((async () => {
      const related = await safeCall(() => deezer.fetchSimilarArtists(seed.artist));
      const topTasks = related.slice(0, 8).map(a => safeCall(() => deezer.fetchTopTracks(a.ids.deezer, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.DEEZER, rank: t.rank })))));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  }

  // Last.fm similar artists + top tracks
  if (lastfm.isConfigured()) {
    tasks.push((async () => {
      const related = await safeCall(() => lastfm.fetchSimilarArtists(seed.artist));
      const topTasks = related.slice(0, 8).map(a => safeCall(() => lastfm.getTopTracks(a.name, TOP_LIMIT).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.LASTFM, rank: t.rank })))));
      const tops = await Promise.all(topTasks);
      tops.forEach(group => out.push(...group));
    })());
  }

  // TIDAL similar artists (pas de top tracks fiable documenté ; on se contente des similaires si dispo)
  if (tidal.isConfigured && tidal.isConfigured()) {
    tasks.push((async () => {
      const related = await safeCall(() => tidal.searchAndSimilar(seed.artist));
      // Sans top tracks, on ne peut pas produire de candidats titres directement.
      // On les garde comme artistes connus pour le scoring de nouveauté.
    })());
  }

  await Promise.all(tasks);
  return out;
}

async function tagTopTracks(seed) {
  if (!lastfm.isConfigured()) return [];
  const tags = seed.tags.slice(0, 3);
  const tasks = tags.map(tag => safeCall(() => lastfm.getTopTracksByTag(tag, TAG_LIMIT)));
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
    const related = await lastfm.fetchSimilarArtists(a.name).catch(() => []);
    const topTasks = related.slice(0, 3).map(sim => safeCall(() => lastfm.getTopTracks(sim.name, 3).then(tracks => tracks.map(t => normalizeCandidate({ ...t, source: CONFIG.sources.LASTFM, rank: t.rank })))));
    const tops = await Promise.all(topTasks);
    tops.forEach(group => out.push(...group));
  }));
  await Promise.all(tasks);
  return out;
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
  normalizeCandidate,
  dedupeCandidates,
  trackTitleKey
};
