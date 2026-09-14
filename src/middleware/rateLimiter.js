
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import redis from 'redis';

const redisClient = redis.createClient({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
});

redisClient.connect();

// General API rate limiter
export const generalLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rate-limit:',
  }),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for auth endpoints
export const authLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rate-limit-auth:',
  }),
  windowMs: 15 * 60 * 1000,
  max: 5, // limit each IP to 5 requests per windowMs
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
});

// API key rate limiting
export const apiKeyLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rate-limit-api:',
  }),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // limit each API key to 1000 requests per hour
  keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
});

// Salesforce API call rate limiting
export const salesforceLimiter = rateLimit({
  store: new RedisStore({
    client: redisClient,
    prefix: 'rate-limit-sf:',
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 25, // Salesforce allows 25 calls per user per minute for some APIs
  keyGenerator: (req) => req.user._id,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Salesforce API rate limit exceeded. Please try again later.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});