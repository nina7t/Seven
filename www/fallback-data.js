// Données de fallback quand le quota YouTube API est dépassé
// Ces vidéos sont des musiques libres de droits/populaires qui fonctionnent toujours

const FALLBACK_VIDEOS = [
  {
    id: 'jfKfPfyJRdk',
    snippet: {
      title: 'lofi hip hop radio - beats to relax/study to',
      channelTitle: 'Lofi Girl',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/jfKfPfyJRdk/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/jfKfPfyJRdk/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT0S' } // Live stream
  },
  {
    id: 'rUxyKA_-grg',
    snippet: {
      title: 'relaxing jazz & bossa nova music - chill out cafe music',
      channelTitle: 'Cafe Music BGM channel',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/rUxyKA_-grg/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/rUxyKA_-grg/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT0S' }
  },
  {
    id: 'lTRiuFIWV54',
    snippet: {
      title: 'Relaxing Piano Music - Stress Relief, Study Music, Meditation',
      channelTitle: 'Soothing Relaxation',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/lTRiuFIWV54/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/lTRiuFIWV54/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT3H0M0S' }
  },
  {
    id: 'DWcJFNfAy9U',
    snippet: {
      title: 'Ed Sheeran - Perfect (Official Music Video)',
      channelTitle: 'Ed Sheeran',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/DWcJFNfAy9U/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/DWcJFNfAy9U/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M23S' }
  },
  {
    id: 'hT_nvWreIhg',
    snippet: {
      title: 'OneRepublic - Counting Stars (Official Music Video)',
      channelTitle: 'OneRepublic',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/hT_nvWreIhg/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/hT_nvWreIhg/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M44S' }
  },
  {
    id: 'kJQP7kiw5Fk',
    snippet: {
      title: 'Luis Fonsi - Despacito ft. Daddy Yankee',
      channelTitle: 'Luis FonsiVEVO',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M42S' }
  },
  {
    id: 'JGwWNGJdvx8',
    snippet: {
      title: 'Ed Sheeran - Shape of You (Official Music Video)',
      channelTitle: 'Ed Sheeran',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/JGwWNGJdvx8/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/JGwWNGJdvx8/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M24S' }
  },
  {
    id: 'RgKAFK5djSk',
    snippet: {
      title: 'Wiz Khalifa - See You Again ft. Charlie Puth (Official Video)',
      channelTitle: 'Wiz Khalifa',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/RgKAFK5djSk/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/RgKAFK5djSk/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT3M58S' }
  },
  {
    id: 'OPf0YbXqDm0',
    snippet: {
      title: 'Mark Ronson - Uptown Funk ft. Bruno Mars (Official Video)',
      channelTitle: 'Mark Ronson',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/OPf0YbXqDm0/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/OPf0YbXqDm0/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M30S' }
  },
  {
    id: '09R8_2nJtjg',
    snippet: {
      title: 'Maroon 5 - Sugar (Official Music Video)',
      channelTitle: 'Maroon 5',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/09R8_2nJtjg/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/09R8_2nJtjg/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT5M2S' }
  },
  {
    id: 'CevxZvSJLk8',
    snippet: {
      title: 'Katy Perry - Roar (Official)',
      channelTitle: 'Katy Perry',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/CevxZvSJLk8/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/CevxZvSJLk8/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M30S' }
  },
  {
    id: 'nfWlot6h_JM',
    snippet: {
      title: 'Taylor Swift - Shake It Off (Official Video)',
      channelTitle: 'Taylor Swift',
      thumbnails: {
        medium: { url: 'https://i.ytimg.com/vi/nfWlot6h_JM/mqdefault.jpg' },
        default: { url: 'https://i.ytimg.com/vi/nfWlot6h_JM/default.jpg' }
      }
    },
    contentDetails: { duration: 'PT4M2S' }
  }
];

function getFallbackSearch(query, maxResults = 12) {
  // Mélanger et filtrer selon la requête (faux matching pour l'expérience utilisateur)
  const shuffled = [...FALLBACK_VIDEOS].sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, maxResults);
  
  return {
    kind: 'youtube#searchListResponse',
    etag: 'fallback',
    items: selected.map(v => ({
      kind: 'youtube#searchResult',
      etag: 'fallback',
      id: { videoId: v.id },
      snippet: v.snippet
    })),
    pageInfo: { totalResults: selected.length, resultsPerPage: maxResults },
    fallback: true,
    message: 'Mode hors-ligne : quota API dépassé'
  };
}

function getFallbackTrending() {
  const shuffled = [...FALLBACK_VIDEOS].sort(() => 0.5 - Math.random());
  
  return {
    kind: 'youtube#videoListResponse',
    etag: 'fallback',
    items: shuffled.slice(0, 16).map(v => ({
      kind: 'youtube#video',
      etag: 'fallback',
      id: v.id,
      snippet: v.snippet
    })),
    pageInfo: { totalResults: 16, resultsPerPage: 16 },
    fallback: true,
    message: 'Mode hors-ligne : quota API dépassé'
  };
}

function getFallbackVideos(ids) {
  const idArray = ids.split(',');
  const matched = idArray.map(id => {
    const found = FALLBACK_VIDEOS.find(v => v.id === id);
    if (found) {
      return {
        kind: 'youtube#video',
        etag: 'fallback',
        id: found.id,
        snippet: found.snippet,
        contentDetails: found.contentDetails
      };
    }
    return null;
  }).filter(Boolean);
  
  return {
    kind: 'youtube#videoListResponse',
    etag: 'fallback',
    items: matched,
    pageInfo: { totalResults: matched.length, resultsPerPage: matched.length },
    fallback: true,
    message: 'Mode hors-ligne : quota API dépassé'
  };
}

module.exports = {
  getFallbackSearch,
  getFallbackTrending,
  getFallbackVideos
};
