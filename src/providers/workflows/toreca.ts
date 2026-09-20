import type { Page } from 'playwright';
import { COMMIT, MAX_PRICE_YEN } from '../../config.ts';
import { buildJapaneseSearchName, numbersEqual } from '../../cards.ts';
import {
  cacheProduct,
  cacheProductAvailability,
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
  searchToreca,
} from '../toreca.ts';
import {
  buildProviderSearchName,
  findMatchingCartEntry,
  matchProviderProduct,
  type ProviderCartEntry,
} from '../matching.ts';

const TORECA_HOSTNAME = 'torecacamp-pokemon.com';
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
  } = {},
): Promise<TorecaCardResult> {
  const commit = options.commit ?? COMMIT;
  const existing = findMatchingCartEntry(card, options.cartEntries ?? []);
  if (existing && existing.quantity >= card.quantity) {
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
  if (cachedResolution) return { status: cachedResolution.status };

  const japanese = buildJapaneseSearchName(card.cardmarketName);
  const searchName =
    getCachedProductSearchName(cacheEntry) ?? japanese.searchName;
  if (!searchName) return { status: 'NAME_NOT_RESOLVED' };

  let product = cachedUrl ? await inspectTorecaProduct(page, cachedUrl) : null;
  if (product && !product.hasStateA) {
    return { status: 'INSUFFICIENT_STOCK', stock: 0 };
  }
  if (
    product &&
    (product.isGraded ||
      isTorecaGradedProduct(product.productName) ||
      matchProviderProduct(card, product).kind === 'none')
  )
    product = null;

  if (!product) {
    const query = buildProviderSearchName(searchName, card);
    options.onProgress?.('Toreca: Searching products');
    const candidates = (await searchToreca(page, query)).filter(
      (candidate) =>
        numbersEqual(candidate.collectorNumber, card.number) &&
        !isTorecaGradedProduct(candidate.productName),
    );
    if (!candidates.length) {
      await cacheProductResolution(
        card,
        TORECA_HOSTNAME,
        'NO_NUMBER_MATCH',
        query,
      );
      return { status: 'NO_NUMBER_MATCH' };
    }
    const inspected = await inspectAllCandidates(
      candidates,
      async (candidate, index, total) => {
        options.onProgress?.(
          `Toreca: Checking candidate ${index + 1}/${total}`,
        );
        return inspectTorecaProduct(page, candidate.url);
      },
    );
    const matches = inspected
      .map(({ product: candidate }) => candidate)
      .filter(
        (candidate) =>
          !candidate.isGraded &&
          !isTorecaGradedProduct(candidate.productName) &&
          matchProviderProduct(card, candidate).kind !== 'none',
      );
    const available = matches.filter(
      (candidate) => candidate.addable && (candidate.stock ?? 0) > 0,
    );
    if (!available.length)
      return {
        status: matches.length ? 'INSUFFICIENT_STOCK' : 'NO_EXACT_MATCH',
        stock: 0,
      };
    product = [...available].sort(
      (a, b) =>
        (a.price ?? Number.POSITIVE_INFINITY) -
        (b.price ?? Number.POSITIVE_INFINITY),
    )[0];
    await cacheProduct(card, product, query);
  }

  const productId = product.externalId;
  if (!productId || !product.stateAVariantId)
    return { status: 'PRODUCT_ID_NOT_FOUND' };
  const currentQuantity = cartQuantities.get(productId) ?? 0;
  const requested = card.quantity - currentQuantity;
  if (requested <= 0) return { status: 'ALREADY_IN_CART', productId };
  const stock = product.stock ?? 0;
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
