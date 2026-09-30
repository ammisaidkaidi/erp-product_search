import type { NormalizedQuery, RankedResult, SearchCandidate } from "../core/types.js";

/**
 * Reranker contract. The search engine depends ONLY on this interface —
 * whether the implementation is a cross-encoder, an LLM judge ("Von") or a
 * no-op is invisible to the engine.
 *
 * Contract:
 *  - receives the query + the fused candidate set (already limited to
 *    reranking.candidate_limit by the engine);
 *  - returns one RankedResult per candidate (same productIds, new order);
 *  - higher score = more relevant;
 *  - must never run against the whole catalog (the engine enforces the
 *    candidate limit, but implementations must not try to "help" by fetching
 *    more data themselves).
 */
export interface Reranker {
  readonly provider: string;
  /** Version for cache keys and benchmarks. */
  readonly version: string;
  /** Load model resources. Throws ModelUnavailableError if not installable. */
  init?(): Promise<void>;
  rank(query: NormalizedQuery, candidates: SearchCandidate[]): Promise<RankedResult[]>;
  dispose?(): Promise<void>;
}
