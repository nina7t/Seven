const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { trackTitleKey, normalizeSeed, topTags } = require('../seed');

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
