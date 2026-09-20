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

export interface ProductOfferSnapshot {
  url: string | null;
  price: number | null;
  stock: number | null;
  available: boolean;
  checkedAt: string;
}

export interface ProductProviderCache {
  selectedUrl?: string;
  resolution?: ProductResolution;
  offers: ProductOfferSnapshot[];
}

export interface ProductCacheEntry {
  searchName?: string;
  providers?: Record<string, ProductProviderCache>;
  /** @deprecated Read-only compatibility fields for pre-normalized callers. */
  urls?: string[];
  availability?: Record<string, ProductAvailability>;
  resolution?: Record<string, ProductResolution>;
  offers?: Record<string, ProductOfferSnapshot[]>;
}

let productCache = new Map<string, ProductCacheEntry>();
let productCacheWriteQueue = Promise.resolve();

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

/** Use one cache key for hosts with and without a leading `www.`. */
export function normalizeProductHostname(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '');
}

function getHostname(url: string) {
  try {
    return normalizeProductHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

function getProviderCache(entry: unknown, hostname: string) {
  if (!entry || typeof entry !== 'object') return null;

  const providers = (entry as { providers?: unknown }).providers;
  if (!providers || typeof providers !== 'object') return null;

  const provider = (providers as Record<string, unknown>)[
    normalizeProductHostname(hostname)
  ];

  return provider && typeof provider === 'object'
    ? (provider as ProductProviderCache)
    : null;
}

/** Read current multi-URL entries and legacy single-URL entries. */
export function getCachedProductUrls(entry: unknown) {
  const legacyValues =
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

  const providerValues: unknown[] = [];
  if (entry && typeof entry === 'object') {
    const providers = (entry as { providers?: unknown }).providers;
    if (providers && typeof providers === 'object') {
      for (const provider of Object.values(
        providers as Record<string, unknown>,
      )) {
        if (!provider || typeof provider !== 'object') continue;
        const record = provider as Record<string, unknown>;
        providerValues.push(record.selectedUrl);
        if (Array.isArray(record.offers)) {
          providerValues.push(
            ...record.offers.flatMap((offer) =>
              offer && typeof offer === 'object'
                ? [(offer as Record<string, unknown>).url]
                : [],
            ),
          );
        }
      }
    }
  }

  return [
    ...new Set(
      [...providerValues, ...legacyValues]
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
  const normalizedHostname = normalizeProductHostname(hostname);

  return getCachedProductUrls(entry).filter((url) => {
    return getHostname(url) === normalizedHostname;
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

  const provider = getProviderCache(entry, hostname);
  const selectedUrl = provider?.selectedUrl;
  const offer = provider?.offers.find(
    (item) => !selectedUrl || item.url === selectedUrl,
  );

  if (offer && typeof offer.stock === 'number') {
    const timestamp = Date.parse(offer.checkedAt);

    if (
      Number.isInteger(offer.stock) &&
      offer.stock >= 0 &&
      Number.isFinite(timestamp) &&
      (PRODUCT_CACHE_TTL_HOURS === 0 ||
        Date.now() - timestamp <= PRODUCT_CACHE_TTL_HOURS * 60 * 60 * 1000)
    ) {
      return { availableQuantity: offer.stock, checkedAt: offer.checkedAt };
    }
  }

  // Read the old shape while an entry is being migrated in memory.
  const availability = (entry as { availability?: unknown }).availability;
  const value =
    availability && typeof availability === 'object'
      ? ((availability as Record<string, unknown>)[hostname] ??
        (availability as Record<string, unknown>)[
          normalizeProductHostname(hostname)
        ])
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

/** Return the observed offers for one provider, including sold-out products. */
export function getCachedProductOffers(
  entry: unknown,
  hostname: string,
): ProductOfferSnapshot[] {
  const provider = getProviderCache(entry, hostname);
  if (provider) return provider.offers.filter(isProductOfferSnapshot);

  if (!entry || typeof entry !== 'object') return [];
  const offers = (entry as { offers?: unknown }).offers;
  const value =
    offers && typeof offers === 'object'
      ? (offers as Record<string, unknown>)[hostname]
      : null;

  return Array.isArray(value) ? value.filter(isProductOfferSnapshot) : [];
}

function isProductOfferSnapshot(value: unknown): value is ProductOfferSnapshot {
  if (!value || typeof value !== 'object') return false;
  const offer = value as ProductOfferSnapshot;
  return (
    (offer.url === null || typeof offer.url === 'string') &&
    (offer.price === null ||
      (typeof offer.price === 'number' && Number.isFinite(offer.price))) &&
    (offer.stock === null ||
      (typeof offer.stock === 'number' && Number.isFinite(offer.stock))) &&
    typeof offer.available === 'boolean' &&
    typeof offer.checkedAt === 'string'
  );
}

/** Store observed provider offers without changing matching or cart logic. */
export async function cacheProductOffers(
  card: { set: string; number: string; cardmarketName: string },
  hostname: string,
  offers: Array<
    Omit<ProductOfferSnapshot, 'checkedAt'> & { checkedAt?: string }
  >,
) {
  if (!USE_PRODUCT_CACHE || !offers.length) return;

  const key = getProductCacheKey(card);
  const previous = productCache.get(key);
  const provider = normalizeProductHostname(hostname);
  const byIdentity = new Map(
    getCachedProductOffers(previous, hostname).map((offer) => [
      `${offer.url ?? ''}:${offer.price ?? ''}:${offer.stock ?? ''}`,
      offer,
    ]),
  );

  for (const offer of offers) {
    const snapshot = {
      ...offer,
      checkedAt: offer.checkedAt ?? new Date().toISOString(),
    };
    byIdentity.set(
      `${snapshot.url ?? ''}:${snapshot.price ?? ''}:${snapshot.stock ?? ''}`,
      snapshot,
    );
  }

  const providers = { ...(previous?.providers ?? {}) };
  providers[provider] = {
    ...(providers[provider] ?? {}),
    offers: [...byIdentity.values()],
  };

  productCache.set(key, {
    searchName: previous?.searchName,
    providers,
  });

  await saveProductCache();
}

/** Return a provider's fresh negative search result, if one was cached. */
export function getCachedProductResolution(
  entry: unknown,
  hostname: string,
): ProductResolution | null {
  const provider = getProviderCache(entry, hostname);
  if (provider?.resolution) {
    const timestamp = Date.parse(provider.resolution.checkedAt);

    if (
      provider.resolution.status &&
      Number.isFinite(timestamp) &&
      (PRODUCT_CACHE_TTL_HOURS === 0 ||
        Date.now() - timestamp <= PRODUCT_CACHE_TTL_HOURS * 60 * 60 * 1000)
    ) {
      return provider.resolution;
    }
  }

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
  const provider = normalizeProductHostname(hostname);
  const providers = { ...(previous?.providers ?? {}) };

  providers[provider] = {
    ...(providers[provider] ?? {}),
    offers: providers[provider]?.offers ?? [],
    resolution: {
      status,
      checkedAt: new Date().toISOString(),
    },
  };

  productCache.set(key, {
    searchName: searchName ?? previous?.searchName,
    providers,
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
  const provider = normalizeProductHostname(hostname);
  const providers = { ...(previous?.providers ?? {}) };
  const current = providers[provider];
  const selectedUrl = current?.selectedUrl;
  const checkedAt = new Date().toISOString();
  const stock = Math.max(0, Math.floor(availableQuantity));
  const offers = (current?.offers ?? []).map((offer) =>
    !selectedUrl || offer.url === selectedUrl
      ? { ...offer, stock, checkedAt }
      : offer,
  );

  providers[provider] = {
    ...(current ?? {}),
    offers,
  };

  productCache.set(key, {
    searchName: previous?.searchName,
    providers,
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

  const hostname = getHostname(url);
  if (!hostname) return;
  const providers = { ...(previous?.providers ?? {}) };
  const provider = providers[hostname];

  const nextProvider = {
    ...(provider ?? {}),
    selectedUrl: url,
    offers: provider?.offers ?? [],
  };
  delete nextProvider.resolution;
  providers[hostname] = nextProvider;

  productCache.set(key, {
    searchName: searchName ?? previous?.searchName,
    providers,
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

      const needsNormalization =
        cached.version !== 1 ||
        Object.values(cached.products).some((value) => {
          if (
            !value ||
            typeof value !== 'object' ||
            !('providers' in (value as Record<string, unknown>))
          ) {
            return true;
          }

          const providers = (value as Record<string, unknown>).providers;
          if (!providers || typeof providers !== 'object') return true;
          return Object.values(providers as Record<string, unknown>).some(
            (provider) => {
              if (!provider || typeof provider !== 'object') return true;
              const offers = (provider as Record<string, unknown>).offers;
              return (
                Array.isArray(offers) &&
                offers.some(
                  (offer) =>
                    offer &&
                    typeof offer === 'object' &&
                    ('productName' in offer ||
                      'addable' in offer ||
                      'status' in offer),
                )
              );
            },
          );
        });

      if (needsNormalization) {
        outputLog('Normalizing legacy product cache entries...');
        await saveProductCache();
      }

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

function normalizeProductOffers(value: unknown) {
  if (!value || typeof value !== 'object') return undefined;

  const result: Record<string, ProductOfferSnapshot[]> = {};

  for (const [hostname, items] of Object.entries(value)) {
    if (!Array.isArray(items)) continue;
    const validItems = items
      .map(normalizeProductOffer)
      .filter((offer): offer is ProductOfferSnapshot => Boolean(offer));
    if (validItems.length) result[hostname] = validItems;
  }

  return Object.keys(result).length ? result : undefined;
}

function normalizeProductOffer(value: unknown): ProductOfferSnapshot | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const url =
    record.url === null ? null : normalizeCachedProductUrl(record.url);
  const price: number | null =
    record.price === null ||
    (typeof record.price === 'number' && Number.isFinite(record.price))
      ? (record.price as number | null)
      : null;
  const stock: number | null =
    record.stock === null ||
    (typeof record.stock === 'number' &&
      Number.isInteger(record.stock) &&
      record.stock >= 0)
      ? (record.stock as number | null)
      : null;
  const checkedAt =
    typeof record.checkedAt === 'string' ? record.checkedAt : null;

  if (typeof record.available !== 'boolean' || !checkedAt) return null;

  return { url, price, stock, available: record.available, checkedAt };
}

function normalizeProductProvider(value: unknown): ProductProviderCache {
  const object =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const selectedUrl = normalizeCachedProductUrl(object.selectedUrl);
  const offers = Array.isArray(object.offers)
    ? object.offers
        .map(normalizeProductOffer)
        .filter((offer): offer is ProductOfferSnapshot => Boolean(offer))
    : [];
  const resolution =
    object.resolution && typeof object.resolution === 'object'
      ? normalizeProductResolution({ provider: object.resolution })?.provider
      : undefined;

  return {
    selectedUrl: selectedUrl ?? undefined,
    offers,
    resolution,
  };
}

function normalizeProductCacheEntry(value: unknown): ProductCacheEntry {
  const object =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const providers: Record<string, ProductProviderCache> = {};

  const ensureProvider = (hostname: string) => {
    const provider = normalizeProductHostname(hostname);
    providers[provider] ??= { offers: [] };
    return providers[provider];
  };

  if (object.providers && typeof object.providers === 'object') {
    for (const [hostname, value] of Object.entries(
      object.providers as Record<string, unknown>,
    )) {
      providers[normalizeProductHostname(hostname)] =
        normalizeProductProvider(value);
    }
  }

  // Migrate the old global URL list into the provider that owns each URL.
  for (const url of getCachedProductUrls(object)) {
    const hostname = getHostname(url);
    if (!hostname) continue;
    const provider = ensureProvider(hostname);
    provider.selectedUrl ??= url;
  }

  // Migrate the old provider-keyed offer map into provider records.
  const legacyOffers = normalizeProductOffers(object.offers);
  for (const [hostname, offers] of Object.entries(legacyOffers ?? {})) {
    const provider = ensureProvider(hostname);
    const byIdentity = new Map(
      provider.offers.map((offer) => [
        `${offer.url ?? ''}:${offer.price ?? ''}:${offer.stock ?? ''}`,
        offer,
      ]),
    );
    for (const offer of offers) {
      byIdentity.set(
        `${offer.url ?? ''}:${offer.price ?? ''}:${offer.stock ?? ''}`,
        offer,
      );
      if (offer.url && !provider.selectedUrl) provider.selectedUrl = offer.url;
    }
    provider.offers = [...byIdentity.values()];
  }

  const legacyResolution = normalizeProductResolution(object.resolution);
  for (const [hostname, resolution] of Object.entries(legacyResolution ?? {})) {
    ensureProvider(hostname).resolution = resolution;
  }

  // Availability used to be separate. Fold it into the selected offer so
  // stock and its timestamp have one authoritative location.
  const legacyAvailability = normalizeProductAvailability(object.availability);
  for (const [hostname, availability] of Object.entries(
    legacyAvailability ?? {},
  )) {
    const provider = ensureProvider(hostname);
    const selected = provider.selectedUrl
      ? provider.offers.find((offer) => offer.url === provider.selectedUrl)
      : provider.offers[0];

    if (selected) {
      selected.stock = availability.availableQuantity;
      selected.checkedAt = availability.checkedAt;
    } else if (provider.selectedUrl) {
      provider.offers.push({
        url: provider.selectedUrl,
        price: null,
        stock: availability.availableQuantity,
        available: availability.availableQuantity > 0,
        checkedAt: availability.checkedAt,
      });
    }
  }

  return {
    searchName:
      typeof object.searchName === 'string' ? object.searchName : undefined,
    providers,
  };
}

async function saveProductCache() {
  if (!USE_PRODUCT_CACHE) {
    return;
  }

  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = productCacheWriteQueue;
  productCacheWriteQueue = previous.then(() => turn);
  await previous;

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
  } finally {
    release();
  }
}
