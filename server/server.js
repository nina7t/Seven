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

const { getFallbackSearch, getFallbackTrending, getFallbackVideos } = require('./fallback-data');
const { searchInvidious, getTrendingInvidious, getVideosInvidious } = require('./invidious-client');

const app = express();
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

// Rotation vers prochaine clé si celle-ci est épuisée
function rotateKey() {
  if (API_KEYS.length <= 1) return;
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

// Rate limiting simple
const requestLog = new Map();
const RATE_LIMIT_PER_MINUTE = 60; // 60 requêtes/minute par IP

app.use(cors());
app.use(express.json());

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
      video: videoCache.getStats()
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

  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const target = norm(name);
  const rank = a => {
    const n = norm(a.name);
    if (n === target) return 3;
    if (n.startsWith(target) || target.startsWith(n)) return 2;
    if (n.includes(target)) return 1;
    return 0;
  };

  return list.reduce((best, a) => {
    const ra = rank(a), rb = rank(best);
    if (ra !== rb) return ra > rb ? a : best;
    return (a.nb_fan || 0) > (best.nb_fan || 0) ? a : best;
  }, list[0]);
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

// PROXY: Recherche YouTube avec coalescing et quota tracking
app.get('/api/youtube/search', rateLimit, async (req, res) => {
  let { q, maxResults = 10, type = 'video' } = req.query; // 10 au lieu de 12 pour économiser
  
  if (!q) {
    return res.status(400).json({ error: 'Paramètre q (query) requis' });
  }

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
      // Si la requête en cours échoue, on continue pour réessayer
      pendingSearches.delete(cacheKey);
    }
  }

  // Créer la promesse pour cette recherche
  const searchPromise = (async () => {
    try {
      console.log(`[API CALL] Search: ${q} (clé ${getCurrentKeyIndex() + 1}/${API_KEYS.length})`);
      const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=${type}&videoCategoryId=10&topicId=%2Fm%2F04rlf&maxResults=${maxResults}&key=${getCurrentKey()}`;
      
      const response = await axios.get(url, { timeout: 5000 });
      
      if (response.data.error) {
        throw new Error(response.data.error.message);
      }

      // Tracker le quota utilisé (~100 unités par search)
      quotaUsedToday += 100;
      console.log(`[QUOTA] Utilisé: ${quotaUsedToday}/${QUOTA_LIMIT} (clé ${getCurrentKeyIndex() + 1})`);

      searchCache.set(cacheKey, response.data);
      return response.data;
      
    } catch (error) {
      console.error('YouTube Search Error:', error.message);
      
      // Quota dépassé (429) → rotation de clé ou Invidious
      if (isQuotaError(error)) {
        console.warn('[YOUTUBE QUOTA] Clé épuisée, rotation...');
        rotateKey();
        
        // Si on a encore des clés, réessayer avec la nouvelle
        if (API_KEYS.length > 1) {
          try {
            const retryUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=${type}&videoCategoryId=10&topicId=%2Fm%2F04rlf&maxResults=${maxResults}&key=${getCurrentKey()}`;
            const retryResponse = await axios.get(retryUrl, { timeout: 5000 });
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
          console.warn('[INVIDIOUS FAIL] Utilisation fallback static...');
          return getFallbackSearch(q, maxResults);
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
    res.status(500).json({
      error: 'Erreur lors de la recherche YouTube',
      details: error.message
    });
  } finally {
    // Nettoyer après un délai pour laisser les requêtes simultanées s'accrocher
    setTimeout(() => pendingSearches.delete(cacheKey), 1000);
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

  try {
    console.log('[API CALL] Trending');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&videoCategoryId=10&maxResults=16&regionCode=FR&key=${getCurrentKey()}`;
    
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
      rotateKey();
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
  const { videoId, maxResults = 10 } = req.query;
  
  if (!videoId) {
    return res.status(400).json({ error: 'Paramètre videoId requis' });
  }

  const cacheKey = `related:${videoId}:${maxResults}`;
  const cached = searchCache.get(cacheKey);
  
  if (cached) {
    console.log(`[CACHE HIT] Related: ${videoId}`);
    return res.json({ ...cached, cached: true });
  }

  // `relatedToVideoId` a été supprimé de l'API YouTube v3 (août 2023).
  // Nouvelle stratégie : récupérer l'artiste/titre de la vidéo source (videos.list,
  // 1 unité de quota) puis faire une recherche dessus (search.list). On garde ainsi
  // le format search.list attendu par le client (item.id.videoId).

  // Graine de recommandation à partir de la vidéo source
  async function getSeedQuery() {
    try {
      const vurl = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${getCurrentKey()}`;
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
  async function searchRelated(q) {
    const surl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&videoCategoryId=10&maxResults=${maxResults}&key=${getCurrentKey()}`;
    const sresp = await axios.get(surl, { timeout: 5000 });
    if (sresp.data.error) throw new Error(sresp.data.error.message);
    quotaUsedToday += 100;
    const data = sresp.data;
    if (Array.isArray(data.items)) {
      data.items = data.items.filter(it => it?.id?.videoId !== videoId);
    }
    return data;
  }

  try {
    console.log(`[API CALL] Related videos for: ${videoId}`);
    const seed = await getSeedQuery();
    if (!seed) {
      return res.json(getFallbackSearch('', maxResults));
    }
    const data = await searchRelated(seed);
    console.log(`[QUOTA] +101 pour related, Total: ${quotaUsedToday}/${QUOTA_LIMIT}`);
    searchCache.set(cacheKey, data);
    res.json({ ...data, cached: false });

  } catch (error) {
    console.error('YouTube Related Error:', error.message);

    if (isQuotaError(error)) {
      rotateKey();
      if (API_KEYS.length > 1) {
        try {
          const seed = await getSeedQuery();
          if (seed) {
            const data = await searchRelated(seed);
            searchCache.set(cacheKey, data);
            return res.json({ ...data, cached: false });
          }
        } catch (retryError) {
          console.warn('[RELATED RETRY FAIL]', retryError.message);
        }
      }

      // Fallback static
      try {
        return res.json(getFallbackSearch('', maxResults));
      } catch (fallbackError) {
        return res.status(503).json({ error: 'Service temporairement indisponible' });
      }
    }

    res.status(500).json({
      error: 'Erreur lors du chargement des vidéos liées',
      details: error.message
    });
  }
});

// PROXY: Détails vidéos (durées) avec coalescing
app.get('/api/youtube/videos', rateLimit, async (req, res) => {
  const { ids } = req.query;
  
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
      pendingVideos.delete(cacheKey);
    }
  }

  const videoPromise = (async () => {
    try {
      console.log(`[API CALL] Videos: ${ids.substring(0, 30)}...`);
      const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids}&key=${getCurrentKey()}`;
      
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
        rotateKey();
        if (API_KEYS.length > 1) {
          try {
            const retryUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids}&key=${getCurrentKey()}`;
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
    setTimeout(() => pendingVideos.delete(cacheKey), 1000);
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

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const lastfmCache = new NodeCache({ stdTTL: 86400, checkperiod: 3600 }); // 24h

async function callLastfm(method, params) {
  if (!LASTFM_API_KEY) {
    console.warn('[LASTFM] LASTFM_API_KEY non définie — recommandations désactivées');
    return null;
  }
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  const cached = lastfmCache.get(cacheKey);
  if (cached) {
    console.log(`[CACHE HIT] Last.fm ${method}: ${params.artist}`);
    return cached;
  }
  const url = `${LASTFM_BASE}?method=${method}&api_key=${LASTFM_API_KEY}&format=json&${
    Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  }`;
  const response = await axios.get(url, { timeout: 6000 });
  if (response.data?.error) {
    throw new Error(response.data.message || `Last.fm error ${response.data.error}`);
  }
  lastfmCache.set(cacheKey, response.data);
  return response.data;
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

// Instances Invidious avec fallback automatique
// Liste mise à jour depuis https://api.invidious.io/ (juin 2026)
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.f5.si',
  'https://yt.chocolatemoo53.com',
  'https://inv.thepixora.com',
  'https://invidious.tiekoetter.com'
];

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

// Fallback yt-dlp quand Invidious est bloqué
async function getAudioStreamWithYtdl(videoId) {
  const ytdl = getYtdl();
  if (!ytdl) throw new Error('Fallback yt-dlp indisponible sur ce serveur');

  try {
    console.log(`[YTDL] Extraction stream pour ${videoId}`);
    const result = await ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
      dumpSingleJson: true,
      simulate: true,
      noCheckCertificates: true,
      noWarnings: true,
      preferFreeFormats: true,
      formatSort: 'abr'
    });

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

// Récupère le stream audio via Invidious avec fallback entre instances, puis yt-dlp
async function getAudioStream(videoId) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      console.log(`[INVIDIOUS] Trying ${instance}...`);

      // axios plutôt que fetch global : fonctionne sur toutes les versions de Node
      const response = await axios.get(`${instance}/api/v1/videos/${videoId}`, {
        timeout: 10000,
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

  console.log('[INVIDIOUS] Toutes les instances ont échoué, tentative yt-dlp...');
  return getAudioStreamWithYtdl(videoId);
}

// Route pour lister les instances disponibles
// IMPORTANT: doit être déclarée AVANT '/api/stream/:videoId', sinon Express
// matche '/api/stream/instances' avec videoId='instances' (-> 400, route morte).
app.get('/api/stream/instances', (req, res) => {
  res.json({ instances: INVIDIOUS_INSTANCES });
});

// Proxy audio : contourne les restrictions CORS de googlevideo en streamant
// depuis le backend. Recommandé pour la lecture navigateur.
app.get('/api/audio/:videoId', rateLimit, async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !videoId.match(/^[a-zA-Z0-9_-]{11}$/)) {
    return res.status(400).json({ error: 'ID vidéo invalide' });
  }

  try {
    const streamData = await getAudioStream(videoId);
    const head = await axios.head(streamData.audioUrl, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    res.set({
      'Content-Type': head.headers['content-type'] || streamData.mimeType || 'audio/webm',
      'Accept-Ranges': 'bytes',
      'Cross-Origin-Resource-Policy': 'cross-origin'
    });

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };
    if (req.headers.range) {
      upstreamHeaders['Range'] = req.headers.range;
      res.set('Content-Range', head.headers['content-range']);
      res.status(206);
    }

    const upstream = await axios.get(streamData.audioUrl, {
      responseType: 'stream',
      timeout: 60000,
      headers: upstreamHeaders
    });

    upstream.data.pipe(res);
    upstream.data.on('error', (err) => {
      console.error('[AUDIO PROXY] stream error', err.message);
      if (!res.headersSent) res.status(503).end();
      else res.end();
    });
    upstream.data.on('end', () => res.end());
  } catch (error) {
    console.error('[AUDIO PROXY ERROR]', error.message);
    res.status(503).json({ error: 'Stream indisponible: ' + error.message });
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
    console.error('[STREAM ERROR]', error.message);
    res.status(503).json({ error: 'Stream indisponible: ' + error.message });
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

    const audioResponse = await axios({
      method: 'get',
      url: streamData.audioUrl,
      responseType: 'stream',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Accept': 'audio/webm,audio/ogg,audio/*;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.youtube.com/'
      }
    });

    res.setHeader('Content-Type', streamData.mimeType.split(';')[0].trim());
    res.setHeader('Accept-Ranges', 'bytes');
    if (audioResponse.headers['content-length']) {
      res.setHeader('Content-Length', audioResponse.headers['content-length']);
    }
    if (audioResponse.headers['content-range']) {
      res.setHeader('Content-Range', audioResponse.headers['content-range']);
      res.status(206);
    }

    audioResponse.data.pipe(res);
  } catch (error) {
    console.error('[PROXY ERROR]', error.message);
    res.status(503).json({ error: 'Stream indisponible: ' + error.message });
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

function renderSpotifyCallbackPage(payload) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Spotify</title></head>
<body>
<script>
  if (window.opener) {
    window.opener.postMessage(${JSON.stringify({ type: 'spotify-auth', ...payload })}, '*');
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
// DEEZER PLAYLIST IMPORT
// ════════════════════════════════════════════════════════════

function extractDeezerPlaylistId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/playlist\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchDeezerPlaylistTracks(playlistId) {
  const tracks = [];
  let url = `https://api.deezer.com/playlist/${playlistId}/tracks?limit=100`;
  while (url) {
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data && data.error && Object.keys(data.error).length) {
      throw new Error(data.error.message || 'Deezer API error');
    }
    (data.data || []).forEach(t => tracks.push(mapDeezerTrackToResult(t)));
    url = data.next || null;
  }
  return tracks;
}

app.get('/api/deezer/playlist', rateLimit, async (req, res) => {
  const { url } = req.query;
  const playlistId = extractDeezerPlaylistId(url);
  if (!playlistId) {
    return res.status(400).json({ error: 'URL Deezer playlist invalide' });
  }
  try {
    const [info, tracks] = await Promise.all([
      deezerGet(`/playlist/${playlistId}`).catch(() => null),
      fetchDeezerPlaylistTracks(playlistId)
    ]);
    const coverUrl = info?.picture_xl || info?.picture_big || info?.picture_medium || info?.picture_small || '';
    res.json({
      playlist: {
        name: info?.title || 'Playlist Deezer',
        description: info?.description || '',
        coverUrl,
        externalUrl: info?.link || `https://www.deezer.com/playlist/${playlistId}`
      },
      count: tracks.length,
      tracks
    });
  } catch (error) {
    console.error('[DEEZER PLAYLIST]', error.message);
    const status = error.response?.status || 502;
    const msg = error.response?.data?.error?.message || error.message || 'Erreur Deezer';
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
