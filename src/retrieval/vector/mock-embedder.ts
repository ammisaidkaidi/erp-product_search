import type { Embedder } from "./embedder.js";

/**
 * Deterministic mock embedder for tests. Maps each text to a stable
 * pseudo-random unit vector (seeded by the text hash) unless an explicit
 * mapping is provided. Fixture mappings make vector-retrieval scenarios
 * (e.g. "vector finds the semantically close product that BM25 misses")
 * explicit and testable without downloading models.
 */
export class MockEmbedder implements Embedder {
  readonly id = "mock";
  readonly modelVersion: string;
  readonly dimensions: number;

  private readonly fixtures: Map<string, number[]>;

  constructor(options: { dimensions?: number; fixtures?: Map<string, number[]>; modelVersion?: string } = {}) {
    this.dimensions = options.dimensions ?? 8;
    this.modelVersion = options.modelVersion ?? `mock-d${this.dimensions}`;
    this.fixtures = options.fixtures ?? new Map();
  }

  async embed(text: string): Promise<number[]> {
    return this.embedBatch([text]).then((v) => v[0]!);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.vectorFor(text));
  }

  private vectorFor(text: string): number[] {
    const fixture = this.fixtures.get(text);
    if (fixture) return [...fixture];
    const vec: number[] = [];
    let seed = 0;
    for (let i = 0; i < text.length; i++) {
      seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
    }
    let state = seed || 1;
    for (let i = 0; i < this.dimensions; i++) {
      // xorshift32
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      vec.push(((state % 2000) - 1000) / 1000);
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}
