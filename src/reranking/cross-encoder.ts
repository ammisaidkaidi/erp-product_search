import type { CrossEncoderConfig } from "../config/schema.js";
import { ModelUnavailableError } from "../core/errors.js";
import type { NormalizedQuery, RankedResult, SearchCandidate } from "../core/types.js";
import type { Reranker } from "./interfaces.js";

/**
 * Cross-encoder reranker via @huggingface/transformers (ONNX Runtime, CPU).
 *
 * BGE, MiniLM and mxbai-rerank are all just model ids here — the benchmark
 * compares them on identical candidate sets:
 *
 *   search-index evaluate --reranker cross-encoder \
 *     --reranker-model mixedbread-ai/mxbai-rerank-xsmall-multilingual-v1
 *   search-index evaluate --reranker cross-encoder \
 *     --reranker-model Xenova/bge-reranker-base
 *
 * The package is an OPTIONAL peer dependency: when missing, init() throws
 * ModelUnavailableError with the install remediation and the fallback chain
 * takes over (logged).
 */
interface ClassificationOutput {
  label: string;
  score: number;
}

interface ClassificationPipeline {
  (inputs: Array<{ text: string; text_pair: string }>): Promise<ClassificationOutput[]>;
  dispose?(): Promise<void>;
}

export class CrossEncoderReranker implements Reranker {
  readonly provider = "cross-encoder";
  readonly version: string;

  private pipeline: ClassificationPipeline | null = null;
  private loading: Promise<void> | null = null;
  private readonly config: CrossEncoderConfig;
  private readonly cacheDir?: string;

  constructor(config: CrossEncoderConfig, options: { cacheDir?: string } = {}) {
    this.config = config;
    this.cacheDir = options.cacheDir;
    this.version = `cross-encoder:${config.model}`;
  }

  async init(): Promise<void> {
    if (this.pipeline) return;
    if (!this.loading) {
      this.loading = this.load().catch((e) => {
        this.loading = null;
        throw e;
      });
    }
    await this.loading;
  }

  private async load(): Promise<void> {
    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch {
      throw new ModelUnavailableError(
        `@huggingface/transformers is required for reranking.provider=cross-encoder (model ${this.config.model})`,
        "cross-encoder",
        "npm install @huggingface/transformers",
      );
    }
    if (this.cacheDir) {
      transformers.env.cacheDir = this.cacheDir;
    }
    const pipeline = await transformers.pipeline("text-classification", this.config.model, {
      dtype: this.config.dtype as "q8" | "fp32" | undefined,
    });
    this.pipeline = pipeline as unknown as ClassificationPipeline;
  }

  async rank(query: NormalizedQuery, candidates: SearchCandidate[]): Promise<RankedResult[]> {
    if (candidates.length === 0) return [];
    await this.init();
    const pipeline = this.pipeline!;

    const pairs = candidates.map((c) => ({
      text: query.normalized.slice(0, this.config.maxTextLength),
      text_pair: c.product.searchDocument.slice(0, this.config.maxTextLength),
    }));

    const scores = new Map<string, number>();
    const batchSize = Math.max(1, this.config.batchSize);
    for (let i = 0; i < pairs.length; i += batchSize) {
      const chunk = pairs.slice(i, i + batchSize);
      const outputs = await pipeline(chunk);
      for (let j = 0; j < chunk.length; j++) {
        const candidate = candidates[i + j]!;
        const output = outputs[j];
        // reranker checkpoints expose the relevance probability on LABEL_0
        // (single-logit models) or the last label (2-class softmax)
        const score = output ? clamp01(output.score) : 0;
        scores.set(candidate.product.productId, score);
      }
    }

    return candidates.map((candidate) => ({
      candidate,
      score: scores.get(candidate.product.productId) ?? 0,
      provider: this.provider,
    }));
  }

  async dispose(): Promise<void> {
    await this.pipeline?.dispose?.();
    this.pipeline = null;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
