/**
 * Normalisation d'un nom d'artiste pour comparaison / dédoublonnage.
 * Règles du brief :
 * - minuscules
 * - accents retirés
 * - ponctuation retirée
 * - « The » initial ignoré
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')      // accents
    .replace(/[^a-z0-9\s]/g, '')           // ponctuation retirée
    .replace(/\bthe\b/g, ' ')              // ignorer « the » initial/partout
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForDedupe(name) {
  return normalizeName(name).replace(/\s/g, ''); // version compacte pour clé
}

function createNormalizedArtist({
  name,
  image = null,
  source,
  ids = {},
  rank = null,
  match = null,
  popularity = null
}) {
  return {
    name,
    normalizedName: normalizeForDedupe(name),
    image,
    sources: [source],
    ids,
    // Données brutes utiles au scoring
    _meta: { rank, match, popularity }
  };
}

/**
 * Fusionne deux entrées normalisées du même artiste.
 */
function mergeArtists(a, b) {
  const sources = Array.from(new Set([...a.sources, ...b.sources]));
  const ids = { ...a.ids, ...b.ids };
  const images = [a.image, b.image].filter(Boolean);
  // On privilégie l'image de la source ayant un vrai visuel ; sinon la première
  const image = images[0] || null;

  return {
    name: a.name, // nom de référence (premier rencontré)
    normalizedName: a.normalizedName,
    image,
    sources,
    ids,
    _meta: {
      rank: mergeNumeric(a._meta.rank, b._meta.rank, Math.min),
      match: mergeNumeric(a._meta.match, b._meta.match, Math.max),
      popularity: mergeNumeric(a._meta.popularity, b._meta.popularity, Math.max)
    }
  };
}

function mergeNumeric(aVal, bVal, reducer) {
  if (aVal == null) return bVal;
  if (bVal == null) return aVal;
  return reducer(aVal, bVal);
}

/**
 * Dédoublonne une liste d'artistes normalisés par mbid puis par nom normalisé.
 * @param {Array} artists - liste d'objets normalisés
 * @returns {Array} liste sans doublons
 */
function dedupeArtists(artists) {
  const byMbid = new Map();
  const byName = new Map();
  const looseDuplicates = [];

  for (const artist of artists) {
    if (!artist.normalizedName) continue;

    const mbid = artist.ids?.mbid;
    if (mbid) {
      const existing = byMbid.get(mbid);
      if (existing) {
        byMbid.set(mbid, mergeArtists(existing, artist));
      } else {
        byMbid.set(mbid, artist);
      }
      continue;
    }

    const existing = byName.get(artist.normalizedName);
    if (existing) {
      byName.set(artist.normalizedName, mergeArtists(existing, artist));
    } else {
      byName.set(artist.normalizedName, artist);
    }
  }

  // Regrouper par nom : si un artiste avec mbid a le même nom normalisé qu'un
  // artiste sans mbid, les fusionner et ne garder que l'entrée mbid.
  for (const [mbid, artist] of byMbid.entries()) {
    const twin = byName.get(artist.normalizedName);
    if (twin) {
      byMbid.set(mbid, mergeArtists(artist, twin));
      byName.delete(artist.normalizedName);
    }
  }

  return [...byMbid.values(), ...byName.values()];
}

module.exports = {
  normalizeName,
  normalizeForDedupe,
  createNormalizedArtist,
  mergeArtists,
  dedupeArtists
};
