import type {
  Bm25Config,
} from "../../config/schema.js";
import type { NormalizedQuery, ProductSearchDocument, RetrievalResult, SearchDocumentFields } from "../../core/types.js";
import { analyzeCode, analyzeText, canonicalCode } from "../../analysis/analyzer.js";
import type { SearchDocumentBuilder } from "../../document/builder.js";

/**
 * In-memory BM25F (field-weighted BM25) index specialized for product search.
 *
 * Why BM25F: product documents have strongly typed fields (code, name,
 * attributes, brand, category). A match on the product code must count far
 * more than a match inside an attribute value; BM25F models this with field
 * weights while keeping classic BM25 tf/idf/length-normalization semantics.
 *
 * On top of BM25F, deterministic product signals are added as explicit,
 * configurable boosts (never hidden inside the tf computation):
 *   - exact product-code match (query code == document code, canonical forms)
 *   - code prefix match ("110B45" vs "T110B45")
 *   - numeric attribute match ("110" matching "diamètre 110 mm")
 *
 * The index is hydrated from product_search rows at startup and updated
 * incrementally by the indexer; it is NOT the source of truth.
 */

export type FieldName = "code" | "name" | "attributes" | "brand" | "category";
export const FIELD_NAMES: readonly FieldName[] = ["code", "name", "attributes", "brand", "category"];

interface FieldPosting {
  /** term -> term frequency in this field */
  tf: Map<string, number>;
  /** total number of terms (incl. variants) for length normalization */
  length: number;
}

interface IndexedDoc {
  productId: string;
  fields: Record<FieldName, FieldPosting>;
  /** document-level term presence (for idf) */
  terms: Set<string>;
  /** numeric terms found in the attributes field (for numeric boost) */
  attributeNumbers: Set<string>;
  canonicalCode: string;
}

export interface Bm25SearchDebug {
  productId: string;
  score: number;
  bm25fScore: number;
  exactCodeBoost: number;
  codePrefixBoost: number;
  numericBoost: number;
}

export class InMemoryBm25Index {
  private docs = new Map<string, IndexedDoc>();
  private df = new Map<string, number>();
  private avgFieldLength: Record<FieldName, number> = { code: 0, name: 0, attributes: 0, brand: 0, category: 0 };
  private statsDirty = false;
  private config: Bm25Config;
  private readonly builder: SearchDocumentBuilder;

  constructor(config: Bm25Config, builder: SearchDocumentBuilder) {
    this.config = config;
    this.builder = builder;
  }

  get documentCount(): number {
    return this.docs.size;
  }

  upsert(doc: ProductSearchDocument): void {
    this.delete(doc.productId);
    const fields = this.builder.fields(doc);
    const indexed: IndexedDoc = {
      productId: doc.productId,
      fields: this.emptyFields(),
      terms: new Set(),
      attributeNumbers: new Set(),
      canonicalCode: canonicalCode(doc.code),
    };

    this.addField(indexed, "code", analyzeCode(fields.code));
    this.addField(indexed, "name", this.analyzeFieldText(fields.name));
    // Attributes: analyze "label value" pairs (labels are searchable text).
    const attrText = Object.entries(fields.attributes)
      .map(([label, value]) => `${label} ${value}`)
      .join(" ");
    const attrTerms = this.analyzeFieldText(attrText);
    this.addField(indexed, "attributes", attrTerms);
    for (const term of attrTerms) {
      if (term.kind === "number" || term.kind === "dimension") {
        indexed.attributeNumbers.add(term.term);
      }
    }
    this.addField(indexed, "brand", this.analyzeFieldText(fields.brand));
    this.addField(indexed, "category", this.analyzeFieldText(fields.category));

    this.docs.set(doc.productId, indexed);
    for (const term of indexed.terms) {
      this.df.set(term, (this.df.get(term) ?? 0) + 1);
    }
    this.statsDirty = true;
  }

  upsertMany(docs: Iterable<ProductSearchDocument>): void {
    for (const doc of docs) this.upsert(doc);
  }

  delete(productId: string): boolean {
    const doc = this.docs.get(productId);
    if (!doc) return false;
    for (const term of doc.terms) {
      const count = this.df.get(term);
      if (count === undefined) continue;
      if (count <= 1) this.df.delete(term);
      else this.df.set(term, count - 1);
    }
    this.docs.delete(productId);
    this.statsDirty = true;
    return true;
  }

  clear(): void {
    this.docs.clear();
    this.df.clear();
    this.statsDirty = true;
  }

  /** Search with full per-document debug info. */
  searchDebug(query: NormalizedQuery, limit: number): Array<RetrievalResult & { debug: Bm25SearchDebug }> {
    this.ensureStats();
    const queryTerms = this.queryTerms(query);
    if (queryTerms.size === 0 && query.codes.length === 0) return [];
    if (this.docs.size === 0) return [];

    const queryCodes = new Set<string>([
      ...query.codes.map((c) => canonicalCode(c)),
      ...query.tokens
        .filter((t) => t.length >= 4 && /[a-z]/.test(t) && /\d/.test(t))
        .map((t) => canonicalCode(t)),
    ]);

    const results: Array<RetrievalResult & { debug: Bm25SearchDebug }> = [];
    for (const doc of this.docs.values()) {
      const bm25f = this.bm25fScore(doc, queryTerms);
      const exactCodeBoost = this.exactCodeBoost(doc, queryCodes);
      const codePrefixBoost = this.codePrefixBoost(doc, queryCodes);
      const numericBoost = this.numericBoost(doc, queryTerms);
      const score = bm25f + exactCodeBoost + codePrefixBoost + numericBoost;
      // Include docs matched either lexically or via a deterministic product
      // signal (e.g. a code-prefix hit with no shared token: "T110" vs "T110B45").
      if (score <= 1e-9) continue;
      results.push({
        productId: doc.productId,
        score,
        retrieverId: "bm25",
        debug: {
          productId: doc.productId,
          score,
          bm25fScore: bm25f,
          exactCodeBoost,
          codePrefixBoost,
          numericBoost,
        },
      });
    }
    results.sort((a, b) => b.score - a.score || (a.productId < b.productId ? -1 : 1));
    return results.slice(0, limit);
  }

  search(query: NormalizedQuery, limit: number): RetrievalResult[] {
    return this.searchDebug(query, limit).map(({ productId, score, retrieverId }) => ({ productId, score, retrieverId }));
  }

  /** Frequent terms for typo-correction vocabulary (bounded). */
  vocabulary(limit = 20_000): string[] {
    this.ensureStats();
    return [...this.df.entries()]
      .filter(([term, df]) => df >= 2 && term.length >= 3 && /[a-zà-ÿ]/i.test(term))
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([term]) => term);
  }

  /** All canonical product codes (for exact-code detection in the normalizer). */
  codes(limit = 100_000): string[] {
    const out: string[] = [];
    for (const doc of this.docs.values()) {
      if (doc.canonicalCode.length > 0) out.push(doc.canonicalCode);
      if (out.length >= limit) break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private analyzeFieldText(text: string) {
    const terms = analyzeText(text);
    // Stopwords are dropped from word fields (never from the code field).
    const stops = new Set(this.config.stopwords);
    return terms.filter((t) => t.kind !== "word" || !stops.has(t.term));
  }

  private emptyFields(): Record<FieldName, FieldPosting> {
    return {
      code: { tf: new Map(), length: 0 },
      name: { tf: new Map(), length: 0 },
      attributes: { tf: new Map(), length: 0 },
      brand: { tf: new Map(), length: 0 },
      category: { tf: new Map(), length: 0 },
    };
  }

  private addField(doc: IndexedDoc, field: FieldName, terms: ReturnType<typeof analyzeText>): void {
    const posting = doc.fields[field];
    for (const t of terms) {
      const tf = t.isVariant ? 1 : (posting.tf.get(t.term) ?? 0) + 1;
      posting.tf.set(t.term, tf);
      posting.length += 1;
      doc.terms.add(t.term);
    }
  }

  /** Lazily recompute field-length averages; O(N) but amortized over batch upserts. */
  private ensureStats(): void {
    if (!this.statsDirty) return;
    const totals: Record<FieldName, number> = { code: 0, name: 0, attributes: 0, brand: 0, category: 0 };
    const counts: Record<FieldName, number> = { code: 0, name: 0, attributes: 0, brand: 0, category: 0 };
    for (const doc of this.docs.values()) {
      for (const field of FIELD_NAMES) {
        totals[field] += doc.fields[field].length;
        if (doc.fields[field].length > 0) counts[field] += 1;
      }
    }
    for (const field of FIELD_NAMES) {
      this.avgFieldLength[field] = counts[field] > 0 ? totals[field] / counts[field] : 0;
    }
    this.statsDirty = false;
  }

  /** Unique query terms (post-normalization tokens, deduplicated). */
  private queryTerms(query: NormalizedQuery): Set<string> {
    const terms = new Set<string>();
    for (const token of query.tokens) {
      for (const analyzed of analyzeText(token)) {
        if (analyzed.kind === "word" && this.config.stopwords.includes(analyzed.term)) continue;
        terms.add(analyzed.term);
      }
      // code-shaped tokens also try the code field
      if (/[a-z]/.test(token) && /\d/.test(token)) {
        for (const analyzed of analyzeCode(token)) terms.add(analyzed.term);
      }
    }
    return terms;
  }

  private idf(term: string): number {
    const n = this.docs.size;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  private bm25fScore(doc: IndexedDoc, queryTerms: Set<string>): number {
    const { k1, b, fieldWeights } = this.config;
    let score = 0;
    for (const term of queryTerms) {
      let weightedTf = 0;
      for (const field of FIELD_NAMES) {
        const tf = doc.fields[field].tf.get(term);
        if (tf === undefined) continue;
        const weight = fieldWeights[field];
        const avgLen = this.avgFieldLength[field];
        const lenNorm = avgLen > 0 ? 1 - b + b * (doc.fields[field].length / avgLen) : 1;
        weightedTf += weight * (tf / lenNorm);
      }
      if (weightedTf === 0) continue;
      score += this.idf(term) * ((weightedTf * (k1 + 1)) / (weightedTf + k1));
    }
    return score;
  }

  private exactCodeBoost(doc: IndexedDoc, queryCodes: Set<string>): number {
    if (doc.canonicalCode.length === 0 || queryCodes.size === 0) return 0;
    for (const code of queryCodes) {
      if (code === doc.canonicalCode) return this.config.boosts.exactCode;
    }
    return 0;
  }

  private codePrefixBoost(doc: IndexedDoc, queryCodes: Set<string>): number {
    if (doc.canonicalCode.length === 0 || queryCodes.size === 0) return 0;
    for (const code of queryCodes) {
      if (code.length < 4) continue;
      if (doc.canonicalCode !== code && (doc.canonicalCode.startsWith(code) || code.startsWith(doc.canonicalCode))) {
        return this.config.boosts.codePrefix;
      }
    }
    return 0;
  }

  private numericBoost(doc: IndexedDoc, queryTerms: Set<string>): number {
    if (doc.attributeNumbers.size === 0) return 0;
    let boost = 0;
    for (const term of queryTerms) {
      if (doc.attributeNumbers.has(term)) {
        boost += this.config.boosts.numericAttribute;
      }
    }
    return boost;
  }
}
