const W = require('./weights');
const { normalizeForDedupe } = require('./normalize');

function jaccard(a, b) {
  const setA = new Set(a || []);
  const setB = new Set(b || []);
  const inter = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

function sourceMatchScore(candidate) {
  let score = 0;
  if (typeof candidate.match === 'number' && candidate.match > 0) {
    score += candidate.match;
  }
  if (typeof candidate.rank === 'number' && candidate.rank > 0) {
    score += 1 / candidate.rank;
  }
  // Si aucun score source, on donne un léger crédit à la présence dans plusieurs sources
  if (score === 0) {
    score = (candidate.sources?.length || 1) * 0.05;
  }
  return Math.min(1, score);
}

function popularityScore(candidate) {
  const pop = candidate.rawScores?.popularity ?? candidate.popularity ?? 0;
  if (pop <= 0) return 0;
  // Popularité normalisée logarithmiquement pour éviter la dictature des têtes d'affiche
  return Math.min(1, Math.log10(1 + pop * (W.popularityLogBase - 1)) / Math.log10(W.popularityLogBase));
}

function noveltyScore(candidate, knownArtists) {
  if (!knownArtists || !knownArtists.size) return 1;
  return knownArtists.has(normalizeForDedupe(candidate.artist)) ? 0.3 : 1;
}

function tempoEraScore(candidate, seed) {
  let score = 0;
  let count = 0;

  if (candidate.bpm && seed.bpm) {
    const diff = Math.abs(candidate.bpm - seed.bpm);
    score += Math.max(0, 1 - diff / (W.maxTempoDiff || 15));
    count++;
  }

  if (candidate.year && seed.year) {
    const diff = Math.abs(candidate.year - seed.year);
    // On considère qu'un écart de 20 ans est le maximum tolérable
    score += Math.max(0, 1 - diff / 20);
    count++;
  }

  return count ? score / count : 0.5;
}

function applyFeedback(score, candidate, feedbackWeights = {}) {
  let delta = 0;

  if (feedbackWeights.tag && candidate.tags?.length) {
    candidate.tags.forEach(tag => {
      delta += feedbackWeights.tag[tag] || 0;
    });
  }

  if (feedbackWeights.artist) {
    delta += feedbackWeights.artist[normalizeForDedupe(candidate.artist)] || 0;
  }

  return Math.min(1, Math.max(0, score + delta));
}

function scoreCandidate(candidate, seed, opts = {}) {
  const { knownArtists = new Set(), feedbackWeights = {} } = opts;

  const source = sourceMatchScore(candidate);
  const tags = jaccard(candidate.tags, seed.tags);
  const pop = popularityScore(candidate);
  const novel = noveltyScore(candidate, knownArtists);
  const tempoEra = tempoEraScore(candidate, seed);

  let score =
    source * W.sourceMatchWeight +
    tags * W.tagJaccardWeight +
    pop * W.popularityWeight +
    novel * W.noveltyWeight +
    tempoEra * W.tempoEraWeight;

  score = applyFeedback(score, candidate, feedbackWeights);

  return Math.min(1, Math.max(0, Number(score.toFixed(4))));
}

function rankCandidates(candidates, seed, opts) {
  return candidates
    .map(c => ({ ...c, score: scoreCandidate(c, seed, opts) }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  jaccard,
  sourceMatchScore,
  popularityScore,
  noveltyScore,
  tempoEraScore,
  scoreCandidate,
  rankCandidates
};
