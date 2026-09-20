import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildJapaneseSearchName,
  extractPokemonSpecies,
  extractTcgSuffix,
  getDorasutaProductId,
  isVUnionCardTitle,
  normalizeNumber,
  normalizeWhitespace,
  numbersEqual,
  parseCardmarketName,
  parseCollectorNumber,
} from '../src/cards.ts';

test('normalizes scraped text and collector numbers', () => {
  assert.equal(normalizeWhitespace('  Pikachu\n  ex  '), 'Pikachu ex');
  assert.equal(normalizeNumber('007'), '7');
  assert.equal(normalizeNumber('not-a-number'), null);
  assert.equal(numbersEqual('007', 7), true);
  assert.equal(numbersEqual('007', 8), false);
});

test('extracts Dorasuta product IDs from product URLs', () => {
  assert.equal(
    getDorasutaProductId('https://dorasuta.jp/pokemon-card/product?pid=704017'),
    '704017',
  );
  assert.equal(
    getDorasutaProductId('/pokemon-card/product?pid=704017'),
    '704017',
  );
  assert.equal(getDorasutaProductId('not a URL'), null);
});

test('parses Cardmarket names and identity fields', () => {
  assert.deepEqual(parseCardmarketName('  Pikachu ex ( sv8 126 ) '), {
    name: 'Pikachu ex',
    set: 'sv8',
    number: '126',
  });
  assert.equal(parseCardmarketName('Pikachu ex'), null);
});

test('builds Japanese search names using species, suffixes and local overrides', () => {
  assert.equal(
    buildJapaneseSearchName('Pikachu ex').searchName,
    'ピカチュウex',
  );
  assert.equal(
    buildJapaneseSearchName("Team Rocket's Mewtwo ex").searchName,
    'ミュウツーex',
  );
  assert.equal(buildJapaneseSearchName('Perrin').searchName, 'サザレ');
  assert.equal(buildJapaneseSearchName('Unknown Trainer').searchName, null);
  assert.equal(extractPokemonSpecies('Mega Greninja ex'), 'Greninja');
  assert.equal(extractTcgSuffix('Pikachu VMAX'), 'VMAX');
});

test('parses the final collector number from alternate-art titles', () => {
  assert.equal(parseCollectorNumber('イーブイ(AR仕様)(755/742)'), '755');
  assert.equal(parseCollectorNumber('ピカチュウex(132/M-P)'), '132');
  assert.equal(parseCollectorNumber('No collector number'), null);
});

test('identifies unsupported V-UNION wishlist titles', () => {
  assert.equal(isVUnionCardTitle('Morpeko V-UNION'), true);
  assert.equal(isVUnionCardTitle('Morpeko V UNION'), true);
  assert.equal(isVUnionCardTitle('Pikachu V-UNION'), true);
  assert.equal(isVUnionCardTitle('Pikachu VMAX'), false);
  assert.equal(isVUnionCardTitle('Union Cave'), false);
});
