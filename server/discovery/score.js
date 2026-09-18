const CONFIG = require('./config');

const { scoring } = CONFIG;

/**
 * Calcule un score combiné pour un artiste agrégé.
 *
 * @param {Object} artist - artiste avec _meta { rank, match, popularity }
 * @param {number} sourceCount - nombre total de sources consultées (vivantes)
 */
function computeScore(artist, sourceCount = 3) {
  const { rank, match, popularity } = artist._meta || {};
  const sources = artist.sources || [];

  // 1. Score basé sur le rang moyen normalisé (1 = meilleur)
  let rankScore = 0;
  if (rank != null && rank > 0) {
    rankScore = 1 / rank;
  }

  // 2. Score Last.fm match (0–1)
  const matchScore = match != null ? parseFloat(match) : 0;

  // 3. Bonus multi-source : croît avec le nombre de sources ayant cet artiste
  const multiBonus = Math.max(0, sources.length - 1) * scoring.multiSourceBonus;

  // 4. Bonus TIDAL (source canonique hi-fi)
  const tidalBonus = sources.includes(CONFIG.sources.TIDAL) ? scoring.tidalBonus : 0;

  // 5. Popularité normalisée (si dispo)
  const popScore = popularity != null ? Math.min(1, popularity) : 0;

  const base =
    (rankScore * scoring.rankWeight) +
    (matchScore * scoring.lastfmMatchWeight) +
    (popScore * 0.10);

  let score = base + multiBonus + tidalBonus;

  // Normaliser légèrement pour que le nombre de sources consultées n'influe pas artificiellement
  if (scoring.normalizeBySources) {
    score = score / Math.max(1, sourceCount - sources.length + 1);
  }

  return Math.min(1, Math.max(0, Number(score.toFixed(4))));
}

/**
 * Trie une liste d'artistes par score décroissant et ajoute le champ `score`.
 */
function rankAndScore(artists, sourceCount) {
  return artists
    .map(a => ({ ...a, score: computeScore(a, sourceCount) }))
    .sort((a, b) => b.score - a.score);
}

module.exports = { computeScore, rankAndScore };
