const crypto = require('crypto');
const W = require('./weights');
const { normalizeForDedupe } = require('./normalize');

const sessions = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
// Plafond mémoire : au-delà, on évince la session la moins récemment utilisée
const MAX_SESSIONS = 200;

function generateRadioId() {
  return crypto.randomUUID();
}

function cleanupSessions() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastUsed < cutoff) sessions.delete(id);
  }
}

function createSession(seed, userHistoryArtists = [], candidates = [], knownTrackKeys = new Set()) {
  cleanupSessions();
  const radioId = generateRadioId();
  const knownArtists = new Set(userHistoryArtists.map(a => normalizeForDedupe(a)));
  if (seed?.artist) knownArtists.add(normalizeForDedupe(seed.artist));

  sessions.set(radioId, {
    seed,
    candidates,
    knownArtists,
    knownTrackKeys: new Set(knownTrackKeys),
    tagWeights: {},
    artistWeights: {},
    artistRejections: {},
    history: [],
    lastUsed: Date.now()
  });
  // La Map garde l'ordre d'insertion, et getSession réinsère à chaque accès :
  // la première clé est donc la moins récemment utilisée.
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return radioId;
}

function getSession(radioId) {
  cleanupSessions();
  const s = sessions.get(radioId);
  if (!s) return null;
  s.lastUsed = Date.now();
  sessions.delete(radioId);
  sessions.set(radioId, s);
  return s;
}

function recordFeedback(radioId, track, type) {
  const s = getSession(radioId);
  if (!s || !track) return false;

  const handlers = {
    like: { artist: W.likeBoost, tag: W.likeBoost },
    listen80: { artist: W.listen80Boost, tag: W.listen80Boost },
    skip: { artist: W.skipPenalty, tag: W.skipPenalty, reject: 1 },
    dislike: { artist: W.dislikePenalty, tag: W.dislikePenalty, reject: 2 }
  };

  const delta = handlers[type];
  if (!delta) return false;

  s.history.push({
    trackKey: track.normalizedKey || `${track.artist}|${track.title}`,
    type,
    at: Date.now()
  });

  const artistNorm = normalizeForDedupe(track.artist);
  const tags = (track.tags || []).filter(Boolean);

  s.artistWeights[artistNorm] = (s.artistWeights[artistNorm] || 0) + delta.artist;
  tags.forEach(tag => {
    s.tagWeights[tag] = (s.tagWeights[tag] || 0) + delta.tag;
  });
  if (delta.reject) {
    s.artistRejections[artistNorm] = (s.artistRejections[artistNorm] || 0) + delta.reject;
  }

  return true;
}

function getFeedbackWeights(radioId) {
  const s = getSession(radioId);
  if (!s) return null;
  return {
    tag: s.tagWeights,
    artist: s.artistWeights,
    rejectedArtists: Object.entries(s.artistRejections)
      .filter(([, count]) => count >= W.artistRejectThreshold)
      .map(([name]) => name)
  };
}

function shouldExcludeArtist(radioId, artist) {
  const s = getSession(radioId);
  if (!s) return false;
  return (s.artistRejections[normalizeForDedupe(artist)] || 0) >= W.artistRejectThreshold;
}

function getKnownArtists(radioId) {
  const s = getSession(radioId);
  return s ? s.knownArtists : new Set();
}

function addKnownArtists(radioId, artists) {
  const s = getSession(radioId);
  if (!s || !Array.isArray(artists)) return;
  artists.forEach(a => s.knownArtists.add(normalizeForDedupe(a)));
}

function getSessionCount() {
  return sessions.size;
}

module.exports = {
  createSession,
  getSession,
  recordFeedback,
  getFeedbackWeights,
  shouldExcludeArtist,
  getKnownArtists,
  addKnownArtists,
  cleanupSessions,
  getSessionCount
};
