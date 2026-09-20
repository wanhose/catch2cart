import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_CART_COVERAGE_RATIO,
  hasComparableCartCoverage,
} from '../src/providers/cart-comparison.ts';

test('only compares cart prices when wishlist coverage is comparable', () => {
  assert.equal(MINIMUM_CART_COVERAGE_RATIO, 0.9);
  assert.equal(hasComparableCartCoverage(100, 90), true);
  assert.equal(hasComparableCartCoverage(100, 89), false);
  assert.equal(hasComparableCartCoverage(5, 0), false);
});
