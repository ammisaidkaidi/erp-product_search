import type { NormalizedQuery, RetrievalResult } from "../core/types.js";

/**
 * Lexical retrieval contract (BM25 and any future replacement:
 * tsvector, a native engine, an external service...).
 */
export interface LexicalRetriever {
  readonly id: string;
  search(query: NormalizedQuery, limit: number): Promise<RetrievalResult[]>;
  /** Number of documents currently indexed (observability). */
  size(): Promise<number>;
}

/**
 * Vector retrieval contract (pgvector today; any vector backend tomorrow).
 * Implementations own their embedder: search() embeds the normalized query
 * internally, then performs ANN search.
 */
export interface VectorRetriever {
  readonly id: string;
  search(query: NormalizedQuery, limit: number): Promise<RetrievalResult[]>;
  /** Number of vectors currently indexed (observability). */
  size(): Promise<number>;
}
