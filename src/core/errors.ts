/** Structured error hierarchy for the search engine. */

export class SearchError extends Error {
  override readonly cause?: unknown;

  constructor(
    message: string,
    public readonly code: string,
    public readonly stage?: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SearchError";
    this.cause = cause;
  }
}

/** Invalid usage (bad arguments, invalid config values). */
export class ConfigurationError extends SearchError {
  constructor(message: string, public readonly path?: string) {
    super(message, "CONFIGURATION_ERROR", "config");
    this.name = "ConfigurationError";
  }
}

/** A model provider (embedder, reranker, LLM) is not installed / not reachable. */
export class ModelUnavailableError extends SearchError {
  /** Provider id (von / cross-encoder / transformers / python-worker...). */
  public readonly provider: string;
  public readonly remediation?: string;

  constructor(message: string, provider: string, remediation?: string, cause?: unknown) {
    super(message, "MODEL_UNAVAILABLE", "model", cause);
    this.name = "ModelUnavailableError";
    this.provider = provider;
    this.remediation = remediation;
  }
}

/** A model provider failed while processing a request. */
export class ModelInferenceError extends SearchError {
  constructor(message: string, public readonly provider: string, cause?: unknown) {
    super(message, "MODEL_INFERENCE_ERROR", "model", cause);
    this.name = "ModelInferenceError";
  }
}

/** Storage (PostgreSQL) failure. */
export class StoreError extends SearchError {
  constructor(message: string, cause?: unknown) {
    super(message, "STORE_ERROR", "store", cause);
    this.name = "StoreError";
  }
}

export function isSearchError(e: unknown): e is SearchError {
  return e instanceof SearchError;
}

export function errorSummary(e: unknown): { name: string; message: string; code?: string } {
  if (e instanceof Error) {
    return {
      name: e.name,
      message: e.message,
      code: isSearchError(e) ? e.code : undefined,
    };
  }
  return { name: typeof e, message: String(e) };
}
