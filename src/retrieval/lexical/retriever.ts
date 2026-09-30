import type { Bm25Config } from "../../config/schema.js";
import type { NormalizedQuery, RetrievalResult } from "../../core/types.js";
import type { LexicalRetriever } from "../interfaces.js";
import type { InMemoryBm25Index } from "./bm25f.js";

/**
 * LexicalRetriever adapter over the in-memory BM25F index.
 * Swapping BM25 for another lexical engine means implementing LexicalRetriever;
 * nothing else in the system changes.
 */
export class Bm25Retriever implements LexicalRetriever {
  readonly id = "bm25";

  constructor(
    private readonly index: InMemoryBm25Index,
    private readonly config: Bm25Config,
  ) {
    if (!config.enabled) {
      throw new Error("Bm25Retriever created while retrieval.bm25.enabled is false");
    }
  }

  async search(query: NormalizedQuery, limit: number): Promise<RetrievalResult[]> {
    return this.index.search(query, limit);
  }

  async size(): Promise<number> {
    return this.index.documentCount;
  }
}
