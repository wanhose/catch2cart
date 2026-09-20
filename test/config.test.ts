import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNonNegativeNumber,
  parseSkippedCardmarketWishlists,
} from '../src/config.ts';

test('parses non-negative numeric options', () => {
  assert.equal(parseNonNegativeNumber('--navigation-gap-ms', '1234'), 1234);
  assert.equal(parseNonNegativeNumber('--navigation-gap-ms', '0'), 0);
  assert.throws(
    () => parseNonNegativeNumber('--navigation-gap-ms', '-1'),
    /must be a non-negative number/,
  );
  assert.throws(
    () => parseNonNegativeNumber('--navigation-gap-ms', 'invalid'),
    /must be a non-negative number/,
  );
});

test('normalizes comma-separated wishlist IDs and URLs', () => {
  assert.deepEqual(
    parseSkippedCardmarketWishlists(
      '123, https://www.cardmarket.com/en/Pokemon/Wants/456',
    ),
    ['123', '456'],
  );
  assert.deepEqual(parseSkippedCardmarketWishlists(''), []);
  assert.throws(
    () => parseSkippedCardmarketWishlists('not-a-wishlist'),
    /must contain numeric wishlist IDs or URLs/,
  );
});
