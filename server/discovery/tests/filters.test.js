const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isBadVariant, filterCandidates } = require('../filters');

describe('isBadVariant', () => {
  test('détecte live et remaster', () => {
    assert.equal(isBadVariant('Bohemian Rhapsody (Remastered 2011)'), true);
    assert.equal(isBadVariant('Imagine (Live at Madison Square Garden)'), true);
    assert.equal(isBadVariant('Karaoke Version of Bad Romance'), true);
  });

  test('accepte les titres standards', () => {
    assert.equal(isBadVariant('Billie Jean'), false);
    assert.equal(isBadVariant('Smells Like Teen Spirit'), false);
  });
});

describe('filterCandidates', () => {
  test('écarte graine, déjà écoutés et rejetés', () => {
    const candidates = [
      { title: 'Seed', artist: 'A', normalizedKey: 'a|seed', tags: [] },
      { title: 'Recent', artist: 'B', normalizedKey: 'b|recent', tags: [] },
      { title: 'Disliked', artist: 'C', normalizedKey: 'c|disliked', tags: [] },
      { title: 'Keep', artist: 'D', normalizedKey: 'd|keep', tags: [] }
    ];
    const result = filterCandidates(candidates, {
      seedKey: 'a|seed',
      recentKeys: new Set(['b|recent']),
      dislikedKeys: new Set(['c|disliked'])
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Keep');
  });

  test('écarte les variantes indésirables', () => {
    const candidates = [
      { title: 'Bad Romance (Official Video)', artist: 'Lady Gaga', normalizedKey: 'x', tags: [] },
      { title: 'Bad Romance', artist: 'Lady Gaga', normalizedKey: 'y', tags: [] }
    ];
    const result = filterCandidates(candidates, {});
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Bad Romance');
  });
});
