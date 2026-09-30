import { ConfigurationError } from "../core/errors.js";
import type { SearchEngineConfig } from "./schema.js";

/**
 * Hand-rolled validation of the final config object. The config surface is
 * finite and documented; this gives precise, actionable error messages without
 * pulling in a schema-validation dependency.
 */
export function validateConfig(config: SearchEngineConfig): string[] {
  const errors: string[] = [];
  const check = (cond: boolean, path: string, message: string) => {
    if (!cond) errors.push(`${path}: ${message}`);
  };

  check(["development", "production", "benchmark", "debug"].includes(config.mode), "mode", "must be development|production|benchmark|debug");

  // search
  check(Number.isInteger(config.search.defaultLimit) && config.search.defaultLimit >= 1, "search.default_limit", "must be an integer >= 1");
  check(config.search.maxLimit >= config.search.defaultLimit, "search.max_limit", "must be >= search.default_limit");
  check(config.search.maxQueryLength >= 16 && config.search.maxQueryLength <= 8192, "search.max_query_length", "must be within [16, 8192]");

  // retrieval.bm25
  const bm25 = config.retrieval.bm25;
  check(bm25.topK >= 1 && bm25.topK <= 1000, "retrieval.bm25.top_k", "must be within [1, 1000]");
  check(bm25.k1 > 0 && bm25.k1 <= 3, "retrieval.bm25.k1", "must be within (0, 3]");
  check(bm25.b >= 0 && bm25.b <= 1, "retrieval.bm25.b", "must be within [0, 1]");
  for (const [field, weight] of Object.entries(bm25.fieldWeights)) {
    check(weight >= 0, `retrieval.bm25.field_weights.${field}`, "must be >= 0");
  }
  for (const [name, boost] of Object.entries(bm25.boosts)) {
    check(boost >= 0, `retrieval.bm25.boosts.${name}`, "must be >= 0");
  }
  if (!bm25.enabled && !config.retrieval.vector.enabled) {
    errors.push("retrieval: at least one of retrieval.bm25.enabled / retrieval.vector.enabled must be true");
  }

  // retrieval.vector
  const vector = config.retrieval.vector;
  check(vector.topK >= 1 && vector.topK <= 1000, "retrieval.vector.top_k", "must be within [1, 1000]");
  check(["cosine", "inner-product"].includes(vector.metric), "retrieval.vector.metric", "must be cosine|inner-product");

  // fusion
  const fusion = config.fusion;
  check(fusion.provider === "rrf", "fusion.provider", "only 'rrf' is supported");
  check(fusion.k >= 1, "fusion.k", "must be >= 1");
  check(fusion.topK >= 1, "fusion.top_k", "must be >= 1");
  check(fusion.weights.bm25 >= 0 && fusion.weights.vector >= 0, "fusion.weights", "weights must be >= 0");

  // reranking
  const rr = config.reranking;
  check(["noop", "cross-encoder", "von"].includes(rr.provider), "reranking.provider", "must be noop|cross-encoder|von");
  check(rr.candidateLimit >= 1 && rr.candidateLimit <= 500, "reranking.candidate_limit", "must be within [1, 500]");
  check(rr.resultLimit >= 1 && rr.resultLimit <= 100, "reranking.result_limit", "must be within [1, 100]");
  check(rr.fallback.every((f) => ["noop", "cross-encoder", "von"].includes(f)), "reranking.fallback", "entries must be noop|cross-encoder|von");
  if (rr.provider === "von" && rr.fallback.length === 0) {
    errors.push("reranking.fallback: von requires at least one fallback provider (e.g. noop)");
  }
  if (!rr.enabled && rr.provider === "von") {
    // allowed: disabled reranking with provider configured — noop is used
  }
  check(rr.crossEncoder.batchSize >= 1, "reranking.cross_encoder.batch_size", "must be >= 1");
  check(rr.von.batchSize >= 1, "reranking.von.batch_size", "must be >= 1");
  check(rr.von.timeoutMs >= 100, "reranking.von.timeout_ms", "must be >= 100");

  // ranking policy
  check(["reranker", "weighted"].includes(config.ranking.policy), "ranking.policy", "must be reranker|weighted");
  if (config.ranking.policy === "weighted") {
    const w = config.ranking.weights;
    const sum = w.bm25 + w.vector + w.rrf + w.reranker;
    check(sum > 0, "ranking.weights", "weights must sum to > 0 when policy=weighted");
  }

  // embedding
  const emb = config.embedding;
  check(["hashing", "transformers", "mock"].includes(emb.provider), "embedding.provider", "must be hashing|transformers|mock");
  check(emb.dimensions >= 8 && emb.dimensions <= 4096, "embedding.dimensions", "must be within [8, 4096]");
  check(emb.batchSize >= 1, "embedding.batch_size", "must be >= 1");
  if (emb.provider === "transformers") {
    check(emb.model.length > 0, "embedding.model", "required for the transformers provider");
  }

  // normalization
  const norm = config.normalization;
  check(["none", "deterministic", "tinyllm", "mock"].includes(norm.provider), "normalization.provider", "must be none|deterministic|tinyllm|mock");
  check(norm.language.length >= 2, "normalization.language", "must be an ISO language code");
  if (norm.provider === "deterministic" || norm.provider === "tinyllm") {
    check(norm.typo.maxEditDistance === 1 || norm.typo.maxEditDistance === 2, "normalization.typo.max_edit_distance", "must be 1 or 2");
    check(norm.typo.minTokenLength >= 3, "normalization.typo.min_token_length", "must be >= 3");
  }
  check(norm.tinyLm.timeoutMs >= 100, "normalization.tinyllm.timeout_ms", "must be >= 100");

  // cache
  const cache = config.cache;
  check(cache.maxEntries >= 1, "cache.max_entries", "must be >= 1");
  check(cache.ttlMs === 0 || cache.ttlMs >= 1000, "cache.ttl_ms", "must be 0 (no ttl) or >= 1000");

  // documents
  check(config.documents.lruMax >= 1000, "documents.lru_max", "must be >= 1000");

  // database (may be absent for pure in-memory mode, but then a warning belongs to runtime)
  if (config.database.url === undefined && config.database.host === undefined) {
    errors.push("database: either database.url or database.host must be set for PostgreSQL-backed stores");
  }

  return errors;
}

export function assertValidConfig(config: SearchEngineConfig): void {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new ConfigurationError(`Invalid search configuration (${errors.length} error(s)):\n  - ${errors.join("\n  - ")}`);
  }
}
