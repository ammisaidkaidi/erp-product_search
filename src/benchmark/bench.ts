import { createSearchSystem, type SearchSystem } from "../system.js";
import { generateCatalog } from "./catalog-generator.js";
import type { SearchEngineConfig } from "../config/schema.js";
import { DEFAULT_CONFIG, deepMerge, type DeepPartial } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import { percentile } from "./stats.js";

/**
 * Performance benchmark over synthetic catalogs (spec §48).
 *
 * Measures per catalog size:
 *   - indexing time (build documents + BM25 + embeddings)
 *   - heap memory before/after indexing
 *   - per-stage search latency (normalization / BM25 / vector / fusion /
 *     reranker) and end-to-end latency, over a fixed query workload
 *   - queries/sec
 *   - the bottleneck stage (highest mean latency share)
 *
 * The benchmark uses benchmark mode (cache disabled, quiet logs) and NEVER
 * touches production configuration.
 */
export interface BenchmarkSizeResult {
  size: number;
  documents: number;
  indexMs: number;
  docsPerSecond: number;
  heapBeforeMb: number;
  heapAfterMb: number;
  normalizationMs: number;
  bm25Ms: number;
  vectorMs: number;
  fusionMs: number;
  rerankerMs: number;
  totalMs: number;
  queriesPerSecond: number;
  p50Ms: number;
  p90Ms: number;
  bottleneck: string;
}

export interface BenchmarkOptions {
  sizes: number[];
  queryCount?: number;
  store?: "memory" | "postgres";
  configOverrides?: DeepPartial<SearchEngineConfig>;
  logger?: Logger;
}

const BENCH_QUERIES = [
  "tube 110 blanc",
  "T110B45",
  "raccord pvc 63",
  "câble rigide 2.5",
  "gaine icta 40 gris",
  "vanne papillon 50",
  "tube évacuation 4m",
  "Ø110",
  "coude 125",
  "joint caoutchouc noir",
  "tube assainissement 160",
  "chemin de câbles 20",
];

export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkSizeResult[]> {
  const results: BenchmarkSizeResult[] = [];
  const queryCount = options.queryCount ?? 200;

  for (const size of options.sizes) {
    const overrides: DeepPartial<SearchEngineConfig> = {
      mode: "benchmark",
      ...(options.configOverrides ?? {}),
    };
    const system = await createSearchSystem({
      config: deepMerge(DEFAULT_CONFIG, overrides),
      store: options.store ?? "memory",
      skipBootstrap: true,
      logger: options.logger,
    });
    try {
      const products = generateCatalog({ size, seed: 42 });

      global.gc?.();
      const heapBefore = process.memoryUsage().heapUsed / 1024 / 1024;
      const indexStart = performance.now();
      const event = await system.indexer.rebuild(products);
      const indexMs = performance.now() - indexStart;
      await system.documentCache.preload();
      global.gc?.();
      const heapAfter = process.memoryUsage().heapUsed / 1024 / 1024;

      // query workload (round-robin over BENCH_QUERIES, cache disabled)
      const stageTotals = { normalization: 0, bm25: 0, vector: 0, fusion: 0, reranker: 0, total: 0 };
      const totals: number[] = [];
      for (let i = 0; i < queryCount; i++) {
        const query = BENCH_QUERIES[i % BENCH_QUERIES.length]!;
        const debug = await system.engine.searchDebug(query, { noCache: true });
        stageTotals.normalization += debug.timings.normalizationMs;
        stageTotals.bm25 += debug.timings.bm25Ms ?? 0;
        stageTotals.vector += debug.timings.vectorMs ?? 0;
        stageTotals.fusion += debug.timings.fusionMs;
        stageTotals.reranker += debug.timings.rerankerMs;
        stageTotals.total += debug.timings.totalMs;
        totals.push(debug.timings.totalMs);
      }

      const means = {
        normalization: stageTotals.normalization / queryCount,
        bm25: stageTotals.bm25 / queryCount,
        vector: stageTotals.vector / queryCount,
        fusion: stageTotals.fusion / queryCount,
        reranker: stageTotals.reranker / queryCount,
      };
      const bottleneck = (Object.entries(means) as Array<[keyof typeof means, number]>)
        .sort((a, b) => b[1] - a[1])[0]![0];

      results.push({
        size,
        documents: event.upserted,
        indexMs: Math.round(indexMs),
        docsPerSecond: Math.round(event.upserted / (indexMs / 1000)),
        heapBeforeMb: Math.round(heapBefore),
        heapAfterMb: Math.round(heapAfter),
        normalizationMs: round3(means.normalization),
        bm25Ms: round3(means.bm25),
        vectorMs: round3(means.vector),
        fusionMs: round3(means.fusion),
        rerankerMs: round3(means.reranker),
        totalMs: round3(stageTotals.total / queryCount),
        queriesPerSecond: round3(1000 / (stageTotals.total / queryCount)),
        p50Ms: round3(percentile(totals, 0.5)),
        p90Ms: round3(percentile(totals, 0.9)),
        bottleneck,
      });
    } finally {
      await system.close();
    }
  }
  return results;
}

export function renderBenchmarkResults(results: BenchmarkSizeResult[]): string {
  const header =
    "| Catalog | Docs | Index (s) | docs/s | Heap Δ (MB) | norm ms | BM25 ms | vector ms | RRF ms | rerank ms | total ms | p50 | p90 | QPS | bottleneck |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = results.map(
    (r) =>
      `| ${r.size.toLocaleString("en-US")} | ${r.documents.toLocaleString("en-US")} | ${(r.indexMs / 1000).toFixed(1)} | ${r.docsPerSecond.toLocaleString("en-US")} | ${r.heapAfterMb - r.heapBeforeMb} | ${r.normalizationMs.toFixed(2)} | ${r.bm25Ms.toFixed(2)} | ${r.vectorMs.toFixed(2)} | ${r.fusionMs.toFixed(2)} | ${r.rerankerMs.toFixed(2)} | ${r.totalMs.toFixed(1)} | ${r.p50Ms.toFixed(1)} | ${r.p90Ms.toFixed(1)} | ${r.queriesPerSecond.toFixed(0)} | ${r.bottleneck} |`,
  );
  return [header, sep, ...rows].join("\n");
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Type helper re-exported for the CLI. */
export type { SearchSystem };
