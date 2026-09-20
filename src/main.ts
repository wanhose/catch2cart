/**
 * Application workflow.
 *
 * The order is intentional: collect wishlist data, prepare product providers,
 * inspect the existing cart, resolve products, and only then add missing
 * quantities when `--commit` is present. A single sequential loop avoids
 * concurrent browser actions and keeps cart state consistent.
 */

import {
  CARDMARKET_URL,
  BATCH_NUMBER,
  BATCH_SIZE,
  COMMIT,
  CDP_ENDPOINT,
  PROVIDER_STRATEGY,
  PROVIDERS,
  SAMURAI_SWORD_SET_LIST_URL,
} from './config.ts';
import {
  getDashboardState,
  formatDashboardStatus,
  formatSummaryStatus,
  outputLog,
  startDashboard,
  stopDashboard,
  updateDashboard,
} from './output.ts';
import { connectToBrowser, getOrCreatePage } from './browser.ts';
import { buildJapaneseSearchName, validatePokemonDataset } from './cards.ts';
import { collectCardmarketCardsWithCache } from './inputs/cardmarket.ts';
import { loadProductCache } from './product-cache.ts';
import { selectProviderOffers } from './providers/strategy.ts';
import {
  matchProviderProduct,
  type ProviderCartEntry,
} from './providers/matching.ts';
import { PROVIDER_REGISTRY } from './providers/registry.ts';
import type { ProviderOffer } from './providers/types.ts';
import {
  readCartEntries,
  readDorasutaCartTotal,
  readInitialCartCount,
  setInitialCartCount,
} from './providers/dorasuta.ts';
import {
  readManaSourceCartEntries,
  readManaSourceCartTotal,
} from './providers/manasource.ts';
import { processManaSourceCard } from './providers/workflows/manasource.ts';
import { readPaoCartEntries, readPaoCartTotal } from './providers/pao.ts';
import { processPaoCard } from './providers/workflows/pao.ts';
import { processDorasutaCard } from './providers/workflows/dorasuta.ts';
import {
  readTorecaCartEntries,
  readTorecaCartTotal,
} from './providers/toreca.ts';
import { processTorecaCard } from './providers/workflows/toreca.ts';
import { loadSetCache, refreshSetCache } from './set-cache.ts';

let cartQuantities = new Map();
let connectedBrowser = null;

async function closeSetMetadataPages(context) {
  const metadataOrigin = new URL(SAMURAI_SWORD_SET_LIST_URL).origin;

  for (const page of context.pages()) {
    try {
      if (new URL(page.url()).origin === metadataOrigin) {
        await page.close();
      }
    } catch {
      // The page may already have been closed during an interrupted run.
    }
  }
}

/** Select a 1-based batch from the collected cards, or all cards when off. */
function selectBatch(cards) {
  if (!BATCH_SIZE) {
    return cards;
  }

  const start = (BATCH_NUMBER - 1) * BATCH_SIZE;

  return cards.slice(start, start + BATCH_SIZE);
}

/**
 * Local fallback only for cards that do not contain a Pokémon species.
 *
 * Keep this small. Pokémon-owned cards such as:
 *
 *   N's Zoroark ex
 *   Cynthia's Garchomp ex
 *   Team Rocket's Mewtwo ex
 *   Galarian Articuno V
 *   Mega Greninja ex
 *
 * do NOT need entries here because the Pokémon species is extracted
 * directly from their English title.
 */
/** Run the complete wishlist-to-cart workflow. */
async function main() {
  validatePokemonDataset();

  outputLog('');
  outputLog(`Connecting to browser: ${CDP_ENDPOINT}`);

  const { browser, context } = await connectToBrowser();

  connectedBrowser = browser;

  outputLog(`Connected. ${context.pages().length} open tab(s).`);

  outputLog('');
  outputLog(
    `Providers: ${PROVIDERS.join(', ')} · strategy=${PROVIDER_STRATEGY}`,
  );

  const providerAvailability: ProviderOffer[] = PROVIDERS.map((provider) => ({
    provider,
    price: null,
    stock: null,
    available: true,
  }));

  outputLog(
    `Provider strategy: ${PROVIDER_STRATEGY} · ` +
      `${selectProviderOffers(providerAvailability, PROVIDER_STRATEGY).length ? 'offers will be distributed after matching' : 'offers will be compared after matching'}.`,
  );

  outputLog('Preparing Cardmarket...');

  const cardmarketPage = await getOrCreatePage(
    context,
    'cardmarket.com',
    CARDMARKET_URL,
  );

  const { cards: collectedCards, failures } =
    await collectCardmarketCardsWithCache(cardmarketPage);

  const cards = selectBatch(collectedCards);

  outputLog('');
  outputLog(`Cards collected: ${collectedCards.length}`);

  if (BATCH_SIZE) {
    outputLog(
      `Batch ${BATCH_NUMBER}: ${cards.length} card(s) selected ` +
        `(size=${BATCH_SIZE}).`,
    );
  }

  const repeatedWishlistCards = cards.filter(
    (card) => Array.isArray(card.wishlistUrls) && card.wishlistUrls.length > 1,
  );

  if (repeatedWishlistCards.length) {
    outputLog('');
    outputLog(
      `WARNING: ${repeatedWishlistCards.length} card(s) appear in multiple wishlists. ` +
        'Their quantities will be merged using the maximum requested quantity:',
    );

    for (const card of repeatedWishlistCards) {
      outputLog(
        `  ${card.cardmarketName} (${card.set} ${card.number}) · ` +
          `${card.wishlistUrls.length} wishlists · quantity=${card.quantity}`,
      );
    }
  }

  if (failures.length) {
    outputLog(`Cardmarket parse failures: ${failures.length}`);

    for (const failure of failures) {
      outputLog(`  ${failure.amount} ${failure.name}`);
    }
  }

  if (!cards.length) {
    throw new Error('No usable cards were found in Cardmarket Wants.');
  }

  const unresolved = cards.filter((card) => {
    const result = buildJapaneseSearchName(card.cardmarketName);

    return !result.searchName;
  });

  if (unresolved.length) {
    outputLog('');
    outputLog(`Unresolved names: ${unresolved.length}`);

    for (const card of unresolved) {
      outputLog(`  ${card.cardmarketName} ` + `(${card.set} ${card.number})`);
    }
  }

  outputLog('');
  outputLog(
    COMMIT
      ? 'COMMIT MODE: confirmed cards will be added to the cart.'
      : 'DRY RUN MODE: the cart will not be modified.',
  );

  outputLog('');
  outputLog('Loading product and set caches...');

  /**
   * Explicit progress logs here are intentional.
   * If startup stalls, we will know exactly which step did it.
   */
  await loadProductCache();

  const setCacheReady = await loadSetCache();

  if (PROVIDERS.length > 0 && !setCacheReady) {
    outputLog('Refreshing Pokémon set cache for provider validation...');
    await closeSetMetadataPages(context);
    const setCachePage = await context.newPage();

    try {
      await refreshSetCache(setCachePage);
    } finally {
      await setCachePage.close();
      await closeSetMetadataPages(context);
    }
  }

  outputLog('');
  outputLog('Ensuring product-provider tabs are available...');
  const providerPages = new Map();

  for (const provider of Object.values(PROVIDER_REGISTRY)) {
    if (!provider.implemented) {
      continue;
    }

    providerPages.set(
      provider.name,
      await getOrCreatePage(context, provider.hostname, provider.homeUrl),
    );
  }

  let manaSourcePage = null;
  let manaSourceCartQuantities = new Map();
  let manaSourceCartEntries: ProviderCartEntry[] = [];
  let dorasutaPage = null;
  let dorasutaCartEntries: ProviderCartEntry[] = [];
  let paoPage = null;
  let paoCartQuantities = {};
  let paoCartEntries: ProviderCartEntry[] = [];
  let torecaPage = null;
  let torecaCartQuantities = new Map();
  let torecaCartEntries: ProviderCartEntry[] = [];

  if (PROVIDERS.includes('manasource')) {
    outputLog('');
    outputLog('Preparing ManaSource...');

    manaSourcePage = providerPages.get('manasource') ?? null;

    if (!manaSourcePage) {
      throw new Error('ManaSource tab could not be prepared.');
    }

    outputLog('Reading ManaSource cart contents...');
    manaSourceCartEntries = await readManaSourceCartEntries(manaSourcePage);
    manaSourceCartQuantities = new Map(
      manaSourceCartEntries.map((entry) => [entry.productId, entry.quantity]),
    );
    outputLog('ManaSource cart products read: ' + manaSourceCartEntries.length);
  }

  if (!PROVIDERS.includes('dorasuta')) {
    outputLog('Dorasuta is not selected; skipping its cart workflow.');
  } else {
    outputLog('');
    outputLog('Preparing Dorasuta...');

    dorasutaPage = providerPages.get('dorasuta') ?? null;

    if (!dorasutaPage) {
      throw new Error('Dorasuta tab could not be prepared.');
    }

    outputLog('Reading Dorasuta cart contents...');

    const initialCartCount = await readInitialCartCount(dorasutaPage);

    setInitialCartCount(initialCartCount);

    outputLog(`Dorasuta initial cart count: ${initialCartCount ?? 0}`);

    dorasutaCartEntries = await readCartEntries(dorasutaPage);
    cartQuantities = new Map(
      dorasutaCartEntries.map((entry) => [entry.productId, entry.quantity]),
    );

    outputLog(`Dorasuta cart products read: ${cartQuantities.size}`);
  }

  if (PROVIDERS.includes('pao')) {
    outputLog('');
    outputLog('Preparing PAO...');
    paoPage = providerPages.get('pao') ?? null;

    if (!paoPage) {
      throw new Error('PAO tab could not be prepared.');
    }

    outputLog('Reading PAO cart contents...');
    paoCartEntries = await readPaoCartEntries(paoPage);
    paoCartQuantities = Object.fromEntries(
      paoCartEntries.map((entry) => [entry.productId, entry]),
    );
    outputLog('PAO cart products read: ' + paoCartEntries.length);
  }

  if (PROVIDERS.includes('toreca')) {
    outputLog('');
    outputLog('Preparing Toreca...');
    torecaPage = providerPages.get('toreca') ?? null;
    if (!torecaPage) throw new Error('Toreca tab could not be prepared.');
    outputLog('Reading Toreca cart contents...');
    torecaCartEntries = await readTorecaCartEntries(torecaPage);
    torecaCartQuantities = new Map(
      torecaCartEntries.map((entry) => [entry.productId, entry.quantity]),
    );
    outputLog('Toreca cart products read: ' + torecaCartEntries.length);
  }

  const initialCartEntries: ProviderCartEntry[] = [
    ...dorasutaCartEntries,
    ...manaSourceCartEntries,
    ...paoCartEntries,
    ...torecaCartEntries,
  ];
  const isCoveredByAnyCart = (card) =>
    initialCartEntries.some(
      (entry) =>
        entry.quantity >= card.quantity &&
        matchProviderProduct(card, entry).kind !== 'none',
    );

  const globallyCoveredCardIndexes = new Set<number>();
  for (const [index, card] of cards.entries()) {
    if (isCoveredByAnyCart(card)) {
      globallyCoveredCardIndexes.add(index);
    }
  }

  const dashboardProviderCount =
    PROVIDER_STRATEGY === 'cheapest' && PROVIDERS.length > 1
      ? PROVIDERS.length
      : Number(Boolean(dorasutaPage)) +
        Number(Boolean(manaSourcePage)) +
        Number(Boolean(paoPage)) +
        Number(Boolean(torecaPage));
  const firstPendingIndex = cards.findIndex(
    (_, index) => !globallyCoveredCardIndexes.has(index),
  );
  const initialCard =
    firstPendingIndex === -1
      ? 'Completed'
      : cards[firstPendingIndex].cardmarketName +
        ' (' +
        cards[firstPendingIndex].set +
        ' ' +
        cards[firstPendingIndex].number +
        ')';

  startDashboard(cards.length, {
    current: firstPendingIndex === -1 ? cards.length : firstPendingIndex + 1,
    card: initialCard,
    completed: globallyCoveredCardIndexes.size,
    skipped: globallyCoveredCardIndexes.size,
    phase: firstPendingIndex === -1 ? 'Completed' : 'Ready',
    status: firstPendingIndex === -1 ? 'Completed' : 'Waiting',
  });

  const summary: Record<string, number> = {};
  const runErrors = [];
  const notFoundCards = [];
  const stockIssues = [];
  const priceIssues = [];
  const notFoundStatuses = new Set([
    'NAME_NOT_RESOLVED',
    'NO_NUMBER_MATCH',
    'NO_EXACT_MATCH',
    'SET_NOT_VERIFIED',
    'AMBIGUOUS_MATCH',
    'PRODUCT_ID_NOT_FOUND',
    'CART_QUANTITY_UNKNOWN',
  ]);
  const stockStatuses = new Set([
    'INSUFFICIENT_STOCK',
    'NO_ACCEPTABLE_CONDITION',
    'DRY_RUN_PARTIAL_STOCK',
    'ADDED_TO_CART_PARTIAL_STOCK',
  ]);
  const providerRuns: Promise<void>[] = [];

  const describeDashboardError = (error) =>
    String(error?.message ?? error)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

  const reportDashboardError = (message, updates = {}) => {
    const messages = getDashboardState().errorMessages ?? [];

    updateDashboard({
      ...updates,
      errors: getDashboardState().errors + 1,
      errorMessages: [...messages, message].slice(-3),
    });
  };

  const completedProviderCards = cards.map(() => new Map());
  for (const index of globallyCoveredCardIndexes) {
    for (const provider of PROVIDERS) {
      completedProviderCards[index].set(provider, {
        status: 'ALREADY_IN_CART',
        added: false,
        partial: false,
        price: null,
      });
    }
  }
  const blockedProviders = new Set();
  const synchronizeAllProviders =
    PROVIDER_STRATEGY === 'all' && PROVIDERS.length > 1;
  const providerTurnResolvers = cards.map(() => () => {});
  const providerTurnCounts = cards.map(() => 0);
  const providerTurns = cards.map(
    (_, index) =>
      new Promise<void>((resolve) => {
        providerTurnResolvers[index] = resolve;
      }),
  );
  providerTurnResolvers[0]?.();

  const waitForProviderTurn = async (index) => {
    if (synchronizeAllProviders) {
      await providerTurns[index];
    }
  };

  const finishProviderTurn = (index) => {
    if (!synchronizeAllProviders) return;
    providerTurnCounts[index]++;
    if (providerTurnCounts[index] === PROVIDERS.length) {
      providerTurnResolvers[index + 1]?.();
    }
  };

  const recordProviderCard = (
    index,
    provider,
    status,
    added = false,
    partial = false,
    price = null,
  ) => {
    const results = completedProviderCards[index];

    results.set(provider, { status, added, partial, price });

    if (results.size < dashboardProviderCount) {
      return;
    }

    const values = [...results.values()];
    const card = cards[index];
    const hasAdded = values.some((value) => value.added);
    const hasPartial = values.some((value) => value.partial);

    updateDashboard({
      current: index + 1,
      card: card.cardmarketName + ' (' + card.set + ' ' + card.number + ')',
      completed: Math.max(getDashboardState().completed, index + 1),
      added: hasAdded
        ? getDashboardState().added + 1
        : getDashboardState().added,
      partial: hasPartial
        ? getDashboardState().partial + 1
        : getDashboardState().partial,
      skipped: !hasAdded
        ? getDashboardState().skipped + 1
        : getDashboardState().skipped,
      phase: 'Completed',
      status: [...results.entries()]
        .map(([provider, value]) => {
          const label =
            provider === 'manasource'
              ? 'ManaSource'
              : provider === 'pao'
                ? 'PAO'
                : provider === 'toreca'
                  ? 'Toreca'
                  : 'Dorasuta';

          return label + ': ' + formatDashboardStatus(value.status);
        })
        .join(' · '),
    });
  };

  if (
    dorasutaPage &&
    !(PROVIDER_STRATEGY === 'cheapest' && PROVIDERS.length > 1)
  ) {
    providerRuns.push(
      (async () => {
        for (let i = 0; i < cards.length; i++) {
          await waitForProviderTurn(i);
          if (globallyCoveredCardIndexes.has(i)) {
            finishProviderTurn(i);
            continue;
          }
          if (blockedProviders.has('dorasuta')) {
            recordProviderCard(i, 'dorasuta', 'PROVIDER_BLOCKED');
            finishProviderTurn(i);
            continue;
          }

          try {
            let dorasutaPrice = null;
            const status = await processDorasutaCard(
              dorasutaPage,
              cards[i],
              i,
              cards.length,
              cartQuantities,
              {
                cartEntries: dorasutaCartEntries,
                onOffer: (offer) => {
                  dorasutaPrice = offer.price;
                },
              },
            );

            summary[status] = (summary[status] ?? 0) + 1;

            const cardDescription =
              `${cards[i].quantity} × ${cards[i].cardmarketName} ` +
              `(${cards[i].set} ${cards[i].number})`;

            if (notFoundStatuses.has(status)) {
              notFoundCards.push({
                card: cardDescription,
                status,
              });
            }

            if (stockStatuses.has(status)) {
              stockIssues.push({
                card: cardDescription,
                status,
              });
            }

            if (status === 'PRICE_LIMIT') {
              priceIssues.push({
                card: cardDescription,
                status,
              });
            }

            const isPartial = status.includes('PARTIAL');

            const isAdded =
              status === 'ADDED_TO_CART' ||
              status === 'ADDED_TO_CART_PARTIAL_STOCK' ||
              status === 'DRY_RUN_OK' ||
              status === 'DRY_RUN_PARTIAL_STOCK';

            recordProviderCard(
              i,
              'dorasuta',
              status,
              isAdded,
              isPartial,
              dorasutaPrice,
            );
          } catch (error) {
            if (error.code === 'CART_FULL') {
              blockedProviders.add('dorasuta');

              runErrors.push(`[${i + 1}/${cards.length}] ${error.message}`);

              updateDashboard({
                status: 'Dorasuta: CART FULL · provider stopped',
                errors: getDashboardState().errors + 1,
                phase: 'Dorasuta stopped; continuing with other providers',
              });

              recordProviderCard(i, 'dorasuta', 'CART_FULL');
              continue;
            }

            if (error.code === 'DORASUTA_IP_BLOCKED') {
              blockedProviders.add('dorasuta');

              runErrors.push(`[${i + 1}/${cards.length}] ${error.message}`);

              reportDashboardError(
                `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
                {
                  status: 'Dorasuta: Cloudflare 1006 · provider stopped',
                  phase: 'Stopped: IP blocked',
                },
              );

              break;
            }

            runErrors.push(`[${i + 1}/${cards.length}] ${error.message}`);

            summary.ERROR = (summary.ERROR ?? 0) + 1;

            reportDashboardError(
              `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
              {
                status:
                  'Dorasuta: ' +
                  formatDashboardStatus('ERROR') +
                  ' · ' +
                  describeDashboardError(error),
                phase:
                  dashboardProviderCount > 1
                    ? 'Waiting for remaining provider'
                    : 'Failed',
              },
            );
            recordProviderCard(i, 'dorasuta', 'ERROR');
          } finally {
            finishProviderTurn(i);
          }
        }
      })(),
    );
  }

  if (
    manaSourcePage &&
    !(PROVIDER_STRATEGY === 'cheapest' && PROVIDERS.length > 1)
  ) {
    outputLog('');
    providerRuns.push(
      (async () => {
        for (let i = 0; i < cards.length; i++) {
          await waitForProviderTurn(i);
          if (globallyCoveredCardIndexes.has(i)) {
            finishProviderTurn(i);
            continue;
          }
          try {
            const result = await processManaSourceCard(
              manaSourcePage,
              cards[i],
              manaSourceCartQuantities,
              {
                cartEntries: manaSourceCartEntries,
                onProgress: (phase) => updateDashboard({ phase }),
              },
            );
            const resultKey = 'MANASOURCE_' + result.status;

            summary[resultKey] = (summary[resultKey] ?? 0) + 1;

            outputLog(
              '[ManaSource ' +
                (i + 1) +
                '/' +
                cards.length +
                '] ' +
                cards[i].cardmarketName +
                ' (' +
                cards[i].set +
                ' ' +
                cards[i].number +
                ') · ' +
                formatDashboardStatus(result.status),
            );

            if (result.status.includes('PARTIAL')) {
              stockIssues.push({
                card:
                  cards[i].quantity +
                  ' × ' +
                  cards[i].cardmarketName +
                  ' (' +
                  cards[i].set +
                  ' ' +
                  cards[i].number +
                  ')',
                status: resultKey,
              });
            }

            if (result.status === 'PRICE_LIMIT') {
              priceIssues.push({
                card:
                  cards[i].quantity +
                  ' × ' +
                  cards[i].cardmarketName +
                  ' (' +
                  cards[i].set +
                  ' ' +
                  cards[i].number +
                  ')',
                status: resultKey,
              });
            }
            recordProviderCard(
              i,
              'manasource',
              result.status,
              result.status === 'ADDED_TO_CART' ||
                result.status === 'ADDED_TO_CART_PARTIAL_STOCK' ||
                result.status === 'DRY_RUN_OK' ||
                result.status === 'DRY_RUN_PARTIAL_STOCK',
              result.status.includes('PARTIAL'),
              result.price,
            );
          } catch (error) {
            const status = 'MANASOURCE_ERROR';

            summary[status] = (summary[status] ?? 0) + 1;
            runErrors.push(
              '[ManaSource ' +
                (i + 1) +
                '/' +
                cards.length +
                '] ' +
                error.message,
            );
            reportDashboardError(
              `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
              {
                status:
                  'ManaSource: ' +
                  formatDashboardStatus('ERROR') +
                  ' · ' +
                  describeDashboardError(error),
                phase:
                  dashboardProviderCount > 1
                    ? 'Waiting for remaining provider'
                    : 'Failed',
              },
            );
            recordProviderCard(i, 'manasource', status);
          } finally {
            finishProviderTurn(i);
          }
        }
      })(),
    );
  }

  if (paoPage && !(PROVIDER_STRATEGY === 'cheapest' && PROVIDERS.length > 1)) {
    outputLog('');
    providerRuns.push(
      (async () => {
        for (let i = 0; i < cards.length; i++) {
          await waitForProviderTurn(i);
          if (globallyCoveredCardIndexes.has(i)) {
            finishProviderTurn(i);
            continue;
          }
          try {
            const result = await processPaoCard(
              paoPage,
              cards[i],
              paoCartQuantities,
              {
                cartEntries: paoCartEntries,
                onProgress: (phase) => updateDashboard({ phase }),
              },
            );
            const resultKey = 'PAO_' + result.status;
            summary[resultKey] = (summary[resultKey] ?? 0) + 1;

            if (result.status.includes('PARTIAL')) {
              stockIssues.push({
                card:
                  cards[i].quantity +
                  ' × ' +
                  cards[i].cardmarketName +
                  ' (' +
                  cards[i].set +
                  ' ' +
                  cards[i].number +
                  ')',
                status: resultKey,
              });
            }
            if (result.status === 'PRICE_LIMIT') {
              priceIssues.push({
                card:
                  cards[i].quantity +
                  ' × ' +
                  cards[i].cardmarketName +
                  ' (' +
                  cards[i].set +
                  ' ' +
                  cards[i].number +
                  ')',
                status: resultKey,
              });
            }
            const covered = [
              'ADDED_TO_CART',
              'ADDED_TO_CART_PARTIAL_STOCK',
              'DRY_RUN_OK',
              'DRY_RUN_PARTIAL_STOCK',
            ].includes(result.status);
            recordProviderCard(
              i,
              'pao',
              result.status,
              covered,
              result.status.includes('PARTIAL'),
              result.price,
            );
          } catch (error) {
            const status = 'PAO_ERROR';
            summary[status] = (summary[status] ?? 0) + 1;
            runErrors.push(
              '[PAO ' + (i + 1) + '/' + cards.length + '] ' + error.message,
            );
            reportDashboardError(
              `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
              {
                status:
                  'PAO: ' +
                  formatDashboardStatus('ERROR') +
                  ' · ' +
                  describeDashboardError(error),
                phase:
                  dashboardProviderCount > 1
                    ? 'Waiting for remaining provider'
                    : 'Failed',
              },
            );
            recordProviderCard(i, 'pao', status);
          } finally {
            finishProviderTurn(i);
          }
        }
      })(),
    );
  }

  if (
    torecaPage &&
    !(PROVIDER_STRATEGY === 'cheapest' && PROVIDERS.length > 1)
  ) {
    outputLog('');
    providerRuns.push(
      (async () => {
        for (let i = 0; i < cards.length; i++) {
          await waitForProviderTurn(i);
          if (globallyCoveredCardIndexes.has(i)) {
            finishProviderTurn(i);
            continue;
          }
          try {
            const result = await processTorecaCard(
              torecaPage,
              cards[i],
              torecaCartQuantities,
              {
                cartEntries: torecaCartEntries,
                onProgress: (phase) => updateDashboard({ phase }),
              },
            );
            const resultKey = 'TORECA_' + result.status;
            summary[resultKey] = (summary[resultKey] ?? 0) + 1;
            const covered = [
              'ADDED_TO_CART',
              'ADDED_TO_CART_PARTIAL_STOCK',
              'DRY_RUN_OK',
              'DRY_RUN_PARTIAL_STOCK',
            ].includes(result.status);
            recordProviderCard(
              i,
              'toreca',
              result.status,
              covered,
              result.status.includes('PARTIAL'),
              result.price,
            );
          } catch (error) {
            const status = 'TORECA_ERROR';
            summary[status] = (summary[status] ?? 0) + 1;
            runErrors.push(
              '[Toreca ' + (i + 1) + '/' + cards.length + '] ' + error.message,
            );
            reportDashboardError(describeDashboardError(error), {
              status:
                'Toreca: ' +
                formatDashboardStatus('ERROR') +
                ' · ' +
                describeDashboardError(error),
              phase:
                dashboardProviderCount > 1
                  ? 'Waiting for remaining provider'
                  : 'Failed',
            });
            recordProviderCard(i, 'toreca', status);
          } finally {
            finishProviderTurn(i);
          }
        }
      })(),
    );
  }

  await Promise.all(providerRuns);

  if (PROVIDER_STRATEGY === 'cheapest' && PROVIDERS.length > 1) {
    outputLog('');
    outputLog('Comparing provider offers before adding cards...');

    for (let i = 0; i < cards.length; i++) {
      let dorasutaOffer: ProviderOffer | null = null;
      let manaSourceOffer: ProviderOffer | null = null;
      let paoOffer: ProviderOffer | null = null;
      let torecaOffer: ProviderOffer | null = null;
      let dorasutaPreflightStatus: string | null = blockedProviders.has(
        'dorasuta',
      )
        ? 'PROVIDER_BLOCKED'
        : null;
      let manaSourcePreflightStatus: string | null = null;
      let paoPreflightStatus: string | null = null;
      let torecaPreflightStatus: string | null = null;

      if (globallyCoveredCardIndexes.has(i)) {
        summary.CHEAPEST_ALREADY_IN_CART =
          (summary.CHEAPEST_ALREADY_IN_CART ?? 0) + 1;
        continue;
      }

      try {
        const preflightRuns: Promise<unknown>[] = [];

        if (dorasutaPage && !blockedProviders.has('dorasuta')) {
          preflightRuns.push(
            processDorasutaCard(
              dorasutaPage,
              cards[i],
              i,
              cards.length,
              cartQuantities,
              {
                commit: false,
                cartEntries: dorasutaCartEntries,
                onOffer: (offer) => {
                  dorasutaOffer = offer;
                },
              },
            ).then((status) => {
              dorasutaPreflightStatus = status;
            }),
          );
        }

        if (manaSourcePage) {
          preflightRuns.push(
            processManaSourceCard(
              manaSourcePage,
              cards[i],
              manaSourceCartQuantities,
              {
                commit: false,
                cartEntries: manaSourceCartEntries,
                onOffer: (offer) => {
                  manaSourceOffer = offer;
                },
              },
            ).then((result) => {
              manaSourcePreflightStatus = result.status;
            }),
          );
        }

        if (paoPage) {
          preflightRuns.push(
            processPaoCard(paoPage, cards[i], paoCartQuantities, {
              commit: false,
              cartEntries: paoCartEntries,
              onOffer: (offer) => {
                paoOffer = offer;
              },
            }).then((result) => {
              paoPreflightStatus = result.status;
            }),
          );
        }

        if (torecaPage) {
          preflightRuns.push(
            processTorecaCard(torecaPage, cards[i], torecaCartQuantities, {
              commit: false,
              cartEntries: torecaCartEntries,
              onOffer: (offer) => {
                torecaOffer = offer;
              },
            }).then((result) => {
              torecaPreflightStatus = result.status;
            }),
          );
        }

        const preflightResults = await Promise.allSettled(preflightRuns);
        const rejectedPreflight = preflightResults.find(
          (result) => result.status === 'rejected',
        );

        if (rejectedPreflight?.status === 'rejected') {
          throw rejectedPreflight.reason;
        }

        const selected = selectProviderOffers(
          [dorasutaOffer, manaSourceOffer, paoOffer, torecaOffer].filter(
            (offer): offer is ProviderOffer => offer !== null,
          ),
          PROVIDER_STRATEGY,
        )[0];

        if (!selected) {
          summary.CHEAPEST_NO_ELIGIBLE_OFFER =
            (summary.CHEAPEST_NO_ELIGIBLE_OFFER ?? 0) + 1;
          outputLog(
            '[Cheapest ' +
              (i + 1) +
              '/' +
              cards.length +
              '] no eligible in-stock priced offer.',
          );
          recordProviderCard(
            i,
            'dorasuta',
            dorasutaPreflightStatus ?? 'NO_RESULT',
          );
          recordProviderCard(
            i,
            'manasource',
            manaSourcePreflightStatus ?? 'NO_RESULT',
          );
          recordProviderCard(i, 'pao', paoPreflightStatus ?? 'NO_RESULT');
          recordProviderCard(i, 'toreca', torecaPreflightStatus ?? 'NO_RESULT');
          continue;
        }

        const selectedProvider = selected.provider;
        let selectedStatus = 'NO_RESULT';

        if (selectedProvider === 'dorasuta' && dorasutaPage) {
          selectedStatus = await processDorasutaCard(
            dorasutaPage,
            cards[i],
            i,
            cards.length,
            cartQuantities,
            { commit: COMMIT, cartEntries: dorasutaCartEntries },
          );
        } else if (selectedProvider === 'manasource' && manaSourcePage) {
          selectedStatus = (
            await processManaSourceCard(
              manaSourcePage,
              cards[i],
              manaSourceCartQuantities,
              {
                commit: COMMIT,
                cartEntries: manaSourceCartEntries,
              },
            )
          ).status;
        } else if (selectedProvider === 'pao' && paoPage) {
          selectedStatus = (
            await processPaoCard(paoPage, cards[i], paoCartQuantities, {
              commit: COMMIT,
              cartEntries: paoCartEntries,
            })
          ).status;
        } else if (selectedProvider === 'toreca' && torecaPage) {
          selectedStatus = (
            await processTorecaCard(
              torecaPage,
              cards[i],
              torecaCartQuantities,
              {
                commit: COMMIT,
                cartEntries: torecaCartEntries,
              },
            )
          ).status;
        }

        const resultKey = 'CHEAPEST_' + selectedProvider + '_' + selectedStatus;

        const selectedIsAdded =
          selectedStatus === 'ADDED_TO_CART' ||
          selectedStatus === 'ADDED_TO_CART_PARTIAL_STOCK' ||
          selectedStatus === 'DRY_RUN_OK' ||
          selectedStatus === 'DRY_RUN_PARTIAL_STOCK';
        const selectedIsPartial = selectedStatus.includes('PARTIAL');

        recordProviderCard(
          i,
          'dorasuta',
          selectedProvider === 'dorasuta'
            ? selectedStatus
            : (dorasutaPreflightStatus ?? 'NO_RESULT'),
          selectedProvider === 'dorasuta' && selectedIsAdded,
          selectedProvider === 'dorasuta' && selectedIsPartial,
          selectedProvider === 'dorasuta' ? selected.price : null,
        );
        recordProviderCard(
          i,
          'manasource',
          selectedProvider === 'manasource'
            ? selectedStatus
            : (manaSourcePreflightStatus ?? 'NO_RESULT'),
          selectedProvider === 'manasource' && selectedIsAdded,
          selectedProvider === 'manasource' && selectedIsPartial,
          selectedProvider === 'manasource' ? selected.price : null,
        );
        recordProviderCard(
          i,
          'pao',
          selectedProvider === 'pao'
            ? selectedStatus
            : (paoPreflightStatus ?? 'NO_RESULT'),
          selectedProvider === 'pao' && selectedIsAdded,
          selectedProvider === 'pao' && selectedIsPartial,
          selectedProvider === 'pao' ? selected.price : null,
        );
        recordProviderCard(
          i,
          'toreca',
          selectedProvider === 'toreca'
            ? selectedStatus
            : (torecaPreflightStatus ?? 'NO_RESULT'),
          selectedProvider === 'toreca' && selectedIsAdded,
          selectedProvider === 'toreca' && selectedIsPartial,
          selectedProvider === 'toreca' ? selected.price : null,
        );

        summary[resultKey] = (summary[resultKey] ?? 0) + 1;
        outputLog(
          '[Cheapest ' +
            (i + 1) +
            '/' +
            cards.length +
            '] selected ' +
            selectedProvider +
            ' at ' +
            (selected.price ?? '?') +
            ' yen · ' +
            selectedStatus,
        );
      } catch (error) {
        if (error.code === 'CART_FULL') {
          blockedProviders.add('dorasuta');

          runErrors.push(
            '[Cheapest ' + (i + 1) + '/' + cards.length + '] ' + error.message,
          );
          reportDashboardError(
            `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
            {
              status: 'Dorasuta: CART FULL · provider stopped',
              phase: 'Dorasuta stopped; continuing with other providers',
            },
          );
          recordProviderCard(i, 'dorasuta', 'CART_FULL');
          recordProviderCard(
            i,
            'manasource',
            manaSourcePreflightStatus ?? 'ERROR',
          );
          recordProviderCard(i, 'pao', paoPreflightStatus ?? 'ERROR');
          recordProviderCard(i, 'toreca', torecaPreflightStatus ?? 'ERROR');
          continue;
        }

        if (error.code === 'DORASUTA_IP_BLOCKED') {
          blockedProviders.add('dorasuta');
          runErrors.push(
            '[Cheapest ' + (i + 1) + '/' + cards.length + '] ' + error.message,
          );
          dorasutaPreflightStatus = 'PROVIDER_BLOCKED';
          reportDashboardError(
            `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
            {
              status: 'Dorasuta: Cloudflare 1006 · provider stopped',
              phase: 'Dorasuta stopped; continuing with other providers',
            },
          );
          recordProviderCard(i, 'dorasuta', dorasutaPreflightStatus);
          recordProviderCard(
            i,
            'manasource',
            manaSourcePreflightStatus ?? 'NO_RESULT',
          );
          recordProviderCard(i, 'pao', paoPreflightStatus ?? 'NO_RESULT');
          recordProviderCard(i, 'toreca', torecaPreflightStatus ?? 'NO_RESULT');
          continue;
        }

        summary.CHEAPEST_ERROR = (summary.CHEAPEST_ERROR ?? 0) + 1;
        runErrors.push(
          '[Cheapest ' + (i + 1) + '/' + cards.length + '] ' + error.message,
        );
        reportDashboardError(
          `${cards[i].cardmarketName} (${cards[i].set} ${cards[i].number}) · ${describeDashboardError(error)}`,
          {
            status:
              'Provider comparison: ' +
              formatDashboardStatus('ERROR') +
              ' · ' +
              describeDashboardError(error),
            phase: 'Waiting for provider comparison results',
          },
        );
        recordProviderCard(i, 'dorasuta', dorasutaPreflightStatus ?? 'ERROR');
        recordProviderCard(
          i,
          'manasource',
          manaSourcePreflightStatus ?? 'ERROR',
        );
        recordProviderCard(i, 'pao', paoPreflightStatus ?? 'ERROR');
        recordProviderCard(i, 'toreca', torecaPreflightStatus ?? 'ERROR');
      }
    }
  }

  updateDashboard({
    current: cards.length,
    phase: 'Completed',
    status: 'Completed',
  });
  stopDashboard();

  for (const error of runErrors) {
    outputLog(`ERROR: ${error}`);
  }

  const cartTotals = await Promise.all([
    dorasutaPage
      ? readDorasutaCartTotal(dorasutaPage).catch(() => null)
      : Promise.resolve(null),
    manaSourcePage
      ? readManaSourceCartTotal(manaSourcePage).catch(() => null)
      : Promise.resolve(null),
    paoPage
      ? readPaoCartTotal(paoPage).catch(() => null)
      : Promise.resolve(null),
    torecaPage
      ? readTorecaCartTotal(torecaPage).catch(() => null)
      : Promise.resolve(null),
  ]);
  const [
    dorasutaCartTotal,
    manaSourceCartTotal,
    paoCartTotal,
    torecaCartTotal,
  ] = cartTotals;

  const fullyCoveredStatuses = new Set([
    'ADDED_TO_CART',
    'DRY_RUN_OK',
    'ALREADY_IN_CART',
  ]);
  const partiallyCoveredStatuses = new Set([
    'ADDED_TO_CART_PARTIAL_STOCK',
    'DRY_RUN_PARTIAL_STOCK',
  ]);
  const getProviderCoverage = (provider) => {
    const results = completedProviderCards.map((cardResults) =>
      cardResults.get(provider),
    );

    return {
      full: results.filter(
        (result) => result && fullyCoveredStatuses.has(result.status),
      ).length,
      partial: results.filter(
        (result) => result && partiallyCoveredStatuses.has(result.status),
      ).length,
    };
  };
  const dorasutaCoverage = dorasutaPage
    ? getProviderCoverage('dorasuta')
    : null;
  const manaSourceCoverage = manaSourcePage
    ? getProviderCoverage('manasource')
    : null;
  const paoCoverage = paoPage ? getProviderCoverage('pao') : null;
  const torecaCoverage = torecaPage ? getProviderCoverage('toreca') : null;

  if (dorasutaPage || manaSourcePage || paoPage || torecaPage) {
    outputLog('');

    const totals = [];

    if (dorasutaPage) {
      totals.push(
        'Dorasuta: ' +
          (dorasutaCartTotal === null
            ? 'unavailable'
            : dorasutaCartTotal.toLocaleString('en-US') + ' yen'),
      );
    }

    if (manaSourcePage) {
      totals.push(
        'ManaSource: ' +
          (manaSourceCartTotal === null
            ? 'unavailable'
            : manaSourceCartTotal.toLocaleString('en-US') + ' yen'),
      );
    }

    if (paoPage) {
      totals.push(
        'PAO: ' +
          (paoCartTotal === null
            ? 'unavailable'
            : paoCartTotal.toLocaleString('en-US') + ' yen'),
      );
    }

    if (torecaPage) {
      totals.push(
        'Toreca: ' +
          (torecaCartTotal === null
            ? 'unavailable'
            : torecaCartTotal.toLocaleString('en-US') + ' yen'),
      );
    }

    outputLog('Cart totals: ' + totals.join(' · '));

    const coverage = [];

    if (dorasutaCoverage) {
      coverage.push(
        'Dorasuta: ' +
          dorasutaCoverage.full +
          '/' +
          cards.length +
          ' fully covered' +
          (dorasutaCoverage.partial
            ? ' · ' + dorasutaCoverage.partial + ' partial'
            : ''),
      );
    }

    if (manaSourceCoverage) {
      coverage.push(
        'ManaSource: ' +
          manaSourceCoverage.full +
          '/' +
          cards.length +
          ' fully covered' +
          (manaSourceCoverage.partial
            ? ' · ' + manaSourceCoverage.partial + ' partial'
            : ''),
      );
    }

    if (paoCoverage) {
      coverage.push(
        'PAO: ' +
          paoCoverage.full +
          '/' +
          cards.length +
          ' fully covered' +
          (paoCoverage.partial ? ' · ' + paoCoverage.partial + ' partial' : ''),
      );
    }

    if (torecaCoverage) {
      coverage.push(
        'Toreca: ' +
          torecaCoverage.full +
          '/' +
          cards.length +
          ' fully covered' +
          (torecaCoverage.partial
            ? ' · ' + torecaCoverage.partial + ' partial'
            : ''),
      );
    }

    outputLog('Wishlist coverage: ' + coverage.join(' · '));

    const addedByProvider = new Map();

    for (const [index, providerResults] of completedProviderCards.entries()) {
      for (const [provider, result] of providerResults.entries()) {
        if (!result.added) continue;

        const cardsForProvider = addedByProvider.get(provider) ?? [];
        cardsForProvider.push({ card: cards[index], price: result.price });
        addedByProvider.set(provider, cardsForProvider);
      }
    }

    const providerLabels = {
      dorasuta: 'Dorasuta',
      manasource: 'ManaSource',
      pao: 'PAO',
      toreca: 'Toreca',
    };

    outputLog('');
    outputLog(
      COMMIT ? 'Cards added by provider:' : 'Cards planned by provider:',
    );

    for (const provider of PROVIDERS) {
      const providerCards = addedByProvider.get(provider) ?? [];
      outputLog(
        `${providerLabels[provider]} (${providerCards.length}):` +
          (providerCards.length ? '' : ' none'),
      );

      for (const { card, price } of providerCards) {
        outputLog(
          `  ${card.quantity} × ${card.cardmarketName} (${card.set} ${card.number}) · ` +
            `${price === null ? '? yen' : price.toLocaleString('en-US') + ' yen'}`,
        );
      }
    }
  }

  const unresolvedByCard = cards
    .map((card, index) => {
      const providerFailures = [...completedProviderCards[index].entries()]
        .filter(([, result]) => notFoundStatuses.has(result.status))
        .map(([provider, result]) => ({
          provider:
            provider === 'manasource'
              ? 'ManaSource'
              : provider === 'pao'
                ? 'PAO'
                : 'Dorasuta',
          status: result.status,
        }));

      return providerFailures.length
        ? {
            card:
              card.quantity +
              ' × ' +
              card.cardmarketName +
              ' (' +
              card.set +
              ' ' +
              card.number +
              ')',
            providerFailures,
          }
        : null;
    })
    .filter((item) => item !== null);

  if (unresolvedByCard.length) {
    outputLog('');
    outputLog(
      'Cards not found or not verified: ' +
        unresolvedByCard.length +
        ' card(s)',
    );

    for (const item of unresolvedByCard) {
      outputLog(
        '  ' +
          item.card +
          ' · ' +
          item.providerFailures
            .map(
              (failure) =>
                failure.provider + ': ' + formatDashboardStatus(failure.status),
            )
            .join(' · '),
      );
    }
  }

  if (stockIssues.length) {
    outputLog('');
    outputLog(`Cards requiring stock attention: ${stockIssues.length}`);

    for (const item of stockIssues) {
      outputLog(`  ${formatSummaryStatus(item.status)} · ${item.card}`);
    }
  }

  if (priceIssues.length) {
    outputLog('');
    outputLog(`Cards over the price limit: ${priceIssues.length}`);

    for (const item of priceIssues) {
      outputLog(`  [${item.status}] ${item.card}`);
    }
  }

  outputLog('');
  outputLog('Completed.');

  console.table(
    Object.fromEntries(
      Object.entries(summary).map(([status, count]) => [
        formatSummaryStatus(status),
        count,
      ]),
    ),
  );

  // For a CDP connection, Browser.close() disposes Playwright's client and
  // disconnects from the existing browser; it does not close that browser.
  await browser.close();
  connectedBrowser = null;

  /**
   * Do NOT call browser.close().
   *
   * This process is attached to the user's existing Chromium/Brave session.
   */
}

main().catch((error) => {
  console.error('');
  console.error(error.stack ?? error.message);

  void connectedBrowser?.close();
  connectedBrowser = null;

  process.exitCode = 1;
});
