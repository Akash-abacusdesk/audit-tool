import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM secretbox for provider tokens at rest (S3-D1B).
 * Key comes from GIT_CREDENTIALS_KEY (64 hex chars = 32 bytes). Zero deps.
 * Ciphertext layout: base64( iv(12) | authTag(16) | data ).
 */
const KEY_ENV = 'GIT_CREDENTIALS_KEY';

export function loadCredentialsKey(keyHex?: string): Buffer {
  const hex = keyHex ?? process.env[KEY_ENV] ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${KEY_ENV} must be 64 hex chars (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

/** Returns null on tamper/auth failure — callers treat as "no usable token". */
export function decryptToken(ciphertext: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(ciphertext, 'base64');
    if (raw.length < 12 + 16) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
