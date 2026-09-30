import type { Bm25Config } from "../../config/schema.js";
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
 * Implementation: an inverted index (term -> doc -> per-field tf) so scoring
 * visits only documents containing query terms — O(matching docs), not
 * O(catalog). A code index answers exact/prefix code boosts without scans.
 * (Measured before/after on 50k products: see docs/performance.md.)
 *
 * The index is hydrated from product_search rows at startup and updated
 * incrementally by the indexer; it is NOT the source of truth.
 */

export type FieldName = "code" | "name" | "attributes" | "brand" | "category";
export const FIELD_NAMES: readonly FieldName[] = ["code", "name", "attributes", "brand", "category"];
const FIELD_INDEX: Record<FieldName, number> = { code: 0, name: 1, attributes: 2, brand: 3, category: 4 };

/** per-term, per-document term frequencies in each field */
interface PostingEntry {
  tf: [number, number, number, number, number];
}

interface DocEntry {
  productId: string;
  /** total terms per field, for length normalization */
  lengths: [number, number, number, number, number];
  /** every indexed term of this document (for deletion) */
  terms: string[];
  canonicalCode: string;
  index: number;
}

export interface Bm25SearchDebug {
  productId: string;
  score: number;
  bm25fScore: number;
  exactCodeBoost: number;
  codePrefixBoost: number;
  numericBoost: number;
}

interface CandidateAccumulator {
  bm25f: number;
  exactCodeBoost: number;
  codePrefixBoost: number;
  numericBoost: number;
}

export class InMemoryBm25Index {
  private docsArr: DocEntry[] = [];
  private freeIndices: number[] = [];
  private idToIndex = new Map<string, number>();
  private postings = new Map<string, Map<number, PostingEntry>>();
  private codeIndex = new Map<string, number>();
  /** sum of field lengths / count of docs having the field (incremental averages) */
  private fieldLengthSum = [0, 0, 0, 0, 0];
  private fieldDocCount = [0, 0, 0, 0, 0];
  private config: Bm25Config;
  private readonly builder: SearchDocumentBuilder;

  constructor(config: Bm25Config, builder: SearchDocumentBuilder) {
    this.config = config;
    this.builder = builder;
  }

  get documentCount(): number {
    return this.idToIndex.size;
  }

  upsert(doc: ProductSearchDocument): void {
    this.delete(doc.productId);
    const fields = this.builder.fields(doc);
    const index = this.freeIndices.pop() ?? this.docsArr.length;
    const entry: DocEntry = {
      productId: doc.productId,
      lengths: [0, 0, 0, 0, 0],
      terms: [],
      canonicalCode: canonicalCode(doc.code),
      index,
    };
    this.docsArr[index] = entry;
    this.idToIndex.set(doc.productId, index);
    if (entry.canonicalCode.length > 0) this.codeIndex.set(entry.canonicalCode, index);

    this.addField(entry, FIELD_INDEX.code, analyzeCode(fields.code));
    this.addField(entry, FIELD_INDEX.name, this.analyzeFieldText(fields.name));
    // Attributes: analyze "label value" pairs (labels are searchable text).
    const attrText = Object.entries(fields.attributes)
      .map(([label, value]) => `${label} ${value}`)
      .join(" ");
    this.addField(entry, FIELD_INDEX.attributes, this.analyzeFieldText(attrText));
    this.addField(entry, FIELD_INDEX.brand, this.analyzeFieldText(fields.brand));
    this.addField(entry, FIELD_INDEX.category, this.analyzeFieldText(fields.category));

    for (let f = 0; f < 5; f++) {
      if (entry.lengths[f]! > 0) {
        this.fieldLengthSum[f]! += entry.lengths[f]!;
        this.fieldDocCount[f]! += 1;
      }
    }
  }

  upsertMany(docs: Iterable<ProductSearchDocument>): void {
    for (const doc of docs) this.upsert(doc);
  }

  delete(productId: string): boolean {
    const index = this.idToIndex.get(productId);
    if (index === undefined) return false;
    const entry = this.docsArr[index]!;
    for (const term of entry.terms) {
      const posting = this.postings.get(term);
      if (posting === undefined) continue;
      posting.delete(index);
      if (posting.size === 0) this.postings.delete(term);
    }
    if (entry.canonicalCode.length > 0) this.codeIndex.delete(entry.canonicalCode);
    for (let f = 0; f < 5; f++) {
      if (entry.lengths[f]! > 0) {
        this.fieldLengthSum[f]! -= entry.lengths[f]!;
        this.fieldDocCount[f]! -= 1;
      }
    }
    this.idToIndex.delete(productId);
    this.docsArr[index] = null as unknown as DocEntry;
    this.freeIndices.push(index);
    return true;
  }

  clear(): void {
    this.docsArr = [];
    this.freeIndices = [];
    this.idToIndex.clear();
    this.postings.clear();
    this.codeIndex.clear();
    this.fieldLengthSum = [0, 0, 0, 0, 0];
    this.fieldDocCount = [0, 0, 0, 0, 0];
  }

  /** Search with full per-document debug info. */
  searchDebug(query: NormalizedQuery, limit: number): Array<RetrievalResult & { debug: Bm25SearchDebug }> {
    const queryTerms = this.queryTerms(query);
    const queryCodes = new Set<string>([
      ...query.codes.map((c) => canonicalCode(c)),
      ...query.tokens
        .filter((t) => t.length >= 4 && /[a-z]/.test(t) && /\d/.test(t))
        .map((t) => canonicalCode(t)),
    ]);
    if (queryTerms.size === 0 && queryCodes.size === 0) return [];

    const candidates = new Map<number, CandidateAccumulator>();
    const touch = (docIndex: number): CandidateAccumulator => {
      let acc = candidates.get(docIndex);
      if (!acc) {
        acc = { bm25f: 0, exactCodeBoost: 0, codePrefixBoost: 0, numericBoost: 0 };
        candidates.set(docIndex, acc);
      }
      return acc;
    };

    // ---- BM25F scoring via the inverted index -----------------------------
    const { k1, b, fieldWeights } = this.config;
    const weights: number[] = [
      fieldWeights.code,
      fieldWeights.name,
      fieldWeights.attributes,
      fieldWeights.brand,
      fieldWeights.category,
    ];
    const n = this.idToIndex.size;
    for (const term of queryTerms) {
      const posting = this.postings.get(term);
      if (posting === undefined || posting.size === 0) continue;
      const df = posting.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      if (idf <= 0) continue;
      const isNumericQueryTerm = /^\d+(?:\.\d+)?(x\d+(\.\d+)?)?$/.test(term);
      for (const [docIndex, entry] of posting) {
        const doc = this.docsArr[docIndex]!;
        let weightedTf = 0;
        for (let f = 0; f < 5; f++) {
          const tf = entry.tf[f]!;
          if (tf === 0) continue;
          const avg = this.fieldDocCount[f]! > 0 ? this.fieldLengthSum[f]! / this.fieldDocCount[f]! : 0;
          const lenNorm = avg > 0 ? 1 - b + b * (doc.lengths[f]! / avg) : 1;
          weightedTf += weights[f]! * (tf / lenNorm);
        }
        if (weightedTf === 0) continue;
        const acc = touch(docIndex);
        acc.bm25f += idf * ((weightedTf * (k1 + 1)) / (weightedTf + k1));
        // numeric attribute signal: query number matching an attributes-field number
        if (isNumericQueryTerm && entry.tf[FIELD_INDEX.attributes]! > 0) {
          acc.numericBoost += this.config.boosts.numericAttribute;
        }
      }
    }

    // ---- deterministic code boosts ----------------------------------------
    for (const code of queryCodes) {
      const exact = this.codeIndex.get(code);
      if (exact !== undefined) {
        touch(exact).exactCodeBoost = this.config.boosts.exactCode;
        continue;
      }
      if (code.length < 4) continue;
      // prefix in either direction; only scans when a code-shaped query exists
      for (const [docCode, docIndex] of this.codeIndex) {
        if (docCode !== code && (docCode.startsWith(code) || code.startsWith(docCode))) {
          const acc = touch(docIndex);
          if (acc.codePrefixBoost === 0) acc.codePrefixBoost = this.config.boosts.codePrefix;
        }
      }
    }

    const results: Array<RetrievalResult & { debug: Bm25SearchDebug }> = [];
    for (const [docIndex, acc] of candidates) {
      const doc = this.docsArr[docIndex]!;
      const score = acc.bm25f + acc.exactCodeBoost + acc.codePrefixBoost + acc.numericBoost;
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
          bm25fScore: acc.bm25f,
          exactCodeBoost: acc.exactCodeBoost,
          codePrefixBoost: acc.codePrefixBoost,
          numericBoost: acc.numericBoost,
        },
      });
    }
    results.sort((a, b2) => b2.score - a.score || (a.productId < b2.productId ? -1 : 1));
    return results.slice(0, limit);
  }

  search(query: NormalizedQuery, limit: number): RetrievalResult[] {
    return this.searchDebug(query, limit).map(({ productId, score, retrieverId }) => ({ productId, score, retrieverId }));
  }

  /** Frequent terms for typo-correction vocabulary (bounded). */
  vocabulary(limit = 20_000): string[] {
    return [...this.postings.entries()]
      .filter(([term, posting]) => posting.size >= 2 && term.length >= 3 && /[a-zà-ÿ]/i.test(term))
      .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit)
      .map(([term]) => term);
  }

  /** All canonical product codes (for exact-code detection in the normalizer). */
  codes(limit = 100_000): string[] {
    const out: string[] = [];
    for (const code of this.codeIndex.keys()) {
      out.push(code);
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

  private addField(doc: DocEntry, field: number, terms: ReturnType<typeof analyzeText>): void {
    for (const t of terms) {
      let posting = this.postings.get(t.term);
      if (!posting) {
        posting = new Map();
        this.postings.set(t.term, posting);
      }
      let entry = posting.get(doc.index);
      if (!entry) {
        entry = { tf: [0, 0, 0, 0, 0] };
        posting.set(doc.index, entry);
        doc.terms.push(t.term);
      }
      entry.tf[field] = t.isVariant ? Math.max(1, entry.tf[field]!) : entry.tf[field]! + 1;
      doc.lengths[field]! += 1;
    }
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
}
