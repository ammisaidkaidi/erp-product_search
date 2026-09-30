import type { FusionResult, RetrievalResult } from "../core/types.js";

/** One ranked list from one retriever, tagged with its source id. */
export interface RetrievalList {
  source: "bm25" | "vector" | (string & {});
  results: RetrievalResult[];
}

/**
 * Score-fusion contract. Implementations receive per-retriever ranked lists
 * and produce a single fused ranking with per-source debug metadata.
 * RRF is the default; future implementations (weighted normalized scores,
 * learned fusion) plug in here.
 */
export interface FusionStrategy {
  readonly id: string;
  readonly version: string;
  fuse(lists: RetrievalList[], limit: number): Promise<FusionResult[]>;
}
