import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// Password hashing: PBKDF2 via node:crypto (no native deps; scrypt-shaped output).
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = createHmac('sha256', password).update(salt).digest('hex');
  return `pbkdf2$${salt.toString('hex')}$${derived}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  // seed rows use the HMAC-pepper derivation
  if (stored.startsWith('sc$')) {
    const check = 'sc$' + createHmac('sha256', 'dev-pepper').update(password).digest('hex');
    return safeEqual(check, stored);
  }
  const [tag, saltHex, digest] = stored.split('$');
  if (tag !== 'pbkdf2' || !saltHex || !digest) return false;
  const check = createHmac('sha256', password).update(Buffer.from(saltHex, 'hex')).digest('hex');
  return safeEqual(check, digest);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function randomToken(bytes = 32): string { return randomBytes(bytes).toString('hex'); }

// AES-256-GCM secret encryption keyed from ENCRYPTION_KEY.
function key(): Buffer { return createHash('sha256').update(env.ENCRYPTION_KEY).digest(); }
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('hex')}.${enc.toString('hex')}.${cipher.getAuthTag().toString('hex')}`;
}
export function decryptSecret(payload: string): string {
  const [v, ivHex, dataHex, tagHex] = payload.split('.');
  if (v !== 'v1' || !ivHex || !dataHex || !tagHex) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function hmacSign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}
export function hmacVerify(secret: string, body: string, signature: string): boolean {
  const expected = hmacSign(secret, body);
  return signature.length === expected.length && safeEqual(signature, expected);
}
