import type { ProviderName, ProviderOffer, ProviderStrategy } from './types.ts';

/**
 * Decide which provider offers are eligible for a card.
 *
 * `all` deliberately returns every available offer so callers can populate
 * every selected cart. `cheapest` returns the lowest known unit price and
 * keeps ties, allowing the caller to choose one product without baking any
 * provider-specific rule into the strategy layer.
 */
export function selectProviderOffers(
  offers: ProviderOffer[],
  strategy: ProviderStrategy,
): ProviderOffer[] {
  const available = offers.filter((offer) => offer.available);

  if (strategy === 'all') {
    return available;
  }

  const priced = available.filter(
    (offer) =>
      offer.price !== null && (offer.stock === null || offer.stock > 0),
  );

  if (!priced.length) {
    return [];
  }

  const cheapestPrice = Math.min(
    ...priced.map((offer) => offer.price as number),
  );

  return priced.filter((offer) => offer.price === cheapestPrice);
}

/** Preserve configured provider order while applying the global strategy. */
export function selectProviderNames(
  providers: ProviderName[],
  strategy: ProviderStrategy,
  offersByProvider: Map<ProviderName, ProviderOffer> = new Map(),
): ProviderName[] {
  if (strategy === 'all') {
    return [...providers];
  }

  return selectProviderOffers(
    providers
      .map((provider) => offersByProvider.get(provider))
      .filter((offer): offer is ProviderOffer => Boolean(offer)),
    strategy,
  ).map((offer) => offer.provider);
}
