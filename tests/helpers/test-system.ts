import { InMemoryBm25Index } from "../../src/retrieval/lexical/bm25f.js";
import { Bm25Retriever } from "../../src/retrieval/lexical/retriever.js";
import { SearchDocumentBuilder } from "../../src/document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "../../src/document/labels/fr.js";
import { HashingEmbedder } from "../../src/retrieval/vector/hashing-embedder.js";
import { StoreVectorRetriever } from "../../src/retrieval/vector/retriever.js";
import { RrfFusion } from "../../src/fusion/rrf.js";
import { SearchEngine } from "../../src/engine/search-engine.js";
import { DocumentCache } from "../../src/engine/document-cache.js";
import { MemoryLruCache } from "../../src/engine/cache.js";
import { IndexVersionTracker } from "../../src/engine/version-tracker.js";
import { SearchIndexer } from "../../src/indexing/indexer.js";
import { MemorySearchStore } from "../../src/store/memory-store.js";
import { NoopLogger } from "../../src/logging/logger.js";
import { NoopReranker } from "../../src/reranking/noop.js";
import { TokenizingNormalizer } from "../../src/normalize/tokenizing-normalizer.js";
import { deepMerge, DEFAULT_CONFIG, type DeepPartial, type SearchEngineConfig } from "../../src/config/schema.js";
import type { Product } from "../../src/core/types.js";
import type { Reranker } from "../../src/reranking/interfaces.js";
import type { QueryNormalizer } from "../../src/normalize/interfaces.js";
import type { Embedder } from "../../src/retrieval/vector/embedder.js";

/**
 * Test helper: assembles a complete in-memory search system with swappable
 * components (mirrors what the production factory does, without PostgreSQL).
 */
export interface TestSystemOptions {
  config?: DeepPartial<SearchEngineConfig>;
  reranker?: Reranker;
  normalizer?: QueryNormalizer;
  embedder?: Embedder;
}

export async function createTestSystem(products: Product[], options: TestSystemOptions = {}) {
  const config = deepMerge(DEFAULT_CONFIG, options.config ?? {});
  const builder = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });
  const embedder = options.embedder ?? new HashingEmbedder({ dimensions: config.embedding.dimensions });
  const store = new MemorySearchStore();
  const bm25 = new InMemoryBm25Index(config.retrieval.bm25, builder);
  const logger = new NoopLogger();
  const indexVersion = new IndexVersionTracker(store);

  const indexer = new SearchIndexer({
    store,
    builder,
    embedder,
    bm25,
    config,
    indexVersion,
    logger,
  });

  const engine = new SearchEngine({
    config,
    normalizer: options.normalizer ?? new TokenizingNormalizer(),
    lexical: config.retrieval.bm25.enabled ? new Bm25Retriever(bm25, config.retrieval.bm25) : null,
    vector: config.retrieval.vector.enabled ? new StoreVectorRetriever(store, embedder, config.retrieval.vector) : null,
    fusion: new RrfFusion({ k: config.fusion.k, weights: config.fusion.weights }),
    reranker: options.reranker ?? new NoopReranker(),
    store,
    documentCache: new DocumentCache(store, { lruMax: config.documents.lruMax }),
    cache: new MemoryLruCache({ maxEntries: config.cache.maxEntries, ttlMs: config.cache.ttlMs }),
    indexVersion,
    logger,
  });

  await store.init();
  await indexer.rebuild(products);
  await engine.init();
  await engine.reloadDocuments();

  return { engine, indexer, store, bm25, embedder, builder, config, indexVersion };
}
