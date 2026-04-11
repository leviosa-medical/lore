// Retrieval quality metrics for the eval harness.

/**
 * Fraction of expected titles present in the top-k retrieved.
 * @param {string[]} retrieved - Retrieved titles in rank order
 * @param {string[]} expected - Ground-truth expected titles
 * @param {number} k - Cutoff
 * @returns {number} Float in [0, 1]
 */
export function recallAtK(retrieved, expected, k) {
  if (expected.length === 0) return 1.0;
  const topK = new Set(retrieved.slice(0, k));
  let hits = 0;
  for (const title of expected) {
    if (topK.has(title)) hits++;
  }
  return hits / expected.length;
}

/**
 * Normalized Discounted Cumulative Gain at k.
 * @param {string[]} retrieved - Retrieved titles in rank order
 * @param {string[]} expected - Ground-truth expected titles
 * @param {number} k - Cutoff
 * @param {Map<string, number>} [grades] - Optional per-title relevance grades. Binary if omitted.
 * @returns {number} Float in [0, 1]
 */
export function ndcgAtK(retrieved, expected, k, grades) {
  const expectedSet = new Set(expected);

  const rel = (title) => {
    if (grades) return grades.get(title) || 0;
    return expectedSet.has(title) ? 1 : 0;
  };

  // DCG over retrieved
  let dcg = 0;
  const topK = retrieved.slice(0, k);
  for (let i = 0; i < topK.length; i++) {
    dcg += rel(topK[i]) / Math.log2(i + 2);
  }

  // IDCG: sort all relevance grades descending, take top-k
  const allGrades = grades
    ? expected.map((t) => grades.get(t) || 0)
    : expected.map(() => 1);
  allGrades.sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(allGrades.length, k); i++) {
    idcg += allGrades[i] / Math.log2(i + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}

/**
 * Returns 1.0 if retrieved is empty (correct abstention), 0.0 otherwise.
 * @param {string[]} retrieved
 * @returns {number}
 */
export function abstentionAccuracy(retrieved) {
  return retrieved.length === 0 ? 1.0 : 0.0;
}

/**
 * Compute latency percentile statistics.
 * @param {number[]} latencies - Per-query wall-clock times in milliseconds
 * @returns {{ p50: number, p95: number, max: number }}
 */
export function latencyStats(latencies) {
  if (latencies.length === 0) return { p50: 0, p95: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    p50: sorted[Math.floor(0.5 * n)],
    p95: sorted[Math.floor(0.95 * n)],
    max: sorted[n - 1],
  };
}
