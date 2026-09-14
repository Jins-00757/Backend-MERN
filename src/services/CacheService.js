
import { redisClient } from '../config/redisClient.js';

// All keys live under this namespace so CacheService.clear() can safely wipe
// just its own keys with SCAN+DEL instead of FLUSHDB - the same Redis
// database also holds rate limiter counters (see middleware/rateLimiter.js)
// that must never be touched by a cache clear.
const NAMESPACE = 'cache:';
const namespaced = (key) => `${NAMESPACE}${key}`;

/**
 * CacheService - Redis-backed caching with TTL, shared across app instances.
 */
class CacheService {
  /**
   * Set cache value with TTL (in seconds)
   */
  async set(key, value, ttl = 300) {
    const serialized = JSON.stringify(value);
    if (ttl) {
      await redisClient.set(namespaced(key), serialized, { EX: ttl });
    } else {
      await redisClient.set(namespaced(key), serialized);
    }
  }

  /**
   * Get cached value
   */
  async get(key) {
    const value = await redisClient.get(namespaced(key));
    return value ? JSON.parse(value) : null;
  }

  /**
   * Check if key exists in cache
   */
  async has(key) {
    return (await redisClient.exists(namespaced(key))) === 1;
  }

  /**
   * Delete cache entry
   */
  async delete(key) {
    return (await redisClient.del(namespaced(key))) > 0;
  }

  /**
   * Delete every cached entry whose key starts with `prefix`. List endpoints
   * cache under keys that include query params (limit/offset/search/...), so
   * invalidating after a create/update/delete has to sweep by prefix rather
   * than delete a single exact key that was never actually stored.
   */
  async deleteByPrefix(prefix) {
    let cursor = '0';
    do {
      const reply = await redisClient.scan(cursor, {
        MATCH: `${namespaced(prefix)}*`,
        COUNT: 100,
      });
      cursor = reply.cursor;
      if (reply.keys.length > 0) {
        await redisClient.del(reply.keys);
      }
    } while (cursor !== '0');
  }

  /**
   * Clear all cache entries (only this service's namespace, never the whole
   * Redis database - rate limiter counters live in the same instance).
   */
  async clear() {
    await this.deleteByPrefix('');
  }

  /**
   * Get cache statistics
   */
  async getStats() {
    const keys = [];
    let cursor = '0';
    do {
      const reply = await redisClient.scan(cursor, {
        MATCH: `${NAMESPACE}*`,
        COUNT: 100,
      });
      cursor = reply.cursor;
      keys.push(...reply.keys.map((k) => k.slice(NAMESPACE.length)));
    } while (cursor !== '0');
    return { size: keys.length, keys };
  }
}

// Singleton instance
const cacheService = new CacheService();

export default cacheService;
