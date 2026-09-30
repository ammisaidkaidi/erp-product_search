import { createHash } from "node:crypto";
import { analyzeText } from "../../analysis/analyzer.js";
import type { Embedder } from "./embedder.js";

/**
 * Deterministic feature-hashing embedder.
 *
 * Zero dependencies, zero downloads, fully local and reproducible: a bag of
 * weighted token + character-trigram features is projected into a fixed
 * dimension space via hashing, then L2-normalized. Cosine similarity between
 * two embeddings therefore approximates lexical/character overlap.
 *
 * This is an honest BASELINE, not a semantic model: it captures vocabulary
 * and surface similarity, not meaning. It exists so the whole hybrid pipeline
 * (and every test and benchmark) runs offline; switching to a real model is a
 * config change (`embedding.provider: transformers`).
 */
export class HashingEmbedder implements Embedder {
  readonly id = "hashing";
  readonly modelVersion: string;
  readonly dimensions: number;

  constructor(options: { dimensions?: number; modelVersion?: string } = {}) {
    this.dimensions = options.dimensions ?? 384;
    this.modelVersion = options.modelVersion ?? `hashing-d${this.dimensions}-v1`;
  }

  async embed(text: string): Promise<number[]> {
    return this.embedBatch([text]).then((v) => v[0]!);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.hash(text));
  }

  private hash(text: string): number[] {
    const vec = new Float64Array(this.dimensions);
    const terms = analyzeText(text);

    // Weighted token features (sublinear tf).
    const tf = new Map<string, number>();
    for (const t of terms) {
      tf.set(t.term, (tf.get(t.term) ?? 0) + (t.isVariant ? 0.5 : 1));
    }
    for (const [term, freq] of tf) {
      const weight = 1 + Math.log(freq);
      this.addFeature(vec, `t:${term}`, weight);
    }

    // Character trigrams of the folded text: gives fuzzy surface similarity
    // (helps typos and near-miss codes) without any model.
    const folded = analyzeText(text)
      .map((t) => t.term)
      .join(" ");
    const padded = `^${folded}$`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      this.addFeature(vec, `g:${padded.slice(i, i + 3)}`, 0.3);
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
    norm = Math.sqrt(norm);
    if (norm === 0) {
      // deterministic non-zero vector for empty text: hash of empty string
      this.addFeature(vec, "e:empty", 1);
      norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    }
    return Array.from(vec, (v) => v / norm);
  }

  /** Project a named feature into the vector with a deterministic sign. */
  private addFeature(vec: Float64Array, feature: string, weight: number): void {
    const digest = createHash("sha1").update(feature).digest();
    const index = ((digest[0]! << 8) | digest[1]!) % this.dimensions;
    // sign bit from the third byte: decorrelates hash collisions
    const sign = digest[2]! % 2 === 0 ? 1 : -1;
    vec[index] = (vec[index] ?? 0) + sign * weight;
  }
}
