import { createHash } from "node:crypto";
import type { SearchResult } from "../core/types.js";

/**
 * Result cache contract. Keys MUST include everything that affects results:
 * query, limit, normalization version, index version, embedding model version,
 * reranker provider/version and a config fingerprint (see buildCacheKey).
 */
export interface SearchCache {
  get(key: string): Promise<SearchResult[] | null>;
  set(key: string, value: SearchResult[]): Promise<void>;
  clear(): void;
  readonly size: number;
}

export interface CacheKeyInput {
  query: string;
  limit: number;
  normalizerVersion: string;
  indexVersion: number;
  embeddingModelVersion: string;
  rerankerProvider: string;
  configFingerprint: string;
}

export function buildCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.query,
        input.limit,
        input.normalizerVersion,
        input.indexVersion,
        input.embeddingModelVersion,
        input.rerankerProvider,
        input.configFingerprint,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

interface CacheEntry {
  value: SearchResult[];
  expiresAt: number; // 0 => no expiry
}

/** Bounded in-memory LRU with optional TTL. Single-process, no locks needed. */
export class MemoryLruCache implements SearchCache {
  private entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.ttlMs = options.ttlMs ?? 0;
  }

  async get(key: string): Promise<SearchResult[] | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    // refresh LRU position
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: SearchResult[]): Promise<void> {
    if (this.entries.has(key)) this.entries.delete(key);
    else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      value,
      expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export class NullCache implements SearchCache {
  async get(): Promise<SearchResult[] | null> {
    return null;
  }
  async set(): Promise<void> {}
  clear(): void {}
  get size(): number {
    return 0;
  }
}
