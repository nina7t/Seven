// Pondérations et constantes du moteur radio.
// Tout est centralisé ici pour rester lisible et modifiable à la main.

const CONFIG = require('./config');
const W = CONFIG.radio.weights;
const F = CONFIG.radio.feedback;

module.exports = {
  // Seeding
  tagTopTracksLimit: CONFIG.radio.tagTopTracksLimit,
  similarTracksLimit: CONFIG.radio.similarTracksLimit,
  topTracksPerArtist: CONFIG.radio.topTracksPerArtist,
  similarArtistsDepth: CONFIG.radio.similarArtistsDepth,
  candidateLimit: CONFIG.radio.candidateLimit,

  // Scoring
  sourceMatchWeight: W.sourceMatch,
  tagJaccardWeight: W.tagJaccard,
  popularityWeight: W.popularityLog,
  noveltyWeight: W.novelty,
  tempoEraWeight: W.tempoEra,
  popularityLogBase: 10,

  // Sequencer
  batchSize: CONFIG.radio.batchSize,
  maxPerArtistInBatch: CONFIG.radio.maxPerArtistInBatch,
  maxConsecutiveSameArtist: CONFIG.radio.maxConsecutiveSameArtist,
  maxSameAlbumInBatch: CONFIG.radio.maxSameAlbumInBatch,
  maxTempoDiff: CONFIG.radio.maxTempoDiff,
  adventurousnessDefault: CONFIG.radio.adventurousnessDefault,

  // Feedback
  likeBoost: F.likeBoost,
  listen80Boost: F.listen80Boost,
  skipPenalty: F.skipPenalty,
  dislikePenalty: F.dislikePenalty,
  artistRejectThreshold: F.artistRejectThreshold
};
