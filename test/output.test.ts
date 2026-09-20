import assert from 'node:assert/strict';
import test from 'node:test';
import { formatSummaryStatus, sortSummaryEntries } from '../src/output.ts';

test('formats every provider and cheapest summary with one separator', () => {
  assert.equal(
    formatSummaryStatus('CHEAPEST_ALREADY_IN_CART'),
    'Cheapest · Already in cart',
  );
  assert.equal(formatSummaryStatus('PAO_ADDED_TO_CART'), 'PAO · Added to cart');
  assert.equal(
    formatSummaryStatus('TORECA_ADDED_TO_CART'),
    'Toreca · Added to cart',
  );
  assert.equal(
    formatSummaryStatus('MANASOURCE_ADDED_TO_CART'),
    'ManaSource · Added to cart',
  );
  assert.equal(
    formatSummaryStatus('CHEAPEST_NO_ELIGIBLE_OFFER'),
    'Cheapest · No eligible offer',
  );
  assert.equal(formatSummaryStatus('ERROR'), 'Dorasuta · Error');
});

test('sorts summary rows by provider and result instead of completion timing', () => {
  const summary = {
    CHEAPEST_ERROR: 2,
    PAO_ADDED_TO_CART: 9,
    TORECA_ADDED_TO_CART: 16,
    CHEAPEST_ALREADY_IN_CART: 244,
    ADDED_TO_CART: 9,
    CHEAPEST_NO_ELIGIBLE_OFFER: 5,
    MANASOURCE_ADDED_TO_CART: 4,
  };

  assert.deepEqual(
    sortSummaryEntries(summary).map(([status]) => formatSummaryStatus(status)),
    [
      'Dorasuta · Added to cart',
      'ManaSource · Added to cart',
      'PAO · Added to cart',
      'Toreca · Added to cart',
      'Cheapest · Already in cart',
      'Cheapest · No eligible offer',
      'Cheapest · Error',
    ],
  );
});
