import {
  parseProviderSelection,
  parseProviderStrategy,
} from './providers/registry.ts';

/**
 * Central runtime configuration.
 *
 * Every user-facing setting is resolved once at module load time. CLI options
 * take precedence over environment variables, which take precedence over the
 * documented defaults.
 */

const nodeMajorVersion = Number(process.versions.node.split('.')[0]);

if (nodeMajorVersion < 24) {
  throw new Error(
    `Node.js 24 or newer is required; detected ${process.versions.node}.`,
  );
}

/** Resolve `--option value` and `--option=value` forms consistently. */
function getCliOption(name, fallback) {
  const equalsPrefix = `${name}=`;
  const equalsArgument = process.argv.find((argument) =>
    argument.startsWith(equalsPrefix),
  );

  if (equalsArgument) {
    return equalsArgument.slice(equalsPrefix.length);
  }

  const position = process.argv.indexOf(name);

  if (
    position !== -1 &&
    process.argv[position + 1] &&
    !process.argv[position + 1].startsWith('--')
  ) {
    return process.argv[position + 1];
  }

  return fallback;
}

/** Read a non-negative millisecond option from the CLI or environment. */
function getNumericOption(name, environmentName, fallback) {
  const value = getCliOption(name, process.env[environmentName] ?? fallback);

  return parseNonNegativeNumber(name, value);
}

/** Validate and convert a numeric runtime option. */
function parseNonNegativeNumber(name, value) {
  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) {
    throw new Error(
      `${name} must be a non-negative number; received ${value}.`,
    );
  }

  return number;
}

/** Read an optional non-negative numeric option; omitted values stay null. */
function getOptionalNumericOption(name, environmentName, fallback = null) {
  const value = getCliOption(name, process.env[environmentName] ?? fallback);

  if (value === null || value === '') {
    return null;
  }

  return parseNonNegativeNumber(name, value);
}

/** Read a positive integer option, or zero when the feature is disabled. */
function getPositiveIntegerOption(name, environmentName, fallback) {
  const value = getNumericOption(name, environmentName, fallback);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative integer; received ${value}.`,
    );
  }

  return value;
}

/** Convert comma-separated wishlist IDs or URLs into canonical numeric IDs. */
function parseSkippedCardmarketWishlists(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/(?:^|\/)(\d+)\/?$/);

      if (!match) {
        throw new Error(
          `--skip-cardmarket-wishlists must contain numeric wishlist IDs or URLs separated by commas; received ${item}.`,
        );
      }

      return match[1];
    });
}

export const CDP_ENDPOINT = getCliOption(
  '--cdp-endpoint',
  process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222',
);

export const CARDMARKET_URL = 'https://www.cardmarket.com/en/Pokemon/Wants';

export const DORASUTA_URL = 'https://dorasuta.jp/pokemon-card';

export const DORASUTA_CART_URL = 'https://dorasuta.jp/cart';

export const SAMURAI_SWORD_SET_LIST_URL =
  'https://samuraiswordtokyo.com/blogs/news/japanese-pokemon-card-sets-in-order';

export const DORASUTA_SEARCH_URL =
  'https://dorasuta.jp/pokemon-card/product-list';

export const PROVIDERS = parseProviderSelection(
  getCliOption('--providers', process.env.PROVIDERS ?? 'all'),
);

export const PROVIDER_STRATEGY = parseProviderStrategy(
  getCliOption('--provider-strategy', process.env.PROVIDER_STRATEGY ?? 'all'),
);

export const COMMIT = process.argv.includes('--commit');

export const CURRENT_WISHLIST_ONLY =
  process.argv.includes('--current-wishlist');

const skippedCardmarketWishlists = parseSkippedCardmarketWishlists(
  getCliOption(
    '--skip-cardmarket-wishlists',
    process.env.SKIP_CARDMARKET_WISHLISTS ?? '',
  ),
);

export const SKIP_CARDMARKET_WISHLIST_IDS = new Set(skippedCardmarketWishlists);

export const USE_WISHLIST_CACHE =
  process.argv.includes('--use-wishlist-cache') ||
  process.argv.includes('--use-cardmarket-cache') ||
  process.argv.includes('--cardmarket-cache') ||
  process.argv.includes('--clear-wishlist-cache') ||
  process.argv.includes('--clear-cardmarket-cache');

export const CLEAR_WISHLIST_CACHE =
  process.argv.includes('--clear-wishlist-cache') ||
  process.argv.includes('--clear-cardmarket-cache');

export const VERBOSE_OUTPUT = process.argv.includes('--verbose');

export const NO_DASHBOARD = process.argv.includes('--no-dashboard');

export const DASHBOARD_ENABLED =
  Boolean(process.stdout.isTTY) && !VERBOSE_OUTPUT && !NO_DASHBOARD;

export const DEFAULT_TIMEOUT_MS = getNumericOption(
  '--default-timeout-ms',
  'DEFAULT_TIMEOUT_MS',
  10_000,
);

export const NAVIGATION_TIMEOUT_MS = getNumericOption(
  '--navigation-timeout-ms',
  'NAVIGATION_TIMEOUT_MS',
  15_000,
);

export const NAVIGATION_RETRY_ATTEMPTS = getNumericOption(
  '--navigation-retry-attempts',
  'NAVIGATION_RETRY_ATTEMPTS',
  2,
);

export const CART_TIMEOUT_MS = getNumericOption(
  '--cart-timeout-ms',
  'CART_TIMEOUT_MS',
  12_000,
);

export const WISHLIST_CACHE_FILE = getCliOption(
  '--wishlist-cache-file',
  process.env.WISHLIST_CACHE_FILE ?? '.wishlist-cache',
);

/** Legacy wishlist cache path kept for automatic migration. */
export const LEGACY_WISHLIST_CACHE_FILE = '.cardmarket-wishlist-cache.json';

// Compatibility alias for integrations using the previous Cardmarket name.
export const CARDMARKET_CACHE_FILE = getCliOption(
  '--cardmarket-cache-file',
  process.env.CARDMARKET_CACHE_FILE ?? WISHLIST_CACHE_FILE,
);

export const PRODUCT_CACHE_FILE = getCliOption(
  '--product-cache-file',
  process.env.PRODUCT_CACHE_FILE ?? '.product-cache',
);

export const SET_CACHE_FILE = '.set-cache';

/** Legacy paths used before the cache became provider-neutral. */
export const LEGACY_PRODUCT_CACHE_FILES = [
  '.product-cache.json',
  '.dorasuta-product-cache.json',
];

export const USE_PRODUCT_CACHE =
  process.argv.includes('--use-product-cache') ||
  process.argv.includes('--use-dorasuta-cache') ||
  process.argv.includes('--use-dorasuta-product-cache') ||
  process.argv.includes('--dorasuta-product-cache') ||
  process.argv.includes('--clear-product-cache') ||
  process.argv.includes('--clear-dorasuta-cache') ||
  process.argv.includes('--clear-dorasuta-product-cache');

export const CLEAR_PRODUCT_CACHE =
  process.argv.includes('--clear-product-cache') ||
  process.argv.includes('--clear-dorasuta-cache') ||
  process.argv.includes('--clear-dorasuta-product-cache');

// Compatibility exports for modules and integrations using the old names.
export const DORASUTA_PRODUCT_CACHE_FILE = PRODUCT_CACHE_FILE;

export const MAX_PRICE_YEN = getOptionalNumericOption(
  '--max-price-yen',
  'MAX_PRICE_YEN',
);

export const BATCH_SIZE = getPositiveIntegerOption(
  '--batch-size',
  'BATCH_SIZE',
  0,
);

export const BATCH_NUMBER = getPositiveIntegerOption(
  '--batch-number',
  'BATCH_NUMBER',
  1,
);

if (BATCH_NUMBER < 1) {
  throw new Error(
    `--batch-number must be at least 1; received ${BATCH_NUMBER}.`,
  );
}

export const WISHLIST_CACHE_TTL_HOURS = getNumericOption(
  '--wishlist-cache-ttl-hours',
  'WISHLIST_CACHE_TTL_HOURS',
  0,
);

export const CARDMARKET_CACHE_TTL_HOURS = getNumericOption(
  '--cardmarket-cache-ttl-hours',
  'CARDMARKET_CACHE_TTL_HOURS',
  WISHLIST_CACHE_TTL_HOURS,
);

export const PRODUCT_CACHE_TTL_HOURS = getNumericOption(
  '--product-cache-ttl-hours',
  'PRODUCT_CACHE_TTL_HOURS',
  24,
);

export const USE_CARDMARKET_CACHE = USE_WISHLIST_CACHE;
export const CLEAR_CARDMARKET_CACHE = CLEAR_WISHLIST_CACHE;

export const NAVIGATION_GAP_MS = getNumericOption(
  '--navigation-gap-ms',
  'NAVIGATION_GAP_MS',
  10_000,
);

export const DORASUTA_SEARCH_GAP_MS = getNumericOption(
  '--dorasuta-search-gap-ms',
  'DORASUTA_SEARCH_GAP_MS',
  15_000,
);

export const CLOUDFLARE_POLL_MS = getNumericOption(
  '--cloudflare-poll-ms',
  'CLOUDFLARE_POLL_MS',
  3_000,
);

export const CLOUDFLARE_MAX_WAIT_MS = getNumericOption(
  '--cloudflare-max-wait-ms',
  'CLOUDFLARE_MAX_WAIT_MS',
  10 * 60_000,
);

export const DORASUTA_RATE_LIMIT_RETRY_MS = getNumericOption(
  '--dorasuta-rate-limit-retry-ms',
  'DORASUTA_RATE_LIMIT_RETRY_MS',
  60_000,
);

export const DORASUTA_RATE_LIMIT_MAX_WAIT_MS = getNumericOption(
  '--dorasuta-rate-limit-max-wait-ms',
  'DORASUTA_RATE_LIMIT_MAX_WAIT_MS',
  15 * 60_000,
);

export { parseNonNegativeNumber, parseSkippedCardmarketWishlists };
