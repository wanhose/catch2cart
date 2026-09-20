import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProviderSearchQueries,
  formatProviderNumberTotal,
  matchProviderProduct,
} from '../src/providers/matching.ts';

test('pads the main-set total to match zero-padded collector numbers', () => {
  assert.equal(formatProviderNumberTotal('070', 64), '070/064');
  assert.equal(formatProviderNumberTotal('126', 103), '126/103');
  assert.equal(formatProviderNumberTotal('67', 89), '067/089');
});

test('refuses to build a query when set metadata is unavailable', () => {
  assert.deepEqual(
    buildProviderSearchQueries('ラティオス 070/064', {
      set: 'sv7a',
      number: '070',
    }),
    [],
  );
});

test('never builds a weak name-only or number-only query', () => {
  assert.deepEqual(
    buildProviderSearchQueries('ピカチュウ 001', {
      set: 'unknown-set',
      number: '001',
    }),
    [],
  );
});

test('accepts a number/total match when set metadata is unavailable', () => {
  assert.deepEqual(
    matchProviderProduct(
      { set: 'sm11b', number: '059' },
      {
        productName: 'ドリュウズ CHR 059/049',
        collectorNumber: '059',
        totalNumber: '049',
        setCode: null,
        collectionName: null,
      },
    ),
    { kind: 'number-total', score: 60 },
  );
});

test('rejects a number/total match with a contradictory set code', () => {
  assert.deepEqual(
    matchProviderProduct(
      { set: 'sv2d', number: '051' },
      {
        productName: 'ニャオハ 051/049',
        collectorNumber: '051',
        totalNumber: '049',
        setCode: 'sv8',
        collectionName: null,
      },
    ),
    { kind: 'none', score: 0 },
  );
});

test('accepts a normalized Pokémon-name match without provider punctuation', () => {
  assert.equal(
    matchProviderProduct(
      { set: 'unknown', number: '126', cardmarketName: 'Pikachu ex' },
      {
        productName: '★特価祭り★【プレイ用】ピカチュウex 126/103',
        collectorNumber: '126',
        totalNumber: '103',
        setCode: null,
        collectionName: null,
      },
    ).kind,
    'exact',
  );
});
