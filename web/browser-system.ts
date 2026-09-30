/**
 * Browser composition root for the demo page.
 *
 * Mirrors createSearchSystem() (src/system.ts) using ONLY browser-safe
 * components — no pg store, no YAML loader, no python worker, no
 * transformers. What runs here is the real core library: the deterministic
 * French normalizer, the BM25F inverted index, the hashing embedder, RRF
 * fusion, the engine with cache/timings/degradations, and the incremental
 * indexer — compiled and executed 100% client-side.
 *
 * The only Node API the core needs is a synchronous createHash (sha1/sha256);
 * web/shims/node-crypto.ts provides it, bit-exact with node:crypto
 * (tests/unit/web-crypto-shim.test.ts), so embeddings and document hashes in
 * the browser match the Node/PostgreSQL deployment.
 */

import type { SearchEngineConfig } from "../src/config/schema.js";
import { DEFAULT_CONFIG } from "../src/config/schema.js";
import { NoopLogger, type Logger } from "../src/logging/logger.js";
import { SearchDocumentBuilder } from "../src/document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "../src/document/labels/fr.js";
import { InMemoryBm25Index } from "../src/retrieval/lexical/bm25f.js";
import { Bm25Retriever } from "../src/retrieval/lexical/retriever.js";
import { HashingEmbedder } from "../src/retrieval/vector/hashing-embedder.js";
import { StoreVectorRetriever } from "../src/retrieval/vector/retriever.js";
import { RrfFusion } from "../src/fusion/rrf.js";
import { SearchEngine } from "../src/engine/search-engine.js";
import { DocumentCache } from "../src/engine/document-cache.js";
import { NullCache } from "../src/engine/cache.js";
import { IndexVersionTracker } from "../src/engine/version-tracker.js";
import { SearchIndexer } from "../src/indexing/indexer.js";
import { MemorySearchStore } from "../src/store/memory-store.js";
import { DeterministicNormalizer } from "../src/normalize/deterministic.js";
import { FrenchNormalizer } from "../src/normalize/french.js";
import { FRENCH_DICTIONARY } from "../src/normalize/dictionaries/fr.js";
import { NoopReranker } from "../src/reranking/noop.js";
import type { Product } from "../src/core/types.js";

export interface DemoSystem {
  config: SearchEngineConfig;
  logger: Logger;
  engine: SearchEngine;
  indexer: SearchIndexer;
  documents: number;
  /** How long indexing took, ms — shown in the demo footer. */
  indexMs: number;
}

export interface BuildDemoSystemOptions {
  /** Config overrides merged onto DEFAULT_CONFIG (deep-merged). */
  configOverrides?: Partial<Record<string, unknown>>;
  logger?: Logger;
}

/**
 * Wires the library for in-browser use and indexes `products` into a fresh
 * in-memory store. Same inputs → same index, same rankings (deterministic).
 */
export async function buildDemoSystem(products: readonly Product[], options: BuildDemoSystemOptions = {}): Promise<DemoSystem> {
  const logger = options.logger ?? new NoopLogger();
  const config = structuredClone(DEFAULT_CONFIG) as SearchEngineConfig;
  // Demo tweaks on top of the shipped defaults:
  // - result cache OFF so every search shows fresh, real stage timings
  // - database section unused (memory store) but must not break bundling
  config.cache.enabled = false;
  config.database.url = undefined;

  const store = new MemorySearchStore();
  await store.init();

  const builder = new SearchDocumentBuilder({ labelMap: FRENCH_ATTRIBUTE_LABELS });
  const embedder = new HashingEmbedder({
    dimensions: config.embedding.dimensions,
    modelVersion: config.embedding.modelVersion,
  });

  const bm25 = new InMemoryBm25Index(config.retrieval.bm25, builder);
  const lexical = config.retrieval.bm25.enabled ? new Bm25Retriever(bm25, config.retrieval.bm25) : null;
  const vector = config.retrieval.vector.enabled
    ? new StoreVectorRetriever(store, embedder, config.retrieval.vector)
    : null;

  const fusion = new RrfFusion({ k: config.fusion.k, weights: config.fusion.weights });

  const language = new FrenchNormalizer({ dictionary: FRENCH_DICTIONARY, typo: config.normalization.typo });
  const normalizer = new DeterministicNormalizer(language);

  const reranker = new NoopReranker();

  const indexVersion = new IndexVersionTracker(store);
  await indexVersion.refresh();

  const documentCache = new DocumentCache(store, { lruMax: config.documents.lruMax });
  const cache = new NullCache();

  const engine = new SearchEngine({
    config,
    normalizer,
    lexical,
    vector,
    fusion,
    reranker,
    store,
    documentCache,
    cache,
    indexVersion,
    logger: logger.child({ component: "engine" }),
  });
  await engine.init();

  const indexer = new SearchIndexer({
    store,
    builder,
    embedder,
    bm25,
    config,
    indexVersion,
    logger: logger.child({ component: "indexer" }),
  });

  const t0 = performance.now();
  const event = await indexer.rebuild([...products]);
  const indexMs = performance.now() - t0;

  return {
    config,
    logger,
    engine,
    indexer,
    documents: event.upserted,
    indexMs,
  };
}
