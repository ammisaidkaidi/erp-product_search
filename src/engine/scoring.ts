import type { RankedResult, SearchCandidate } from "../core/types.js";
import type { RankingConfig } from "../config/schema.js";

/**
 * Final ranking policy. The engine delegates the "how do we order the final
 * results and what is finalScore" decision here.
 *
 * Policies:
 *  - reranker-first (default): order by reranker score, ties broken by RRF.
 *    finalScore = reranker score (or rrfScore when no reranking ran).
 *  - weighted (experimental, must be enabled explicitly): 
 *      FinalScore = a*normBM25 + b*normVector + g*normRRF + d*rerankerScore
 *    with min-max normalization computed over the candidate set.
 */
export interface RankingPolicy {
  readonly id: string;
  finalize(ranked: RankedResult[], candidates: Map<string, SearchCandidate>): Array<RankedResult & { finalScore: number }>;
}

export class RerankerFirstPolicy implements RankingPolicy {
  readonly id = "reranker";

  finalize(
    ranked: RankedResult[],
    _candidates: Map<string, SearchCandidate>,
  ): Array<RankedResult & { finalScore: number }> {
    return ranked
      .map((r) => ({ ...r, finalScore: r.score }))
      .sort(
        (a, b) =>
          b.finalScore - a.finalScore ||
          b.candidate.rrfScore - a.candidate.rrfScore ||
          (a.candidate.product.productId < b.candidate.product.productId ? -1 : 1),
      );
  }
}

export class WeightedScorePolicy implements RankingPolicy {
  readonly id = "weighted";
  constructor(private readonly config: RankingConfig) {}

  finalize(
    ranked: RankedResult[],
    candidates: Map<string, SearchCandidate>,
  ): Array<RankedResult & { finalScore: number }> {
    const w = this.config.weights;
    const all = ranked.map((r) => r.candidate);
    const bm25Range = minMax(all.map((c) => c.bm25?.score ?? 0));
    const vectorRange = minMax(all.map((c) => c.vector?.score ?? 0));
    const rrfRange = minMax(all.map((c) => c.rrfScore));
    const rerankerRange = minMax(ranked.map((r) => r.score));

    return ranked
      .map((r) => {
        const c = r.candidate;
        const finalScore =
          w.bm25 * normalize(c.bm25?.score ?? 0, bm25Range) +
          w.vector * normalize(c.vector?.score ?? 0, vectorRange) +
          w.rrf * normalize(c.rrfScore, rrfRange) +
          w.reranker * normalize(r.score, rerankerRange);
        return { ...r, finalScore };
      })
      .sort(
        (a, b) =>
          b.finalScore - a.finalScore ||
          (a.candidate.product.productId < b.candidate.product.productId ? -1 : 1),
      );
  }
}

interface MinMax {
  min: number;
  max: number;
}

function minMax(values: number[]): MinMax {
  if (values.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

function normalize(value: number, range: MinMax): number {
  const span = range.max - range.min;
  if (span <= 0) return 0;
  return (value - range.min) / span;
}

export function createRankingPolicy(config: RankingConfig): RankingPolicy {
  return config.policy === "weighted" ? new WeightedScorePolicy(config) : new RerankerFirstPolicy();
}
