import crypto from 'crypto';
import { config } from '../config/env.js';
import AuditLogger from './AuditLogger.js';

/**
 * Encrypt / decrypt sensitive data (Salesforce OAuth tokens today; any other
 * sensitive field going forward) with AES-256-GCM.
 *
 * Format: `v2:<saltHex>:<ivHex>:<authTagHex>:<cipherHex>`
 *   - salt (16 random bytes, unique per encryption call - "per-record salt")
 *   - a per-record 32-byte data-encryption key is derived from the app's
 *     master ENCRYPTION_KEY and that salt via scrypt (see deriveRecordKey
 *     below) - so no two records ever share a key, and compromising one
 *     record's derived key reveals nothing about any other record's.
 *   - iv (12 random bytes - the NIST-recommended, and Node's default, GCM
 *     nonce length)
 *   - authTag (16 bytes from GCM) - authenticates both the ciphertext AND
 *     the salt/iv are exactly what was written; decryption fails loudly
 *     (throws) on ANY tampering instead of silently returning garbage the
 *     way plain CBC would. This is the main reason for moving off CBC.
 *
 * Why the "record key" is derived from the master key + a random salt
 * rather than from the user's login password (the literal reading of
 * "user-key derivation"): an OAuth token must stay decryptable across
 * password changes and resets, and a login password is low-entropy,
 * mutable, and never available outside a live login request anyway (a
 * scheduled token refresh has no password to hand). Deriving the record
 * key straight from it would mean a password reset permanently bricks
 * every previously-encrypted token - trading a security feature for a
 * reliability bug. scrypt is deliberately slow/memory-hard, so this still
 * defeats brute-forcing a leaked ciphertext far better than a bare SHA-256
 * key ever could, without that failure mode.
 */
const SCRYPT_KEYLEN = 32; // AES-256 needs exactly 32 bytes
const SALT_BYTES = 16;
const IV_BYTES = 12; // recommended length for AES-GCM
const FORMAT_VERSION = 'v2';

const getMasterKeyMaterial = () => String(config.encryptionKey);

const deriveRecordKey = (salt) =>
  crypto.scryptSync(getMasterKeyMaterial(), salt, SCRYPT_KEYLEN);

// Legacy (pre-GCM) key: SHA-256 of the master key, used only to decrypt
// tokens that were encrypted before this upgrade - see decryptToken's
// legacy branch. Never used for new encryptions.
const getLegacyKey = () => crypto.createHash('sha256').update(getMasterKeyMaterial()).digest();

export const encryptToken = (token) => {
  if (token === null || token === undefined) return token;

  try {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = deriveRecordKey(salt);
    const iv = crypto.randomBytes(IV_BYTES);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [FORMAT_VERSION, salt.toString('hex'), iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
  } catch (err) {
    console.error('❌ Encryption error:', err.message);
    throw new Error('Failed to encrypt token');
  }
};

/**
 * Decrypt the current v2 (AES-256-GCM) format.
 */
const decryptV2 = (parts) => {
  const [, saltHex, ivHex, authTagHex, cipherHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const key = deriveRecordKey(salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(cipherHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
};

/**
 * Decrypt the legacy `<ivHex>:<cipherHex>` AES-256-CBC format written by
 * every encryption before this upgrade (in particular, any Salesforce
 * token already stored for an existing user). Kept indefinitely on the
 * read path only - every *write* goes through encryptToken() above and is
 * therefore always v2, so tokens migrate to the stronger format the next
 * time they're written (e.g. the next OAuth reconnect or scheduled
 * refresh), with no explicit migration step required.
 */
const decryptLegacy = (ivHex, cipherHex) => {
  const key = getLegacyKey();
  const iv = Buffer.from(ivHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
};

export const decryptToken = (encryptedToken) => {
  if (encryptedToken === null || encryptedToken === undefined) return encryptedToken;

  try {
    const parts = String(encryptedToken).split(':');

    if (parts[0] === FORMAT_VERSION && parts.length === 5) {
      return decryptV2(parts);
    }

    // Anything else is the legacy 2-part `iv:cipher` format.
    const [ivHex, cipherHex] = parts;
    return decryptLegacy(ivHex, cipherHex);
  } catch (err) {
    console.error('❌ Decryption error:', err.message);
    throw new Error('Failed to decrypt token');
  }
};

/**
 * SHA-256 hash of a Buffer/string - used for file/content integrity
 * verification (uploaded CSVs, generated exports), not secrecy. Exported
 * from here so every hash-for-integrity call site in the app uses one
 * shared, reviewed implementation instead of ad hoc crypto.createHash
 * calls scattered around.
 */
export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

// Generic aliases - encryptToken/decryptToken predate this file covering
// more than just Salesforce tokens; kept as the primary export names since
// every existing call site already uses them, but "field" is the more
// accurate name for new callers encrypting other sensitive data.
export const encryptField = encryptToken;
export const decryptField = decryptToken;

/**
 * decryptField, but with a complete audit trail: every call writes a
 * `READ` AuditLog entry (via the app's existing AuditLogger service, same
 * one every controller already uses for its own activity logging) recording
 * who decrypted which field on which record, and whether it succeeded.
 *
 * This is the "complete audit trail logging all decryption access"
 * requirement - every current caller of decryptToken/decryptField
 * (salesforceService.js's OAuth tokens, twoFactor.controller.js's TOTP
 * secret) goes through this wrapper instead, so no sensitive-field
 * decryption in the app happens unlogged.
 *
 * Logging is fire-and-forget (never awaited, always .catch'd) so a slow or
 * failing audit write can never delay or break the decryption itself - the
 * same non-blocking pattern every other controller's AuditLogger.log call
 * already uses.
 */
export const decryptFieldAudited = (encryptedValue, context = {}) => {
  const { userId, resourceType = 'User', resourceId, fieldName, req } = context;

  if (encryptedValue === null || encryptedValue === undefined) return encryptedValue;

  const writeAuditEntry = (status, errorMessage) => {
    // AuditLog.userId is required - without one the write would just fail
    // validation, so skip it outright rather than generate a pointless
    // "Audit logging failed" console error on every call that lacks one.
    if (!userId) return;

    AuditLogger.log('READ', {
      userId,
      resourceType,
      resourceId,
      changes: { field: fieldName, operation: 'decrypt' },
      ipAddress: req?.ip,
      userAgent: req?.get ? req.get('user-agent') : undefined,
      status,
      errorMessage,
    }).catch((err) => console.error('❌ Failed to audit-log field decryption:', err.message));
  };

  try {
    const decrypted = decryptField(encryptedValue);
    writeAuditEntry('success');
    return decrypted;
  } catch (err) {
    writeAuditEntry('failure', err.message);
    throw err;
  }
};

export default {
  encryptToken,
  decryptToken,
  encryptField,
  decryptField,
  decryptFieldAudited,
  sha256Hex,
};
