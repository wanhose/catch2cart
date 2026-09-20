import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseCondition,
  filterCandidatesByNumber,
  isCompatibleCachedProduct,
  isExactMatch,
  isInsufficientStockAlert,
  isLastResortNumberAndTotalMatch,
  setQuantity,
} from '../src/providers/dorasuta.ts';
import {
  getCachedProductUrls,
  getCachedProductOffers,
  getCachedProductAvailability,
  getCachedProductResolution,
  getCachedProductUrlsForProvider,
  getProductCacheKey,
  normalizeProductHostname,
} from '../src/product-cache.ts';

const card = {
  cardmarketName: 'Eevee',
  set: 'mc',
  number: '755',
};

test('creates stable provider-neutral product cache keys', () => {
  assert.equal(getProductCacheKey(card), 'mc:755:eevee');
});

test('reads current and legacy product cache entries', () => {
  assert.deepEqual(
    getCachedProductUrls('https://dorasuta.jp/pokemon-card/product?pid=1'),
    ['https://dorasuta.jp/pokemon-card/product?pid=1'],
  );
  assert.deepEqual(
    getCachedProductUrls({
      url: 'https://dorasuta.jp/pokemon-card/product?pid=2',
    }),
    ['https://dorasuta.jp/pokemon-card/product?pid=2'],
  );
  assert.deepEqual(
    getCachedProductUrls({
      urls: [
        'https://dorasuta.jp/pokemon-card/product?pid=3',
        '[https://manasource.net/product/4](https://manasource.net/product/4)',
        'https\\://manasource.net/product/4',
      ],
    }),
    [
      'https://dorasuta.jp/pokemon-card/product?pid=3',
      'https://manasource.net/product/4',
    ],
  );
  assert.deepEqual(getCachedProductUrls({}), []);
  assert.deepEqual(
    getCachedProductResolution(
      {
        resolution: {
          'dorasuta.jp': {
            status: 'NO_NUMBER_MATCH',
            checkedAt: new Date().toISOString(),
          },
        },
      },
      'dorasuta.jp',
    )?.status,
    'NO_NUMBER_MATCH',
  );
  assert.equal(
    getCachedProductResolution(
      {
        resolution: {
          'dorasuta.jp': {
            status: 'SET_METADATA_NOT_FOUND',
            checkedAt: new Date().toISOString(),
          },
        },
      },
      'dorasuta.jp',
    ),
    null,
  );
});

test('reads observed provider offers, including sold-out products', () => {
  const checkedAt = new Date().toISOString();

  assert.deepEqual(
    getCachedProductOffers(
      {
        offers: {
          'pao-onlineshop.com': [
            {
              url: 'https://pao-onlineshop.com/view/item/1',
              productName: 'ラティオス 070/064',
              price: 1800,
              stock: 0,
              available: false,
              addable: false,
              status: 'OBSERVED',
              checkedAt,
            },
          ],
        },
      },
      'pao-onlineshop.com',
    ),
    [
      {
        url: 'https://pao-onlineshop.com/view/item/1',
        productName: 'ラティオス 070/064',
        price: 1800,
        stock: 0,
        available: false,
        addable: false,
        status: 'OBSERVED',
        checkedAt,
      },
    ],
  );
});

test('reads the selected offer without duplicating its URL in provider metadata', () => {
  const checkedAt = new Date().toISOString();
  const entry = {
    providers: {
      'manasource.net': {
        offers: [
          {
            url: 'https://www.manasource.net/product/197256',
            selected: true,
            productName: 'アローラニャース 115/103',
            price: 450,
            stock: 15,
            available: true,
            addable: true,
            status: 'OBSERVED',
            checkedAt,
          },
          {
            url: 'https://www.manasource.net/product/999999',
            selected: false,
            price: 400,
            stock: 99,
            available: true,
            checkedAt,
          },
        ],
      },
    },
  };

  assert.equal(
    normalizeProductHostname('www.manasource.net'),
    'manasource.net',
  );
  assert.deepEqual(
    getCachedProductUrlsForProvider(entry, 'www.manasource.net'),
    [
      'https://www.manasource.net/product/197256',
      'https://www.manasource.net/product/999999',
    ],
  );
  assert.equal(getCachedProductOffers(entry, 'manasource.net')[0]?.price, 450);
  assert.deepEqual(getCachedProductAvailability(entry, 'www.manasource.net'), {
    availableQuantity: 15,
    checkedAt,
  });
});

test('reads the legacy selected URL until the product cache is migrated', () => {
  const entry = {
    providers: {
      'dorasuta.jp': {
        selectedUrl: 'https://dorasuta.jp/pokemon-card/product?pid=2',
        offers: [
          {
            url: 'https://dorasuta.jp/pokemon-card/product?pid=1',
            price: 100,
            stock: 1,
            available: true,
            checkedAt: new Date().toISOString(),
          },
          {
            url: 'https://dorasuta.jp/pokemon-card/product?pid=2',
            price: 200,
            stock: 2,
            available: true,
            checkedAt: new Date().toISOString(),
          },
        ],
      },
    },
  };

  assert.equal(
    getCachedProductUrlsForProvider(entry, 'dorasuta.jp')[0],
    'https://dorasuta.jp/pokemon-card/product?pid=2',
  );
});

test('requires set and collector number for an exact match', () => {
  assert.equal(
    isExactMatch(card, { setCode: 'mc', collectorNumber: '755' }),
    true,
  );
  assert.equal(
    isExactMatch(card, { setCode: 'sv8', collectorNumber: '755' }),
    false,
  );
  assert.equal(
    isExactMatch(card, { setCode: null, collectorNumber: '755' }),
    false,
  );
});

test('allows incomplete cached metadata only when it is not contradictory', () => {
  assert.equal(isCompatibleCachedProduct(card, {}), true);
  assert.equal(isCompatibleCachedProduct(card, { setCode: 'mc' }), true);
  assert.equal(
    isCompatibleCachedProduct(card, { collectorNumber: '756' }),
    false,
  );
});

test('supports restricted fallback matching for incomplete product metadata', () => {
  const fallbackCard = {
    cardmarketName: 'Example',
    set: 'sv2d',
    number: '51',
  };
  const productName = 'ニャオハ(51/071)';

  assert.equal(
    isLastResortNumberAndTotalMatch(
      fallbackCard,
      {
        setCode: null,
        collectorNumber: '51',
        modelNumber: 'pn51071',
        productName,
      },
      1,
    ),
    true,
  );
  assert.equal(
    isLastResortNumberAndTotalMatch(
      fallbackCard,
      {
        setCode: null,
        collectorNumber: '51',
        modelNumber: 'pn51048',
        productName: 'ニャオハ(51/049)',
      },
      1,
    ),
    false,
  );
});

test('filters candidates by collector number', () => {
  const candidates = [
    { title: 'イーブイ(AR仕様)(755/742)' },
    { title: 'イーブイ(126/103)' },
  ];

  assert.deepEqual(filterCandidatesByNumber(candidates, '755'), [
    candidates[0],
  ]);
});

test('prefers full stock and otherwise returns the best partial offer', () => {
  const discounted = { condition: '状態A特価', stock: 1, canAdd: true };
  const regular = { condition: '状態A', stock: 3, canAdd: true };

  assert.equal(chooseCondition([discounted, regular], 2), regular);
  assert.equal(chooseCondition([discounted, regular], 5), regular);
  assert.equal(chooseCondition([{ ...discounted, stock: 0 }], 1), null);
  assert.equal(
    chooseCondition(
      [
        { condition: '状態A特価', stock: 5, canAdd: false },
        { condition: '状態A', stock: 2, canAdd: true },
      ],
      1,
    ).condition,
    '状態A',
  );
});

test('handles selectors safely when quantity one has no selector', async () => {
  await setQuantity({ count: async () => 0 }, 1);

  await assert.rejects(
    setQuantity({ count: async () => 0 }, 2),
    /Quantity selector missing/,
  );

  let selected = null;
  const select = {
    count: async () => 1,
    locator: () => ({
      evaluateAll: async (callback) =>
        callback([{ value: '1' }, { value: '2' }]),
    }),
    selectOption: async (value) => {
      selected = value;
    },
  };

  await setQuantity(select, 2);
  assert.equal(selected, '2');
});

test('recognizes a Dorasuta stock alert that requires cart reconciliation', () => {
  assert.equal(
    isInsufficientStockAlert(
      '在庫が不足しています。カートの数量を調整してください。',
    ),
    true,
  );
  assert.equal(isInsufficientStockAlert('商品をカートに追加しました。'), false);
});
