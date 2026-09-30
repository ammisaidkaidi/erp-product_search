import type { SearchEngineConfig } from "../config/schema.js";
import type { Logger } from "../logging/logger.js";
import type { Product, ProductSearchDocument } from "../core/types.js";
import type { SearchDocumentBuilder } from "../document/builder.js";
import type { Embedder } from "../retrieval/vector/embedder.js";
import type { InMemoryBm25Index } from "../retrieval/lexical/bm25f.js";
import type { SearchStore } from "../store/search-store.js";
import type { IndexVersionTracker } from "../engine/version-tracker.js";

export interface IndexerDeps {
  store: SearchStore;
  builder: SearchDocumentBuilder;
  embedder: Embedder;
  bm25: InMemoryBm25Index;
  config: SearchEngineConfig;
  indexVersion: IndexVersionTracker;
  logger: Logger;
}

export interface IndexEvent {
  upserted: number;
  deleted: number;
  /** Products whose embedding was recomputed. */
  embedded: number;
  /** Products whose stored embedding was reused (hash + model unchanged). */
  reusedEmbeddings: number;
  indexVersion: number;
  durationMs: number;
}

/**
 * Indexing pipeline:
 *
 *   Product (ERP, read-only) -> canonical search_document -> BM25F (memory)
 *                                                    \----> embedding -> vector store
 *
 * Guarantees:
 *  - the ERP product is never modified;
 *  - embeddings are recomputed ONLY when document_hash or embedding model
 *    version changed (deterministic builder output => stable hashes);
 *  - every mutation bumps index_version (stored in search_configuration),
 *    which the engine folds into cache keys (no stale results).
 */
export class SearchIndexer {
  constructor(private readonly deps: IndexerDeps) {}

  async getIndexVersion(): Promise<number> {
    return this.deps.indexVersion.refresh();
  }

  async upsert(product: Product): Promise<IndexEvent> {
    return this.upsertBatch([product]);
  }

  async upsertBatch(products: Product[]): Promise<IndexEvent> {
    const start = performance.now();
    if (products.length === 0) {
      return this.emptyEvent(start);
    }
    const docs = products.map((p) => this.deps.builder.build(p));
    await this.deps.store.upsertSearchDocs(docs.map((product) => this.toRow(product)));
    this.deps.bm25.upsertMany(docs);
    const { embedded, reused } = await this.embedIfNeeded(docs);
    const indexVersion = await this.bumpIndexVersion();
    return {
      upserted: docs.length,
      deleted: 0,
      embedded,
      reusedEmbeddings: reused,
      indexVersion,
      durationMs: performance.now() - start,
    };
  }

  async delete(productId: string): Promise<IndexEvent> {
    return this.deleteBatch([productId]);
  }

  async deleteBatch(productIds: string[]): Promise<IndexEvent> {
    const start = performance.now();
    if (productIds.length === 0) return this.emptyEvent(start);
    await this.deps.store.deleteSearchDocs(productIds);
    for (const id of productIds) this.deps.bm25.delete(id);
    const indexVersion = await this.bumpIndexVersion();
    return {
      upserted: 0,
      deleted: productIds.length,
      embedded: 0,
      reusedEmbeddings: 0,
      indexVersion,
      durationMs: performance.now() - start,
    };
  }

  /**
   * Full rebuild from a provider: upserts every product, deletes products that
   * no longer exist, re-embeds changed documents, prunes embeddings of other
   * model versions.
   */
  async rebuild(products: AsyncIterable<Product> | Iterable<Product>, options: { dropFirst?: boolean } = {}): Promise<IndexEvent> {
    const start = performance.now();
    if (options.dropFirst) {
      await this.deps.store.setConfig("index", { version: 0, updatedAt: new Date().toISOString() });
      await this.deps.indexVersion.refresh();
    }

    let upserted = 0;
    let embedded = 0;
    let reused = 0;
    const seen = new Set<string>();

    const batch: Product[] = [];
    for await (const product of products) {
      batch.push(product);
      if (batch.length >= 500) {
        const r = await this.indexBatch(batch, seen);
        upserted += r.upserted;
        embedded += r.embedded;
        reused += r.reused;
        batch.length = 0;
      }
    }
    if (batch.length > 0) {
      const r = await this.indexBatch(batch, seen);
      upserted += r.upserted;
      embedded += r.embedded;
      reused += r.reused;
    }

    // Delete stale documents (products removed from the source).
    const stale: string[] = [];
    for await (const row of this.deps.store.iterateSearchDocs()) {
      if (!seen.has(row.productId)) stale.push(row.productId);
    }
    let deleted = 0;
    if (stale.length > 0) {
      await this.deps.store.deleteSearchDocs(stale);
      for (const id of stale) this.deps.bm25.delete(id);
      deleted = stale.length;
    }

    const indexVersion = await this.bumpIndexVersion();
    const event: IndexEvent = {
      upserted,
      deleted,
      embedded,
      reusedEmbeddings: reused,
      indexVersion,
      durationMs: performance.now() - start,
    };
    this.deps.logger.info("index rebuild complete", {
      upserted,
      deleted,
      embedded,
      reused,
      duration_ms: Math.round(event.durationMs),
      index_version: indexVersion,
    });
    return event;
  }

  /** Hydrate the in-memory BM25 index from the persistent store (startup). */
  async bootstrap(): Promise<{ documents: number }> {
    const start = performance.now();
    let count = 0;
    for await (const row of this.deps.store.iterateSearchDocs()) {
      this.deps.bm25.upsert(row.product);
      count += 1;
    }
    this.deps.logger.info("index bootstrapped", {
      documents: count,
      duration_ms: Math.round(performance.now() - start),
    });
    return { documents: count };
  }

  // ------------------------------------------------------------------ internals

  private async indexBatch(products: Product[], seen: Set<string>): Promise<{ upserted: number; embedded: number; reused: number }> {
    const docs = products.map((p) => this.deps.builder.build(p));
    for (const doc of docs) seen.add(doc.productId);
    await this.deps.store.upsertSearchDocs(docs.map((product) => this.toRow(product)));
    this.deps.bm25.upsertMany(docs);
    const { embedded, reused } = await this.embedIfNeeded(docs);
    return { upserted: docs.length, embedded, reused };
  }

  /** Embed only documents whose hash or embedding model version changed. */
  private async embedIfNeeded(docs: ProductSearchDocument[]): Promise<{ embedded: number; reused: number }> {
    const ids = docs.map((d) => d.productId);
    const meta = await this.deps.store.getEmbeddingMeta(ids);
    const toEmbed: ProductSearchDocument[] = [];
    let reused = 0;
    for (const doc of docs) {
      const m = meta.get(doc.productId);
      if (m && m.modelVersion === this.deps.embedder.modelVersion && m.documentHash === doc.documentHash) {
        reused += 1;
      } else {
        toEmbed.push(doc);
      }
    }
    let embedded = 0;
    const batchSize = Math.max(1, this.deps.config.embedding.batchSize);
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const chunk = toEmbed.slice(i, i + batchSize);
      const vectors = await this.deps.embedder.embedBatch(chunk.map((d) => d.searchDocument));
      await this.deps.store.upsertEmbeddings(
        chunk.map((doc, j) => ({
          productId: doc.productId,
          embedding: vectors[j]!,
          modelVersion: this.deps.embedder.modelVersion,
          documentHash: doc.documentHash,
        })),
      );
      embedded += chunk.length;
    }
    if (toEmbed.length > 0) {
      this.deps.logger.debug("embedded documents", { count: embedded, reused });
    }
    return { embedded, reused };
  }

  private async bumpIndexVersion(): Promise<number> {
    return this.deps.indexVersion.bump();
  }

  private toRow(product: ProductSearchDocument) {
    return {
      productId: product.productId,
      searchDocument: product.searchDocument,
      documentHash: product.documentHash,
      builderVersion: product.builderVersion,
      product,
      updatedAt: new Date(),
    };
  }

  private async emptyEvent(start: number): Promise<IndexEvent> {
    return {
      upserted: 0,
      deleted: 0,
      embedded: 0,
      reusedEmbeddings: 0,
      indexVersion: await this.getIndexVersion(),
      durationMs: performance.now() - start,
    };
  }
}
