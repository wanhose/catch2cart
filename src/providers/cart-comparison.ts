/**
 * Decide whether cart totals are comparable for a price-only suggestion.
 *
 * A provider with substantially lower wishlist coverage can look cheaper only
 * because it lacks cards. Keep the threshold intentionally conservative.
 */
export const MINIMUM_CART_COVERAGE_RATIO = 0.9;

export function hasComparableCartCoverage(
  leftCoveredCards: number,
  rightCoveredCards: number,
) {
  if (leftCoveredCards <= 0 || rightCoveredCards <= 0) {
    return false;
  }

  return (
    Math.min(leftCoveredCards, rightCoveredCards) /
      Math.max(leftCoveredCards, rightCoveredCards) >=
    MINIMUM_CART_COVERAGE_RATIO
  );
}
