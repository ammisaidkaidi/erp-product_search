/**
 * @erp/product-search — public API
 *
 * Quick start:
 *
 *   import { createSearchSystem, loadConfig } from "@erp/product-search";
 *
 *   const config = await loadConfig({ file: "search.config.yaml" });
 *   const system = await createSearchSystem({ config });
 *   await system.indexer.rebuild(myProductProvider);   // or upsert()
 *   const results = await system.engine.search("tube 110 blnc");
 *   const debug   = await system.engine.searchDebug("tube 110 blnc");
 *   await system.close();
 */

// core domain types
export type {
  Product,
  ProductSearchDocument,
  SearchDocumentFields,
  NormalizedQuery,
  ExtractedAttribute,
  TokenProvenance,
  Correction,
  CorrectionKind,
  NormalizeContext,
  RetrievalResult,
  RankScore,
  FusionResult,
  SearchCandidate,
  RankedResult,
  SearchResult,
  SearchOptions,
  StageTimings,
  DegradationEvent,
  DebugSearchResult,
  EvaluationQuery,
  GoldLabel,
  MetricSummary,
  LatencySummary,
} from "./core/types.js";

export {
  SearchError,
  ConfigurationError,
  ModelUnavailableError,
  ModelInferenceError,
  StoreError,
  isSearchError,
  errorSummary,
} from "./core/errors.js";

// configuration
export { loadConfig, configFingerprint } from "./config/loader.js";
export { validateConfig, assertValidConfig } from "./config/validate.js";
export { DEFAULT_CONFIG, MODE_PRESETS, deepMerge, FRENCH_STOPWORDS } from "./config/schema.js";
export type { SearchEngineConfig, SearchMode, DeepPartial } from "./config/schema.js";

// composition root + system
export { createSearchSystem } from "./system.js";
export type { SearchSystem, CreateSystemOptions } from "./system.js";

// engine
export { SearchEngine } from "./engine/search-engine.js";
export { DocumentCache } from "./engine/document-cache.js";
export { MemoryLruCache, NullCache, buildCacheKey } from "./engine/cache.js";
export type { SearchCache, CacheKeyInput } from "./engine/cache.js";
export { IndexVersionTracker } from "./engine/version-tracker.js";
export { RerankerFirstPolicy, WeightedScorePolicy, createRankingPolicy } from "./engine/scoring.js";
export type { RankingPolicy } from "./engine/scoring.js";

// normalization
export type { QueryNormalizer, LanguageNormalizer, DeterministicNormalization } from "./normalize/interfaces.js";
export { DeterministicNormalizer } from "./normalize/deterministic.js";
export { FrenchNormalizer } from "./normalize/french.js";
export { TokenizingNormalizer } from "./normalize/tokenizing-normalizer.js";
export { TinyLmNormalizer } from "./normalize/tiny-lm.js";
export { MockNormalizer } from "./normalize/mock.js";
export { FRENCH_DICTIONARY } from "./normalize/dictionaries/fr.js";
export type { LanguageDictionary } from "./normalize/dictionaries/fr.js";
export { damerauLevenshtein, closestWord } from "./normalize/damerau.js";

// documents + analysis
export { SearchDocumentBuilder } from "./document/builder.js";
export { FRENCH_ATTRIBUTE_LABELS, humanizeKey } from "./document/labels/fr.js";
export { analyzeText, analyzeCode, foldText, canonicalCode, isCodeShaped, preprocessText } from "./analysis/analyzer.js";

// retrieval
export type { LexicalRetriever, VectorRetriever } from "./retrieval/interfaces.js";
export { InMemoryBm25Index, FIELD_NAMES } from "./retrieval/lexical/bm25f.js";
export { Bm25Retriever } from "./retrieval/lexical/retriever.js";
export type { Embedder } from "./retrieval/vector/embedder.js";
export { HashingEmbedder } from "./retrieval/vector/hashing-embedder.js";
export { TransformersEmbedder } from "./retrieval/vector/transformers-embedder.js";
export { MockEmbedder } from "./retrieval/vector/mock-embedder.js";
export { StoreVectorRetriever } from "./retrieval/vector/retriever.js";

// fusion
export type { FusionStrategy, RetrievalList } from "./fusion/interfaces.js";
export { RrfFusion } from "./fusion/rrf.js";

// reranking
export type { Reranker } from "./reranking/interfaces.js";
export { NoopReranker } from "./reranking/noop.js";
export { CrossEncoderReranker } from "./reranking/cross-encoder.js";
export { VonReranker } from "./reranking/von/reranker.js";
export { MockVonBackend, PythonVonBackend } from "./reranking/von/backend.js";
export type { VonBackend, VonScore, VonRerankRequest } from "./reranking/von/backend.js";
export { FallbackReranker } from "./reranking/fallback.js";

// storage
export type { SearchStore, SearchDocRow, EmbeddingRow, EmbeddingMeta, SearchLogRow, BehaviorEventRow } from "./store/search-store.js";
export { PgSearchStore } from "./store/pg-store.js";
export { MemorySearchStore, cosineSimilarity } from "./store/memory-store.js";

// indexing
export { SearchIndexer } from "./indexing/indexer.js";
export type { IndexerDeps, IndexEvent } from "./indexing/indexer.js";
export { JsonCatalogProvider, StaticProductProvider, PgProductProvider, parseProduct } from "./indexing/product-provider.js";
export type { ProductProvider } from "./indexing/product-provider.js";

// evaluation + benchmark
export { loadDataset, goldTemplate } from "./evaluation/dataset.js";
export type { NormalizedDataset, DatasetOptions } from "./evaluation/dataset.js";
export { Evaluator } from "./evaluation/evaluator.js";
export type { EvaluationReport, EvaluationOptions, QueryReport } from "./evaluation/evaluator.js";
export { RerankerBenchmark, renderBenchmarkTable } from "./evaluation/reranker-benchmark.js";
export { recallAtK, mrrAtK, ndcgAtK, computeMetrics, latencySummary } from "./evaluation/metrics.js";
export { runBenchmark, renderBenchmarkResults } from "./benchmark/bench.js";
export { generateCatalog, generateFixtureCatalog } from "./benchmark/catalog-generator.js";

// logging
export { createLogger, ConsoleLogger, NoopLogger } from "./logging/logger.js";
export type { Logger, LogLevel, LogFields } from "./logging/logger.js";
