import { ModelUnavailableError } from "../../core/errors.js";
import type { Embedder } from "./embedder.js";

/**
 * Embedder backed by @huggingface/transformers (ONNX Runtime, CPU) — the
 * optional peer dependency. Loaded lazily via dynamic import so the core
 * package works without it; when missing, a ModelUnavailableError with an
 * actionable remediation is thrown at init time (never a silent no-op).
 *
 * Recommended multilingual/French model: Xenova/multilingual-e5-small (384d).
 */
export interface TransformersEmbedderOptions {
  model: string;
  dimensions: number;
  batchSize: number;
  normalize: boolean;
  /** Cache directory for downloaded ONNX weights. Default: ./.hf-cache */
  cacheDir?: string;
}

interface TransformersPipeline {
  (texts: string[], options?: Record<string, unknown>): Promise<Array<{ data: number[] }>>;
}

export class TransformersEmbedder implements Embedder {
  readonly id = "transformers";
  readonly modelVersion: string;
  readonly dimensions: number;

  private extractor: TransformersPipeline | null = null;
  private loading: Promise<void> | null = null;
  private readonly options: TransformersEmbedderOptions;

  constructor(options: TransformersEmbedderOptions) {
    this.options = options;
    this.dimensions = options.dimensions;
    this.modelVersion = `transformers:${options.model}`;
  }

  async init(): Promise<void> {
    if (this.extractor) return;
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
        `@huggingface/transformers is required for embedding.provider=transformers (model ${this.options.model})`,
        "transformers",
        "npm install @huggingface/transformers",
      );
    }
    if (this.options.cacheDir) {
      // local-only cache, avoids re-downloads between runs
      transformers.env.cacheDir = this.options.cacheDir;
    }
    this.extractor = await transformers.pipeline("feature-extraction", this.options.model, {
      dtype: "q8",
      progress_callback: () => {},
    }) as unknown as TransformersPipeline;
  }

  async embed(text: string): Promise<number[]> {
    await this.init();
    return (await this.embedBatch([text]))[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.init();
    const extractor = this.extractor!;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.options.batchSize) {
      const chunk = texts.slice(i, i + this.options.batchSize);
      const results = await extractor(chunk, { pooling: "mean", normalize: this.options.normalize });
      for (const r of results) {
        if (r.data.length !== this.dimensions) {
          throw new ModelUnavailableError(
            `Embedding model returned ${r.data.length} dimensions but config declares ${this.dimensions}. ` +
              `Update embedding.dimensions to match the model.`,
            "transformers",
          );
        }
        out.push(Array.from(r.data));
      }
    }
    return out;
  }
}
