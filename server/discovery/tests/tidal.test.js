const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const tidal = require('../providers/tidal');
const { normalizeCandidate, dedupeCandidates } = require('../candidates');

describe('isoDurationToSeconds', () => {
  test('convertit les durées ISO 8601 de TIDAL', () => {
    assert.equal(tidal.isoDurationToSeconds('PT5M20S'), 320);
    assert.equal(tidal.isoDurationToSeconds('PT3M46S'), 226);
    assert.equal(tidal.isoDurationToSeconds('PT1H2M3S'), 3723);
  });

  test('gère les composantes absentes', () => {
    assert.equal(tidal.isoDurationToSeconds('PT4M'), 240);
    assert.equal(tidal.isoDurationToSeconds('PT45S'), 45);
  });

  test('renvoie null sur une entrée invalide plutôt que NaN', () => {
    assert.equal(tidal.isoDurationToSeconds(null), null);
    assert.equal(tidal.isoDurationToSeconds(''), null);
    assert.equal(tidal.isoDurationToSeconds('5:20'), null);
    assert.equal(tidal.isoDurationToSeconds(320), null);
  });
});

describe('parseRadioItems', () => {
  // Forme réelle d'une page de /playlists/{id}/relationships/items?include=items.artists
  const page = {
    data: [{ type: 'tracks', id: '1' }, { type: 'tracks', id: '2' }],
    included: [
      {
        type: 'tracks', id: '1',
        attributes: { title: 'One More Time', popularity: 0.961, duration: 'PT5M20S', isrc: 'GBDUW0000053' },
        relationships: { artists: { data: [{ type: 'artists', id: 'a1' }] } }
      },
      {
        type: 'tracks', id: '2',
        attributes: { title: "Can't Hold Us", popularity: 0.61, duration: 'PT4M18S', isrc: 'GMM881200021' },
        relationships: { artists: { data: [{ type: 'artists', id: 'a2' }, { type: 'artists', id: 'a3' }] } }
      },
      { type: 'artists', id: 'a1', attributes: { name: 'Daft Punk' } },
      { type: 'artists', id: 'a2', attributes: { name: 'Macklemore' } },
      { type: 'artists', id: 'a3', attributes: { name: 'Ryan Lewis' } }
    ],
    links: { next: '/playlists/x/relationships/items?page[cursor]=zyx' }
  };

  test('recolle les artistes référencés dans included', () => {
    const items = tidal.parseRadioItems(page);
    assert.equal(items.length, 2);
    assert.equal(items[0].artist, 'Daft Punk');
    assert.equal(items[0].title, 'One More Time');
    assert.equal(items[0].duration, 320);
    assert.equal(items[0].ids.isrc, 'GBDUW0000053');
  });

  test('retient le premier artiste crédité comme principal', () => {
    const items = tidal.parseRadioItems(page);
    assert.equal(items[1].artist, 'Macklemore');
  });

  test('numérote les rangs en tenant compte de la pagination', () => {
    assert.deepEqual(tidal.parseRadioItems(page).map(i => i.rank), [1, 2]);
    assert.deepEqual(tidal.parseRadioItems(page, 40).map(i => i.rank), [41, 42]);
  });

  test('ignore un titre dont aucun artiste n’est résoluble', () => {
    const orphan = {
      included: [
        {
          type: 'tracks', id: '9',
          attributes: { title: 'Orpheline', popularity: 0.5 },
          relationships: { artists: { data: [{ type: 'artists', id: 'absent' }] } }
        }
      ]
    };
    assert.deepEqual(tidal.parseRadioItems(orphan), []);
  });

  test('ne casse pas sur un document vide ou malformé', () => {
    assert.deepEqual(tidal.parseRadioItems({}), []);
    assert.deepEqual(tidal.parseRadioItems(null), []);
    assert.deepEqual(tidal.parseRadioItems({ included: [] }), []);
  });
});

describe('fusion des métadonnées entre sources', () => {
  // TIDAL est la seule source à fournir la durée, et il arrive après Last.fm
  // dans le vivier. Sans complétion à la fusion, la durée serait perdue.
  test('la durée TIDAL survit à la fusion avec une entrée Last.fm sans durée', () => {
    const fromLastfm = normalizeCandidate({
      title: 'D.A.N.C.E.', artist: 'Justice', source: 'lastfm', rank: 2
    });
    const fromTidal = normalizeCandidate({
      title: 'D.A.N.C.E.', artist: 'Justice', source: 'tidal', rank: 1,
      duration: 242, rawScores: { popularity: 0.886 }
    });

    const [merged] = dedupeCandidates([fromLastfm, fromTidal]);
    assert.equal(merged.duration, 242);
    assert.equal(merged.rawScores.popularity, 0.886);
    assert.deepEqual(merged.sources.sort(), ['lastfm', 'tidal']);
  });

  test('ne remplace pas une valeur déjà renseignée', () => {
    const first = normalizeCandidate({
      title: 'Genesis', artist: 'Justice', source: 'deezer', duration: 235, bpm: 120
    });
    const second = normalizeCandidate({
      title: 'Genesis', artist: 'Justice', source: 'tidal', duration: 999
    });

    const [merged] = dedupeCandidates([first, second]);
    assert.equal(merged.duration, 235);
    assert.equal(merged.bpm, 120);
  });
});
