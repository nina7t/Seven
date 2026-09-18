#!/usr/bin/env node
/**
 * Script d'évaluation du moteur radio.
 *
 * Comme les clés API Last.fm / TIDAL ne sont pas disponibles dans l'environnement
 * de test, ce script simule un vivier de candidats réalistes par genre et mesure
 * les propriétés de l'ordonnanceur (diversité artistes, répartition époques,
 * taux de découverte).
 */

const { filterCandidates } = require('../filters');
const { rankCandidates } = require('../scoring');
const { buildQueue } = require('../sequencer');
const { normalizeForDedupe } = require('../normalize');

const SEEDS = [
  { title: 'One More Time', artist: 'Daft Punk', tags: ['electronic', 'house', 'french'], bpm: 123, year: 2001 },
  { title: 'Bohemian Rhapsody', artist: 'Queen', tags: ['rock', 'classic rock', 'british'], bpm: 72, year: 1975 },
  { title: 'Billie Jean', artist: 'Michael Jackson', tags: ['pop', 'r&b', '80s'], bpm: 117, year: 1982 },
  { title: 'Smells Like Teen Spirit', artist: 'Nirvana', tags: ['grunge', 'rock', 'alternative'], bpm: 120, year: 1991 },
  { title: 'Nuthin\' But a G Thang', artist: 'Dr. Dre', tags: ['hip-hop', 'rap', 'g-funk'], bpm: 95, year: 1992 },
  { title: 'Creep', artist: 'Radiohead', tags: ['alternative rock', 'rock', 'british'], bpm: 92, year: 1992 },
  { title: 'Formation', artist: 'Beyoncé', tags: ['pop', 'r&b', 'funk'], bpm: 119, year: 2016 },
  { title: 'Midnight City', artist: 'M83', tags: ['electronic', 'dream pop', 'synthwave'], bpm: 105, year: 2011 },
  { title: 'La Bohème', artist: 'Charles Aznavour', tags: ['chanson française', 'variété', 'oldies'], bpm: 110, year: 1965 },
  { title: 'Gasolina', artist: 'Daddy Yankee', tags: ['reggaeton', 'latin', 'dance'], bpm: 96, year: 2004 }
];

const KNOWN_POOL = ['Coldplay', 'U2', 'Beyoncé', 'Jay-Z', 'Rihanna', 'Eminem', 'Adele', 'Bruno Mars', 'Katy Perry', 'Maroon 5'];
const KNOWN_ARTISTS = new Set([
  'daftpunk', 'queen', 'michaeljackson', 'nirvana', 'radiohead',
  ...KNOWN_POOL
].map(normalizeForDedupe));

function randomArtist(baseTags) {
  const pools = {
    'electronic': ['Justice', 'Kavinsky', 'The Chemical Brothers', 'Disclosure', 'Röyksopp', 'Moby', 'LCD Soundsystem'],
    'house': ['David Guetta', 'Swedish House Mafia', 'Calvin Harris', 'Avicii', 'Armand Van Helden'],
    'rock': ['The Beatles', 'The Rolling Stones', 'Led Zeppelin', 'Pink Floyd', 'The Who', 'Foo Fighters'],
    'pop': ['Madonna', 'Prince', 'Whitney Houston', 'Britney Spears', 'Rihanna', 'Dua Lipa'],
    'hip-hop': ['Snoop Dogg', 'Tupac', 'The Notorious B.I.G.', 'Nas', 'Kendrick Lamar', 'J. Cole'],
    'alternative rock': ['Pixies', 'The Smashing Pumpkins', 'Muse', 'Arctic Monkeys', 'The Strokes'],
    'r&b': ['Alicia Keys', 'Usher', 'Frank Ocean', 'SZA', 'H.E.R.', 'Daniel Caesar'],
    'chanson française': ['Édith Piaf', 'Jacques Brel', 'Serge Gainsbourg', 'Barbara', 'Georges Brassens'],
    'reggaeton': ['Bad Bunny', 'J Balvin', 'Don Omar', 'Wisin & Yandel', 'Becky G']
  };
  const primary = baseTags[0];
  const pool = pools[primary] || ['Unknown Artist A', 'Unknown Artist B', 'Unknown Artist C'];
  // Simuler un historique utilisateur : ~30 % des artistes proposés sont déjà connus
  if (Math.random() < 0.30) {
    const knownPool = ['Coldplay', 'U2', 'Beyoncé', 'Jay-Z', 'Rihanna', 'Eminem', 'Adele', 'Bruno Mars', 'Katy Perry', 'Maroon 5'];
    return knownPool[Math.floor(Math.random() * knownPool.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

function generateCandidates(seed, count = 300) {
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const artist = randomArtist(seed.tags);
    const tags = [seed.tags[0]];
    if (Math.random() < 0.5) tags.push(seed.tags[1]);
    if (Math.random() < 0.3) tags.push(seed.tags[2]);

    candidates.push({
      title: `${seed.title} Mix ${i + 1}`,
      artist,
      album: `${artist} LP`,
      tags,
      year: Math.max(1950, seed.year + Math.floor(Math.random() * 40) - 20),
      bpm: Math.max(60, seed.bpm + Math.floor(Math.random() * 30) - 15),
      sources: ['lastfm'],
      match: Math.random() * 0.8 + 0.1,
      normalizedKey: `${normalizeForDedupe(artist)}|${normalizeForDedupe(`${seed.title} Mix ${i + 1}`)}`
    });
  }
  return candidates;
}

function evaluateSeed(seed) {
  const allCandidates = generateCandidates(seed);
  const seedKey = `${normalizeForDedupe(seed.artist)}|${normalizeForDedupe(seed.title)}`;
  const filtered = filterCandidates(allCandidates, {
    seedKey,
    recentKeys: new Set(),
    dislikedKeys: new Set()
  });

  const scored = rankCandidates(filtered, seed, { knownArtists: KNOWN_ARTISTS });

  const queue = [];
  while (queue.length < 50) {
    const batch = buildQueue(scored, { existingQueue: queue, adventurousness: 0.35, batchSize: 20 });
    if (!batch.length) break;
    queue.push(...batch);
  }

  const distinctArtists = new Set(queue.map(t => normalizeForDedupe(t.artist))).size;
  const knownInQueue = queue.filter(t => KNOWN_ARTISTS.has(normalizeForDedupe(t.artist))).length;
  const noveltyRate = queue.length ? (queue.length - knownInQueue) / queue.length : 0;

  const decades = {};
  queue.forEach(t => {
    const d = t.year ? `${Math.floor(t.year / 10) * 10}s` : 'unknown';
    decades[d] = (decades[d] || 0) + 1;
  });

  return {
    seed: `${seed.artist} - ${seed.title}`,
    queueLength: queue.length,
    distinctArtists,
    noveltyRate,
    decades
  };
}

function main() {
  console.log('=== Évaluation moteur radio (simulation) ===\n');
  const results = SEEDS.map(evaluateSeed);
  const avgNovelty = results.reduce((s, r) => s + r.noveltyRate, 0) / results.length;

  results.forEach(r => {
    console.log(`${r.seed}`);
    console.log(`  Titres générés : ${r.queueLength}`);
    console.log(`  Artistes distincts : ${r.distinctArtists}/${r.queueLength}`);
    console.log(`  Taux de découverte : ${(r.noveltyRate * 100).toFixed(1)}%`);
    console.log(`  Répartition époques :`, r.decades);
  });

  console.log(`\n→ Taux de découverte moyen : ${(avgNovelty * 100).toFixed(1)}%`);
  console.log(`→ Cible : 30-40% de découverte`);
  if (avgNovelty >= 0.30 && avgNovelty <= 0.40) {
    console.log('✅ Dans la cible.');
  } else if (avgNovelty < 0.30) {
    console.log('⚠️ Trop peu de découverte, augmenter le poids nouveauté / aventure.');
  } else {
    console.log('⚠️ Trop de découverte, réduire le poids nouveauté.');
  }
}

main();
