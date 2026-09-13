
/**
 * CacheService - In-memory caching with TTL
 * In production, use Redis for distributed caching
 */
class CacheService {
  constructor() {
    this.cache = new Map();
    this.ttls = new Map();
  }

  /**
   * Set cache value with TTL (in seconds)
   */
  set(key, value, ttl = 300) {
    this.cache.set(key, value);

    // Clear existing TTL
    if (this.ttls.has(key)) {
      clearTimeout(this.ttls.get(key));
    }

    // Set new TTL
    if (ttl) {
      const timeout = setTimeout(() => {
        this.cache.delete(key);
        this.ttls.delete(key);
      }, ttl * 1000);

      this.ttls.set(key, timeout);
    }
  }

  /**
   * Get cached value
   */
  get(key) {
    return this.cache.get(key) || null;
  }

  /**
   * Check if key exists in cache
   */
  has(key) {
    return this.cache.has(key);
  }

  /**
   * Delete cache entry
   */
  delete(key) {
    if (this.ttls.has(key)) {
      clearTimeout(this.ttls.get(key));
      this.ttls.delete(key);
    }
    return this.cache.delete(key);
  }

  /**
   * Delete every cached entry whose key starts with `prefix`. List endpoints
   * cache under keys that include query params (limit/offset/search/...), so
   * invalidating after a create/update/delete has to sweep by prefix rather
   * than delete a single exact key that was never actually stored.
   */
  deleteByPrefix(prefix) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.delete(key);
      }
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    this.ttls.forEach((timeout) => clearTimeout(timeout));
    this.cache.clear();
    this.ttls.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}

// Singleton instance
const cacheService = new CacheService();

export default cacheService;