const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName, normalizeForDedupe, dedupeArtists, createNormalizedArtist, mergeArtists } = require('../normalize');

describe('normalizeName', () => {
  test('lowercase et retire accents', () => {
    assert.equal(normalizeName('Émilie Simon'), 'emilie simon');
  });

  test('retire ponctuation', () => {
    assert.equal(normalizeName('P!nk / R.E.M.'), 'pnk rem');
  });

  test('ignore "The" initial', () => {
    assert.equal(normalizeName('The Beatles'), 'beatles');
  });
});

describe('dedupeArtists', () => {
  test('dédouble par mbid', () => {
    const a = createNormalizedArtist({ name: 'Daft Punk', source: 'lastfm', ids: { mbid: 'abc' } });
    const b = createNormalizedArtist({ name: 'Daft Punk', source: 'deezer', ids: { deezer: '27' } });
    const result = dedupeArtists([a, b]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources.sort(), ['deezer', 'lastfm']);
    assert.equal(result[0].ids.mbid, 'abc');
    assert.equal(result[0].ids.deezer, '27');
  });

  test('dédouble par nom normalisé quand pas de mbid', () => {
    const a = createNormalizedArtist({ name: 'The Strokes', source: 'deezer', ids: { deezer: '1' } });
    const b = createNormalizedArtist({ name: 'Strokes', source: 'tidal', ids: { tidal: '2' } });
    const result = dedupeArtists([a, b]);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].sources.sort(), ['deezer', 'tidal']);
  });

  test('garde les entrées distinctes', () => {
    const a = createNormalizedArtist({ name: 'Air', source: 'deezer' });
    const b = createNormalizedArtist({ name: 'Justice', source: 'deezer' });
    const result = dedupeArtists([a, b]);
    assert.equal(result.length, 2);
  });
});

describe('mergeArtists', () => {
  test('fusionne images et scores', () => {
    const a = createNormalizedArtist({ name: 'Justice', source: 'deezer', image: 'deezer.jpg', rank: 2 });
    const b = createNormalizedArtist({ name: 'Justice', source: 'lastfm', image: null, match: 0.9 });
    const merged = mergeArtists(a, b);
    assert.equal(merged.image, 'deezer.jpg');
    assert.equal(merged._meta.rank, 2);
    assert.equal(merged._meta.match, 0.9);
  });
});
