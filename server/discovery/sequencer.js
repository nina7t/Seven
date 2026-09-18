const W = require('./weights');
const { normalizeForDedupe } = require('./normalize');

function getDecade(year) {
  return year ? Math.floor(year / 10) * 10 : null;
}

function countArtist(queue, artist) {
  const norm = normalizeForDedupe(artist);
  return queue.filter(t => normalizeForDedupe(t.artist) === norm).length;
}

function lastArtist(queue) {
  if (!queue.length) return null;
  return normalizeForDedupe(queue[queue.length - 1].artist);
}

function countAlbum(queue, album) {
  if (!album) return 0;
  const norm = normalizeForDedupe(album);
  return queue.filter(t => normalizeForDedupe(t.album) === norm).length;
}

function countDecadeRecent(queue, decade) {
  if (decade == null) return 0;
  return queue.slice(-5).filter(t => getDecade(t.year) === decade).length;
}

function isValid(candidate, queue, constraints) {
  if (!candidate.title || !candidate.artist) return false;
  const artistNorm = normalizeForDedupe(candidate.artist);

  // Jamais deux titres consécutifs du même artiste
  if (lastArtist(queue) === artistNorm) return false;
  // Max N titres par artiste dans le lot
  if (countArtist(queue, candidate.artist) >= constraints.maxPerArtistInBatch) return false;
  // Max N titres du même album
  if (candidate.album && countAlbum(queue, candidate.album) >= constraints.maxSameAlbumInBatch) return false;

  // Saut de tempo
  if (constraints.maxTempoDiff && queue.length) {
    const prev = queue[queue.length - 1];
    if (candidate.bpm && prev.bpm && Math.abs(candidate.bpm - prev.bpm) > constraints.maxTempoDiff) {
      return false;
    }
  }

  // Répartition des époques : pas plus de 3 titres de la même décennie dans les 5 derniers
  const decade = getDecade(candidate.year);
  if (decade != null && countDecadeRecent(queue, decade) >= 3) return false;

  return true;
}

function weightedRandomPick(pool) {
  const total = pool.reduce((sum, c) => sum + (c.score || 1), 0);
  let r = Math.random() * total;
  for (const c of pool) {
    r -= (c.score || 1);
    if (r <= 0) return c;
  }
  return pool[pool.length - 1];
}

function sanitizeAdventurousness(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : W.adventurousnessDefault;
}

function pickNext(candidates, queue, opts) {
  const { adventurousness = W.adventurousnessDefault, constraints = W } = opts;
  const adv = sanitizeAdventurousness(adventurousness);
  const valid = candidates.filter(c => isValid(c, queue, constraints));
  if (!valid.length) return null;

  // Deux bassins : valeurs sûres (haut du classement) et aventure (tout le vivier valide)
  const safeSize = Math.max(1, Math.ceil(valid.length * (1 - adv)));
  const safePool = valid.slice(0, safeSize);
  const pool = Math.random() < adv ? valid : safePool;

  return weightedRandomPick(pool);
}

/**
 * Construit un lot de `batchSize` titres à partir de candidats déjà scorés.
 *
 * @param {Array} candidates — candidats avec un champ `score`
 * @param {Object} opts
 * @param {number} opts.batchSize — taille du lot (défaut 20)
 * @param {Array} opts.existingQueue — file déjà en place (pour les contraintes)
 * @param {number} opts.adventurousness — 0 à 1
 * @returns {Array} nouveau lot de taille <= batchSize
 */
function buildQueue(candidates, opts = {}) {
  const {
    batchSize = W.batchSize,
    existingQueue = [],
    adventurousness = W.adventurousnessDefault
  } = opts;

  const constraints = {
    maxPerArtistInBatch: W.maxPerArtistInBatch,
    maxSameAlbumInBatch: W.maxSameAlbumInBatch,
    maxTempoDiff: W.maxTempoDiff
  };

  const queue = [...existingQueue];
  const added = [];

  while (added.length < batchSize) {
    const next = pickNext(candidates, queue, { adventurousness, constraints });
    if (!next) break;
    queue.push(next);
    added.push(next);
  }

  return added;
}

module.exports = {
  getDecade,
  isValid,
  pickNext,
  buildQueue
};
