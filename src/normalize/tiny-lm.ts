import type { NormalizeContext, NormalizedQuery } from "../core/types.js";
import { errorSummary } from "../core/errors.js";
import type { Logger } from "../logging/logger.js";
import type { PythonModelWorker } from "../adapters/python-worker.js";
import type { QueryNormalizer } from "./interfaces.js";
import type { DeterministicNormalizer } from "./deterministic.js";
import type { LanguageDictionary } from "./dictionaries/fr.js";

export interface TinyLmNormalizerOptions {
  deterministic: DeterministicNormalizer;
  worker: PythonModelWorker;
  dictionary: LanguageDictionary;
  config: {
    timeoutMs: number;
    maxInputChars: number;
  };
  logger: Logger;
}

/**
 * TinyLM-backed query normalizer: deterministic rules first, then an optional
 * local-LLM refinement pass (typo cleanup + attribute extraction) through the
 * python worker.
 *
 * Safety rules (the LLM is untrusted):
 *  - worker unavailable / timeout / malformed output => deterministic result
 *    kept, degradation logged and recorded as a note (never hidden, never fatal);
 *  - LLM attributes are accepted ONLY for whitelisted attribute names
 *    (dictionary.knownAttributeNames), are never allowed to overwrite
 *    deterministic extractions, and are marked provenance "inferred"
 *    with rule "tinyllm";
 *  - output length is bounded.
 */
export class TinyLmNormalizer implements QueryNormalizer {
  readonly id = "tinyllm";
  readonly version: string;

  constructor(private readonly options: TinyLmNormalizerOptions) {
    this.version = `tinyllm:${options.deterministic.version}`;
  }

  async normalize(raw: string, ctx?: NormalizeContext): Promise<NormalizedQuery> {
    const base = await this.options.deterministic.normalize(raw, ctx);
    const trimmed = raw.trim();
    if (trimmed.length < 3 || trimmed.length > this.options.config.maxInputChars) {
      return base;
    }

    let response;
    try {
      await this.options.worker.start();
      response = await this.options.worker.request("normalize", { query: trimmed }, this.options.config.timeoutMs);
    } catch (e) {
      base.notes.push(`tinyllm worker error: ${errorSummary(e).message}`);
      this.options.logger.warn("tinyllm normalizer worker failed; deterministic result kept", {
        error: errorSummary(e).message,
      });
      return this.merge(base, null);
    }
    if (!response.ok) {
      base.notes.push(`tinyllm unavailable (${response.error.code}): ${response.error.message}`);
      this.options.logger.warn("tinyllm normalizer unavailable; deterministic result kept", {
        code: response.error.code,
        error: response.error.message,
      });
      return this.merge(base, null);
    }

    const result = response.result as { normalized?: unknown; attributes?: unknown } | null;
    if (!result || typeof result !== "object" || typeof result.normalized !== "string") {
      base.notes.push("tinyllm returned malformed output; deterministic result kept");
      this.options.logger.warn("tinyllm returned malformed output", {});
      return this.merge(base, null);
    }

    const llmNormalized = result.normalized.slice(0, 256);
    const llmAttributes: Record<string, { value: string }> = {};
    if (result.attributes && typeof result.attributes === "object") {
      for (const [key, value] of Object.entries(result.attributes as Record<string, unknown>)) {
        const known = this.options.dictionary.knownAttributeNames.includes(key);
        const clean = typeof value === "string" ? value.trim().slice(0, 32) : "";
        if (known && clean && !base.attributes[key]) {
          llmAttributes[key] = { value: clean };
        }
      }
    }

    if (llmNormalized !== base.normalized && llmNormalized.length > 0) {
      base.corrections.push({ from: base.normalized, to: llmNormalized, kind: "typo", rule: "tinyllm:cleanup" });
    }
    return this.merge(base, { normalized: llmNormalized, attributes: llmAttributes });
  }

  private merge(
    base: NormalizedQuery,
    llm: { normalized: string; attributes: Record<string, { value: string }> } | null,
  ): NormalizedQuery {
    if (!llm) return base;
    const attributes = { ...base.attributes };
    const attributeValues = { ...base.attributeValues };
    for (const [key, attr] of Object.entries(llm.attributes)) {
      attributes[key] = {
        name: key,
        value: attr.value,
        raw: base.original,
        provenance: "inferred",
        rule: "tinyllm",
      };
      attributeValues[key] = attr.value;
    }
    return {
      ...base,
      normalized: llm.normalized,
      attributes,
      attributeValues,
      normalizerId: this.id,
    };
  }
}
