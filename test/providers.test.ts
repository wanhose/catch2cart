import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProviderHostname,
  getProviderLabel,
  parseProviderSelection,
  parseProviderStrategy,
} from '../src/providers/registry.ts';
import {
  getManaSourceCollectionUrl,
  parseManaSourcePrice,
  parseManaSourceQuantityOptions,
  parseManaSourceCartCount,
  parseManaSourceStock,
  parseManaSourceProductTitle,
} from '../src/providers/manasource.ts';
import {
  parseTorecaPrice,
  parseTorecaProductTitle,
  parseTorecaStock,
} from '../src/providers/toreca.ts';
import {
  selectProviderNames,
  selectProviderOffers,
} from '../src/providers/strategy.ts';

test('resolves the default provider selection to implemented providers', () => {
  assert.deepEqual(parseProviderSelection('all'), [
    'dorasuta',
    'pao',
    'manasource',
    'toreca',
  ]);
  assert.deepEqual(parseProviderSelection('dorasuta,dorasuta'), ['dorasuta']);
});

test('rejects unknown providers and accepts implemented providers', () => {
  assert.throws(() => parseProviderSelection('unknown'), /Unknown provider/);
  assert.deepEqual(parseProviderSelection('manasource'), ['manasource']);
});

test('reads provider labels and hostnames from the shared registry', () => {
  assert.equal(getProviderLabel('manasource'), 'ManaSource');
  assert.equal(getProviderLabel('pao'), 'PAO');
  assert.equal(getProviderHostname('toreca'), 'torecacamp-pokemon.com');
});

test('parses provider distribution strategies', () => {
  assert.equal(parseProviderStrategy('all'), 'all');
  assert.equal(parseProviderStrategy('CHEAPEST'), 'cheapest');
  assert.throws(
    () => parseProviderStrategy('random'),
    /Unknown provider strategy/,
  );
});

test('parses ManaSource identity embedded in product titles', () => {
  assert.deepEqual(
    parseManaSourceProductTitle('【30th CELEBRATION SAR】ホゲータex　124/103'),
    {
      productName: '【30th CELEBRATION SAR】ホゲータex 124/103',
      setCode: '30th CELEBRATION SAR',
      collectionName: '30th CELEBRATION',
      collectorNumber: '124',
      totalNumber: '103',
    },
  );
  assert.equal(
    parseManaSourceProductTitle('商品 without identity').collectorNumber,
    null,
  );
  assert.equal(
    getManaSourceCollectionUrl(2359),
    'https://www.manasource.net/product-list/2359',
  );
  assert.deepEqual(
    parseManaSourceProductTitle('【PROMO】名探偵ピカチュウ 098/SV-P'),
    {
      productName: '【PROMO】名探偵ピカチュウ 098/SV-P',
      setCode: 'PROMO',
      collectionName: 'PROMO',
      collectorNumber: '098',
      totalNumber: 'SV-P',
    },
  );
});

test('preserves ManaSource stock semantics from the HTML', () => {
  assert.equal(parseManaSourceStock('在庫数 4個'), 4);
  assert.equal(parseManaSourceStock('在庫わずか'), null);
  assert.equal(parseManaSourceStock('在庫なし'), null);
  assert.equal(parseManaSourcePrice('1,200円'), 1200);
  assert.equal(parseManaSourcePrice('価格未定'), null);
});

test('parses Toreca card identity and range-page values', () => {
  assert.deepEqual(parseTorecaProductTitle('ピカチュウex SAR M6a 126/103'), {
    productName: 'ピカチュウex SAR M6a 126/103',
    collectorNumber: '126',
    totalNumber: '103',
    setCode: 'M6a',
  });
  assert.equal(parseTorecaPrice('¥180～¥280'), 180);
  assert.equal(parseTorecaStock('在庫 52個'), 52);
  assert.equal(parseTorecaStock('在庫数 40個'), 40);
  assert.equal(parseTorecaStock('売り切れ'), 0);
});

test('parses the ManaSource global cart badge separately', () => {
  assert.equal(parseManaSourceCartCount('1'), 1);
  assert.equal(parseManaSourceCartCount(' 12 '), 12);
  assert.equal(parseManaSourceCartCount(''), null);
});

test('reads selectable ManaSource quantities from product-page options', () => {
  assert.deepEqual(
    parseManaSourceQuantityOptions(['1', '2', '3', '3', '0', 'x']),
    [1, 2, 3],
  );
});

test('applies provider strategy independently of provider implementation', () => {
  const offers = [
    { provider: 'dorasuta', price: 1500, stock: 2, available: true },
    { provider: 'manasource', price: 1200, stock: 1, available: true },
  ] as const;

  assert.deepEqual(
    selectProviderOffers([...offers], 'all').map((offer) => offer.provider),
    ['dorasuta', 'manasource'],
  );
  assert.deepEqual(
    selectProviderOffers([...offers], 'cheapest').map(
      (offer) => offer.provider,
    ),
    ['manasource'],
  );
  assert.deepEqual(
    selectProviderNames(
      ['dorasuta', 'manasource'],
      'cheapest',
      new Map(offers.map((offer) => [offer.provider, offer])),
    ),
    ['manasource'],
  );
});

test('cheapest ignores a lower-priced provider with no stock', () => {
  assert.deepEqual(
    selectProviderOffers(
      [
        { provider: 'dorasuta', price: 800, stock: 0, available: false },
        { provider: 'manasource', price: 1200, stock: 2, available: true },
      ],
      'cheapest',
    ).map((offer) => offer.provider),
    ['manasource'],
  );
});
