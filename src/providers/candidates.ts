/* eslint-disable no-unused-vars */
/**
 * Inspect candidates one at a time using the same browser page.
 *
 * Product pages are deliberately not inspected concurrently: providers apply
 * navigation pacing per tab, and a sequential traversal makes every numbered
 * result auditable without producing a burst of requests.
 */
export async function inspectAllCandidates<Candidate, Product>(
  candidates: readonly Candidate[],
  inspect: (
    candidate: Candidate,
    index: number,
    total: number,
  ) => Promise<Product>,
): Promise<Array<{ candidate: Candidate; product: Product }>> {
  const inspected: Array<{ candidate: Candidate; product: Product }> = [];

  for (const [index, candidate] of candidates.entries()) {
    inspected.push({
      candidate,
      product: await inspect(candidate, index, candidates.length),
    });
  }

  return inspected;
}
