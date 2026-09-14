import { createClient } from 'redis';
import { config } from './env.js';

/**
 * Single shared Redis connection, reused by both the rate limiter
 * (middleware/rateLimiter.js) and the cache service (services/CacheService.js)
 * rather than opening a separate socket for each.
 */
export const redisClient = createClient({
  socket: {
    host: config.redisHost,
    port: config.redisPort,
    connectTimeout: 5000, // fail fast on startup if Redis isn't reachable
  },
  // The node-redis v4+ client negotiates RESP3 via a HELLO command by
  // default. The local dev Redis server (tools/redis, based on Redis 5.0)
  // predates RESP3 and doesn't understand HELLO at all, so force the
  // original RESP2 protocol instead.
  RESP: 2,
});

// The redis v4+ client throws if an 'error' event has no listener, which
// would otherwise crash the process (via unhandledRejection -> process.exit
// in server.js) on every transient connection blip.
redisClient.on('error', (err) => {
  console.error('❌ Redis client error:', err.message);
});

let connectPromise = null;

/**
 * Connect once and cache the in-flight/resolved promise so callers (app.js,
 * CacheService, rateLimiter) can all await the same connection attempt
 * instead of racing separate connect() calls.
 */
export const connectRedis = () => {
  if (!connectPromise) {
    connectPromise = redisClient
      .connect()
      .then(() => {
        console.log(`✅ Redis connected (${config.redisHost}:${config.redisPort})`);
      })
      .catch((error) => {
        console.error(`❌ Redis connection failed: ${error.message}`);
        connectPromise = null; // allow a later retry instead of caching the failure forever
        throw error;
      });
  }
  return connectPromise;
};
