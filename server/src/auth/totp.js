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

/*
 * 보안 잔여 11-27 M3: 시드는 **엄격한 base32** 만 받는다(공백 제거 · 대문자화 뒤 A-Z2-7 + 끝의 '=' 채움). 예전에는 알파벳 밖 글자를 **건너뛰었다** —
 *   봉인 문자열(`enc$1$aes-256-gcm$…`)이 시드 자리에 들어가면(복호 실패 시드는 암호문 그대로 메모리에 남는다 — secretVault 레코드 단위 봉인)
 *   그 안의 A-Z2-7 글자만으로 키가 만들어져, users.json(암호문)을 가진 사람이 유효한 코드를 계산할 수 있었다. auth 의 isSealed 가드와 이중 방어선이다.
 *   정규식은 앵커가 있고 선형이다(ReDoS 아님 — 입력은 저장된 시드). 포탈이 만든 시드(generateSecret — 대문자 B32)는 영향이 없다.
 */
const STRICT_B32 = /^[A-Z2-7]+=*$/;
function strictSecret(secret) {
  const clean = String(secret ?? '').replace(/\s/g, '').toUpperCase();
  return clean.length <= 1024 && STRICT_B32.test(clean) ? clean : null;
}
function base32Decode(secret) {
  const strict = strictSecret(secret);
  if (strict == null) throw new Error('TOTP 시드가 base32 형식이 아닙니다');
  const eq = strict.indexOf('=');
  const clean = eq < 0 ? strict : strict.slice(0, eq);   // 끝의 '=' 채움 — 엄격 판정이 '=' 는 끝에만 허용한다
  let bits = '';
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, '0');
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

/**
 * Verify a user-supplied token against the secret within ±window steps.
 * 반환: 일치한 카운터(정수) 또는 null(불일치). 카운터는 항상 큰 양수라 `if (!verifyToken())`
 * 형태의 기존 부울 호출도 그대로 동작한다. minCounter 이하 카운터의 코드는 재사용(replay) 거부.
 */
export function verifyToken(token, secret, { period = 30, digits = 6, window = 1, minCounter = -Infinity } = {}) {
  if (!secret || !token) return null;
  if (strictSecret(secret) == null) return null;   // 보안 잔여 11-27 M3 — 봉인 문자열 · 알파벳 밖 글자 시드로 코드를 맞추지 않는다
  const clean = String(token).replace(/\s/g, '');
  if (!/^\d{4,8}$/.test(clean)) return null;
  const now = Math.floor(Date.now() / 1000 / period);
  for (let w = -window; w <= window; w++) {
    const ctr = now + w;
    if (ctr <= minCounter) continue; // 이미 사용된(또는 그 이전) 카운터의 코드는 재사용 거부
    const expected = generateToken(secret, { period, digits, counter: ctr });
    // constant-time-ish compare
    if (expected.length === clean.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return ctr;
  }
  return null;
}

/** Build the otpauth:// URI for QR enrollment in an authenticator app. */
export function otpauthURL({ secret, account, issuer, digits = 6, period = 30 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
