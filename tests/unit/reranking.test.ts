import { describe, expect, it } from "vitest";
import { VonReranker } from "../../src/reranking/von/reranker.js";
import { MockVonBackend } from "../../src/reranking/von/backend.js";
import { PythonVonBackend } from "../../src/reranking/von/backend.js";
import { PythonModelWorker } from "../../src/adapters/python-worker.js";
import { FallbackReranker } from "../../src/reranking/fallback.js";
import { NoopReranker } from "../../src/reranking/noop.js";
import { CrossEncoderReranker } from "../../src/reranking/cross-encoder.js";
import { MemorySearchStore } from "../../src/store/memory-store.js";
import { IndexVersionTracker } from "../../src/engine/version-tracker.js";
import { ConsoleLogger, NoopLogger } from "../../src/logging/logger.js";
import { DEFAULT_CONFIG } from "../../src/config/schema.js";
import type { NormalizedQuery, Product, SearchCandidate } from "../../src/core/types.js";
import { SearchDocumentBuilder } from "../../src/document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "../../src/document/labels/fr.js";

const builder = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });

function nq(text: string): NormalizedQuery {
  return {
    original: text,
    normalized: text,
    tokens: text.toLowerCase().split(/\s+/),
    attributes: {},
    attributeValues: {},
    codes: [],
    tokenProvenance: {},
    corrections: [],
    normalizerId: "test",
    normalizerVersion: "t",
    isEmpty: false,
    notes: [],
  };
}

function candidate(product: Product, rrfScore: number): SearchCandidate {
  return { product: builder.build(product), rrfScore };
}

const products: Product[] = [
  { id: "P1", code: "T110B45", name: "Tube PVC évacuation", attributes: { diameter: "110 mm", color: "blanc" } },
  { id: "P2", code: "T125B45", name: "Tube PVC évacuation", attributes: { diameter: "125 mm", color: "blanc" } },
  { id: "P3", code: "R110B45", name: "Raccord PVC", attributes: { diameter: "110 mm", color: "blanc" } },
];

describe("VonReranker", () => {
  it("maps backend scores onto candidates preserving productId and metadata", async () => {
    const backend = new MockVonBackend();
    const reranker = new VonReranker({ backend, config: DEFAULT_CONFIG.reranking.von });
    const candidates = products.map((p, i) => candidate(p, 0.03 - i * 0.001));
    const ranked = await reranker.rank(nq("tube 110 blanc"), candidates);
    expect(ranked).toHaveLength(3);
    for (const r of ranked) {
      expect(r.provider).toBe("von");
      expect(typeof r.score).toBe("number");
      expect(r.candidate.product.productId).toBeDefined();
      expect(r.candidate.rrfScore).toBeGreaterThan(0);
    }
    // the 110mm tube should outscore the 125mm one for this query
    const p1 = ranked.find((r) => r.candidate.product.productId === "P1")!;
    const p2 = ranked.find((r) => r.candidate.product.productId === "P2")!;
    expect(p1.score).toBeGreaterThan(p2.score);
  });

  it("returns every candidate even when the backend omits scores", async () => {
    const backend = new (class extends MockVonBackend {
      override async rerank(request: { documents: Array<{ id: string }> }) {
        // only scores the first document
        return [{ productId: request.documents[0]!.id, score: 0.9 }];
      }
    })();
    const reranker = new VonReranker({ backend, config: DEFAULT_CONFIG.reranking.von });
    const ranked = await reranker.rank(nq("tube"), products.map((p) => candidate(p, 0.01)));
    expect(ranked).toHaveLength(3);
    expect(ranked.find((r) => r.candidate.product.productId === "P1")!.score).toBeCloseTo(0.9);
    expect(ranked.find((r) => r.candidate.product.productId === "P2")!.score).toBe(0);
  });

  it("batches requests according to batch_size", async () => {
    const backend = new MockVonBackend();
    const reranker = new VonReranker({
      backend,
      config: { ...DEFAULT_CONFIG.reranking.von, batchSize: 2 },
    });
    await reranker.rank(nq("tube"), products.map((p) => candidate(p, 0.01)));
    expect(backend.calls).toBe(2); // 3 candidates / batch 2
  });

  it("propagates backend failures (no silent hiding)", async () => {
    const backend = new MockVonBackend();
    backend.failNextCount = 1;
    const reranker = new VonReranker({ backend, config: DEFAULT_CONFIG.reranking.von });
    await expect(reranker.rank(nq("tube"), products.map((p) => candidate(p, 0.01)))).rejects.toThrow(
      /mock von backend failure/,
    );
  });
});

describe("FallbackReranker", () => {
  it("falls back to the next provider and records the degradation", async () => {
    const von = new VonReranker({
      backend: (() => {
        const b = new MockVonBackend();
        b.failNextCount = 99;
        return b;
      })(),
      config: DEFAULT_CONFIG.reranking.von,
    });
    const noop = new NoopReranker();
    const chain = new FallbackReranker([von, noop], new NoopLogger());
    const candidates = products.map((p, i) => candidate(p, 0.03 - i * 0.005));
    const ranked = await chain.rank(nq("tube 110"), candidates);
    expect(ranked).toHaveLength(3);
    expect(ranked[0]!.provider).toBe("noop");
    expect(chain.lastFallbackInfo?.from).toBe("von");
    expect(chain.lastFallbackInfo?.to).toBe("noop");
  });

  it("uses the primary when healthy", async () => {
    const von = new VonReranker({ backend: new MockVonBackend(), config: DEFAULT_CONFIG.reranking.von });
    const chain = new FallbackReranker([von, new NoopReranker()], new NoopLogger());
    const ranked = await chain.rank(nq("tube"), products.map((p) => candidate(p, 0.01)));
    expect(ranked[0]!.provider).toBe("von");
    expect(chain.lastFallbackInfo).toBeNull();
  });

  it("terminal noop guarantees results even if everything fails", async () => {
    const exploding: NoopReranker[] = [];
    const boom = new (class extends NoopReranker {
      override async rank() {
        throw new Error("boom");
      }
    })();
    exploding.push(boom);
    const chain = new FallbackReranker([boom, new NoopReranker()], new NoopLogger());
    const ranked = await chain.rank(nq("q"), products.map((p) => candidate(p, 0.02)));
    expect(ranked).toHaveLength(3);
  });
});

describe("CrossEncoderReranker (optional dependency missing)", () => {
  it("reports ModelUnavailableError with remediation when transformers.js is absent", async () => {
    const reranker = new CrossEncoderReranker(DEFAULT_CONFIG.reranking.crossEncoder);
    try {
      await reranker.init();
      // if @huggingface/transformers IS installed (dev machine), verify it runs
      const ranked = await reranker.rank(nq("tube"), products.map((p) => candidate(p, 0.01)));
      expect(ranked.length).toBe(3);
    } catch (e) {
      expect((e as Error).name).toBe("ModelUnavailableError");
      expect((e as Error).message).toContain("@huggingface/transformers");
    }
  });
});

describe("PythonModelWorker + PythonVonBackend (real worker, no model deps)", () => {
  it("reports UNAVAILABLE when transformers is not installed, and fallback rescues the search", async () => {
    const logger = new ConsoleLogger("error", false);
    const worker = new PythonModelWorker({
      pythonPath: process.env.PYTHON_PATH ?? "python3",
      workerPath: "adapters/python/model_worker.py",
      args: ["--model", "dummy/model", "--backend", "llm"],
      timeoutMs: 15_000,
      warmupTimeoutMs: 30_000,
      logger,
    });
    const store = new MemorySearchStore();
    const tracker = new IndexVersionTracker(store);
    void tracker;
    const backend = new PythonVonBackend({ model: "dummy/model", worker });

    // If transformers IS installed in this environment, the mock fallback test
    // still passes because the chain returns *some* provider's results.
    const chain = new FallbackReranker(
      [new VonReranker({ backend, config: DEFAULT_CONFIG.reranking.von }), new NoopReranker()],
      logger,
    );
    const candidates = products.map((p, i) => candidate(p, 0.03 - i * 0.005));
    const ranked = await chain.rank(nq("tube 110"), candidates);

    expect(ranked.length).toBe(3);
    expect(["von", "noop"]).toContain(ranked[0]!.provider);
    if (ranked[0]!.provider === "noop") {
      // graceful degradation happened and was recorded + logged
      expect(chain.lastFallbackInfo).not.toBeNull();
    } else {
      // transformers is installed: von answered through the real worker
      expect(ranked.every((r) => r.score >= 0 && r.score <= 1)).toBe(true);
    }
    await worker.dispose();
  }, 60_000);
});
