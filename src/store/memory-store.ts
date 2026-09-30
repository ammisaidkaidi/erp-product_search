import type { RetrievalResult } from "../core/types.js";
import type {
  BehaviorEventRow,
  EmbeddingMeta,
  EmbeddingRow,
  SearchDocRow,
  SearchLogRow,
  SearchStore,
} from "./search-store.js";

/**
 * In-memory SearchStore: same contract as PgSearchStore, no database.
 * Backs unit tests, benchmarks and offline development. Data does not
 * survive the process.
 */
export class MemorySearchStore implements SearchStore {
  readonly id = "memory";
  private docs = new Map<string, SearchDocRow>();
  private embeddings = new Map<string, EmbeddingRow>();
  private config = new Map<string, unknown>();
  readonly searchLogs: SearchLogRow[] = [];
  readonly behaviorEvents: BehaviorEventRow[] = [];

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async upsertSearchDocs(rows: SearchDocRow[]): Promise<void> {
    for (const row of rows) {
      this.docs.set(row.productId, { ...row, updatedAt: new Date() });
    }
  }

  async deleteSearchDocs(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.docs.delete(id);
      this.embeddings.delete(id);
    }
  }

  async getSearchDocs(ids: string[]): Promise<SearchDocRow[]> {
    const out: SearchDocRow[] = [];
    for (const id of ids) {
      const row = this.docs.get(id);
      if (row) out.push(row);
    }
    return out;
  }

  async *iterateSearchDocs(): AsyncIterable<SearchDocRow> {
    for (const row of this.docs.values()) {
      yield row;
    }
  }

  async countSearchDocs(): Promise<number> {
    return this.docs.size;
  }

  async getEmbeddingMeta(ids: string[]): Promise<Map<string, EmbeddingMeta>> {
    const out = new Map<string, EmbeddingMeta>();
    for (const id of ids) {
      const row = this.embeddings.get(id);
      if (row) out.set(id, { modelVersion: row.modelVersion, documentHash: row.documentHash });
    }
    return out;
  }

  async upsertEmbeddings(rows: EmbeddingRow[]): Promise<void> {
    for (const row of rows) {
      this.embeddings.set(row.productId, { ...row });
    }
  }

  async deleteEmbeddings(ids: string[]): Promise<void> {
    for (const id of ids) this.embeddings.delete(id);
  }

  async countEmbeddings(modelVersion: string): Promise<number> {
    let n = 0;
    for (const row of this.embeddings.values()) {
      if (row.modelVersion === modelVersion) n += 1;
    }
    return n;
  }

  async searchVectors(embedding: number[], modelVersion: string, limit: number): Promise<RetrievalResult[]> {
    const results: RetrievalResult[] = [];
    for (const row of this.embeddings.values()) {
      if (row.modelVersion !== modelVersion) continue;
      if (row.embedding.length !== embedding.length) continue;
      if (!this.docs.has(row.productId)) continue;
      results.push({
        productId: row.productId,
        score: cosineSimilarity(embedding, row.embedding),
        retrieverId: "vector",
      });
    }
    results.sort((a, b) => b.score - a.score || (a.productId < b.productId ? -1 : 1));
    return results.slice(0, limit);
  }

  async getConfig(key: string): Promise<unknown | null> {
    return this.config.get(key) ?? null;
  }

  async setConfig(key: string, value: unknown): Promise<void> {
    this.config.set(key, value);
  }

  async logSearchEvent(row: SearchLogRow): Promise<void> {
    this.searchLogs.push(row);
  }

  async logBehaviorEvent(row: BehaviorEventRow): Promise<void> {
    this.behaviorEvents.push(row);
  }
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
