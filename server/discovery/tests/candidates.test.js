const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCandidate, dedupeCandidates } = require('../candidates');

describe('normalizeCandidate', () => {
  test('normalise les champs principaux', () => {
    const c = normalizeCandidate({
      title: '  Around the World  ',
      artist: 'Daft Punk ',
      source: 'lastfm',
      rank: 3,
      match: 0.5
    });
    assert.equal(c.title, 'Around the World');
    assert.equal(c.artist, 'Daft Punk');
    assert.equal(c.rank, 3);
    assert.equal(c.match, 0.5);
    assert.equal(c.sources[0], 'lastfm');
    assert.ok(c.normalizedKey);
  });
});

describe('dedupeCandidates', () => {
  test('fusionne les doublons par clé normalisée', () => {
    const a = normalizeCandidate({ title: 'Harder Better Faster Stronger', artist: 'Daft Punk', source: 'lastfm', rank: 1 });
    const b = normalizeCandidate({ title: 'Harder, Better, Faster, Stronger', artist: 'Daft Punk', source: 'deezer', rank: 2, ids: { deezer: '123' } });
    const c = normalizeCandidate({ title: 'One More Time', artist: 'Daft Punk', source: 'lastfm', rank: 5 });
    const result = dedupeCandidates([a, b, c]);
    assert.equal(result.length, 2);
    const merged = result.find(t => t.title === 'Harder Better Faster Stronger');
    assert.ok(merged.sources.includes('lastfm'));
    assert.ok(merged.sources.includes('deezer'));
    assert.equal(merged.ids.deezer, '123');
  });
});
