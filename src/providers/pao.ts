/** PAO search, product and cart primitives. */

import type { Page } from 'playwright';
import { NAVIGATION_TIMEOUT_MS } from '../config.ts';
import { gotoAndWait } from '../browser.ts';
import { normalizeWhitespace, parseCollectorNumber } from '../cards.ts';
import type { ProviderCartEntry } from './matching.ts';

export const PAO_URL = 'https://pao-onlineshop.com';
export const PAO_SEARCH_URL = PAO_URL + '/view/search';
export const PAO_CART_URL = PAO_URL + '/view/cart';

export interface PaoProductIdentity {
  productName: string;
  collectorNumber: string | null;
  totalNumber: string | null;
  setCode: string | null;
}

export function parsePaoProductTitle(title: string): PaoProductIdentity {
  const productName = normalizeWhitespace(title);
  const numberAndIdentity = productName.match(
    /(\d+)\s*\/\s*([A-Za-z][A-Za-z0-9-]*|\d+)/,
  );
  const suffix = numberAndIdentity?.[2] ?? null;

  return {
    productName,
    collectorNumber:
      numberAndIdentity?.[1] ?? parseCollectorNumber(productName),
    totalNumber: suffix && /^\d+$/.test(suffix) ? suffix : null,
    setCode: suffix && !/^\d+$/.test(suffix) ? suffix : null,
  };
}

export function parsePaoPrice(text: string | null | undefined) {
  const match = normalizeWhitespace(text).match(/[\d,]+/);
  return match ? Number(match[0].replaceAll(',', '')) : null;
}

export function parsePaoStock(text: string | null | undefined) {
  const normalized = normalizeWhitespace(text);
  if (/在庫なし|売り切れ|品切れ|sold\s*out/i.test(normalized)) return 0;
  const match = normalized.match(/残りあと\s*(\d+)\s*個/);
  return match ? Number(match[1]) : null;
}

export function parsePaoCartRows(
  rows: Array<{ id: string; quantity: string; price: string }>,
) {
  const parsed: Record<string, { quantity: number; price: number | null }> = {};

  for (const row of rows) {
    const rawId = row.id.replace(/^makeshop-common-cart-quantity:/, '');
    const id = rawId.match(/^\d+/)?.[0] ?? '';
    const quantity = Number(row.quantity);

    if (id && Number.isInteger(quantity) && quantity > 0) {
      parsed[id] = { quantity, price: parsePaoPrice(row.price) };
    }
  }

  return parsed;
}

export async function searchPao(page: Page, searchName: string) {
  const params = new globalThis.URLSearchParams({
    search_keyword: searchName,
    sort: 'price',
  });
  await gotoAndWait(page, PAO_SEARCH_URL + '?' + params, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  return page
    .locator('.itemList__unit .itemWrap[href*="/view/item/"]')
    .evaluateAll((links) =>
      links.map((link) => {
        const title = link.querySelector('.itemName')?.textContent ?? '';
        const price =
          link.querySelector('.itemPrice--sale, .itemPrice')?.textContent ?? '';
        const href = (link as HTMLAnchorElement).href;
        const identity = title
          .replace(/\s+/g, ' ')
          .trim()
          .match(/(\d+)\s*\/\s*([A-Za-z][A-Za-z0-9-]*|\d+)/);
        const suffix = identity?.[2] ?? null;
        return {
          url: href,
          externalId: href.match(/\/view\/item\/(\d+)/)?.[1] ?? null,
          productName: title.replace(/\s+/g, ' ').trim(),
          collectorNumber: identity?.[1] ?? null,
          totalNumber: suffix && /^\d+$/.test(suffix) ? suffix : null,
          setCode: suffix && !/^\d+$/.test(suffix) ? suffix : null,
          price:
            Number((price.match(/[\d,]+/)?.[0] ?? '').replaceAll(',', '')) ||
            null,
        };
      }),
    );
}

export async function inspectPaoProduct(page: Page, url: string) {
  await gotoAndWait(page, url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const data = await page.locator('h1.itemName--detail').evaluate((title) => ({
    title: title.textContent ?? '',
    price: document.querySelector('.itemPrice--detail')?.textContent ?? '',
    stock:
      document.querySelector('.item-stock, .itemstock, .soldout--detail')
        ?.textContent ?? '',
    soldOut: Boolean(
      document.querySelector(
        '.soldout--detail, [itemprop="availability"][content*="SoldOut"]',
      ),
    ),
    addable: Boolean(
      document.querySelector('.addCartArea .addCartBtn[href*=cart-entry]'),
    ),
    url: globalThis.location.href,
  }));
  return {
    ...parsePaoProductTitle(data.title),
    url: data.url,
    price: parsePaoPrice(data.price),
    stock: data.soldOut ? 0 : parsePaoStock(data.stock),
    addable: data.addable,
    externalId: data.url.match(/\/view\/item\/(\d+)/)?.[1] ?? null,
  };
}

export async function readPaoCart(page: Page) {
  const entries = await readPaoCartEntries(page);
  return Object.fromEntries(entries.map((entry) => [entry.productId, entry]));
}

export function dedupePaoCartEntries(entries: ProviderCartEntry[]) {
  const uniqueEntries = new Map<string, ProviderCartEntry>();

  for (const entry of entries) {
    if (entry.productId && !uniqueEntries.has(entry.productId)) {
      uniqueEntries.set(entry.productId, entry);
    }
  }

  return [...uniqueEntries.values()];
}

export function parsePaoCartEntries(
  rows: Array<{
    id: string;
    quantity: string;
    productName: string;
    url: string | null;
    price: string;
  }>,
) {
  return dedupePaoCartEntries(
    rows.map((row) => {
      const id = row.id.replace(/^makeshop-common-cart-quantity:/, '');
      return {
        productId: id.match(/^\d+/)?.[0] ?? '',
        url: row.url,
        productName: row.productName,
        quantity: Number(row.quantity),
        price: parsePaoPrice(row.price),
      };
    }),
  );
}

export function getPaoCartProductName(
  linkText: string | null | undefined,
  imageAlt: string | null | undefined,
) {
  return normalizeWhitespace(linkText) || normalizeWhitespace(imageAlt);
}

export async function readPaoCartEntries(page: Page) {
  await gotoAndWait(page, PAO_CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const rows = await page
    .locator(
      '[data-id^="makeshop-common-cart-quantity:"], .section.list .element input[name="quantity"]',
    )
    .evaluateAll((inputs) =>
      inputs.map((input) => {
        const container =
          input.closest('tr') ??
          input.closest('.cart-item, .cart_list_item, .item-cart') ??
          input.closest('.element') ??
          input.parentElement;
        const link = container?.querySelector(
          'a[href*="/view/item/"], a[href*="/pokemon-card/product"]',
        ) as HTMLAnchorElement | null;
        const title = container?.querySelector('.item-cart-title');
        const image = container?.querySelector('img[alt]');
        const href = link?.href ?? null;
        const productId =
          input.getAttribute('data-id') ??
          href?.match(/[?&]pid=(\d+)/)?.[1] ??
          href?.match(/\/view\/item\/(\d+)/)?.[1] ??
          '';
        const productName = (
          title?.textContent ||
          link?.textContent ||
          image?.getAttribute('alt') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();

        return {
          id: productId,
          quantity: (input as HTMLInputElement | HTMLSelectElement).value,
          productName,
          url: href,
          price:
            container?.querySelector('.item-cart-price')?.textContent ??
            [...(container?.querySelectorAll('li') ?? [])].at(-1)
              ?.textContent ??
            '',
        };
      }),
    );
  return parsePaoCartEntries(rows);
}

/** Add a verified quantity from the current PAO product page to the cart. */
export async function addPaoToCart(
  page: Page,
  quantity: number,
  productId?: string,
) {
  const quantitySelect = page
    .locator(
      '.addCartArea select, select[name*=quantity], select[id*=quantity]',
    )
    .first();
  const addButton = page
    .locator('.addCartArea .addCartBtn[href*=cart-entry], a[href*=cart-entry]')
    .first();

  if (!(await addButton.count())) {
    throw new Error(
      'PAO product is unavailable or sold out; add button not found.',
    );
  }

  if (await quantitySelect.count()) {
    const available = await quantitySelect
      .locator('option')
      .evaluateAll((options) =>
        options
          .map((option) => Number(option.getAttribute('value') ?? ''))
          .filter((value) => Number.isInteger(value) && value > 0),
      );

    if (!available.includes(quantity)) {
      throw new Error(
        `PAO quantity ${quantity} is not available; maximum selectable quantity is ${available.at(-1) ?? 0}.`,
      );
    }

    await quantitySelect.selectOption(String(quantity));
  } else if (quantity !== 1) {
    throw new Error(`PAO quantity selector missing for ${quantity}.`);
  }

  await addButton.click();
  // PAO handles `#makeshop-common-cart-entry-url:*` through AJAX and keeps
  // the product URL. Navigate to the cart only after that request can finish.
  await page.waitForTimeout(500);
  await gotoAndWait(page, PAO_CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  if (productId) {
    const found = await page
      .locator('[data-id^="makeshop-common-cart-quantity:"]')
      .evaluateAll(
        (inputs, wantedProductId) =>
          inputs.some((input) =>
            (input.getAttribute('data-id') ?? '').includes(wantedProductId),
          ),
        productId,
      );

    if (!found) {
      throw new Error('PAO cart did not confirm the product was added.');
    }
  }
}

/** Read PAO's current cart total, if the cart exposes one. */
export async function readPaoCartTotal(page: Page) {
  await gotoAndWait(page, PAO_CART_URL, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  const text = await page
    .locator('.cart-total, .item-cart-total, .cartTotal, [class*="total"]')
    .allTextContents();
  const values = text
    .map((value) => parsePaoPrice(value))
    .filter((value): value is number => value !== null);

  return values.at(-1) ?? null;
}
