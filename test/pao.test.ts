import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dedupePaoCartEntries,
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
