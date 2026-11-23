// Radios par décennie : sources éditoriales Deezer (playlists d'éditeurs et
// radios), servies par lots de 20. Sans état serveur : le client renvoie les
// titres déjà joués, donc un redémarrage de Render ne coupe aucune radio.
const axios = require('axios');
const CONFIG = require('./config');
const cache = require('./cache');
const { isBadVariant } = require('./filters');
const { trackTitleKey } = require('./seed');

const API = CONFIG.endpoints.deezer.apiBase;
const BATCH = 20;
const MAX_PER_ARTIST = 2;
const RECENT_WINDOW = 20; // en cas d'épuisement, on rejoue tout sauf les derniers titres

// `playlist` = liste fixe d'un éditeur Deezer ; `radio` = échantillon renouvelé
// à chaque appel (100 titres tirés dans la radio éditoriale).
const DECADES = [
  { id: '1960', label: 'Années 60', color: '#c9a063', sources: [['playlist', 908622995], ['playlist', 6312331044], ['playlist', 944752975], ['radio', 39402]] },
  { id: '1970', label: 'Années 70', color: '#e0803a', sources: [['playlist', 1075854071], ['radio', 38295], ['radio', 39422]] },
  { id: '1980', label: 'Années 80', color: '#e8449a', sources: [['playlist', 1163842311], ['radio', 38305], ['radio', 39442]] },
  { id: '1990', label: 'Années 90', color: '#4f8ef0', sources: [['playlist', 1251125011], ['radio', 39462]] },
  { id: '2000', label: 'Années 2000', color: '#2fc4b2', sources: [['playlist', 751764391], ['radio', 39482]] },
  { id: '2010', label: 'Années 2010', color: '#8a6cf0', sources: [['playlist', 2051712324], ['playlist', 5175061384]] },
  { id: '2020', label: 'Années 2020', color: '#1ed760', sources: [['playlist', 11915740641], ['playlist', 13650084141], ['playlist', 9563400362]] }
];

function listDecades() {
  return DECADES.map(({ id, label, color }) => ({ id, label, color }));
}

function findDecade(id) {
  return DECADES.find(d => d.id === String(id)) || null;
}

function normalizeTrack(t) {
  if (!t?.title || !t.artist?.name || isBadVariant(t.title)) return null;
  return {
    title: t.title,
    artist: t.artist.name,
    album: t.album?.title || null,
    year: null,
    bpm: null,
    duration: t.duration || null,
    ids: { deezer: String(t.id) },
    image: t.album?.cover_xl || t.album?.cover_big || t.album?.cover || null,
    tags: [],
    score: null,
    familiar: false,
    sources: ['deezer'],
    normalizedKey: trackTitleKey(t.title, t.artist.name)
  };
}

async function fetchSource([type, id]) {
  try {
    if (type === 'playlist') {
      const cached = cache.get('search', String(id), 'decade-playlist');
      if (cached) return cached;
      const res = await axios.get(`${API}/playlist/${id}/tracks?limit=200`, { timeout: CONFIG.sourceTimeoutMs });
      const tracks = (res.data?.data || []).map(normalizeTrack).filter(Boolean);
      return tracks.length ? cache.set('search', String(id), 'decade-playlist', tracks) : [];
    }
    const res = await axios.get(`${API}/radio/${id}/tracks?limit=100`, { timeout: CONFIG.sourceTimeoutMs });
    return (res.data?.data || []).map(normalizeTrack).filter(Boolean);
  } catch (e) {
    console.warn(`[decades] ${type}/${id}:`, e.message);
    return [];
  }
}

function shuffle(list, rand = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Choisit un lot : pas de titre déjà joué, 2 titres au plus par artiste, jamais
 * deux fois le même artiste de suite. Si les titres neufs ne suffisent pas, on
 * rejoue des anciens (hors les derniers joués) plutôt que de s'arrêter.
 */
function pickBatch(pool, excludeKeys = [], limit = BATCH, rand = Math.random) {
  const played = new Set(excludeKeys);
  // Fenêtre bornée à la moitié du vivier : sinon un petit vivier ne rejouerait jamais rien.
  const recent = new Set(excludeKeys.slice(-Math.min(RECENT_WINDOW, Math.floor(pool.length / 2))));
  const fresh = shuffle(pool.filter(t => !played.has(t.normalizedKey)), rand);
  const replay = shuffle(pool.filter(t => played.has(t.normalizedKey) && !recent.has(t.normalizedKey)), rand);

  const perArtist = new Map();
  const out = [];
  for (const t of [...fresh, ...replay]) {
    if (out.length >= limit) break;
    const n = perArtist.get(t.artist) || 0;
    if (n >= MAX_PER_ARTIST) continue;
    if (out.length && out[out.length - 1].artist === t.artist) continue;
    perArtist.set(t.artist, n + 1);
    out.push(t);
  }
  return out;
}

async function nextDecadeBatch(decadeId, { excludeKeys = [], limit = BATCH } = {}) {
  const decade = findDecade(decadeId);
  if (!decade) return null;
  const groups = await Promise.all(decade.sources.map(fetchSource));
  const byKey = new Map();
  groups.flat().forEach(t => { if (!byKey.has(t.normalizedKey)) byKey.set(t.normalizedKey, t); });
  const pool = [...byKey.values()];
  const tracks = pickBatch(pool, excludeKeys, Math.min(Math.max(limit, 1), 40)).map((t, i) => ({ ...t, index: i + 1 }));
  return { decade: { id: decade.id, label: decade.label, color: decade.color }, tracks, poolSize: pool.length };
}

module.exports = { DECADES, listDecades, findDecade, pickBatch, nextDecadeBatch, normalizeTrack };
