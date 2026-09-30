import type { Logger } from "../../logging/logger.js";
import type { PythonModelWorker } from "../../adapters/python-worker.js";

/**
 * Von backend contract.
 *
 * "Von" is treated as a local-LLM relevance judge: it receives the query and
 * candidate product texts and returns one relevance score in [0, 1] per
 * product. The rest of the system knows nothing beyond this interface —
 * whether the backend is a Python-hosted LLM, an ONNX graph or a mock is an
 * implementation detail.
 *
 * Von is an EXPERIMENTALLY EVALUATED candidate, not an assumed winner: run
 * `search-index benchmark` before trusting it over a cross-encoder.
 */
export interface VonScore {
  productId: string;
  score: number;
}

export interface VonRerankRequest {
  query: string;
  documents: Array<{ id: string; text: string }>;
}

export interface VonBackend {
  readonly id: string;
  readonly modelVersion: string;
  rerank(request: VonRerankRequest): Promise<VonScore[]>;
  dispose?(): Promise<void>;
}

/**
 * Backend that delegates to the local Python worker (`model_worker.py`).
 * Unavailable when Python / transformers / the model are missing; the caller
 * (FallbackReranker / engine) then degrades to the configured fallback.
 */
export class PythonVonBackend implements VonBackend {
  readonly id = "python";
  readonly modelVersion: string;

  private readonly worker: PythonModelWorker;

  constructor(options: { model: string; worker: PythonModelWorker }) {
    this.worker = options.worker;
    this.modelVersion = `von:python:${options.model}`;
  }

  async rerank(request: VonRerankRequest): Promise<VonScore[]> {
    await this.worker.start();
    const response = await this.worker.request("rerank", {
      query: request.query,
      documents: request.documents,
    });
    if (!response.ok) {
      throw new Error(`von backend error (${response.error.code}): ${response.error.message}`);
    }
    const result = response.result as { scores?: Array<{ id?: string; score?: number }> };
    if (!result || !Array.isArray(result.scores)) {
      throw new Error("von backend returned malformed scores");
    }
    const out: VonScore[] = [];
    for (const entry of result.scores) {
      if (typeof entry?.id !== "string" || typeof entry.score !== "number") continue;
      out.push({ productId: entry.id, score: clamp01(entry.score) });
    }
    return out;
  }

  async dispose(): Promise<void> {
    await this.worker.dispose();
  }
}

/**
 * Deterministic mock backend for tests: scores = token-overlap(query, text)
 * with small char-similarity term. Scriptable failures exercise fallback.
 */
export class MockVonBackend implements VonBackend {
  readonly id = "mock";
  readonly modelVersion = "von:mock:v1";

  public failNextCount = 0;
  public calls = 0;

  async rerank(request: VonRerankRequest): Promise<VonScore[]> {
    this.calls += 1;
    if (this.failNextCount > 0) {
      this.failNextCount -= 1;
      throw new Error("mock von backend failure (scripted)");
    }
    const queryTokens = new Set(request.query.toLowerCase().split(/\s+/).filter(Boolean));
    return request.documents.map((doc) => {
      const docTokens = doc.text.toLowerCase().split(/[^a-zà-ÿ0-9]+/u).filter(Boolean);
      const docSet = new Set(docTokens);
      let overlap = 0;
      for (const token of queryTokens) {
        if (docSet.has(token)) overlap += 1;
      }
      const coverage = queryTokens.size === 0 ? 0 : overlap / queryTokens.size;
      const lengthPenalty = 1 / (1 + docTokens.length * 0.02);
      return { productId: doc.id, score: clamp01(coverage * 0.85 * lengthPenalty + 0.05) };
    });
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
