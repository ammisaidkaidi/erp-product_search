import type { SearchStore } from "../store/search-store.js";

const INDEX_CONFIG_KEY = "index";

/**
 * Tracks the persisted index version (stored in search_configuration) with an
 * in-memory cache so search requests do not need an extra query. The indexer
 * bumps through this tracker; listeners (engine cache keys) are notified, so a
 * mutation can never serve stale cached results.
 */
export class IndexVersionTracker {
  private cached = 0;
  private loaded = false;
  private listeners = new Set<(version: number) => void>();

  constructor(private readonly store: SearchStore) {}

  /** Last known version (0 if never persisted). Does not hit the store. */
  get(): number {
    return this.cached;
  }

  async refresh(): Promise<number> {
    const value = await this.store.getConfig(INDEX_CONFIG_KEY);
    this.cached =
      value && typeof value === "object" && "version" in value
        ? Number((value as { version: number }).version) || 0
        : 0;
    this.loaded = true;
    return this.cached;
  }

  async bump(): Promise<number> {
    if (!this.loaded) await this.refresh();
    const next = this.cached + 1;
    await this.store.setConfig(INDEX_CONFIG_KEY, {
      version: next,
      updatedAt: new Date().toISOString(),
    });
    this.cached = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  onChange(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
