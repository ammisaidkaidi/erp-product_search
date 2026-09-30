import { describe, expect, it } from "vitest";
import { computeMetrics, latencySummary, mrrAtK, ndcgAtK, recallAtK } from "../../src/evaluation/metrics.js";
import { loadDataset } from "../../src/evaluation/dataset.js";
import { Evaluator } from "../../src/evaluation/evaluator.js";
import { RerankerBenchmark, renderBenchmarkTable } from "../../src/evaluation/reranker-benchmark.js";
import { createSearchSystem } from "../../src/system.js";
import { generateFixtureCatalog } from "../../src/benchmark/catalog-generator.js";
import { MockVonBackend } from "../../src/reranking/von/backend.js";
import { VonReranker } from "../../src/reranking/von/reranker.js";
import { NoopReranker } from "../../src/reranking/noop.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import { JsonCatalogProvider } from "../../src/indexing/product-provider.js";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("IR metrics (hand-verified)", () => {
  const relevant = new Set(["A", "B"]);
  const gains = new Map([
    ["A", 3],
    ["B", 1],
    ["C", 4],
  ]);

  it("recall@k", () => {
    expect(recallAtK(relevant, ["A", "X", "B"], 2)).toBeCloseTo(0.5);
    expect(recallAtK(relevant, ["A", "X", "B"], 3)).toBeCloseTo(1);
    expect(recallAtK(relevant, ["X", "Y"], 10)).toBe(0);
    expect(recallAtK(new Set(), ["X"], 10)).toBe(0);
  });

  it("mrr@k", () => {
    expect(mrrAtK(relevant, ["X", "A"], 10)).toBeCloseTo(0.5);
    expect(mrrAtK(relevant, ["A", "B"], 10)).toBeCloseTo(1);
    expect(mrrAtK(relevant, ["X", "Y", "A"], 2)).toBe(0); // beyond cutoff
    expect(mrrAtK(relevant, ["X"], 10)).toBe(0);
  });

  it("ndcg@k with graded gains", () => {
    // gains: A=3, B=1, C=4. IDCG@10 (ideal order C,A,B):
    //   15/log2(2) + 7/log2(3) + 1/log2(4)
    const idcg = 15 / Math.log2(2) + 7 / Math.log2(3) + 1 / Math.log2(4);
    // results [C, A]: DCG = 15 + 7/log2(3) (B unretrieved => < 1)
    expect(ndcgAtK(gains, ["C", "A"], 10)).toBeCloseTo((15 + 7 / Math.log2(3)) / idcg, 5);
    // all three retrieved in ideal order => 1.0
    expect(ndcgAtK(gains, ["C", "A", "B"], 10)).toBeCloseTo(1.0, 5);
    // reversed order of the top two
    const dcg = 7 / Math.log2(3) + 15 / Math.log2(2);
    expect(ndcgAtK(gains, ["A", "C"], 10)).toBeCloseTo(dcg / idcg, 5);
    // non-relevant entries in between
    expect(ndcgAtK(gains, ["X", "C"], 10)).toBeCloseTo(15 / Math.log2(2) / idcg, 5);
  });

  it("computeMetrics aggregates over queries", () => {
    const summary = computeMetrics([
      { query: "q1", results: ["A", "X"], relevant, gains },
      { query: "q2", results: ["Y"], relevant, gains },
    ]);
    expect(summary.recallAt1).toBeCloseTo(0.25); // q1: A@1 hit(1/2), q2: 0
    expect(summary.recallAt5).toBeCloseTo(0.25);
    expect(summary.mrrAt10).toBeCloseTo(0.5); // q1: 1/1, q2: 0
  });

  it("latencySummary percentiles", () => {
    const summary = latencySummary([10, 20, 30, 40, 100]);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(100);
    expect(summary.meanMs).toBeCloseTo(40, 1);
    expect(summary.p50Ms).toBe(30);
  });
});

describe("dataset loading", () => {
  it("loads graded JSONL and applies the relevance threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    const file = join(dir, "gold.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ query: "q", productId: "A", label: 4 }),
        JSON.stringify({ query: "q", productId: "B", label: 2 }),
        JSON.stringify({ query: "q2", productId: "C", label: 1 }),
      ].join("\n"),
      "utf8",
    );
    const dataset = await loadDataset(file);
    expect(dataset.format).toBe("graded");
    const q = dataset.queries.find((entry) => entry.query === "q")!;
    expect(q.gains.get("A")).toBe(4);
    expect(q.relevantProductIds).toEqual(["A", "B"]); // label >= 1
    const strict = await loadDataset(file, { relevantThreshold: 3 });
    const qStrict = strict.queries.find((entry) => entry.query === "q")!;
    expect(qStrict.relevantProductIds).toEqual(["A"]);
    await rm(dir, { recursive: true, force: true });
  });

  it("loads binary JSON datasets (spec format)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    const file = join(dir, "eval.json");
    await writeFile(file, JSON.stringify([{ query: "tube 110", relevantProductIds: ["P1", "P2"] }]), "utf8");
    const dataset = await loadDataset(file);
    expect(dataset.format).toBe("binary");
    expect(dataset.queries[0]!.relevantProductIds).toEqual(["P1", "P2"]);
    expect(dataset.queries[0]!.gains.get("P1")).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects malformed datasets with clear errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ds-"));
    const file = join(dir, "bad.json");
    await writeFile(file, JSON.stringify([{ query: "x" }]), "utf8");
    await expect(loadDataset(file)).rejects.toThrow(/relevant_product_ids/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("evaluation on the fixture catalog (end-to-end, in-memory)", () => {
  it("evaluates the full pipeline and reports sane metrics", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.cache.enabled = false;
    const system = await createSearchSystem({
      config,
      store: "memory",
      skipBootstrap: true,
    });
    try {
      await system.indexer.rebuild(new JsonCatalogProvider("fixtures/catalog-fr.json").fetchAll());
      await system.documentCache.preload();

      const dataset = await loadDataset("fixtures/gold-fr.jsonl");
      const report = await new Evaluator(system.engine).evaluate(dataset);
      expect(report.queryCount).toBe(28);
      // sanity: the pipeline must find most relevant products in top 10
      expect(report.metrics.recallAt10).toBeGreaterThan(0.5);
      expect(report.metrics.mrrAt10).toBeGreaterThan(0.3);
      expect(report.latency.p50Ms).toBeGreaterThanOrEqual(0);

      // exact-code query must hit rank 1
      const codeQuery = report.perQuery.find((q) => q.query === "TD110L4BL0")!;
      expect(codeQuery.firstHitRank).toBe(1);
    } finally {
      await system.close();
    }
  }, 60_000);

  it("compares rerankers on EXACTLY the same candidate sets", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.cache.enabled = false;
    const system = await createSearchSystem({ config, store: "memory", skipBootstrap: true });
    try {
      await system.indexer.rebuild(new JsonCatalogProvider("fixtures/catalog-fr.json").fetchAll());
      await system.documentCache.preload();

      const dataset = await loadDataset("fixtures/gold-fr.jsonl");
      const von = new VonReranker({
        backend: new MockVonBackend(),
        config: DEFAULT_CONFIG.reranking.von,
      });
      const benchmark = new RerankerBenchmark(system);
      const report = await benchmark.run(dataset, [new NoopReranker(), von]);

      // hybrid-only baseline + noop + von
      expect(report.rows.map((r) => r.reranker)).toEqual(["hybrid-only", "noop", "von"]);
      expect(report.queryCount).toBe(28);
      expect(report.candidateCoverage).toBeGreaterThan(0.5);

      const table = renderBenchmarkTable(report);
      expect(table).toContain("hybrid-only");
      expect(table).toContain("von");

      // von (overlap scorer) should not be wildly worse than hybrid-only here:
      // the assertion documents that mock-von is a baseline, not a quality claim
      const vonRow = report.rows.find((r) => r.reranker === "von")!;
      expect(vonRow.metrics.recallAt10).toBeGreaterThan(0);
    } finally {
      await system.close();
    }
  }, 60_000);
});
