const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSession,
  recordFeedback,
  getFeedbackWeights,
  shouldExcludeArtist,
  getKnownArtists,
  getSession
} = require('../feedback');

describe('createSession', () => {
  test('crée une session avec seed et artistes connus', () => {
    const seed = { artist: 'Daft Punk' };
    const id = createSession(seed, ['Justice', 'Daft Punk']);
    assert.ok(typeof id === 'string' && id.length > 0);
    const known = getKnownArtists(id);
    assert.ok(known.has('justice'));
    assert.ok(known.has('daftpunk'));
  });
});

describe('recordFeedback', () => {
  test('like booste artiste et tags', () => {
    const id = createSession({ artist: 'A' });
    recordFeedback(id, { artist: 'Daft Punk', tags: ['house', 'electronic'], normalizedKey: 'x' }, 'like');
    const w = getFeedbackWeights(id);
    assert.ok(w.tag.house > 0);
    assert.ok(w.artist.daftpunk > 0);
  });

  test('deux skips excluent un artiste', () => {
    const id = createSession({ artist: 'A' });
    recordFeedback(id, { artist: 'Bad', tags: [], normalizedKey: 'x' }, 'skip');
    recordFeedback(id, { artist: 'Bad', tags: [], normalizedKey: 'y' }, 'skip');
    assert.equal(shouldExcludeArtist(id, 'Bad'), true);
  });

  test('dislike exclut immédiatement', () => {
    const id = createSession({ artist: 'A' });
    recordFeedback(id, { artist: 'Worse', tags: [], normalizedKey: 'z' }, 'dislike');
    assert.equal(shouldExcludeArtist(id, 'Worse'), true);
  });

  test('un type inconnu est rejeté sans être ajouté à l’historique', () => {
    const id = createSession({ artist: 'A' });
    assert.equal(recordFeedback(id, { artist: 'B', normalizedKey: 'b|track' }, 'unknown'), false);
    assert.deepEqual(getSession(id).history, []);
  });

  test('session inconnue retourne false', () => {
    assert.equal(recordFeedback('nope', { artist: 'A' }, 'like'), false);
    assert.equal(getFeedbackWeights('nope'), null);
  });
});
