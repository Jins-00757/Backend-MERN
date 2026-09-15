import crypto from 'crypto';
import { redisClient } from '../config/redisClient.js';
import { sha256Hex } from './encryptionService.js';

/**
 * Secure, short-lived, single-use download links for generated exports
 * (bulk job results/failed records, dashboard CSV/PDF export).
 *
 * The exported *content* is generated up front and held in Redis alongside
 * the token metadata - re-deriving it from Salesforce on redemption would
 * be simpler, but then the file a user actually downloads could silently
 * differ from what existed the moment they clicked "Export" (records
 * changed/deleted in between); freezing the bytes at creation time and
 * hash-verifying them at redemption catches corruption AND guarantees the
 * download matches what was promised. This holds base64 content in Redis,
 * so it's sized for exports in the tens-of-KB-to-low-MB range this app
 * produces (bulk job results, dashboard summaries) - not arbitrary file
 * hosting.
 *
 * Not built on top of CacheService (services/CacheService.js) deliberately:
 * single-use redemption needs an atomic "read, then delete" so two
 * near-simultaneous requests for the same token can never both succeed
 * (classic TOCTOU race) - and the target Redis here (see config/redisClient.js)
 * predates GETDEL (Redis 6.2+), so that atomicity comes from a small Lua
 * script (EVAL), which CacheService has no reason to expose for its
 * everyday get/set/delete cache use.
 */
const KEY_PREFIX = 'download-token:';
const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour, per the export-security requirement

const GET_AND_DELETE_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

/**
 * Create a download token for a piece of already-generated export content.
 * Returns the raw token (only ever handed to the requesting client - only
 * its SHA-256 hash is stored, the same "never persist the literal secret"
 * pattern used for password-reset/email-verification tokens) plus the
 * content's hash and expiry, for the caller to surface/log.
 */
export const createDownloadToken = async ({ userId, ip, filename, contentType, content }) => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256Hex(rawToken);
  const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const fileHash = sha256Hex(contentBuffer);

  const record = {
    userId: String(userId),
    ip: ip || null,
    filename,
    contentType,
    contentBase64: contentBuffer.toString('base64'),
    fileHash,
    createdAt: Date.now(),
  };

  await redisClient.set(`${KEY_PREFIX}${tokenHash}`, JSON.stringify(record), { EX: TOKEN_TTL_SECONDS });

  return {
    token: rawToken,
    fileHash,
    expiresAt: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000),
  };
};

/**
 * Redeem a download token: single atomic get-and-delete (so a second
 * redemption attempt - replay, or a race with the first - always sees
 * nothing and is rejected), userId ownership check, and a hash
 * re-verification of the content before it's handed back. IP is compared
 * but not enforced as a hard failure by default (mobile/corporate networks
 * routinely change IP mid-session, and hard-failing there would turn a
 * non-issue into a support ticket) - callers get `ipMismatch` back and can
 * decide, and every redemption (match or not) belongs in the audit log
 * regardless.
 */
export const redeemDownloadToken = async (rawToken, { userId, ip }) => {
  if (!rawToken) {
    const err = new Error('Download token is required');
    err.status = 400;
    throw err;
  }

  const tokenHash = sha256Hex(rawToken);
  const key = `${KEY_PREFIX}${tokenHash}`;

  const raw = await redisClient.eval(GET_AND_DELETE_SCRIPT, { keys: [key] });

  if (!raw) {
    const err = new Error('This download link is invalid, has expired, or was already used');
    err.status = 410;
    throw err;
  }

  const record = JSON.parse(raw);

  if (String(record.userId) !== String(userId)) {
    const err = new Error('This download link does not belong to your account');
    err.status = 403;
    throw err;
  }

  const contentBuffer = Buffer.from(record.contentBase64, 'base64');
  const recomputedHash = sha256Hex(contentBuffer);

  if (recomputedHash !== record.fileHash) {
    // Should be unreachable in practice (we just base64-decoded exactly
    // what we base64-encoded), but a failed integrity check must never
    // silently serve the file anyway.
    const err = new Error('Download content failed integrity verification');
    err.status = 500;
    throw err;
  }

  return {
    content: contentBuffer,
    filename: record.filename,
    contentType: record.contentType,
    fileHash: record.fileHash,
    ipMismatch: Boolean(record.ip && ip && record.ip !== ip),
    createdIp: record.ip,
  };
};

export default { createDownloadToken, redeemDownloadToken };
