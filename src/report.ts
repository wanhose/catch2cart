import {
  getCachedProductOffers,
  normalizeProductHostname,
  type getCachedProductEntry,
  type getProductCacheKey,
  type ProductCacheEntry,
  type ProductOfferSnapshot,
} from './product-cache.ts';
import { PROVIDER_REGISTRY } from './providers/registry.ts';

export interface CostReportCard {
  quantity: number;
  cardmarketName: string;
  set: string;
  number: string;
}

export interface CostReportProvider {
  provider: string;
  cost: number;
  fullCards: number;
  partialCards: number;
  missingQuantity: number;
  unavailableCards: number;
  observedCards: number;
}

export interface CostReport {
  providers: CostReportProvider[];
  idealCost: number;
  idealFullCards: number;
  idealPartialCards: number;
  idealMissingQuantity: number;
  idealUnavailableCards: number;
  observedCards: number;
}

type ProductEntryReader = typeof getCachedProductEntry;
type ProductKeyBuilder = typeof getProductCacheKey;

function eligibleOffer(offer: ProductOfferSnapshot) {
  return (
    offer.available &&
    typeof offer.price === 'number' &&
    Number.isFinite(offer.price) &&
    offer.price >= 0 &&
    typeof offer.stock === 'number' &&
    Number.isInteger(offer.stock) &&
    offer.stock > 0
  );
}

function observedOffers(
  entry: ProductCacheEntry | undefined,
  provider: string,
  observedAfter: number,
) {
  const hostname = normalizeProductHostname(
    PROVIDER_REGISTRY[provider as keyof typeof PROVIDER_REGISTRY]?.hostname ??
      provider,
  );

  return getCachedProductOffers(entry, hostname).filter(
    (offer) => Date.parse(offer.checkedAt) >= observedAfter,
  );
}

function bestOffer(offers: ProductOfferSnapshot[], quantity: number) {
  return (
    offers.filter(eligibleOffer).sort((a, b) => {
      const aCoverage = Math.min(a.stock ?? 0, quantity);
      const bCoverage = Math.min(b.stock ?? 0, quantity);

      if (aCoverage !== bCoverage) return bCoverage - aCoverage;
      return a.price - b.price;
    })[0] ?? null
  );
}

function addOffer(
  target: {
    cost: number;
    fullCards: number;
    partialCards: number;
    missingQuantity: number;
    unavailableCards: number;
    observedCards: number;
  },
  quantity: number,
  offer: ProductOfferSnapshot | null,
) {
  if (!offer) {
    target.unavailableCards++;
    return;
  }

  const stock = Math.max(0, offer.stock ?? 0);
  const bought = Math.min(quantity, stock);
  target.cost += bought * (offer.price ?? 0);
  target.observedCards++;

  if (bought >= quantity) {
    target.fullCards++;
  } else {
    target.partialCards++;
    target.missingQuantity += quantity - bought;
  }
}

export function buildCostReport(
  cards: CostReportCard[],
  providers: string[],
  getEntry: ProductEntryReader,
  getKey: ProductKeyBuilder,
  observedAfter: number,
): CostReport {
  const readEntry = getEntry;
  const makeKey = getKey;
  const totals = new Map(
    providers.map((provider) => [
      provider,
      {
        provider,
        cost: 0,
        fullCards: 0,
        partialCards: 0,
        missingQuantity: 0,
        unavailableCards: 0,
        observedCards: 0,
      },
    ]),
  );
  const ideal = {
    cost: 0,
    fullCards: 0,
    partialCards: 0,
    missingQuantity: 0,
    unavailableCards: 0,
    observedCards: 0,
  };

  for (const card of cards) {
    const entries = providers.map((provider) => ({
      provider,
      offer: bestOffer(
        observedOffers(readEntry(makeKey(card)), provider, observedAfter),
        card.quantity,
      ),
    }));

    for (const { provider, offer } of entries) {
      addOffer(totals.get(provider), card.quantity, offer);
    }

    addOffer(
      ideal,
      card.quantity,
      bestOffer(
        entries
          .map(({ offer }) => offer)
          .filter((offer): offer is ProductOfferSnapshot => offer !== null),
        card.quantity,
      ),
    );
  }

  return {
    providers: [...totals.values()],
    idealCost: ideal.cost,
    idealFullCards: ideal.fullCards,
    idealPartialCards: ideal.partialCards,
    idealMissingQuantity: ideal.missingQuantity,
    idealUnavailableCards: ideal.unavailableCards,
    observedCards: ideal.observedCards,
  };
}

function yen(value: number) {
  return `${Math.round(value).toLocaleString('en-US')}円`;
}

function providerLabel(provider: string) {
  return provider === 'manasource'
    ? 'ManaSource'
    : provider === 'dorasuta'
      ? 'Dorasuta'
      : provider === 'pao'
        ? 'PAO'
        : provider === 'toreca'
          ? 'Toreca'
          : provider;
}

export function formatCostReport(report: CostReport) {
  const lines = [
    '',
    'COST REPORT · observed offers from this run',
    'Prices include the provider-listed card price; shipping is excluded.',
    '',
    'Hypothetical cost by provider:',
  ];

  for (const provider of report.providers) {
    lines.push(
      `  ${providerLabel(provider.provider)} · ${yen(provider.cost)} · ` +
        `${provider.fullCards} full · ${provider.partialCards} partial · ` +
        `${provider.unavailableCards} unavailable · ` +
        `${provider.missingQuantity} missing copy(ies)`,
    );
  }

  lines.push(
    '',
    `Best observed mix · ${yen(report.idealCost)} · ` +
      `${report.idealFullCards} full · ${report.idealPartialCards} partial · ` +
      `${report.idealUnavailableCards} unavailable · ` +
      `${report.idealMissingQuantity} missing copy(ies)`,
  );

  return lines.join('\n');
}
