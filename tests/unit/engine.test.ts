import { describe, expect, it } from "vitest";
import { createTestSystem } from "../helpers/test-system.js";
import { NoopReranker } from "../../src/reranking/noop.js";
import type { Product } from "../../src/core/types.js";
import type { Reranker } from "../../src/reranking/interfaces.js";
import type { NormalizedQuery, RankedResult, SearchCandidate } from "../../src/core/types.js";
import { MemorySearchStore } from "../../src/store/memory-store.js";
import { StoreError } from "../../src/core/errors.js";

const products: Product[] = [
  { id: "P001245", code: "T110B45", name: "Tube PVC évacuation", attributes: { diameter: "110 mm", length: "4 m", color: "blanc", material: "PVC" } },
  { id: "P001246", code: "T110G45", name: "Tube PVC évacuation", attributes: { diameter: "110 mm", length: "4 m", color: "gris", material: "PVC" } },
  { id: "P001247", code: "T125B45", name: "Tube PVC évacuation", attributes: { diameter: "125 mm", length: "4 m", color: "blanc", material: "PVC" } },
  { id: "P001248", code: "R110B45", name: "Raccord PVC à bague", attributes: { diameter: "110 mm", color: "blanc", material: "PVC" } },
  { id: "P001249", code: "C3G15", name: "Câble rigide H07V-U 3G1.5", attributes: { section: "1.5 mm2", color: "bleu", material: "cuivre" } },
];

describe("SearchEngine (hybrid pipeline)", () => {
  it("returns top results with rich metadata for a normal query", async () => {
    const { engine } = await createTestSystem(products);
    const results = await engine.search("tube pvc 110 blanc");
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(10);
    const top = results[0]!;
    expect(top.rank).toBe(1);
    expect(top.product.searchDocument).toContain("Tube PVC");
    expect(top.retrieval.bm25 || top.retrieval.vector).toBeTruthy();
    expect(top.retrieval.rrf).toBeDefined();
    expect(top.finalScore).toBeGreaterThan(0);
    // determinism
    const again = await engine.search("tube pvc 110 blanc");
    expect(again.map((r) => r.productId)).toEqual(results.map((r) => r.productId));
  });

  it("finds the exact product by code", async () => {
    const { engine } = await createTestSystem(products);
    const results = await engine.search("T110B45");
    expect(results[0]?.productId).toBe("P001245");
  });

  it("respects the limit option", async () => {
    const { engine } = await createTestSystem(products);
    expect((await engine.search("tube", { limit: 2 })).length).toBeLessThanOrEqual(2);
    expect((await engine.search("tube", { limit: 100 })).length).toBeLessThanOrEqual(100);
  });

  it("returns empty for empty and whitespace queries (graceful, no crash)", async () => {
    const { engine } = await createTestSystem(products);
    expect(await engine.search("")).toEqual([]);
    expect(await engine.search("   ")).toEqual([]);
  });

  it("returns empty for unknown products (xyzabc999)", async () => {
    const { engine } = await createTestSystem(products);
    const results = await engine.search("xyzabc999");
    expect(results).toEqual([]);
  });

  it("handles very long queries gracefully", async () => {
    const { engine } = await createTestSystem(products);
    const long = `tube ${"evacuation pvc blanc diametre ".repeat(80)}`;
    const results = await engine.search(long);
    expect(Array.isArray(results)).toBe(true);
  });

  it("searchDebug exposes the complete pipeline", async () => {
    const { engine } = await createTestSystem(products, { config: { cache: { enabled: false } } });
    const debug = await engine.searchDebug("tube 110");
    expect(debug.query.normalized).toBeTruthy();
    expect(debug.retrieval.candidateCount).toBeGreaterThan(0);
    expect(debug.retrieval.candidateCount).toBeLessThanOrEqual(50);
    expect(debug.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(debug.timings.normalizationMs).toBeGreaterThanOrEqual(0);
    expect(debug.config.bm25TopK).toBe(50);
    expect(debug.config.vectorTopK).toBe(50);
    expect(debug.results.length).toBeGreaterThan(0);
    // top-50 policy: no more than 50 candidates ever reranked
    expect(debug.reranking.scores.length).toBeLessThanOrEqual(50);
  });

  it("caches results and invalidates on index version change", async () => {
    const { engine, indexer, cache } = await createTestSystem(products, {
      config: { cache: { enabled: true, maxEntries: 100, ttlMs: 60_000 } },
    });
    void cache;
    const r1 = await engine.search("tube pvc");
    const r2 = await engine.search("tube pvc");
    expect(r2.map((x) => x.productId)).toEqual(r1.map((x) => x.productId));

    // a mutation bumps index version -> cache must not serve stale results
    await indexer.upsert({ id: "P001250", code: "T110X45", name: "Tube PVC extra", attributes: { diameter: "110 mm", color: "blanc" } });
    await engine.reloadDocuments();
    const r3 = await engine.search("tube pvc extra");
    expect(r3[0]?.productId).toBe("P001250");
  });

  it("noCache option bypasses the cache", async () => {
    const { engine } = await createTestSystem(products);
    await engine.search("tube");
    const debug = await engine.searchDebug("tube");
    expect(debug.cache.hit).toBe(false);
    const fresh = await engine.search("tube", { noCache: true });
    expect(fresh.length).toBeGreaterThan(0);
  });

  it("degrades gracefully when one retriever fails (BM25 down)", async () => {
    const { engine } = await createTestSystem(products);
    // sabotage the lexical retriever through the engine internals via a broken config path:
    // use a broken engine constructed manually
    const system = await createTestSystem(products);
    const brokenEngine = new (await import("../../src/engine/search-engine.js")).SearchEngine({
      config: system.config,
      normalizer: new (await import("../../src/normalize/tokenizing-normalizer.js")).TokenizingNormalizer(),
      lexical: {
        id: "bm25",
        async search() {
          throw new StoreError("bm25 exploded");
        },
        async size() {
          return 0;
        },
      },
      vector: null,
      fusion: new (await import("../../src/fusion/rrf.js")).RrfFusion({ k: 60 }),
      reranker: new NoopReranker(),
      store: system.store,
      documentCache: new (await import("../../src/engine/document-cache.js")).DocumentCache(system.store),
      cache: new (await import("../../src/engine/cache.js")).NullCache(),
      indexVersion: system.indexVersion,
      logger: new (await import("../../src/logging/logger.js")).NoopLogger(),
    });
    await brokenEngine.init();
    const debug = await brokenEngine.searchDebug("tube");
    expect(debug.degradations.length).toBe(1);
    expect(debug.degradations[0]!.stage).toBe("retrieval");
    expect(debug.results).toEqual([]);
  });

  it("falls back to RRF ordering when the reranker throws", async () => {
    const brokenReranker: Reranker = {
      provider: "broken",
      version: "v1",
      async rank(_q: NormalizedQuery, candidates: SearchCandidate[]): Promise<RankedResult[]> {
        throw new Error("model exploded");
      },
    };
    const { engine } = await createTestSystem(products, { reranker: brokenReranker, config: { cache: { enabled: false } } });
    const debug = await engine.searchDebug("tube 110");
    expect(debug.reranking.degraded).toBe(true);
    expect(debug.reranking.provider).toBe("rrf-fallback");
    expect(debug.reranking.fallbackFor).toBe("broken");
    expect(debug.results.length).toBeGreaterThan(0);
    // results still ordered (by RRF via noop)
    expect(debug.results[0]!.retrieval.rrf!.score).toBeGreaterThanOrEqual(debug.results[1]!.retrieval.rrf!.score);
  });

  it("uses only vector retrieval when BM25 is disabled", async () => {
    const { engine } = await createTestSystem(products, {
      config: { retrieval: { bm25: { enabled: false } }, cache: { enabled: false } },
    });
    const results = await engine.search("raccord");
    expect(results.length).toBeGreaterThan(0);
    const debug = await engine.searchDebug("raccord");
    expect(debug.retrieval.bm25).toEqual([]);
    expect(debug.retrieval.vector.length).toBeGreaterThan(0);
  });

  it("indexer upsert/delete keep results consistent", async () => {
    const { engine, indexer } = await createTestSystem(products);
    await indexer.upsert({ id: "P009999", code: "Z999", name: "Zork spécial", attributes: {} });
    await engine.reloadDocuments();
    expect((await engine.search("zork"))[0]?.productId).toBe("P009999");
    await indexer.delete("P009999");
    await engine.reloadDocuments();
    expect(await engine.search("zork")).toEqual([]);
  });
});
