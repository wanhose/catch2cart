/**
 * Console output and the optional terminal dashboard.
 *
 * Detailed logs are suppressed while the dashboard tracks the current card.
 * `--verbose` and `--no-dashboard` disable the interactive dashboard.
 */

import { DASHBOARD_ENABLED } from './config.ts';
import { createLogUpdate } from 'log-update';
import { getProviderLabel } from './providers/registry.ts';
import type { ProviderName } from './providers/types.ts';

const RAW_CONSOLE_LOG = console.log.bind(console);
const INTERACTIVE_DASHBOARD_ENABLED =
  DASHBOARD_ENABLED && Boolean(process.stdout.isTTY);

const DASHBOARD_STATUS_LABELS = {
  ADDED_TO_CART: 'Added to cart',
  ADDED_TO_CART_PARTIAL_STOCK: 'Added partially · stock remaining',
  DRY_RUN_OK: 'Would be added',
  DRY_RUN_PARTIAL_STOCK: 'Would be added partially · stock remaining',
  ALREADY_IN_CART: 'Already in cart',
  INSUFFICIENT_STOCK: 'Insufficient stock',
  NO_ACCEPTABLE_CONDITION: 'No acceptable condition',
  PRICE_LIMIT: 'Over price limit',
  NO_NUMBER_MATCH: 'No collector number match',
  NO_EXACT_MATCH: 'No exact match',
  SET_NOT_VERIFIED: 'Collection not verified',
  AMBIGUOUS_MATCH: 'Ambiguous match',
  NAME_NOT_RESOLVED: 'Name not resolved',
  PRODUCT_ID_NOT_FOUND: 'Product ID not found',
  CART_QUANTITY_UNKNOWN: 'Cart quantity unknown',
  NO_ELIGIBLE_OFFER: 'No eligible offer',
  MANASOURCE_ERROR: 'Error',
  CART_FULL: 'Cart full · provider stopped',
  PROVIDER_BLOCKED: 'Provider stopped',
  ERROR: 'Error',
  NO_RESULT: 'No result',
};

const CHEAPEST_LABEL = 'Cheapest';

const PROVIDER_ORDER = new Map(
  ['dorasuta', 'manasource', 'pao', 'toreca', 'cheapest'].map(
    (provider, index) => [provider, index],
  ),
);

const SUMMARY_RESULT_ORDER = new Map(
  [
    'ADDED_TO_CART',
    'ADDED_TO_CART_PARTIAL_STOCK',
    'DRY_RUN_OK',
    'DRY_RUN_PARTIAL_STOCK',
    'ALREADY_IN_CART',
    'INSUFFICIENT_STOCK',
    'NO_ACCEPTABLE_CONDITION',
    'PRICE_LIMIT',
    'NO_ELIGIBLE_OFFER',
    'NO_NUMBER_MATCH',
    'NO_EXACT_MATCH',
    'SET_NOT_VERIFIED',
    'AMBIGUOUS_MATCH',
    'NAME_NOT_RESOLVED',
    'PRODUCT_ID_NOT_FOUND',
    'CART_QUANTITY_UNKNOWN',
    'CART_FULL',
    'PROVIDER_BLOCKED',
    'NO_RESULT',
    'ERROR',
  ].map((result, index) => [result, index]),
);

function getSummaryStatusParts(status: string): {
  provider: ProviderName | 'cheapest' | null;
  result: string;
} {
  const providerMatch = status.match(/^(MANASOURCE|PAO|TORECA)_(.+)$/);
  const cheapestMatch = status.match(
    /^CHEAPEST_(dorasuta|manasource|pao|toreca)_(.+)$/,
  );
  const cheapestResultMatch = status.match(/^CHEAPEST_(.+)$/);

  if (cheapestMatch) {
    return {
      provider: cheapestMatch[1] as ProviderName,
      result: cheapestMatch[2],
    };
  }

  if (cheapestResultMatch) {
    return { provider: 'cheapest', result: cheapestResultMatch[1] };
  }

  if (providerMatch) {
    return {
      provider: providerMatch[1].toLowerCase() as ProviderName,
      result: providerMatch[2],
    };
  }

  if (
    [
      'ADDED_TO_CART',
      'ADDED_TO_CART_PARTIAL_STOCK',
      'DRY_RUN_OK',
      'DRY_RUN_PARTIAL_STOCK',
      'ALREADY_IN_CART',
      'INSUFFICIENT_STOCK',
      'NO_ACCEPTABLE_CONDITION',
      'PRICE_LIMIT',
      'NO_NUMBER_MATCH',
      'NO_EXACT_MATCH',
      'SET_NOT_VERIFIED',
      'AMBIGUOUS_MATCH',
      'NAME_NOT_RESOLVED',
      'PRODUCT_ID_NOT_FOUND',
      'CART_QUANTITY_UNKNOWN',
      'CART_FULL',
      'PROVIDER_BLOCKED',
      'NO_RESULT',
      'ERROR',
    ].includes(status)
  ) {
    return { provider: 'dorasuta', result: status };
  }

  return { provider: null, result: status };
}

/** Format summary keys while preserving the provider or strategy that produced them. */
export function formatSummaryStatus(status: string) {
  const { provider, result } = getSummaryStatusParts(status);
  const label = formatDashboardStatus(result);

  const providerLabel =
    provider === 'cheapest'
      ? CHEAPEST_LABEL
      : provider
        ? getProviderLabel(provider)
        : null;

  return providerLabel ? providerLabel + ' · ' + label : label;
}

/** Sort summary rows by provider and then by a stable result priority. */
export function sortSummaryEntries(summary: Record<string, number>) {
  return Object.entries(summary).sort(([left], [right]) => {
    const leftParts = getSummaryStatusParts(left);
    const rightParts = getSummaryStatusParts(right);
    const providerDifference =
      (PROVIDER_ORDER.get(leftParts.provider ?? '') ??
        Number.MAX_SAFE_INTEGER) -
      (PROVIDER_ORDER.get(rightParts.provider ?? '') ??
        Number.MAX_SAFE_INTEGER);

    if (providerDifference) return providerDifference;

    const resultDifference =
      (SUMMARY_RESULT_ORDER.get(leftParts.result) ?? Number.MAX_SAFE_INTEGER) -
      (SUMMARY_RESULT_ORDER.get(rightParts.result) ?? Number.MAX_SAFE_INTEGER);

    return resultDifference || left.localeCompare(right);
  });
}

export function formatDashboardStatus(status) {
  const label = DASHBOARD_STATUS_LABELS[status];

  if (label) {
    return label;
  }

  return status
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/^\w/, (character) => character.toUpperCase());
}

let dashboardActive = false;
let dashboardTimer: ReturnType<typeof globalThis.setInterval> | null = null;
let dashboardAnimationFrame = 0;
let dashboardStartedAt = 0;
const dashboardLog = createLogUpdate(process.stdout, {
  defaultHeight: 20,
  defaultWidth: 100,
});
const DASHBOARD_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DASHBOARD_WIDTH = 78;
const DASHBOARD_CONTENT_WIDTH = DASHBOARD_WIDTH - 4;
let dashboardState = {
  current: 0,
  total: 0,
  card: 'Starting...',
  mode: '—',
  phase: 'Preparing',
  status: '—',
  completed: 0,
  added: 0,
  alreadyInCart: 0,
  partial: 0,
  skipped: 0,
  errors: 0,
  errorMessages: [],
};

/** Write detailed output unless the interactive dashboard owns the terminal. */
export function outputLog(...args) {
  if (dashboardActive && DASHBOARD_ENABLED) {
    return;
  }

  RAW_CONSOLE_LOG(...args);
}

function renderDashboard() {
  if (!INTERACTIVE_DASHBOARD_ENABLED || !dashboardActive) {
    return;
  }

  const progress =
    dashboardState.total > 0
      ? Math.round((dashboardState.completed / dashboardState.total) * 100)
      : 0;

  const progressWidth = 22;
  const filledProgress = Math.round((progress / 100) * progressWidth);
  const progressBar =
    '█'.repeat(filledProgress) + '░'.repeat(progressWidth - filledProgress);
  const spinner = DASHBOARD_SPINNER[dashboardAnimationFrame];
  const elapsedSeconds = Math.floor((Date.now() - dashboardStartedAt) / 1000);
  const elapsed = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:${String(elapsedSeconds % 60).padStart(2, '0')}`;

  const horizontal = '─'.repeat(DASHBOARD_WIDTH - 2);
  const frame = (content = '') => {
    const value = String(content);
    const clipped =
      value.length > DASHBOARD_CONTENT_WIDTH
        ? value.slice(0, DASHBOARD_CONTENT_WIDTH - 1) + '…'
        : value;

    return `│ ${clipped.padEnd(DASHBOARD_CONTENT_WIDTH)} │`;
  };
  const field = (label, value) => frame(`${label.padEnd(10)} ${String(value)}`);

  const lines = [
    `┌${horizontal}┐`,
    frame(`catch2cart · ${spinner} LIVE RUN · ${elapsed}`),
    frame(horizontal.slice(0, DASHBOARD_CONTENT_WIDTH)),
    field('Mode', dashboardState.mode),
    field(
      'Progress',
      `[${progressBar}] ${progress}% · ${dashboardState.completed}/${dashboardState.total}`,
    ),
    field(
      'Current',
      `${dashboardState.current}/${dashboardState.total} · ${dashboardState.card}`,
    ),
    field('Step', `${spinner} ${dashboardState.phase}`),
    field('Status', dashboardState.status),
    frame(horizontal.slice(0, DASHBOARD_CONTENT_WIDTH)),
    field(
      'Results',
      `${dashboardState.added} added/planned · ${dashboardState.alreadyInCart} already in cart · ` +
        `${dashboardState.errors} errors`,
    ),
    ...dashboardState.errorMessages.map((message) => field('Issue', message)),
    `└${horizontal}┘`,
  ];

  dashboardLog(lines.join('\n'));
}

/** Merge state changes and redraw the dashboard when it is enabled. */
export function updateDashboard(updates) {
  dashboardState = {
    ...dashboardState,
    ...updates,
  };

  renderDashboard();
}

/** Return the current dashboard snapshot for counters and summaries. */
export function getDashboardState() {
  return dashboardState;
}

/** Initialise the dashboard counters for a new card-processing run. */
export function startDashboard(total, initialState = {}) {
  dashboardState = {
    current: 0,
    total,
    card: 'Starting...',
    mode: '—',
    phase: 'Ready',
    status: 'Waiting',
    completed: 0,
    added: 0,
    alreadyInCart: 0,
    partial: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
    ...initialState,
  };

  dashboardActive = INTERACTIVE_DASHBOARD_ENABLED;
  dashboardAnimationFrame = 0;
  dashboardStartedAt = Date.now();

  if (dashboardActive) {
    dashboardTimer = globalThis.setInterval(() => {
      dashboardAnimationFrame =
        (dashboardAnimationFrame + 1) % DASHBOARD_SPINNER.length;
      renderDashboard();
    }, 120);
    dashboardTimer.unref?.();
  }

  renderDashboard();
}

/** Stop rendering without clearing the user's terminal scrollback. */
export function stopDashboard() {
  if (dashboardTimer) {
    globalThis.clearInterval(dashboardTimer);
    dashboardTimer = null;
  }

  if (dashboardActive) {
    dashboardLog.done();
  }
  dashboardActive = false;
}
