const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCandidate, dedupeCandidates, lastfmSimilarTracks, similarArtistsTopTracks } = require('../candidates');
const lastfm = require('../providers/lastfm');
const deezer = require('../providers/deezer');

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

describe('lastfmSimilarTracks safeCall', () => {
  test('ne plante pas si Last.fm échoue', async () => {
    const originals = {
      isConfigured: lastfm.isConfigured,
      getSimilarTracks: lastfm.getSimilarTracks
    };
    try {
      lastfm.isConfigured = () => true;
      lastfm.getSimilarTracks = () => Promise.reject(new Error('Last.fm down'));
      const result = await lastfmSimilarTracks({ artist: 'Daft Punk', title: 'One More Time' });
      assert.deepEqual(result, []);
    } finally {
      Object.assign(lastfm, originals);
    }
  });
});

describe('similarArtistsTopTracks Deezer artistId', () => {
  test('appelle /artist/{artistId}/related avec le vrai id artiste, pas le trackId', async () => {
    const calledIds = [];
    const originals = {
      fetchSimilarArtistsById: deezer.fetchSimilarArtistsById,
      fetchSimilarArtists: deezer.fetchSimilarArtists,
      fetchTopTracks: deezer.fetchTopTracks
    };
    try {
      deezer.fetchSimilarArtistsById = async (id) => {
        calledIds.push(id);
        return [{ name: 'Justice', ids: { deezer: '99' } }];
      };
      deezer.fetchSimilarArtists = async () => {
        throw new Error('fallback should not be used when artistId exists');
      };
      deezer.fetchTopTracks = async (id) => [
        { title: 'D.A.N.C.E.', artist: 'Justice', rank: 1, ids: { deezer: '100' } }
      ];

      const seed = {
        artist: 'Daft Punk',
        title: 'One More Time',
        artistMeta: { id: '27', name: 'Daft Punk' },
        ids: { deezer: '999', artistDeezer: '27' }
      };
      const result = await similarArtistsTopTracks(seed);

      assert.deepEqual(calledIds, ['27']);
      assert.equal(result.length, 1);
      assert.equal(result[0].title, 'D.A.N.C.E.');
      assert.equal(result[0].artist, 'Justice');
    } finally {
      Object.assign(deezer, originals);
    }
  });

  test('utilise ids.artistDeezer quand artistMeta.id est absent', async () => {
    const calledIds = [];
    const originals = {
      fetchSimilarArtistsById: deezer.fetchSimilarArtistsById,
      fetchTopTracks: deezer.fetchTopTracks
    };
    try {
      deezer.fetchSimilarArtistsById = async (id) => {
        calledIds.push(id);
        return [{ name: 'Air', ids: { deezer: '42' } }];
      };
      deezer.fetchTopTracks = async () => [
        { title: 'Playground Love', artist: 'Air', rank: 1, ids: { deezer: '101' } }
      ];

      const seed = {
        artist: 'Daft Punk',
        title: 'One More Time',
        ids: { deezer: '999', artistDeezer: '27' }
      };
      const result = await similarArtistsTopTracks(seed);

      assert.deepEqual(calledIds, ['27']);
      assert.equal(result[0].title, 'Playground Love');
    } finally {
      Object.assign(deezer, originals);
    }
  });

  test('retombe sur recherche par nom si aucun artistId n\'est disponible', async () => {
    const calledNames = [];
    const originals = {
      fetchSimilarArtistsById: deezer.fetchSimilarArtistsById,
      fetchSimilarArtists: deezer.fetchSimilarArtists,
      fetchTopTracks: deezer.fetchTopTracks
    };
    try {
      deezer.fetchSimilarArtistsById = async () => {
        throw new Error('should not be called without id');
      };
      deezer.fetchSimilarArtists = async (name) => {
        calledNames.push(name);
        return [{ name: 'Justice', ids: { deezer: '99' } }];
      };
      deezer.fetchTopTracks = async () => [
        { title: 'D.A.N.C.E.', artist: 'Justice', rank: 1, ids: { deezer: '100' } }
      ];

      const seed = {
        artist: 'Daft Punk',
        title: 'One More Time',
        ids: { deezer: '999' }
      };
      const result = await similarArtistsTopTracks(seed);

      assert.deepEqual(calledNames, ['Daft Punk']);
      assert.equal(result[0].title, 'D.A.N.C.E.');
    } finally {
      Object.assign(deezer, originals);
    }
  });
});
