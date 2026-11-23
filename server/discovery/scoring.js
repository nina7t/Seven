const W = require('./weights');
const { normalizeForDedupe } = require('./normalize');

const BROAD_TAGS = new Set(['pop', 'rock', 'electronic', 'alternative', 'indie', 'music', 'seen live', 'favorites', 'favourites']);

function styleTags(tags = []) {
  return tags.map(tag => String(tag).trim().toLowerCase()).filter(tag => tag && !BROAD_TAGS.has(tag));
}

/**
 * Décennies citées par des tags Last.fm : « 50s », « 1980s », « oldies ».
 * Retourne des années de début de décennie (1950, 1980…). « 00s », « 10s » et « 20s » sont lus comme 2000, 2010 et 2020
 * (usage actuel de Last.fm). Tableau vide = époque inconnue.
 */
function decadesFromTags(tags = []) {
  const out = new Set();
  tags.forEach(raw => {
    const tag = String(raw?.name ?? raw).trim().toLowerCase();
    let m = tag.match(/^(19|20)(\d)0s$/);
    if (m) return out.add(parseInt(m[1] + m[2] + '0', 10));
    m = tag.match(/^(\d)0s$/);
    if (m) return out.add(parseInt(m[1], 10) < 3 ? 2000 + parseInt(m[1], 10) * 10 : 1900 + parseInt(m[1], 10) * 10);
    if (tag === 'oldies') { out.add(1950); out.add(1960); }
  });
  return [...out];
}

/**
 * Deux musiques à plus de 30 ans d'écart ne sont pas de la même époque, même
 * sous la même étiquette « pop » (Piaf et la pop actuelle). Si l'une des deux
 * époques est inconnue, on ne tranche pas.
 */
const MAX_ERA_GAP_YEARS = 30;
function eraCompatible(candidate, seed) {
  const ce = candidate.eras || [];
  const se = seed.eras || [];
  if (!ce.length || !se.length) return true;
  return ce.some(c => se.some(s => Math.abs(c - s) <= MAX_ERA_GAP_YEARS));
}

function jaccard(a, b) {
  const setA = new Set(a || []);
  const setB = new Set(b || []);
  const inter = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

function sourceMatchScore(candidate) {
  // Un classement de popularité chez un artiste n'est pas une similarité titre.
  if (candidate.rawScores?.trackSimilar && candidate.match > 0) {
    return 0.5 + 0.5 * Math.max(0, Math.min(1, candidate.match || 0));
  }
  if (candidate.rawScores?.artistRelated) return 0.35 / Math.max(1, candidate.rank || 1);
  if (candidate.rawScores?.tagTop) return 0.15 / Math.max(1, candidate.rank || 1);
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

/**
 * Un candidat est « familier » si l'auditeur a déjà écouté ce titre précis,
 * ou s'il écoute déjà cet artiste. Le séquenceur s'en sert pour doser la
 * part de connu et de découverte dans chaque lot.
 */
function tagFamiliarity(candidate, knownArtists, knownTrackKeys) {
  if (knownTrackKeys?.has(candidate.normalizedKey)) return true;
  return Boolean(knownArtists?.has(normalizeForDedupe(candidate.artist)));
}

/**
 * Garde-fou de genre Deezer : écarte un candidat dont le genre est connu et
 * n'a rien en commun avec celui de la graine (ex. Zaz dans une radio PLK).
 * Si l'un des deux genres est inconnu, on ne tranche pas.
 */
function genreCompatible(candidate, seed) {
  const cg = candidate.genres || [];
  const sg = seed.genres || [];
  if (!cg.length || !sg.length) return true;
  return cg.some(g => sg.includes(g));
}

function coherentCandidates(allCandidates, seed) {
  const candidates = allCandidates.filter(c => genreCompatible(c, seed) && eraCompatible(c, seed));
  const annotated = candidates.some(c => c.rawScores?.trackSimilar || c.rawScores?.artistRelated || c.rawScores?.tagTop);
  if (!annotated) return candidates;

  const tags = styleTags(seed.trackTags || seed.tags || []);
  const supported = candidates.filter(c => (c.rawScores?.trackSimilar && c.match > 0) ||
    (c.rawScores?.artistRelated && jaccard(styleTags(c.tags), tags) > 0));
  // Le quota découverte et les likes ne doivent jamais réintroduire des titres
  // sans lien : filtrer avant de calculer ces bonus, y compris dans /next.
  if (seed.trackSimilarityAvailable || supported.length) return supported;
  return candidates.filter(c => c.rawScores?.artistRelated);
}

function rankCandidates(candidates, seed, opts = {}) {
  const { knownArtists = new Set(), knownTrackKeys = new Set() } = opts;
  return coherentCandidates(candidates, seed)
    .map(c => ({
      ...c,
      score: scoreCandidate(c, seed, opts),
      familiar: tagFamiliarity(c, knownArtists, knownTrackKeys)
    }))
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  jaccard,
  genreCompatible,
  eraCompatible,
  decadesFromTags,
  tagFamiliarity,
  sourceMatchScore,
  popularityScore,
  noveltyScore,
  tempoEraScore,
  coherentCandidates,
  styleTags,
  scoreCandidate,
  rankCandidates
};
