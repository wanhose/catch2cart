import {
  COMMIT,
  MAX_PRICE_YEN,
  NAVIGATION_TIMEOUT_MS,
  PRODUCT_CACHE_FILE,
  USE_PRODUCT_CACHE,
} from '../../config.ts';
import { buildJapaneseSearchName, getDorasutaProductId } from '../../cards.ts';
import {
  formatDashboardStatus,
  outputLog,
  updateDashboard,
} from '../../output.ts';
import { inspectAllCandidates } from '../candidates.ts';
import {
  buildProviderSearchName,
  findMatchingCartEntry,
  type ProviderCartEntry,
} from '../matching.ts';
import type { ProviderOffer } from '../types.ts';
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
import { gotoAndWait } from '../../browser.ts';
import {
  addToCartAndWait,
  chooseCondition,
  findConditionOptions,
  filterCandidatesByNumber,
  inspectProduct,
  isCompatibleCachedProduct,
  isExactMatch,
  isLastResortNumberAndTotalMatch,
  searchDorasuta,
  setQuantity,
} from '../dorasuta.ts';

/** Resolve one wishlist card and optionally add only its missing quantity. */
export async function processDorasutaCard(
  page,
  card,
  index,
  total,
  cartQuantities,
  options: {
    commit?: boolean;
    cartEntries?: ProviderCartEntry[];
    // eslint-disable-next-line no-unused-vars
    onOffer?: (offer: ProviderOffer) => void;
  } = {},
) {
  const commit = options.commit ?? COMMIT;
  updateDashboard({
    current: index + 1,
    total,
    card: `${card.cardmarketName} (${card.set} ${card.number})`,
    phase: 'Resolving product',
    status: 'In progress',
  });

  outputLog('');
  outputLog(
    `[${index + 1}/${total}] ` +
      `${card.quantity} × ` +
      `${card.cardmarketName} ` +
      `(${card.set} ${card.number})`,
  );

  const cartEntry = findMatchingCartEntry(card, options.cartEntries ?? []);
  if (cartEntry && cartEntry.quantity >= card.quantity) {
    return 'ALREADY_IN_CART';
  }

  const cacheKey = getProductCacheKey(card);

  const cachedEntry = USE_PRODUCT_CACHE
    ? getCachedProductEntry(cacheKey)
    : undefined;

  let product = null;
  let searchNameForCache = null;

  const cachedUrl =
    getCachedProductUrlsForProvider(cachedEntry, 'dorasuta.jp')[0] ?? null;
  const cachedResolution = cachedUrl
    ? null
    : getCachedProductResolution(cachedEntry, 'dorasuta.jp');

  if (cachedResolution) {
    outputLog(
      '  SKIP: cached search result is still fresh (' +
        formatDashboardStatus(cachedResolution.status) +
        '); live search skipped.',
    );

    return cachedResolution.status;
  }

  if (cachedUrl) {
    outputLog(`  Cached Dorasuta URL: ${cachedUrl}`);

    const cachedProductId = getDorasutaProductId(cachedUrl);
    const cachedCartQuantity = cachedProductId
      ? cartQuantities.get(cachedProductId)
      : undefined;
    const cachedAvailability = getCachedProductAvailability(
      cachedEntry,
      'dorasuta.jp',
    );

    if (
      cachedProductId &&
      cachedCartQuantity !== null &&
      cachedCartQuantity !== undefined &&
      cachedCartQuantity >= card.quantity
    ) {
      outputLog(
        `  SKIP: already in cart (${cachedCartQuantity}/${card.quantity}); product page check skipped.`,
      );

      return 'ALREADY_IN_CART';
    }

    if (cachedProductId && cachedAvailability?.availableQuantity === 0) {
      outputLog(
        '  SKIP: cached stock says this product is unavailable; ' +
          'product page check skipped.',
      );

      return 'INSUFFICIENT_STOCK';
    }

    const cachedProduct = await inspectProduct(page, cachedUrl);

    outputLog(
      `    ${cachedProduct.productName} | ` +
        `set=${cachedProduct.setCode ?? '?'} | ` +
        `number=${cachedProduct.collectorNumber ?? '?'}`,
    );

    const exactCachedMatch = isExactMatch(card, cachedProduct);

    if (exactCachedMatch || isCompatibleCachedProduct(card, cachedProduct)) {
      product = cachedProduct;
      outputLog(
        exactCachedMatch
          ? '  Exact match loaded from product cache.'
          : '  Cached URL accepted; product metadata is incomplete but not contradictory.',
      );
    } else {
      outputLog(
        '  Cached URL did not match set + collector number; searching again.',
      );
    }
  }

  if (!product) {
    const japanese = buildJapaneseSearchName(card.cardmarketName);
    const cachedSearchName = getCachedProductSearchName(cachedEntry);
    const searchName = cachedSearchName ?? japanese.searchName;

    if (!searchName) {
      outputLog(
        `  SKIP: Japanese search name could not be resolved ` +
          `(${japanese.strategy}). Add the product URL manually to ` +
          `${PRODUCT_CACHE_FILE} under key "${cacheKey}".`,
      );

      return 'NAME_NOT_RESOLVED';
    }

    if (japanese.species) {
      outputLog(
        `  Pokémon: ` +
          `${japanese.species} -> ` +
          `${japanese.japaneseSpecies}`,
      );
    } else {
      outputLog(`  Local name: ${searchName}`);
    }

    searchNameForCache = buildProviderSearchName(searchName, card);
    outputLog(`  Search: ${searchNameForCache}`);

    updateDashboard({
      phase: `Searching Dorasuta for ${searchNameForCache}`,
    });

    const candidates = await searchDorasuta(page, searchNameForCache);

    outputLog(`  Results: ${candidates.length}`);

    updateDashboard({
      phase: `Checking ${candidates.length} search result(s)`,
    });

    const numberedCandidates = filterCandidatesByNumber(
      candidates,
      card.number,
    );

    outputLog(
      `  Number ${card.number}: ` + `${numberedCandidates.length} candidate(s)`,
    );

    if (!numberedCandidates.length) {
      outputLog('  SKIP: collector number not found in search results.');
      await cacheProductResolution(
        card,
        'dorasuta.jp',
        'NO_NUMBER_MATCH',
        searchNameForCache,
      );

      return 'NO_NUMBER_MATCH';
    }

    const inspectedCandidates = await inspectAllCandidates(
      numberedCandidates,
      async (candidate: { href: string }, candidateIndex, candidateTotal) => {
        updateDashboard({
          phase:
            'Dorasuta: Checking candidate ' +
            (candidateIndex + 1) +
            '/' +
            candidateTotal,
        });
        outputLog(
          '  Checking Dorasuta candidate ' +
            (candidateIndex + 1) +
            '/' +
            candidateTotal +
            ': ' +
            candidate.href,
        );
        return inspectProduct(page, candidate.href);
      },
    );
    const exactMatches = [];

    for (const { product: candidateProduct } of inspectedCandidates) {
      outputLog(
        `    ${candidateProduct.productName} | ` +
          `set=${candidateProduct.setCode ?? '?'} | ` +
          `number=${candidateProduct.collectorNumber ?? '?'}`,
      );

      if (isExactMatch(card, candidateProduct)) {
        exactMatches.push(candidateProduct);
      } else if (
        isLastResortNumberAndTotalMatch(
          card,
          candidateProduct,
          numberedCandidates.length,
        )
      ) {
        outputLog(
          '    LAST RESORT WARNING: accepted unique number/total match; set metadata is missing.',
        );

        exactMatches.push(candidateProduct);
      }
    }

    if (!exactMatches.length) {
      outputLog('  SKIP: set + collector number did not match.');
      await cacheProductResolution(
        card,
        'dorasuta.jp',
        'NO_EXACT_MATCH',
        searchNameForCache,
      );

      return 'NO_EXACT_MATCH';
    }

    if (exactMatches.length > 1) {
      const availableMatches = [];

      for (const candidateProduct of exactMatches) {
        await gotoAndWait(page, candidateProduct.url, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
        const conditions = await findConditionOptions(page);
        const eligibleConditions =
          MAX_PRICE_YEN === null
            ? conditions
            : conditions.filter(
                (item) => item.price !== null && item.price <= MAX_PRICE_YEN,
              );
        const chosen = chooseCondition(eligibleConditions, card.quantity);

        if (chosen) {
          availableMatches.push({ candidateProduct, chosen });
        }
      }

      if (!availableMatches.length) {
        outputLog(
          '  SKIP: all exact product matches are sold out or have no acceptable A condition.',
        );
        return 'INSUFFICIENT_STOCK';
      }

      availableMatches.sort((a, b) => {
        if (a.chosen.price === null && b.chosen.price === null) return 0;
        if (a.chosen.price === null) return 1;
        if (b.chosen.price === null) return -1;
        return a.chosen.price - b.chosen.price;
      });
      exactMatches.splice(
        0,
        exactMatches.length,
        availableMatches[0].candidateProduct,
      );
    }

    product = exactMatches[0];

    await cacheProduct(card, product, searchNameForCache);
  }

  const productId = getDorasutaProductId(product.url);

  if (!productId) {
    outputLog('  SKIP: product pid could not be determined safely.');

    return 'PRODUCT_ID_NOT_FOUND';
  }

  const inCart = cartQuantities.get(productId);

  updateDashboard({
    phase: 'Checking current cart',
  });

  if (inCart === null) {
    outputLog(
      '  SKIP: product is in the cart but its quantity could not be read safely.',
    );

    return 'CART_QUANTITY_UNKNOWN';
  }

  const currentCartQuantity = inCart ?? 0;

  const quantityToAdd = card.quantity - currentCartQuantity;

  if (quantityToAdd <= 0) {
    outputLog(
      `  SKIP: already in cart (${currentCartQuantity}/${card.quantity}).`,
    );

    return 'ALREADY_IN_CART';
  }

  if (currentCartQuantity > 0) {
    outputLog(
      `  Cart has ${currentCartQuantity}; adding only ${quantityToAdd} more.`,
    );
  }

  await gotoAndWait(page, product.url, {
    waitUntil: 'domcontentloaded',

    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const conditions = await findConditionOptions(page);
  const verifiedStock = conditions.reduce((maximum, item) => {
    if (!item.canAdd || !Number.isInteger(item.stock) || item.stock <= 0) {
      return maximum;
    }

    return Math.max(maximum, item.stock);
  }, 0);

  await cacheProductAvailability(card, 'dorasuta.jp', verifiedStock);

  if (conditions.length) {
    for (const option of conditions) {
      outputLog(
        `  Offer: ${option.condition} | ` +
          `${option.price ?? '?'}円 | ` +
          `stock=${option.stock ?? '?'} | ` +
          `cart=${option.canAdd ? 'yes' : 'no'}`,
      );
    }
  }

  const conditionsWithinPriceLimit =
    MAX_PRICE_YEN === null
      ? conditions
      : conditions.filter(
          (item) => item.price !== null && item.price <= MAX_PRICE_YEN,
        );

  if (MAX_PRICE_YEN !== null && !conditionsWithinPriceLimit.length) {
    outputLog(`  SKIP: no acceptable offer is at or below ${MAX_PRICE_YEN}円.`);

    return 'PRICE_LIMIT';
  }

  const chosen = chooseCondition(conditionsWithinPriceLimit, quantityToAdd);

  if (!chosen) {
    const hasAcceptableCondition = conditions.some(
      (item) => item.condition === '状態A特価' || item.condition === '状態A',
    );

    if (hasAcceptableCondition) {
      outputLog(
        `  SKIP: no acceptable offer has verified stock >= ${quantityToAdd}.`,
      );

      return 'INSUFFICIENT_STOCK';
    }

    outputLog('  SKIP: neither 状態A特価 nor 状態A is available.');

    return 'NO_ACCEPTABLE_CONDITION';
  }

  const quantityToAddNow = Math.min(quantityToAdd, chosen.stock);

  const missingQuantity = quantityToAdd - quantityToAddNow;

  if (missingQuantity > 0) {
    updateDashboard({
      status: `Partial stock · ${missingQuantity} missing`,
    });

    outputLog(
      `  PARTIAL STOCK: adding ${quantityToAddNow}; ` +
        `${missingQuantity} card(s) still missing from Dorasuta stock.`,
    );
  }

  outputLog(`  Match: ${product.productName}`);

  outputLog(
    `  Chosen: ${chosen.condition} | ` +
      `${chosen.price ?? '?'}円 | ` +
      `stock=${chosen.stock}`,
  );

  options.onOffer?.({
    provider: 'dorasuta',
    price: chosen.price,
    stock: chosen.stock,
    available: chosen.stock > 0,
  });

  if (!commit) {
    outputLog(`  DRY RUN: would add ${quantityToAddNow} to cart.`);

    return missingQuantity > 0 ? 'DRY_RUN_PARTIAL_STOCK' : 'DRY_RUN_OK';
  }

  updateDashboard({
    phase: `Adding ${quantityToAddNow} card(s) to cart`,
  });

  await setQuantity(chosen.quantitySelect, quantityToAddNow);

  const cartCount = await addToCartAndWait(page, chosen.addButton);

  outputLog(`  ADDED TO CART | cart=${cartCount}`);

  cartQuantities.set(productId, currentCartQuantity + quantityToAddNow);

  return missingQuantity > 0 ? 'ADDED_TO_CART_PARTIAL_STOCK' : 'ADDED_TO_CART';
}
