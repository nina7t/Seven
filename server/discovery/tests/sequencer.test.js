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

  test('ne sélectionne jamais deux fois la même clé normalisée', () => {
    const candidates = [
      { title: 'Track A', artist: 'Artist A', album: 'Album A', bpm: 120, normalizedKey: 'artist a|track a' },
      { title: 'Track B', artist: 'Artist B', album: 'Album B', bpm: 121, normalizedKey: 'artist b|track b' }
    ];

    const queue = buildQueue(candidates, { batchSize: 4, adventurousness: 0 });
    assert.equal(queue.length, 2);
    assert.equal(new Set(queue.map(t => t.normalizedKey)).size, queue.length);
  });

  test('applique les plafonds artiste et album au nouveau lot seulement', () => {
    const existingQueue = [
      { title: 'Old 1', artist: 'Repeated Artist', album: 'Repeated Album', bpm: 118 },
      { title: 'Old 2', artist: 'Repeated Artist', album: 'Repeated Album', bpm: 119 },
      { title: 'Tail', artist: 'Other Artist', album: 'Other Album', bpm: 120 }
    ];
    const candidates = [
      { title: 'New 1', artist: 'Repeated Artist', album: 'Repeated Album', bpm: 121, score: 1 }
    ];

    const queue = buildQueue(candidates, { existingQueue, batchSize: 1, adventurousness: 0 });
    assert.equal(queue.length, 1);
    assert.equal(queue.filter(t => t.artist === 'Repeated Artist').length, 1);
    assert.equal(queue.filter(t => t.album === 'Repeated Album').length, 1);
    assert.notEqual(queue[0].artist, existingQueue[existingQueue.length - 1].artist);
  });
});

describe('quota connu / découverte', () => {
  function pool() {
    const out = [];
    for (let i = 0; i < 60; i++) {
      out.push({
        title: `Connu ${i}`, artist: `ConnuArtiste ${i}`, album: `AlbumC ${i}`,
        normalizedKey: `c|${i}`, score: 0.5, familiar: true, bpm: 120, year: 1970 + (i % 6) * 10
      });
      out.push({
        title: `Neuf ${i}`, artist: `NeufArtiste ${i}`, album: `AlbumN ${i}`,
        normalizedKey: `n|${i}`, score: 0.5, familiar: false, bpm: 120, year: 1975 + (i % 6) * 10
      });
    }
    return out;
  }

  test('un curseur à 0.5 donne moitié connu moitié découverte', () => {
    const batch = buildQueue(pool(), { batchSize: 20, adventurousness: 0.5 });
    const discoveries = batch.filter(t => !t.familiar).length;
    assert.equal(batch.length, 20);
    assert.ok(Math.abs(discoveries - 10) <= 2, `attendu ~10 découvertes, obtenu ${discoveries}`);
  });

  test('un curseur à 0 ne donne que du connu', () => {
    const batch = buildQueue(pool(), { batchSize: 20, adventurousness: 0 });
    assert.equal(batch.filter(t => !t.familiar).length, 0);
  });

  test('un curseur à 1 ne donne que de la découverte', () => {
    const batch = buildQueue(pool(), { batchSize: 20, adventurousness: 1 });
    assert.equal(batch.filter(t => t.familiar).length, 0);
  });

  test('un vivier sans connu remplit quand même le lot', () => {
    const onlyNew = pool().filter(c => !c.familiar);
    const batch = buildQueue(onlyNew, { batchSize: 20, adventurousness: 0 });
    assert.equal(batch.length, 20);
  });
});
