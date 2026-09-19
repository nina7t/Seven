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

function candidateKey(candidate) {
  return candidate.normalizedKey || `${normalizeForDedupe(candidate.artist)}|${normalizeForDedupe(candidate.title)}`;
}

function isValid(candidate, queue, constraints, context = {}) {
  if (!candidate.title || !candidate.artist) return false;
  const artistNorm = normalizeForDedupe(candidate.artist);
  const batchQueue = context.batchQueue || queue;

  if (context.usedKeys && context.usedKeys.has(candidateKey(candidate))) return false;

  // Jamais deux titres consécutifs du même artiste (y compris à la limite du lot)
  if (lastArtist(queue) === artistNorm) return false;
  // Les plafonds artiste/album ne portent que sur le nouveau lot.
  if (countArtist(batchQueue, candidate.artist) >= constraints.maxPerArtistInBatch) return false;
  if (candidate.album && countAlbum(batchQueue, candidate.album) >= constraints.maxSameAlbumInBatch) return false;

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
  const {
    constraints = W,
    batchQueue = queue,
    usedKeys,
    wantDiscovery = false
  } = opts;
  const valid = candidates.filter(c => isValid(c, queue, constraints, { batchQueue, usedKeys }));
  if (!valid.length) return null;

  // Deux bassins : ce que l'auditeur connaît déjà, et ce qu'il ne connaît pas.
  // On sert le bassin demandé ; s'il est vide, on prend l'autre plutôt que de
  // rendre un lot trop court.
  const wanted = valid.filter(c => Boolean(c.familiar) !== wantDiscovery);
  return weightedRandomPick(wanted.length ? wanted : valid);
}

/**
 * Construit un lot de `batchSize` titres à partir de candidats déjà scorés.
 *
 * @param {Array} candidates — candidats avec un champ `score`
 * @param {Object} opts
 * @param {number} opts.batchSize — taille du lot (défaut 20)
 * @param {Array} opts.existingQueue — file déjà en place (pour les contraintes)
 * @param {number} opts.adventurousness — part visée de découverte, 0 à 1
 *        (0 = que du connu, 1 = que de la découverte)
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

  const adv = sanitizeAdventurousness(adventurousness);
  const queue = [...existingQueue];
  const added = [];
  const usedKeys = new Set(existingQueue.map(candidateKey));
  let discoveries = 0;

  while (added.length < batchSize) {
    // Quota entier : on demande une découverte tant qu'on n'a pas atteint le
    // nombre visé pour la taille de lot courante, du connu sinon. Comparer des
    // entiers plutôt que des ratios évite l'angle mort aux extrêmes (à 1.0, un
    // ratio déjà égal à la cible faisait basculer le slot vers du connu).
    const wantDiscovery = discoveries < Math.round(adv * (added.length + 1));

    const next = pickNext(candidates, queue, {
      constraints,
      batchQueue: added,
      usedKeys,
      wantDiscovery
    });
    if (!next) break;
    queue.push(next);
    added.push(next);
    usedKeys.add(candidateKey(next));
    if (!next.familiar) discoveries++;
  }

  return added;
}

module.exports = {
  getDecade,
  isValid,
  pickNext,
  buildQueue
};
