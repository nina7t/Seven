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
