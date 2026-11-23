const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  jaccard,
  popularityScore,
  noveltyScore,
  tempoEraScore,
  sourceMatchScore,
  scoreCandidate,
  rankCandidates
} = require('../scoring');

describe('jaccard', () => {
  test('indice de similarité entre deux ensembles de tags', () => {
    assert.equal(jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 2 / 4);
    assert.equal(jaccard(['a'], ['a']), 1);
    assert.equal(jaccard(['a'], ['b']), 0);
    assert.equal(jaccard([], []), 0);
  });
});

describe('popularityScore', () => {
  test('popularité amortie logarithmiquement', () => {
    assert.ok(popularityScore({ popularity: 0.001 }) < popularityScore({ popularity: 0.5 }));
    assert.ok(popularityScore({ popularity: 10 }) <= 1);
  });
});

describe('noveltyScore', () => {
  test('artiste connu pénalisé', () => {
    assert.equal(noveltyScore({ artist: 'Daft Punk' }, new Set(['daftpunk'])), 0.3);
    assert.equal(noveltyScore({ artist: 'Unknown' }, new Set(['daftpunk'])), 1);
  });
});

describe('tempoEraScore', () => {
  test('proximité tempo et époque', () => {
    assert.equal(tempoEraScore({ bpm: 120, year: 2001 }, { bpm: 120, year: 2001 }), 1);
    assert.ok(tempoEraScore({ bpm: 140, year: 2010 }, { bpm: 120, year: 2000 }) < 1);
  });

  test('score neutre si infos absentes', () => {
    assert.equal(tempoEraScore({}, {}), 0.5);
  });
});

describe('scoreCandidate', () => {
  test('score entre 0 et 1', () => {
    const seed = { tags: ['electronic', 'house'], bpm: 120, year: 2000 };
    const c = { title: 'x', artist: 'y', tags: ['electronic'], bpm: 120, year: 2000, sources: ['lastfm'], match: 0.5 };
    const s = scoreCandidate(c, seed, { knownArtists: new Set() });
    assert.ok(s >= 0 && s <= 1);
  });

  test('feedback ajuste le score', () => {
    const seed = { tags: [] };
    const c = { title: 'x', artist: 'Daft Punk', tags: ['house'], sources: ['lastfm'], match: 0 };
    const s1 = scoreCandidate(c, seed);
    const s2 = scoreCandidate(c, seed, { feedbackWeights: { tag: { house: 0.5 } } });
    assert.ok(s2 > s1);
  });
});

describe('rankCandidates', () => {
  test('ordre décroissant', () => {
    const seed = { tags: ['rock'] };
    const candidates = [
      { title: 'a', artist: 'A', tags: ['pop'], sources: ['deezer'], score: 0.1 },
      { title: 'b', artist: 'B', tags: ['rock'], sources: ['lastfm'], match: 0.9 },
      { title: 'c', artist: 'C', tags: ['rock'], sources: ['deezer'], match: 0.5 }
    ];
    const ranked = rankCandidates(candidates, seed, {});
    assert.ok(ranked[0].score >= ranked[1].score);
    assert.ok(ranked[1].score >= ranked[2].score);
  });

  test('un hit populaire sans lien au titre ne revient pas grâce aux likes ou à la découverte', () => {
    const seed = { trackTags: ['trip-hop'], trackSimilarityAvailable: true };
    const direct = { title: 'Glory Box', artist: 'Portishead', match: 0.4, rawScores: { trackSimilar: 1 } };
    const unrelated = { title: 'Worldwide hit', artist: 'Other', rank: 1, tags: ['pop'], rawScores: { artistRelated: 1 } };
    const ranked = rankCandidates([direct, unrelated], seed, { feedbackWeights: { artist: { other: 1 } } });
    assert.deepEqual(ranked.map(c => c.title), ['Glory Box']);
    assert.ok(sourceMatchScore(direct) > sourceMatchScore(unrelated));
  });

  test('un tag précis doit être corroboré par un artiste directement lié', () => {
    const seed = { trackTags: ['trip-hop'], trackSimilarityAvailable: true };
    const tagOnly = { title: 'Tag hit', artist: 'A', tags: ['trip-hop'], rawScores: { tagTop: 1 } };
    const corroborated = { title: 'Angel', artist: 'Massive Attack', tags: ['trip-hop'], rawScores: { tagTop: 1, artistRelated: 1 } };
    assert.deepEqual(rankCandidates([tagOnly, corroborated], seed).map(c => c.title), ['Angel']);
  });

  test('la fin du vivier proche ne relâche pas le filtre sur un top artiste', () => {
    const unrelated = { title: 'Unverified', artist: 'A', rank: 1, rawScores: { artistRelated: 1 } };
    assert.deepEqual(rankCandidates([unrelated], { trackTags: ['soul'], trackSimilarityAvailable: true }), []);
  });

  test('un tag générique ne suffit pas à corroborer un titre', () => {
    const broad = { title: 'Rock hit', artist: 'A', tags: ['rock'], rawScores: { artistRelated: 1, tagTop: 1 } };
    assert.deepEqual(rankCandidates([broad], { trackTags: ['rock'], trackSimilarityAvailable: true }), []);
  });

  test('sans similarité titre exploitable le repli reste limité aux artistes directs', () => {
    const directArtist = { title: 'Related', artist: 'A', rawScores: { artistRelated: 1 } };
    const zeroMatch = { title: 'Zero', artist: 'B', match: 0, rawScores: { trackSimilar: 1 } };
    const tagOnly = { title: 'Tag hit', artist: 'C', tags: ['soul'], rawScores: { tagTop: 1 } };
    assert.deepEqual(rankCandidates([zeroMatch, tagOnly, directArtist], { trackTags: ['soul'] }).map(c => c.title), ['Related']);
  });
});

describe('garde-fou de genre Deezer', () => {
  const { genreCompatible, coherentCandidates } = require('../scoring');
  const seed = { genres: ['rap/hip hop'], tags: [], trackTags: [] };
  const mk = (artist, genres) => ({ artist, title: 't', genres, rawScores: { artistRelated: 1 } });

  test('écarte un genre connu sans rapport, garde l\'inconnu', () => {
    assert.equal(genreCompatible(mk('Zaz', ['variété française']), seed), false);
    assert.equal(genreCompatible(mk('Ninho', ['rap/hip hop', 'musique']), seed), true);
    assert.equal(genreCompatible(mk('Inconnu', []), seed), true);
    assert.equal(genreCompatible(mk('Zaz', ['pop']), { genres: [] }), true);
  });

  test('Zaz est retiré même quand le repli « tout artistRelated » s\'applique', () => {
    const out = coherentCandidates([mk('Zaz', ['variété française']), mk('Ninho', ['rap/hip hop'])], seed);
    assert.deepEqual(out.map(c => c.artist), ['Ninho']);
  });
});

describe('filtre d\'époque', () => {
  const { decadesFromTags, eraCompatible } = require('../scoring');

  test('lit les décennies dans les tags Last.fm', () => {
    assert.deepEqual(decadesFromTags(['40s', { name: '1950s' }, 'oldies', '90s', '10s', '20s', 'pop']).sort(), [1940, 1950, 1960, 1990, 2010, 2020]);
    assert.deepEqual(decadesFromTags(['pop', 'french']), []);
  });

  test('écarte une époque éloignée (Piaf vs pop actuelle), pas l\'inconnu', () => {
    const piaf = { eras: [1940, 1950] };
    assert.equal(eraCompatible({ eras: [2010] }, piaf), false);
    assert.equal(eraCompatible({ eras: [1970] }, piaf), true);
    assert.equal(eraCompatible({ eras: [] }, piaf), true);
    assert.equal(eraCompatible({ eras: [2010] }, { eras: [] }), true);
  });
});
