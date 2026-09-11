import crypto from 'crypto';
import { config } from '../config/env.js';

/**
 * Encrypt / decrypt sensitive data (Salesforce tokens) with AES-256-CBC.
 *
 * The configured ENCRYPTION_KEY is hashed down to a fixed 32-byte key via
 * SHA-256 rather than used verbatim - AES-256 requires exactly a 32-byte
 * key, and relying on the raw string being exactly 32 characters is fragile
 * (createCipheriv throws "Invalid key length" otherwise).
 */
const getKey = () => crypto.createHash('sha256').update(String(config.encryptionKey)).digest();

export const encryptToken = (token) => {
  try {
    const key = getKey();
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Return IV + encrypted data (IV needs to be known for decryption)
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('❌ Encryption error:', err.message);
    throw new Error('Failed to encrypt token');
  }
};

export const decryptToken = (encryptedToken) => {
  try {
    const key = getKey();
    const [ivHex, encrypted] = encryptedToken.split(':');
    const iv = Buffer.from(ivHex, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error('❌ Decryption error:', err.message);
    throw new Error('Failed to decrypt token');
  }
};

export default { encryptToken, decryptToken };
