import crypto from 'crypto';
import { config } from '../config/env.js';
 
/**
 * Encrypt sensitive data (like Salesforce tokens)
 * Uses AES-256-CBC for symmetric encryption
 */
export const encryptToken = (token) => {
  try {
    const key = Buffer.from(config.encryptionKey);
    const iv = crypto.randomBytes(16);
 
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
 
    // Return IV + encrypted data (IV needs to be known for decryption)
    return `${iv.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('Encryption error:', err);
    throw new Error('Failed to encrypt token');
  }
};
 
/**
 * Decrypt sensitive data (like Salesforce tokens)
 */
export const decryptToken = (encryptedToken) => {
  try {
    const key = Buffer.from(config.encryptionKey);
    const [ivHex, encrypted] = encryptedToken.split(':');
    const iv = Buffer.from(ivHex, 'hex');
 
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
 
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err);
    throw new Error('Failed to decrypt token');
  }
};