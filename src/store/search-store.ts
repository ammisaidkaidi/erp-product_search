import type { ProductSearchDocument, RetrievalResult } from "../core/types.js";

/**
 * Persistence contract for the search projection.
 *
 * PostgreSQL (PgSearchStore) is the production implementation; the in-memory
 * store backs tests, benchmarks and no-database development. The engine and
 * indexer depend only on this interface.
 */

/** Persisted search-document row (reconstructible without the ERP product table). */
export interface SearchDocRow {
  productId: string;
  searchDocument: string;
  documentHash: string;
  builderVersion: string;
  /** Structured fields needed to rebuild the in-memory BM25F index and result objects. */
  product: ProductSearchDocument;
  updatedAt: Date;
}

export interface EmbeddingRow {
  productId: string;
  embedding: number[];
  modelVersion: string;
  documentHash: string;
}

export interface EmbeddingMeta {
  modelVersion: string;
  documentHash: string;
}

export interface SearchLogRow {
  searchId: string;
  query: string;
  normalizedQuery: string;
  resultProductIds: string[];
  latencyMs: number;
}

/** Behavior signal hook (click / select / purchase ...) — data model only in v1. */
export interface BehaviorEventRow {
  searchId?: string;
  eventType: string;
  query?: string;
  productId?: string;
  position?: number;
  payload?: Record<string, unknown>;
}

export interface SearchStore {
  readonly id: string;
  /** Create/verify schema. Idempotent. */
  init(): Promise<void>;
  close(): Promise<void>;

  upsertSearchDocs(rows: SearchDocRow[]): Promise<void>;
  deleteSearchDocs(ids: string[]): Promise<void>;
  getSearchDocs(ids: string[]): Promise<SearchDocRow[]>;
  /** Ordered iteration for bootstrap/rebuild (keyset-paginated on PG). */
  iterateSearchDocs(): AsyncIterable<SearchDocRow>;
  countSearchDocs(): Promise<number>;

  getEmbeddingMeta(ids: string[]): Promise<Map<string, EmbeddingMeta>>;
  upsertEmbeddings(rows: EmbeddingRow[]): Promise<void>;
  deleteEmbeddings(ids: string[]): Promise<void>;
  countEmbeddings(modelVersion: string): Promise<number>;

  /** Nearest-neighbor search; scores are cosine similarity in [ -1, 1 ]. */
  searchVectors(embedding: number[], modelVersion: string, limit: number): Promise<RetrievalResult[]>;

  getConfig(key: string): Promise<unknown | null>;
  setConfig(key: string, value: unknown): Promise<void>;

  logSearchEvent(row: SearchLogRow): Promise<void>;
  logBehaviorEvent(row: BehaviorEventRow): Promise<void>;
}
