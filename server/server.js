const express = require('express');
const cors = require('cors');
const NodeCache = require('node-cache');
const axios = require('axios');
require('dotenv').config();

const { getFallbackSearch, getFallbackTrending, getFallbackVideos } = require('./fallback-data');
const { searchInvidious, getTrendingInvidious, getVideosInvidious } = require('./invidious-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Support multi-clé API YouTube pour 10 users
const API_KEYS = [
  process.env.YOUTUBE_API_KEY,
  process.env.YOUTUBE_API_KEY_2,
  process.env.YOUTUBE_API_KEY_3
].filter(Boolean);

if (!API_KEYS[0]) {
  console.error('ERREUR: YOUTUBE_API_KEY non définie dans .env');
  process.exit(1);
}

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
let quotaUsedToday = 0;
const QUOTA_LIMIT = 9500; // Marge de sécurité avant 10000
const quotaResetTime = new Date();
quotaResetTime.setHours(24, 0, 0, 0); // Reset à minuit PST (heure YouTube)

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
      if (error.response?.status === 429 || error.response?.data?.error?.message?.includes('quota')) {
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
    if (error.response?.status === 429 || error.response?.data?.error?.message?.includes('quota')) {
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
      
      if (error.response?.status === 429 || error.response?.data?.error?.message?.includes('quota')) {
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

app.listen(PORT, () => {
  console.log(`🚀 Serveur proxy YouTube démarré sur http://localhost:${PORT}`);
  console.log(`📊 Cache activé: 6h pour recherches, 24h pour tendances`);
  console.log(`⏱️  Rate limit: ${RATE_LIMIT_PER_MINUTE} req/min par IP`);
  console.log(`💰 Quota tracking: ${QUOTA_LIMIT} unités/jour max`);
  console.log(`🔗 Coalescing: requêtes dupliquées dedupées`);
});
