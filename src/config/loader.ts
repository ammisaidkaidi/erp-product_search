import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ConfigurationError } from "../core/errors.js";
import { DEFAULT_CONFIG, MODE_PRESETS, deepMerge, type DeepPartial, type SearchEngineConfig } from "./schema.js";
import { assertValidConfig } from "./validate.js";

export interface LoadConfigOptions {
  /** Path to a YAML config file. Missing file => defaults (unless required). */
  file?: string;
  /** Programmatic overrides applied last. */
  overrides?: DeepPartial<SearchEngineConfig>;
  /** Fail if the file is missing. Default: false. */
  required?: boolean;
}

/**
 * Load configuration: defaults -> mode preset -> YAML file -> overrides.
 * Env vars (DATABASE_URL, PG*) are already folded into the defaults.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<SearchEngineConfig> {
  let filePatch: DeepPartial<SearchEngineConfig> | undefined;

  if (options.file) {
    try {
      const raw = await readFile(options.file, "utf8");
      const parsed: unknown = parseYaml(raw);
      if (parsed === null || parsed === undefined) {
        filePatch = undefined;
      } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
        filePatch = parsed as DeepPartial<SearchEngineConfig>;
      } else {
        throw new ConfigurationError(`Config file ${options.file} must contain a YAML mapping`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        if (options.required) {
          throw new ConfigurationError(`Config file not found: ${options.file}`);
        }
      } else if (e instanceof ConfigurationError) {
        throw e;
      } else {
        throw new ConfigurationError(`Failed to parse config file ${options.file}: ${(e as Error).message}`);
      }
    }
  }

  // Resolve the mode early so the preset can be applied beneath the file patch.
  const mode = (filePatch?.mode ?? options.overrides?.mode ?? DEFAULT_CONFIG.mode) as SearchEngineConfig["mode"];
  const preset = MODE_PRESETS[mode] ?? {};

  const config = deepMerge(
    deepMerge(DEFAULT_CONFIG, preset),
    deepMerge(filePatch ?? {}, options.overrides ?? {}),
  );

  assertValidConfig(config);
  return config;
}

/** Stable hash of the config subset that affects search results (for cache keys). */
export async function configFingerprint(config: SearchEngineConfig): Promise<string> {
  const { createHash } = await import("node:crypto");
  const relevant = {
    search: config.search,
    retrieval: config.retrieval,
    fusion: config.fusion,
    ranking: config.ranking,
    embedding: { provider: config.embedding.provider, modelVersion: config.embedding.modelVersion, dimensions: config.embedding.dimensions, normalize: config.embedding.normalize },
    reranking: {
      enabled: config.reranking.enabled,
      provider: config.reranking.provider,
      candidateLimit: config.reranking.candidateLimit,
      fallback: config.reranking.fallback,
    },
    normalization: {
      enabled: config.normalization.enabled,
      provider: config.normalization.provider,
      language: config.normalization.language,
      typo: config.normalization.typo,
    },
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 16);
}
