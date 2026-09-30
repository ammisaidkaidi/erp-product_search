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
  /**
   * Embeddings stored ONLY as L2-normalized Float32Arrays (cosine == dot
   * product) alongside their metadata — half the memory of float64 rows and
   * a single monomorphic scan surface for searchVectors.
   */
  private vectors = new Map<string, { productId: string; modelVersion: string; documentHash: string; vec: Float32Array }>();
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
      this.vectors.delete(id);
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
      const row = this.vectors.get(id);
      if (row) out.set(id, { modelVersion: row.modelVersion, documentHash: row.documentHash });
    }
    return out;
  }

  async upsertEmbeddings(rows: EmbeddingRow[]): Promise<void> {
    for (const row of rows) {
      this.vectors.set(row.productId, {
        productId: row.productId,
        modelVersion: row.modelVersion,
        documentHash: row.documentHash,
        vec: toNormalizedFloat32(row.embedding),
      });
    }
  }

  async deleteEmbeddings(ids: string[]): Promise<void> {
    for (const id of ids) this.vectors.delete(id);
  }

  async countEmbeddings(modelVersion: string): Promise<number> {
    let n = 0;
    for (const row of this.vectors.values()) {
      if (row.modelVersion === modelVersion) n += 1;
    }
    return n;
  }

  async searchVectors(embedding: number[], modelVersion: string, limit: number): Promise<RetrievalResult[]> {
    // Brute-force scan over pre-normalized Float32 vectors (dot product).
    // This store backs tests, benchmarks and offline development; for large
    // catalogs use PgSearchStore + pgvector ANN indexes (see docs/architecture.md).
    const dim = embedding.length;
    const q = toNormalizedFloat32(embedding);
    // Bounded top-K selection over parallel arrays instead of materializing
    // and sorting one result object per document: on a 50k x 384 catalog this
    // cut the vector stage from ~97ms to ~55ms per query (docs/performance.md).
    // Admission order (score desc, productId asc) is a total order, so the
    // selected top-K is identical to a full sort with the same comparator.
    const cap = Math.max(limit * 4, 256);
    const bufScore: number[] = [];
    const bufId: string[] = [];
    let worstScore = -Infinity;
    let worstId = "";
    const prune = (): void => {
      const order = bufScore.map((_, i) => i);
      order.sort((a, b) => bufScore[b]! - bufScore[a]! || (bufId[a]! < bufId[b]! ? -1 : 1));
      order.length = limit;
      const nextScore: number[] = [];
      const nextId: string[] = [];
      for (const i of order) {
        nextScore.push(bufScore[i]!);
        nextId.push(bufId[i]!);
      }
      bufScore.length = 0;
      bufId.length = 0;
      bufScore.push(...nextScore);
      bufId.push(...nextId);
      worstScore = bufScore.length > 0 ? bufScore[bufScore.length - 1]! : -Infinity;
      worstId = bufScore.length > 0 ? bufId[bufId.length - 1]! : "";
    };
    // values() (not entries()): avoids a per-entry array allocation per scan.
    // The dot product is unrolled by 4 to break the accumulator dependency
    // chain — measured 1.5x on a 50k x 384 catalog (see docs/performance.md).
    for (const entry of this.vectors.values()) {
      if (entry.modelVersion !== modelVersion) continue;
      const vec = entry.vec;
      if (vec.length !== dim) continue;
      if (!this.docs.has(entry.productId)) continue;
      let d0 = 0;
      let d1 = 0;
      let d2 = 0;
      let d3 = 0;
      let j = 0;
      for (; j + 3 < dim; j += 4) {
        d0 += q[j]! * vec[j]!;
        d1 += q[j + 1]! * vec[j + 1]!;
        d2 += q[j + 2]! * vec[j + 2]!;
        d3 += q[j + 3]! * vec[j + 3]!;
      }
      for (; j < dim; j++) d0 += q[j]! * vec[j]!;
      const score = d0 + d1 + d2 + d3;
      if (bufId.length >= cap) {
        if (score < worstScore || (score === worstScore && entry.productId >= worstId)) continue;
        prune();
      }
      bufScore.push(score);
      bufId.push(entry.productId);
    }
    prune();
    const out: RetrievalResult[] = [];
    for (let i = 0; i < Math.min(limit, bufId.length); i++) {
      out.push({ productId: bufId[i]!, score: bufScore[i]!, retrieverId: "vector" });
    }
    return out;
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

  async saveEvaluationQueries(entries: Array<{ query: string; relevantProductIds: string[]; notes?: string }>): Promise<void> {
    for (const entry of entries) {
      this.evaluationQueries.push(entry);
    }
  }

  async listEvaluationQueries(): Promise<Array<{ query: string; relevantProductIds: string[]; notes?: string }>> {
    return [...this.evaluationQueries];
  }

  readonly evaluationQueries: Array<{ query: string; relevantProductIds: string[]; notes?: string }> = [];
}

function toNormalizedFloat32(v: readonly number[]): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i]!;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  }
  return out;
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
