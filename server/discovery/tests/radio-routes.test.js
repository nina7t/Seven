const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const seedProvider = require('../seed');
const candidatesProvider = require('../candidates');
const scoring = require('../scoring');

let initialCandidates = [];
let freshCandidates = [];
const seed = {
  title: 'Seed', artist: 'Seed Artist', tags: ['rock'], bpm: 100,
  ids: { deezer: '1' }, normalizedKey: 'seedartist|seed'
};

// Les fournisseurs sont simulés ; filtrage, sessions et séquenceur restent réels.
const originals = {
  resolveTrackSeed: seedProvider.resolveTrackSeed,
  fetchCandidates: candidatesProvider.fetchCandidates,
  fetchMoreCandidates: candidatesProvider.fetchMoreCandidates,
  rankCandidates: scoring.rankCandidates
};
seedProvider.resolveTrackSeed = async () => ({ ...seed });
candidatesProvider.fetchCandidates = async () => [...initialCandidates];
candidatesProvider.fetchMoreCandidates = async () => [...freshCandidates];
scoring.rankCandidates = candidates => candidates.map(c => ({ ...c, score: 1, familiar: true }));
const router = require('../routes/radio');
Object.assign(seedProvider, { resolveTrackSeed: originals.resolveTrackSeed });
Object.assign(candidatesProvider, {
  fetchCandidates: originals.fetchCandidates,
  fetchMoreCandidates: originals.fetchMoreCandidates
});
Object.assign(scoring, { rankCandidates: originals.rankCandidates });

function track(title, artist, bpm = 100) {
  return {
    title, artist, bpm, tags: ['rock'], sources: ['deezer'],
    normalizedKey: seedProvider.trackTitleKey(title, artist)
  };
}

async function api(t) {
  initialCandidates = [];
  freshCandidates = [];
  const app = express();
  app.use(express.json());
  app.use('/api/radio', router);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/radio/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
}

test('radio/start exclut les titres déjà servis lors de la reprise de station', async t => {
  const post = await api(t);
  const old = track('Déjà servi', 'Old Artist');
  const fresh = track('Nouveau', 'New Artist');
  initialCandidates = [old, fresh];
  const result = await post('start', {
    title: seed.title, artist: seed.artist, playedKeys: [old.normalizedKey]
  });
  assert.deepEqual(result.tracks.map(t => t.normalizedKey), [fresh.normalizedKey]);
});

test('radio/next applique aussi les exclusions aux nouveaux candidats', async t => {
  const post = await api(t);
  const initial = track('Initial', 'Initial Artist');
  const rejected = track('Refusé', 'Rejected Artist');
  const allowed = track('Autorisé', 'Allowed Artist');
  initialCandidates = [initial];
  const station = await post('start', {
    title: seed.title, artist: seed.artist, dislikedKeys: [rejected.normalizedKey]
  });
  freshCandidates = [
    { ...seed, sources: ['deezer'] },
    track('Un titre (Live at Paris)', 'Live Artist'),
    rejected,
    allowed
  ];
  const result = await post('next', { radioId: station.radioId, playedKeys: [] });
  assert.deepEqual(result.tracks.map(t => t.normalizedKey), [allowed.normalizedKey]);
});

test('radio/next ne répète pas les lots précédents si le front compacte sa file', async t => {
  const post = await api(t);
  const a = track('Premier', 'Artist A');
  const b = track('Deuxième', 'Artist B');
  const c = track('Troisième', 'Artist C');
  initialCandidates = [a];
  const station = await post('start', { title: seed.title, artist: seed.artist });
  freshCandidates = [a, b];
  const second = await post('next', { radioId: station.radioId, playedKeys: [] });
  assert.deepEqual(second.tracks.map(t => t.normalizedKey), [b.normalizedKey]);
  freshCandidates = [a, b, c];
  const third = await post('next', { radioId: station.radioId, playedKeys: [] });
  assert.deepEqual(third.tracks.map(t => t.normalizedKey), [c.normalizedKey]);
});

test('radio/next conserve les contraintes artiste et tempo à la frontière des lots', async t => {
  const post = await api(t);
  initialCandidates = [track('Fin du premier lot', 'Artist A', 100)];
  const station = await post('start', { title: seed.title, artist: seed.artist });
  const sameArtist = track('Même artiste', 'Artist A', 100);
  const tooFast = track('Trop rapide', 'Artist B', 145);
  const compatible = track('Transition douce', 'Artist C', 105);
  freshCandidates = [sameArtist, tooFast, compatible];
  const result = await post('next', { radioId: station.radioId, playedKeys: [] });
  assert.equal(result.tracks[0]?.normalizedKey, compatible.normalizedKey);
  assert.ok(!result.tracks.some(t => t.normalizedKey === tooFast.normalizedKey));
});
