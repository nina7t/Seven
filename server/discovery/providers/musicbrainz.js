const axios = require('axios');
const { normalizeForDedupe } = require('../normalize');

// MusicBrainz tolère ~1 requête par seconde et exige un User-Agent identifiable.
const API = 'https://musicbrainz.org/ws/2/artist/';
const USER_AGENT = 'SEVENZ-radio/1.0';
const GAP_MS = 1100;
const MAX_ENTRIES = 5000;

// Époque d'un artiste : ne change pas, donc pas d'expiration. `null` veut dire
// « cherché, introuvable » ; une erreur réseau n'est jamais mémorisée.
const known = new Map();
const pending = new Map();
let chain = Promise.resolve();

/**
 * Décennie de début de carrière. Pour une personne, `begin` est sa naissance :
 * on ajoute 20 ans (Piaf née en 1915 → années 1930). Pour un groupe, c'est la
 * formation.
 */
function careerDecade(artist) {
  const begin = artist?.['life-span']?.begin;
  const year = parseInt(String(begin || '').slice(0, 4), 10);
  if (!Number.isFinite(year)) return null;
  const start = artist.type === 'Person' ? year + 20 : year;
  return Math.floor(start / 10) * 10;
}

/** Meilleur résultat : nom exact, score élevé, avec une date de début. */
function pickArtist(list, name) {
  const target = normalizeForDedupe(name);
  return (list || [])
    .filter(a => a.score >= 90 && normalizeForDedupe(a.name) === target && a['life-span']?.begin)
    .sort((a, b) => b.score - a.score)[0] || null;
}

async function lookup(name) {
  const url = `${API}?query=${encodeURIComponent(`artist:"${name}"`)}&fmt=json&limit=5`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await axios.get(url, { timeout: 6000, headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
    const data = res?.data;
    if (data?.artists) {
      const decade = careerDecade(pickArtist(data.artists, name));
      return decade ? [decade] : null;
    }
    // « serveur occupé » ou réseau : on patiente puis on réessaie.
    await new Promise(r => setTimeout(r, GAP_MS * (attempt + 2)));
  }
  throw new Error('musicbrainz indisponible');
}

function schedule(name) {
  const key = normalizeForDedupe(name);
  if (known.has(key)) return Promise.resolve(known.get(key));
  if (pending.has(key)) return pending.get(key);

  const job = chain.then(async () => {
    const eras = await lookup(name);
    if (known.size >= MAX_ENTRIES) known.delete(known.keys().next().value);
    known.set(key, eras);
    return eras;
  }).catch(() => undefined).finally(() => pending.delete(key));
  pending.set(key, job);
  // La file avance d'une requête par seconde, que la précédente ait échoué ou non.
  chain = job.then(() => new Promise(r => setTimeout(r, GAP_MS)));
  return job;
}

/** Réponse immédiate : décennies connues, ou `[]` si inconnu / pas encore cherché. */
function cachedEras(name) {
  return known.get(normalizeForDedupe(name)) || [];
}

/**
 * Lance la recherche pour ces artistes (dans l'ordre, 1/s) et attend au plus
 * `budgetMs`. Le reste continue en arrière-plan et remplit le cache pour les
 * lots suivants de la radio.
 */
async function prefetchEras(names, { budgetMs = 3000, max = 30 } = {}) {
  if (process.env.MUSICBRAINZ_DISABLED) return;
  const todo = [...new Set(names.filter(Boolean))]
    .filter(n => !known.has(normalizeForDedupe(n)))
    .slice(0, max);
  if (!todo.length) return;
  const all = Promise.all(todo.map(schedule));
  await Promise.race([all, new Promise(r => setTimeout(r, budgetMs))]);
}

module.exports = { prefetchEras, cachedEras, careerDecade, pickArtist };
