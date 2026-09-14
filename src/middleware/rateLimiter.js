
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient, connectRedis } from '../config/redisClient.js';

// RedisStore loads a Lua script synchronously as soon as it's constructed,
// so the client must already be connected by the time makeStore() runs
// below - awaiting it here (rather than the fire-and-forget connect in
// app.js) blocks this module, and everything that imports it, until the
// connection is ready.
await connectRedis();

// rate-limit-redis v3 talks to node-redis v4's client via sendCommand rather
// than holding its own connection, so every limiter below shares the one
// connection opened in config/redisClient.js.
const makeStore = (prefix) =>
  new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix,
  });

// General API rate limiter
export const generalLimiter = rateLimit({
  store: makeStore('rate-limit:'),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for auth endpoints
export const authLimiter = rateLimit({
  store: makeStore('rate-limit-auth:'),
  windowMs: 15 * 60 * 1000,
  max: 5, // limit each IP to 5 requests per windowMs
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// API key rate limiting
export const apiKeyLimiter = rateLimit({
  store: makeStore('rate-limit-api:'),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // limit each API key to 1000 requests per hour
  keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
});

// Salesforce API call rate limiting
export const salesforceLimiter = rateLimit({
  store: makeStore('rate-limit-sf:'),
  windowMs: 60 * 1000, // 1 minute
  max: 25, // Salesforce allows 25 calls per user per minute for some APIs
  keyGenerator: (req) => req.user._id.toString(),
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Salesforce API rate limit exceeded. Please try again later.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});
