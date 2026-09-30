import type { FusionResult, RankScore, RetrievalResult } from "../core/types.js";
import { RRF_VERSION } from "../core/version.js";
import type { FusionStrategy, RetrievalList } from "./interfaces.js";

export interface RrfOptions {
  /** RRF constant; 60 is the canonical value from the original paper. */
  k: number;
  /** Optional per-source weights (default 1). */
  weights?: Record<string, number>;
}

/**
 * Reciprocal Rank Fusion:
 *
 *   RRF(d) = Σ_i  w_i / (k + rank_i(d))
 *
 * Ranks are 1-based. Rank-based fusion is deliberately used instead of score
 * averaging because BM25 (unbounded, ~0-30) and cosine similarity ([-1, 1])
 * have incomparable distributions.
 *
 * The implementation preserves product identity (merges duplicates by
 * productId), per-source ranks/scores, and exposes them for debugging.
 */
export class RrfFusion implements FusionStrategy {
  readonly id = "rrf";
  readonly version = RRF_VERSION;

  private readonly k: number;
  private readonly weights: Record<string, number>;

  constructor(options: RrfOptions) {
    if (options.k < 1) throw new Error(`RRF k must be >= 1, got ${options.k}`);
    this.k = options.k;
    this.weights = options.weights ?? {};
  }

  async fuse(lists: RetrievalList[], limit: number): Promise<FusionResult[]> {
    // productId -> per-source rank/score + running rrf score
    const fused = new Map<string, FusionResult>();
    for (const list of lists) {
      const weight = this.weights[list.source] ?? 1;
      const ranked = rank(list.results);
      for (const { result, rank } of ranked) {
        let entry = fused.get(result.productId);
        if (!entry) {
          entry = { productId: result.productId, rrfScore: 0, sources: {} };
          fused.set(result.productId, entry);
        }
        const sourceScore: RankScore = { rank, score: result.score };
        // Keep the best rank/score if a source appears twice (defensive).
        const existing = entry.sources[list.source];
        if (!existing || rank < existing.rank) {
          entry.sources[list.source] = sourceScore;
        }
        entry.rrfScore += weight / (this.k + rank);
      }
    }
    const out = [...fused.values()];
    out.sort((a, b) => b.rrfScore - a.rrfScore || (a.productId < b.productId ? -1 : 1));
    return out.slice(0, limit);
  }
}

function rank(results: RetrievalResult[]): Array<{ result: RetrievalResult; rank: number }> {
  // Preserve the retriever's ordering; rank = position (1-based).
  return results.map((result, i) => ({ result, rank: i + 1 }));
}
