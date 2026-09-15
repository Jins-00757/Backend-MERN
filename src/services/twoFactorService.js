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
 * Render an otpauth:// URL as a scannable QR code data URL (PNG, base64).
 */
export const generateQRCodeDataUrl = (otpauthUrl) => qrcode.toDataURL(otpauthUrl);

/**
 * Verify a 6-digit TOTP code against a base32 secret. window: 1 allows the
 * previous/next 30s step to account for clock drift between the server and
 * the user's device, without opening the window wide enough to make
 * brute-forcing meaningfully easier.
 */
export const verifyTotp = (base32Secret, token) => {
  if (!base32Secret || !token) return false;

  return speakeasy.totp.verify({
    secret: base32Secret,
    encoding: 'base32',
    token: String(token).trim(),
    window: 1,
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
 */
export const consumeBackupCode = (user, submittedCode) => {
  if (!submittedCode || !Array.isArray(user.backupCodes)) return false;

  const hash = sha256Hex(String(submittedCode).trim().toUpperCase());
  const match = user.backupCodes.find((entry) => entry.codeHash === hash && !entry.usedAt);

  if (!match) return false;

  match.usedAt = new Date();
  return true;
};

export default {
  generateSecret,
  generateQRCodeDataUrl,
  verifyTotp,
  generateBackupCodes,
  consumeBackupCode,
};
