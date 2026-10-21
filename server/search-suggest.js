// Suggestions de recherche façon Spotify : classement des entités mixtes
// (artiste / titre / album) renvoyées par /search/autocomplete de Deezer.
// Module pur : pas d'appel réseau ici, la route /api/suggest injecte le payload.

const TIER_WEIGHT = 1.2;
const ARTIST_MATCH_BONUS = 0.6;
// Spotify met volontiers un artiste en top hit quand son nom correspond.
const ARTIST_TYPE_BONUS = 1.5;
// L'ordre des artistes renvoyé par Deezer est déjà un signal de pertinence.
const DEEZER_ORDER_WEIGHT = 0.5;
const NEUTRAL_POPULARITY = 4.5;
const MIN_POPULARITY_UNMATCHED = 4;

const MAX_ITEMS = 10;
const MAX_ARTISTS = 3;
const MAX_TRACKS = 5;
const MAX_ALBUMS = 2;

// ── Helpers Deezer partagés (déplacés depuis server.js, réutilisés par les
// routes existantes) ────────────────────────────────────────────────────────

function msToDurationSec(ms) {
  if (!ms || ms <= 0) return null;
  return Math.round(ms / 1000);
}

function deezerCoverUrl(small, medium, big, xl) {
  return xl || big || medium || small || null;
}

function mapDeezerTrackToResult(track) {
  return {
    artist: track.artist?.name || '',
    title: track.title || '',
    album: track.album?.title || '',
    durationSec: msToDurationSec(track.duration * 1000) || track.duration || 0,
    coverUrl: deezerCoverUrl(
      track.album?.cover,
      track.album?.cover_medium,
      track.album?.cover_big,
      track.album?.cover_xl
    ),
    albumId: track.album?.id ? String(track.album.id) : null,
    isrc: track.isrc || null,
    source: 'deezer',
    sourceId: String(track.id || '')
  };
}

// ── Normalisation / matching ────────────────────────────────────────────────

// Minuscules, sans accents, apostrophes supprimées (« O'Connor » → « oconnor »),
// le reste de la ponctuation devient des espaces.
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// « y » et « i » se prononcent pareil : « synad » doit trouver « Sinéad ».
// Appliqué au nom comme à la requête dans tier().
function fold(s) {
  return norm(s).replace(/y/g, 'i');
}

// Variante de la requête à envoyer aussi à Deezer, qui ne fait pas ce
// rapprochement lui-même. null si elle ne change rien.
function phoneticVariant(q) {
  const v = (q || '').replace(/[yÿý]/gi, 'i');
  return v.toLowerCase() === (q || '').toLowerCase() ? null : v;
}

// Fusionne deux réponses /search/autocomplete, la première d'abord,
// sans doublons d'identifiant.
function mergePayloads(a, b) {
  if (!b) return a;
  const out = {};
  for (const k of ['artists', 'tracks', 'albums']) {
    const seen = new Set();
    out[k] = { data: [...(a?.[k]?.data || []), ...(b?.[k]?.data || [])].filter(x => {
      if (seen.has(x.id)) return false;
      seen.add(x.id);
      return true;
    }) };
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// Niveau de correspondance entre un nom affiché et la requête tapée :
//   3 = identique, 2.5 = mot entier, 2 = préfixe, 1 = faute sur un mot entier,
//   0.5 = faute sur un début de mot, 0 = rien.
function tier(name, q) {
  const n = fold(name), t = fold(q);
  if (!n || !t) return 0;
  if (n === t) return 3;

  const words = n.split(' ');
  if (` ${n} `.includes(` ${t} `)) return 2.5;
  if (n.startsWith(t) || words.some(w => w.startsWith(t))) return 2;

  // Fuzzy : un seul mot tapé, d'au moins 4 caractères, comparé à chaque mot
  // du nom ( « sinad » ≈ « sinead » ), puis à son préfixe de la même longueur,
  // moins fiable ( « sinad » ≈ « sinat|ra » ).
  if (!t.includes(' ') && t.length >= 4) {
    const maxD = t.length >= 7 ? 2 : 1;
    if (words.some(w => levenshtein(w, t) <= maxD)) return 1;
    if (words.some(w => w.length > t.length && levenshtein(w.slice(0, t.length), t) <= maxD)) return 0.5;
  }

  // Plusieurs mots tapés ( « synad oconnor » ) : chacun doit retrouver un mot
  // du nom, à l'identique, par son début ou à une faute près s'il est assez long.
  if (t.includes(' ')) {
    const ok = t.split(' ').every(qw => words.some(w =>
      w.startsWith(qw) || (qw.length >= 4 && levenshtein(w, qw) <= (qw.length >= 7 ? 2 : 1))
    ));
    if (ok) return 1;
  }
  return 0;
}

// Une faute sur un début de mot ne doit pas laisser une star écraser
// le résultat cherché : sa popularité ne compte qu'à moitié.
function popularityFor(t, popularity) {
  return t === 0.5 ? popularity / 2 : popularity;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function rankSuggestions(query, payload) {
  const artists = payload?.artists?.data || [];
  const tracks = payload?.tracks?.data || [];
  const albums = payload?.albums?.data || [];

  const items = [];

  // Artistes : dédoublonnés par nom normalisé, on garde le plus suivi.
  const artistByName = new Map();
  const deezerIndex = new Map();
  artists.forEach((a, i) => {
    const key = norm(a.name);
    if (!key) return;
    if (!deezerIndex.has(key)) deezerIndex.set(key, i);
    const cur = artistByName.get(key);
    if (!cur || (a.nb_fan || 0) > (cur.nb_fan || 0)) artistByName.set(key, a);
  });
  for (const [key, a] of artistByName) {
    const nameTier = tier(a.name, query);
    const popularity = Math.log10((a.nb_fan || 0) + 1);
    if (nameTier === 0 && popularity < MIN_POPULARITY_UNMATCHED) continue;
    const bonus = nameTier > 0
      ? ARTIST_TYPE_BONUS + DEEZER_ORDER_WEIGHT * (1 - deezerIndex.get(key) / artists.length)
      : 0;
    items.push({
      type: 'artist',
      id: String(a.id || ''),
      name: a.name || '',
      picture: a.picture_medium || a.picture || null,
      nbFan: a.nb_fan || 0,
      topHit: false,
      _score: TIER_WEIGHT * nameTier + popularityFor(nameTier, popularity) + bonus
    });
  }

  // La liste d'artistes de Deezer ignore la popularité (« frank » n'y donne
  // que des homonymes à 10 fans) alors que ses titres en tiennent compte :
  // on promeut les artistes de ces titres dont le nom correspond, avec le
  // rang de leur meilleur titre comme popularité.
  const fromTracks = new Map();
  for (const t of tracks) {
    const key = norm(t.artist?.name);
    if (!key || artistByName.has(key) || tier(t.artist.name, query) < 2) continue;
    const cur = fromTracks.get(key);
    if (!cur || (t.rank || 0) > (cur.rank || 0)) fromTracks.set(key, t);
  }
  for (const t of fromTracks.values()) {
    items.push({
      type: 'artist',
      id: String(t.artist.id || ''),
      name: t.artist.name,
      picture: t.artist.picture_medium || t.artist.picture || null,
      nbFan: 0,
      topHit: false,
      _score: TIER_WEIGHT * tier(t.artist.name, query) + Math.log10((t.rank || 0) + 1) + ARTIST_TYPE_BONUS
    });
  }

  // Titres : dédoublonnés par titre+artiste, on garde le mieux classé Deezer.
  const trackByKey = new Map();
  for (const t of tracks) {
    const key = `${norm(t.title)}|${norm(t.artist?.name)}`;
    if (!norm(t.title)) continue;
    const cur = trackByKey.get(key);
    if (!cur || (t.rank || 0) > (cur.rank || 0)) trackByKey.set(key, t);
  }
  for (const t of trackByKey.values()) {
    const titleTier = tier(t.title, query);
    const artistTier = tier(t.artist?.name, query);
    const popularity = Math.log10((t.rank || 0) + 1);
    if (titleTier === 0 && artistTier === 0 && popularity < MIN_POPULARITY_UNMATCHED) continue;
    items.push({
      ...mapDeezerTrackToResult(t),
      type: 'track',
      topHit: false,
      _score: TIER_WEIGHT * titleTier + (artistTier >= 1 ? ARTIST_MATCH_BONUS : 0)
        + popularityFor(Math.max(titleTier, artistTier), popularity)
    });
  }

  for (const al of albums) {
    const titleTier = tier(al.title, query);
    const artistTier = tier(al.artist?.name, query);
    // Pas de métrique de popularité fiable pour un album : constante neutre.
    if (titleTier === 0 && artistTier === 0) continue;
    items.push({
      type: 'album',
      id: String(al.id || ''),
      title: al.title || '',
      artist: al.artist?.name || '',
      recordType: al.record_type || '',
      coverUrl: al.cover_medium || al.cover || null,
      topHit: false,
      _score: TIER_WEIGHT * titleTier + (artistTier >= 1 ? ARTIST_MATCH_BONUS : 0) + NEUTRAL_POPULARITY
    });
  }

  items.sort((a, b) => b._score - a._score);
  if (!items.length) return [];

  // Le premier résultat est le « top hit » ; les places restantes sont
  // réparties par type comme dans l'autocomplétion Spotify.
  const top = items[0];
  top.topHit = true;
  const caps = { artist: MAX_ARTISTS, track: MAX_TRACKS, album: MAX_ALBUMS };
  const out = [top];
  const kept = { artist: 0, track: 0, album: 0 };
  for (const it of items.slice(1)) {
    if (out.length >= MAX_ITEMS) break;
    if (kept[it.type] >= caps[it.type]) continue;
    kept[it.type]++;
    out.push(it);
  }
  for (const it of out) delete it._score;
  return out;
}

module.exports = {
  rankSuggestions,
  phoneticVariant,
  mergePayloads,
  norm,
  tier,
  mapDeezerTrackToResult,
  msToDurationSec,
  deezerCoverUrl
};
