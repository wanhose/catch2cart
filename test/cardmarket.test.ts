import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeWishlistCards } from '../src/inputs/cardmarket.ts';

test('merges duplicate wishlist cards using the maximum quantity', () => {
  const cards = mergeWishlistCards([
    {
      cardmarketName: 'Eevee',
      quantity: 2,
      set: 'mc',
      number: '755',
      wishlistUrl: 'https://www.cardmarket.com/en/Pokemon/Wants/1',
    },
    {
      cardmarketName: 'Eevee',
      quantity: 5,
      set: 'mc',
      number: '755',
      wishlistUrl: 'https://www.cardmarket.com/en/Pokemon/Wants/2',
    },
    {
      cardmarketName: 'Eevee',
      quantity: 3,
      set: 'mc',
      number: '755',
      wishlistUrl: 'https://www.cardmarket.com/en/Pokemon/Wants/1',
    },
  ]);

  assert.deepEqual(cards, [
    {
      cardmarketName: 'Eevee',
      quantity: 5,
      set: 'mc',
      number: '755',
      wishlistUrls: [
        'https://www.cardmarket.com/en/Pokemon/Wants/1',
        'https://www.cardmarket.com/en/Pokemon/Wants/2',
      ],
      wishlistIds: ['1', '2'],
    },
  ]);
});

test('does not merge cards with different set or collector number', () => {
  const cards = mergeWishlistCards([
    {
      cardmarketName: 'Eevee',
      quantity: 1,
      set: 'mc',
      number: '755',
      wishlistUrl: 'list-1',
    },
    {
      cardmarketName: 'Eevee',
      quantity: 1,
      set: 'mc',
      number: '756',
      wishlistUrl: 'list-1',
    },
    {
      cardmarketName: 'Eevee',
      quantity: 1,
      set: 'sv8',
      number: '755',
      wishlistUrl: 'list-1',
    },
  ]);

  assert.equal(cards.length, 3);
});
