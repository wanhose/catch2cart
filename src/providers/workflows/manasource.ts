import type { Page } from 'playwright';
import { COMMIT, MAX_PRICE_YEN } from '../../config.ts';
import { buildJapaneseSearchName, numbersEqual } from '../../cards.ts';
import {
  buildProviderSearchName,
  findMatchingCartEntry,
  matchProviderProduct,
  type ProviderCartEntry,
} from '../matching.ts';
import { inspectAllCandidates } from '../candidates.ts';
import {
  cacheProduct,
  cacheProductAvailability,
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

/** Reject a product whose Japanese collection contradicts a known set code. */
function matchesManaSourceSet(card, product) {
  return (
    matchProviderProduct(
      {
        set: card.set,
        number: product.collectorNumber ?? '',
        cardmarketName: card.cardmarketName,
      },
      product,
    ).kind !== 'none'
  );
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
  } = {},
): Promise<ManaSourceCardResult> {
  const commit = options.commit ?? COMMIT;
  const cartEntry = findMatchingCartEntry(card, options.cartEntries ?? []);

  if (cartEntry && cartEntry.quantity >= card.quantity) {
    return { status: 'ALREADY_IN_CART', productId: cartEntry.productId };
  }

  const japanese = buildJapaneseSearchName(card.cardmarketName);

  if (!japanese.searchName) {
    return { status: 'NAME_NOT_RESOLVED' };
  }

  const cacheEntry = getCachedProductEntry(getProductCacheKey(card));
  const cachedUrl = getCachedProductUrlsForProvider(
    cacheEntry,
    'www.manasource.net',
  )[0];
  const cachedSearchName = getCachedProductSearchName(cacheEntry);
  const cachedResolution = cachedUrl
    ? null
    : getCachedProductResolution(cacheEntry, 'www.manasource.net');
  let product = null;

  if (cachedResolution) {
    return { status: cachedResolution.status };
  }

  if (cachedUrl) {
    const cachedProductId = parseManaSourceProductId(cachedUrl);
    const cachedCartQuantity = cachedProductId
      ? cartQuantities.get(cachedProductId)
      : undefined;
    const cachedAvailability = getCachedProductAvailability(
      cacheEntry,
      'www.manasource.net',
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
      matchesManaSourceSet(card, cachedProduct)
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

  const searchName = buildProviderSearchName(
    cachedSearchName ?? japanese.searchName,
    card,
  );

  if (!product) {
    const candidates = await searchManaSource(page, searchName, {
      sortByPrice: true,
    });
    const numberedCandidates = candidates.filter(
      (candidate) =>
        candidate.collectorNumber !== null &&
        numbersEqual(candidate.collectorNumber, card.number),
    );

    if (!numberedCandidates.length) {
      await cacheProductResolution(
        card,
        'www.manasource.net',
        'NO_NUMBER_MATCH',
        searchName,
      );
      return { status: 'NO_NUMBER_MATCH' };
    }

    const inspectedCandidates = await inspectAllCandidates(
      numberedCandidates,
      async (candidate: { url: string }, candidateIndex, candidateTotal) => {
        options.onProgress?.(
          'ManaSource: Checking candidate ' +
            (candidateIndex + 1) +
            '/' +
            candidateTotal,
        );
        return inspectManaSourceProduct(page, candidate.url);
      },
    );
    const verifiedCandidates = [];

    for (const {
      candidate,
      product: inspectedCandidate,
    } of inspectedCandidates) {
      if (matchesManaSourceSet(card, inspectedCandidate)) {
        verifiedCandidates.push({ candidate, product: inspectedCandidate });
      }
    }

    if (!verifiedCandidates.length) {
      await cacheProductResolution(
        card,
        'www.manasource.net',
        'SET_NOT_VERIFIED',
        searchName,
      );
      return { status: 'SET_NOT_VERIFIED' };
    }

    const availableCandidates = verifiedCandidates.filter(
      ({ product: candidateProduct }) =>
        candidateProduct.addable && candidateProduct.availableQuantity > 0,
    );

    if (!availableCandidates.length) {
      return { status: 'INSUFFICIENT_STOCK', stock: 0 };
    }

    const matched = [...availableCandidates].sort((a, b) => {
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
    'www.manasource.net',
    product.availableQuantity,
  );

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
