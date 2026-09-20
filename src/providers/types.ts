/** Names understood by the provider selection layer. */
export type ProviderName = 'dorasuta' | 'manasource' | 'pao' | 'toreca';

/** How matching offers should be distributed across selected providers. */
export type ProviderStrategy = 'all' | 'cheapest';

/** Provider metadata used before a concrete browser adapter is loaded. */
export interface ProviderDescriptor {
  name: ProviderName;
  label: string;
  implemented: boolean;
  hostname: string;
  homeUrl: string;
}

/** Normalized offer data used by the provider strategy. */
export interface ProviderOffer {
  provider: ProviderName;
  price: number | null;
  stock: number | null;
  available: boolean;
}
