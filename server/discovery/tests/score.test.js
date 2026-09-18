const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeScore, rankAndScore } = require('../score');

describe('computeScore', () => {
  test('score élevé pour artiste présent dans toutes les sources avec bon match', () => {
    const artist = {
      sources: ['tidal', 'deezer', 'lastfm'],
      _meta: { rank: 1, match: 0.95, popularity: 0.8 }
    };
    const score = computeScore(artist, 3);
    assert.ok(score > 0 && score <= 1, `score=${score}`);
    assert.ok(score >= 0.5, `score=${score}`);
  });

  test('score bas pour artiste isolé sans match', () => {
    const artist = {
      sources: ['deezer'],
      _meta: { rank: 10, match: null, popularity: 0.1 }
    };
    const score = computeScore(artist, 3);
    assert.ok(score < 0.5, `score=${score}`);
  });

  test('score normalisé entre 0 et 1', () => {
    const artist = {
      sources: ['lastfm'],
      _meta: { rank: 5, match: 0.5, popularity: 0.5 }
    };
    const score = computeScore(artist, 3);
    assert.ok(score >= 0 && score <= 1);
  });
});

describe('rankAndScore', () => {
  test('ordre décroissant par score', () => {
    const artists = [
      { name: 'C', sources: ['deezer'], _meta: { rank: 10 } },
      { name: 'A', sources: ['tidal', 'deezer', 'lastfm'], _meta: { rank: 1, match: 0.95 } },
      { name: 'B', sources: ['deezer'], _meta: { rank: 2 } }
    ];
    const ranked = rankAndScore(artists, 3);
    assert.equal(ranked[0].name, 'A');
    assert.ok(ranked[0].score > ranked[1].score);
  });
});
