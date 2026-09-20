import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTorecaCartItems,
  parseTorecaPrice,
  parseTorecaProductTitle,
  parseTorecaStock,
  isTorecaGradedProduct,
  isTorecaMetalCardProduct,
  selectTorecaStateA,
} from '../src/providers/toreca.ts';

test('parses Toreca identity from Japanese product titles', () => {
  assert.deepEqual(parseTorecaProductTitle('アローラニャース AR M6a 115/103'), {
    productName: 'アローラニャース AR M6a 115/103',
    collectorNumber: '115',
    totalNumber: '103',
    setCode: 'M6a',
  });
  assert.equal(
    parseTorecaProductTitle('card without number').collectorNumber,
    null,
  );
});

test('parses a printed promo identifier from a Toreca product title', () => {
  assert.deepEqual(parseTorecaProductTitle('名探偵ピカチュウ PROMO 098/SV-P'), {
    productName: '名探偵ピカチュウ PROMO 098/SV-P',
    collectorNumber: '098',
    totalNumber: null,
    setCode: 'SV-P',
  });
});

test('parses single and range prices', () => {
  assert.equal(parseTorecaPrice('¥280～¥380'), 280);
  assert.equal(parseTorecaPrice('¥11,800'), 11800);
  assert.equal(parseTorecaPrice('在庫なし'), null);
});

test('rejects graded and slabbed products', () => {
  assert.equal(isTorecaGradedProduct('PSA10)アリアドス CHR S8b 205/184'), true);
  assert.equal(isTorecaGradedProduct('アリアドス CHR S8b 205/184'), false);
  assert.equal(
    isTorecaGradedProduct('鑑定品 アリアドス CHR S8b 205/184'),
    true,
  );
});

test('rejects Metal Card products that reuse a collector number', () => {
  assert.equal(
    isTorecaMetalCardProduct('英語版)Mew ex 205/165 (151 Metal Card) ミュウex'),
    true,
  );
  assert.equal(
    isTorecaMetalCardProduct('ミュウex SAR SV2a 205/165 【KK】'),
    false,
  );
});

test('parses available and sold-out stock labels', () => {
  assert.equal(parseTorecaStock('在庫 52個'), 52);
  assert.equal(parseTorecaStock('在庫数 40個'), 40);
  assert.equal(parseTorecaStock('残り 2個'), 2);
  assert.equal(parseTorecaStock('売り切れ'), 0);
  assert.equal(parseTorecaStock(''), null);
});

test('accepts only condition A', () => {
  assert.deepEqual(
    selectTorecaStateA([
      { id: 'a-minus', text: '【状態A-】 - ¥380' },
      { id: 'b', text: '【状態B】 - ¥280' },
      { id: 'a', text: '【状態A】 - ¥480' },
    ]),
    { id: 'a', price: 480 },
  );
  assert.equal(
    selectTorecaStateA([{ id: 'a', text: '【状態A】 - ¥480', disabled: true }]),
    null,
  );
});

test('normalizes Shopify cart items', () => {
  assert.deepEqual(
    parseTorecaCartItems([
      {
        id: 49361800167598,
        variant_id: 49361800167598,
        url: '/products/rc_itxjoqhqr9g0_qs2l?variant=49361800167598',
        product_title: 'アローラニャース AR M6a 115/103',
        title: '【状態A】',
        quantity: 2,
        final_price: 960,
      },
    ]),
    [
      {
        productId: '49361800167598',
        url: 'https://torecacamp-pokemon.com/products/rc_itxjoqhqr9g0_qs2l?variant=49361800167598',
        productName: 'アローラニャース AR M6a 115/103',
        quantity: 2,
        price: 9.6,
      },
    ],
  );
});
