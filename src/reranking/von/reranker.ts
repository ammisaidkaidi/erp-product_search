import type { VonConfig } from "../../config/schema.js";
import type { NormalizedQuery, RankedResult, SearchCandidate } from "../../core/types.js";
import type { Reranker } from "../interfaces.js";
import type { VonBackend } from "./backend.js";

export interface VonRerankerOptions {
  backend: VonBackend;
  config: VonConfig;
}

/**
 * Von reranker adapter.
 *
 * Responsibilities (and nothing more):
 *  1. receive the query + candidates (already limited by the engine)
 *  2. build the Von decision input: (query, searchDocument) pairs, truncated
 *  3. obtain relevance scores from the backend (batched)
 *  4. map scores back onto candidates, preserving productId + retrieval metadata
 *  5. return ranked candidates
 *
 * Every candidate is returned (missing scores map to 0) so retrieval metadata
 * is never lost. Backend/model failures propagate to the engine, which falls
 * back to the configured fallback reranker — loudly, never silently.
 */
export class VonReranker implements Reranker {
  readonly provider = "von";
  readonly version: string;

  private readonly backend: VonBackend;
  private readonly config: VonConfig;

  constructor(options: VonRerankerOptions) {
    this.backend = options.backend;
    this.config = options.config;
    this.version = this.backend.modelVersion;
  }

  /**
   * Availability is probed lazily on the first rank() (a hard probe at startup
   * would slow every boot for an optional provider); failures then flow to the
   * configured fallback chain and are logged.
   */
  async init(): Promise<void> {}

  async rank(query: NormalizedQuery, candidates: SearchCandidate[]): Promise<RankedResult[]> {
    if (candidates.length === 0) return [];
    const documents = candidates.map((c) => ({
      id: c.product.productId,
      text: c.product.searchDocument.slice(0, this.config.maxTextLength),
    }));

    const scores = new Map<string, number>();
    const batchSize = Math.max(1, this.config.batchSize);
    for (let i = 0; i < documents.length; i += batchSize) {
      const chunk = documents.slice(i, i + batchSize);
      const chunkScores = await this.backend.rerank({
        query: query.normalized.slice(0, this.config.maxTextLength),
        documents: chunk,
      });
      for (const s of chunkScores) scores.set(s.productId, s.score);
    }

    return candidates.map((candidate) => ({
      candidate,
      score: scores.get(candidate.product.productId) ?? 0,
      provider: this.provider,
    }));
  }

  async dispose(): Promise<void> {
    await this.backend.dispose?.();
  }
}
