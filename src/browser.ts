/**
 * Browser/CDP navigation boundary.
 *
 * All page navigations go through `gotoAndWait`. Dorasuta receives pacing,
 * verification and rate-limit handling; other providers navigate immediately
 * while still serializing access to their shared browser tab.
 */

import { chromium } from 'playwright';
import {
  CDP_ENDPOINT,
  CLOUDFLARE_MAX_WAIT_MS,
  CLOUDFLARE_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  DORASUTA_NAVIGATION_GAP_MS,
  DORASUTA_RATE_LIMIT_MAX_WAIT_MS,
  DORASUTA_RATE_LIMIT_RETRY_MS,
  DORASUTA_SEARCH_GAP_MS,
  NAVIGATION_RETRY_ATTEMPTS,
  NAVIGATION_TIMEOUT_MS,
} from './config.ts';
import { outputLog, updateDashboard } from './output.ts';

const navigationStates = new WeakMap();
let lastDorasutaSearchAt = 0;
const DORASUTA_HOSTNAME = 'dorasuta.jp';

/** Resolve after the requested delay without blocking the event loop. */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Acquire the navigation slot for one provider tab. Only Dorasuta receives a
 * minimum gap; every provider retains the slot to prevent concurrent use of
 * the same Playwright page.
 *
 * The slot stays held until the caller releases it. Keeping it held across
 * `page.goto()` is important: pacing alone does not prevent two workflows
 * from navigating the same Playwright page at the same time.
 */
async function acquireNavigationSlot(page, paceDorasuta = false) {
  let state = navigationStates.get(page);

  if (!state) {
    state = {
      lastNavigationAt: 0,
      queue: Promise.resolve(),
    };
    navigationStates.set(page, state);
  }

  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = state.queue;

  state.queue = previous.then(() => turn);
  await previous;

  const elapsed = Date.now() - state.lastNavigationAt;
  const remaining = paceDorasuta ? DORASUTA_NAVIGATION_GAP_MS - elapsed : 0;

  if (remaining > 0) {
    await sleep(remaining);
  }

  if (paceDorasuta) {
    state.lastNavigationAt = Date.now();
  }
  return release;
}

export function isDorasutaUrl(url: string) {
  try {
    return new URL(url).hostname.toLowerCase() === DORASUTA_HOSTNAME;
  } catch {
    return false;
  }
}

/** Enforce the longer minimum delay reserved for Dorasuta searches. */
export async function waitForDorasutaSearchGap() {
  const elapsed = Date.now() - lastDorasutaSearchAt;
  const remaining = DORASUTA_SEARCH_GAP_MS - elapsed;

  if (remaining > 0) {
    updateDashboard({
      phase: `Waiting ${Math.ceil(remaining / 1000)}s before next search`,
    });

    outputLog(
      `  Waiting ${Math.ceil(remaining / 1000)}s before the next Dorasuta search...`,
    );

    await sleep(remaining);
  }

  lastDorasutaSearchAt = Date.now();
}

export type CloudflareState =
  'clear' | 'challenge' | 'turnstile' | 'ip-blocked';

export type CloudflareSignals = {
  strongChallengeText: boolean;
  genericChallengeText: boolean;
  activeChallengeElement: boolean;
  activeTurnstileFrame: boolean;
  hasTurnstileToken: boolean;
  ipBlocked: boolean;
};

export type CloudflareInspection = CloudflareSignals & {
  state: CloudflareState;
  url: string;
};

/** Classify rendered Cloudflare state. URL tokens are deliberately excluded. */
export function classifyCloudflareState(
  signals: CloudflareSignals,
): CloudflareState {
  if (signals.ipBlocked) {
    return 'ip-blocked';
  }

  if (signals.activeTurnstileFrame && !signals.hasTurnstileToken) {
    return 'turnstile';
  }

  if (
    signals.strongChallengeText ||
    signals.genericChallengeText ||
    signals.activeChallengeElement
  ) {
    return 'challenge';
  }

  return 'clear';
}

/** Read the visible browser state without attempting to solve or bypass it. */
export async function inspectCloudflare(page): Promise<CloudflareInspection> {
  const url = page.url();

  try {
    const signals = await page.evaluate(() => {
      const title = document.title ?? '';
      const body = document.body?.innerText ?? '';
      const text = `${title}\n${body}`.slice(0, 20_000);

      const isVisible = (element) => {
        if (!element) return false;

        const style = globalThis.getComputedStyle(element);
        const rect = element.getBoundingClientRect();

        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const strongChallengeText =
        /just a moment|checking your browser|verifying you are human|performing security verification/i.test(
          text,
        );
      const genericChallengeText =
        text.length < 2_000 && /enable javascript and cookies/i.test(text);
      const activeChallengeElement = [
        ...document.querySelectorAll('#challenge-running, #challenge-stage'),
      ].some(isVisible);
      const activeTurnstileFrame = [
        ...document.querySelectorAll(
          'iframe[src*="challenges.cloudflare.com"]',
        ),
      ].some(isVisible);
      const turnstileInputs = [
        ...document.querySelectorAll('input[name="cf-turnstile-response"]'),
      ];
      const hasTurnstileToken = turnstileInputs.some((input) =>
        Boolean((input as HTMLInputElement).value.trim()),
      );

      return {
        strongChallengeText,
        genericChallengeText,
        activeChallengeElement,
        activeTurnstileFrame,
        hasTurnstileToken,
        ipBlocked:
          /error\s*1006/i.test(text) && /banned your IP address/i.test(text),
      };
    });

    return {
      ...signals,
      state: classifyCloudflareState(signals),
      url,
    };
  } catch {
    return {
      strongChallengeText: false,
      genericChallengeText: false,
      activeChallengeElement: false,
      activeTurnstileFrame: false,
      hasTurnstileToken: false,
      ipBlocked: false,
      state: 'clear',
      url,
    };
  }
}

function cloudflarePhase(state: CloudflareState) {
  if (state === 'turnstile') {
    return 'Cloudflare Turnstile pending; complete it in Chromium';
  }

  return 'Waiting for Cloudflare verification';
}

function cloudflareLog(state: CloudflareState) {
  if (state === 'turnstile') {
    return '  Cloudflare Turnstile is pending. Complete it in Chromium to continue.';
  }

  return '  Cloudflare verification is in progress.';
}

function createDorasutaIpBlockedError() {
  return Object.assign(
    new Error(
      'Dorasuta blocked this IP address with Cloudflare error 1006. Stopping without retries.',
    ),
    { code: 'DORASUTA_IP_BLOCKED' },
  );
}

function throwForCloudflareState(inspection: CloudflareInspection) {
  if (inspection.state === 'ip-blocked') {
    throw createDorasutaIpBlockedError();
  }
}

/**
 * Wait for a rendered verification state to clear. It never retries,
 * navigates, modifies browser fingerprints, or solves a challenge.
 */
export async function waitForCloudflare(page) {
  let inspection = await inspectCloudflare(page);
  throwForCloudflareState(inspection);

  if (inspection.state === 'clear') {
    return false;
  }

  const startedAt = Date.now();
  let previousState: CloudflareState | null = null;
  let settledPolls = 0;

  while (settledPolls < 2) {
    throwForCloudflareState(inspection);

    if (inspection.state === 'clear') {
      settledPolls++;
    } else {
      settledPolls = 0;

      if (inspection.state !== previousState) {
        updateDashboard({ phase: cloudflarePhase(inspection.state) });
        outputLog(cloudflareLog(inspection.state));
        previousState = inspection.state;
      }
    }

    if (Date.now() - startedAt >= CLOUDFLARE_MAX_WAIT_MS) {
      throw Object.assign(
        new Error(
          `Cloudflare verification (${inspection.state}) did not finish within ${CLOUDFLARE_MAX_WAIT_MS} ms.`,
        ),
        {
          code: 'CLOUDFLARE_TIMEOUT',
          cloudflareState: inspection.state,
          url: inspection.url,
        },
      );
    }

    if (settledPolls < 2) {
      await page.waitForTimeout(CLOUDFLARE_POLL_MS);
      inspection = await inspectCloudflare(page);
    }
  }

  await page.waitForLoadState('domcontentloaded').catch(() => {});

  outputLog('  Cloudflare verification finished.');
  return true;
}

async function isDorasutaRateLimitPage(page) {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      return /リクエストが集中しています|しばらく待ってからご利用ください/.test(
        text,
      );
    });
  } catch {
    return false;
  }
}

async function isDorasutaIpBlockedPage(page) {
  return (await inspectCloudflare(page)).state === 'ip-blocked';
}

async function throwIfDorasutaIpBlocked(page) {
  if (await isDorasutaIpBlockedPage(page)) {
    throw createDorasutaIpBlockedError();
  }
}

/** Wait through Dorasuta's explicit rate-limit page with bounded retries. */
async function waitForDorasutaAvailability(
  page,
  url,
  options,
  navigationRelease,
) {
  const startedAt = Date.now();
  let retryNumber = 0;

  while (await isDorasutaRateLimitPage(page)) {
    if (Date.now() - startedAt >= DORASUTA_RATE_LIMIT_MAX_WAIT_MS) {
      throw new Error(
        `Dorasuta rate-limit page did not clear within ${DORASUTA_RATE_LIMIT_MAX_WAIT_MS} ms.`,
      );
    }

    retryNumber++;
    updateDashboard({
      phase: `Rate limited; retrying in ${DORASUTA_RATE_LIMIT_RETRY_MS / 1000}s`,
    });
    outputLog(
      `  Dorasuta is rate-limiting requests. Waiting ${DORASUTA_RATE_LIMIT_RETRY_MS / 1000}s before retry ${retryNumber}...`,
    );

    await page.waitForTimeout(DORASUTA_RATE_LIMIT_RETRY_MS);
    await gotoPageWithRetries(page, url, options, navigationRelease);
    await throwIfDorasutaIpBlocked(page);
    await waitForCloudflare(page);
  }
}

function isRetryableNavigationError(error) {
  const message = String(error?.message ?? error);

  return /timeout|net::ERR_|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(message);
}

/** Navigate with bounded retries for transient browser or network failures. */
async function gotoPageWithRetries(
  page,
  url,
  options,
  navigationRelease = null,
) {
  for (let attempt = 0; ; attempt++) {
    const releaseNavigation =
      navigationRelease ??
      (await acquireNavigationSlot(page, isDorasutaUrl(url)));

    try {
      return await page.goto(url, options);
    } catch (error) {
      if (isDorasutaUrl(url)) {
        await throwIfDorasutaIpBlocked(page);
      }

      if (
        !isRetryableNavigationError(error) ||
        attempt >= NAVIGATION_RETRY_ATTEMPTS
      ) {
        throw error;
      }

      outputLog(
        `  Navigation failed; retrying (${attempt + 1}/${NAVIGATION_RETRY_ATTEMPTS})...`,
      );
    } finally {
      if (!navigationRelease) {
        releaseNavigation();
      }
    }
  }
}

/** Compare URLs while ignoring hash fragments used by some Dorasuta links. */
function samePageUrl(currentUrl, targetUrl) {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);

    current.hash = '';
    target.hash = '';

    return current.href === target.href;
  } catch {
    return currentUrl === targetUrl;
  }
}

/**
 * Navigate once, wait for verification/rate-limit handling, and return the
 * Playwright response. If the page already has the requested URL, no second
 * request is made.
 */
export async function gotoAndWait(page, url, options = {}) {
  const isDorasuta = isDorasutaUrl(url);
  const releaseNavigation = await acquireNavigationSlot(page, isDorasuta);

  try {
    if (isDorasuta) {
      await throwIfDorasutaIpBlocked(page);
    }

    let result = null;

    if (samePageUrl(page.url(), url)) {
      const hostname = new URL(url).hostname;
      outputLog(`  Reusing ${hostname} page after pacing delay: ${url}`);
    } else {
      result = await gotoPageWithRetries(page, url, options, releaseNavigation);
    }

    if (isDorasuta) {
      await throwIfDorasutaIpBlocked(page);
      await waitForCloudflare(page);
      await waitForDorasutaAvailability(page, url, options, releaseNavigation);
    }
    return result;
  } finally {
    releaseNavigation();
  }
}

/** Connect to the user's existing Chromium context over CDP. */
export async function connectToBrowser() {
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];

  if (!context) {
    throw new Error('No Chromium browser context found.');
  }

  context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

  return { browser, context };
}

function findOpenPage(context, hostname) {
  return context.pages().find((page) => {
    try {
      return new URL(page.url()).hostname.includes(hostname);
    } catch {
      return false;
    }
  });
}

/** Reuse an open site tab or create one at the supplied fallback URL. */
export async function getOrCreatePage(context, hostname, fallbackUrl) {
  const existing = findOpenPage(context, hostname);

  if (existing) {
    outputLog(`Using existing ${hostname} tab: ${existing.url()}`);
    if (hostname === DORASUTA_HOSTNAME) {
      await throwIfDorasutaIpBlocked(existing);
      await waitForCloudflare(existing);
    }
    return existing;
  }

  outputLog(`No ${hostname} tab found. Opening ${fallbackUrl}`);
  const page = await context.newPage();

  try {
    await gotoAndWait(page, fallbackUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  } catch (error) {
    if (error.code === 'CLOUDFLARE_TIMEOUT') {
      throw error;
    }

    outputLog(`Navigation warning for ${hostname}: ${error.message}`);
    if (hostname === DORASUTA_HOSTNAME) {
      await throwIfDorasutaIpBlocked(page);
      await waitForCloudflare(page);
    }
    outputLog(`Current URL: ${page.url()}`);
  }

  return page;
}
