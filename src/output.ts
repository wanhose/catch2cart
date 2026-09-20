/**
 * Console output and the optional terminal dashboard.
 *
 * Detailed logs are suppressed while the dashboard tracks the current card.
 * `--verbose` and `--no-dashboard` disable the interactive dashboard.
 */

import { DASHBOARD_ENABLED } from './config.ts';
import { createLogUpdate } from 'log-update';

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
