import type { FusionResult, MetricSummary, NormalizedQuery, RetrievalResult, SearchCandidate } from "../core/types.js";
import type { SearchSystem } from "../system.js";
import type { Reranker } from "../reranking/interfaces.js";
import type { NormalizedDataset } from "./dataset.js";
import { computeMetrics, latencySummary, type QueryEvaluationInput } from "./metrics.js";

export interface RerankerBenchmarkOptions {
  /** candidates per query frozen for every reranker (default: fusion top-K). */
  candidateLimit?: number;
  resultLimit?: number;
}

export interface RerankerBenchmarkRow {
  reranker: string;
  metrics: MetricSummary;
  rerankerLatency: { meanMs: number; p90Ms: number };
  totalLatency: { meanMs: number; p90Ms: number };
  /** requests where the provider threw (unavailable model...): RRF order used */
  failures?: number;
}

export interface RerankerBenchmarkReport {
  rows: RerankerBenchmarkRow[];
  /** fraction of queries whose frozen candidate set contains a relevant doc */
  candidateCoverage: number;
  queryCount: number;
}

/**
 * Reranker comparison on EXACTLY the same candidate sets (spec §28):
 *
 * For each evaluation query, the pipeline (normalization -> BM25 + Vector ->
 * RRF) runs ONCE; every reranker then ranks the same frozen Top-K candidates.
 * Differences in metrics are therefore attributable to the reranker alone —
 * never to retrieval variance.
 *
 * The first row is always "hybrid-only" (no reranker: RRF order), the baseline.
 */
export class RerankerBenchmark {
  constructor(private readonly system: SearchSystem) {}

  async run(
    dataset: NormalizedDataset,
    rerankers: Reranker[],
    options: RerankerBenchmarkOptions = {},
  ): Promise<RerankerBenchmarkReport> {
    const config = this.system.config;
    const candidateLimit = options.candidateLimit ?? config.fusion.topK;
    const resultLimit = options.resultLimit ?? config.search.defaultLimit;

    interface Frozen {
      query: string;
      normalized: NormalizedQuery;
      relevant: Set<string>;
      gains: Map<string, number>;
      candidates: SearchCandidate[];
      retrievalMs: number;
    }
    const frozen: Frozen[] = [];
    let covered = 0;

    for (const entry of dataset.queries) {
      const start = performance.now();
      let normalized: NormalizedQuery;
      try {
        normalized = await this.system.normalizer.normalize(entry.query);
      } catch {
        continue;
      }

      const lists: Array<{ source: "bm25" | "vector"; results: RetrievalResult[] }> = [];
      const bm25Results = this.system.lexical
        ? await this.system.lexical.search(normalized, config.retrieval.bm25.topK).catch(() => [])
        : [];
      if (bm25Results.length > 0) lists.push({ source: "bm25", results: bm25Results });
      const vectorResults = this.system.vector
        ? await this.system.vector.search(normalized, config.retrieval.vector.topK).catch(() => [])
        : [];
      if (vectorResults.length > 0) lists.push({ source: "vector", results: vectorResults });

      const fused: FusionResult[] = await this.system.fusion.fuse(lists, candidateLimit);
      const docs = await this.system.documentCache.getMany(fused.map((f) => f.productId));
      const candidates: SearchCandidate[] = [];
      for (let i = 0; i < fused.length; i++) {
        const doc = docs[i];
        if (!doc) continue;
        candidates.push({
          product: doc,
          rrfScore: fused[i]!.rrfScore,
          bm25: fused[i]!.sources.bm25,
          vector: fused[i]!.sources.vector,
        });
      }
      const retrievalMs = performance.now() - start;

      const relevant = new Set(entry.relevantProductIds);
      if (candidates.some((c) => relevant.has(c.product.productId))) covered += 1;
      frozen.push({ query: entry.query, normalized, relevant, gains: entry.gains, candidates, retrievalMs });
    }

    const hybridOnly: Reranker = {
      provider: "hybrid-only",
      version: "rrf",
      async rank(_query, candidates) {
        return candidates
          .map((candidate) => ({ candidate, score: candidate.rrfScore, provider: "hybrid-only" }))
          .sort((a, b) => b.score - a.score);
      },
    };

    const rows: RerankerBenchmarkRow[] = [];
    for (const reranker of [hybridOnly, ...rerankers]) {
      const inputs: QueryEvaluationInput[] = [];
      const rerankLatencies: number[] = [];
      const totalLatencies: number[] = [];
      let failures = 0;

      for (const entry of frozen) {
        const start = performance.now();
        let orderedIds: string[];
        try {
          const ranked = await reranker.rank(entry.normalized, entry.candidates);
          orderedIds = ranked.map((r) => r.candidate.product.productId);
        } catch {
          // provider unavailable for this run: count it, fall back to RRF order
          failures += 1;
          orderedIds = [...entry.candidates]
            .sort((a, b) => b.rrfScore - a.rrfScore)
            .map((c) => c.product.productId);
        }
        const rerankMs = performance.now() - start;
        rerankLatencies.push(rerankMs);
        totalLatencies.push(entry.retrievalMs + rerankMs);
        inputs.push({
          query: entry.query,
          results: orderedIds.slice(0, resultLimit),
          relevant: entry.relevant,
          gains: entry.gains,
        });
      }

      const rerankerSummary = latencySummary(rerankLatencies);
      const totalSummary = latencySummary(totalLatencies);
      const row: RerankerBenchmarkRow = {
        reranker: reranker.provider,
        metrics: computeMetrics(inputs),
        rerankerLatency: { meanMs: rerankerSummary.meanMs, p90Ms: rerankerSummary.p90Ms },
        totalLatency: { meanMs: totalSummary.meanMs, p90Ms: totalSummary.p90Ms },
      };
      if (failures > 0) row.failures = failures;
      rows.push(row);
    }

    return {
      rows,
      candidateCoverage: frozen.length > 0 ? Math.round((covered / frozen.length) * 1000) / 1000 : 0,
      queryCount: frozen.length,
    };
  }
}

/** Markdown table rendering (spec §28 shape). */
export function renderBenchmarkTable(report: RerankerBenchmarkReport): string {
  const header = "| Reranker | Recall@10 | MRR@10 | NDCG@10 | Rerank p50 (ms) | Total p50 (ms) | Failures |";
  const separator = "|---|---|---|---|---|---|---|";
  const lines = report.rows.map((row) => {
    const r = (v: number) => v.toFixed(3);
    return `| ${row.reranker} | ${r(row.metrics.recallAt10)} | ${r(row.metrics.mrrAt10)} | ${r(row.metrics.ndcgAt10)} | ${row.rerankerLatency.meanMs.toFixed(1)} | ${row.totalLatency.meanMs.toFixed(1)} | ${row.failures ?? 0} |`;
  });
  return [
    `Queries: ${report.queryCount} — candidate coverage@${report.candidateCoverage}`,
    header,
    separator,
    ...lines,
  ].join("\n");
}
