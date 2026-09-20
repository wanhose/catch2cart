import type { Page } from 'playwright';
import { COMMIT, MAX_PRICE_YEN } from '../../config.ts';
import { buildJapaneseSearchName, numbersEqual } from '../../cards.ts';
import {
  buildProviderSearchQueries,
  findMatchingCartEntry,
  matchProviderProduct,
  type ProviderCartEntry,
} from '../matching.ts';
import { inspectAllCandidates } from '../candidates.ts';
import {
  cacheProduct,
  cacheProductAvailability,
  cacheProductOffers,
  cacheProductResolution,
  getCachedProductAvailability,
  getCachedProductEntry,
  getCachedProductSearchName,
  getCachedProductResolution,
  getCachedProductUrlsForProvider,
  getProductCacheKey,
} from '../../product-cache.ts';
import {
  addManaSourceToCart,
  inspectManaSourceProduct,
  parseManaSourceProductId,
  searchManaSource,
} from '../manasource.ts';
import { getProviderHostname } from '../registry.ts';

const MANASOURCE_HOSTNAME = getProviderHostname('manasource');

export type ManaSourceCartQuantities = Map<string, number | null>;

export interface ManaSourceCardResult {
  status: string;
  productId?: string;
  price?: number | null;
  stock?: number;
  missingQuantity?: number;
}

interface ManaSourceCard {
  quantity: number;
  cardmarketName: string;
  set: string;
  number: string;
}

/** Rank verified identities before comparing price. */
function getManaSourceMatch(card, product) {
  return matchProviderProduct(card, product);
}

/** Resolve, verify and optionally add one wishlist card on ManaSource. */
export async function processManaSourceCard(
  page: Page,
  card: ManaSourceCard,
  cartQuantities: ManaSourceCartQuantities,
  options: {
    commit?: boolean;
    cartEntries?: ProviderCartEntry[];
    // eslint-disable-next-line no-unused-vars
    onOffer?: (offer: {
      provider: 'manasource';
      price: number | null;
      stock: number;
      available: boolean;
    }) => void;
    // eslint-disable-next-line no-unused-vars
    onProgress?: (phase: string) => void;
    // eslint-disable-next-line no-unused-vars
    onCandidateProgress?: (checked: number, total: number) => void;
    // eslint-disable-next-line no-unused-vars
    onCandidatesReady?: (total: number) => void | Promise<void>;
  } = {},
): Promise<ManaSourceCardResult> {
  const commit = options.commit ?? COMMIT;
  const cartEntry = findMatchingCartEntry(card, options.cartEntries ?? []);

  if (cartEntry && cartEntry.quantity >= card.quantity) {
    await options.onCandidatesReady?.(0);
    return { status: 'ALREADY_IN_CART', productId: cartEntry.productId };
  }

  const japanese = buildJapaneseSearchName(card.cardmarketName);

  if (!japanese.searchName) {
    await options.onCandidatesReady?.(0);
    return { status: 'NAME_NOT_RESOLVED' };
  }

  const cacheEntry = getCachedProductEntry(getProductCacheKey(card));
  const cachedUrl = getCachedProductUrlsForProvider(
    cacheEntry,
    MANASOURCE_HOSTNAME,
  )[0];
  const cachedSearchName = getCachedProductSearchName(cacheEntry);
  const cachedResolution = cachedUrl
    ? null
    : getCachedProductResolution(cacheEntry, MANASOURCE_HOSTNAME);
  let product = null;
  let candidatesWereInspected = false;

  if (cachedResolution) {
    await options.onCandidatesReady?.(0);
    return { status: cachedResolution.status };
  }

  if (cachedUrl) {
    const cachedProductId = parseManaSourceProductId(cachedUrl);
    const cachedCartQuantity = cachedProductId
      ? cartQuantities.get(cachedProductId)
      : undefined;
    const cachedAvailability = getCachedProductAvailability(
      cacheEntry,
      MANASOURCE_HOSTNAME,
    );
    if (
      cachedProductId &&
      cachedCartQuantity !== null &&
      cachedCartQuantity !== undefined &&
      cachedCartQuantity >= card.quantity
    ) {
      return {
        status: 'ALREADY_IN_CART',
        productId: cachedProductId,
      };
    }

    const cachedProduct = await inspectManaSourceProduct(page, cachedUrl);

    if (
      (cachedProduct.collectorNumber === null ||
        numbersEqual(cachedProduct.collectorNumber, card.number)) &&
      getManaSourceMatch(card, cachedProduct).kind !== 'none'
    ) {
      product = cachedProduct;

      if (cachedAvailability?.availableQuantity === 0) {
        return {
          status: 'INSUFFICIENT_STOCK',
          productId: cachedProductId,
          stock: 0,
        };
      }
    }
  }

  const searchQueries = buildProviderSearchQueries(
    cachedSearchName ?? japanese.searchName,
    card,
  );
  if (!searchQueries.length) {
    await options.onCandidatesReady?.(0);
    await cacheProductResolution(
      card,
      MANASOURCE_HOSTNAME,
      'SET_METADATA_NOT_FOUND',
      cachedSearchName ?? japanese.searchName,
    );
    return { status: 'SET_METADATA_NOT_FOUND' };
  }
  let searchName = searchQueries[0];

  if (!product) {
    let numberedCandidates = [];

    for (const query of searchQueries) {
      searchName = query;
      const candidates = await searchManaSource(page, query, {
        sortByPrice: true,
      });
      numberedCandidates = candidates.filter(
        (candidate) =>
          candidate.collectorNumber !== null &&
          numbersEqual(candidate.collectorNumber, card.number),
      );

      if (numberedCandidates.length) break;
    }

    if (!numberedCandidates.length) {
      await options.onCandidatesReady?.(0);
      await cacheProductResolution(
        card,
        MANASOURCE_HOSTNAME,
        'NO_NUMBER_MATCH',
        searchName,
      );
      return { status: 'NO_NUMBER_MATCH' };
    }

    await options.onCandidatesReady?.(numberedCandidates.length);
    candidatesWereInspected = true;
    const inspectedCandidates = await inspectAllCandidates(
      numberedCandidates,
      async (candidate: { url: string }, candidateIndex, candidateTotal) => {
        options.onCandidateProgress?.(candidateIndex + 1, candidateTotal);
        return inspectManaSourceProduct(page, candidate.url);
      },
    );
    const verifiedCandidates = [];

    for (const {
      candidate,
      product: inspectedCandidate,
    } of inspectedCandidates) {
      if (getManaSourceMatch(card, inspectedCandidate).kind !== 'none') {
        verifiedCandidates.push({ candidate, product: inspectedCandidate });
      }
    }

    if (!verifiedCandidates.length) {
      await cacheProductResolution(
        card,
        MANASOURCE_HOSTNAME,
        'SET_NOT_VERIFIED',
        searchName,
      );
      return { status: 'SET_NOT_VERIFIED' };
    }

    await cacheProductOffers(
      card,
      MANASOURCE_HOSTNAME,
      verifiedCandidates.map(({ product: candidateProduct }) => ({
        url: candidateProduct.url,
        price: candidateProduct.price,
        stock: candidateProduct.availableQuantity,
        available:
          candidateProduct.addable && candidateProduct.availableQuantity > 0,
      })),
    );

    const availableCandidates = verifiedCandidates.filter(
      ({ product: candidateProduct }) =>
        candidateProduct.addable && candidateProduct.availableQuantity > 0,
    );

    if (!availableCandidates.length) {
      return { status: 'INSUFFICIENT_STOCK', stock: 0 };
    }

    const matched = [...availableCandidates].sort((a, b) => {
      const matchPriority =
        getManaSourceMatch(card, b.product).score -
        getManaSourceMatch(card, a.product).score;
      if (matchPriority !== 0) return matchPriority;

      const aPrice = a.product.price;
      const bPrice = b.product.price;
      if (aPrice === null && bPrice === null) return 0;
      if (aPrice === null) return 1;
      if (bPrice === null) return -1;
      return aPrice - bPrice;
    })[0];

    // Cache only after collector number and collection identity agree.
    await cacheProduct(card, matched.product, searchName);
    product = matched.product;
  }

  await cacheProductAvailability(
    card,
    MANASOURCE_HOSTNAME,
    product.availableQuantity,
  );
  await cacheProductOffers(card, MANASOURCE_HOSTNAME, [
    {
      url: product.url,
      price: product.price,
      stock: product.availableQuantity,
      available: product.addable && product.availableQuantity > 0,
    },
  ]);

  if (product && !candidatesWereInspected) {
    await options.onCandidatesReady?.(0);
  }

  const productId = product.externalId;

  if (!productId) {
    return { status: 'PRODUCT_ID_NOT_FOUND' };
  }

  if (!product.addable || product.availableQuantity <= 0) {
    return {
      status: 'INSUFFICIENT_STOCK',
      productId,
      price: product.price,
      stock: product.availableQuantity,
    };
  }

  if (
    MAX_PRICE_YEN !== null &&
    (product.price === null || product.price > MAX_PRICE_YEN)
  ) {
    return {
      status: 'PRICE_LIMIT',
      productId,
      price: product.price,
      stock: product.availableQuantity,
    };
  }

  const currentQuantity = cartQuantities.get(productId);

  if (currentQuantity === null) {
    return { status: 'CART_QUANTITY_UNKNOWN', productId };
  }

  const requestedAdditional = card.quantity - (currentQuantity ?? 0);

  if (requestedAdditional <= 0) {
    return {
      status: 'ALREADY_IN_CART',
      productId,
      price: product.price,
      stock: product.availableQuantity,
    };
  }

  const quantityToAdd = Math.min(
    requestedAdditional,
    product.availableQuantity,
  );
  const missingQuantity = requestedAdditional - quantityToAdd;

  options.onOffer?.({
    provider: 'manasource',
    price: product.price,
    stock: product.availableQuantity,
    available: product.availableQuantity > 0,
  });

  if (!commit) {
    return {
      status: missingQuantity ? 'DRY_RUN_PARTIAL_STOCK' : 'DRY_RUN_OK',
      productId,
      price: product.price,
      stock: product.availableQuantity,
      missingQuantity,
    };
  }

  await addManaSourceToCart(page, productId, quantityToAdd);
  cartQuantities.set(productId, (currentQuantity ?? 0) + quantityToAdd);

  return {
    status: missingQuantity ? 'ADDED_TO_CART_PARTIAL_STOCK' : 'ADDED_TO_CART',
    productId,
    price: product.price,
    stock: product.availableQuantity,
    missingQuantity,
  };
}
