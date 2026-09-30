import type { NormalizeContext, NormalizedQuery } from "../core/types.js";
import type { QueryNormalizer } from "./interfaces.js";

/**
 * Scriptable mock normalizer for tests: applies an exact from->to string map
 * (both for the normalized text and attribute values), or passes through.
 */
export class MockNormalizer implements QueryNormalizer {
  readonly id = "mock";
  readonly version = "mock-v1";

  constructor(
    private readonly replacements: Record<string, string> = {},
    private readonly attributes: Record<string, string> = {},
  ) {}

  async normalize(raw: string, _ctx?: NormalizeContext): Promise<NormalizedQuery> {
    const trimmed = raw.trim();
    const normalized = this.replacements[trimmed] ?? trimmed;
    const tokens = normalized
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    return {
      original: raw,
      normalized,
      tokens,
      attributes: Object.fromEntries(
        Object.entries(this.attributes).map(([name, value]) => [
          name,
          { name, value, raw: raw, provenance: "inferred" as const, rule: "mock" },
        ]),
      ),
      attributeValues: { ...this.attributes },
      codes: [],
      tokenProvenance: {},
      corrections: normalized !== trimmed ? [{ from: trimmed, to: normalized, kind: "typo", rule: "mock" }] : [],
      normalizerId: this.id,
      normalizerVersion: this.version,
      isEmpty: trimmed.length === 0,
      notes: [],
    };
  }
}
