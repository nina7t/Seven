const { normalizeForDedupe } = require('./normalize');

const PENALTY_KEYWORDS = [
  'reprise', 'cover by', 'karaoke', 'instrumental', 'acoustic cover',
  'live at', 'en concert', 'live version', 'live performance', 'live from',
  'remaster', 'remastered', 'radio edit', 'extended mix', 'club mix', 'dj mix',
  '8d audio', '8d', 'slowed', 'sped up', 'nightcore', 'tiktok version',
  'reaction', 'reacts to', 'compilation', 'playlist', 'medley', 'best of',
  'greatest hits', 'official video', 'clip officiel', 'music video'
];

const EXACT_STOPWORDS = new Set([
  'reaction video', 'audio visualizer', 'visualizer', ' lyric ', ' lyrics ',
  ' paroles ', ' full album ', 'album complet'
]);

function isBadVariant(title) {
  const lower = String(title).toLowerCase();
  if (PENALTY_KEYWORDS.some(k => lower.includes(k))) return true;
  if ([...EXACT_STOPWORDS].some(w => lower.includes(w))) return true;
  return false;
}

function trackKey(title, artist) {
  return `${normalizeForDedupe(artist || '')}|${normalizeForDedupe(title || '')}`;
}

/**
 * Filtre le vivier de candidats.
 *
 * @param {Array} candidates
 * @param {Object} opts
 * @param {string} opts.seedKey — clé du titre de départ (exclu)
 * @param {Set<string>} opts.recentKeys — titres écoutés dans les 7 derniers jours
 * @param {Set<string>} opts.dislikedKeys — titres explicitement rejetés
 * @param {boolean} opts.keepBadVariants — true pour désactiver le filtre variantes
 */
function filterCandidates(candidates, opts = {}) {
  const {
    seedKey,
    recentKeys = new Set(),
    dislikedKeys = new Set(),
    keepBadVariants = false
  } = opts;

  const recent = new Set(recentKeys);
  const disliked = new Set(dislikedKeys);

  return candidates.filter(c => {
    if (!c.title || !c.artist) return false;
    if (seedKey && c.normalizedKey === seedKey) return false;
    if (recent.has(c.normalizedKey)) return false;
    if (disliked.has(c.normalizedKey)) return false;
    if (!keepBadVariants && isBadVariant(c.title)) return false;
    return true;
  });
}

module.exports = {
  isBadVariant,
  trackKey,
  filterCandidates
};
