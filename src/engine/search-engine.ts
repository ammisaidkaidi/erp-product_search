import type { SearchEngineConfig } from "../config/schema.js";
import { configFingerprint } from "../config/loader.js";
import { SearchError, errorSummary } from "../core/errors.js";
import { newRequestId } from "../core/ids.js";
import type {
  DebugSearchResult,
  DegradationEvent,
  FusionResult,
  NormalizedQuery,
  ProductSearchDocument,
  RankedResult,
  RetrievalResult,
  SearchCandidate,
  SearchOptions,
  SearchResult,
  StageTimings,
} from "../core/types.js";
import type { FusionStrategy, RetrievalList } from "../fusion/interfaces.js";
import type { Logger } from "../logging/logger.js";
import type { QueryNormalizer } from "../normalize/interfaces.js";
import type { LexicalRetriever, VectorRetriever } from "../retrieval/interfaces.js";
import type { Reranker } from "../reranking/interfaces.js";
import type { SearchStore } from "../store/search-store.js";
import { buildCacheKey, type SearchCache } from "./cache.js";
import { DocumentCache } from "./document-cache.js";
import { createRankingPolicy, type RankingPolicy } from "./scoring.js";
import type { IndexVersionTracker } from "./version-tracker.js";

export interface SearchEngineDeps {
  config: SearchEngineConfig;
  normalizer: QueryNormalizer;
  lexical: LexicalRetriever | null;
  vector: VectorRetriever | null;
  fusion: FusionStrategy;
  reranker: Reranker;
  store: SearchStore;
  documentCache: DocumentCache;
  cache: SearchCache;
  indexVersion: IndexVersionTracker;
  logger: Logger;
}

interface RunResult {
  results: SearchResult[];
  debug: DebugSearchResult;
}

/**
 * The orchestrator. Owns no retrieval, fusion, reranking or normalization
 * logic — it composes the components behind interfaces, enforces the top-k
 * policy (retrieval top-K -> fusion top-K -> rerank candidate limit -> final
 * limit), records per-stage latency and degradations, and serves the public
 * search / searchDebug APIs.
 *
 * «TinyLM understands the query. BM25 and Vector retrieve candidates. RRF
 * combines retrieval signals. The Reranker determines relevance. The Search
 * Engine orchestrates everything.»
 */
export class SearchEngine {
  private readonly rankingPolicy: RankingPolicy;
  private fingerprint: string;

  constructor(private readonly deps: SearchEngineDeps) {
    this.rankingPolicy = createRankingPolicy(deps.config.ranking);
    this.fingerprint = "";
  }

  async init(): Promise<void> {
    this.fingerprint = await configFingerprint(this.deps.config);
  }

  async search(rawQuery: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { results } = await this.run(rawQuery, options, false);
    return results;
  }

  async searchDebug(rawQuery: string, options: SearchOptions = {}): Promise<DebugSearchResult> {
    const { debug } = await this.run(rawQuery, options, true);
    return debug;
  }

  /** Warm caches / indexes after a mutation (document cache reload). */
  async reloadDocuments(): Promise<number> {
    const n = await this.deps.documentCache.preload();
    await this.deps.indexVersion.refresh();
    this.deps.cache.clear();
    return n;
  }

  // --------------------------------------------------------------------

  private async run(rawQuery: string, options: SearchOptions, debugMode: boolean): Promise<RunResult> {
    const t0 = performance.now();
    const searchId = newRequestId();
    const logger = this.deps.logger.child({ search_id: searchId });
    const degradations: DegradationEvent[] = [];
    const note = (stage: DegradationEvent["stage"], message: string, error?: unknown) => {
      degradations.push({ stage, message, error: error ? errorSummary(error).name : undefined, at: new Date().toISOString() });
    };

    const config = this.deps.config;
    const limit = Math.max(1, Math.min(options.limit ?? config.search.defaultLimit, config.search.maxLimit));

    // ---- null / non-string guards (edge cases) --------------------------
    if (typeof rawQuery !== "string") {
      note("normalization", `non-string query received (${typeof rawQuery}); returned empty result`);
      logger.warn("rejected non-string query", { query_type: typeof rawQuery });
      return this.empty(typeof rawQuery === "string" ? "" : String(rawQuery), searchId, degradations, t0);
    }
    if (rawQuery.length > config.search.maxQueryLength) {
      rawQuery = rawQuery.slice(0, config.search.maxQueryLength);
      note("normalization", `query truncated to ${config.search.maxQueryLength} characters`);
    }

    // ---- normalization ---------------------------------------------------
    const tNorm = performance.now();
    let normalized: NormalizedQuery;
    try {
      normalized = await this.deps.normalizer.normalize(rawQuery, this.normalizerContext());
    } catch (e) {
      // Normalizer failure must not kill search: fall back to tokenizing.
      note("normalization", `normalizer failed, fell back to raw tokens: ${errorSummary(e).message}`, e);
      logger.error("normalizer failed", { error: errorSummary(e).message });
      const { TokenizingNormalizer } = await import("../normalize/tokenizing-normalizer.js");
      normalized = await new TokenizingNormalizer().normalize(rawQuery);
    }
    const normalizationMs = performance.now() - tNorm;

    if (normalized.isEmpty) {
      logger.debug("empty query", {});
      return this.emptyResult(normalized, limit, searchId, degradations, this.timings(normalizationMs, null, null, 0, 0, 0, performance.now() - t0), debugMode);
    }

    // ---- cache -----------------------------------------------------------
    const cacheEnabled = config.cache.enabled && !options.noCache;
    const indexVersion = this.deps.indexVersion.get();
    const cacheKey = buildCacheKey({
      query: rawQuery,
      limit,
      normalizerVersion: normalized.normalizerVersion,
      indexVersion,
      embeddingModelVersion: config.embedding.modelVersion,
      rerankerProvider: this.deps.reranker.provider,
      configFingerprint: this.fingerprint,
    });
    if (cacheEnabled && !debugMode) {
      const cached = await this.deps.cache.get(cacheKey);
      if (cached) {
        logger.debug("cache hit", { cache_key: cacheKey });
        return { results: cached, debug: this.cachedDebug(searchId, normalized, cached, cacheKey, degradations, normalizationMs, t0) };
      }
    }

    // ---- hybrid retrieval (parallel) --------------------------------------
    const tRetrieval = performance.now();
    const [bm25Results, vectorResults, bm25Ms, vectorMs] = await this.retrieve(normalized, note, logger);
    const retrievalMs = performance.now() - tRetrieval;
    if (bm25Results.length === 0 && vectorResults.length === 0) {
      const timings = this.timings(normalizationMs, bm25Ms, vectorMs, retrievalMs, 0, 0, performance.now() - t0);
      return this.emptyResult(normalized, limit, searchId, degradations, timings, debugMode, bm25Results, vectorResults);
    }

    // ---- fusion ------------------------------------------------------------
    const tFusion = performance.now();
    const lists: RetrievalList[] = [];
    if (bm25Results.length > 0) lists.push({ source: "bm25", results: bm25Results });
    if (vectorResults.length > 0) lists.push({ source: "vector", results: vectorResults });
    const fused = await this.deps.fusion.fuse(lists, config.fusion.topK);
    const fusionMs = performance.now() - tFusion;
    // ---- candidate assembly (document hydration) ---------------------------
    const candidateLimit = Math.min(config.reranking.candidateLimit, config.fusion.topK);
    const fusedTop = fused.slice(0, candidateLimit);
    const ids = fusedTop.map((f) => f.productId);
    const docs = await this.deps.documentCache.getMany(ids);
    const candidates: SearchCandidate[] = [];
    const fusionById = new Map(fused.map((f) => [f.productId, f]));
    for (let i = 0; i < fusedTop.length; i++) {
      const doc = docs[i];
      if (!doc) {
        note("store", `document ${fusedTop[i]!.productId} missing from store (skipped)`);
        continue;
      }
      const f = fusedTop[i]!;
      candidates.push({
        product: doc,
        rrfScore: f.rrfScore,
        bm25: f.sources.bm25,
        vector: f.sources.vector,
        fusionSources: f.sources,
      });
    }

    // ---- reranking ---------------------------------------------------------
    const tRerank = performance.now();
    let ranked: RankedResult[];
    let rerankProvider = this.deps.reranker.provider;
    let rerankFallbackFor: string | undefined;
    if (config.reranking.enabled && candidates.length > 0) {
      try {
        ranked = await this.deps.reranker.rank(normalized, candidates);
      } catch (e) {
        note("reranking", `reranker ${rerankProvider} failed: ${errorSummary(e).message}; RRF ordering kept`, e);
        logger.error("reranker failed; falling back to RRF order", {
          provider: rerankProvider,
          error: errorSummary(e).message,
        });
        rerankFallbackFor = rerankProvider;
        rerankProvider = "rrf-fallback";
        const { NoopReranker } = await import("../reranking/noop.js");
        ranked = await new NoopReranker().rank(normalized, candidates);
      }
    } else {
      const { NoopReranker } = await import("../reranking/noop.js");
      ranked = await new NoopReranker().rank(normalized, candidates);
      rerankProvider = "noop";
    }
    const rerankerMs = performance.now() - tRerank;

    // ---- final ranking -------------------------------------------------------
    const candidatesById = new Map(candidates.map((c) => [c.product.productId, c]));
    const finalized = this.rankingPolicy.finalize(ranked, candidatesById).slice(0, limit);

    const results: SearchResult[] = finalized.map((r, i) => ({
      productId: r.candidate.product.productId,
      rank: i + 1,
      finalScore: round(r.finalScore, 6),
      retrieval: {
        bm25: r.candidate.bm25,
        vector: r.candidate.vector,
        rrf: { score: round(r.candidate.rrfScore, 6) },
      },
      reranking:
        config.reranking.enabled && rerankProvider !== "noop"
          ? { provider: rerankProvider, score: round(r.score, 6), ...(rerankFallbackFor ? { fallbackFor: rerankFallbackFor } : {}) }
          : undefined,
      product: r.candidate.product,
    }));

    const timings = this.timings(normalizationMs, bm25Ms, vectorMs, retrievalMs, fusionMs, rerankerMs, performance.now() - t0);

    if (cacheEnabled && !debugMode) {
      await this.deps.cache.set(cacheKey, results);
    }

    logger.info("search complete", {
      query: rawQuery,
      normalized: normalized.normalized,
      bm25_ms: bm25Ms === null ? null : round1(bm25Ms),
      vector_ms: vectorMs === null ? null : round1(vectorMs),
      rrf_ms: round1(fusionMs),
      reranker_ms: round1(rerankerMs),
      total_ms: round1(timings.totalMs),
      candidate_count: candidates.length,
      result_count: results.length,
    });

    if (this.deps.config.logging.events.enabled && !debugMode) {
      void this.deps.store
        .logSearchEvent({
          searchId,
          query: rawQuery,
          normalizedQuery: normalized.normalized,
          resultProductIds: results.map((r) => r.productId),
          latencyMs: timings.totalMs,
        })
        .catch((e) => logger.warn("search log write failed", { error: errorSummary(e).message }));
    }

    const debug: DebugSearchResult = {
      searchId,
      query: { original: rawQuery, normalized },
      retrieval: {
        bm25: bm25Results.slice(0, 20),
        vector: vectorResults.slice(0, 20),
        fused: fused.slice(0, candidateLimit),
        candidateCount: candidates.length,
      },
      reranking: {
        provider: rerankProvider,
        ...(rerankFallbackFor ? { fallbackFor: rerankFallbackFor } : {}),
        scores: ranked.slice(0, candidateLimit).map((r) => ({
          productId: r.candidate.product.productId,
          score: round(r.score, 6),
        })),
        degraded: rerankFallbackFor !== undefined,
      },
      results,
      timings,
      degradations,
      cache: { enabled: cacheEnabled, hit: false, key: debugMode ? undefined : cacheKey },
      config: {
        bm25TopK: config.retrieval.bm25.topK,
        vectorTopK: config.retrieval.vector.topK,
        fusionK: config.fusion.k,
        fusionTopK: config.fusion.topK,
        rerankerProvider: config.reranking.provider,
        rerankerFallback: config.reranking.fallback,
        indexVersion,
        embeddingModelVersion: config.embedding.modelVersion,
      },
    };

    if (debugMode && this.deps.config.logging.debugSearch) {
      logger.debug("search debug", { degradations: degradations.length });
    }

    return { results, debug };
  }

  // --------------------------------------------------------------------

  private normalizerContext() {
    // Vocabulary/code hints come from the lexical index when available.
    const lexical = this.deps.lexical;
    if (!lexical) return {};
    const withIndex = lexical as unknown as {
      index?: { vocabulary: (n: number) => string[]; codes: (n: number) => string[] };
    };
    const index = withIndex.index;
    if (!index) return {};
    return {
      vocabulary: index.vocabulary(10_000),
      codes: index.codes(50_000),
    };
  }

  private async retrieve(
    normalized: NormalizedQuery,
    note: (stage: DegradationEvent["stage"], message: string, error?: unknown) => void,
    logger: Logger,
  ): Promise<[RetrievalResult[], RetrievalResult[], number | null, number | null]> {
    const config = this.deps.config;
    const jobs: Array<Promise<RetrievalResult[] | null>> = [];

    const tBm25 = performance.now();
    let bm25Ms: number | null = null;
    if (config.retrieval.bm25.enabled && this.deps.lexical) {
      jobs.push(
        this.deps.lexical.search(normalized, config.retrieval.bm25.topK).then(
          (r) => {
            bm25Ms = performance.now() - tBm25;
            return r;
          },
          (e) => {
            bm25Ms = performance.now() - tBm25;
            note("retrieval", `BM25 retriever failed: ${errorSummary(e).message}`, e);
            logger.error("bm25 retriever failed", { error: errorSummary(e).message });
            return null;
          },
        ),
      );
    } else {
      jobs.push(Promise.resolve(null));
    }

    const tVector = performance.now();
    let vectorMs: number | null = null;
    if (config.retrieval.vector.enabled && this.deps.vector) {
      jobs.push(
        this.deps.vector.search(normalized, config.retrieval.vector.topK).then(
          (r) => {
            vectorMs = performance.now() - tVector;
            return r;
          },
          (e) => {
            vectorMs = performance.now() - tVector;
            note("retrieval", `vector retriever failed: ${errorSummary(e).message}`, e);
            logger.error("vector retriever failed", { error: errorSummary(e).message });
            return null;
          },
        ),
      );
    } else {
      jobs.push(Promise.resolve(null));
    }

    const [bm25, vector] = await Promise.all(jobs);
    return [bm25 ?? [], vector ?? [], bm25Ms, vectorMs];
  }


  private timings(
    normalizationMs: number,
    bm25Ms: number | null,
    vectorMs: number | null,
    retrievalMs: number,
    fusionMs: number,
    rerankerMs: number,
    totalMs: number,
  ): StageTimings {
    return {
      normalizationMs: round1(normalizationMs),
      bm25Ms: bm25Ms === null ? null : round1(bm25Ms),
      vectorMs: vectorMs === null ? null : round1(vectorMs),
      retrievalMs: round1(retrievalMs),
      fusionMs: round1(fusionMs),
      rerankerMs: round1(rerankerMs),
      totalMs: round1(totalMs),
    };
  }

  private emptyResult(
    normalized: NormalizedQuery,
    limit: number,
    searchId: string,
    degradations: DegradationEvent[],
    timings: StageTimings,
    debugMode: boolean,
    bm25Results: RetrievalResult[] = [],
    vectorResults: RetrievalResult[] = [],
  ): RunResult {
    void limit;
    void debugMode;
    const debug: DebugSearchResult = {
      searchId,
      query: { original: normalized.original, normalized },
      retrieval: {
        bm25: bm25Results.slice(0, 20),
        vector: vectorResults.slice(0, 20),
        fused: [],
        candidateCount: 0,
      },
      reranking: { provider: "none", scores: [], degraded: false },
      results: [],
      timings,
      degradations,
      cache: { enabled: false, hit: false },
      config: {
        bm25TopK: this.deps.config.retrieval.bm25.topK,
        vectorTopK: this.deps.config.retrieval.vector.topK,
        fusionK: this.deps.config.fusion.k,
        fusionTopK: this.deps.config.fusion.topK,
        rerankerProvider: this.deps.config.reranking.provider,
        rerankerFallback: this.deps.config.reranking.fallback,
        indexVersion: this.deps.indexVersion.get(),
        embeddingModelVersion: this.deps.config.embedding.modelVersion,
      },
    };
    return { results: [], debug };
  }

  private empty(queryLabel: string, searchId: string, degradations: DegradationEvent[], t0: number): RunResult {
    const normalized: NormalizedQuery = {
      original: queryLabel,
      normalized: "",
      tokens: [],
      attributes: {},
      attributeValues: {},
      codes: [],
      tokenProvenance: {},
      corrections: [],
      normalizerId: "none",
      normalizerVersion: "none-v1",
      isEmpty: true,
      notes: [],
    };
    const timings = this.timings(0, null, null, 0, 0, 0, performance.now() - t0);
    return this.emptyResult(normalized, 0, searchId, degradations, timings, false);
  }

  private cachedDebug(
    searchId: string,
    normalized: NormalizedQuery,
    results: SearchResult[],
    cacheKey: string,
    degradations: DegradationEvent[],
    normalizationMs: number,
    t0: number,
  ): DebugSearchResult {
    return {
      searchId,
      query: { original: normalized.original, normalized },
      retrieval: { bm25: [], vector: [], fused: [], candidateCount: 0 },
      reranking: { provider: "cache", scores: [], degraded: false },
      results,
      timings: this.timings(normalizationMs, null, null, 0, 0, 0, performance.now() - t0),
      degradations,
      cache: { enabled: true, hit: true, key: cacheKey },
      config: {
        bm25TopK: this.deps.config.retrieval.bm25.topK,
        vectorTopK: this.deps.config.retrieval.vector.topK,
        fusionK: this.deps.config.fusion.k,
        fusionTopK: this.deps.config.fusion.topK,
        rerankerProvider: this.deps.config.reranking.provider,
        rerankerFallback: this.deps.config.reranking.fallback,
        indexVersion: this.deps.indexVersion.get(),
        embeddingModelVersion: this.deps.config.embedding.modelVersion,
      },
    };
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function round1(v: number): number {
  return round(v, 1);
}
