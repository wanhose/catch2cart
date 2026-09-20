/**
 * Console output and the optional terminal dashboard.
 *
 * Detailed logs are suppressed while the dashboard is active so the terminal
 * remains readable. `--verbose` and `--no-dashboard` disable that behaviour.
 */

import { DASHBOARD_ENABLED } from './config.ts';

const RAW_CONSOLE_LOG = console.log.bind(console);

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
  MANASOURCE_ERROR: 'Error',
  CART_FULL: 'Cart full · provider stopped',
  PROVIDER_BLOCKED: 'Provider stopped',
  ERROR: 'Error',
  NO_RESULT: 'No result',
};

/** Convert internal result codes into concise text for the live dashboard. */
/** Format summary keys while preserving the provider that produced them. */
export function formatSummaryStatus(status) {
  let provider = null;
  let result = status;

  const manaSourceMatch = status.match(/^MANASOURCE_(.+)$/);
  const cheapestMatch = status.match(
    /^CHEAPEST_(dorasuta|manasource|pao|toreca)_(.+)$/,
  );

  if (manaSourceMatch) {
    provider = 'ManaSource';
    result = manaSourceMatch[1];
  } else if (cheapestMatch) {
    provider =
      cheapestMatch[1] === 'manasource'
        ? 'ManaSource'
        : cheapestMatch[1] === 'pao'
          ? 'PAO'
          : cheapestMatch[1] === 'toreca'
            ? 'Toreca'
            : 'Dorasuta';
    result = cheapestMatch[2];
  } else if (
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
    ].includes(status)
  ) {
    provider = 'Dorasuta';
  }

  const label = formatDashboardStatus(result);

  return provider ? provider + ' · ' + label : label;
}

export function formatDashboardStatus(status) {
  const label = DASHBOARD_STATUS_LABELS[status];

  if (label) {
    return label;
  }

  return status
    .replaceAll('_', ' ')
    .toLowerCase()
    .replace(/(^| )\w/g, (character) => character.toUpperCase());
}

let dashboardActive = false;
let dashboardLineCount = 0;
let dashboardState = {
  current: 0,
  total: 0,
  card: 'Starting...',
  phase: 'Preparing',
  status: '—',
  completed: 0,
  added: 0,
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
  if (!DASHBOARD_ENABLED || !dashboardActive) {
    return;
  }

  const progress =
    dashboardState.total > 0
      ? Math.round((dashboardState.completed / dashboardState.total) * 100)
      : 0;

  const lines = [
    '────────────────────────────────────────',
    `Progress: ${dashboardState.completed}/${dashboardState.total} (${progress}%)`,
    `Current:  ${dashboardState.current}/${dashboardState.total} · ${dashboardState.card}`,
    `Step:     ${dashboardState.phase}`,
    `Status:   ${dashboardState.status}`,
    '────────────────────────────────────────',
    `Added/planned: ${dashboardState.added}  Partial: ${dashboardState.partial}  ` +
      `Skipped: ${dashboardState.skipped}  Errors: ${dashboardState.errors}`,
    ...dashboardState.errorMessages.map((message) => `Error: ${message}`),
  ];

  const cursorUp = dashboardLineCount ? `\x1b[${dashboardLineCount}A` : '';

  process.stdout.write(
    (dashboardLineCount ? '' : 'catch2cart\n') +
      cursorUp +
      '\x1b[0J' +
      `${lines.join('\n')}\n`,
  );
  dashboardLineCount = lines.length;
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
export function startDashboard(total) {
  dashboardState = {
    current: 0,
    total,
    card: 'Starting...',
    phase: 'Ready',
    status: 'Waiting',
    completed: 0,
    added: 0,
    partial: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
  };

  dashboardLineCount = 0;
  dashboardActive = true;
  renderDashboard();
}

/** Stop rendering without clearing the user's terminal scrollback. */
export function stopDashboard() {
  dashboardActive = false;
  dashboardLineCount = 0;
}
