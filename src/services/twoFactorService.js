import crypto from 'crypto';
import speakeasy from 'speakeasy';
import qrcode from 'qrcode';

const ISSUER = 'SalesPipelineIntel';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5; // -> 10 hex chars, formatted as XXXXX-XXXXX

/**
 * Generate a new TOTP secret for a user. Returns the base32 secret (stored,
 * encrypted, until confirmed) and the otpauth:// URL used to build the QR
 * code - authenticator apps (Google Authenticator, Authy, 1Password, ...)
 * all understand this URL format.
 */
export const generateSecret = (email) => {
  const secret = speakeasy.generateSecret({
    name: `${ISSUER} (${email})`,
    issuer: ISSUER,
    length: 20,
  });

  return {
    base32: secret.base32,
    otpauthUrl: secret.otpauth_url,
  };
};

/**
 * Rebuild the otpauth:// URL (and thus the QR code) for an *existing*
 * base32 secret - used to re-show the same QR for a setup already in
 * progress, rather than minting a new secret (see setupTwoFactor's
 * reuse-if-pending logic in twoFactor.controller.js).
 */
export const buildOtpauthUrl = (base32, email) =>
  speakeasy.otpauthURL({
    secret: base32,
    label: `${ISSUER} (${email})`,
    issuer: ISSUER,
    encoding: 'base32',
  });

/**
 * Render an otpauth:// URL as a scannable QR code data URL (PNG, base64).
 */
export const generateQRCodeDataUrl = (otpauthUrl) => qrcode.toDataURL(otpauthUrl);

/**
 * Verify a 6-digit TOTP code against a base32 secret.
 *
 * BUG FIX: some authenticator apps (Google Authenticator included, on
 * certain versions/locales) display the code as two groups of 3 digits
 * separated by a space, e.g. "216 662" - a user who selects and copies that
 * display text (rather than typing the digits manually) pastes the space
 * right along with it. `.trim()` only strips leading/trailing whitespace,
 * not an internal one, so a perfectly correct, freshly-copied code was
 * silently rejected every time. Stripping every non-digit character fixes
 * this and is also strictly more forgiving of stray whitespace generally.
 *
 * window: 2 allows the previous/next two 30s steps (~90s of drift either
 * side) to account for clock drift between the server and the user's
 * device, and for the time spent copying/typing the code before it's
 * verified - window: 1 (~30s) was tight enough that a slightly slow phone
 * clock or a few seconds spent typing could roll the code over before
 * submission, rejecting an otherwise-correct code. Still only a few extra
 * valid codes at any moment, nowhere near enough to make brute-forcing the
 * 6-digit space meaningfully easier.
 */
export const verifyTotp = (base32Secret, token) => {
  if (!base32Secret || !token) return false;

  return speakeasy.totp.verify({
    secret: base32Secret,
    encoding: 'base32',
    token: String(token).replace(/\D/g, ''),
    window: 2,
  });
};

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

const formatBackupCode = (buffer) =>
  buffer.toString('hex').toUpperCase().match(/.{1,5}/g).join('-');

/**
 * Generate a fresh set of single-use backup codes. Returns both the raw
 * codes (shown to the user exactly once, never persisted) and their SHA-256
 * hashes (what actually gets stored on the user document).
 */
export const generateBackupCodes = (count = BACKUP_CODE_COUNT) => {
  const raw = Array.from({ length: count }, () =>
    formatBackupCode(crypto.randomBytes(BACKUP_CODE_BYTES))
  );

  const hashed = raw.map((code) => ({ codeHash: sha256Hex(code), usedAt: undefined }));

  return { raw, hashed };
};

/**
 * Check a submitted backup code against a user's stored (hashed) codes and,
 * if it matches an unused one, mark it used. Mutates `user.backupCodes` in
 * place - the caller is responsible for `await user.save()`. Returns true
 * only on a genuine, previously-unused match.
 *
 * Strips every whitespace character (not just leading/trailing) before
 * hashing, same reasoning as verifyTotp above - a code copied from
 * wherever it was saved shouldn't silently fail to match just because it
 * picked up a stray space along the way.
 */
export const consumeBackupCode = (user, submittedCode) => {
  if (!submittedCode || !Array.isArray(user.backupCodes)) return false;

  const hash = sha256Hex(String(submittedCode).replace(/\s+/g, '').toUpperCase());
  const match = user.backupCodes.find((entry) => entry.codeHash === hash && !entry.usedAt);

  if (!match) return false;

  match.usedAt = new Date();
  return true;
};

export default {
  generateSecret,
  buildOtpauthUrl,
  generateQRCodeDataUrl,
  verifyTotp,
  generateBackupCodes,
  consumeBackupCode,
};
