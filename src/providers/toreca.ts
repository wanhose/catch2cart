/** TorecaCamp (Shopify) search, product and cart primitives. */

import type { Page } from 'playwright';
import { NAVIGATION_TIMEOUT_MS } from '../config.ts';
import { gotoAndWait } from '../browser.ts';
import { normalizeWhitespace, parseCollectorNumber } from '../cards.ts';

export const TORECA_URL = 'https://torecacamp-pokemon.com';
export const TORECA_SEARCH_URL = TORECA_URL + '/search';

export interface TorecaProductIdentity {
  productName: string;
  collectorNumber: string | null;
  totalNumber: string | null;
  setCode: string | null;
}

export function parseTorecaProductTitle(title: string): TorecaProductIdentity {
  const productName = normalizeWhitespace(title);
  const match = productName.match(
    /\b(\d+)\s*\/\s*([A-Za-z][A-Za-z0-9-]*|\d+)\b/,
  );
  const beforeNumber = match ? productName.slice(0, match.index) : productName;
  const suffix = match?.[2] ?? null;
  const setCode =
    (suffix && !/^\d+$/.test(suffix) ? suffix : null) ??
    beforeNumber?.match(/\b([A-Za-z]{1,6}\d+[A-Za-z]*)\s*$/)?.[1] ??
    null;

  return {
    productName,
    collectorNumber: match?.[1] ?? parseCollectorNumber(productName),
    totalNumber: suffix && /^\d+$/.test(suffix) ? suffix : null,
    setCode,
  };
}

/** Toreca lists graded/slabbed cards separately; they are never acceptable. */
export function isTorecaGradedProduct(title: string | null | undefined) {
  const normalized = normalizeWhitespace(title);
  return /\bPSA\s*\d{1,2}\b|\bBGS\s*\d{1,2}\b|\bCGC\s*\d{1,2}\b|鑑定(?:品|済)|ARS鑑定/i.test(
    normalized,
  );
}

/** Toreca also lists Pokémon TCG Metal Cards with the same number/total. */
export function isTorecaMetalCardProduct(title: string | null | undefined) {
  return /\bmetal\s*card\b|メタル\s*カード/i.test(normalizeWhitespace(title));
}

export function parseTorecaPrice(text: string | null | undefined) {
  const match = normalizeWhitespace(text).match(/[¥￥]\s*([\d,]+)/);
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

export function parseTorecaStock(text: string | null | undefined) {
  const normalized = normalizeWhitespace(text);
  if (/売り切れ|在庫なし|sold\s*out/i.test(normalized)) return 0;
  const match = normalized.match(/(?:在庫(?:数)?|残り)\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

export interface TorecaVariantOption {
  id: string;
  text: string;
  disabled?: boolean;
}

export function selectTorecaStateA(variants: TorecaVariantOption[]) {
  const variant = variants.find(
    (candidate) =>
      /【状態A】/.test(candidate.text) &&
      !/【状態A-】/.test(candidate.text) &&
      !candidate.disabled,
  );
  return variant
    ? { id: variant.id, price: parseTorecaPrice(variant.text) }
    : null;
}

export interface TorecaCartEntry {
  productId: string;
  url: string | null;
  productName: string;
  quantity: number;
  price: number | null;
}

export function parseTorecaCartItems(
  items: Array<{
    id?: number;
    variant_id?: number;
    url?: string;
    product_title?: string;
    title?: string;
    quantity?: number;
    final_price?: number;
  }>,
): TorecaCartEntry[] {
  return items.map((item) => ({
    productId: String(item.variant_id ?? item.id ?? ''),
    url: item.url ? new URL(item.url, TORECA_URL).href : null,
    productName: item.product_title ?? item.title ?? '',
    quantity: Number(item.quantity ?? 0),
    price: Number.isFinite(item.final_price)
      ? Number(item.final_price) / 100
      : null,
  }));
}

export async function searchToreca(page: Page, searchName: string) {
  const params = new globalThis.URLSearchParams({
    type: 'product',
    q: searchName,
    'options[prefix]': 'last',
    'options[unavailable_products]': 'last',
  });
  await gotoAndWait(page, TORECA_SEARCH_URL + '?' + params, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  return page
    .locator('.product-item')
    .evaluateAll((items) =>
      items
        .map((item) => {
          const titleLink = item.querySelector('.product-item__title');
          const title = titleLink?.textContent ?? '';
          const href = (titleLink as HTMLAnchorElement | null)?.href ?? '';
          const price =
            item.querySelector('.product-item__price-list')?.textContent ?? '';
          const stock =
            item.querySelector('.product-item__inventory')?.textContent ?? '';
          const id =
            item.querySelector('input[name="id"]')?.getAttribute('value') ??
            null;
          return { title, href, price, stock, id };
        })
        .filter((item) => item.href),
    )
    .then((items) =>
      items
        .filter(
          (item) =>
            !isTorecaGradedProduct(item.title) &&
            !isTorecaMetalCardProduct(item.title),
        )
        .map((item) => ({
          ...parseTorecaProductTitle(item.title),
          url: item.href,
          externalId: item.id,
          price: parseTorecaPrice(item.price),
          stock: parseTorecaStock(item.stock),
        })),
    );
}

export async function inspectTorecaProduct(page: Page, url: string) {
  await gotoAndWait(page, url, {
    waitUntil: 'domcontentloaded',
    timeout: NAVIGATION_TIMEOUT_MS,
  });

  const data = await page.evaluate(() => {
    const title =
      document.querySelector('h1.product-meta__title, h1.product-title')
        ?.textContent ??
      document
        .querySelector('meta[property="og:title"]')
        ?.getAttribute('content') ??
      '';
    const variants = [
      ...document.querySelectorAll('select[name="id"] option'),
    ].map((option) => ({
      id: option.getAttribute('value') ?? '',
      text: option.textContent ?? '',
      disabled: option.hasAttribute('disabled'),
    }));
    // This callback runs inside the browser page; module functions are not
    // available here, so keep the DOM-side selection self-contained.
    const stateA = variants.find(
      (variant) =>
        /【状態A】/.test(variant.text) &&
        !/【状態A-】/.test(variant.text) &&
        !variant.disabled,
    );
    const stateASwatch = document.querySelector(
      '.swatch-view-item[orig-value="【状態A】"]',
    );
    const stateAUnavailable = Boolean(
      stateASwatch?.classList.contains('swatch-item-unavailable') ||
      stateASwatch?.classList.contains('swatch-unavailable') ||
      stateASwatch?.getAttribute('aria-disabled') === 'true',
    );
    const hasStateA = Boolean(stateA || stateASwatch);
    const stockText =
      document.querySelector(
        '.product-form__inventory, .product-meta__inventory',
      )?.textContent ?? '';
    const addable = Boolean(
      document.querySelector(
        'form[action="/cart/add"] button[type="submit"]:not([disabled]), form[action="/cart/add"] [data-action="add-to-cart"]:not([disabled]), form[action="/cart/add"] .product-form__add-button:not([disabled])',
      ),
    );
    return {
      title,
      variantId:
        stateA?.id ?? stateASwatch?.getAttribute('option-value-id') ?? null,
      stateAPrice: stateA?.text ?? stateASwatch?.textContent ?? '',
      stateAUnavailable,
      hasStateA,
      stockText,
      addable,
      url: globalThis.location.href,
    };
  });

  const parsed = parseTorecaProductTitle(data.title);
  const stock = parseTorecaStock(data.stockText);
  return {
    ...parsed,
    url: data.url,
    externalId: data.variantId,
    price: parseTorecaPrice(data.stateAPrice),
    stock: !data.hasStateA || data.stateAUnavailable ? 0 : stock,
    addable:
      data.hasStateA &&
      Boolean(data.variantId) &&
      data.addable &&
      !data.stateAUnavailable,
    hasStateA: data.hasStateA,
    stateAVariantId: data.variantId,
    isGraded: isTorecaGradedProduct(data.title),
  };
}

export async function readTorecaCartEntries(
  page: Page,
): Promise<TorecaCartEntry[]> {
  const cart = await page.evaluate(async () => {
    const response = await globalThis.fetch('/cart.js', {
      credentials: 'same-origin',
    });
    if (!response.ok)
      throw new Error(
        `Toreca cart request failed with HTTP ${response.status}.`,
      );
    return response.json();
  });
  return parseTorecaCartItems(cart.items ?? []);
}

export async function addTorecaToCart(
  page: Page,
  quantity: number,
  variantId: string,
) {
  const stateASwatch = page
    .locator(
      'li.swatch-view-item[orig-value="【状態A】"]:not(.swatch-item-unavailable):not([aria-disabled="true"])',
    )
    .filter({ visible: true })
    .first();

  if (await stateASwatch.count()) {
    await stateASwatch.click({ force: true });
  }

  const variantSelect = page.locator('select[name="id"]').first();
  if (!(await stateASwatch.count()) && (await variantSelect.count())) {
    const availableOptions = await variantSelect
      .locator('option')
      .evaluateAll((options) => {
        return options
          .filter((candidate) => !candidate.hasAttribute('disabled'))
          .map((candidate) => ({
            value: candidate.getAttribute('value') ?? '',
            text: candidate.textContent?.replace(/\s+/g, ' ').trim() ?? '',
          }));
      });
    const exactStateAValue = availableOptions.find(
      (option) =>
        /^【状態A】(?:\s*-|$)/.test(option.text) &&
        !/【状態A-】/.test(option.text),
    )?.value;
    const selectedValue = await variantSelect.inputValue();
    const targetValue =
      exactStateAValue ||
      availableOptions.find((option) => option.value === variantId)?.value;

    if (targetValue && selectedValue !== targetValue) {
      await variantSelect.selectOption(targetValue);
    } else if (!targetValue) {
      throw new Error('Toreca state A is unavailable.');
    }
  } else if (!(await stateASwatch.count())) {
    const stateA = page.locator(
      '.swatch-view-item[orig-value="【状態A】"]:not(.swatch-item-unavailable)',
    );
    if (!(await stateA.count()))
      throw new Error('Toreca state A selector not found.');
    await stateA.filter({ visible: true }).first().click({ force: true });
  }

  const quantityInput = page
    .locator('form[action="/cart/add"] input[name="quantity"]')
    .first();
  if (await quantityInput.count()) await quantityInput.fill(String(quantity));

  const button = page
    .locator(
      'form[action="/cart/add"] button[type="submit"], form[action="/cart/add"] [data-action="add-to-cart"], .product-form__add-button',
    )
    .first();
  if (!(await button.count()))
    throw new Error('Toreca add-to-cart button not found.');
  await button.click();
  await page.waitForTimeout(500);
}

export async function readTorecaCartTotal(page: Page) {
  const cart = await page.evaluate(async () =>
    (await globalThis.fetch('/cart.js')).json(),
  );
  return Number.isFinite(cart.total_price)
    ? Number(cart.total_price) / 100
    : null;
}
