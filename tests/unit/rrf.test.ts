import { describe, expect, it } from "vitest";
import { RrfFusion } from "../../src/fusion/rrf.js";
import type { RetrievalResult } from "../../src/core/types.js";

function rr(productId: string, score: number): RetrievalResult {
  return { productId, score, retrieverId: "bm25" };
}

describe("RrfFusion", () => {
  it("computes RRF(d) = Σ 1/(k + rank_i(d)) with 1-based ranks", async () => {
    const fusion = new RrfFusion({ k: 60 });
    const bm25: RetrievalResult[] = [
      { productId: "P1", score: 14.72, retrieverId: "bm25" },
      { productId: "P2", score: 10.1, retrieverId: "bm25" },
    ];
    const vector: RetrievalResult[] = [
      { productId: "P2", score: 0.9, retrieverId: "vector" },
      { productId: "P1", score: 0.823, retrieverId: "vector" },
      { productId: "P3", score: 0.71, retrieverId: "vector" },
    ];
    const fused = await fusion.fuse(
      [
        { source: "bm25", results: bm25 },
        { source: "vector", results: vector },
      ],
      10,
    );

    const p1 = fused.find((f) => f.productId === "P1")!;
    // bm25 rank 1, vector rank 2
    expect(p1.rrfScore).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(p1.sources.bm25).toEqual({ rank: 1, score: 14.72 });
    expect(p1.sources.vector).toEqual({ rank: 2, score: 0.823 });

    const p2 = fused.find((f) => f.productId === "P2")!;
    expect(p2.rrfScore).toBeCloseTo(1 / 62 + 1 / 61, 10);
    // P1 and P2 have identical RRF scores; deterministic tie-break by id
    expect(fused[0]!.productId).toBe("P1");

    const p3 = fused.find((f) => f.productId === "P3")!;
    expect(p3.rrfScore).toBeCloseTo(1 / 63, 10);
    expect(p3.sources.vector).toEqual({ rank: 3, score: 0.71 });
    expect(p3.sources.bm25).toBeUndefined();
  });

  it("merges duplicates and preserves product identity", async () => {
    const fusion = new RrfFusion({ k: 60 });
    const fused = await fusion.fuse(
      [
        { source: "bm25", results: [rr("A", 1), rr("B", 1)] },
        { source: "vector", results: [rr("B", 1), rr("A", 1)] },
      ],
      10,
    );
    expect(fused.map((f) => f.productId).sort()).toEqual(["A", "B"]);
    for (const f of fused) {
      expect(f.sources.bm25).toBeDefined();
      expect(f.sources.vector).toBeDefined();
    }
  });

  it("applies per-source weights", async () => {
    const fusion = new RrfFusion({ k: 60, weights: { bm25: 2, vector: 1 } });
    const fused = await fusion.fuse(
      [
        { source: "bm25", results: [rr("A", 1)] },      // rank 1
        { source: "vector", results: [rr("B", 1)] },    // rank 1
      ],
      10,
    );
    const a = fused.find((f) => f.productId === "A")!;
    const b = fused.find((f) => f.productId === "B")!;
    expect(a.rrfScore).toBeCloseTo(2 / 61, 10);
    expect(b.rrfScore).toBeCloseTo(1 / 61, 10);
    expect(fused[0]!.productId).toBe("A");
  });

  it("respects the limit and orders by RRF score desc", async () => {
    const fusion = new RrfFusion({ k: 1 });
    const fused = await fusion.fuse(
      [
        { source: "bm25", results: [rr("A", 1), rr("B", 1), rr("C", 1)] },
      ],
      2,
    );
    expect(fused.map((f) => f.productId)).toEqual(["A", "B"]);
  });

  it("handles empty lists", async () => {
    const fusion = new RrfFusion({ k: 60 });
    expect(await fusion.fuse([], 10)).toEqual([]);
    expect(await fusion.fuse([{ source: "bm25", results: [] }], 10)).toEqual([]);
  });

  it("rejects k < 1", () => {
    expect(() => new RrfFusion({ k: 0 })).toThrow();
  });
});
