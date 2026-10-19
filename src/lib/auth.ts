import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Booking references like 'GXP-7K3M9Q'; avoids look-alike characters (0/O, 1/I/L).
const REF_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generateReference(): string {
  const bytes = randomBytes(6);
  let ref = '';
  for (const b of bytes) ref += REF_ALPHABET[b % REF_ALPHABET.length];
  return `GXP-${ref}`;
}
