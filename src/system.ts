import type { SearchEngineConfig } from "./config/schema.js";
import { createLogger, type Logger } from "./logging/logger.js";
import { SearchDocumentBuilder } from "./document/builder.js";
import { FRENCH_ATTRIBUTE_LABELS } from "./document/labels/fr.js";
import { InMemoryBm25Index } from "./retrieval/lexical/bm25f.js";
import { Bm25Retriever } from "./retrieval/lexical/retriever.js";
import { HashingEmbedder } from "./retrieval/vector/hashing-embedder.js";
import { MockEmbedder } from "./retrieval/vector/mock-embedder.js";
import { TransformersEmbedder } from "./retrieval/vector/transformers-embedder.js";
import type { Embedder } from "./retrieval/vector/embedder.js";
import { StoreVectorRetriever } from "./retrieval/vector/retriever.js";
import { RrfFusion } from "./fusion/rrf.js";
import { SearchEngine } from "./engine/search-engine.js";
import { DocumentCache } from "./engine/document-cache.js";
import { MemoryLruCache, NullCache, type SearchCache } from "./engine/cache.js";
import { IndexVersionTracker } from "./engine/version-tracker.js";
import { SearchIndexer } from "./indexing/indexer.js";
import { MemorySearchStore } from "./store/memory-store.js";
import { PgSearchStore } from "./store/pg-store.js";
import type { SearchStore } from "./store/search-store.js";
import { TokenizingNormalizer } from "./normalize/tokenizing-normalizer.js";
import { DeterministicNormalizer } from "./normalize/deterministic.js";
import { FrenchNormalizer } from "./normalize/french.js";
import { TinyLmNormalizer } from "./normalize/tiny-lm.js";
import { MockNormalizer } from "./normalize/mock.js";
import type { QueryNormalizer } from "./normalize/interfaces.js";
import { FRENCH_DICTIONARY } from "./normalize/dictionaries/fr.js";
import { NoopReranker } from "./reranking/noop.js";
import { CrossEncoderReranker } from "./reranking/cross-encoder.js";
import { VonReranker } from "./reranking/von/reranker.js";
import { MockVonBackend, PythonVonBackend } from "./reranking/von/backend.js";
import { FallbackReranker } from "./reranking/fallback.js";
import type { Reranker } from "./reranking/interfaces.js";
import { PythonModelWorker } from "./adapters/python-worker.js";
import { ConfigurationError } from "./core/errors.js";

export interface CreateSystemOptions {
  config: SearchEngineConfig;
  /** 'postgres' (default) or 'memory' (tests/benchmarks/offline dev). */
  store?: "postgres" | "memory";
  logger?: Logger;
  /** Fixed components for evaluation/benchmarks (bypass config selection). */
  reranker?: Reranker;
  normalizer?: QueryNormalizer;
  embedder?: Embedder;
  /** transformers.js / HF model cache dir. */
  modelCacheDir?: string;
  /** Skip bootstrap (document preload + BM25 hydration) — used by first-time setup. */
  skipBootstrap?: boolean;
}

export interface SearchSystem {
  config: SearchEngineConfig;
  logger: Logger;
  engine: SearchEngine;
  indexer: SearchIndexer;
  store: SearchStore;
  embedder: Embedder;
  bm25: InMemoryBm25Index;
  builder: SearchDocumentBuilder;
  indexVersion: IndexVersionTracker;
  reranker: Reranker;
  documentCache: DocumentCache;
  cache: SearchCache;
  /** composed components exposed for evaluation/benchmark tooling */
  normalizer: QueryNormalizer;
  lexical: import("./retrieval/interfaces.js").LexicalRetriever | null;
  vector: import("./retrieval/interfaces.js").VectorRetriever | null;
  fusion: import("./fusion/interfaces.js").FusionStrategy;
  close(): Promise<void>;
}

/**
 * Composition root: the ONLY place where concrete providers are selected from
 * configuration. Everything downstream receives interfaces.
 *
 *   config.normalization.provider  -> QueryNormalizer
 *   config.embedding.provider      -> Embedder
 *   config.reranking.provider      -> Reranker (+ fallback chain)
 *   config.fusion.provider         -> FusionStrategy
 *   options.store                  -> SearchStore (pgvector | memory)
 */
export async function createSearchSystem(options: CreateSystemOptions): Promise<SearchSystem> {
  const { config } = options;
  const logger =
    options.logger ??
    createLogger({ enabled: config.logging.enabled, level: config.logging.level, pretty: config.logging.pretty });
  const systemLogger = logger.child({ component: "system" });

  // ---- store -------------------------------------------------------------
  const store: SearchStore =
    options.store === "memory"
      ? new MemorySearchStore()
      : new PgSearchStore({
          config: config.database,
          embeddingDimensions: config.embedding.dimensions,
          metric: config.retrieval.vector.metric,
        });
  await store.init();

  // ---- document builder (language-specific labels, deterministic) --------
  const labelMap = config.normalization.language === "fr" ? FRENCH_ATTRIBUTE_LABELS : {};
  if (config.normalization.language !== "fr") {
    systemLogger.warn("no attribute label map for language; falling back to humanized keys", {
      language: config.normalization.language,
    });
  }
  const builder = new SearchDocumentBuilder({ labelMap });

  // ---- embedder -----------------------------------------------------------
  const embedder: Embedder =
    options.embedder ??
    (() => {
      switch (config.embedding.provider) {
        case "hashing":
          return new HashingEmbedder({
            dimensions: config.embedding.dimensions,
            modelVersion: config.embedding.modelVersion,
          });
        case "transformers":
          return new TransformersEmbedder({
            model: config.embedding.model,
            dimensions: config.embedding.dimensions,
            batchSize: config.embedding.batchSize,
            normalize: config.embedding.normalize,
            ...(options.modelCacheDir ? { cacheDir: options.modelCacheDir } : {}),
          });
        case "mock":
          return new MockEmbedder({ dimensions: config.embedding.dimensions, modelVersion: config.embedding.modelVersion });
        default:
          throw new ConfigurationError(`unknown embedding provider: ${config.embedding.provider}`);
      }
    })();

  // ---- lexical + vector retrieval -----------------------------------------
  const bm25 = new InMemoryBm25Index(config.retrieval.bm25, builder);
  const lexical = config.retrieval.bm25.enabled ? new Bm25Retriever(bm25, config.retrieval.bm25) : null;
  const vector = config.retrieval.vector.enabled
    ? new StoreVectorRetriever(store, embedder, config.retrieval.vector)
    : null;

  // ---- fusion ---------------------------------------------------------------
  if (config.fusion.provider !== "rrf") {
    throw new ConfigurationError(`unsupported fusion provider: ${config.fusion.provider}`);
  }
  const fusion = new RrfFusion({ k: config.fusion.k, weights: config.fusion.weights });

  // ---- shared python model worker (von + tinyllm) ---------------------------
  let pythonWorker: PythonModelWorker | null = null;
  const getPythonWorker = (): PythonModelWorker => {
    if (!pythonWorker) {
      pythonWorker = new PythonModelWorker({
        pythonPath: config.reranking.von.pythonPath,
        workerPath: config.reranking.von.workerPath,
        args: ["--model", config.reranking.von.model],
        timeoutMs: config.reranking.von.timeoutMs,
        warmupTimeoutMs: config.reranking.von.warmupTimeoutMs,
        logger: logger.child({ component: "python-worker" }),
      });
    }
    return pythonWorker;
  };

  // ---- normalizer -------------------------------------------------------------
  const normalizer: QueryNormalizer = options.normalizer ?? createNormalizer(config, getPythonWorker, logger);
  const engineNormalizer = config.normalization.enabled || options.normalizer ? normalizer : new TokenizingNormalizer();

  // ---- reranker chain -----------------------------------------------------------
  const reranker: Reranker = options.reranker ?? createRerankerChain(config, getPythonWorker, options.modelCacheDir, logger);
  const activeReranker = config.reranking.enabled || options.reranker ? reranker : new NoopReranker();

  // ---- engine + indexer -----------------------------------------------------------
  const indexVersion = new IndexVersionTracker(store);
  await indexVersion.refresh();

  const documentCache = new DocumentCache(store, { lruMax: config.documents.lruMax });
  const cache: SearchCache = config.cache.enabled
    ? new MemoryLruCache({ maxEntries: config.cache.maxEntries, ttlMs: config.cache.ttlMs })
    : new NullCache();

  const engine = new SearchEngine({
    config,
    normalizer: engineNormalizer,
    lexical,
    vector,
    fusion,
    reranker: activeReranker,
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

  // ---- bootstrap -------------------------------------------------------------------
  if (!options.skipBootstrap) {
    const [{ documents }] = await Promise.all([indexer.bootstrap()]);
    if (config.documents.preload) {
      await documentCache.preload();
    }
    if (documents > 0) {
      systemLogger.info("search system ready", {
        documents,
        store: store.id,
        embedder: embedder.id,
        reranker: activeReranker.provider,
        normalizer: engineNormalizer.id,
      });
    }
  }

  return {
    config,
    logger,
    engine,
    indexer,
    store,
    embedder,
    bm25,
    builder,
    indexVersion,
    reranker: activeReranker,
    documentCache,
    cache,
    normalizer: engineNormalizer,
    lexical,
    vector,
    fusion,
    async close() {
      const disposable = activeReranker as Reranker & { dispose?(): Promise<void> };
      await disposable.dispose?.();
      await pythonWorker?.dispose();
      await store.close();
    },
  };
}

// ---------------------------------------------------------------------------

function createNormalizer(
  config: SearchEngineConfig,
  getPythonWorker: () => PythonModelWorker,
  logger: Logger,
): QueryNormalizer {
  if (!config.normalization.enabled) return new TokenizingNormalizer();
  switch (config.normalization.provider) {
    case "none":
      return new TokenizingNormalizer();
    case "mock":
      return new MockNormalizer();
    case "deterministic":
    case "tinyllm": {
      if (config.normalization.language !== "fr") {
        throw new ConfigurationError(
          `no LanguageNormalizer shipped for language '${config.normalization.language}' (v1: fr)`,
        );
      }
      const language = new FrenchNormalizer({
        dictionary: FRENCH_DICTIONARY,
        typo: config.normalization.typo,
      });
      const deterministic = new DeterministicNormalizer(language);
      if (config.normalization.provider === "deterministic") return deterministic;
      return new TinyLmNormalizer({
        deterministic,
        worker: getPythonWorker(),
        dictionary: FRENCH_DICTIONARY,
        config: {
          timeoutMs: config.normalization.tinyLm.timeoutMs,
          maxInputChars: config.normalization.tinyLm.maxInputChars,
        },
        logger: logger.child({ component: "tinyllm" }),
      });
    }
    default:
      throw new ConfigurationError(`unknown normalization provider: ${config.normalization.provider}`);
  }
}

function createRerankerChain(
  config: SearchEngineConfig,
  getPythonWorker: () => PythonModelWorker,
  modelCacheDir: string | undefined,
  logger: Logger,
): Reranker {
  const build = (provider: string): Reranker => {
    switch (provider) {
      case "noop":
        return new NoopReranker();
      case "von": {
        const backend =
          config.reranking.von.backend === "mock"
            ? new MockVonBackend()
            : new PythonVonBackend({ model: config.reranking.von.model, worker: getPythonWorker() });
        return new VonReranker({ backend, config: config.reranking.von });
      }
      case "cross-encoder":
        return new CrossEncoderReranker(config.reranking.crossEncoder, modelCacheDir ? { cacheDir: modelCacheDir } : {});
      default:
        throw new ConfigurationError(`unknown reranker provider: ${provider}`);
    }
  };

  const chain: Reranker[] = [build(config.reranking.provider)];
  for (const fallback of config.reranking.fallback) {
    const provider = build(fallback);
    if (!chain.some((r) => r.provider === provider.provider)) chain.push(provider);
  }
  // noop is the guaranteed terminal fallback
  if (chain[chain.length - 1]!.provider !== "noop") chain.push(new NoopReranker());

  if (chain.length === 1) return chain[0]!;
  return new FallbackReranker(chain, logger.child({ component: "reranking" }));
}
