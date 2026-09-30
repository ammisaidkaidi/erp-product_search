/**
 * Core domain types for the product search engine.
 *
 * This module has ZERO dependencies on retrieval, reranking, storage or model
 * code. Every other layer depends on these types; these types depend on nothing.
 */

// ---------------------------------------------------------------------------
// Products & canonical search representation
// ---------------------------------------------------------------------------

/** Raw product as provided by the ERP. Never modified for search purposes. */
export interface Product {
  id: string;
  code: string;
  name: string;
  /** Free-form technical attributes, e.g. { diameter: "110 mm", color: "blanc" }. */
  attributes?: Readonly<Record<string, string>>;
  brand?: string;
  category?: string;
  subcategory?: string;
}

/**
 * Canonical, deterministic searchable representation of a product.
 * `searchDocument` is the single text indexed by BM25, the vector index and
 * consumed by rerankers. It is generated from the product; the original
 * product data is never modified.
 */
export interface ProductSearchDocument {
  productId: string;
  code: string;
  name: string;
  attributes: Readonly<Record<string, string>>;
  brand?: string;
  category?: string;
  subcategory?: string;
  /** Deterministic canonical text, e.g.
   *  "T110B45 | Tube PVC évacuation | diamètre 110 mm | longueur 4 m | couleur blanc | matière PVC" */
  searchDocument: string;
  /** Version of the document builder that produced searchDocument. */
  builderVersion: string;
  /** sha256 of the canonical serialization; changes whenever any indexed input changes. */
  documentHash: string;
}

/** Structured fields extracted alongside searchDocument (used by field-weighted BM25). */
export interface SearchDocumentFields {
  code: string;
  name: string;
  attributes: Readonly<Record<string, string>>;
  brand: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Query normalization
// ---------------------------------------------------------------------------

export type TokenProvenance = "observed" | "normalized" | "inferred" | "unknown";

export type CorrectionKind = "typo" | "abbreviation" | "unit" | "accent" | "whitespace" | "case" | "synonym";

export interface Correction {
  from: string;
  to: string;
  kind: CorrectionKind;
  /** Rule identifier that produced the correction, for auditability. */
  rule?: string;
}

/** An attribute extracted from the query with explicit provenance. */
export interface ExtractedAttribute {
  /** Canonical attribute name, e.g. "diameter". */
  name: string;
  /** Canonical value, e.g. "110". */
  value: string;
  /** Canonical unit if any, e.g. "mm". */
  unit?: string;
  /** Raw text as it appeared in the query. */
  raw: string;
  provenance: TokenProvenance;
  /** Deterministic rule id that extracted this attribute, e.g. "diameter:prefix-symbol". */
  rule?: string;
}

/** Contextual hints the engine can pass to the normalizer. */
export interface NormalizeContext {
  /** Catalog vocabulary (frequent tokens) for typo correction. Optional. */
  vocabulary?: readonly string[];
  /** Known product codes, for exact-code detection. Optional. */
  codes?: readonly string[];
}

/**
 * Result of query normalization. Conservative: only contains what was observed
 * in the input or produced by an explicit deterministic rule. The normalizer
 * never invents product attributes.
 */
export interface NormalizedQuery {
  original: string;
  /** Canonical cleaned text used for retrieval. */
  normalized: string;
  /** Analyzed lexical tokens (accent-folded, lowercased, variants included downstream). */
  tokens: string[];
  /** Extracted attributes keyed by canonical attribute name. */
  attributes: Readonly<Record<string, ExtractedAttribute>>;
  /** Flat convenience view: { diameter: "110", color: "blanc" }. */
  attributeValues: Readonly<Record<string, string>>;
  /** Canonical product-code candidates detected in the query, e.g. ["T110B45"]. */
  codes: string[];
  /** Provenance per output token. Tokens absent from the map default to "observed". */
  tokenProvenance: Readonly<Record<string, TokenProvenance>>;
  corrections: Correction[];
  normalizerId: string;
  normalizerVersion: string;
  /** True when the query is empty / whitespace-only. */
  isEmpty: boolean;
  /** Non-fatal notes (e.g. "query truncated to 512 characters"). */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Retrieval & fusion
// ---------------------------------------------------------------------------

/** A single retrieval hit from one retriever. */
export interface RetrievalResult {
  productId: string;
  /** Raw retriever score. Distribution is retriever-specific; never compare across retrievers. */
  score: number;
  retrieverId: string;
}

export interface RankScore {
  rank: number;
  score: number;
}

/** Output of the fusion stage: one entry per product with per-source details. */
export interface FusionResult {
  productId: string;
  rrfScore: number;
  sources: {
    bm25?: RankScore;
    vector?: RankScore;
    [sourceId: string]: RankScore | undefined;
  };
}

/** A candidate prepared for reranking, carrying all retrieval metadata. */
export interface SearchCandidate {
  product: ProductSearchDocument;
  rrfScore: number;
  bm25?: RankScore;
  vector?: RankScore;
  /** Additional debug info attached by the fusion stage. */
  fusionSources?: FusionResult["sources"];
}

export interface RankedResult {
  candidate: SearchCandidate;
  /** Reranker score (higher = more relevant). Semantics depend on the provider. */
  score: number;
  provider: string;
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

/** The rich public search result, exposing every stage's contribution. */
export interface SearchResult {
  productId: string;
  rank: number;
  finalScore: number;
  retrieval: {
    bm25?: RankScore;
    vector?: RankScore;
    rrf?: { score: number };
  };
  reranking?: {
    provider: string;
    score: number;
    /** Set when this provider was used as a fallback for another one. */
    fallbackFor?: string;
  };
  product: ProductSearchDocument;
}

export interface SearchOptions {
  /** Number of results to return. Defaults to config `search.default_limit`. */
  limit?: number;
  /** Bypass the result cache for this call. */
  noCache?: boolean;
}

/** Per-stage latency in milliseconds. */
export interface StageTimings {
  normalizationMs: number;
  bm25Ms: number | null;
  vectorMs: number | null;
  retrievalMs: number;
  fusionMs: number;
  rerankerMs: number;
  totalMs: number;
}

/** Degradation events that occurred while serving a request. */
export interface DegradationEvent {
  stage: "normalization" | "retrieval" | "reranking" | "cache" | "store";
  message: string;
  /** Original error class name when applicable. */
  error?: string;
  at: string;
}

/** Debug payload returned by searchDebug(). */
export interface DebugSearchResult {
  searchId: string;
  query: {
    original: string;
    normalized: NormalizedQuery;
  };
  retrieval: {
    bm25: RetrievalResult[];
    vector: RetrievalResult[];
    fused: FusionResult[];
    candidateCount: number;
  };
  reranking: {
    provider: string;
    fallbackFor?: string;
    scores: Array<{ productId: string; score: number }>;
    degraded: boolean;
  };
  results: SearchResult[];
  timings: StageTimings;
  degradations: DegradationEvent[];
  cache: {
    enabled: boolean;
    hit: boolean;
    key?: string;
  };
  config: {
    bm25TopK: number;
    vectorTopK: number;
    fusionK: number;
    fusionTopK: number;
    rerankerProvider: string;
    rerankerFallback: string[];
    indexVersion: number;
    embeddingModelVersion: string;
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Binary relevance dataset record. */
export interface EvaluationQuery {
  query: string;
  relevantProductIds: string[];
  notes?: string;
}

/** Graded gold-label record (label scale is configurable, default 0-4). */
export interface GoldLabel {
  query: string;
  productId: string;
  label: number;
}

export interface MetricSummary {
  recallAt1: number;
  recallAt5: number;
  recallAt10: number;
  recallAt20: number;
  mrrAt10: number;
  ndcgAt10: number;
}

export interface LatencySummary {
  p50Ms: number;
  p90Ms: number;
  p99Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  queriesPerSecond: number;
}
