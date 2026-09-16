
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

// Salesforce CRUD rate limiting (opportunities/accounts/contacts/bulk - see
// salesforce.routes.js). A separate bucket from salesforceLimiter above
// (different Redis key prefix) so interactive features that call this
// router repeatedly in a short burst - e.g. dragging several deals across
// Kanban board columns - don't get throttled by unrelated Analytics/Search
// traffic sharing the same counter, and vice versa. The ceiling is higher
// than salesforceLimiter's because a single legitimate drag-and-drop
// session can easily fire more than 25 requests/minute, but it still caps
// well below Salesforce's own per-org API limits, protecting against a
// runaway client loop or bug from hammering the connected org.
export const salesforceCrudLimiter = rateLimit({
  store: makeStore('rate-limit-sf-crud:'),
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.user._id.toString(),
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many Salesforce requests - please slow down and try again shortly.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

// Sensitive, high-impact operations rate limiting - creating a bulk
// insert/update/upsert/delete job (which can touch thousands of Salesforce
// records in one call, see bulkOperationsController.createBulkJob) and
// generating a data-export download link (see downloadTokenService.js).
// A deliberately low ceiling (5/hour, well under salesforceCrudLimiter's
// 60/minute) separate from every other bucket above - these aren't
// "interactive UI" traffic like dragging Kanban cards, they're the
// operations with the largest blast radius in the app, so they get their
// own tight cap regardless of how much of the general Salesforce quota a
// user has left.
export const sensitiveOperationLimiter = rateLimit({
  store: makeStore('rate-limit-sensitive:'),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) => req.user._id.toString(),
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many sensitive operations (bulk jobs / data exports) this hour - please try again later.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});

// Outbound email sent to an address the user supplies (currently: emailing
// a quote PDF - see quotesController.emailQuotePdf) - still needs its own
// cap so the app can't be used to blast arbitrary mailboxes, but a sales rep
// emailing several quotes to several prospects in one afternoon is normal,
// everyday use, not a "largest blast radius in the app" action. Sharing
// sensitiveOperationLimiter's 5/hour budget with bulk CSV jobs and full-org
// exports meant a couple of ordinary quote emails could exhaust the same
// counter a bulk export needs, and vice versa - two unrelated concerns (spam
// prevention vs. large-blast-radius Salesforce writes) fighting over one
// bucket. This is deliberately more generous and on its own counter.
export const outboundEmailLimiter = rateLimit({
  store: makeStore('rate-limit-email:'),
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  keyGenerator: (req) => req.user._id.toString(),
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many emails sent this hour - please try again later.',
      retryAfter: req.rateLimit.resetTime,
    });
  },
});
