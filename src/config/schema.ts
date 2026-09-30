/**
 * Config schema. Every tunable of the engine lives here; nothing below is
 * hard-coded elsewhere. Types mirror `search.config.default.yaml`.
 */

export type SearchMode = "development" | "production" | "benchmark" | "debug";

export type RerankerProviderId = "noop" | "cross-encoder" | "von";
export type EmbeddingProviderId = "hashing" | "transformers" | "mock";
export type NormalizationProviderId = "none" | "deterministic" | "tinyllm" | "mock";
export type VectorMetric = "cosine" | "inner-product";

export interface DatabaseConfig {
  /** Full connection URL, e.g. postgres://user:pass@host:5432/db. Takes precedence over individual fields. */
  url?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  poolMax: number;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
}

export interface SearchConfig {
  defaultLimit: number;
  maxLimit: number;
  maxQueryLength: number;
}

export interface Bm25Config {
  enabled: boolean;
  topK: number;
  k1: number;
  b: number;
  fieldWeights: Record<"code" | "name" | "attributes" | "brand" | "category", number>;
  boosts: {
    exactCode: number;
    codePrefix: number;
    numericAttribute: number;
  };
  stopwords: string[];
}

export interface VectorConfig {
  enabled: boolean;
  topK: number;
  metric: VectorMetric;
  /** Minimum cosine similarity for a vector hit to be considered a candidate.
   *  Filters noise for out-of-domain queries ("xyzabc999"). Tune per embedding
   *  model: hashing ~0.15, e5/BGE-family models usually >= 0.5 for unrelated text. */
  minScore: number;
}

export interface FusionConfig {
  provider: "rrf";
  k: number;
  topK: number;
  weights: Record<"bm25" | "vector", number>;
}

export interface CrossEncoderConfig {
  model: string;
  batchSize: number;
  /** Quantization for onnx weights, e.g. "q8" (smaller/faster) or "fp32". */
  dtype: string;
  maxTextLength: number;
}

export interface VonConfig {
  backend: "python" | "mock";
  pythonPath: string;
  workerPath: string;
  /** Model id passed to the python worker. */
  model: string;
  timeoutMs: number;
  batchSize: number;
  maxTextLength: number;
  /** Extra startup delay tolerance for first model load, in ms. */
  warmupTimeoutMs: number;
}

export interface RerankingConfig {
  enabled: boolean;
  provider: RerankerProviderId;
  candidateLimit: number;
  resultLimit: number;
  fallback: RerankerProviderId[];
  crossEncoder: CrossEncoderConfig;
  von: VonConfig;
}

export interface RankingConfig {
  /** "reranker": rank by reranker score, ties broken by RRF (default).
   *  "weighted": FinalScore = a*normBM25 + b*normVector + g*normRRF + d*reranker. */
  policy: "reranker" | "weighted";
  weights: {
    bm25: number;
    vector: number;
    rrf: number;
    reranker: number;
  };
}

export interface EmbeddingConfig {
  provider: EmbeddingProviderId;
  /** Model id for the transformers provider; informational for hashing/mock. */
  model: string;
  modelVersion: string;
  dimensions: number;
  batchSize: number;
  normalize: boolean;
}

export interface TypoConfig {
  enabled: boolean;
  maxEditDistance: 1 | 2;
  minTokenLength: number;
}

export interface NormalizationConfig {
  enabled: boolean;
  provider: NormalizationProviderId;
  language: string;
  /** Optional extra dictionary file (JSON) merged with the built-in one. */
  dictionaryFile?: string;
  typo: TypoConfig;
  tinyLm: {
    pythonPath: string;
    workerPath: string;
    model: string;
    timeoutMs: number;
    maxInputChars: number;
  };
}

export interface CacheConfig {
  enabled: boolean;
  maxEntries: number;
  ttlMs: number;
}

export interface LoggingEventsConfig {
  /** Persist search events (query, results, latency) to the search_log table. */
  enabled: boolean;
  /** Persist behavior events (click/select/...) — hooks only in v1, no ranking use. */
  behaviorEvents: boolean;
}

export interface LoggingConfig {
  enabled: boolean;
  level: "debug" | "info" | "warn" | "error";
  pretty: boolean;
  debugSearch: boolean;
  events: LoggingEventsConfig;
}

export interface DocumentsConfig {
  preload: boolean;
  lruMax: number;
}

export interface SearchEngineConfig {
  mode: SearchMode;
  database: DatabaseConfig;
  search: SearchConfig;
  retrieval: {
    bm25: Bm25Config;
    vector: VectorConfig;
  };
  fusion: FusionConfig;
  reranking: RerankingConfig;
  ranking: RankingConfig;
  embedding: EmbeddingConfig;
  normalization: NormalizationConfig;
  cache: CacheConfig;
  logging: LoggingConfig;
  documents: DocumentsConfig;
}

export const FRENCH_STOPWORDS: string[] = [
  "le", "la", "les", "de", "des", "du", "un", "une", "et", "en", "pour", "avec",
  "au", "aux", "a", "d", "l", "dun", "dune", "sur", "dans", "par", "ou",
];

export const DEFAULT_CONFIG: SearchEngineConfig = {
  mode: "development",
  database: {
    url: process.env.DATABASE_URL,
    host: process.env.PGHOST ?? "127.0.0.1",
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE ?? "postgres",
    poolMax: 10,
    connectTimeoutMs: 5_000,
    statementTimeoutMs: 15_000,
  },
  search: {
    defaultLimit: 10,
    maxLimit: 100,
    maxQueryLength: 512,
  },
  retrieval: {
    bm25: {
      enabled: true,
      topK: 50,
      k1: 1.2,
      b: 0.75,
      fieldWeights: { code: 4, name: 2, attributes: 1.5, brand: 1, category: 1 },
      boosts: { exactCode: 25, codePrefix: 8, numericAttribute: 2 },
      stopwords: FRENCH_STOPWORDS,
    },
    vector: {
      enabled: true,
      topK: 50,
      metric: "cosine",
      minScore: 0.15,
    },
  },
  fusion: {
    provider: "rrf",
    k: 60,
    topK: 50,
    weights: { bm25: 1, vector: 1 },
  },
  reranking: {
    enabled: true,
    provider: "noop",
    candidateLimit: 50,
    resultLimit: 10,
    fallback: ["noop"],
    crossEncoder: {
      model: "mixedbread-ai/mxbai-rerank-xsmall-multilingual-v1",
      batchSize: 16,
      dtype: "q8",
      maxTextLength: 512,
    },
    von: {
      backend: "python",
      pythonPath: "python3",
      workerPath: "adapters/python/model_worker.py",
      model: "Qwen/Qwen2.5-0.5B-Instruct",
      timeoutMs: 5_000,
      batchSize: 8,
      maxTextLength: 512,
      warmupTimeoutMs: 120_000,
    },
  },
  ranking: {
    policy: "reranker",
    weights: { bm25: 0.2, vector: 0.2, rrf: 0.2, reranker: 0.4 },
  },
  embedding: {
    provider: "hashing",
    model: "local/hashing-embedder",
    modelVersion: "hashing-v1",
    dimensions: 384,
    batchSize: 64,
    normalize: true,
  },
  normalization: {
    enabled: true,
    provider: "deterministic",
    language: "fr",
    typo: {
      enabled: true,
      maxEditDistance: 2,
      minTokenLength: 4,
    },
    tinyLm: {
      pythonPath: "python3",
      workerPath: "adapters/python/model_worker.py",
      model: "Qwen/Qwen2.5-0.5B-Instruct",
      timeoutMs: 3_000,
      maxInputChars: 256,
    },
  },
  cache: {
    enabled: true,
    maxEntries: 500,
    ttlMs: 300_000,
  },
  logging: {
    enabled: true,
    level: "info",
    pretty: true,
    debugSearch: false,
    events: {
      enabled: false,
      behaviorEvents: false,
    },
  },
  documents: {
    preload: true,
    lruMax: 200_000,
  },
};

/** Mode presets overlay defaults; explicit config always wins over presets. */
export const MODE_PRESETS: Record<SearchMode, DeepPartial<SearchEngineConfig>> = {
  development: {},
  production: {
    logging: { pretty: false, level: "info", debugSearch: false },
    cache: { enabled: true },
  },
  benchmark: {
    logging: { pretty: false, level: "warn", debugSearch: false, events: { enabled: false, behaviorEvents: false } },
    cache: { enabled: false },
  },
  debug: {
    logging: { level: "debug", pretty: true, debugSearch: true },
  },
};

// ---------------------------------------------------------------------------
// deep-merge helpers (small, dependency-free)
// ---------------------------------------------------------------------------

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object | undefined ? (T[K] extends readonly unknown[] ? T[K] : DeepPartial<NonNullable<T[K]>>) : T[K];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge `patch` over `base`; arrays are replaced, not concatenated. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return structuredClone(base);
  const out: Record<string, unknown> = structuredClone(base as Record<string, unknown>);
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = out[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = deepMerge(current, value as DeepPartial<Record<string, unknown>>);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out as T;
}
