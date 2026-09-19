const express = require('express');
const { resolveTrackSeed } = require('../seed');
const CONFIG = require('../config');
const { fetchCandidates, fetchMoreCandidates } = require('../candidates');
const { filterCandidates } = require('../filters');
const { rankCandidates } = require('../scoring');
const { buildQueue } = require('../sequencer');
const { normalizeForDedupe } = require('../normalize');
const lastfm = require('../providers/lastfm');
const {
  createSession,
  getSession,
  recordFeedback,
  getFeedbackWeights,
  addKnownArtists
} = require('../feedback');

const router = express.Router();

function extractUserArtists(userHistory = []) {
  return userHistory.map(h => {
    if (typeof h === 'string') return h;
    return h.artist || h.channel;
  }).filter(Boolean);
}

function toTrackSet(keys = []) {
  return new Set(keys.map(k => String(k).toLowerCase().trim()));
}

function formatTrack(candidate, index) {
  return {
    index: index + 1,
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album,
    year: candidate.year,
    bpm: candidate.bpm,
    duration: candidate.duration,
    ids: candidate.ids || {},
    image: candidate.image || null,
    tags: candidate.tags || [],
    score: candidate.score,
    sources: candidate.sources || [],
    normalizedKey: candidate.normalizedKey
  };
}

function determineStrategy(seed, tracks) {
  const sources = new Set();
  tracks.forEach(t => (t.sources || []).forEach(s => sources.add(s)));
  if (!sources.size) return 'fallback';
  if (seed.tags.length > 0 && sources.has('lastfm')) return 'track-similar-tags';
  if (sources.has('lastfm') || sources.has('deezer')) return 'artist-similar';
  return 'genre';
}

function degradedSources(seed, candidates = []) {
  const out = [];
  const actualSources = new Set();
  candidates.forEach(candidate => (candidate.sources || []).forEach(source => actualSources.add(source)));

  if (!seed.ids.deezer) out.push({ source: 'deezer', reason: 'title not resolved' });
  else if (!actualSources.has(CONFIG.sources.DEEZER)) {
    out.push({ source: 'deezer', reason: 'no candidates returned' });
  }
  if (!seed.ids.mbid) out.push({ source: 'musicbrainz', reason: 'mbid not resolved' });
  if (lastfm.isConfigured() && !actualSources.has(CONFIG.sources.LASTFM)) {
    out.push({ source: 'lastfm', reason: 'no candidates returned' });
  }
  return out;
}

/**
 * POST /api/radio/start
 * Body: { title, artist, album?, year?, adventurousness?, userHistory?, dislikedKeys? }
 */
router.post('/start', async (req, res) => {
  try {
    const { title, artist, album, year } = req.body || {};
    if (!title || !artist) {
      return res.status(400).json({ error: 'title et artist sont requis' });
    }

    const adventurousness = Number.isFinite(parseFloat(req.body.adventurousness))
      ? parseFloat(req.body.adventurousness)
      : undefined;
    const userHistoryArtists = extractUserArtists(req.body.userHistory || []);
    const normalizedHistoryArtists = userHistoryArtists.map(normalizeForDedupe).filter(Boolean);
    const dislikedKeys = toTrackSet(req.body.dislikedKeys || []);
    const recentKeys = toTrackSet(req.body.recentKeys || []);

    const seed = await resolveTrackSeed({ title, artist, album, year });
    let candidates = await fetchCandidates(seed);

    candidates = filterCandidates(candidates, {
      seedKey: seed.normalizedKey,
      recentKeys,
      dislikedKeys
    });

    // Réintégrer la graine comme premier élément ? Non, le front a déjà le titre en cours.
    // On génère uniquement la suite.

    const scored = rankCandidates(candidates, seed, { knownArtists: new Set(normalizedHistoryArtists) });
    const tracks = buildQueue(scored, { adventurousness });

    const radioId = createSession(seed, normalizedHistoryArtists, scored);
    addKnownArtists(radioId, tracks.map(t => t.artist));

    res.json({
      radioId,
      seed,
      tracks: tracks.map(formatTrack),
      strategy: determineStrategy(seed, tracks),
      degradedSources: degradedSources(seed, candidates),
      meta: { candidatePool: candidates.length, batchSize: tracks.length }
    });
  } catch (e) {
    console.error('[radio/start]', e);
    res.status(500).json({ error: e.message || 'Erreur lors du démarrage de la radio' });
  }
});

/**
 * POST /api/radio/next
 * Body: { radioId, feedback?: [{ trackKey, type }], playedKeys?: [...] }
 */
router.post('/next', async (req, res) => {
  try {
    const { radioId } = req.body || {};
    if (!radioId) return res.status(400).json({ error: 'radioId requis' });

    const session = getSession(radioId);
    if (!session) return res.status(404).json({ error: 'Session radio inconnue ou expirée' });

    // Appliquer le feedback reçu
    (req.body.feedback || []).forEach(fb => {
      const track = session.candidates.find(c => c.normalizedKey === fb.trackKey);
      if (track) recordFeedback(radioId, track, fb.type);
    });

    const weights = getFeedbackWeights(radioId);
    const knownArtists = new Set([...session.knownArtists]);
    const rejected = new Set(weights.rejectedArtists);
    const playedKeys = toTrackSet(req.body.playedKeys || []);

    const isAvailable = candidate =>
      !playedKeys.has(candidate.normalizedKey) && !rejected.has(normalizeForDedupe(candidate.artist));
    if (session.candidates.filter(isAvailable).length < CONFIG.radio.replenishThreshold) {
      try {
        const existingKeys = new Set(session.candidates.map(candidate => candidate.normalizedKey));
        const fresh = await fetchMoreCandidates(session.seed, {
          excludeKeys: existingKeys,
          artists: session.candidates.map(candidate => candidate.artist)
        });
        session.candidates.push(...fresh);
      } catch (error) {
        console.warn('[radio/next] candidate replenishment failed:', error.message);
      }
    }

    // Rescorer les candidats non encore joués en appliquant les poids de feedback
    let remaining = session.candidates
      .filter(isAvailable)
      .map(c => ({ ...c }));

    const rescored = rankCandidates(remaining, session.seed, { knownArtists, feedbackWeights: weights });
    const nextAdventurousness = Number.isFinite(parseFloat(req.body.adventurousness))
      ? parseFloat(req.body.adventurousness)
      : undefined;
    const tracks = buildQueue(rescored, { adventurousness: nextAdventurousness });
    addKnownArtists(radioId, tracks.map(t => t.artist));

    res.json({
      radioId,
      tracks: tracks.map(formatTrack),
      strategy: determineStrategy(session.seed, tracks),
      degradedSources: degradedSources(session.seed, session.candidates),
      meta: { remainingPool: remaining.length, batchSize: tracks.length }
    });
  } catch (e) {
    console.error('[radio/next]', e);
    res.status(500).json({ error: e.message || 'Erreur lors de la génération du lot suivant' });
  }
});

/**
 * POST /api/radio/feedback
 * Body: { radioId, feedback: [{ trackKey, type }] }
 */
router.post('/feedback', (req, res) => {
  try {
    const { radioId, feedback } = req.body || {};
    if (!radioId || !Array.isArray(feedback)) {
      return res.status(400).json({ error: 'radioId et feedback[] requis' });
    }

    const session = getSession(radioId);
    if (!session) return res.status(404).json({ error: 'Session radio inconnue ou expirée' });

    let applied = 0;
    for (const fb of feedback) {
      const track = session.candidates.find(c => c.normalizedKey === fb.trackKey);
      if (track && recordFeedback(radioId, track, fb.type)) applied++;
    }

    res.json({ ok: true, applied, weights: getFeedbackWeights(radioId) });
  } catch (e) {
    console.error('[radio/feedback]', e);
    res.status(500).json({ error: e.message || 'Erreur feedback' });
  }
});

module.exports = router;
