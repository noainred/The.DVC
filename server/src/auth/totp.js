/**
 * Time-based One-Time Password (TOTP, RFC 6238) — compatible with Google
 * Authenticator / Microsoft Authenticator / Authy. Pure Node crypto, no deps
 * (important for the air-gapped Rocky 9 deployment).
 *
 * Defaults: 6 digits, 30s period, HMAC-SHA1, ±1 step verification window.
 */

import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 base32 alphabet

/** Generate a random base32 secret (default 20 bytes → 32 chars). */
export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret) {
  const clean = String(secret).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** Compute the TOTP code for a given counter (defaults to the current step). */
export function generateToken(secret, { period = 30, digits = 6, counter } = {}) {
  const key = base32Decode(secret);
  const ctr = counter ?? Math.floor(Date.now() / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(ctr));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Verify a user-supplied token against the secret within ±window steps. */
export function verifyToken(token, secret, { period = 30, digits = 6, window = 1 } = {}) {
  if (!secret || !token) return false;
  const clean = String(token).replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(clean)) return false;
  const now = Math.floor(Date.now() / 1000 / period);
  for (let w = -window; w <= window; w++) {
    const expected = generateToken(secret, { period, digits, counter: now + w });
    // constant-time-ish compare
    if (expected.length === clean.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** Build the otpauth:// URI for QR enrollment in an authenticator app. */
export function otpauthURL({ secret, account, issuer, digits = 6, period = 30 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
