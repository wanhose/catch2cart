import assert from 'node:assert/strict';
import test from 'node:test';
import { matchProviderProduct } from '../src/providers/matching.ts';

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
