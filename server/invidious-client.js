// Client Invidious API - Alternative à YouTube API sans quota
// https://docs.invidious.io/api/

const axios = require('axios');

// Instances Invidious publiques (testées et fonctionnelles)
const INVIDIOUS_INSTANCES = [
  'https://iv.datura.network',
  'https://vid.puffyan.us',
  'https://iv.nboeck.de',
  'https://iv.melmac.space',
  'https://yt.artemislena.eu',
  'https://iv.drgns.space',
  'https://iv.minitar.de'
];

let currentInstanceIndex = 0;

function getCurrentInstance() {
  return INVIDIOUS_INSTANCES[currentInstanceIndex];
}

function rotateInstance() {
  currentInstanceIndex = (currentInstanceIndex + 1) % INVIDIOUS_INSTANCES.length;
  console.log(`[Invidious] Rotation vers instance: ${getCurrentInstance()}`);
  return getCurrentInstance();
}

// Récupérer la meilleure instance en parallèle (première réponse gagnante)
async function fetchFromBestInstance(path, timeout = 4000) {
  const controller = new AbortController();
  
  const promises = INVIDIOUS_INSTANCES.map(async (instance) => {
    const url = `${instance}${path}`;
    const start = Date.now();
    try {
      const response = await axios.get(url, {
        timeout,
        signal: controller.signal,
        headers: { 'User-Agent': 'SevenzMusic/1.0' }
      });
      const latency = Date.now() - start;
      console.log(`[Invidious] Instance ${instance} répondue en ${latency}ms`);
      // Premier succès = annuler les autres
      controller.abort();
      return { instance, data: response.data, latency };
    } catch (error) {
      return { instance, error: error.message };
    }
  });

  const results = await Promise.all(promises);
  
  // Retourner le premier succès (le plus rapide)
  const success = results.find(r => r.data !== undefined);
  if (success) {
    console.log(`[Invidious] Instance gagnante: ${success.instance} (${success.latency}ms)`);
    return { instance: success.instance, data: success.data };
  }
  
  throw new Error(`Toutes les instances Invidious sont indisponibles`);
}

// Recherche Invidious (équivalent YouTube Search) - PARALLÈLE
// Filtre pour musique uniquement (category 10 sur YouTube = Music)
async function searchInvidious(query, maxResults = 12) {
  console.log(`[Invidious] Recherche parallèle musique: "${query}"`);
  
  // Ajouter des mots-clés musique à la requête si absents
  const musicQuery = query.toLowerCase().includes('music') || 
                     query.toLowerCase().includes('song') ||
                     query.toLowerCase().includes('audio') ||
                     query.toLowerCase().includes('podcast') ||
                     query.toLowerCase().includes('mix') ||
                     query.toLowerCase().includes('dj ')
                     ? query 
                     : `${query} music audio`;
  
  const path = `/api/v1/search?q=${encodeURIComponent(musicQuery)}&type=video`;
  const { instance, data } = await fetchFromBestInstance(path, 4000);

  if (!Array.isArray(data)) {
    throw new Error('Réponse invalide de Invidious');
  }

  // Transformer au format YouTube
  const items = data.slice(0, maxResults).map(video => ({
    kind: 'youtube#searchResult',
    etag: 'invidious',
    id: { videoId: video.videoId },
    snippet: {
      title: video.title,
      channelTitle: video.author,
      thumbnails: {
        default: { url: video.videoThumbnails?.[3]?.url || video.videoThumbnails?.[0]?.url },
        medium: { url: video.videoThumbnails?.[2]?.url || video.videoThumbnails?.[0]?.url }
      },
      publishedAt: video.publishedText
    }
  }));

  return {
    kind: 'youtube#searchListResponse',
    etag: 'invidious',
    items,
    pageInfo: { totalResults: items.length, resultsPerPage: maxResults },
    source: 'invidious',
    instance
  };
}

// Tendances Invidious - PARALLÈLE
async function getTrendingInvidious(region = 'FR') {
  console.log(`[Invidious] Tendances parallèles`);
  
  const path = `/api/v1/trending?region=${region}`;
  const { instance, data } = await fetchFromBestInstance(path, 4000);

  if (!Array.isArray(data)) {
    throw new Error('Réponse invalide de Invidious');
  }

  const items = data.slice(0, 16).map(video => ({
    kind: 'youtube#video',
    etag: 'invidious',
    id: video.videoId,
    snippet: {
      title: video.title,
      channelTitle: video.author,
      thumbnails: {
        default: { url: video.videoThumbnails?.[3]?.url || video.videoThumbnails?.[0]?.url },
        medium: { url: video.videoThumbnails?.[2]?.url || video.videoThumbnails?.[0]?.url }
      }
    }
  }));

  return {
    kind: 'youtube#videoListResponse',
    etag: 'invidious',
    items,
    pageInfo: { totalResults: items.length, resultsPerPage: 16 },
    source: 'invidious',
    instance
  };
}

// Détails vidéo Invidious - PARALLÈLE
async function getVideosInvidious(ids) {
  const idArray = ids.split(',');
  console.log(`[Invidious] Détails vidéos parallèles: ${idArray.length} vidéos`);
  
  // Pour chaque vidéo, essayer toutes les instances en parallèle et prendre le premier succès
  const videoPromises = idArray.map(async (videoId) => {
    try {
      const { data } = await fetchFromBestInstance(`/api/v1/videos/${videoId}`, 3000);
      return {
        kind: 'youtube#video',
        etag: 'invidious',
        id: data.videoId,
        snippet: {
          title: data.title,
          channelTitle: data.author
        },
        contentDetails: {
          duration: `PT${Math.floor(data.lengthSeconds / 60)}M${data.lengthSeconds % 60}S`
        }
      };
    } catch (e) {
      return null; // Ignore les vidéos en erreur
    }
  });
  
  const items = (await Promise.all(videoPromises)).filter(Boolean);
  
  return {
    kind: 'youtube#videoListResponse',
    etag: 'invidious',
    items,
    pageInfo: { totalResults: items.length, resultsPerPage: items.length },
    source: 'invidious'
  };
}

module.exports = {
  searchInvidious,
  getTrendingInvidious,
  getVideosInvidious
};
