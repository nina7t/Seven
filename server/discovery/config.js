// Config unique du module discovery : timeouts, pondérations de score,
// noms de sources et constantes. Tout est centralisé ici.

const CONFIG = {
  sources: {
    TIDAL: 'tidal',
    DEEZER: 'deezer',
    LASTFM: 'lastfm'
  },

  // Timeout par appel source (ms)
  sourceTimeoutMs: 4000,

  // Cache LRU (max éléments, TTL en ms)
  cache: {
    similar: { max: 500, ttlMs: 24 * 60 * 60 * 1000 },   // 24 h
    search:  { max: 500, ttlMs: 60 * 60 * 1000 },         // 1 h
    token:   { max: 1,   ttlMs: 10 * 60 * 60 * 1000 }    // marge avant expiration TIDAL
  },

  // Nombre maximum de résultats demandés à chaque source
  limits: {
    similar: 15,
    search:  10
  },

  // Pondérations du score combiné (total 1.0 conseillé)
  scoring: {
    // Score Last.fm (0–1) : directement utilisable
    lastfmMatchWeight: 0.40,
    // Rang dans chaque source : 1/rang normalisé
    rankWeight: 0.40,
    // Bonus multi-source : +0.1 par source supplémentaire
    multiSourceBonus: 0.10,
    // Bonus d'appartenance à TIDAL (source la plus qualitative)
    tidalBonus: 0.05,
    // Pénalité/Divisée par nombre de sources pour éviter le bonus abusif
    normalizeBySources: true
  },

  // Paramètres du moteur radio
  radio: {
    sourceTimeoutMs: 4000,
    candidateLimit: 300,
    batchSize: 20,
    sessionTtlMs: 24 * 60 * 60 * 1000,
    maxPerArtistInBatch: 2,
    maxConsecutiveSameArtist: 1,
    maxSameAlbumInBatch: 2,
    maxTempoDiff: 15,
    adventurousnessDefault: 0.35,
    tagTopTracksLimit: 30,
    similarTracksLimit: 30,
    topTracksPerArtist: 5,
    similarArtistsDepth: 2,
    // Pondérations du score radio (doivent sommer à ~1)
    weights: {
      sourceMatch: 0.25,
      tagJaccard: 0.30,
      popularityLog: 0.15,
      novelty: 0.15,
      tempoEra: 0.15
    },
    // Feedback
    feedback: {
      likeBoost: 0.30,
      listen80Boost: 0.15,
      skipPenalty: -0.25,
      dislikePenalty: -0.60,
      artistRejectThreshold: 2
    }
  },

  // Codes pays
  countryCode: 'FR',

  // Endpoints officiels
  endpoints: {
    tidal: {
      auth:    'https://auth.tidal.com/v1/oauth2/token',
      apiBase: 'https://openapi.tidal.com/v2'
    },
    lastfm: {
      apiBase: 'https://ws.audioscrobbler.com/2.0/'
    },
    deezer: {
      apiBase: 'https://api.deezer.com'
    }
  }
};

module.exports = CONFIG;
