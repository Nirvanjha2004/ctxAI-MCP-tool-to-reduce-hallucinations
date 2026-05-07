export interface CacheEntry {
  fingerprint: string;
  timestamp: number;
}

// 5 minutes in milliseconds
const TTL_MS = 5 * 60 * 1000;

class SessionCache {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Retrieves a cached fingerprint if it exists and hasn't expired.
   */
  get(projectPath: string): string | null {
    const entry = this.cache.get(projectPath);
    
    if (!entry) {
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > TTL_MS) {
      // Cache entry is stale; purge it
      this.cache.delete(projectPath);
      return null;
    }

    return entry.fingerprint;
  }

  /**
   * Stores a new fingerprint with the current timestamp.
   */
  set(projectPath: string, fingerprint: string): void {
    this.cache.set(projectPath, {
      fingerprint,
      timestamp: Date.now(),
    });
  }

  /**
   * Manual clear for testing or session resets.
   */
  clear(): void {
    this.cache.clear();
  }
}

// Export a singleton instance
export const sessionCache = new SessionCache();