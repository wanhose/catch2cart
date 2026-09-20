import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dedupePaoCartEntries,
  getPaoCartProductName,
  parsePaoCartEntries,
  parsePaoCartRows,
  parsePaoPrice,
  parsePaoProductTitle,
  parsePaoStock,
} from '../src/providers/pao.ts';

test('deduplicates PAO cart entries rendered in multiple layouts', () => {
  const entry = {
    productId: '000000150173',
    url: 'https://pao-onlineshop.com/view/item/150173',
    productName: 'ロケット団のヘルガー AR 100/098',
    quantity: 1,
    price: 560,
  };

  assert.deepEqual(dedupePaoCartEntries([entry, { ...entry }]), [entry]);
});

test('parses PAO product identity, price and stock', () => {
  assert.deepEqual(
    parsePaoProductTitle(
      '★特価祭り★【プレイ用】ロケット団のヘルガー AR 100/098',
    ),
    {
      productName: '★特価祭り★【プレイ用】ロケット団のヘルガー AR 100/098',
      collectorNumber: '100',
      totalNumber: '098',
    },
  );
  assert.equal(parsePaoPrice('560円(税込)'), 560);
  assert.equal(parsePaoStock('残りあと4個'), 4);
  assert.equal(parsePaoStock('在庫なし'), 0);
  assert.equal(parsePaoStock('SOLD OUT'), 0);
});

test('reads PAO cart line identities and quantities', () => {
  assert.deepEqual(
    parsePaoCartRows([
      {
        id: 'makeshop-common-cart-quantity:000000150173-0-0-0-0-0',
        quantity: '2',
        price: '560円',
      },
    ]),
    {
      '000000150173': { quantity: 2, price: 560 },
    },
  );
});

test('reads PAO legacy cart product links and card numbers', () => {
  assert.deepEqual(
    parsePaoCartEntries([
      {
        id: '711166',
        quantity: '1',
        productName: 'フリーザー(107/103)',
        url: 'https://pao-onlineshop.com/pokemon-card/product?pid=711166',
        price: '570円(税込)',
      },
    ]),
    [
      {
        productId: '711166',
        url: 'https://pao-onlineshop.com/pokemon-card/product?pid=711166',
        productName: 'フリーザー(107/103)',
        quantity: 1,
        price: 570,
      },
    ],
  );
});

test('keeps the cart identity when the product link has no text', () => {
  assert.equal(
    getPaoCartProductName('', 'フリーザー(107/103)'),
    'フリーザー(107/103)',
  );
});
