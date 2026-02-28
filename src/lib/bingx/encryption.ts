import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error(
      'ENCRYPTION_KEY must be set in env with at least 32 characters (32-byte hex or base64)'
    );
  }
  // Support hex or base64
  if (/^[0-9a-fA-F]+$/.test(key) && key.length >= 64) {
    return Buffer.from(key.slice(0, 64), 'hex');
  }
  return Buffer.from(key, 'base64').slice(0, KEY_LENGTH);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Output format: salt (hex) + iv (hex) + authTag (hex) + ciphertext (base64)
 */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('base64')].join(':');
}

/**
 * Decrypt ciphertext produced by encryptSecret.
 */
export function decryptSecret(encryptedPayload: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, cipherBase64] = encryptedPayload.split(':');
  if (!ivHex || !authTagHex || !cipherBase64) {
    throw new Error('Invalid encrypted payload format');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(cipherBase64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}
