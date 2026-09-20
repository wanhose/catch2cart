/**
 * Dorasuta search, product matching, stock selection, and cart operations.
 *
 * Search results are only candidates. A product is accepted after its detail
 * page has been inspected and matched using the identity rules below. Cart
 * quantities are tracked by product `pid`, never by the global cart counter
 * alone.
 */

import {
  CART_TIMEOUT_MS,
  DORASUTA_CART_URL,
  DORASUTA_SEARCH_URL,
  NAVIGATION_TIMEOUT_MS,
} from '../config.ts';
import { gotoAndWait, waitForDorasutaSearchGap } from '../browser.ts';
import {
  normalizeWhitespace,
  numbersEqual,
  parseCollectorNumber,
} from '../cards.ts';
import { outputLog } from '../output.ts';
import { matchProviderProduct } from './matching.ts';

let lastKnownCartCount = null;
function setInitialCartCount(count) {
  lastKnownCartCount = count;
}

/**
 * Dorasuta result pages contain many unrelated links.
 *
 * Restrict candidate extraction to actual result .element nodes.
 */
async function searchDorasuta(page, searchName) {
  await waitForDorasutaSearchGap();

  const url = `${DORASUTA_SEARCH_URL}?kw=` + encodeURIComponent(searchName);

  await gotoAndWait(page, url, {
    waitUntil: 'domcontentloaded',

    timeout: NAVIGATION_TIMEOUT_MS,
  });

  return page
    .locator('.frame.item .section .element')
    .evaluateAll((elements) => {
      const seen = new Set();

      const results = [];

      for (const element of elements) {
        const link = element.querySelector(
          '.description li.change_hight > a[href*="/pokemon-card/product?pid="]',
        );

        if (!link) {
          continue;
        }

        const href = link.href;

        if (!href || seen.has(href)) {
          continue;
        }

        const title = link.textContent?.replace(/\s+/g, ' ').trim() ?? '';

        seen.add(href);

        results.push({
          href,
          title,
        });
      }

      return results;
    });
}

/** Keep only search results whose visible title contains the requested number. */
function filterCandidatesByNumber(candidates, wantedNumber) {
  return candidates.filter((candidate) => {
    const number = parseCollectorNumber(candidate.title);

    return number !== null && numbersEqual(number, wantedNumber);
  });
}

/**
 * Read product metadata from its own detail table.
 *
 * Do NOT look for a set code in the entire body because Dorasuta also
 * renders unrelated global series links.
 */
async function inspectProduct(page, url) {
  await gotoAndWait(page, url, {
    waitUntil: 'domcontentloaded',

    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const metadata = await page
    .locator('.detail table tr')
    .evaluateAll((rows) => {
      const result = {};

      for (const row of rows) {
        const th = row.querySelector('th');

        const td = row.querySelector('td');

        if (!th || !td) {
          continue;
        }

        const key = th.textContent?.replace(/\s+/g, ' ').trim() ?? '';

        const value = td.textContent?.replace(/\s+/g, ' ').trim() ?? '';

        if (key && value) {
          result[key] = value;
        }
      }

      return result;
    });

  let productName = '';

  const jsonLdScripts = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents();

  for (const text of jsonLdScripts) {
    try {
      const data = JSON.parse(text);

      if (data?.['@type'] === 'Product' && data?.name) {
        productName = normalizeWhitespace(data.name);

        break;
      }
    } catch {
      // Ignore unrelated JSON-LD blocks.
    }
  }

  if (!productName) {
    productName = normalizeWhitespace(await page.title());
  }

  const seriesText = metadata['シリーズ'] ?? '';

  const seriesMatch = seriesText.match(/【\s*([^】]+?)\s*】/);

  const setCode = seriesMatch?.[1]?.trim().toLowerCase() ?? null;

  return {
    url,
    productName,
    setCode,

    collectorNumber: parseCollectorNumber(productName),
    totalNumber: productName.match(/\((\d+)\/(\d+)/)?.[2] ?? null,

    modelNumber: metadata['型番'] ?? null,

    rarity: metadata['レアリティ'] ?? null,
  };
}

/** Require both set code and collector number for the normal match path. */
function isExactMatch(card, product) {
  return matchProviderProduct(card, product).kind === 'exact';
}

/**
 * Cached URLs can be manually supplied for trainers, tools and stadiums.
 * Those pages do not always expose set/collector metadata. In that case the
 * cache is authoritative unless metadata that is present explicitly conflicts.
 */
function isCompatibleCachedProduct(card, product) {
  if (product.setCode && product.setCode !== card.set) {
    return false;
  }

  if (
    product.collectorNumber &&
    !numbersEqual(card.number, product.collectorNumber)
  ) {
    return false;
  }

  return true;
}

/**
 * Last-resort fallback for one-off alternate-art listings. It requires one
 * candidate and matching `number/total` information, optionally corroborated
 * by Dorasuta's model number.
 */
function isLastResortNumberAndTotalMatch(card, product, candidateCount) {
  if (
    candidateCount !== 1 ||
    product.setCode ||
    !product.collectorNumber ||
    !numbersEqual(card.number, product.collectorNumber)
  ) {
    return false;
  }

  const numberAndTotal = product.productName.match(
    /\((\d+)\/(\d+)(?:\/[^)]*)?\)/,
  );

  if (!numberAndTotal || !product.modelNumber) {
    return false;
  }

  const match = matchProviderProduct(card, {
    ...product,
    collectorNumber: numberAndTotal[1],
    totalNumber: numberAndTotal[2],
  });

  if (match.kind === 'none' && !numbersEqual(card.number, numberAndTotal[1])) {
    return false;
  }

  return new RegExp(
    `^pn0*${numberAndTotal[1]}0*${numberAndTotal[2]}(?:\\d|$)`,
    'i',
  ).test(product.modelNumber);
}

/**
 * Product pages:
 *
 *   .stock .main_offer
 *   .stock .stock_list .condition_item
 *
 * Only 状態A特価 and 状態A are accepted.
 *
 * Unknown/unparsed stock is NOT safe and is never selected.
 */
async function findConditionOptions(page) {
  const offers = page.locator(
    '.stock .main_offer, .stock .stock_list .condition_item',
  );

  const result = [];

  const count = await offers.count();

  for (let i = 0; i < count; i++) {
    const offer = offers.nth(i);

    const condition = normalizeWhitespace(
      (await offer.locator('.condition').textContent()) ?? '',
    );

    if (condition !== '状態A特価' && condition !== '状態A') {
      continue;
    }

    const stockText = normalizeWhitespace(
      (await offer.locator('.stock_quantity').textContent()) ?? '',
    );

    let stock = null;

    if (/在庫なし/.test(stockText)) {
      stock = 0;
    } else {
      const match = stockText.match(/在庫数[：:]\s*(\d+)/);

      if (match) {
        stock = Number(match[1]);
      }
    }

    const priceText = normalizeWhitespace(
      (await offer.locator('.price').textContent()) ?? '',
    );

    const priceMatch = priceText.match(/([\d,]+)\s*円/);

    const price = priceMatch ? Number(priceMatch[1].replaceAll(',', '')) : null;

    const addButton = offer.locator('a[id^="cart_110300_"]').first();

    const quantitySelect = offer
      .locator('select[id^="quantity_110300_"]')
      .first();

    result.push({
      condition,
      stock,
      price,

      canAdd: (await addButton.count()) > 0,

      addButton,
      quantitySelect,
    });
  }

  return result;
}

/**
 * Condition priority:
 *
 *   1. 状態A特価
 *   2. 状態A
 *
 * Prefer verified stock >= requested quantity; otherwise select the largest
 * verified positive stock so partial quantities can still be added.
 */
function chooseCondition(options, quantity) {
  const priority = ['状態A特価', '状態A'];

  const fullStock = options
    .filter(
      (item) =>
        priority.includes(item.condition) &&
        Number.isInteger(item.stock) &&
        item.stock >= quantity &&
        item.canAdd,
    )
    .sort((a, b) => {
      if (a.price === null && b.price === null) return 0;
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      if (a.price !== b.price) return a.price - b.price;
      return priority.indexOf(a.condition) - priority.indexOf(b.condition);
    });

  if (fullStock.length) return fullStock[0];

  // If the requested quantity is unavailable, still choose the offer with
  // the most verified stock so the available copies can be added.
  return (
    options
      .filter(
        (item) =>
          priority.includes(item.condition) &&
          Number.isInteger(item.stock) &&
          item.stock > 0 &&
          item.canAdd,
      )
      .sort((a, b) => {
        if (b.stock !== a.stock) return b.stock - a.stock;
        if (a.price === null && b.price === null) return 0;
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        if (a.price !== b.price) return a.price - b.price;
        return priority.indexOf(a.condition) - priority.indexOf(b.condition);
      })[0] ?? null
  );
}

async function setQuantity(select, quantity) {
  if (!(await select.count())) {
    if (quantity !== 1) {
      throw new Error(`Quantity selector missing for quantity ${quantity}.`);
    }

    return;
  }

  const desired = String(quantity);

  const available = await select
    .locator('option')
    .evaluateAll((options) => options.map((option) => option.value));

  if (!available.includes(desired)) {
    throw new Error(
      `Quantity ${quantity} is not available in the Dorasuta selector.`,
    );
  }

  await select.selectOption(desired);
}

/**
 * Cart counters are dynamically populated.
 *
 * Empty cart may legitimately return null.
 */
async function readCartCount(page) {
  return page.evaluate(() => {
    const values = [];

    for (const selector of ['#cart_count', '#cart_count_sp']) {
      const element = document.querySelector(selector);

      if (!element) {
        continue;
      }

      const text = element.textContent ?? '';

      const match = text.match(/\d+/);

      if (match) {
        values.push(Number(match[0]));
      }
    }

    if (!values.length) {
      return null;
    }

    return Math.max(...values);
  });
}

/**
 * Dorasuta can populate the initial cart counter asynchronously.
 *
 * We give it a short opportunity, but we do NOT block startup if the
 * current cart is empty and no number appears.
 */
async function readInitialCartCount(page) {
  const immediate = await readCartCount(page);

  if (immediate !== null) {
    return immediate;
  }

  try {
    const handle = await page.waitForFunction(
      () => {
        const values = [];

        for (const selector of ['#cart_count', '#cart_count_sp']) {
          const element = document.querySelector(selector);

          const match = element?.textContent?.match(/\d+/);

          if (match) {
            values.push(Number(match[0]));
          }
        }

        if (!values.length) {
          return false;
        }

        return Math.max(...values);
      },
      undefined,
      {
        timeout: 1500,
      },
    );

    return Number(await handle.jsonValue());
  } catch {
    return null;
  }
}

/** Read Dorasuta's tax-inclusive cart total from the cart summary. */
async function readDorasutaCartTotal(page) {
  await gotoAndWait(page, DORASUTA_CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  return page
    .locator('.frame.cart .section.total td')
    .first()
    .textContent()
    .then((text) => {
      const match = normalizeWhitespace(text ?? '').match(/[\d,]+/);

      return match ? Number(match[0].replaceAll(',', '')) : null;
    });
}

/**
 * Read the cart by product pid, not just by its global counter. The latter
 * cannot tell us whether a particular wishlist card is already present.
 */
async function readCartContents(page) {
  const entries = await readCartEntries(page);
  const quantities = new Map();

  for (const entry of entries) {
    const previous = quantities.get(entry.productId);

    if (entry.quantity === null) {
      quantities.set(entry.productId, null);
      continue;
    }

    if (previous !== null) {
      quantities.set(entry.productId, Math.max(previous ?? 0, entry.quantity));
    }
  }

  return quantities;
}

async function readCartEntries(page) {
  await gotoAndWait(page, DORASUTA_CART_URL, {
    waitUntil: 'domcontentloaded',

    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const entries = await page.evaluate(() => {
    const result = new Map();

    for (const link of document.querySelectorAll(
      'a[href*="/pokemon-card/product?pid="]',
    )) {
      const href = (link as HTMLAnchorElement).href;
      const pid = new URL(href).searchParams.get('pid');

      if (!pid) {
        continue;
      }

      const container =
        link.closest(
          '.frame.cart .section.list .element, ' +
            '.cart .section.list .element, ' +
            '.cart .element, .element, tr',
        ) ?? link.parentElement;

      if (!container) {
        continue;
      }

      const quantityControl = container.querySelector(
        'select[id*="quantity"], select[name*="quantity"], ' +
          'input[id*="quantity"], input[name*="quantity"], ' +
          'input[type="number"]',
      );

      const controlQuantity = Number(
        (quantityControl as HTMLInputElement | HTMLSelectElement | null)
          ?.value ?? '',
      );

      const textMatch = container.textContent?.match(/数量\s*[：:]\s*(\d+)/);

      const textQuantity = Number(textMatch?.[1] ?? '');

      const quantity =
        Number.isInteger(controlQuantity) && controlQuantity > 0
          ? controlQuantity
          : Number.isInteger(textQuantity) && textQuantity > 0
            ? textQuantity
            : null;

      const productName = link.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const previous = result.get(pid);

      if (!previous) {
        result.set(pid, {
          productId: pid,
          url: href,
          productName,
          quantity,
        });
        continue;
      }

      // Dorasuta renders both an image link and a title link for each
      // product. Keep the same cart line once, but prefer the link carrying
      // the product identity needed by the wishlist matcher.
      if (!previous.productName && productName) {
        previous.productName = productName;
        previous.url = href;
      }

      if (previous.quantity === null && quantity !== null) {
        previous.quantity = quantity;
      }
    }

    return [...result.values()];
  });

  return entries;
}

function isInsufficientStockAlert(message) {
  return /在庫が不足しています。?カートの数量を調整してください。?/.test(
    normalizeWhitespace(message),
  );
}

/**
 * Add to cart and do not continue navigating until the cart counter rises.
 *
 * - confirms are accepted
 * - successful add alerts are accepted; unexpected alerts become errors
 * - the next card is not processed until the counter increases
 */
async function addToCartAndWait(page, addButton) {
  const before = (await readCartCount(page)) ?? lastKnownCartCount;

  let alertMessage = null;
  let cartFull = false;

  const isSuccessfulAddAlert = (message) =>
    /商品をカートに追加しました。?/.test(normalizeWhitespace(message));

  const isCartFullAlert = (message) =>
    /カートがいっぱいです/.test(normalizeWhitespace(message));

  const createAlertError = (message) =>
    Object.assign(new Error(`Dorasuta alert: ${message}`), {
      code: 'DORASUTA_ALERT',
      alertMessage: message,
    });

  const isRetryableCartAlert = (message) =>
    /カート登録に失敗しました。?再度処理を実施してください/.test(
      normalizeWhitespace(message),
    );

  const handleDialog = async (dialog) => {
    const type = dialog.type();

    if (type === 'confirm') {
      outputLog(`  Confirm: ${dialog.message()}`);

      await dialog.accept();
      return;
    }

    if (type === 'alert') {
      const message = dialog.message();

      outputLog(`  Alert: ${message}`);

      if (isCartFullAlert(message)) {
        cartFull = true;
      } else if (!isSuccessfulAddAlert(message)) {
        alertMessage = message;
      }

      await dialog.accept();
      return;
    }

    await dialog.accept();
  };

  page.on('dialog', handleDialog);

  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      alertMessage = null;
      cartFull = false;

      try {
        await addButton.click();

        if (cartFull) {
          const cartFullError = new Error(
            'Dorasuta cart is full. Complete or clear the current cart before continuing.',
          );
          Object.assign(cartFullError, { code: 'CART_FULL' });
          throw cartFullError;
        }

        if (alertMessage) {
          const current = await readCartCount(page);
          if (before !== null && current !== null && current > before) {
            lastKnownCartCount = current;
            return current;
          }

          if (isRetryableCartAlert(alertMessage) && attempt < 3) {
            outputLog(
              `  Retrying Dorasuta cart registration (${attempt + 1}/3)...`,
            );
            await page.waitForTimeout(1000);
            continue;
          }

          throw createAlertError(alertMessage);
        }

        const handle = await page.waitForFunction(
          (previousCount) => {
            const values = [];

            for (const selector of ['#cart_count', '#cart_count_sp']) {
              const element = document.querySelector(selector);

              if (!element) {
                continue;
              }

              const match = element.textContent?.match(/\d+/);

              if (match) {
                values.push(Number(match[0]));
              }
            }

            if (!values.length) {
              return false;
            }

            const current = Math.max(...values);

            if (previousCount === null) {
              return current > 0 ? current : false;
            }

            return current > previousCount ? current : false;
          },
          before,
          { timeout: CART_TIMEOUT_MS },
        );

        const after = Number(await handle.jsonValue());
        lastKnownCartCount = after;
        return after;
      } catch (error) {
        if (error.code === 'CART_FULL') {
          throw error;
        }

        if (alertMessage && isRetryableCartAlert(alertMessage) && attempt < 3) {
          outputLog(
            `  Retrying Dorasuta cart registration (${attempt + 1}/3)...`,
          );
          await page.waitForTimeout(1000);
          continue;
        }

        if (alertMessage) {
          throw createAlertError(alertMessage);
        }

        throw new Error(
          `Cart did not confirm an increased count: ${error.message}`,
        );
      }
    }
  } finally {
    page.off('dialog', handleDialog);
  }
}

export { isInsufficientStockAlert };

export {
  addToCartAndWait,
  chooseCondition,
  findConditionOptions,
  filterCandidatesByNumber,
  inspectProduct,
  isCompatibleCachedProduct,
  isExactMatch,
  isLastResortNumberAndTotalMatch,
  readCartContents,
  readCartEntries,
  readDorasutaCartTotal,
  readInitialCartCount,
  searchDorasuta,
  setQuantity,
  setInitialCartCount,
};
