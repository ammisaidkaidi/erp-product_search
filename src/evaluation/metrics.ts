import type { LatencySummary, MetricSummary } from "../core/types.js";

/**
 * Standard IR metrics. All are pure functions with hand-verified unit tests.
 *
 * Graded labels use gains 2^label - 1 (exponential, standard NDCG convention).
 * Binary relevance (dataset "relevant_product_ids") is label 1.
 */

export function recallAtK(relevant: ReadonlySet<string>, results: readonly string[], k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < Math.min(k, results.length); i++) {
    if (relevant.has(results[i]!)) hits += 1;
  }
  return hits / relevant.size;
}

export function mrrAtK(relevant: ReadonlySet<string>, results: readonly string[], k: number): number {
  for (let i = 0; i < Math.min(k, results.length); i++) {
    if (relevant.has(results[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(gains: ReadonlyMap<string, number>, results: readonly string[], k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, results.length); i++) {
    const gain = gains.get(results[i]!);
    if (gain !== undefined && gain > 0) {
      dcg += (2 ** gain - 1) / Math.log2(i + 2);
    }
  }
  const sortedGains = [...gains.values()].filter((g) => g > 0).sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, sortedGains.length); i++) {
    idcg += (2 ** sortedGains[i]! - 1) / Math.log2(i + 2);
  }
  if (idcg === 0) return 0;
  return dcg / idcg;
}

export interface QueryEvaluationInput {
  query: string;
  /** ordered result product ids for this query */
  results: string[];
  /** binary relevant set (label >= threshold) */
  relevant: ReadonlySet<string>;
  /** graded gains per product */
  gains: ReadonlyMap<string, number>;
}

export function computeMetrics(
  queries: readonly QueryEvaluationInput[],
  ks: { recall: readonly number[]; mrr: number; ndcg: number } = { recall: [1, 5, 10, 20], mrr: 10, ndcg: 10 },
): MetricSummary {
  const n = queries.length;
  if (n === 0) {
    return { recallAt1: 0, recallAt5: 0, recallAt10: 0, recallAt20: 0, mrrAt10: 0, ndcgAt10: 0 };
  }
  const recallSums = new Map<number, number>();
  let mrrSum = 0;
  let ndcgSum = 0;
  for (const q of queries) {
    for (const k of ks.recall) {
      recallSums.set(k, (recallSums.get(k) ?? 0) + recallAtK(q.relevant, q.results, k));
    }
    mrrSum += mrrAtK(q.relevant, q.results, ks.mrr);
    ndcgSum += ndcgAtK(q.gains, q.results, ks.ndcg);
  }
  const recallField = (k: number) => (recallSums.get(k) ?? 0) / n;
  return {
    recallAt1: recallField(1),
    recallAt5: recallField(5),
    recallAt10: recallField(10),
    recallAt20: recallField(20),
    mrrAt10: mrrSum / n,
    ndcgAt10: ndcgSum / n,
  };
}

export function latencySummary(samplesMs: readonly number[]): LatencySummary {
  if (samplesMs.length === 0) {
    return { p50Ms: 0, p90Ms: 0, p99Ms: 0, meanMs: 0, minMs: 0, maxMs: 0, queriesPerSecond: 0 };
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  const totalMs = sorted.reduce((s, v) => s + v, 0);
  return {
    p50Ms: round(at(0.5)),
    p90Ms: round(at(0.9)),
    p99Ms: round(at(0.99)),
    meanMs: round(mean),
    minMs: round(sorted[0]!),
    maxMs: round(sorted[sorted.length - 1]!),
    queriesPerSecond: totalMs > 0 ? round(1000 / mean, 2) : 0,
  };
}

function round(v: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
