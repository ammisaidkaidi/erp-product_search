import { errorSummary } from "../core/errors.js";
import type { Logger } from "../logging/logger.js";
import type { NormalizedQuery, RankedResult, SearchCandidate } from "../core/types.js";
import type { Reranker } from "./interfaces.js";

export interface FallbackInfo {
  from: string;
  to: string;
  error: string;
  at: string;
}

/**
 * Reranker chain with graceful degradation:
 *
 *   von unavailable -> cross-encoder -> noop (RRF order)
 *
 * Failures are LOGGED (never hidden) and recorded in `lastFallback` for
 * observability; the chain always terminates in a provider that cannot fail.
 * The chain itself implements Reranker, so the engine stays ignorant of
 * fallback mechanics.
 */
export class FallbackReranker implements Reranker {
  readonly provider: string;
  readonly version: string;

  private lastFallback: FallbackInfo | null = null;

  constructor(
    private readonly chain: Reranker[],
    private readonly logger: Logger,
  ) {
    if (chain.length === 0) throw new Error("FallbackReranker requires at least one reranker");
    this.provider = chain[0]!.provider;
    this.version = chain.map((r) => `${r.provider}@${r.version}`).join(">");
  }

  /** Last degradation, if any (observability; read after rank()). */
  get lastFallbackInfo(): FallbackInfo | null {
    return this.lastFallback;
  }

  async init(): Promise<void> {
    // Init only the primary; fallbacks are initialized lazily if used.
    await this.chain[0]!.init?.();
  }

  async rank(query: NormalizedQuery, candidates: SearchCandidate[]): Promise<RankedResult[]> {
    if (candidates.length === 0) return [];
    let lastError: unknown = null;
    for (let i = 0; i < this.chain.length; i++) {
      const reranker = this.chain[i]!;
      try {
        if (i > 0) await reranker.init?.();
        const ranked = await reranker.rank(query, candidates);
        if (i > 0) {
          this.lastFallback = {
            from: this.chain[0]!.provider,
            to: reranker.provider,
            error: lastError ? errorSummary(lastError).message : "unknown",
            at: new Date().toISOString(),
          };
        } else {
          this.lastFallback = null;
        }
        return ranked;
      } catch (e) {
        lastError = e;
        const next = this.chain[i + 1];
        this.logger.error("reranker failed, trying fallback", {
          provider: reranker.provider,
          fallback_to: next?.provider ?? "none",
          error: errorSummary(e).message,
        });
      }
    }
    // Every provider failed (should be impossible when noop terminates the chain).
    this.lastFallback = {
      from: this.chain[0]!.provider,
      to: "rrf",
      error: lastError ? errorSummary(lastError).message : "unknown",
      at: new Date().toISOString(),
    };
    // preserve RRF order deterministically instead of crashing the search
    return candidates
      .map((candidate) => ({ candidate, score: candidate.rrfScore, provider: "rrf-emergency" }))
      .sort((a, b) => b.score - a.score);
  }

  async dispose(): Promise<void> {
    for (const reranker of this.chain) {
      await reranker.dispose?.().catch(() => {});
    }
  }
}
