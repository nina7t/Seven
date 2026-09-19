const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { pickNext, buildQueue } = require('../sequencer');
const W = require('../weights');

function candidate(id, score, extra = {}) {
  return {
    title: `T${id}`, artist: `A${id}`, normalizedKey: `k${id}`,
    score, familiar: false, ...extra
  };
}

// pickNext tire au sort ; on fige Math.random pour rendre les cas déterministes.
function withRandom(value, fn) {
  const real = Math.random;
  Math.random = () => value;
  try { return fn(); } finally { Math.random = real; }
}

describe('pondération du tirage', () => {
  test('pickSharpness vaut 3 — un tirage proportionnel au score ne discrimine pas assez', () => {
    assert.equal(W.pickSharpness, 3);
  });

  test('un bon candidat est préféré là où le tirage proportionnel prenait le médiocre', () => {
    // Poids à l'exposant 3 : 0.6³ = 0.216 et 0.3³ = 0.027, soit 89 % / 11 %.
    // À l'exposant 1 c'était 67 % / 33 %, et un tirage à 0.7 tombait sur le
    // second candidat. C'est exactement l'écart que la correction vise.
    const pool = [candidate(1, 0.6), candidate(2, 0.3)];
    const picked = withRandom(0.7, () => pickNext(pool, [], { wantDiscovery: true }));
    assert.equal(picked.normalizedKey, 'k1');
  });

  test('le candidat faible reste atteignable — la variété est préservée', () => {
    const pool = [candidate(1, 0.6), candidate(2, 0.3)];
    const picked = withRandom(0.95, () => pickNext(pool, [], { wantDiscovery: true }));
    assert.equal(picked.normalizedKey, 'k2');
  });

  test('un candidat sans score ne prend pas le dessus sur un bon candidat', () => {
    // Le repli valait 1, soit plus que n'importe quel score réel (max ~0.65) :
    // un candidat non scoré raflait la mise.
    const pool = [candidate(1, 0.6), candidate(2, undefined)];
    const picked = withRandom(0.5, () => pickNext(pool, [], { wantDiscovery: true }));
    assert.equal(picked.normalizedKey, 'k1');
  });
});

describe('le tirage ne perturbe ni le quota ni la taille du lot', () => {
  // Chaque bassin doit pouvoir remplir un lot entier à lui seul, sinon le
  // repli « bassin vide → on prend dans l'autre » s'active et masque le quota.
  // 24 candidats par bassin, tous d'artistes distincts et d'années étalées
  // pour ne buter ni sur le plafond par artiste ni sur celui par décennie.
  const pool = [];
  for (let i = 0; i < 24; i++) {
    pool.push(candidate(`c${i}`, 0.2 + (i % 5) * 0.08, { familiar: true, year: 1960 + i * 2 }));
    pool.push(candidate(`n${i}`, 0.2 + (i % 5) * 0.08, { familiar: false, year: 1961 + i * 2 }));
  }

  for (const [adventurousness, attendu] of [[0, 0], [0.25, 5], [0.5, 10], [0.75, 15], [1, 20]]) {
    test(`curseur ${adventurousness} → ${attendu} découvertes sur 20`, () => {
      const batch = buildQueue(pool, { adventurousness, batchSize: 20 });
      assert.equal(batch.length, 20);
      assert.equal(batch.filter(t => !t.familiar).length, attendu);
    });
  }
});
