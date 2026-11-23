import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Time-based one-time codes as used by authenticator apps (RFC 6238: SHA-1, 6 digits, 30 seconds).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function generateSecret(): string {
  let bits = '';
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, '0');
  return (bits.match(/.{5}/g) ?? []).map((chunk) => ALPHABET[parseInt(chunk, 2)]).join('');
}

function decode(secret: string): Buffer {
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const value = ALPHABET.indexOf(char);
    if (value === -1) throw new Error('Invalid secret');
    bits += value.toString(2).padStart(5, '0');
  }
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Returns the time step the code belongs to, or null when it is wrong. Accepts the previous
// and next step too, for clocks that are slightly off, but never a step at or before `lastStep`.
export function verifyCode(secret: string, code: string, lastStep = 0, now = Date.now()): number | null {
  const given = Buffer.from(code.replace(/\s/g, ''));
  if (given.length !== 6) return null;
  const step = currentStep(now);
  for (const candidate of [step, step - 1, step + 1]) {
    if (candidate > lastStep && timingSafeEqual(Buffer.from(codeAt(secret, candidate)), given)) return candidate;
  }
  return null;
}

// What the authenticator app reads from the QR code.
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Backup codes like 'k7m2-9xqp', for when the phone is lost.
export function generateRecoveryCodes(count = 8): string[] {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const pick = [...randomBytes(8)].map((b) => chars[b % chars.length]).join('');
    return `${pick.slice(0, 4)}-${pick.slice(4)}`;
  });
}
