/**
 * test/_sshKeyFixtures.js — 테스트용 SSH 개인키를 **node:crypto 로만** 만든다(CI 러너에 ssh-keygen 이 없다 — 7b단계).
 *  · ed25519 · DSA 는 OpenSSH 형식(openssh-key-v1)으로 직접 조립한다(node 는 그 형식을 내보내지 못한다).
 *  · RSA · EC 는 node 가 내보내는 PEM(PKCS#1 · SEC1 — ssh2 가 읽는 형식).
 * 실제 운영 키가 아니다(매 실행 새로 만든다).
 */
import crypto from 'node:crypto';

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const sshStr = (buf) => { const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'latin1'); return Buffer.concat([u32(b.length), b]); };
const mpint = (buf) => { let b = Buffer.from(buf); let i = 0; while (i < b.length - 1 && b[i] === 0) i += 1; b = b.subarray(i); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return sshStr(b); };
const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function opensshPem(pubBlob, privSection) {
  const check = crypto.randomBytes(4);
  let body = Buffer.concat([check, check, privSection, sshStr('test-comment')]);
  let pad = 1; while (body.length % 8) body = Buffer.concat([body, Buffer.from([pad++])]);
  const all = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sshStr('none'), sshStr('none'), sshStr(''), u32(1), sshStr(pubBlob), sshStr(body)]);
  const b64 = all.toString('base64').replace(/(.{70})/g, '$1\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** ed25519 OpenSSH 개인키 + 기대 지문. */
export function ed25519Key() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const jPriv = privateKey.export({ format: 'jwk' });
  const seed = b64url(jPriv.d); const pub = b64url(jPriv.x);
  const pubBlob = Buffer.concat([sshStr('ssh-ed25519'), sshStr(pub)]);
  const priv = Buffer.concat([sshStr('ssh-ed25519'), sshStr(pub), sshStr(Buffer.concat([seed, pub]))]);
  void publicKey;
  return { pem: opensshPem(pubBlob, priv), fingerprint: `SHA256:${crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}`, pubBlob };
}

/** RSA PKCS#1 PEM(비트 · passphrase 선택). */
export function rsaKey(bits = 3072, passphrase = '') {
  const enc = passphrase ? { cipher: 'aes-128-cbc', passphrase } : {};
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits, privateKeyEncoding: { type: 'pkcs1', format: 'pem', ...enc }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { pem: privateKey };
}

export function ecKey() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return { pem: privateKey };
}

/* DSA — PKCS#8 DER 에서 p · q · g · x 를 꺼내 OpenSSH 'ssh-dss' 로 조립(y = g^x mod p). */
function derRead(buf, p) {
  const tag = buf[p]; let len = buf[p + 1]; let hdr = 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i += 1) len = (len << 8) | buf[p + 2 + i]; hdr = 2 + n; }
  return { tag, start: p + hdr, end: p + hdr + len };
}
function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
const bufToBig = (b) => BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
const bigToBuf = (n) => { let h = n.toString(16); if (h.length % 2) h = `0${h}`; return Buffer.from(h, 'hex'); };
export function dsaKey() {
  const { privateKey } = crypto.generateKeyPairSync('dsa', { modulusLength: 1024, divisorLength: 160 });
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const top = derRead(der, 0);
  const ver = derRead(der, top.start);
  const alg = derRead(der, ver.end);
  const oid = derRead(der, alg.start);
  const params = derRead(der, oid.end);
  const P = derRead(der, params.start); const Q = derRead(der, P.end); const G = derRead(der, Q.end);
  const oct = derRead(der, alg.end);
  const X = derRead(der, oct.start);
  const p = der.subarray(P.start, P.end); const q = der.subarray(Q.start, Q.end); const g = der.subarray(G.start, G.end); const x = der.subarray(X.start, X.end);
  const y = bigToBuf(modPow(bufToBig(g), bufToBig(x), bufToBig(p)));
  const pubBlob = Buffer.concat([sshStr('ssh-dss'), mpint(p), mpint(q), mpint(g), mpint(y)]);
  const priv = Buffer.concat([sshStr('ssh-dss'), mpint(p), mpint(q), mpint(g), mpint(y), mpint(x)]);
  return { pem: opensshPem(pubBlob, priv) };
}

/**
 * 암호화된 ed25519 OpenSSH 개인키(kdf bcrypt · aes256-ctr — `ssh-keygen -t ed25519 -N <pass>` 와 같은 형식). bcrypt 는 ssh2 가 쓰는 bcrypt-pbkdf.
 * 감사 M-5(접속마다 bcrypt 비용) 측정 · 캐시 시험용.
 */
export async function ed25519KeyEncrypted(pass, rounds = 16) {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const bcrypt = require('bcrypt-pbkdf').pbkdf;
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const j = privateKey.export({ format: 'jwk' });
  const seed = b64url(j.d); const pub = b64url(j.x);
  const pubBlob = Buffer.concat([sshStr('ssh-ed25519'), sshStr(pub)]);
  const check = crypto.randomBytes(4);
  let body = Buffer.concat([check, check, sshStr('ssh-ed25519'), sshStr(pub), sshStr(Buffer.concat([seed, pub])), sshStr('enc')]);
  let pad = 1; while (body.length % 16) body = Buffer.concat([body, Buffer.from([pad++])]);
  const salt = crypto.randomBytes(16);
  const out = Buffer.alloc(48);
  const pw = Buffer.from(pass, 'utf8');
  bcrypt(pw, pw.length, salt, salt.length, out, out.length, rounds);
  const c = crypto.createCipheriv('aes-256-ctr', out.subarray(0, 32), out.subarray(32, 48));
  const enc = Buffer.concat([c.update(body), c.final()]);
  const kdfOpts = Buffer.concat([sshStr(salt), u32(rounds)]);
  const all = Buffer.concat([Buffer.from('openssh-key-v1\0', 'latin1'), sshStr('aes256-ctr'), sshStr('bcrypt'), sshStr(kdfOpts), u32(1), sshStr(pubBlob), sshStr(enc)]);
  const b64 = all.toString('base64').replace(/(.{70})/g, '$1\n');
  return { pem: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`, fingerprint: `SHA256:${crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '')}` };
}
