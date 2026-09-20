import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyCloudflareState,
  inspectCloudflare,
  waitForCloudflare,
} from '../src/browser.ts';

function cloudflareSignals(overrides = {}) {
  return {
    strongChallengeText: false,
    genericChallengeText: false,
    activeChallengeElement: false,
    activeTurnstileFrame: false,
    hasTurnstileToken: false,
    ipBlocked: false,
    ...overrides,
  };
}

test('does not wait forever when Dorasuta leaves a challenge token in the settled URL', async () => {
  let polls = 0;
  const page = {
    url: () => 'https://dorasuta.jp/cart?__cf_chl_rt_tk=stale-token',
    // The rendered page is a normal Dorasuta page, not a challenge.
    evaluate: async () => cloudflareSignals(),
    waitForTimeout: async () => {
      polls++;
    },
    waitForLoadState: async () => {},
  };

  assert.equal(await waitForCloudflare(page), false);
  assert.equal(polls, 0);
});

test('classifies Cloudflare states from rendered signals', () => {
  assert.equal(classifyCloudflareState(cloudflareSignals()), 'clear');
  assert.equal(
    classifyCloudflareState(
      cloudflareSignals({ activeChallengeElement: true }),
    ),
    'challenge',
  );
  assert.equal(
    classifyCloudflareState(
      cloudflareSignals({
        activeTurnstileFrame: true,
        hasTurnstileToken: false,
      }),
    ),
    'turnstile',
  );
  assert.equal(
    classifyCloudflareState(
      cloudflareSignals({
        activeTurnstileFrame: true,
        hasTurnstileToken: true,
      }),
    ),
    'clear',
  );
  assert.equal(
    classifyCloudflareState(cloudflareSignals({ ipBlocked: true })),
    'ip-blocked',
  );
});

test('inspects the current URL together with the rendered Cloudflare state', async () => {
  const inspection = await inspectCloudflare({
    url: () => 'https://dorasuta.jp/pokemon-card/product?pid=458388',
    evaluate: async () => cloudflareSignals({ activeTurnstileFrame: true }),
  });

  assert.deepEqual(inspection, {
    ...cloudflareSignals({ activeTurnstileFrame: true }),
    state: 'turnstile',
    url: 'https://dorasuta.jp/pokemon-card/product?pid=458388',
  });
});

test('waits through state transitions until the page is settled twice', async () => {
  const inspections = [
    cloudflareSignals({ activeChallengeElement: true }),
    cloudflareSignals({ activeTurnstileFrame: true }),
    cloudflareSignals(),
    cloudflareSignals(),
  ];
  let reads = 0;
  let polls = 0;
  const page = {
    url: () => 'https://dorasuta.jp/pokemon-card/product?pid=458388',
    evaluate: async () => inspections[reads++],
    waitForTimeout: async () => {
      polls++;
    },
    waitForLoadState: async () => {},
  };

  assert.equal(await waitForCloudflare(page), true);
  assert.equal(reads, 4);
  assert.equal(polls, 3);
});

test('stops immediately when Cloudflare reports an IP block', async () => {
  const page = {
    url: () => 'https://dorasuta.jp/pokemon-card/product?pid=458388',
    evaluate: async () => cloudflareSignals({ ipBlocked: true }),
  };

  await assert.rejects(waitForCloudflare(page), {
    code: 'DORASUTA_IP_BLOCKED',
  });
});
