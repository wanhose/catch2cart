/**
 * Cardmarket wishlist ingestion and cache normalisation.
 *
 * The module returns one record per logical card. If a card appears in more
 * than one wishlist, quantities are merged with `max`, not `sum`, and all
 * source lists are retained in `wishlistUrls` for diagnostics.
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';
import {
  WISHLIST_CACHE_TTL_HOURS,
  WISHLIST_CACHE_FILE,
  LEGACY_WISHLIST_CACHE_FILE,
  CARDMARKET_URL,
  CLEAR_WISHLIST_CACHE,
  CURRENT_WISHLIST_ONLY,
  NAVIGATION_TIMEOUT_MS,
  SKIP_CARDMARKET_WISHLIST_IDS,
  USE_WISHLIST_CACHE,
} from '../config.ts';
import { gotoAndWait } from '../browser.ts';
import { normalizeNumber, parseCardmarketName } from '../cards.ts';
import { outputLog } from '../output.ts';

/** Extract raw amount/name rows from the currently loaded Wants page. */
async function scrapeCurrentWishlist(page) {
  return page.evaluate(() => {
    const result = [];

    for (const row of document.querySelectorAll('tbody tr')) {
      const amount = row.querySelector('.amount');

      const name = row.querySelector('.name');

      if (!amount || !name) {
        continue;
      }

      result.push({
        amount: amount.textContent.trim(),

        name: name.textContent.trim(),
      });
    }

    return result;
  });
}

/** Discover numeric Wants lists from the Cardmarket overview. */

/**
 * Always run this from the Wants overview.
 *
 * Cardmarket may expose links in different languages:
 *
 *   /en/Pokemon/Wants/23152554
 *   /fr/Pokemon/Wants/23152554
 *   /de/Pokemon/Wants/23152554
 *
 * We deduplicate by the numeric list ID and reconstruct one canonical
 * English URL.
 *
 * ShoppingWizard is never accepted.
 */
async function discoverWishlistUrls(page) {
  outputLog('Opening Cardmarket Wants overview...');

  await gotoAndWait(page, CARDMARKET_URL, {
    waitUntil: 'domcontentloaded',

    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const ids = await page.evaluate(() => {
    const result = new Set();

    for (const link of document.querySelectorAll('a[href]')) {
      try {
        const url = new URL((link as HTMLAnchorElement).href);

        if (!url.hostname.includes('cardmarket.com')) {
          continue;
        }

        const match = url.pathname.match(
          /^\/[a-z]{2}\/Pokemon\/Wants\/(\d+)\/?$/i,
        );

        if (match) {
          result.add(match[1]);
        }
      } catch {
        // Ignore malformed links.
      }
    }

    return [...result];
  });

  const skippedIds = ids.filter((id) => SKIP_CARDMARKET_WISHLIST_IDS.has(id));

  if (skippedIds.length) {
    outputLog(`Skipping Cardmarket wishlist(s): ${skippedIds.join(', ')}`);
  }

  return ids
    .filter((id) => !SKIP_CARDMARKET_WISHLIST_IDS.has(id))
    .map((id) => `https://www.cardmarket.com/en/Pokemon/Wants/${id}`);
}

/** Convert raw Cardmarket rows into normalized cards and parse failures. */
function normalizeWishlistRows(rows, wishlistUrl) {
  const cards = [];
  const failures = [];
  const wishlistId = wishlistUrl.match(/\/Wants\/(\d+)\/?$/i)?.[1] ?? null;

  for (const row of rows) {
    const parsed = parseCardmarketName(row.name);

    if (!parsed) {
      failures.push({
        amount: row.amount,

        name: row.name,

        wishlistUrl,
        ...(wishlistId ? { wishlistId } : {}),
      });

      continue;
    }

    const quantity = Number(row.amount);

    cards.push({
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,

      cardmarketName: parsed.name,

      set: parsed.set,

      number: parsed.number,

      wishlistUrl,
      ...(wishlistId ? { wishlistId } : {}),
    });
  }

  return {
    cards,
    failures,
  };
}

/**
 * Merge rows from multiple wishlists without multiplying requested copies.
 * The helper is pure so the quantity-integrity rule can be tested without a
 * browser session.
 */
function mergeWishlistCards(cards) {
  const merged = new Map();

  for (const card of cards) {
    const wishlistId =
      card.wishlistId ??
      card.wishlistUrl.match(/\/Wants\/(\d+)\/?$/i)?.[1] ??
      null;
    const key = [
      card.set,
      normalizeNumber(card.number),
      card.cardmarketName,
    ].join(':');

    const existing = merged.get(key);

    if (existing) {
      existing.quantity = Math.max(existing.quantity, card.quantity);

      if (!existing.wishlistUrls.includes(card.wishlistUrl)) {
        existing.wishlistUrls.push(card.wishlistUrl);
      }

      if (wishlistId) {
        existing.wishlistIds ??= [];
        if (!existing.wishlistIds.includes(wishlistId)) {
          existing.wishlistIds.push(wishlistId);
        }
      }

      continue;
    }

    const normalizedCard = {
      ...card,
    };

    delete normalizedCard.wishlistUrl;
    delete normalizedCard.wishlistId;

    merged.set(key, {
      ...normalizedCard,
      wishlistUrls: [card.wishlistUrl],
      ...(wishlistId ? { wishlistIds: [wishlistId] } : {}),
    });
  }

  return [...merged.values()];
}

/** Scrape, filter, parse, and merge all selected Cardmarket wishlists. */

async function collectCardmarketCards(page) {
  /**
   * Explicit diagnostic mode:
   *
   *   node index.js --current-wishlist
   */
  if (CURRENT_WISHLIST_ONLY) {
    outputLog(`Using current Wants page only: ${page.url()}`);

    const rows = await scrapeCurrentWishlist(page);

    return normalizeWishlistRows(rows, page.url());
  }

  /**
   * Normal mode:
   *
   * ALWAYS return to /Pokemon/Wants first and discover every list there.
   */
  const wishlistUrls = await discoverWishlistUrls(page);

  if (!wishlistUrls.length) {
    throw new Error(
      SKIP_CARDMARKET_WISHLIST_IDS.size
        ? 'No Cardmarket Wants lists remain after applying the skip filter.'
        : 'No numeric Wants lists were found on the Cardmarket Wants overview.',
    );
  }

  outputLog(`Found ${wishlistUrls.length} Wants list(s).`);

  const cards = [];
  const failures = [];

  for (let i = 0; i < wishlistUrls.length; i++) {
    const url = wishlistUrls[i];

    outputLog(`[Cardmarket ${i + 1}/${wishlistUrls.length}] ${url}`);

    await gotoAndWait(page, url, {
      waitUntil: 'domcontentloaded',

      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const rows = await scrapeCurrentWishlist(page);

    const result = normalizeWishlistRows(rows, url);

    outputLog(`  Cards: ${result.cards.length}`);

    cards.push(...result.cards);

    failures.push(...result.failures);
  }

  /**
   * A card may appear in multiple organizational Wants lists.
   *
   * Use max(), not sum(), to avoid accidentally purchasing duplicate copies
   * merely because the same desired card was placed in two lists.
   */
  return {
    cards: mergeWishlistCards(cards),

    failures,
  };
}

/** Load a compatible cache, migrate legacy fields, or create a fresh cache. */

async function collectCardmarketCardsWithCache(page) {
  if (CLEAR_WISHLIST_CACHE) {
    try {
      await unlink(WISHLIST_CACHE_FILE);
      outputLog(`Wishlist cache deleted: ${WISHLIST_CACHE_FILE}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        outputLog(`Could not delete wishlist cache (${error.message}).`);
      }
    }
  }

  if (!USE_WISHLIST_CACHE || CURRENT_WISHLIST_ONLY) {
    return collectCardmarketCards(page);
  }

  try {
    let cacheFile = WISHLIST_CACHE_FILE;
    let contents: string;

    try {
      contents = await readFile(cacheFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      contents = await readFile(LEGACY_WISHLIST_CACHE_FILE, 'utf8');
      cacheFile = LEGACY_WISHLIST_CACHE_FILE;
      outputLog('Migrating legacy wishlist cache: ' + cacheFile);
    }

    const cached = JSON.parse(contents);

    const cacheAgeMs = cached.collectedAt
      ? Date.now() - Date.parse(cached.collectedAt)
      : 0;
    const cacheExpired =
      WISHLIST_CACHE_TTL_HOURS > 0 &&
      (!Number.isFinite(cacheAgeMs) ||
        cacheAgeMs > WISHLIST_CACHE_TTL_HOURS * 60 * 60 * 1000);

    if (
      cached?.version === 1 &&
      Array.isArray(cached.cards) &&
      Array.isArray(cached.failures) &&
      !cacheExpired
    ) {
      outputLog('Using wishlist cache: ' + cacheFile);

      if (cached.collectedAt) {
        outputLog(`  Cache generated: ${cached.collectedAt}`);
      }

      let cacheNeedsRewrite = false;

      const normalizedCards = cached.cards.map((card) => {
        const normalizedCard = {
          ...card,
        };

        const hadLegacyWishlistUrl = Object.hasOwn(
          normalizedCard,
          'wishlistUrl',
        );
        const legacyWishlistUrl = normalizedCard.wishlistUrl;

        delete normalizedCard.wishlistUrl;

        const originalWishlistUrls = normalizedCard.wishlistUrls;
        const wishlistUrls = Array.isArray(originalWishlistUrls)
          ? normalizedCard.wishlistUrls
          : legacyWishlistUrl
            ? [legacyWishlistUrl]
            : [];

        normalizedCard.wishlistUrls = [...new Set(wishlistUrls)];
        const originalWishlistIds = normalizedCard.wishlistIds;
        const wishlistIds = Array.isArray(originalWishlistIds)
          ? originalWishlistIds
          : normalizedCard.wishlistUrls
              .map((url) => url.match(/\/Wants\/(\d+)\/?$/i)?.[1] ?? null)
              .filter((id): id is string => Boolean(id));

        normalizedCard.wishlistIds = [...new Set(wishlistIds)];

        if (
          hadLegacyWishlistUrl ||
          !Array.isArray(originalWishlistUrls) ||
          normalizedCard.wishlistUrls.length !== originalWishlistUrls.length ||
          !Array.isArray(originalWishlistIds) ||
          normalizedCard.wishlistIds.length !== originalWishlistIds.length
        ) {
          cacheNeedsRewrite = true;
        }

        return normalizedCard;
      });

      if (cacheNeedsRewrite) {
        try {
          await writeFile(
            WISHLIST_CACHE_FILE,
            `${JSON.stringify(
              {
                ...cached,
                cards: normalizedCards,
              },
              null,
              2,
            )}\n`,
            'utf8',
          );

          outputLog(`Normalized wishlist cache: ${WISHLIST_CACHE_FILE}`);
        } catch (error) {
          outputLog(
            `Warning: could not normalize wishlist cache (${error.message}).`,
          );
        }
      }

      const cardsHaveSourceIds = normalizedCards.every(
        (card) => card.wishlistIds.length > 0,
      );

      if (SKIP_CARDMARKET_WISHLIST_IDS.size && !cardsHaveSourceIds) {
        outputLog(
          'Wishlist cache has cards without source IDs; downloading lists again to apply skip filters.',
        );
      } else {
        const cards = SKIP_CARDMARKET_WISHLIST_IDS.size
          ? normalizedCards.filter((card) =>
              card.wishlistIds.some(
                (id) => !SKIP_CARDMARKET_WISHLIST_IDS.has(id),
              ),
            )
          : normalizedCards;
        const failures = SKIP_CARDMARKET_WISHLIST_IDS.size
          ? cached.failures.filter((failure) => {
              const id = failure.wishlistUrl?.match(/\/Wants\/(\d+)\/?$/i)?.[1];
              return !id || !SKIP_CARDMARKET_WISHLIST_IDS.has(id);
            })
          : cached.failures;

        return { cards, failures };
      }
    }

    if (cacheExpired) {
      outputLog(
        `Wishlist cache expired after ${WISHLIST_CACHE_TTL_HOURS} hour(s). Downloading lists again.`,
      );
    }

    if (!cacheExpired) {
      outputLog(`Ignoring invalid wishlist cache: ${WISHLIST_CACHE_FILE}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      outputLog(
        `Wishlist cache not found. Downloading lists and creating it: ${WISHLIST_CACHE_FILE}`,
      );
    } else {
      outputLog(
        `Could not read wishlist cache (${error.message}). Downloading lists again.`,
      );
    }
  }

  const result = await collectCardmarketCards(page);

  try {
    await writeFile(
      WISHLIST_CACHE_FILE,
      `${JSON.stringify(
        {
          version: 1,
          collectedAt: new Date().toISOString(),
          cards: result.cards,
          failures: result.failures,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    outputLog(`Wishlist cache written: ${WISHLIST_CACHE_FILE}`);
  } catch (error) {
    outputLog(`Warning: could not write wishlist cache (${error.message}).`);
  }

  return result;
}

export { collectCardmarketCardsWithCache, mergeWishlistCards };
