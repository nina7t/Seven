const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { rankSuggestions, norm, phoneticVariant, mergePayloads } = require('../../search-suggest');

// Fixtures calquées sur les vraies réponses de /search/autocomplete de Deezer.
const A = (name, nb_fan, extra = {}) => ({
  id: extra.id || 1, name, nb_fan, picture: 'p', picture_medium: 'pm', ...extra
});
const T = (title, artist, rank, extra = {}) => ({
  id: extra.id || 1, title, rank, duration: 200,
  artist: { name: artist }, album: { title: 'Album', cover_medium: 'c' }, ...extra
});
const AL = (title, artist, record_type = 'album') => ({
  id: 1, title, record_type, cover_medium: 'c', artist: { name: artist }
});
const payload = ({ artists = [], tracks = [], albums = [] }) => ({
  artists: { data: artists }, tracks: { data: tracks }, albums: { data: albums }
});

describe('norm', () => {
  test('minuscules, sans accents ni apostrophes', () => {
    assert.equal(norm("Sinéad O'Connor"), 'sinead oconnor');
  });
});

describe('rankSuggestions', () => {
  test('« oconnor » trouve Sinéad O\'Connor en top hit malgré l\'apostrophe', () => {
    const items = rankSuggestions('oconnor', payload({
      artists: [A('OConnor', 4362), A("O'Connor", 1267), A("Sinéad O'Connor", 135092), A("The O'Connors", 21)],
      tracks: [T('Yo Caníbal', 'OConnor', 188141), T('Vida Perra', 'OConnor', 131811)]
    }));
    assert.equal(items[0].type, 'artist');
    assert.equal(items[0].name, "Sinéad O'Connor");
    assert.equal(items[0].topHit, true);
  });

  test('« sinad » (faute de frappe) remonte Sinéad O\'Connor avant Sinadin', () => {
    const items = rankSuggestions('sinad', payload({
      artists: [A('Zinadelphia', 1604), A('Sinadin', 8), A("Sinéad O'Connor", 135092), A('Sandy e Junior', 476698)]
    }));
    assert.equal(items[0].type, 'artist');
    assert.equal(items[0].name, "Sinéad O'Connor");
    assert.ok(items.findIndex(i => i.name === 'Sinadin') > 0);
  });

  test('« angele » dédoublonne l\'artiste et garde le plus suivi', () => {
    const items = rankSuggestions('angele', payload({
      artists: [A('Angele', 20), A('Angèle', 82), A('Angèle', 1747162)],
      tracks: [T('On verra', 'Angèle', 996753)]
    }));
    assert.equal(items[0].type, 'artist');
    assert.equal(items[0].name, 'Angèle');
    assert.equal(items[0].nbFan, 1747162);
    assert.equal(items.filter(i => i.type === 'artist' && i.name === 'Angèle').length, 1);
  });

  test('« nothing comp » préfère le titre de Sinéad O\'Connor en top hit', () => {
    const items = rankSuggestions('nothing comp', payload({
      artists: [A('Nothing Compares 2 U', 66)],
      tracks: [
        T('Nothing Compares 2 U', "Sinéad O'Connor", 831988),
        T('Nothing Compares 2 U', 'Prince', 687186)
      ]
    }));
    assert.equal(items[0].type, 'track');
    assert.equal(items[0].title, 'Nothing Compares 2 U');
    assert.equal(items[0].artist, "Sinéad O'Connor");
  });

  test('« sinead » met l\'artiste avant un titre qui s\'appelle exactement « Sinéad »', () => {
    const items = rankSuggestions('sinead', payload({
      artists: [A('SINEAD', 39), A("Sinéad O'Connor", 135092), A('Sinead Harnett', 22080)],
      tracks: [T('Sinéad', 'Within Temptation', 425000)]
    }));
    assert.equal(items[0].type, 'artist');
    assert.equal(items[0].name, "Sinéad O'Connor");
  });

  test('« sinad » : la faute sur un début de mot (Sinatra) ne bat pas Sinéad', () => {
    const items = rankSuggestions('sinad', payload({
      artists: [A('Zinadelphia', 1604), A("Sinéad O'Connor", 135092), A('Frank Sinatra', 2487845)],
      tracks: [T('Sinadisi (Live)', 'Dimitra Galani', 74000)]
    }));
    assert.equal(items[0].name, "Sinéad O'Connor");
  });

  test('« frank » promeut les artistes populaires trouvés via les titres', () => {
    const items = rankSuggestions('frank', payload({
      artists: [A('Frank(just Frank)', 9), A('Frank & Rogg', 1701)],
      tracks: [
        T('Nights', 'Frank Ocean', 864617, { artist: { id: 1350335, name: 'Frank Ocean', picture_medium: 'fo' } }),
        T('Franklin Saint', 'SDM', 835353),
        T('My Way', 'Frank Sinatra', 792826)
      ]
    }));
    assert.equal(items[0].type, 'artist');
    assert.equal(items[0].name, 'Frank Ocean');
    assert.equal(items[0].id, '1350335');
    assert.equal(items[0].picture, 'fo');
    assert.equal(items[1].name, 'Frank Sinatra');
  });

  test('« synad » : y = i, Sinéad trouvée via la variante « sinad »', () => {
    assert.equal(phoneticVariant('synad'), 'sinad');
    assert.equal(phoneticVariant('sinad'), null);
    const main = payload({ artists: [A('Synapson', 300000, { id: 10 })] });
    const alt = payload({ artists: [A("Sinéad O'Connor", 135092, { id: 20 }), A('Synapson', 300000, { id: 10 })] });
    const merged = mergePayloads(main, alt);
    assert.equal(merged.artists.data.length, 2);
    assert.equal(rankSuggestions('synad', merged)[0].name, "Sinéad O'Connor");
  });

  test('« synad oc » : plusieurs mots avec une faute retrouvent l\'artiste', () => {
    const items = rankSuggestions('synad oc', payload({
      artists: [A("Sinéad O'Connor", 135092)],
      tracks: [T('Cinnamon Girl', 'Lana Del Rey', 800000)]
    }));
    assert.equal(items[0].name, "Sinéad O'Connor");
  });

  test('« wonderwall oasis » / « zombie cranberries » : l\'original avant les reprises', () => {
    let items = rankSuggestions('wonderwall oasis', payload({
      tracks: [T('Wonderwall (Oasis)', 'The Fourth Floor', 300000), T('Wonderwall', 'Oasis', 900000)]
    }));
    assert.equal(items[0].artist, 'Oasis');
    items = rankSuggestions('zombie cranberries', payload({
      tracks: [T('Zombie Cranberries VS T.A.T.U (Remix)', 'Dee Jay Robson', 300000), T('Zombie', 'The Cranberries', 900000)]
    }));
    assert.equal(items[0].artist, 'The Cranberries');
  });

  test('plafonds : au plus 1 top hit + 3 lignes artiste', () => {
    const items = rankSuggestions('test', payload({
      artists: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta']
        .map((n, i) => A(`Test ${n}`, 1000000 - i * 1000))
    }));
    assert.ok(items.filter(i => i.type === 'artist').length <= 4);
    assert.ok(items.length <= 10);
    assert.equal(items.filter(i => i.topHit).length, 1);
  });
});
