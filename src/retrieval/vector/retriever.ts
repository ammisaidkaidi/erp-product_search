import type { NormalizedQuery, RetrievalResult } from "../../core/types.js";
import type { VectorRetriever } from "../interfaces.js";
import type { Embedder } from "./embedder.js";
import type { SearchStore } from "../../store/search-store.js";
import type { VectorConfig } from "../../config/schema.js";

/**
 * Vector retriever over any SearchStore (pgvector in production, in-memory in
 * tests/benchmarks). Embeds the normalized query with its own embedder, then
 * performs nearest-neighbor search filtered by the active embedding model
 * version. A configurable minimum similarity filters out-of-domain noise
 * ("xyzabc999" must not return random products).
 *
 * Swapping pgvector for another backend means implementing
 * SearchStore.searchVectors — the retriever and engine stay untouched.
 */
export class StoreVectorRetriever implements VectorRetriever {
  readonly id: string;

  constructor(
    private readonly store: SearchStore,
    private readonly embedder: Embedder,
    private readonly vectorConfig?: Pick<VectorConfig, "minScore">,
    id?: string,
  ) {
    this.id = id ?? `vector(${store.id})`;
  }

  async search(query: NormalizedQuery, limit: number): Promise<RetrievalResult[]> {
    if (query.isEmpty || limit <= 0) return [];
    const embedding = await this.embedder.embed(query.normalized);
    const results = await this.store.searchVectors(embedding, this.embedder.modelVersion, limit);
    const minScore = this.vectorConfig?.minScore ?? -1;
    return results.filter((r) => r.score >= minScore);
  }

  async size(): Promise<number> {
    return this.store.countEmbeddings(this.embedder.modelVersion);
  }
}
