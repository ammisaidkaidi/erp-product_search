import type { NormalizeContext, NormalizedQuery } from "../core/types.js";
import type { QueryNormalizer } from "./interfaces.js";
import type { LanguageNormalizer } from "./interfaces.js";

/**
 * QueryNormalizer driven by a LanguageNormalizer (French in v1). Pure,
 * deterministic, synchronous inside. The engine only sees QueryNormalizer.
 */
export class DeterministicNormalizer implements QueryNormalizer {
  readonly id: string;
  readonly version: string;

  constructor(private readonly language: LanguageNormalizer) {
    this.id = `deterministic:${language.language}`;
    this.version = language.version;
  }

  async normalize(raw: string, ctx?: NormalizeContext): Promise<NormalizedQuery> {
    const det = this.language.normalizeDet(raw, ctx ?? {});
    return this.assemble(raw, det);
  }

  protected assemble(raw: string, det: ReturnType<LanguageNormalizer["normalizeDet"]>): NormalizedQuery {
    const attributeValues: Record<string, string> = {};
    for (const [key, attr] of Object.entries(det.attributes)) {
      attributeValues[key] = attr.unit ? `${attr.value} ${attr.unit}` : attr.value;
    }
    return {
      original: raw,
      normalized: det.normalized,
      tokens: det.tokens,
      attributes: det.attributes,
      attributeValues,
      codes: det.codes,
      tokenProvenance: det.tokenProvenance,
      corrections: det.corrections,
      normalizerId: this.id,
      normalizerVersion: this.version,
      isEmpty: det.normalized.length === 0,
      notes: det.notes,
    };
  }
}
