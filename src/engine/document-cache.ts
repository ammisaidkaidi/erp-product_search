import type { ProductSearchDocument } from "../core/types.js";
import type { SearchStore } from "../store/search-store.js";

/**
 * In-memory document cache with a persistent-store backing. Preloading the
 * full projection (default) is O(catalog) once at startup; a bounded LRU mode
 * is available for very large catalogs.
 */
export class DocumentCache {
  private documents = new Map<string, ProductSearchDocument>();
  private readonly lruMax: number;
  private preloaded = false;

  constructor(private readonly store: SearchStore, options: { lruMax?: number } = {}) {
    this.lruMax = options.lruMax ?? 200_000;
  }

  /** Load all documents from the store. Idempotent. */
  async preload(): Promise<number> {
    this.documents.clear();
    let count = 0;
    for await (const row of this.store.iterateSearchDocs()) {
      this.documents.set(row.productId, row.product);
      count += 1;
    }
    this.preloaded = true;
    return count;
  }

  async getMany(ids: string[]): Promise<Array<ProductSearchDocument | null>> {
    const missing = ids.filter((id) => !this.documents.has(id));
    if (missing.length > 0 && this.preloaded === false) {
      // lazy mode: fetch unknown ids from the store
      const rows = await this.store.getSearchDocs(missing);
      for (const row of rows) this.put(row.product);
    }
    return ids.map((id) => this.documents.get(id) ?? null);
  }

  put(doc: ProductSearchDocument): void {
    if (this.documents.size >= this.lruMax && !this.documents.has(doc.productId)) {
      const oldest = this.documents.keys().next().value;
      if (oldest !== undefined) this.documents.delete(oldest);
    }
    this.documents.set(doc.productId, doc);
  }

  delete(productId: string): void {
    this.documents.delete(productId);
  }

  get size(): number {
    return this.documents.size;
  }
}
