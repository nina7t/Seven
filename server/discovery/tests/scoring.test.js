const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  jaccard,
  popularityScore,
  noveltyScore,
  tempoEraScore,
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
});
