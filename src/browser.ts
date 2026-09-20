/**
 * Browser/CDP navigation boundary.
 *
 * All page navigations go through `gotoAndWait`. That boundary paces
 * requests, waits for manual Cloudflare checks, handles Dorasuta rate limits,
 * reuses an already-loaded URL, and stops on an explicit IP block.
 */

import { chromium } from 'playwright';
import {
  CDP_ENDPOINT,
  CLOUDFLARE_MAX_WAIT_MS,
  CLOUDFLARE_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  DORASUTA_RATE_LIMIT_MAX_WAIT_MS,
  DORASUTA_RATE_LIMIT_RETRY_MS,
  DORASUTA_SEARCH_GAP_MS,
  NAVIGATION_GAP_MS,
  NAVIGATION_RETRY_ATTEMPTS,
  NAVIGATION_TIMEOUT_MS,
} from './config.ts';
import { outputLog, updateDashboard } from './output.ts';

let lastNavigationAt = 0;
let lastDorasutaSearchAt = 0;
let navigationQueue = Promise.resolve();

/** Resolve after the requested delay without blocking the event loop. */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** Enforce the global minimum delay between any two navigations. */
async function waitForNavigationGap() {
  let release: () => void = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = navigationQueue;

  navigationQueue = previous.then(() => turn);
  await previous;

  try {
    const elapsed = Date.now() - lastNavigationAt;
    const remaining = NAVIGATION_GAP_MS - elapsed;

    if (remaining > 0) {
      await sleep(remaining);
    }

    lastNavigationAt = Date.now();
  } finally {
    release();
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

async function isCloudflareChallenge(page) {
  try {
    return await page.evaluate(() => {
      const title = document.title ?? '';
      const body = document.body?.innerText ?? '';
      const text = `${title}\n${body}`.slice(0, 20_000);
      const challengeElement = document.querySelector(
        '#challenge-running, #challenge-stage, ' +
          'iframe[src*="challenges.cloudflare.com"]',
      );
      const emptyTurnstile = [
        ...document.querySelectorAll('input[name="cf-turnstile-response"]'),
      ].some((input) => !(input as HTMLInputElement).value);

      return Boolean(
        challengeElement ||
        emptyTurnstile ||
        /just a moment/i.test(title) ||
        /checking your browser|verifying you are human|performing security verification|enable javascript and cookies/i.test(
          text,
        ),
      );
    });
  } catch {
    return false;
  }
}

/** Wait for a challenge to finish; manual checkbox interaction is supported. */
async function waitForCloudflare(page) {
  if (!(await isCloudflareChallenge(page))) {
    return;
  }

  const startedAt = Date.now();

  updateDashboard({
    phase: 'Waiting for Cloudflare verification',
  });
  outputLog('  Cloudflare verification detected.');
  outputLog(
    '  Waiting for it to finish; complete the checkbox manually if needed...',
  );

  while (await isCloudflareChallenge(page)) {
    if (Date.now() - startedAt >= CLOUDFLARE_MAX_WAIT_MS) {
      throw new Error(
        `Cloudflare verification did not finish within ${CLOUDFLARE_MAX_WAIT_MS} ms.`,
      );
    }

    await page.waitForTimeout(CLOUDFLARE_POLL_MS);
  }

  outputLog('  Cloudflare verification finished.');
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
  try {
    return await page.evaluate(() => {
      const title = document.title ?? '';
      const body = document.body?.innerText ?? '';
      const text = `${title}\n${body}`;

      return /error\s*1006/i.test(text) && /banned your IP address/i.test(text);
    });
  } catch {
    return false;
  }
}

async function throwIfDorasutaIpBlocked(page) {
  if (await isDorasutaIpBlockedPage(page)) {
    const error = Object.assign(
      new Error(
        'Dorasuta blocked this IP address with Cloudflare error 1006. Stopping without retries.',
      ),
      { code: 'DORASUTA_IP_BLOCKED' },
    );

    throw error;
  }
}

/** Wait through Dorasuta's explicit rate-limit page with bounded retries. */
async function waitForDorasutaAvailability(page, url, options) {
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
    await gotoPageWithRetries(page, url, options);
    await throwIfDorasutaIpBlocked(page);
    await waitForCloudflare(page);
  }
}

function isRetryableNavigationError(error) {
  const message = String(error?.message ?? error);

  return /timeout|net::ERR_|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(message);
}

/** Navigate with bounded retries for transient browser or network failures. */
async function gotoPageWithRetries(page, url, options) {
  for (let attempt = 0; ; attempt++) {
    await waitForNavigationGap();

    try {
      return await page.goto(url, options);
    } catch (error) {
      await throwIfDorasutaIpBlocked(page);

      if (
        !isRetryableNavigationError(error) ||
        attempt >= NAVIGATION_RETRY_ATTEMPTS
      ) {
        throw error;
      }

      outputLog(
        `  Navigation failed; retrying (${attempt + 1}/${NAVIGATION_RETRY_ATTEMPTS})...`,
      );
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
  await throwIfDorasutaIpBlocked(page);

  let result = null;

  if (samePageUrl(page.url(), url)) {
    await waitForNavigationGap();
    const hostname = new URL(url).hostname;
    outputLog(`  Reusing ${hostname} page after pacing delay: ${url}`);
  } else {
    result = await gotoPageWithRetries(page, url, options);
  }

  await throwIfDorasutaIpBlocked(page);
  await waitForCloudflare(page);
  await waitForDorasutaAvailability(page, url, options);
  return result;
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
    await throwIfDorasutaIpBlocked(existing);
    await waitForCloudflare(existing);
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
    outputLog(`Navigation warning for ${hostname}: ${error.message}`);
    await throwIfDorasutaIpBlocked(page);
    await waitForCloudflare(page);
    outputLog(`Current URL: ${page.url()}`);
  }

  return page;
}
