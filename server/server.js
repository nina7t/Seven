const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

// yt-dlp n'est qu'un FALLBACK d'extraction audio (quand toutes les instances
// Invidious sont bloquées). Chargement paresseux et tolérant : son absence doit
// dégrader cette seule fonctionnalité, jamais empêcher le serveur de démarrer.
let _ytdl = null;
let _ytdlUnavailable = false;
function getYtdl() {
  if (_ytdlUnavailable) return null;
  if (_ytdl) return _ytdl;
  try {
    _ytdl = require('youtube-dl-exec');
    return _ytdl;
  } catch (e) {
    console.warn('[YTDL] module indisponible, fallback yt-dlp désactivé:', e.message);
    _ytdlUnavailable = true;
    return null;
  }
}

const { getFallbackTrending, getFallbackVideos } = require('./fallback-data');
const { searchInvidious, getTrendingInvidious, getVideosInvidious } = require('./invidious-client');
const discoveryCache = require('./discovery/cache');
const lastfmProvider = require('./discovery/providers/lastfm');

const app = express();
// Faire confiance au premier proxy (Render, Netlify, Nginx) pour que req.ip
// reflète l'IP client réelle (X-Forwarded-For) et que le rate limiting
// soit appliqué par utilisateur et non par IP de proxy partagée.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// Support multi-clé API YouTube (rotation quota) — nombre illimité de clés
// YOUTUBE_API_KEY, puis YOUTUBE_API_KEY_2, _3, _4, _5, ... dans .env
const API_KEYS = [
  process.env.YOUTUBE_API_KEY,
  ...Array.from({ length: 19 }, (_, i) => process.env[`YOUTUBE_API_KEY_${i + 2}`])
].filter(Boolean);

if (!API_KEYS[0]) {
  console.error('ERREUR: YOUTUBE_API_KEY non définie dans .env');
  process.exit(1);
}

// Spotify (import playlists) — optionnel, requis seulement pour /api/spotify/playlist
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3001/api/spotify/callback';
const SPOTIFY_AUTH_SCOPES = 'playlist-read-private playlist-read-collaborative';
const spotifyStateCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

let currentKeyIndex = 0;
function getCurrentKey() { return API_KEYS[currentKeyIndex]; }
function getCurrentKeyIndex() { return currentKeyIndex; }

// Rotation vers prochaine clé si celle-ci est épuisée.
// `failedIdx` = clé utilisée par la requête en échec : si une requête
// concurrente a déjà fait tourner la clé, on ne saute pas une clé saine.
function rotateKey(failedIdx) {
  if (API_KEYS.length <= 1 || failedIdx !== currentKeyIndex) return;
  currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
  console.log(`[KEY] Rotation vers clé ${currentKeyIndex + 1}/${API_KEYS.length}`);
}

// Cache avec TTL de 6 heures pour les recherches (économie quota), 24h pour les tendances
const searchCache = new NodeCache({ stdTTL: 21600, checkperiod: 600 }); // 6h = 4x moins de requêtes
const trendingCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const videoCache = new NodeCache({ stdTTL: 21600, checkperiod: 600 }); // 6h aussi

// Request coalescing - évite les requêtes dupliquées simultanées
const pendingSearches = new Map(); // query -> Promise
const pendingVideos = new Map();   // ids -> Promise

// Suivi quota approximatif (100 unités par search, 1 unité par video)
// Persistance dans un fichier pour survivre aux redémarrages
const QUOTA_FILE = path.join(__dirname, '.quota.json');
const QUOTA_LIMIT = 9500; // Marge de sécurité avant 10000

function loadQuotaState() {
  try {
    if (fs.existsSync(QUOTA_FILE)) {
      const data = JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
      const savedDate = new Date(data.resetTime);
      const now = new Date();
      
      // Si c'est un nouveau jour, reset
      if (now > savedDate) {
        console.log('[QUOTA] Nouveau jour détecté, reset du quota');
        return { used: 0, resetTime: getTomorrowMidnight() };
      }
      console.log(`[QUOTA] Chargé: ${data.used}/${QUOTA_LIMIT} (reset: ${savedDate.toISOString()})`);
      return { used: data.used || 0, resetTime: savedDate };
    }
  } catch (e) {
    console.error('[QUOTA] Erreur chargement:', e.message);
  }
  return { used: 0, resetTime: getTomorrowMidnight() };
}

function getTomorrowMidnight() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function saveQuotaState() {
  try {
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({
      used: quotaUsedToday,
      resetTime: quotaResetTime.toISOString()
    }));
  } catch (e) {
    console.error('[QUOTA] Erreur sauvegarde:', e.message);
  }
}

const quotaState = loadQuotaState();
let quotaUsedToday = quotaState.used;
let quotaResetTime = new Date(quotaState.resetTime);

// Détection robuste d'une erreur de quota YouTube.
// YouTube renvoie un HTTP 403 (et non 429) OU une erreur dans le corps d'une
// réponse 200. Comme on re-throw via `new Error(data.error.message)` (qui n'a
// pas de `.response`), il FAUT aussi inspecter le message texte, sinon le
// fallback (rotation de clé / Invidious) n'était jamais déclenché.
function isQuotaError(error) {
  const status = error.response?.status;
  if (status === 403 || status === 429) return true;
  const apiMsg = error.response?.data?.error?.message || '';
  const combined = `${error.message || ''} ${apiMsg}`;
  return /quota|exceeded|rate.?limit|dailylimit|userratelimit/i.test(combined);
}

// Sauvegarder toutes les 30 secondes et à l'arrêt
setInterval(saveQuotaState, 30000);
process.on('SIGINT', () => { saveQuotaState(); process.exit(0); });
process.on('SIGTERM', () => { saveQuotaState(); process.exit(0); });
// Express 4 n'attrape pas les rejets des handlers async : sans ce garde-fou,
// une seule requête malformée suffisait à tuer le processus.
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

// Rate limiting simple
const requestLog = new Map();
const RATE_LIMIT_PER_MINUTE = 60; // 60 requêtes/minute par IP

app.use(cors());
app.use(express.json());

// Moteur radio à partir d'un titre (rateLimit est une déclaration de
// fonction, donc déjà disponible ici)
app.use('/api/radio', rateLimit, require('./discovery/routes/radio'));

// Middleware de rate limiting (exempté pour localhost)
function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || '';

  // Exempter localhost (développement local)
  // ::ffff:127.0.0.1 = format IPv6-mapped vu par Express quand le navigateur appelle localhost
  if (ip.includes('127.0.0.1') || ip === '::1' || ip.includes('localhost')) {
    return next();
  }

  const now = Date.now();
  const windowStart = now - 60000; // 1 minute

  if (!requestLog.has(ip)) {
    requestLog.set(ip, []);
  }

  const requests = requestLog.get(ip).filter(time => time > windowStart);

  if (requests.length >= RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({
      error: 'Trop de requêtes. Veuillez patienter une minute.',
      retryAfter: 60
    });
  }

  requests.push(now);
  requestLog.set(ip, requests);
  next();
}

// Nettoyage périodique du rate limiting
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of requestLog.entries()) {
    const valid = times.filter(t => now - t < 60000);
    if (valid.length === 0) requestLog.delete(ip);
    else requestLog.set(ip, valid);
  }
}, 60000);

// Route de santé avec monitoring quota
app.get('/api/health', (req, res) => {
  // Reset quota si nouveau jour
  const now = new Date();
  if (now > quotaResetTime) {
    quotaUsedToday = 0;
    quotaResetTime.setDate(quotaResetTime.getDate() + 1);
  }
  
  res.json({ 
    status: 'ok', 
    keys: {
      total: API_KEYS.length,
      current: currentKeyIndex + 1
    },
    quota: {
      used: quotaUsedToday,
      limit: QUOTA_LIMIT,
      remaining: Math.max(0, QUOTA_LIMIT - quotaUsedToday),
      percentUsed: Math.round((quotaUsedToday / QUOTA_LIMIT) * 100)
    },
    cacheStats: {
      search: searchCache.getStats(),
      trending: trendingCache.getStats(),
      video: videoCache.getStats(),
      discovery: discoveryCache.stats()
    }
  });
});

// ════════════════════════════════════════════════════════════
// RECHERCHE MÉTADONNÉES (Deezer)
// ════════════════════════════════════════════════════════════
// Sépare la recherche d'entités officielles (artiste/titre/album/durée)
// de la résolution du flux audio (NewPipeExtractor côté APK).

const metadataCache = new NodeCache({ stdTTL: 21600, checkperiod: 600 }); // 6h

// Normalise une chaîne pour comparaison : minuscules, sans ponctuation,
// sans espaces multiples, sans les suffixes d'édition audio.
function normalizeMetadataText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // accents
    .replace(/[.,/#!$%^&*;:{}=\-_`~()\[\]"'|?]/g, ' ') // ponctuation -> espace
    .replace(/\b(feat(uring)?|ft|with)\b\.?/g, ' ') // feat.
    .replace(/\b(remastered|remaster|explicit|clean|hd|official video|official audio|audio|video|live|acoustic|instrumental|radio edit|extended|deluxe)\b/g, ' ')
    .replace(/\b(sped up|slowed|reverb|8d|nightcore)\b/g, ' ')
    .replace(/\(\d{4}\)/g, ' ') // années entre parenthèses
    .replace(/\s+/g, ' ')
    .trim();
}

function durationSecToMs(sec) { return (sec || 0) * 1000; }

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

// PROXY: Recherche de métadonnées sur Deezer (pas de clé API requise)
app.get('/api/search', rateLimit, async (req, res) => {
  const { q, limit = 15 } = req.query;

  if (!q || typeof q !== 'string' || q.trim().length < 2) {
    return res.status(400).json({ error: 'Paramètre q requis (min 2 caractères)' });
  }

  const cleanQ = q.trim().slice(0, 200);
  const cacheKey = `metadata:${cleanQ.toLowerCase()}:${limit}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(cleanQ)}&limit=${Math.min(parseInt(limit) || 15, 50)}`;
    const response = await axios.get(url, { timeout: 8000 });

    if (response.data.error) {
      throw new Error(response.data.error.message || 'Deezer API error');
    }

    const results = (response.data.data || [])
      .map(mapDeezerTrackToResult)
      .filter(r => r.artist && r.title);

    const payload = {
      query: cleanQ,
      count: results.length,
      results
    };

    metadataCache.set(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('[DEEZER SEARCH ERROR]', error.message);
    res.status(502).json({
      error: 'Erreur lors de la recherche de métadonnées',
      details: error.message
    });
  }
});

// ════════════════════════════════════════════════════════════════════
// PAGES ARTISTE / ALBUM (Deezer)
// ════════════════════════════════════════════════════════════════════
// Même principe que /api/search : Deezer fournit les ENTITÉS officielles
// (artiste, discographie, tracklist d'album) et YouTube ne sert qu'à
// résoudre l'audio au moment de la lecture, côté client.

const artistCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // 24h
const albumCache  = new NodeCache({ stdTTL: 86400, checkperiod: 3600 });
const newReleasesCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); // 1h

function deezerArtistPicture(a) {
  return a?.picture_xl || a?.picture_big || a?.picture_medium || a?.picture || null;
}

function deezerAlbumCover(al) {
  return al?.cover_xl || al?.cover_big || al?.cover_medium || al?.cover || null;
}

function mapDeezerArtist(a) {
  return {
    id: String(a.id),
    name: a.name || '',
    picture: deezerArtistPicture(a),
    nbFan: a.nb_fan || 0,
    nbAlbum: a.nb_album || 0
  };
}

function mapDeezerAlbumSummary(al) {
  return {
    id: String(al.id),
    title: al.title || '',
    cover: deezerAlbumCover(al),
    year: (al.release_date || '').substring(0, 4),
    releaseDate: al.release_date || '',
    type: al.record_type || 'album',
    fans: al.fans || 0,
    explicit: !!al.explicit_lyrics
  };
}

// Deezer liste chaque édition/réédition d'un album séparément : sans ce filtre,
// « Nonante-Cinq La Suite » apparaît deux fois dans la discographie. On garde
// l'édition la plus écoutée, puis la plus ancienne — celle que l'on considère
// comme la sortie de référence.
function dedupeReleases(list) {
  const byTitle = new Map();
  const norm = t => String(t || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  for (const rel of list) {
    const key = norm(rel.title);
    const kept = byTitle.get(key);
    if (!kept) { byTitle.set(key, rel); continue; }
    const better = rel.fans !== kept.fans
      ? rel.fans > kept.fans
      : (rel.releaseDate || '9999') < (kept.releaseDate || '9999');
    if (better) byTitle.set(key, rel);
  }
  return [...byTitle.values()];
}

async function deezerGetRaw(path) {
  const { data } = await axios.get(`https://api.deezer.com${path}`, { timeout: 8000 });
  return data;
}

async function deezerGet(path) {
  const data = await deezerGetRaw(path);
  if (data && data.error && Object.keys(data.error).length) {
    throw new Error(data.error.message || 'Deezer API error');
  }
  return data;
}

// Résout un nom d'artiste vers l'entité Deezer la plus probable.
// Deux critères, dans cet ordre : la justesse du nom, puis la notoriété.
// La notoriété seule choisirait un artiste proche mais différent ; le nom seul
// choisirait un homonyme obscur (« Angele » à 13 fans plutôt qu'Angèle).
async function resolveDeezerArtist(name) {
  const data = await deezerGet(`/search/artist?q=${encodeURIComponent(name)}&limit=10`);
  const list = data.data || [];
  if (!list.length) return null;

  return rankArtistMatches(list, name)[0] || null;
}

// Classe des artistes Deezer face à une saisie : justesse du nom d'abord,
// notoriété ensuite. Sans ça, « Indochine » remonte « Mount Indochina » et
// « Indorphine » avant le groupe cherché.
function rankArtistMatches(list, query) {
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const target = norm(query);
  const rank = a => {
    const n = norm(a.name);
    if (n === target) return 3;
    if (n.startsWith(target) || target.startsWith(n)) return 2;
    if (n.includes(target)) return 1;
    return 0;
  };
  return [...list].sort((a, b) => (rank(b) - rank(a)) || ((b.nb_fan || 0) - (a.nb_fan || 0)));
}

// GET /api/artist?q=<nom>  → artiste + titres populaires + discographie + similaires
app.get('/api/artist', rateLimit, async (req, res) => {
  const { q } = req.query;
  if (!q || typeof q !== 'string' || q.trim().length < 1) {
    return res.status(400).json({ error: 'Paramètre q requis' });
  }

  const name = q.trim().slice(0, 120);
  const cacheKey = `artist:${name.toLowerCase()}`;
  const cached = artistCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const found = await resolveDeezerArtist(name);
    if (!found) return res.status(404).json({ error: 'Artiste introuvable', name });

    const id = found.id;
    // Les trois volets sont indépendants : un échec ne doit pas vider la page.
    const [top, albums, related] = await Promise.all([
      deezerGet(`/artist/${id}/top?limit=10`).catch(() => ({ data: [] })),
      deezerGet(`/artist/${id}/albums?limit=40`).catch(() => ({ data: [] })),
      deezerGet(`/artist/${id}/related?limit=8`).catch(() => ({ data: [] }))
    ]);

    const payload = {
      artist: mapDeezerArtist(found),
      topTracks: (top.data || []).map(mapDeezerTrackToResult).filter(t => t.title),
      albums: dedupeReleases((albums.data || []).map(mapDeezerAlbumSummary))
        .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '')),
      related: (related.data || []).map(mapDeezerArtist)
    };

    artistCache.set(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('[DEEZER ARTIST ERROR]', error.message);
    res.status(502).json({ error: "Erreur lors du chargement de l'artiste", details: error.message });
  }
});

// GET /api/new-releases?artist=<nom>  → sorties les plus récentes d'un artiste
app.get('/api/new-releases', rateLimit, async (req, res) => {
  const artist = String(req.query.artist || '').trim().slice(0, 120);
  if (!artist) return res.status(400).json({ error: 'Paramètre artist requis' });

  const cacheKey = `newreleases:${artist.toLowerCase()}`;
  const cached = newReleasesCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const found = await resolveDeezerArtist(artist);
    if (!found) return res.status(404).json({ error: 'Artiste introuvable', artist });

    const albums = await deezerGet(`/artist/${found.id}/albums?limit=50`);
    const releases = (albums.data || [])
      .sort((a, b) => (b.release_date || '').localeCompare(a.release_date || ''))
      .slice(0, 8)
      .map(al => ({
        id: String(al.id),
        title: al.title || '',
        cover: deezerAlbumCover(al),
        release_date: al.release_date || '',
        record_type: al.record_type || 'album',
        ...(al.nb_tracks != null ? { tracks_count: al.nb_tracks } : {})
      }))
      .filter(al => al.title);

    const payload = { artist: mapDeezerArtist(found), releases };
    newReleasesCache.set(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('[DEEZER NEW RELEASES]', error.message);
    res.status(502).json({ error: error.message || 'Erreur lors du chargement des nouveautés' });
  }
});

// GET /api/album/:id  → album + tracklist complète
app.get('/api/album/:id', rateLimit, async (req, res) => {
  const id = String(req.params.id || '').replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'Identifiant album invalide' });

  const cacheKey = `album:${id}`;
  const cached = albumCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const al = await deezerGet(`/album/${id}`);
    const cover = deezerAlbumCover(al);

    // Les pistes d'un album ne portent pas leur pochette : on la recopie pour
    // que la file de lecture ait toujours une image.
    const tracks = (al.tracks?.data || []).map(t => ({
      artist: t.artist?.name || al.artist?.name || '',
      title: t.title || '',
      album: al.title || '',
      durationSec: t.duration || 0,
      coverUrl: cover,
      isrc: t.isrc || null,
      explicit: !!t.explicit_lyrics,
      source: 'deezer',
      sourceId: String(t.id || '')
    })).filter(t => t.title);

    const payload = {
      album: {
        id: String(al.id),
        title: al.title || '',
        cover,
        year: (al.release_date || '').substring(0, 4),
        releaseDate: al.release_date || '',
        type: al.record_type || 'album',
        nbTracks: al.nb_tracks || tracks.length,
        durationSec: al.duration || tracks.reduce((s, t) => s + (t.durationSec || 0), 0),
        label: al.label || '',
        explicit: !!al.explicit_lyrics,
        genres: (al.genres?.data || []).map(g => g.name)
      },
      artist: al.artist ? mapDeezerArtist(al.artist) : null,
      tracks
    };

    albumCache.set(cacheKey, payload);
    res.json(payload);
  } catch (error) {
    console.error('[DEEZER ALBUM ERROR]', error.message);
    res.status(502).json({ error: "Erreur lors du chargement de l'album", details: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// IMPORT DE PLAYLISTS DEEZER
// ════════════════════════════════════════════════════════════════════
// Contrairement à Spotify, l'API publique Deezer ne demande ni clé ni OAuth :
// le lien de la playlist suffit, tant qu'elle est publique. (La création de
// nouvelles applications Deezer est fermée depuis 2024, donc pas d'OAuth
// possible — les playlists privées sont hors de portée.)

const dzPlaylistCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); // 1h

// Accepte une URL complète (avec ou sans préfixe de langue), un lien de partage
// ou un identifiant nu.
function extractDeezerId(input, kind) {
  const str = String(input || '').trim();
  if (/^\d+$/.test(str)) return str;
  const paths = kind === 'user' ? '(?:profile|user)' : 'playlist';
  const m = str.match(new RegExp(`deezer\\.com/(?:[a-z]{2}/)?${paths}/(\\d+)`, 'i'));
  return m ? m[1] : null;
}

// Deezer renvoie ses erreurs en HTTP 200 avec un objet `error` dans le corps :
// tester le statut ne suffit pas.
function deezerErrorMessage(data, kind) {
  const err = data && data.error;
  if (!err || !Object.keys(err).length) return null;
  if (err.code === 800 || err.type === 'DataException') {
    return kind === 'user'
      ? 'Profil Deezer introuvable. Vérifie le lien (il doit ressembler à deezer.com/profile/123456).'
      : 'Playlist introuvable ou privée. Sur Deezer : ouvre la playlist → Modifier → passe-la en « Publique ».';
  }
  return err.message || 'Erreur Deezer';
}

// La tracklist incluse dans /playlist/{id} est TRONQUÉE À 400 TITRES, sans
// aucun champ `next` pour le signaler : une playlist de 636 titres en perdrait
// 236 en silence. On passe donc toujours par l'endpoint paginé dédié.
async function fetchDeezerPlaylistTracks(playlistId, total) {
  const tracks = [];
  const limit = 100;
  let index = 0;

  while (index < (total || Infinity)) {
    const page = await deezerGetRaw(`/playlist/${playlistId}/tracks?index=${index}&limit=${limit}`);
    const msg = deezerErrorMessage(page, 'playlist');
    if (msg) throw new Error(msg);

    const items = page.data || [];
    if (!items.length) break;
    for (const t of items) {
      if (t && t.title) tracks.push(mapDeezerTrackToResult(t));
    }
    if (!page.next) break;
    index += limit;
    if (tracks.length >= 2000) break; // garde-fou
  }
  return tracks;
}

// GET /api/deezer/artists  → photos d'artistes, pour l'écran d'accueil
// ────────────────────────────────────────────────────────────────────
// Deux modes :
//   ?names=a|b|c   résout chaque nom (grille d'onboarding : vraies photos)
//   ?search=nirv   recherche libre (l'utilisateur choisit un artiste absent
//                  de la liste proposée)
// `/genre/{id}/artists` et `/chart/{genre}/artists` renvoient le même top
// global quel que soit le genre : on ne peut pas construire la grille par genre
// côté Deezer, d'où la liste curée dans l'app et la simple résolution ici.
app.get('/api/deezer/artists', rateLimit, async (req, res) => {
  const search = String(req.query.search || '').trim();
  const names = String(req.query.names || '').split('|').map(n => n.trim()).filter(Boolean).slice(0, 40);

  if (!search && !names.length) {
    return res.status(400).json({ error: 'Paramètre names ou search requis' });
  }

  try {
    if (search) {
      const limit = Math.min(parseInt(req.query.limit) || 12, 25);
      const cacheKey = `dzsearch:${search.toLowerCase()}:${limit}`;
      const cached = artistCache.get(cacheKey);
      if (cached) return res.json({ ...cached, cached: true });

      const data = await deezerGetRaw(`/search/artist?q=${encodeURIComponent(search)}&limit=${Math.max(limit, 20)}`);
      const ranked = rankArtistMatches(data.data || [], search);
      const solid = ranked.filter(a => (a.nb_fan || 0) >= 1000);
      const kept = (solid.length >= 3 ? solid : ranked).slice(0, limit);
      const payload = { artists: kept.map(mapDeezerArtist).filter(a => a.name) };
      artistCache.set(cacheKey, payload);
      return res.json(payload);
    }

    // Résolution par nom, en petits lots : Deezer n'a pas d'endpoint groupé.
    const out = [];
    for (let i = 0; i < names.length; i += 6) {
      const chunk = names.slice(i, i + 6);
      const resolved = await Promise.all(chunk.map(async name => {
        const key = `dzname:${name.toLowerCase()}`;
        const hit = artistCache.get(key);
        if (hit) return hit;
        try {
          const found = await resolveDeezerArtist(name);
          const entry = found ? { query: name, ...mapDeezerArtist(found) } : { query: name, picture: null };
          artistCache.set(key, entry);
          return entry;
        } catch (e) {
          return { query: name, picture: null };
        }
      }));
      out.push(...resolved);
    }
    res.json({ artists: out });
  } catch (error) {
    console.error('[DEEZER ARTISTS]', error.message);
    res.status(502).json({ error: error.message || 'Erreur lors du chargement des artistes' });
  }
});

// GET /api/deezer/radio?artist=<nom>[&exclude=<titre>]  → titres liés, cohérents
// ────────────────────────────────────────────────────────────────────
// Remplace /youtube/related, dont la graine est le nom de la CHAÎNE YouTube.
// Cette chaîne est très souvent le label (« London Records » pour Bronski Beat),
// si bien que « la suite » devient le catalogue du label — interviews comprises,
// et du rap dès que le label en publie. La radio Deezer part de l'artiste réel.
app.get('/api/deezer/radio', rateLimit, async (req, res) => {
  const artist = String(req.query.artist || '').trim().slice(0, 120);
  if (!artist) return res.status(400).json({ error: 'Paramètre artist requis' });

  const exclude = String(req.query.exclude || '').trim().toLowerCase();
  const cacheKey = `radio:${artist.toLowerCase()}`;
  let payload = dzPlaylistCache.get(cacheKey);

  try {
    if (!payload) {
      const found = await resolveDeezerArtist(artist);
      if (!found) return res.status(404).json({ error: 'Artiste introuvable', artist });

      const radio = await deezerGetRaw(`/artist/${found.id}/radio`);
      const msg = deezerErrorMessage(radio, 'radio');
      if (msg) return res.status(502).json({ error: msg });

      payload = {
        artist: mapDeezerArtist(found),
        tracks: (radio.data || []).map(mapDeezerTrackToResult).filter(t => t.title)
      };
      dzPlaylistCache.set(cacheKey, payload);
    }

    // Le titre en cours ne doit pas réapparaître en tête de sa propre radio.
    const tracks = exclude
      ? payload.tracks.filter(t => (t.title || '').toLowerCase() !== exclude)
      : payload.tracks;

    res.json({ ...payload, tracks, count: tracks.length });
  } catch (error) {
    console.error('[DEEZER RADIO]', error.message);
    res.status(502).json({ error: error.message || 'Erreur lors du chargement de la radio' });
  }
});

// GET /api/deezer/playlist?url=<lien ou id>  → playlist + tracklist complète
app.get('/api/deezer/playlist', rateLimit, async (req, res) => {
  const id = extractDeezerId(req.query.url, 'playlist');
  if (!id) {
    return res.status(400).json({ error: 'Lien de playlist Deezer invalide (attendu : https://www.deezer.com/playlist/…)' });
  }

  const cached = dzPlaylistCache.get(`pl:${id}`);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const info = await deezerGetRaw(`/playlist/${id}`);
    const msg = deezerErrorMessage(info, 'playlist');
    if (msg) return res.status(404).json({ error: msg });

    const tracks = await fetchDeezerPlaylistTracks(id, info.nb_tracks);

    const payload = {
      playlist: {
        name: info.title || 'Playlist Deezer',
        description: info.description || '',
        coverUrl: info.picture_xl || info.picture_big || info.picture_medium || tracks[0]?.coverUrl || '',
        creator: info.creator?.name || '',
        externalUrl: info.link || `https://www.deezer.com/playlist/${id}`
      },
      count: tracks.length,
      expected: info.nb_tracks || tracks.length,
      tracks
    };

    dzPlaylistCache.set(`pl:${id}`, payload);
    res.json(payload);
  } catch (error) {
    console.error('[DEEZER PLAYLIST]', error.message);
    res.status(502).json({ error: error.message || 'Erreur lors du chargement de la playlist' });
  }
});

// GET /api/deezer/profile?url=<lien profil ou id>  → playlists publiques
app.get('/api/deezer/profile', rateLimit, async (req, res) => {
  const id = extractDeezerId(req.query.url, 'user');
  if (!id) {
    return res.status(400).json({ error: 'Lien de profil Deezer invalide (attendu : https://www.deezer.com/profile/…)' });
  }

  const cached = dzPlaylistCache.get(`user:${id}`);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const [user, lists] = await Promise.all([
      deezerGetRaw(`/user/${id}`),
      deezerGetRaw(`/user/${id}/playlists?limit=100`)
    ]);
    const msg = deezerErrorMessage(user, 'user') || deezerErrorMessage(lists, 'user');
    if (msg) return res.status(404).json({ error: msg });

    const payload = {
      user: {
        id: String(user.id),
        name: user.name || '',
        picture: user.picture_big || user.picture_medium || null
      },
      playlists: (lists.data || [])
        .filter(pl => pl.nb_tracks > 0)
        .map(pl => ({
          id: String(pl.id),
          title: pl.title || '',
          nbTracks: pl.nb_tracks || 0,
          cover: pl.picture_medium || pl.picture || null,
          link: pl.link || `https://www.deezer.com/playlist/${pl.id}`
        }))
    };

    if (!payload.playlists.length) {
      return res.status(404).json({ error: "Ce profil n'a aucune playlist publique. Sur Deezer, les playlists sont privées par défaut." });
    }

    dzPlaylistCache.set(`user:${id}`, payload);
    res.json(payload);
  } catch (error) {
    console.error('[DEEZER PROFILE]', error.message);
    res.status(502).json({ error: error.message || 'Erreur lors du chargement du profil' });
  }
});

// Identifiant vidéo YouTube : 11 caractères [A-Za-z0-9_-]
const YT_ID_RE = /^[\w-]{11}$/;

// maxResults borné à 1..50 (limite de l'API), 10 par défaut
function clampMaxResults(v) {
  return Math.min(50, Math.max(1, parseInt(v, 10) || 10));
}

// Quota épuisé sans repli réel : 503 détectable par le client, plutôt que des
// vidéos statiques tirées au hasard servies en HTTP 200.
function quotaError() {
  const e = new Error('Quota YouTube épuisé');
  e.reason = 'quota';
  return e;
}

function sendQuotaExhausted(res) {
  return res.status(503).json({ error: 'Quota YouTube épuisé, réessayez plus tard', reason: 'quota' });
}

// PROXY: Recherche YouTube avec coalescing et quota tracking
app.get('/api/youtube/search', rateLimit, async (req, res) => {
  let { q, type = 'video' } = req.query;

  // `?q=a&q=b` donne un tableau : sans ce test, q.toLowerCase() tuait le processus
  if (typeof q !== 'string' || !q) {
    return res.status(400).json({ error: 'Paramètre q (query) requis' });
  }
  if (type !== 'video') {
    return res.status(400).json({ error: 'Seul type=video est accepté' });
  }
  const maxResults = clampMaxResults(req.query.maxResults); // 10 par défaut pour économiser

  // Enrichir la requête pour cibler l'audio musique/podcast
  const lowerQ = q.toLowerCase();
  const hasMusicKeyword = ['music', 'song', 'audio', 'track', 'album', 'podcast', 'mix', 'dj ', 'radio', 'live'].some(k => lowerQ.includes(k));
  if (!hasMusicKeyword) {
    q = `${q} music audio`;
  }

  const cacheKey = `search:${q}:${maxResults}:${type}`;
  const cached = searchCache.get(cacheKey);
  
  if (cached) {
    console.log(`[CACHE HIT] Search: ${q}`);
    return res.json({ ...cached, cached: true });
  }

  // Request coalescing: si une recherche identique est en cours, on attend son résultat
  if (pendingSearches.has(cacheKey)) {
    console.log(`[COALESCING] Attente recherche en cours: ${q}`);
    try {
      const data = await pendingSearches.get(cacheKey);
      return res.json({ ...data, cached: false, coalesced: true });
    } catch (err) {
      // Échec de la requête partagée : on ne la relance pas pour chaque attente
      if (err.reason === 'quota') return sendQuotaExhausted(res);
      return res.status(502).json({ error: 'Erreur lors de la recherche YouTube', details: err.message });
    }
  }

  // Créer la promesse pour cette recherche
  const searchPromise = (async () => {
    // Clé figée pour cette requête : la rotation ne doit viser que celle-ci
    const keyIdx = getCurrentKeyIndex();
    const searchUrl = k => `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&videoCategoryId=10&topicId=%2Fm%2F04rlf&maxResults=${maxResults}&key=${API_KEYS[k]}`;
    try {
      console.log(`[API CALL] Search: ${q} (clé ${keyIdx + 1}/${API_KEYS.length})`);
      const response = await axios.get(searchUrl(keyIdx), { timeout: 5000 });
      
      if (response.data.error) {
        throw new Error(response.data.error.message);
      }

      // Tracker le quota utilisé (~100 unités par search)
      quotaUsedToday += 100;
      console.log(`[QUOTA] Utilisé: ${quotaUsedToday}/${QUOTA_LIMIT} (clé ${keyIdx + 1})`);

      searchCache.set(cacheKey, response.data);
      return response.data;
      
    } catch (error) {
      console.error('YouTube Search Error:', error.message);
      
      // Quota dépassé (429) → rotation de clé ou Invidious
      if (isQuotaError(error)) {
        console.warn('[YOUTUBE QUOTA] Clé épuisée, rotation...');
        rotateKey(keyIdx);
        
        // Si on a encore des clés, réessayer avec la nouvelle
        const retryIdx = getCurrentKeyIndex();
        if (retryIdx !== keyIdx) {
          try {
            const retryResponse = await axios.get(searchUrl(retryIdx), { timeout: 5000 });
            if (!retryResponse.data.error) {
              quotaUsedToday += 100;
              searchCache.set(cacheKey, retryResponse.data);
              return retryResponse.data;
            }
          } catch (retryError) {
            console.warn('[RETRY FAIL] Clé suivante aussi épuisée');
          }
        }
        
        // Toutes les clés épuisées → Invidious
        console.warn('[ALL KEYS EXHAUSTED] Passage sur Invidious...');
        try {
          return await searchInvidious(q, maxResults);
        } catch (invidiousError) {
          console.warn('[INVIDIOUS FAIL] Aucun repli disponible, 503 quota');
          throw quotaError();
        }
      }
      
      throw error;
    }
  })();

  pendingSearches.set(cacheKey, searchPromise);

  try {
    const data = await searchPromise;
    res.json({ ...data, cached: false });
  } catch (error) {
    if (error.reason === 'quota') return sendQuotaExhausted(res);
    res.status(500).json({
      error: 'Erreur lors de la recherche YouTube',
      details: error.message
    });
  } finally {
    // Nettoyer après un délai pour laisser les requêtes simultanées s'accrocher,
    // sans effacer une recherche plus récente lancée sous la même clé
    setTimeout(() => {
      if (pendingSearches.get(cacheKey) === searchPromise) pendingSearches.delete(cacheKey);
    }, 1000);
  }
});

// PROXY: Tendances YouTube
app.get('/api/youtube/trending', rateLimit, async (req, res) => {
  const cacheKey = 'trending:fr';
  const cached = trendingCache.get(cacheKey);
  
  if (cached) {
    console.log('[CACHE HIT] Trending');
    return res.json({ ...cached, cached: true });
  }

  const keyIdx = getCurrentKeyIndex();
  try {
    console.log('[API CALL] Trending');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=16&regionCode=FR&key=${API_KEYS[keyIdx]}`;
    
    const response = await axios.get(url, { timeout: 5000 });
    
    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    trendingCache.set(cacheKey, response.data);
    res.json({ ...response.data, cached: false });
    
  } catch (error) {
    console.error('YouTube Trending Error:', error.message);
    
    // Quota dépassé → rotation clé ou Invidious
    if (isQuotaError(error)) {
      rotateKey(keyIdx);
      try {
        const retryUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=16&regionCode=FR&key=${getCurrentKey()}`;
        const retryResponse = await axios.get(retryUrl, { timeout: 5000 });
        if (!retryResponse.data.error) {
          trendingCache.set(cacheKey, retryResponse.data);
          return res.json({ ...retryResponse.data, cached: false });
        }
      } catch (retryError) {}
      
      console.warn('[TRENDING] Toutes clés épuisées, Invidious...');
      try {
        const invidiousData = await getTrendingInvidious('FR');
        return res.json(invidiousData);
      } catch (invError) {
        const fallback = getFallbackTrending();
        return res.json(fallback);
      }
    }
    
    if (error.response?.data?.error?.message?.includes('quota')) {
      console.warn('[YOUTUBE QUOTA] Tentative avec Invidious...');
      try {
        const invidiousData = await getTrendingInvidious('FR');
        return res.json(invidiousData);
      } catch (invError) {
        console.warn('[INV FAIL] Fallback aux données statiques');
        const fallback = getFallbackTrending();
        return res.json(fallback);
      }
    }
    
    res.status(500).json({
      error: 'Erreur lors du chargement des tendances',
      details: error.message
    });
  }
});

// PROXY: Vidéos liées / recommandations
app.get('/api/youtube/related', rateLimit, async (req, res) => {
  const { videoId } = req.query;
  
  if (typeof videoId !== 'string' || !YT_ID_RE.test(videoId)) {
    return res.status(400).json({ error: 'Paramètre videoId requis (identifiant YouTube valide)' });
  }
  const maxResults = clampMaxResults(req.query.maxResults);

  // On met en cache 10 résultats par vidéo, puis on tronque à la demande :
  // maxResults=5 et maxResults=10 ne coûtent plus deux recherches.
  const RELATED_FETCH = 10;
  const sendRelated = (data, extra) =>
    res.json({ ...data, items: (data.items || []).slice(0, maxResults), ...extra });

  const cacheKey = `related:${videoId}`;
  const cached = searchCache.get(cacheKey);
  
  if (cached) {
    console.log(`[CACHE HIT] Related: ${videoId}`);
    return sendRelated(cached, { cached: true });
  }

  // `relatedToVideoId` a été supprimé de l'API YouTube v3 (août 2023).
  // Nouvelle stratégie : récupérer l'artiste/titre de la vidéo source (videos.list,
  // 1 unité de quota) puis faire une recherche dessus (search.list). On garde ainsi
  // le format search.list attendu par le client (item.id.videoId).

  // Graine de recommandation à partir de la vidéo source
  async function getSeedQuery(keyIdx) {
    try {
      const vurl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${API_KEYS[keyIdx]}`;
      const vresp = await axios.get(vurl, { timeout: 5000 });
      if (vresp.data.error) throw new Error(vresp.data.error.message);
      quotaUsedToday += 1;
      const snip = vresp.data?.items?.[0]?.snippet;
      if (!snip) return null;
      // Le nom de la chaîne (artiste) donne de meilleures recommandations que le titre
      return snip.channelTitle || snip.title || null;
    } catch (e) {
      if (isQuotaError(e)) throw e; // laisser remonter pour déclencher le fallback quota
      return null;
    }
  }

  // Recherche YouTube, en retirant la vidéo source des résultats
  async function searchRelated(q, keyIdx) {
    const surl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&videoCategoryId=10&maxResults=${RELATED_FETCH}&key=${API_KEYS[keyIdx]}`;
    const sresp = await axios.get(surl, { timeout: 5000 });
    if (sresp.data.error) throw new Error(sresp.data.error.message);
    quotaUsedToday += 100;
    const data = sresp.data;
    if (Array.isArray(data.items)) {
      data.items = data.items.filter(it => it?.id?.videoId !== videoId);
    }
    return data;
  }

  const keyIdx = getCurrentKeyIndex();
  try {
    console.log(`[API CALL] Related videos for: ${videoId}`);
    const seed = await getSeedQuery(keyIdx);
    if (!seed) {
      // Vidéo source introuvable : liste vide plutôt que des vidéos au hasard
      return res.json({ kind: 'youtube#searchListResponse', items: [] });
    }
    const data = await searchRelated(seed, keyIdx);
    console.log(`[QUOTA] +101 pour related, Total: ${quotaUsedToday}/${QUOTA_LIMIT}`);
    searchCache.set(cacheKey, data);
    sendRelated(data, { cached: false });

  } catch (error) {
    console.error('YouTube Related Error:', error.message);

    if (isQuotaError(error)) {
      rotateKey(keyIdx);
      const retryIdx = getCurrentKeyIndex();
      if (retryIdx !== keyIdx) {
        try {
          const seed = await getSeedQuery(retryIdx);
          if (seed) {
            const data = await searchRelated(seed, retryIdx);
            searchCache.set(cacheKey, data);
            return sendRelated(data, { cached: false });
          }
        } catch (retryError) {
          console.warn('[RELATED RETRY FAIL]', retryError.message);
        }
      }

      return sendQuotaExhausted(res);
    }

    res.status(500).json({
      error: 'Erreur lors du chargement des vidéos liées',
      details: error.message
    });
  }
});

// PROXY: Détails vidéos (durées) avec coalescing
app.get('/api/youtube/videos', rateLimit, async (req, res) => {
  // Seuls des identifiants YouTube valides partent vers l'API (50 max par appel)
  const ids = String(req.query.ids || '').split(',')
    .filter(id => YT_ID_RE.test(id)).slice(0, 50).join(',');
  
  if (!ids) {
    return res.status(400).json({ error: 'Paramètre ids requis' });
  }

  const cacheKey = `videos:${ids}`;
  const cached = videoCache.get(cacheKey);
  
  if (cached) {
    console.log(`[CACHE HIT] Videos: ${ids.substring(0, 30)}...`);
    return res.json({ ...cached, cached: true });
  }

  // Request coalescing pour les vidéos
  if (pendingVideos.has(cacheKey)) {
    console.log(`[COALESCING] Attente vidéos en cours: ${ids.substring(0, 30)}...`);
    try {
      const data = await pendingVideos.get(cacheKey);
      return res.json({ ...data, cached: false, coalesced: true });
    } catch (err) {
      // Échec de la requête partagée : on ne la relance pas pour chaque attente
      return res.status(502).json({ error: 'Erreur lors du chargement des vidéos', details: err.message });
    }
  }

  const videoPromise = (async () => {
    const keyIdx = getCurrentKeyIndex();
    try {
      console.log(`[API CALL] Videos: ${ids.substring(0, 30)}...`);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids}&key=${API_KEYS[keyIdx]}`;
      
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data.error) {
        throw new Error(response.data.error.message);
      }

      // Tracker quota (~1 unité par vidéo)
      const videoCount = ids.split(',').length;
      quotaUsedToday += videoCount;
      console.log(`[QUOTA] +${videoCount} pour vidéos, Total: ${quotaUsedToday}/${QUOTA_LIMIT}`);

      videoCache.set(cacheKey, response.data);
      return response.data;
      
    } catch (error) {
      console.error('YouTube Videos Error:', error.message);
      
      if (isQuotaError(error)) {
        rotateKey(keyIdx);
        const retryIdx = getCurrentKeyIndex();
        if (retryIdx !== keyIdx) {
          try {
            const retryUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids}&key=${API_KEYS[retryIdx]}`;
            const retryResponse = await axios.get(retryUrl, { timeout: 5000 });
            if (!retryResponse.data.error) {
              const videoCount = ids.split(',').length;
              quotaUsedToday += videoCount;
              videoCache.set(cacheKey, retryResponse.data);
              return retryResponse.data;
            }
          } catch (retryError) {}
        }
        
        try {
          return await getVideosInvidious(ids);
        } catch (invError) {
          return getFallbackVideos(ids);
        }
      }
      
      throw error;
    }
  })();

  pendingVideos.set(cacheKey, videoPromise);

  try {
    const data = await videoPromise;
    res.json({ ...data, cached: false });
  } catch (error) {
    res.status(500).json({
      error: 'Erreur lors du chargement des vidéos',
      details: error.message
    });
  } finally {
    setTimeout(() => {
      if (pendingVideos.get(cacheKey) === videoPromise) pendingVideos.delete(cacheKey);
    }, 1000);
  }
});

// Route pour vider le cache (admin)
app.post('/api/admin/clear-cache', (req, res) => {
  // Route sensible : exiger un token admin (header x-admin-token ou ?token=).
  // Sans ADMIN_TOKEN défini, la route est désactivée pour éviter qu'un tiers
  // vide le cache à distance (déni de service / explosion de quota).
  const adminToken = process.env.ADMIN_TOKEN;
  const provided = req.get('x-admin-token') || req.query.token;
  if (!adminToken || provided !== adminToken) {
    return res.status(403).json({ error: 'Non autorisé' });
  }

  const { key } = req.query;

  if (key === 'search') searchCache.flushAll();
  if (key === 'trending') trendingCache.flushAll();
  if (key === 'video') videoCache.flushAll();
  if (!key) {
    searchCache.flushAll();
    trendingCache.flushAll();
    videoCache.flushAll();
  }
  
  res.json({ message: 'Cache vidé', key: key || 'all' });
});

// ════════════════════════════════════════════════════════════
// LAST.FM - Recommandations d'artistes similaires
// La clé reste côté serveur (LASTFM_API_KEY), jamais exposée au client.
// Cache 24h : les données Last.fm bougent peu et l'API est gratuite mais
// limitée — on évite de la spammer à chaque chargement.
// ════════════════════════════════════════════════════════════

const lastfmCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // 24h

// L'appel HTTP passe par le fournisseur Last.fm du module radio (clé, retry,
// erreurs) ; on garde ici le cache et la réponse BRUTE attendue par le client
// (champs `image[]`, `name`…), que les fonctions normalisées du fournisseur
// ne renvoient pas.
async function callLastfm(method, params) {
  if (!lastfmProvider.isConfigured()) {
    console.warn('[LASTFM] LASTFM_API_KEY non définie — recommandations désactivées');
    return null;
  }
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  const cached = lastfmCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] Last.fm ${method}: ${params.artist}`);
    return cached;
  }
  const data = await lastfmProvider.call(method, params);
  lastfmCache.set(cacheKey, data);
  return data;
}

// Artistes similaires à un artiste donné
app.get('/api/lastfm/similar/:artist', rateLimit, async (req, res) => {
  try {
    const data = await callLastfm('artist.getsimilar', { artist: req.params.artist, limit: 10 });
    const artists = data?.similarartists?.artist || [];
    res.json(Array.isArray(artists) ? artists : [artists]);
  } catch (e) {
    console.error('[LASTFM SIMILAR]', e.message);
    res.json([]); // dégrade en silence côté client
  }
});

// Top tracks d'un artiste
app.get('/api/lastfm/top-tracks/:artist', rateLimit, async (req, res) => {
  try {
    const data = await callLastfm('artist.gettoptracks', { artist: req.params.artist, limit: 5 });
    const tracks = data?.toptracks?.track || [];
    res.json(Array.isArray(tracks) ? tracks : [tracks]);
  } catch (e) {
    console.error('[LASTFM TOP-TRACKS]', e.message);
    res.json([]);
  }
});

// ════════════════════════════════════════════════════════════
// STREAM URL - Pour lecture native en arrière-plan (ExoPlayer)
// Utilise Invidious pour éviter le ban d'IP de Render par YouTube
// ════════════════════════════════════════════════════════════

// Instances Invidious avec fallback automatique.
//
// ETAT MESURE LE 18/09/2026 : plus aucune instance publique ne repond.
// Les 6 instances historiquement codees ici renvoient 403/401/500/303, et la
// liste officielle https://api.invidious.io/instances.json ne contient plus
// qu'une seule entree https+api (invidious.f5.si) qui elle-meme renvoie 500.
// 16 instances testees, 0 exploitable. Les garder en dur ne faisait qu'ajouter
// plusieurs secondes de latence avant le repli yt-dlp, sans jamais aboutir.
//
// La liste est donc VIDE par defaut et pilotable sans redeploiement de code via
// la variable d'environnement INVIDIOUS_INSTANCES (URLs separees par des
// virgules). Si l'ecosysteme Invidious redevient utilisable, il suffit de
// renseigner cette variable — le code de repli ci-dessous est intact.
const INVIDIOUS_INSTANCES = String(process.env.INVIDIOUS_INSTANCES || '')
  .split(',')
  .map(u => u.trim().replace(/\/+$/, ''))
  .filter(u => /^https:\/\//.test(u));

// Timeout par instance : court, car une instance lente est de toute facon
// inutilisable pour de la lecture audio a la demande.
const INVIDIOUS_TIMEOUT_MS = Number(process.env.INVIDIOUS_TIMEOUT_MS || 6000);

// Valide l'URL audio renvoyée par une instance Invidious tierce avant de la
// transmettre au client (anti-SSRF) : on n'autorise que le CDN média de YouTube
// (*.googlevideo.com) ou l'hôte de l'instance elle-même (proxy local Invidious).
function isAllowedAudioUrl(rawUrl, instance) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host === 'googlevideo.com' || host.endsWith('.googlevideo.com')) return true;
    const instanceHost = new URL(instance).hostname.toLowerCase();
    return host === instanceHost;
  } catch (e) {
    return false;
  }
}

// ── Cookies YouTube pour yt-dlp ──────────────────────────────────────────────
// Sans cookies, YouTube repond « Sign in to confirm you're not a bot » sur la
// quasi-totalite des clips depuis une IP d'hebergeur (mesure du 18/09/2026 :
// 0 piste sur 6 extraite depuis Render). C'est le seul contournement fiable
// documente par yt-dlp. Deux facons de le fournir, sans commiter de secret :
//   - YTDLP_COOKIES_FILE : chemin vers un cookies.txt (format Netscape)
//   - YTDLP_COOKIES_B64  : ce meme fichier encode en base64 (pratique pour
//                          coller un secret multi-ligne dans Render)
let _cookiesPath = null;
let _cookiesResolved = false;
function getCookiesFile() {
  if (_cookiesResolved) return _cookiesPath;
  _cookiesResolved = true;

  const direct = process.env.YTDLP_COOKIES_FILE;
  if (direct) {
    if (fs.existsSync(direct)) {
      _cookiesPath = direct;
      console.log('[YTDL] cookies charges depuis YTDLP_COOKIES_FILE');
    } else {
      console.warn(`[YTDL] YTDLP_COOKIES_FILE pointe sur un fichier absent: ${direct}`);
    }
    return _cookiesPath;
  }

  const b64 = process.env.YTDLP_COOKIES_B64;
  if (b64) {
    try {
      const target = path.join(require('os').tmpdir(), 'sevenz-yt-cookies.txt');
      fs.writeFileSync(target, Buffer.from(b64, 'base64'), { mode: 0o600 });
      _cookiesPath = target;
      console.log('[YTDL] cookies materialises depuis YTDLP_COOKIES_B64');
    } catch (e) {
      console.warn('[YTDL] YTDLP_COOKIES_B64 illisible:', e.message);
    }
  }
  return _cookiesPath;
}

// Classe une erreur d'extraction pour renvoyer au client un message actionnable
// plutot que le pave brut de yt-dlp.
function classifyStreamError(message) {
  const m = String(message || '');
  if (/not a bot|Sign in to confirm/i.test(m)) {
    return {
      status: 503,
      reason: 'youtube_bot_check',
      error: "YouTube bloque l'extraction depuis ce serveur (verification anti-bot).",
      hint: 'Fournir des cookies YouTube au serveur via YTDLP_COOKIES_B64 ou YTDLP_COOKIES_FILE.'
    };
  }
  if (/yt-dlp indisponible/i.test(m)) {
    return {
      status: 503,
      reason: 'extractor_unavailable',
      error: "Aucun extracteur audio disponible sur ce serveur.",
      hint: "Le module youtube-dl-exec n'est pas installe (dependance optionnelle)."
    };
  }
  if (/Private video|unavailable|removed|age.?restrict|not available/i.test(m)) {
    return {
      status: 404,
      reason: 'video_unavailable',
      error: 'Cette video est indisponible (privee, supprimee ou restreinte).'
    };
  }
  if (/Aucun format audio/i.test(m)) {
    return {
      status: 502,
      reason: 'no_audio_format',
      error: "Aucune piste audio exploitable n'a ete renvoyee pour cette video."
    };
  }
  return { status: 503, reason: 'extraction_failed', error: 'Stream indisponible: ' + m };
}

// Fallback yt-dlp quand Invidious est bloqué
async function getAudioStreamWithYtdl(videoId) {
  const ytdl = getYtdl();
  if (!ytdl) throw new Error('Fallback yt-dlp indisponible sur ce serveur');

  try {
    console.log(`[YTDL] Extraction stream pour ${videoId}`);
    const opts = {
      dumpSingleJson: true,
      simulate: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      formatSort: 'abr',
      // yt-dlp a besoin d'un runtime JS pour dechiffrer les URLs ; sans lui il
      // previent « No supported JavaScript runtime could be found » et certains
      // formats manquent. Seul deno est actif par defaut, or l'hebergeur fait
      // tourner Node : on le declare explicitement (verifie le 18/09/2026).
      jsRuntimes: process.env.YTDLP_JS_RUNTIME || 'node',
      noUpdate: true
    };

    // visitor_data aide yt-dlp a obtenir un PO Token GVS (voir plus bas).
    const extractorArgs = [];
    if (process.env.YTDLP_VISITOR_DATA) {
      extractorArgs.push(`youtube:visitor_data=${process.env.YTDLP_VISITOR_DATA}`);
    }

    const cookies = getCookiesFile();
    if (cookies) opts.cookies = cookies;

    // Permet de tester un autre client YouTube (ios, web_safari, android_vr, tv…)
    // sans toucher au code, en cas de nouveau blocage cote YouTube.
    if (process.env.YTDLP_PLAYER_CLIENT) {
      extractorArgs.push(`youtube:player_client=${process.env.YTDLP_PLAYER_CLIENT}`);
    }
    if (extractorArgs.length) opts.extractorArgs = extractorArgs;

    const result = await ytdl(`https://www.youtube.com/watch?v=${videoId}`, opts);

    const audioFormats = (result.formats || [])
      .filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    if (audioFormats.length === 0) {
      throw new Error('Aucun format audio trouvé via yt-dlp');
    }

    const best = audioFormats[0];
    return {
      audioUrl: best.url,
      title: result.title || 'Unknown',
      author: result.uploader || 'Unknown Artist',
      duration: result.duration || 0,
      mimeType: best.ext ? `audio/${best.ext}` : 'audio/webm',
      instance: 'yt-dlp'
    };
  } catch (e) {
    console.error('[YTDL] échec', e.message);
    throw e;
  }
}

// Cache des extractions reussies. Une extraction yt-dlp coute ~10 s : sans
// cache, chaque lecture (et chaque requete Range du lecteur) relançait toute la
// chaine. Les URLs googlevideo restent valides ~6 h, on cache 2 h par securite.
const streamCache = new NodeCache({ stdTTL: 7200, checkperiod: 600 });
// Extractions en cours : les requêtes simultanées pour une même vidéo (Range
// du lecteur, /stream + /audio) partagent un seul yt-dlp au lieu d'en lancer N.
const pendingStreams = new Map();

// Récupère le stream audio via Invidious avec fallback entre instances, puis yt-dlp
function getAudioStream(videoId) {
  const cached = streamCache.get(videoId);
  if (cached) return Promise.resolve(cached);
  if (pendingStreams.has(videoId)) return pendingStreams.get(videoId);

  const promise = resolveAudioStream(videoId)
    .then(data => { streamCache.set(videoId, data); return data; })
    .finally(() => pendingStreams.delete(videoId));
  pendingStreams.set(videoId, promise);
  return promise;
}

async function resolveAudioStream(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`[INVIDIOUS] Trying ${instance}...`);

      // axios plutôt que fetch global : fonctionne sur toutes les versions de Node
      const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: INVIDIOUS_TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
          'Accept': 'application/json'
        }
      });

      if (response.status < 200 || response.status >= 300) {
        console.log(`[INVIDIOUS] ${instance} returned ${response.status}`);
        continue;
      }

      const data = response.data;

      if (data.error) {
        console.log(`[INVIDIOUS] ${instance} error: ${data.error}`);
        continue;
      }
      
      // Trouve le meilleur format audio
      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type && f.type.startsWith('audio/'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      
      if (audioFormats.length === 0) {
        console.log(`[INVIDIOUS] ${instance} - no audio format found`);
        continue;
      }
      
      const best = audioFormats[0];

      // Anti-SSRF : refuser une URL audio vers un hôte arbitraire
      if (!isAllowedAudioUrl(best.url, instance)) {
        console.warn(`[INVIDIOUS] ${instance} - URL audio non autorisée, ignorée`);
        continue;
      }

      console.log(`[INVIDIOUS] Success via ${instance}, bitrate: ${best.bitrate}`);

      return {
        audioUrl: best.url,
        title: data.title || 'Unknown',
        author: data.author || 'Unknown Artist',
        duration: data.lengthSeconds || 0,
        mimeType: best.type || 'audio/webm',
        instance: instance
      };
      
    } catch (error) {
      console.log(`[INVIDIOUS] ${instance} failed: ${error.message}`);
      continue;
    }
  }

  if (INVIDIOUS_INSTANCES.length === 0) {
    console.log('[STREAM] Aucune instance Invidious configuree, extraction via yt-dlp...');
  } else {
    console.log('[INVIDIOUS] Toutes les instances ont échoué, tentative yt-dlp...');
  }
  return getAudioStreamWithYtdl(videoId);
}

// Route pour lister les instances disponibles
// IMPORTANT: doit être déclarée AVANT '/api/stream/:videoId', sinon Express
// matche '/api/stream/instances' avec videoId='instances' (-> 400, route morte).
app.get('/api/stream/instances', (req, res) => {
  // Diagnostic de la chaine d'extraction : permet de verifier depuis l'exterieur
  // si yt-dlp est reellement installe et si les cookies sont bien pris en compte.
  res.json({
    instances: INVIDIOUS_INSTANCES,
    invidiousConfigured: INVIDIOUS_INSTANCES.length > 0,
    ytdlpAvailable: !!getYtdl(),
    cookiesConfigured: !!getCookiesFile(),
    playerClient: process.env.YTDLP_PLAYER_CLIENT || 'default',
    cachedStreams: streamCache.keys().length
  });
});

// ── Proxy audio googlevideo ──────────────────────────────────────────────────
// googlevideo ne sert plus qu'environ 1 Mio par requete : au-dela il repond 403
// (mesure du 18/09/2026 : Range 0-1048575 -> 206, Range 0-2097151 -> 403, GET
// sans Range -> 403, HEAD -> 403). Il faut donc telecharger par tranches et les
// recoller, sinon toute lecture non "rangee" par le client echoue.
const GOOGLEVIDEO_CHUNK = 1024 * 1024;
const GOOGLEVIDEO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function parseRangeHeader(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  return {
    start: m[1] ? parseInt(m[1], 10) : 0,
    end: m[2] ? parseInt(m[2], 10) : null
  };
}

function parseContentRange(header) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(String(header || ''));
  return m ? { start: +m[1], end: +m[2], total: +m[3] } : null;
}

function fetchAudioChunk(url, start, end) {
  return axios.get(url, {
    responseType: 'stream',
    timeout: 30000,
    headers: { 'User-Agent': GOOGLEVIDEO_UA, 'Range': `bytes=${start}-${end}` },
    validateStatus: (code) => code === 200 || code === 206
  });
}

// Telecharge par tranches successives et pipe le tout vers le client.
async function pipeAudioStream(req, res, streamData) {
  const wanted = parseRangeHeader(req.headers.range);
  const start = wanted ? wanted.start : 0;
  const askedEnd = wanted && wanted.end != null ? wanted.end : null;

  const firstEnd = askedEnd == null
    ? start + GOOGLEVIDEO_CHUNK - 1
    : Math.min(start + GOOGLEVIDEO_CHUNK - 1, askedEnd);

  let current = await fetchAudioChunk(streamData.audioUrl, start, firstEnd);
  const cr = parseContentRange(current.headers['content-range']);
  const total = cr ? cr.total : null;

  let finalEnd;
  if (askedEnd != null) finalEnd = total != null ? Math.min(askedEnd, total - 1) : askedEnd;
  else finalEnd = total != null ? total - 1 : firstEnd;

  res.set({
    'Content-Type': current.headers['content-type'] || streamData.mimeType || 'audio/webm',
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Resource-Policy': 'cross-origin'
  });
  // N'envoyer Content-Length que si la taille totale est connue (Content-Range
  // amont parsable). Si total == null, on laisse le transfert en chunked :
  // annoncer une longueur partielle ferait croire au lecteur que le flux est
  // complet, et une reponse 206 sans Content-Range serait invalide.
  if (total != null) {
    res.set('Content-Length', String(finalEnd - start + 1));
    if (wanted) {
      res.set('Content-Range', `bytes ${start}-${finalEnd}/${total}`);
      res.status(206);
    }
  }

  let aborted = false;
  req.on('close', () => { aborted = true; try { current.data.destroy(); } catch (e) {} });

  let pos = cr ? cr.end + 1 : firstEnd + 1;
  for (;;) {
    await new Promise((resolve, reject) => {
      current.data.on('error', reject);
      current.data.on('end', resolve);
      current.data.pipe(res, { end: false });
    });
    if (aborted || pos > finalEnd) break;
    const next = Math.min(pos + GOOGLEVIDEO_CHUNK - 1, finalEnd);
    try {
      current = await fetchAudioChunk(streamData.audioUrl, pos, next);
    } catch (e) {
      // Sans PO Token GVS valide, YouTube ne sert que le premier Mio de l'URL
      // et repond 403/429/5xx au-dela (mesure du 18/09/2026). Un res.end()
      // "propre" tromperait le lecteur : il croirait le flux complet et
      // stopperait la lecture sans erreur. On detruit donc la connexion.
      console.error(
        `[AUDIO PROXY] tranche ${pos}-${next} refusee (${e.message}). ` +
        'Symptome classique d\'un PO Token GVS manquant : connexion detruite ' +
        'pour signaler l\'echec au client.'
      );
      // `current` porte encore la tranche PRÉCÉDENTE — déjà entièrement
      // consommée par le pipe ci-dessus. La détruire ne libère donc rien, et
      // surtout pas la requête qui vient d'échouer : c'est à fetchAudioChunk
      // de refermer la sienne sur rejet.
      try { current && current.data && current.data.destroy(); } catch (_) {}
      if (res.headersSent) {
        // Des octets ont deja ete envoyes : impossible de renvoyer un statut
        // d'erreur, on detruit le socket pour que le client detecte l'echec.
        try { res.destroy ? res.destroy() : req.socket.destroy(); } catch (_) {}
        try { req.socket && req.socket.destroy(); } catch (_) {}
      } else {
        // Aucun octet envoye : on peut encore repondre un statut explicite.
        res.status(502).json({
          error: 'Flux amont refuse',
          reason: 'upstream_chunk_refused'
        });
      }
      return;
    }
    const ncr = parseContentRange(current.headers['content-range']);
    pos = ncr ? ncr.end + 1 : next + 1;
  }
  res.end();
}

// Proxy audio : contourne les restrictions CORS de googlevideo en streamant
// depuis le backend. Recommandé pour la lecture navigateur.
app.get('/api/audio/:videoId', rateLimit, async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    return res.status(400).json({ error: 'ID vidéo invalide' });
  }

  try {
    const streamData = await getAudioStream(videoId);
    await pipeAudioStream(req, res, streamData);
  } catch (error) {
    const { status, ...info } = classifyStreamError(error.message);
    console.error('[AUDIO PROXY ERROR]', info.reason, '-', error.message);
    // Une tranche peut echouer apres l'envoi des en-tetes : on ne peut
    // plus renvoyer de JSON. On detruit la connexion (et non un res.end()
    // "propre") pour que le client detecte un flux tronque.
    if (res.headersSent) {
      try { req.socket && req.socket.destroy(); } catch (_) {}
      return;
    }
    res.status(status).json(info);
  }
});

app.get('/api/stream/:videoId', rateLimit, async (req, res) => {
  const { videoId } = req.params;

  if (!videoId || !videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    return res.status(400).json({ error: 'ID vidéo invalide' });
  }

  try {
    const streamData = await getAudioStream(videoId);

    res.json({
      videoId,
      title: streamData.title,
      author: streamData.author,
      duration: streamData.duration,
      audioUrl: streamData.audioUrl,
      proxyUrl: `/api/audio/${videoId}`,
      mimeType: streamData.mimeType.split(';')[0].trim(),
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), // expire dans 4h
      via: streamData.instance
    });

  } catch (error) {
    const { status, ...info } = classifyStreamError(error.message);
    console.error('[STREAM ERROR]', info.reason, '-', error.message);
    res.status(status).json(info);
  }
});

// Proxy audio CORS-safe : le navigateur ne peut pas lire directement les URLs googlevideo
// à cause des restrictions CORS, donc on fait passer le flux par notre backend.
app.get('/api/proxy/stream/:videoId', rateLimit, async (req, res) => {
  const { videoId } = req.params;

  if (!videoId || !videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    return res.status(400).json({ error: 'ID vidéo invalide' });
  }

  try {
    const streamData = await getAudioStream(videoId);
    console.log(`[PROXY] Stream ${videoId} via ${streamData.instance}`);
    await pipeAudioStream(req, res, streamData);
  } catch (error) {
    const { status, ...info } = classifyStreamError(error.message);
    console.error('[PROXY ERROR]', info.reason, '-', error.message);
    // Une tranche peut echouer apres l'envoi des en-tetes : on ne peut
    // plus renvoyer de JSON. On detruit la connexion (et non un res.end()
    // "propre") pour que le client detecte un flux tronque.
    if (res.headersSent) {
      try { req.socket && req.socket.destroy(); } catch (_) {}
      return;
    }
    res.status(status).json(info);
  }
});

// ════════════════════════════════════════════════════════════
// SPOTIFY PLAYLIST IMPORT
// ════════════════════════════════════════════════════════════

const spotifyTokenCache = new NodeCache({ stdTTL: 3300, checkperiod: 600 });

function extractSpotifyPlaylistId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/playlist\/([a-zA-Z0-9]{22})/);
  return m ? m[1] : null;
}

async function getSpotifyToken(userToken) {
  if (userToken) return userToken;
  const cached = spotifyTokenCache.get('token');
  if (cached) return cached;
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('SPOTIFY_CLIENT_ID/SECRET manquants dans .env');
  }
  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    }
  );
  const token = res.data?.access_token;
  if (!token) throw new Error('Token Spotify invalide');
  spotifyTokenCache.set('token', token);
  return token;
}

async function fetchSpotifyPlaylistTracks(playlistId, token) {
  const tracks = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?offset=${offset}&limit=${limit}&market=FR`;
    const res = await axios.get(url, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    });
    const items = res.data?.items || [];
    for (const item of items) {
      const t = item.track;
      if (!t || t.type !== 'track') continue;
      const artist = (t.artists || []).map(a => a.name).filter(Boolean).join(', ');
      const album = t.album || {};
      tracks.push({
        artist,
        title: t.name || '',
        album: album.name || '',
        durationSec: Math.round((t.duration_ms || 0) / 1000),
        coverUrl: album.images?.[0]?.url || '',
        isrc: t.external_ids?.isrc || null,
        source: 'spotify',
        sourceId: t.id
      });
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return tracks;
}

app.get('/api/spotify/playlist', rateLimit, async (req, res) => {
  const { url } = req.query;
  const playlistId = extractSpotifyPlaylistId(url);
  if (!playlistId) {
    return res.status(400).json({ error: 'URL Spotify playlist invalide' });
  }
  try {
    const userToken = req.get('x-spotify-token');
    const token = await getSpotifyToken(userToken);
    const [info, tracks] = await Promise.all([
      axios.get(`https://api.spotify.com/v1/playlists/${playlistId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000
      }).then(r => r.data).catch(() => null),
      fetchSpotifyPlaylistTracks(playlistId, token)
    ]);
    const coverUrl = info?.images?.[0]?.url || tracks[0]?.coverUrl || '';
    res.json({
      playlist: {
        name: info?.name || 'Playlist importée',
        description: info?.description || '',
        coverUrl,
        externalUrl: info?.external_urls?.spotify || `https://open.spotify.com/playlist/${playlistId}`
      },
      count: tracks.length,
      tracks
    });
  } catch (error) {
    console.error('[SPOTIFY IMPORT]', error.message);
    const status = error.response?.status || 500;
    const msg = error.response?.data?.error?.message || error.message || 'Erreur Spotify';
    res.status(status === 401 ? 503 : status).json({ error: msg });
  }
});

// ════════════════════════════════════════════════════════════
// SPOTIFY OAUTH (lecture des playlists utilisateur)
// ════════════════════════════════════════════════════════════

function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Origines autorisées à recevoir le token Spotify de la popup. postMessage vers
// une origine qui ne correspond pas à la fenêtre parente est ignoré en silence :
// on poste donc à chacune, sans jamais diffuser le token avec '*'.
const APP_ORIGINS = String(process.env.APP_ORIGINS ||
  'https://localhost,capacitor://localhost,http://localhost:8888,https://sevenz-7beb7.web.app,https://sevenz-7beb7.firebaseapp.com')
  .split(',').map(o => o.trim()).filter(Boolean);

function renderSpotifyCallbackPage(payload) {
  // `<` échappé : le JSON est injecté dans un <script>
  const json = v => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Spotify</title></head>
<body>
<script>
  if (window.opener) {
    var msg = ${json({ type: 'spotify-auth', ...payload })};
    ${json(APP_ORIGINS)}.forEach(function (o) {
      try { window.opener.postMessage(msg, o); } catch (e) {}
    });
  }
  setTimeout(() => window.close(), 900);
</script>
<p style="font-family:sans-serif;text-align:center;margin-top:40px;color:#333">
  ${payload.error ? 'Erreur : ' + escHtml(payload.error) : 'Connexion Spotify réussie, fermeture…'}
</p>
</body>
</html>`;
}

app.get('/api/spotify/auth', rateLimit, (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Spotify non configuré (SPOTIFY_CLIENT_ID/SECRET manquants)' });
  }
  const state = crypto.randomBytes(16).toString('hex');
  spotifyStateCache.set(state, true);
  const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_AUTH_SCOPES,
    state
  }).toString();
  res.json({ authUrl, state });
});

app.get('/api/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(renderSpotifyCallbackPage({ error: `Spotify: ${error}` }));
  }
  if (!code || !state || !spotifyStateCache.has(state)) {
    return res.status(400).send(renderSpotifyCallbackPage({ error: 'Session invalide ou expirée' }));
  }
  spotifyStateCache.del(state);
  try {
    const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI
      }).toString(),
      {
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    res.send(renderSpotifyCallbackPage({ access_token, refresh_token, expires_in }));
  } catch (error) {
    console.error('[SPOTIFY CALLBACK]', error.message);
    res.status(400).send(renderSpotifyCallbackPage({ error: 'Échange du code Spotify échoué' }));
  }
});

app.get('/api/spotify/me/playlists', rateLimit, async (req, res) => {
  const token = req.get('x-spotify-token');
  if (!token) {
    return res.status(401).json({ error: 'Token Spotify manquant (header x-spotify-token)' });
  }
  try {
    const r = await axios.get('https://api.spotify.com/v1/me/playlists?limit=50', {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 15000
    });
    res.json(r.data);
  } catch (error) {
    console.error('[SPOTIFY ME PLAYLISTS]', error.message);
    const status = error.response?.status || 502;
    const msg = error.response?.data?.error?.message || error.message || 'Erreur Spotify';
    res.status(status).json({ error: msg });
  }
});

// ════════════════════════════════════════════════════════════
// FIN STREAM URL
// ════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`🚀 Serveur proxy YouTube démarré sur http://localhost:${PORT}`);
  console.log(`📊 Cache activé: 6h pour recherches, 24h pour tendances`);
  console.log(`⏱️  Rate limit: ${RATE_LIMIT_PER_MINUTE} req/min par IP`);
  console.log(`💰 Quota tracking: ${QUOTA_LIMIT} unités/jour max`);
  console.log(`🔗 Coalescing: requêtes dupliquées dedupées`);
});
