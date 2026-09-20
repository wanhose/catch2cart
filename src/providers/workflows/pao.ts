import type { Page } from 'playwright';
import { COMMIT, MAX_PRICE_YEN } from '../../config.ts';
import { buildJapaneseSearchName, numbersEqual } from '../../cards.ts';
import { gotoAndWait } from '../../browser.ts';
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
import { inspectAllCandidates } from '../candidates.ts';
import { addPaoToCart, inspectPaoProduct, searchPao } from '../pao.ts';
import {
  buildProviderSearchName,
  findMatchingCartEntry,
  matchProviderProduct,
  type ProviderCartEntry,
} from '../matching.ts';

const PAO_HOSTNAME = 'pao-onlineshop.com';

export type PaoCartQuantities = Record<
  string,
  { quantity: number; price: number | null }
>;

export interface PaoCardResult {
  status: string;
  productId?: string;
  price?: number | null;
  stock?: number | null;
  missingQuantity?: number;
}

interface PaoCard {
  quantity: number;
  cardmarketName: string;
  set: string;
  number: string;
}

function getCartQuantity(cartQuantities: PaoCartQuantities, productId: string) {
  return cartQuantities[productId]?.quantity ?? 0;
}

function isMatch(
  card: PaoCard,
  product: Awaited<ReturnType<typeof inspectPaoProduct>>,
) {
  return matchProviderProduct(card, product).kind !== 'none';
}

/** Resolve, verify and optionally add one wishlist card on PAO. */
export async function processPaoCard(
  page: Page,
  card: PaoCard,
  cartQuantities: PaoCartQuantities,
  options: {
    commit?: boolean;
    cartEntries?: ProviderCartEntry[];
    // eslint-disable-next-line no-unused-vars
    onOffer?: (offer: {
      provider: 'pao';
      price: number | null;
      stock: number;
      available: boolean;
    }) => void;
    // eslint-disable-next-line no-unused-vars
    onProgress?: (phase: string) => void;
  } = {},
): Promise<PaoCardResult> {
  const commit = options.commit ?? COMMIT;
  const cartEntry = findMatchingCartEntry(card, options.cartEntries ?? []);

  if (cartEntry && cartEntry.quantity >= card.quantity) {
    return { status: 'ALREADY_IN_CART', productId: cartEntry.productId };
  }

  const cacheEntry = getCachedProductEntry(getProductCacheKey(card));
  const cachedUrl = getCachedProductUrlsForProvider(
    cacheEntry,
    PAO_HOSTNAME,
  )[0];
  const cachedResolution = cachedUrl
    ? null
    : getCachedProductResolution(cacheEntry, PAO_HOSTNAME);

  if (cachedResolution) return { status: cachedResolution.status };

  let product = null;

  if (cachedUrl) {
    const cachedProduct = await inspectPaoProduct(page, cachedUrl);
    if (isMatch(card, cachedProduct)) product = cachedProduct;
  }

  const japanese = buildJapaneseSearchName(card.cardmarketName);
  const cachedSearchName = getCachedProductSearchName(cacheEntry);
  const searchName = cachedSearchName ?? japanese.searchName;

  if (!product && !searchName) {
    return { status: 'NAME_NOT_RESOLVED' };
  }

  if (!product) {
    const query = buildProviderSearchName(searchName, card);
    options.onProgress?.('PAO: Searching products');
    const candidates = await searchPao(page, query);
    const numberedCandidates = candidates.filter((candidate) =>
      numbersEqual(candidate.collectorNumber, card.number),
    );

    if (!numberedCandidates.length) {
      await cacheProductResolution(
        card,
        PAO_HOSTNAME,
        'NO_NUMBER_MATCH',
        query,
      );
      return { status: 'NO_NUMBER_MATCH' };
    }

    const inspected = await inspectAllCandidates(
      numberedCandidates,
      async (candidate, index, total) => {
        options.onProgress?.(`PAO: Checking candidate ${index + 1}/${total}`);
        return inspectPaoProduct(page, candidate.url);
      },
    );
    const matches = inspected
      .map(({ product: candidateProduct }) => candidateProduct)
      .filter((candidateProduct) => isMatch(card, candidateProduct));

    if (!matches.length) {
      await cacheProductResolution(card, PAO_HOSTNAME, 'NO_EXACT_MATCH', query);
      return { status: 'NO_EXACT_MATCH' };
    }

    const availableMatches = matches.filter(
      (candidateProduct) =>
        candidateProduct.addable && (candidateProduct.stock ?? 0) > 0,
    );

    if (!availableMatches.length) {
      return { status: 'INSUFFICIENT_STOCK', stock: 0 };
    }

    product = [...availableMatches].sort((a, b) => {
      if (a.price === null && b.price === null) return 0;
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price;
    })[0];
    await cacheProduct(card, product, query);
  }

  const productId = product.externalId;
  if (!productId) return { status: 'PRODUCT_ID_NOT_FOUND' };

  const cachedAvailability = getCachedProductAvailability(
    cacheEntry,
    PAO_HOSTNAME,
  );
  const currentQuantity = getCartQuantity(cartQuantities, productId);
  const requestedAdditional = card.quantity - currentQuantity;

  if (requestedAdditional <= 0) return { status: 'ALREADY_IN_CART', productId };

  if (cachedAvailability?.availableQuantity === 0) {
    return { status: 'INSUFFICIENT_STOCK', productId, stock: 0 };
  }

  await gotoAndWait(page, product.url, { waitUntil: 'domcontentloaded' });
  const stock = product.stock ?? 0;
  await cacheProductAvailability(card, PAO_HOSTNAME, stock);

  if (!product.addable || stock <= 0) {
    return {
      status: 'INSUFFICIENT_STOCK',
      productId,
      price: product.price,
      stock,
    };
  }

  if (
    MAX_PRICE_YEN !== null &&
    (product.price === null || product.price > MAX_PRICE_YEN)
  ) {
    return { status: 'PRICE_LIMIT', productId, price: product.price, stock };
  }

  const quantityToAdd = Math.min(requestedAdditional, stock);
  const missingQuantity = requestedAdditional - quantityToAdd;
  options.onOffer?.({
    provider: 'pao',
    price: product.price,
    stock,
    available: stock > 0,
  });

  if (!commit) {
    return {
      status: missingQuantity ? 'DRY_RUN_PARTIAL_STOCK' : 'DRY_RUN_OK',
      productId,
      price: product.price,
      stock,
      missingQuantity,
    };
  }

  await addPaoToCart(page, quantityToAdd, productId);
  cartQuantities[productId] = {
    quantity: currentQuantity + quantityToAdd,
    price: product.price,
  };

  return {
    status: missingQuantity ? 'ADDED_TO_CART_PARTIAL_STOCK' : 'ADDED_TO_CART',
    productId,
    price: product.price,
    stock,
    missingQuantity,
  };
}

export { PAO_HOSTNAME };
