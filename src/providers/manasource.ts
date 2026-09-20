/**
 * ManaSource provider adapter.
 *
 * ManaSource has two useful entry points: direct keyword search and collection
 * pages (`/product-list/<id>`). Product pages expose the title, price, stock,
 * quantity selector and a POST form that redirects to `/cart` after adding.
 *
 * This adapter is intentionally kept separate from Dorasuta. The workflow can
 * compare normalized offers later without sharing provider-specific selectors.
 */

import type { Page } from 'playwright';
import { NAVIGATION_TIMEOUT_MS } from '../config.ts';
import { gotoAndWait } from '../browser.ts';
import { normalizeWhitespace } from '../cards.ts';

export const MANASOURCE_URL = 'https://www.manasource.net';
export const MANASOURCE_CART_URL = `${MANASOURCE_URL}/cart`;
export const MANASOURCE_SEARCH_URL = `${MANASOURCE_URL}/product-list`;

export interface ManaSourceProduct {
  url: string;
  externalId: string | null;
  productName: string;
  setCode: string | null;
  collectorNumber: string | null;
  totalNumber: string | null;
  price: number | null;
  stock: number | null;
}

/** Product identity parsed from ManaSource's Japanese title format. */
export function parseManaSourceProductTitle(title: string) {
  const normalized = normalizeWhitespace(title);
  const match = normalized.match(
    /^【([^】]+)】\s*(.*?)\s+(\d+)\/([A-Za-z0-9-]+)$/,
  );

  if (!match) {
    return {
      productName: normalized,
      setCode: null,
      collectionName: null,
      collectorNumber: null,
      totalNumber: null,
    };
  }

  const setCode = match[1].trim();
  const collectionName = setCode
    .replace(
      /\s+(?:C|U|R|RR|RRR|AR|SR|SAR|UR|CHR|CSR|S|ACE SPEC|\d+R)\s*$/i,
      '',
    )
    .trim();

  return {
    productName: normalized,
    setCode,
    collectionName,
    collectorNumber: match[3],
    totalNumber: match[4],
  };
}

export function parseManaSourcePrice(text: string | null | undefined) {
  const match = normalizeWhitespace(text).match(/[\d,]+/);

  return match ? Number(match[0].replaceAll(',', '')) : null;
}

/**
 * Parse only explicit quantities. `在庫わずか` is deliberately unknown: it
 * means low stock, but the site does not disclose how many units remain.
 */
export function parseManaSourceStock(text: string | null | undefined) {
  const match = normalizeWhitespace(text).match(
    /(?:在庫数|stock)\s*[：:]?\s*(\d+)/i,
  );

  return match ? Number(match[1]) : null;
}

export function parseManaSourceProductId(url: string) {
  return url.match(/\/product\/(\d+)/)?.[1] ?? null;
}

/** Convert product-page quantity options into selectable quantities. */
export function parseManaSourceQuantityOptions(values: string[]) {
  return [
    ...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ].sort((a, b) => a - b);
}

/** Parse the red header badge, which counts cart items globally. */
export function parseManaSourceCartCount(text: string | null | undefined) {
  const match = normalizeWhitespace(text).match(/\d+/);

  return match ? Number(match[0]) : null;
}

/** Extract product cards from a loaded ManaSource list page. */
async function readListProducts(page: Page): Promise<ManaSourceProduct[]> {
  return page.locator('.item_data_link').evaluateAll((links) => {
    const parseTitle = (title: string) => {
      const normalized = title.replace(/\s+/g, ' ').trim();
      const match = normalized.match(
        /^【([^】]+)】\s*(.*?)\s+(\d+)\/([A-Za-z0-9-]+)$/,
      );

      return match
        ? {
            productName: normalized,
            setCode: match[1].trim(),
            collectionName: match[1]
              .trim()
              .replace(
                /\s+(?:C|U|R|RR|RRR|AR|SR|SAR|UR|CHR|CSR|S|ACE SPEC|\d+R)\s*$/i,
                '',
              )
              .trim(),
            collectorNumber: match[3],
            totalNumber: match[4],
          }
        : {
            productName: normalized,
            setCode: null,
            collectionName: null,
            collectorNumber: null,
            totalNumber: null,
          };
    };

    const parsePrice = (text: string | null | undefined) => {
      const match = String(text ?? '').match(/[\d,]+/);

      return match ? Number(match[0].replaceAll(',', '')) : null;
    };

    const parseStock = (text: string | null | undefined) => {
      const match = String(text ?? '').match(
        /(?:在庫数|stock)\s*[：:]?\s*(\d+)/i,
      );

      return match ? Number(match[1]) : null;
    };

    return links.map((link) => {
      const href = (link as HTMLAnchorElement).href;
      const container = link.closest('.list_item_cell') ?? link;
      const title = container.querySelector('.goods_name')?.textContent ?? '';
      const price = container.querySelector(
        '.selling_price .figure',
      )?.textContent;
      const stock = container.querySelector('.stock')?.textContent;

      return {
        url: href,
        externalId: href.match(/\/product\/(\d+)/)?.[1] ?? null,
        ...parseTitle(title),
        price: parsePrice(price),
        stock: parseStock(stock),
      };
    });
  });
}

interface ManaSourceListOptions {
  page?: number;
  sortByPrice?: boolean;
}

async function searchListPage(
  page: Page,
  url: string,
): Promise<ManaSourceProduct[]> {
  await gotoAndWait(page, url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  return readListProducts(page);
}

/** Search ManaSource directly by keyword, avoiding collection traversal. */
export async function searchManaSource(
  page: Page,
  searchName: string,
  options: ManaSourceListOptions = {},
) {
  const params = new globalThis.URLSearchParams({
    keyword: searchName,
    num: '120',
    ...(options.sortByPrice ? { order: 'asc' } : {}),
    ...(options.page && options.page > 1 ? { page: String(options.page) } : {}),
  });

  return searchListPage(page, `${MANASOURCE_SEARCH_URL}?${params}`);
}

/** Build a collection URL for a future collection-first search strategy. */
export function getManaSourceCollectionUrl(collectionId: string | number) {
  return `${MANASOURCE_SEARCH_URL}/${collectionId}`;
}

/** Search a ManaSource collection page, with optional pagination and price sort. */
export async function searchManaSourceCollection(
  page: Page,
  collectionId: string | number,
  options: ManaSourceListOptions = {},
) {
  const params = new globalThis.URLSearchParams({
    ...(options.sortByPrice ? { sort: 'price' } : {}),
    ...(options.page && options.page > 1 ? { page: String(options.page) } : {}),
  });
  const query = params.toString();
  const url = `${getManaSourceCollectionUrl(collectionId)}${query ? `?${query}` : ''}`;

  return searchListPage(page, url);
}

/** Inspect a ManaSource product detail page and expose normalized offer data. */
export async function inspectManaSourceProduct(page: Page, url: string) {
  await gotoAndWait(page, url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const readOptionalText = async (selector: string) => {
    const locator = page.locator(selector).first();

    return (await locator.count()) ? locator.textContent() : null;
  };
  const title = await readOptionalText('.goods_name');
  const price = await readOptionalText('#pricech, .selling_price .figure');
  const stock = await readOptionalText(
    '.detail_block_stock .stock, .detail_block_stock',
  );
  const identity = parseManaSourceProductTitle(title ?? (await page.title()));
  const externalId = parseManaSourceProductId(url);

  const addButton = page.locator('#productadd #submit_cart_input_btn');
  const quantitySelect = externalId
    ? page.locator('#cart_addquantity_' + externalId)
    : page.locator('#purchase_qty select');
  const availableQuantity = (await quantitySelect.count())
    ? await quantitySelect.locator('option').evaluateAll((options) => {
        const quantities = options
          .map((option) => Number(option.getAttribute('value') ?? ''))
          .filter((value) => Number.isInteger(value) && value > 0);

        return [...new Set(quantities)].sort((a, b) => a - b);
      })
    : [];

  return {
    provider: 'manasource' as const,
    url,
    externalId,
    ...identity,
    price: parseManaSourcePrice(price),
    stock: parseManaSourceStock(stock),
    availableQuantity: availableQuantity.at(-1) ?? 0,
    addable: (await addButton.count()) > 0,
    quantitySelector: externalId
      ? `#cart_addquantity_${externalId}`
      : '#purchase_qty select',
    addButtonSelector: '#submit_cart_input_btn',
  };
}

/** Read ManaSource's tax-inclusive product total from the cart summary. */
export async function readManaSourceCartTotal(page: Page) {
  await gotoAndWait(page, MANASOURCE_CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const text = await page.locator('#subtotal').first().textContent();
  const match = normalizeWhitespace(text ?? '').match(/[\d,]+/);

  return match ? Number(match[0].replaceAll(',', '')) : null;
}

/**
 * Read ManaSource cart quantities by product ID.
 *
 * The cart page exposes one .cart_data_box per product. Its quantity control
 * is select.cart_quantity[name="cart_quantity_<productId>"]. The header
 * counter is global and is intentionally not used as a per-card quantity.
 */
export async function readManaSourceCart(page: Page) {
  const entries = await readManaSourceCartEntries(page);
  return Object.fromEntries(
    entries.map((entry) => [entry.productId, entry.quantity]),
  );
}

export async function readManaSourceCartEntries(page: Page) {
  await gotoAndWait(page, MANASOURCE_CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  return page.evaluate(() => {
    const result = [];

    for (const link of document.querySelectorAll('a[href*="/product/"]')) {
      const href = (link as HTMLAnchorElement).href;
      const productId = href.match(/\/product\/(\d+)/)?.[1];

      if (!productId) {
        continue;
      }

      const container =
        link.closest('.cart_data_box') ??
        link.closest(
          '.cart_item, .cart_list_item, .cart_item_cell, .list_item_cell, tr',
        ) ??
        link.parentElement;
      const productName =
        container?.querySelector('.goods_name')?.textContent ??
        link.textContent ??
        '';
      const control = container?.querySelector(
        'select.cart_quantity[name="cart_quantity_' +
          productId +
          '"], select[name="cart_quantity_' +
          productId +
          '"]',
      ) as HTMLInputElement | HTMLSelectElement | null;
      const quantity = Number(control?.value ?? '');

      if (Number.isInteger(quantity) && quantity > 0) {
        result.push({
          productId,
          url: href,
          productName: productName.replace(/\s+/g, ' ').trim(),
          quantity,
        });
      }
    }

    return Object.values(result);
  });
}

/** Read the global header badge without confusing it with a card quantity. */
export async function readManaSourceCartCount(page: Page) {
  const headerCount = parseManaSourceCartCount(
    await page.locator('.cart_qty .cart_item_quantity').first().textContent(),
  );

  if (headerCount !== null) {
    return headerCount;
  }

  return page.evaluate(() => {
    for (const script of document.scripts) {
      const match = script.textContent?.match(
        /globalObj\.cartItemCnt\s*=\s*(\d+)/,
      );

      if (match) {
        return Number(match[1]);
      }
    }

    return null;
  });
}

/** Set the quantity and submit ManaSource's product form. */
export async function addManaSourceToCart(
  page: Page,
  productId: string,
  quantity: number,
) {
  const select = page.locator(`#cart_addquantity_${productId}`);
  const addButton = page.locator('#productadd #submit_cart_input_btn');

  if (!(await addButton.count())) {
    throw new Error(
      `ManaSource product ${productId} is unavailable or sold out; add button not found.`,
    );
  }

  if (await select.count()) {
    const available = await select.locator('option').evaluateAll((options) => {
      const quantities = options
        .map((option) => Number(option.getAttribute('value') ?? ''))
        .filter((value) => Number.isInteger(value) && value > 0);

      return [...new Set(quantities)].sort((a, b) => a - b);
    });

    if (!available.includes(quantity)) {
      throw new Error(
        'ManaSource quantity ' +
          quantity +
          ' is not available; maximum selectable quantity is ' +
          (available.at(-1) ?? 0) +
          '.',
      );
    }

    await select.selectOption(String(quantity));
  } else if (quantity !== 1) {
    throw new Error(`ManaSource quantity selector missing for ${quantity}.`);
  }

  await addButton.click();

  if (!/\/cart(?:[/?#]|$)/.test(page.url())) {
    await page.waitForURL(/\/cart(?:[/?#]|$)/, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  }

  return page.url();
}
