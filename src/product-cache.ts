import { readFile, unlink, writeFile } from 'node:fs/promises';
import {
  CLEAR_PRODUCT_CACHE,
  PRODUCT_CACHE_FILE,
  LEGACY_PRODUCT_CACHE_FILES,
  USE_PRODUCT_CACHE,
  PRODUCT_CACHE_TTL_HOURS,
} from './config.ts';
import { normalizeNumber, normalizeWhitespace } from './cards.ts';
import { outputLog } from './output.ts';

export interface ProductAvailability {
  availableQuantity: number;
  checkedAt: string;
}

export interface ProductResolution {
  status: string;
  checkedAt: string;
}

export interface ProductCacheEntry {
  urls: string[];
  source?: string;
  searchName?: string;
  availability?: Record<string, ProductAvailability>;
  resolution?: Record<string, ProductResolution>;
}

let productCache = new Map<string, ProductCacheEntry>();

/** Build the provider-neutral key shared by every product adapter. */
export function getProductCacheKey(card: {
  set: string;
  number: string;
  cardmarketName: string;
}) {
  return [
    card.set,
    normalizeNumber(card.number),
    normalizeWhitespace(card.cardmarketName).toLowerCase(),
  ].join(':');
}

/** Normalize pasted URLs and remove Markdown link wrappers if present. */
export function normalizeCachedProductUrl(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const markdown = value.match(/^\[[^\]]+\]\((https?:\/\/[^)]+)\)$/);
  const url = (markdown?.[1] ?? value).replaceAll('\\:', ':').trim();

  return /^https?:\/\//.test(url) ? url : null;
}

/** Read current multi-URL entries and legacy single-URL entries. */
export function getCachedProductUrls(entry: unknown) {
  const values =
    typeof entry === 'string'
      ? [entry]
      : entry && typeof entry === 'object'
        ? [
            ...((Array.isArray((entry as { urls?: unknown[] }).urls)
              ? (entry as { urls: unknown[] }).urls
              : []) as unknown[]),
            (entry as { url?: unknown }).url,
          ]
        : [];

  return [
    ...new Set(
      values
        .map((value) => normalizeCachedProductUrl(value))
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

/** Backwards-compatible first URL helper for adapters still using one URL. */
export function getCachedProductUrl(entry: unknown) {
  return getCachedProductUrls(entry)[0] ?? null;
}

/** Return only URLs belonging to one provider hostname when needed. */
export function getCachedProductUrlsForProvider(
  entry: unknown,
  hostname: string,
) {
  return getCachedProductUrls(entry).filter((url) => {
    try {
      return new URL(url).hostname === hostname;
    } catch {
      return false;
    }
  });
}

export function getProductCacheEntry(key: string) {
  return productCache.get(key);
}

export const getCachedProductEntry = getProductCacheEntry;

export function getCachedProductSearchName(entry: unknown) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const value = (entry as { searchName?: unknown }).searchName;

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Return a provider's cached availability when its TTL is still valid. */
export function getCachedProductAvailability(
  entry: unknown,
  hostname: string,
): ProductAvailability | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const availability = (entry as { availability?: unknown }).availability;
  const value =
    availability && typeof availability === 'object'
      ? (availability as Record<string, unknown>)[hostname]
      : null;

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const availableQuantity = record.availableQuantity;
  const checkedAt = record.checkedAt;
  const timestamp = typeof checkedAt === 'string' ? Date.parse(checkedAt) : NaN;

  if (
    typeof availableQuantity !== 'number' ||
    !Number.isInteger(availableQuantity) ||
    availableQuantity < 0 ||
    typeof checkedAt !== 'string' ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  if (
    PRODUCT_CACHE_TTL_HOURS > 0 &&
    Date.now() - timestamp > PRODUCT_CACHE_TTL_HOURS * 60 * 60 * 1000
  ) {
    return null;
  }

  return { availableQuantity, checkedAt };
}

/** Return a provider's fresh negative search result, if one was cached. */
export function getCachedProductResolution(
  entry: unknown,
  hostname: string,
): ProductResolution | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const resolution = (entry as { resolution?: unknown }).resolution;
  const value =
    resolution && typeof resolution === 'object'
      ? (resolution as Record<string, unknown>)[hostname]
      : null;

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const timestamp =
    typeof record.checkedAt === 'string' ? Date.parse(record.checkedAt) : NaN;

  if (
    typeof record.status !== 'string' ||
    !record.status ||
    typeof record.checkedAt !== 'string' ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  if (
    PRODUCT_CACHE_TTL_HOURS > 0 &&
    Date.now() - timestamp > PRODUCT_CACHE_TTL_HOURS * 60 * 60 * 1000
  ) {
    return null;
  }

  return { status: record.status, checkedAt: record.checkedAt };
}

/** Store a safe negative search result without associating an incorrect URL. */
export async function cacheProductResolution(
  card: { set: string; number: string; cardmarketName: string },
  hostname: string,
  status: string,
  searchName?: string,
) {
  if (!USE_PRODUCT_CACHE) {
    return;
  }

  const key = getProductCacheKey(card);
  const previous = productCache.get(key);
  const resolution = { ...(previous?.resolution ?? {}) };

  resolution[hostname] = {
    status,
    checkedAt: new Date().toISOString(),
  };

  productCache.set(key, {
    urls: previous?.urls ?? [],
    source: previous?.source ?? 'search',
    searchName: searchName ?? previous?.searchName,
    availability: previous?.availability,
    resolution,
  });

  await saveProductCache();
}

/** Store the latest verified stock state for one provider without losing URLs. */
export async function cacheProductAvailability(
  card: { set: string; number: string; cardmarketName: string },
  hostname: string,
  availableQuantity: number,
) {
  if (!USE_PRODUCT_CACHE) {
    return;
  }

  const key = getProductCacheKey(card);
  const previous = productCache.get(key);
  const availability = { ...(previous?.availability ?? {}) };

  availability[hostname] = {
    availableQuantity: Math.max(0, Math.floor(availableQuantity)),
    checkedAt: new Date().toISOString(),
  };

  productCache.set(key, {
    urls: previous?.urls ?? [],
    source: previous?.source ?? 'availability',
    searchName: previous?.searchName,
    availability,
    resolution: previous?.resolution,
  });

  await saveProductCache();
}

/** Add a URL without losing manually supplied URLs for other providers. */
export async function cacheProduct(
  card: { set: string; number: string; cardmarketName: string },
  product: { url: string },
  searchName?: string,
) {
  if (!USE_PRODUCT_CACHE) {
    return;
  }

  const key = getProductCacheKey(card);
  const previous = productCache.get(key);
  const url = normalizeCachedProductUrl(product.url);

  if (!url) {
    return;
  }

  const resolution = { ...(previous?.resolution ?? {}) };

  try {
    delete resolution[new URL(url).hostname];
  } catch {
    // URL validation already happened above; retain a stale resolution safely.
  }

  productCache.set(key, {
    urls: [...new Set([...(previous?.urls ?? []), url])],
    source: previous?.source ?? 'search',
    searchName: searchName ?? previous?.searchName,
    availability: previous?.availability,
    resolution: Object.keys(resolution).length ? resolution : undefined,
  });

  await saveProductCache();
}

/** Load, normalize and migrate all supported product-cache formats. */
export async function loadProductCache() {
  if (CLEAR_PRODUCT_CACHE) {
    try {
      await unlink(PRODUCT_CACHE_FILE);
      outputLog(`Product cache deleted: ${PRODUCT_CACHE_FILE}`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        outputLog(`Could not delete product cache (${error.message}).`);
      }
    }
  }

  if (!USE_PRODUCT_CACHE) {
    return;
  }

  try {
    let cacheFile = PRODUCT_CACHE_FILE;
    let contents: string;

    try {
      contents = await readFile(cacheFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }

      let migrated = false;

      for (const legacyFile of LEGACY_PRODUCT_CACHE_FILES) {
        if (legacyFile === PRODUCT_CACHE_FILE) {
          continue;
        }

        try {
          contents = await readFile(legacyFile, 'utf8');
          cacheFile = legacyFile;
          outputLog('Migrating legacy product cache: ' + cacheFile);
          migrated = true;
          break;
        } catch (legacyError) {
          if (legacyError.code !== 'ENOENT') {
            throw legacyError;
          }
        }
      }

      if (!migrated) {
        throw error;
      }
    }

    const cached = JSON.parse(contents);

    if (
      cached?.products &&
      typeof cached.products === 'object' &&
      !Array.isArray(cached.products)
    ) {
      productCache = new Map(
        Object.entries(cached.products).map(([key, value]) => [
          key,
          normalizeProductCacheEntry(value),
        ]),
      );

      outputLog(
        `Using product cache: ${cacheFile} ` + `(${productCache.size} entries)`,
      );
      return;
    }

    outputLog(`Ignoring invalid product cache: ${PRODUCT_CACHE_FILE}`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      outputLog(
        `Product cache not found. It will be created as matches are found: ${PRODUCT_CACHE_FILE}`,
      );
      await saveProductCache();
    } else {
      outputLog(
        `Could not read product cache (${error.message}). Starting empty.`,
      );
    }
  }
}

function normalizeProductAvailability(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const result: Record<string, ProductAvailability> = {};

  for (const [hostname, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;

    if (
      Number.isInteger(record.availableQuantity) &&
      (record.availableQuantity as number) >= 0 &&
      typeof record.checkedAt === 'string'
    ) {
      result[hostname] = {
        availableQuantity: record.availableQuantity as number,
        checkedAt: record.checkedAt,
      };
    }
  }

  return Object.keys(result).length ? result : undefined;
}

function normalizeProductResolution(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const result: Record<string, ProductResolution> = {};

  for (const [hostname, item] of Object.entries(value)) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    const record = item as Record<string, unknown>;

    if (
      typeof record.status === 'string' &&
      typeof record.checkedAt === 'string'
    ) {
      result[hostname] = {
        status: record.status,
        checkedAt: record.checkedAt,
      };
    }
  }

  return Object.keys(result).length ? result : undefined;
}

function normalizeProductCacheEntry(value: unknown): ProductCacheEntry {
  const object =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const urls = getCachedProductUrls(object);

  return {
    urls,
    source: typeof object.source === 'string' ? object.source : 'migration',
    searchName:
      typeof object.searchName === 'string' ? object.searchName : undefined,
    availability: normalizeProductAvailability(object.availability),
    resolution: normalizeProductResolution(object.resolution),
  };
}

async function saveProductCache() {
  if (!USE_PRODUCT_CACHE) {
    return;
  }

  try {
    await writeFile(
      PRODUCT_CACHE_FILE,
      `${JSON.stringify(
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          products: Object.fromEntries(productCache),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  } catch (error) {
    outputLog(`Warning: could not write product cache (${error.message}).`);
  }
}
