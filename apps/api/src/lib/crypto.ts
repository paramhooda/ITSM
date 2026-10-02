import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { config } from '@/config';

const key = createHash('sha256').update(config.ENCRYPTION_KEY).digest();

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** AES-256-GCM for secrets at rest (SNMP communities, SMTP passwords in config, ...). */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([iv, tag, enc]).toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!value?.startsWith('enc:v1:')) return value;
  const buf = Buffer.from(value.slice(7), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export const isEncrypted = (v: unknown) => typeof v === 'string' && v.startsWith('enc:v1:');
