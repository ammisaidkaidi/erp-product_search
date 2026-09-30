import { analyzeText } from "../analysis/analyzer.js";
import type { NormalizeContext, NormalizedQuery } from "../core/types.js";
import type { QueryNormalizer } from "./interfaces.js";

/**
 * Minimal normalizer used when normalization is disabled: it only tokenizes
 * (BM25 still needs tokens). No corrections, no attribute extraction, no
 * invented data — the raw query passes through unchanged.
 */
export class TokenizingNormalizer implements QueryNormalizer {
  readonly id = "none";
  readonly version = "none-v1";

  async normalize(raw: string, _ctx?: NormalizeContext): Promise<NormalizedQuery> {
    const trimmed = raw.trim();
    const tokens = [...new Set(analyzeText(trimmed).map((t) => t.term))];
    return {
      original: raw,
      normalized: trimmed,
      tokens,
      attributes: {},
      attributeValues: {},
      codes: [],
      tokenProvenance: {},
      corrections: [],
      normalizerId: this.id,
      normalizerVersion: this.version,
      isEmpty: trimmed.length === 0,
      notes: [],
    };
  }
}
