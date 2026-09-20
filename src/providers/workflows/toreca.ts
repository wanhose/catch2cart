import type { Page } from 'playwright';
import { COMMIT, MAX_PRICE_YEN } from '../../config.ts';
import { buildJapaneseSearchName, numbersEqual } from '../../cards.ts';
import {
  cacheProduct,
  cacheProductAvailability,
  cacheProductOffers,
  cacheProductResolution,
  getCachedProductEntry,
  getCachedProductResolution,
  getCachedProductSearchName,
  getCachedProductUrlsForProvider,
  getProductCacheKey,
} from '../../product-cache.ts';
import { inspectAllCandidates } from '../candidates.ts';
import {
  addTorecaToCart,
  inspectTorecaProduct,
  isTorecaGradedProduct,
  isTorecaMetalCardProduct,
  searchToreca,
} from '../toreca.ts';
import {
  buildProviderSearchQueries,
  findMatchingCartEntry,
  matchProviderProduct,
  type ProviderCartEntry,
} from '../matching.ts';
import { getProviderHostname } from '../registry.ts';

const TORECA_HOSTNAME = getProviderHostname('toreca');
export type TorecaCartQuantities = Map<string, number>;

interface TorecaCard {
  quantity: number;
  cardmarketName: string;
  set: string;
  number: string;
}

export interface TorecaCardResult {
  status: string;
  productId?: string;
  price?: number | null;
  stock?: number | null;
  missingQuantity?: number;
}

function hasExplicitTorecaSetCode(card: TorecaCard, product) {
  return Boolean(
    product.setCode &&
    product.setCode.replace(/[^a-z0-9]/gi, '').toLowerCase() ===
      card.set.replace(/[^a-z0-9]/gi, '').toLowerCase(),
  );
}

export async function processTorecaCard(
  page: Page,
  card: TorecaCard,
  cartQuantities: TorecaCartQuantities,
  options: {
    commit?: boolean;
    cartEntries?: ProviderCartEntry[];
    // eslint-disable-next-line no-unused-vars
    onOffer?: (offer: {
      provider: 'toreca';
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
): Promise<TorecaCardResult> {
  const commit = options.commit ?? COMMIT;
  const existing = findMatchingCartEntry(card, options.cartEntries ?? []);
  if (existing && existing.quantity >= card.quantity) {
    await options.onCandidatesReady?.(0);
    return { status: 'ALREADY_IN_CART', productId: existing.productId };
  }

  const cacheEntry = getCachedProductEntry(getProductCacheKey(card));
  const cachedUrl = getCachedProductUrlsForProvider(
    cacheEntry,
    TORECA_HOSTNAME,
  )[0];
  const cachedResolution = cachedUrl
    ? null
    : getCachedProductResolution(cacheEntry, TORECA_HOSTNAME);
  if (cachedResolution) {
    await options.onCandidatesReady?.(0);
    return { status: cachedResolution.status };
  }

  const japanese = buildJapaneseSearchName(card.cardmarketName);
  const searchName =
    getCachedProductSearchName(cacheEntry) ?? japanese.searchName;
  if (!searchName) {
    await options.onCandidatesReady?.(0);
    return { status: 'NAME_NOT_RESOLVED' };
  }

  let product = cachedUrl ? await inspectTorecaProduct(page, cachedUrl) : null;
  let candidatesWereInspected = false;
  if (
    product &&
    (isTorecaMetalCardProduct(product.productName) ||
      product.isGraded ||
      isTorecaGradedProduct(product.productName) ||
      matchProviderProduct(card, product).kind === 'none')
  )
    product = null;
  if (product && !product.hasStateA) {
    return { status: 'INSUFFICIENT_STOCK', stock: 0 };
  }

  if (!product) {
    const queries = buildProviderSearchQueries(searchName, card);
    if (!queries.length) {
      await options.onCandidatesReady?.(0);
      return { status: 'SET_METADATA_NOT_FOUND' };
    }

    options.onProgress?.('Toreca: Searching products');
    let query = queries[0];
    let candidates = [];
    for (const candidateQuery of queries) {
      query = candidateQuery;
      candidates = (await searchToreca(page, candidateQuery)).filter(
        (candidate) =>
          numbersEqual(candidate.collectorNumber, card.number) &&
          !isTorecaGradedProduct(candidate.productName),
      );
      if (candidates.length) break;
    }
    if (!candidates.length) {
      await options.onCandidatesReady?.(0);
      await cacheProductResolution(
        card,
        TORECA_HOSTNAME,
        'NO_NUMBER_MATCH',
        query,
      );
      return { status: 'NO_NUMBER_MATCH' };
    }
    await options.onCandidatesReady?.(candidates.length);
    candidatesWereInspected = true;
    const inspected = await inspectAllCandidates(
      candidates,
      async (candidate, index, total) => {
        options.onCandidateProgress?.(index + 1, total);
        return inspectTorecaProduct(page, candidate.url);
      },
    );
    const matches = inspected
      .map(({ product: candidate }) => candidate)
      .filter(
        (candidate) =>
          !candidate.isGraded &&
          !isTorecaMetalCardProduct(candidate.productName) &&
          !isTorecaGradedProduct(candidate.productName) &&
          matchProviderProduct(card, candidate).kind !== 'none',
      );
    const available = matches.filter(
      (candidate) => candidate.addable && (candidate.stock ?? 0) > 0,
    );
    await cacheProductOffers(
      card,
      TORECA_HOSTNAME,
      matches.map((candidate) => ({
        url: candidate.url,
        price: candidate.price,
        stock: candidate.stock,
        available: candidate.addable && (candidate.stock ?? 0) > 0,
      })),
    );
    if (!available.length)
      return {
        status: matches.length ? 'INSUFFICIENT_STOCK' : 'NO_EXACT_MATCH',
        stock: 0,
      };
    product = [...available].sort((a, b) => {
      const setCodePriority =
        Number(hasExplicitTorecaSetCode(card, b)) -
        Number(hasExplicitTorecaSetCode(card, a));

      if (setCodePriority !== 0) return setCodePriority;

      return (
        (a.price ?? Number.POSITIVE_INFINITY) -
        (b.price ?? Number.POSITIVE_INFINITY)
      );
    })[0];
    await cacheProduct(card, product, query);
  }

  if (product && !candidatesWereInspected) {
    await options.onCandidatesReady?.(0);
  }

  const productId = product.externalId;
  if (!productId || !product.stateAVariantId)
    return { status: 'PRODUCT_ID_NOT_FOUND' };
  const currentQuantity = cartQuantities.get(productId) ?? 0;
  const requested = card.quantity - currentQuantity;
  if (requested <= 0) return { status: 'ALREADY_IN_CART', productId };
  const stock = product.stock ?? 0;
  await cacheProductOffers(card, TORECA_HOSTNAME, [
    {
      url: product.url,
      price: product.price,
      stock: product.stock,
      available: product.addable && stock > 0,
    },
  ]);
  await cacheProductAvailability(card, TORECA_HOSTNAME, stock);
  if (!product.addable || stock <= 0)
    return { status: 'INSUFFICIENT_STOCK', productId, stock };
  if (
    MAX_PRICE_YEN !== null &&
    (product.price === null || product.price > MAX_PRICE_YEN)
  ) {
    return { status: 'PRICE_LIMIT', productId, price: product.price, stock };
  }

  const quantity = Math.min(requested, stock);
  const missingQuantity = requested - quantity;
  options.onOffer?.({
    provider: 'toreca',
    price: product.price,
    stock,
    available: true,
  });
  if (!commit)
    return {
      status: missingQuantity ? 'DRY_RUN_PARTIAL_STOCK' : 'DRY_RUN_OK',
      productId,
      price: product.price,
      stock,
      missingQuantity,
    };
  await addTorecaToCart(page, quantity, product.stateAVariantId);
  cartQuantities.set(productId, currentQuantity + quantity);
  return {
    status: missingQuantity ? 'ADDED_TO_CART_PARTIAL_STOCK' : 'ADDED_TO_CART',
    productId,
    price: product.price,
    stock,
    missingQuantity,
  };
}

export { TORECA_HOSTNAME };
