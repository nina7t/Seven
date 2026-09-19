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
  test('écarte la graine, les rejetés et ce qui a déjà été joué dans cette radio', () => {
    const candidates = [
      { title: 'Seed', artist: 'A', normalizedKey: 'a|seed', tags: [] },
      { title: 'Played', artist: 'B', normalizedKey: 'b|played', tags: [] },
      { title: 'Disliked', artist: 'C', normalizedKey: 'c|disliked', tags: [] },
      { title: 'Keep', artist: 'D', normalizedKey: 'd|keep', tags: [] }
    ];
    const result = filterCandidates(candidates, {
      seedKey: 'a|seed',
      excludeKeys: new Set(['b|played']),
      dislikedKeys: new Set(['c|disliked'])
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Keep');
  });

  test("garde les titres déjà écoutés par l'auditeur : ce sont ses classiques", () => {
    const candidates = [
      { title: 'Un classique', artist: 'A', normalizedKey: 'a|classique', tags: [] },
      { title: 'Une découverte', artist: 'B', normalizedKey: 'b|decouverte', tags: [] }
    ];
    // L'historique d'écoute n'est plus un motif d'exclusion.
    const result = filterCandidates(candidates, { excludeKeys: new Set() });
    assert.equal(result.length, 2);
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
