/**
 * util/sshKeyKdf.js — OpenSSH 새 형식 개인키(openssh-key-v1)의 bcrypt KDF **반복 횟수(rounds)** 를 parseKey 전에 읽는다(순수 · 전체 점검 21회차 L-6).
 *
 * 왜: ssh2 의 parseKey 는 패스프레이즈가 있으면 키 안의 rounds(uint32 — 키를 만든 쪽이 정한다)만큼 bcrypt 를 **동기로** 돈다
 *   (실측 16 → 171ms · 64 → 686ms · 256 → 2.7초). rounds 100,000 키 한 장이면 이벤트 루프가 약 17분 멈춘다.
 *   ssh-keygen 기본은 16(-a 로 바꿈 · 흔한 강화값 64~100). 상한을 넘으면 파싱하지 않고 거절한다.
 * ⚠ util/ 규약: 도메인 모듈을 import 하지 않는다.
 */
export const SSH_KDF_ROUNDS_MAX = 128;

/** PEM 문자열 → bcrypt rounds(수) · bcrypt 가 아니거나 새 형식이 아니면 null(검사 대상 아님) · 읽을 수 없으면 null. */
export function opensshKdfRounds(pem) {
  const s = String(pem ?? '');
  const a = s.indexOf('-----BEGIN OPENSSH PRIVATE KEY-----');
  if (a < 0) return null;
  const b = s.indexOf('-----END OPENSSH PRIVATE KEY-----', a);
  if (b < 0) return null;
  const body = s.slice(a + 35, b).replace(/[^A-Za-z0-9+/=]/g, '');
  if (body.length > 64 * 1024) return null;
  let buf;
  try { buf = Buffer.from(body, 'base64'); } catch { return null; }
  const MAGIC = 'openssh-key-v1\0';
  if (buf.length < MAGIC.length || buf.toString('latin1', 0, MAGIC.length) !== MAGIC) return null;
  let off = MAGIC.length;
  const str = () => { if (off + 4 > buf.length) return null; const n = buf.readUInt32BE(off); off += 4; if (off + n > buf.length) return null; const v = buf.subarray(off, off + n); off += n; return v; };
  const cipher = str(); const kdf = str(); const opts = str();
  if (!cipher || !kdf || !opts) return null;
  if (kdf.toString('latin1') !== 'bcrypt') return null;
  if (opts.length < 8) return null;
  const saltLen = opts.readUInt32BE(0);
  if (4 + saltLen + 4 > opts.length) return null;
  return opts.readUInt32BE(4 + saltLen);
}

/** 상한을 넘는 rounds 면 사람이 읽을 사유, 아니면 null. */
export function sshKdfRoundsIssue(pem) {
  const r = opensshKdfRounds(pem);
  if (r == null || r <= SSH_KDF_ROUNDS_MAX) return null;
  return `개인키의 KDF 반복 횟수(${r})가 상한(${SSH_KDF_ROUNDS_MAX})보다 큽니다 — 처리에 오래 걸려 받지 않습니다. ssh-keygen -p -a 16(또는 64) 로 다시 암호화하세요.`;
}
