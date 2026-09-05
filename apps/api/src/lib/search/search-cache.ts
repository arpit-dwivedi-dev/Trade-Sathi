import type { SearchResult } from "../verification/types.js";

/**
 * A small in-process TTL cache for search results.
 *
 * Extracted from the fundamentals verification service so the news-analysis
 * feature can reuse it. Process-local, and subject to the same
 * single-instance constraint as the candle cache — see the operational note
 * in CLAUDE.md.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  value: SearchResult[];
  fetchedAt: number;
}

export class SearchResultCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  async resolve(key: string, load: () => Promise<SearchResult[]>): Promise<SearchResult[]> {
    const entry = this.entries.get(key);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) return entry.value;
    const value = await load();
    this.entries.set(key, { value, fetchedAt: Date.now() });
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
