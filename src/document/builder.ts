import { createHash } from "node:crypto";
import type { Product, ProductSearchDocument, SearchDocumentFields } from "../core/types.js";
import { DOCUMENT_BUILDER_VERSION } from "../core/version.js";

export interface SearchDocumentBuilderOptions {
  /** Attribute key -> human label (e.g. diameter -> "diamètre"). */
  labelMap: Readonly<Record<string, string>>;
  /** Fallback label generator for unmapped keys. */
  humanize?: (key: string) => string;
  /** Overrides the builder version (cache invalidation knob for advanced setups). */
  version?: string;
}

/**
 * Builds the canonical, deterministic searchable representation of a product.
 *
 * Rules (locked by unit tests):
 *  - attribute parts are emitted sorted by attribute key => stable regardless of
 *    the source JSON key order;
 *  - the product code always comes first, the name second;
 *  - brand / category / subcategory are appended when present;
 *  - documentHash = sha256 over the canonical JSON of all inputs + builder version,
 *    so any change to a searchable input (or the builder itself) invalidates
 *    derived artifacts (embeddings).
 *
 * The original product object is never mutated.
 */
export class SearchDocumentBuilder {
  private readonly labelMap: Readonly<Record<string, string>>;
  private readonly humanize: (key: string) => string;
  readonly version: string;

  constructor(options: SearchDocumentBuilderOptions) {
    this.labelMap = options.labelMap;
    this.humanize = options.humanize ?? ((key: string) => key.replace(/[_-]+/g, " ").trim() || key);
    this.version = options.version ?? DOCUMENT_BUILDER_VERSION;
  }

  label(attributeKey: string): string {
    return this.labelMap[attributeKey] ?? this.humanize(attributeKey);
  }

  /** Canonical "label value" attribute pairs, sorted by attribute key. */
  attributePairs(attributes: Readonly<Record<string, string>>): Array<{ key: string; label: string; value: string }> {
    return Object.keys(attributes)
      .filter((k) => {
        const v = attributes[k];
        return typeof v === "string" && v.trim().length > 0;
      })
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => ({ key, label: this.label(key), value: attributes[key]!.trim() }));
  }

  build(product: Product): ProductSearchDocument {
    if (!product || typeof product.id !== "string" || product.id.length === 0) {
      throw new TypeError("Product must have a non-empty string id");
    }
    const attributes = product.attributes ?? {};
    const pairs = this.attributePairs(attributes);

    const parts: string[] = [product.code, product.name]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim());
    for (const pair of pairs) {
      parts.push(`${pair.label} ${pair.value}`);
    }
    for (const extra of [product.brand, product.category, product.subcategory]) {
      if (typeof extra === "string" && extra.trim().length > 0) {
        parts.push(extra.trim());
      }
    }
    const searchDocument = parts.join(" | ");

    const canonicalInput = {
      v: this.version,
      id: product.id,
      code: product.code ?? "",
      name: product.name ?? "",
      attributes: pairs.map((p) => [p.key, p.value]),
      brand: product.brand ?? "",
      category: product.category ?? "",
      subcategory: product.subcategory ?? "",
    };
    const documentHash = createHash("sha256").update(JSON.stringify(canonicalInput)).digest("hex");

    return {
      productId: product.id,
      code: product.code ?? "",
      name: product.name ?? "",
      attributes,
      brand: product.brand,
      category: product.category,
      subcategory: product.subcategory,
      searchDocument,
      builderVersion: this.version,
      documentHash,
    };
  }

  /** Structured fields consumed by the field-weighted lexical index. */
  fields(doc: ProductSearchDocument): SearchDocumentFields {
    return {
      code: doc.code,
      name: doc.name,
      attributes: Object.fromEntries(this.attributePairs(doc.attributes).map((p) => [p.label, p.value])),
      brand: doc.brand ?? "",
      category: [doc.category, doc.subcategory].filter(Boolean).join(" "),
    };
  }
}
