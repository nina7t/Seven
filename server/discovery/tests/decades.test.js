const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickBatch, listDecades, findDecade, normalizeTrack } = require('../decades');

const mk = (artist, n) => ({ title: `t${n}`, artist, normalizedKey: `${artist}|t${n}` });
const pool = [...Array.from({ length: 6 }, (_, i) => mk('A', i)), ...Array.from({ length: 6 }, (_, i) => mk('B', i)), ...Array.from({ length: 6 }, (_, i) => mk('C', i))];

describe('radios par décennie', () => {
  test('7 décennies, ids connus', () => {
    assert.deepEqual(listDecades().map(d => d.id), ['1960', '1970', '1980', '1990', '2000', '2010', '2020']);
    assert.equal(findDecade('1980').label, 'Années 80');
    assert.equal(findDecade('1950'), null);
  });

  test('lot : 2 titres max par artiste, jamais le même artiste de suite', () => {
    const batch = pickBatch(pool, [], 20);
    assert.equal(batch.length, 6); // 3 artistes × 2
    for (let i = 1; i < batch.length; i++) assert.notEqual(batch[i].artist, batch[i - 1].artist);
  });

  test('ne rejoue pas un titre déjà joué tant qu\'il y en a des neufs', () => {
    const played = pool.slice(0, 12).map(t => t.normalizedKey);
    const batch = pickBatch(pool, played, 1);
    assert.ok(batch.every(t => !played.includes(t.normalizedKey)));
  });

  test('épuisement : rejoue des anciens, sauf les derniers joués', () => {
    const all = pool.map(t => t.normalizedKey);
    const batch = pickBatch(pool, all, 20);
    assert.ok(batch.length > 0);
    const recent = new Set(all.slice(-9)); // moitié du vivier de 18
    assert.ok(batch.every(t => !recent.has(t.normalizedKey)));
  });

  test('écarte les titres douteux (live, reprise…)', () => {
    assert.equal(normalizeTrack({ id: 1, title: 'Song (Live at Wembley)', artist: { name: 'X' } }), null);
    assert.equal(normalizeTrack({ id: 2, title: 'Song', artist: { name: 'X' }, album: { title: 'Alb' } }).ids.deezer, '2');
  });
});
