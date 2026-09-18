const express = require('express');
const CONFIG = require('./config');
const cache = require('./cache');
const { dedupeArtists, createNormalizedArtist } = require('./normalize');
const { rankAndScore } = require('./score');
const tidal = require('./providers/tidal');
const lastfm = require('./providers/lastfm');
const deezer = require('./providers/deezer');
const radioRouter = require('./routes/radio');

const router = express.Router();

// Routes du moteur radio (titre → file continue)
router.use('/radio', radioRouter);

const SOURCES = [CONFIG.sources.TIDAL, CONFIG.sources.DEEZER, CONFIG.sources.LASTFM];

function withTimeout(promise, ms) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), ms)
  );
  return Promise.race([promise, timeout]);
}

async function safeCall(label, fn) {
  try {
    const result = await withTimeout(fn(), CONFIG.sourceTimeoutMs);
    return { ok: true, source: label, data: result };
  } catch (err) {
    console.warn(`[discovery] ${label} failed:`, err.message);
    return { ok: false, source: label, error: err.message };
  }
}

function pickImage(entries) {
  // On choisit la première image non nulle, en privilégiant Deezer (URL directe)
  for (const e of entries) {
    if (e?.image) return e.image;
  }
  return null;
}

/**
 * GET /api/discovery/search?q=<nom>
 * Recherche d'artiste, renvoie une liste normalisée.
 */
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Paramètre q requis (min 2 caractères)' });
  }

  const cacheKey = q.toLowerCase();
  const cached = cache.get('search', cacheKey, 'aggregate');
  if (cached) return res.json({ ...cached, cached: true });

  const calls = [];
  if (lastfm.isConfigured()) {
    calls.push(safeCall(CONFIG.sources.LASTFM, () => lastfm.searchArtists(q)));
  }
  calls.push(safeCall(CONFIG.sources.DEEZER, () => deezer.searchArtists(q)));
  // TIDAL n'a pas de recherche texte simple documentée en v2 ; on ne l'inclut pas ici.

  const results = await Promise.all(calls);
  const degradedSources = results.filter(r => !r.ok).map(r => ({ source: r.source, error: r.error }));

  const normalized = [];
  for (const r of results.filter(r => r.ok)) {
    (r.data || []).forEach((item, index) => {
      const ids = {};
      if (r.source === CONFIG.sources.DEEZER) ids.deezer = item.id;
      if (r.source === CONFIG.sources.LASTFM) ids.mbid = item.mbid;
      normalized.push(createNormalizedArtist({
        name: item.name,
        image: item.picture || null,
        source: r.source,
        ids,
        rank: index + 1,
        popularity: item.listeners ? item.listeners / 10_000_000 : item.nbFan ? item.nbFan / 10_000_000 : null
      }));
    });
  }

  const deduped = dedupeArtists(normalized);
  const scored = rankAndScore(deduped, results.filter(r => r.ok).length);

  const payload = {
    query: q,
    count: scored.length,
    artists: scored.map(({ _meta, ...rest }) => rest),
    degradedSources,
    sources: results.filter(r => r.ok).map(r => r.source)
  };

  cache.set('search', cacheKey, 'aggregate', payload);
  res.json(payload);
});

/**
 * GET /api/discovery/artists/:id/similar
 * Artistes apparentés agrégés depuis TIDAL, Last.fm et Deezer.
 * L'`:id` est l'identifiant Deezer de l'artiste (source unique de vérité
 * stable et accessible sans auth).
 */
router.get('/artists/:id/similar', async (req, res) => {
  const deezerId = String(req.params.id || '').replace(/\D/g, '');
  if (!deezerId) {
    return res.status(400).json({ error: 'Identifiant artiste invalide' });
  }

  const cacheKey = deezerId;
  const cached = cache.get('similar', cacheKey, 'aggregate');
  if (cached) return res.json({ ...cached, cached: true });

  // 1. Résoudre le nom via Deezer
  let artistName;
  try {
    const dzArtist = await withTimeout(deezer.findArtistById(deezerId), CONFIG.sourceTimeoutMs);
    artistName = dzArtist?.name;
  } catch (err) {
    console.warn('[discovery] Deezer artist lookup failed:', err.message);
  }

  if (!artistName) {
    return res.status(404).json({ error: 'Artiste introuvable', id: deezerId });
  }

  const calls = [
    safeCall(CONFIG.sources.DEEZER, () => deezer.fetchSimilarArtistsById(deezerId))
  ];

  if (lastfm.isConfigured()) {
    calls.push(safeCall(CONFIG.sources.LASTFM, () => lastfm.fetchSimilarArtists(artistName)));
  }

  if (tidal.isConfigured && tidal.isConfigured()) {
    calls.push(safeCall(CONFIG.sources.TIDAL, () => tidal.searchAndSimilar(artistName)));
  }

  const results = await Promise.all(calls);
  const degradedSources = results.filter(r => !r.ok).map(r => ({ source: r.source, error: r.error }));
  const okSources = results.filter(r => r.ok);

  const normalized = [];
  for (const r of okSources) {
    for (const item of r.data || []) {
      // Les fournisseurs retournent déjà des objets normalisés ; on les
      // complète juste avec une image si un autre fournisseur en a une.
      normalized.push(item);
    }
  }

  const deduped = dedupeArtists(normalized);

  // Enrichissement : si un artiste n'a pas d'image, on cherche un doublon
  // dans une autre source qui en a une.
  const byName = new Map();
  for (const a of deduped) {
    byName.set(a.normalizedName, a);
  }
  for (const a of deduped) {
    if (!a.image) {
      // Pas de recherche supplémentaire ici pour respecter le timeout global.
      // On laissera le front afficher un fallback.
    }
  }

  const scored = rankAndScore(deduped, okSources.length);

  const payload = {
    artist: { name: artistName, id: deezerId },
    count: scored.length,
    artists: scored.map(({ _meta, ...rest }) => rest),
    degradedSources,
    sources: okSources.map(r => r.source)
  };

  cache.set('similar', cacheKey, 'aggregate', payload);
  res.json(payload);
});

module.exports = router;
