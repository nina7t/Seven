const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { isValid, buildQueue } = require('../sequencer');

describe('isValid', () => {
  test('refuse deux titres consécutifs du même artiste', () => {
    const queue = [{ artist: 'Daft Punk', album: 'Discovery', year: 2001, bpm: 120 }];
    const c = { artist: 'Daft Punk', album: 'Homework', year: 1997, bpm: 125 };
    assert.equal(isValid(c, queue, { maxPerArtistInBatch: 2, maxSameAlbumInBatch: 2, maxTempoDiff: 15 }), false);
  });

  test('respecte le plafond par artiste', () => {
    const queue = [
      { artist: 'Daft Punk', album: 'A', year: 2001, bpm: 120 },
      { artist: 'Justice', album: 'B', year: 2007, bpm: 125 },
      { artist: 'Daft Punk', album: 'C', year: 2001, bpm: 121 }
    ];
    const c = { artist: 'Daft Punk', album: 'D', year: 2001, bpm: 122 };
    assert.equal(isValid(c, queue, { maxPerArtistInBatch: 2, maxSameAlbumInBatch: 2, maxTempoDiff: 15 }), false);
  });

  test('respecte le plafond par album', () => {
    const queue = [
      { artist: 'Daft Punk', album: 'Discovery', year: 2001, bpm: 120 },
      { artist: 'Daft Punk', album: 'Discovery', year: 2001, bpm: 121 }
    ];
    const c = { artist: 'Daft Punk', album: 'Discovery', year: 2001, bpm: 122 };
    assert.equal(isValid(c, queue, { maxPerArtistInBatch: 2, maxSameAlbumInBatch: 2, maxTempoDiff: 15 }), false);
  });

  test('refuse un saut de tempo trop grand', () => {
    const queue = [{ artist: 'A', album: 'X', year: 2000, bpm: 100 }];
    const c = { artist: 'B', album: 'Y', year: 2000, bpm: 130 };
    assert.equal(isValid(c, queue, { maxPerArtistInBatch: 2, maxSameAlbumInBatch: 2, maxTempoDiff: 15 }), false);
  });
});

describe('buildQueue', () => {
  test('produit un lot de la bonne taille avec contraintes respectées', () => {
    const candidates = [];
    for (let i = 0; i < 80; i++) {
      const artistIdx = i % 16;
      candidates.push({
        title: `Title ${i}`,
        artist: `Artist ${artistIdx}`,
        album: `Album ${artistIdx}-${Math.floor(i / 2) % 2}`,
        year: 1990 + (i % 6) * 5,
        bpm: 115 + (i % 7),
        score: 1 - i * 0.005
      });
    }
    const queue = buildQueue(candidates, { batchSize: 20, adventurousness: 0 });
    assert.ok(queue.length > 0 && queue.length <= 20);

    // Pas deux consécutifs même artiste
    for (let i = 1; i < queue.length; i++) {
      assert.notEqual(queue[i].artist, queue[i - 1].artist);
    }

    // Max 2 par artiste
    const counts = {};
    queue.forEach(t => { counts[t.artist] = (counts[t.artist] || 0) + 1; });
    Object.values(counts).forEach(n => assert.ok(n <= 2));
  });
});
