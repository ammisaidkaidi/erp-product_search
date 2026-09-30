/**
 * Embedder contract. Implementations: HashingEmbedder (zero-dependency
 * baseline), TransformersEmbedder (ONNX via optional @huggingface/transformers),
 * MockEmbedder (tests). The engine never depends on a concrete embedder.
 */
export interface Embedder {
  readonly id: string;
  /** Version identifier used for cache invalidation & incremental re-indexing. */
  readonly modelVersion: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Optional warmup (model load). Implementations may no-op. */
  init?(): Promise<void>;
  /** Optional resource cleanup. */
  dispose?(): Promise<void>;
}
