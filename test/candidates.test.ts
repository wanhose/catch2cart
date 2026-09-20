import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAllCandidates } from '../src/providers/candidates.ts';

test('inspects every candidate sequentially, even after an earlier mismatch', async () => {
  const visited: string[] = [];
  const candidates = ['first-mismatch', 'matching-product', 'another-match'];

  const inspected = await inspectAllCandidates(
    candidates,
    async (candidate) => {
      visited.push(candidate);
      return { accepted: candidate !== 'first-mismatch' };
    },
  );

  assert.deepEqual(visited, candidates);
  assert.deepEqual(
    inspected.map(({ product }) => product.accepted),
    [false, true, true],
  );
});
