import type { LatencySummary, MetricSummary, SearchResult } from "../core/types.js";
import type { SearchEngine } from "../engine/search-engine.js";
import type { NormalizedDataset } from "./dataset.js";
import { computeMetrics, latencySummary, type QueryEvaluationInput } from "./metrics.js";

export interface EvaluationOptions {
  /** Top-K retrieved per query (default 20 so Recall@20 is computable). */
  limit?: number;
  /** Disable the result cache during evaluation (default true). */
  noCache?: boolean;
}

export interface QueryReport {
  query: string;
  recallAt10: number;
  mrrAt10: number;
  firstHitRank: number | null;
  relevantProductIds: string[];
  topResults: Array<{ productId: string; score: number }>;
}

export interface EvaluationReport {
  queryCount: number;
  metrics: MetricSummary;
  latency: LatencySummary;
  perQuery: QueryReport[];
}

/**
 * Offline evaluation of a fully-configured engine (retrieval + fusion +
 * reranking as configured). For reranker-only comparisons on frozen candidate
 * sets use RerankerBenchmark.
 */
export class Evaluator {
  constructor(private readonly engine: SearchEngine) {}

  async evaluate(dataset: NormalizedDataset, options: EvaluationOptions = {}): Promise<EvaluationReport> {
    const limit = options.limit ?? 20;
    const noCache = options.noCache ?? true;

    const inputs: QueryEvaluationInput[] = [];
    const perQuery: QueryReport[] = [];
    const latencies: number[] = [];

    for (const entry of dataset.queries) {
      const start = performance.now();
      let results: SearchResult[];
      if (noCache) {
        results = await this.engine.search(entry.query, { limit, noCache: true });
      } else {
        results = await this.engine.search(entry.query, { limit });
      }
      latencies.push(performance.now() - start);

      const resultIds = results.map((r) => r.productId);
      const relevant = new Set(entry.relevantProductIds);
      inputs.push({ query: entry.query, results: resultIds, relevant, gains: entry.gains });

      let firstHitRank: number | null = null;
      for (let i = 0; i < resultIds.length; i++) {
        if (relevant.has(resultIds[i]!)) {
          firstHitRank = i + 1;
          break;
        }
      }
      perQuery.push({
        query: entry.query,
        recallAt10: recall(relevant, resultIds, 10),
        mrrAt10: firstHitRank !== null && firstHitRank <= 10 ? 1 / firstHitRank : 0,
        firstHitRank,
        relevantProductIds: entry.relevantProductIds,
        topResults: results.slice(0, 10).map((r) => ({ productId: r.productId, score: r.finalScore })),
      });
    }

    return {
      queryCount: dataset.queries.length,
      metrics: computeMetrics(inputs),
      latency: latencySummary(latencies),
      perQuery,
    };
  }
}

function recall(relevant: ReadonlySet<string>, results: readonly string[], k: number): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let i = 0; i < Math.min(k, results.length); i++) {
    if (relevant.has(results[i]!)) hits += 1;
  }
  return hits / relevant.size;
}
