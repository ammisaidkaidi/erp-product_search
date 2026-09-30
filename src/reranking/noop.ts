import type { NormalizedQuery, RankedResult, SearchCandidate } from "../core/types.js";
import type { Reranker } from "./interfaces.js";

/**
 * No-op reranker: keeps the RRF ordering and surfaces rrfScore as the score.
 * Used as the default (reranking disabled / "noop" provider) and as the
 * terminal fallback for every other provider.
 */
export class NoopReranker implements Reranker {
  readonly provider = "noop";
  readonly version = "noop-v1";

  async init(): Promise<void> {}

  async rank(_query: NormalizedQuery, candidates: SearchCandidate[]): Promise<RankedResult[]> {
    return candidates
      .map((candidate) => ({ candidate, score: candidate.rrfScore, provider: this.provider }))
      .sort((a, b) => b.score - a.score || (a.candidate.product.productId < b.candidate.product.productId ? -1 : 1));
  }
}
