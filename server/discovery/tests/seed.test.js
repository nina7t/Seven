const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { trackTitleKey, normalizeSeed, topTags, selectBestDeezerTrack } = require('../seed');

test('les tags du morceau priment sur le style global de son artiste', async () => {
  const axios = require('axios');
  const deezer = require('../providers/deezer');
  const lastfm = require('../providers/lastfm');
  const { resolveTrackSeed } = require('../seed');
  const originals = {
    get: axios.get, findArtist: deezer.findArtist,
    configured: lastfm.isConfigured, trackTags: lastfm.getTrackTopTags,
    artistTags: lastfm.getArtistTopTags
  };
  try {
    axios.get = async () => ({ data: { data: [] } });
    deezer.findArtist = async () => null;
    lastfm.isConfigured = () => true;
    lastfm.getTrackTopTags = async () => [{ name: 'acoustic', count: 20 }];
    lastfm.getArtistTopTags = async () => [{ name: 'hip-hop', count: 100 }];
    const seed = await resolveTrackSeed({ title: 'Quiet session', artist: 'Mixed styles test' });
    assert.deepEqual(seed.tags, ['acoustic']);
    assert.deepEqual(seed.trackTags, ['acoustic']);

    lastfm.getTrackTopTags = async () => [];
    const fallback = await resolveTrackSeed({ title: 'Unknown tags', artist: 'Mixed styles test' });
    assert.deepEqual(fallback.tags, ['hip-hop']);
    assert.deepEqual(fallback.trackTags, []);
  } finally {
    axios.get = originals.get;
    deezer.findArtist = originals.findArtist;
    lastfm.isConfigured = originals.configured;
    lastfm.getTrackTopTags = originals.trackTags;
    lastfm.getArtistTopTags = originals.artistTags;
  }
});

describe('trackTitleKey', () => {
  test('normalise titre et artiste pour dédoublonnage', () => {
    assert.equal(
      trackTitleKey('One More Time', 'Daft Punk'),
      trackTitleKey('one more time', 'daft punk')
    );
    assert.equal(
      trackTitleKey('One More Time', 'Daft Punk'),
      trackTitleKey('One More Time!', 'The Daft Punk')
    );
  });
});

describe('normalizeSeed', () => {
  test('trim et parse année', () => {
    const s = normalizeSeed({ title: '  Bohemian Rhapsody  ', artist: 'Queen', year: '1975' });
    assert.equal(s.title, 'Bohemian Rhapsody');
    assert.equal(s.artist, 'Queen');
    assert.equal(s.year, 1975);
  });

  test('année invalide devient null', () => {
    const s = normalizeSeed({ title: 'x', artist: 'y', year: 'nope' });
    assert.equal(s.year, null);
  });
});

describe('topTags', () => {
  test('privilégie les tags du titre et garde top 5', () => {
    const track = [{ name: 'electronic', count: 80 }, { name: 'house', count: 60 }];
    const artist = [{ name: 'electronic', count: 100 }, { name: 'french', count: 50 }, { name: 'dance', count: 40 }, { name: 'disco', count: 30 }, { name: 'funk', count: 20 }, { name: 'pop', count: 10 }];
    const tags = topTags(track, artist, 5);
    assert.equal(tags.length, 5);
    assert.equal(tags[0], 'electronic');
    assert.ok(tags.includes('house'));
    assert.ok(tags.includes('french'));
  });
});

describe('selectBestDeezerTrack', () => {
  test('retourne la correspondance exacte même si elle n\'est pas en première position', () => {
    const seed = { title: 'One More Time', artist: 'Daft Punk' };
    const tracks = [
      { id: 1, title: 'One More Time (Live)', artist: { name: 'Daft Punk' }, rank: 100 },
      { id: 2, title: 'One More Time', artist: { name: 'Daft Punk' }, rank: 999 },
      { id: 3, title: 'Something Else', artist: { name: 'Daft Punk' }, rank: 500 }
    ];
    const best = selectBestDeezerTrack(tracks, seed);
    assert.equal(best.title, 'One More Time');
    assert.equal(best.id, 2);
  });

  test('accepte une variante d\'orthographe/normalisation', () => {
    const seed = { title: 'One More Time', artist: 'Daft Punk' };
    const tracks = [
      { id: 1, title: 'One More Time!', artist: { name: 'The Daft Punk' }, rank: 100 }
    ];
    const best = selectBestDeezerTrack(tracks, seed);
    assert.equal(best.title, 'One More Time!');
  });

  test('retourne null si aucun résultat ne correspond suffisamment', () => {
    const seed = { title: 'Unknown Track', artist: 'Daft Punk' };
    const tracks = [
      { id: 1, title: 'Something Else', artist: { name: 'Daft Punk' }, rank: 100 }
    ];
    const best = selectBestDeezerTrack(tracks, seed);
    assert.equal(best, null);
  });

  test('privilégie l\'artiste correct et retient un titre partiel seulement si l\'artiste correspond', () => {
    const seed = { title: 'One More Time', artist: 'Daft Punk' };
    const tracks = [
      { id: 1, title: 'One More Time (Remix)', artist: { name: 'Britney Spears' }, rank: 900 },
      { id: 2, title: 'One More Time', artist: { name: 'Daft Punk' }, rank: 100 }
    ];
    const best = selectBestDeezerTrack(tracks, seed);
    assert.equal(best.artist.name, 'Daft Punk');
  });
});

describe('genres Deezer de la graine', () => {
  const deezer = require('../providers/deezer');
  const seedMod = require('../seed');
  const axios = require('axios');
  test('retombe sur les albums de l\'artiste quand l\'album du titre n\'a pas de genre', async () => {
    const orig = { get: axios.get };
    const calls = [];
    axios.get = async (url) => {
      calls.push(url);
      if (url.includes('/search/track')) return { data: { data: [{ id: 1, title: 'La Vie en rose', artist: { name: 'Édith Piaf', id: 9 }, album: { id: 100, title: 'Compil' } }] } };
      if (url.includes('/search/artist')) return { data: { data: [{ id: 9, name: 'Édith Piaf' }] } };
      if (url.includes('/artist/9/top')) return { data: { data: [{ id: 5, title: 'x', artist: { name: 'Édith Piaf' }, album: { id: 200 } }] } };
      if (url.includes('/album/100')) return { data: { genres: { data: [] } } };
      if (url.includes('/album/200')) return { data: { genres: { data: [{ name: 'Chanson française' }] } } };
      throw new Error('inattendu ' + url);
    };
    try {
      const seed = await seedMod.resolveTrackSeed({ title: 'La Vie en rose', artist: 'Édith Piaf' });
      assert.deepEqual(seed.genres, ['chanson française']);
    } finally { axios.get = orig.get; }
  });
});
