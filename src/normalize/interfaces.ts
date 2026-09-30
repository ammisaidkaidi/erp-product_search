import type { NormalizeContext, NormalizedQuery, TokenProvenance } from "../core/types.js";

/**
 * Query normalization contracts.
 *
 * The engine depends only on QueryNormalizer. Implementations:
 *   - TokenizingNormalizer   (provider "none": tokenize only)
 *   - DeterministicNormalizer (provider "deterministic": rules + dictionaries)
 *   - TinyLmNormalizer       (provider "tinyllm": deterministic + local LLM pass)
 *   - MockNormalizer         (tests)
 *
 * CRITICAL RULE for all implementations: never invent product attributes.
 * Everything in `attributes` must come from an explicit deterministic rule
 * applied to observed input, with provenance recorded.
 */
export interface QueryNormalizer {
  readonly id: string;
  /** Version used in cache keys. */
  readonly version: string;
  normalize(raw: string, ctx?: NormalizeContext): Promise<NormalizedQuery>;
}

/**
 * Language-specific deterministic rules behind QueryNormalizer. The core
 * engine never imports language data; the composition root selects a
 * LanguageNormalizer (French ships in v1, others can be added).
 */
export interface LanguageNormalizer {
  readonly language: string;
  readonly version: string;
  normalizeDet(raw: string, ctx: NormalizeContext): DeterministicNormalization;
}

/** Intermediate deterministic result before final NormalizedQuery assembly. */
export interface DeterministicNormalization {
  normalized: string;
  tokens: string[];
  tokenProvenance: Record<string, TokenProvenance>;
  codes: string[];
  attributes: NormalizedQuery["attributes"];
  corrections: NormalizedQuery["corrections"];
  notes: string[];
}
