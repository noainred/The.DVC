/**
 * winrm/ntlm.js — NTLM(NTLMv2) 클라이언트 메시지 계산(순수 · 의존 없음 — node:crypto 만) · 서버 접속 3단계(WinRM HTTPS + NTLM · 설계 docs/design/server-access ④).
 *
 * 왜 직접 구현하나: 서버 의존성(cors · exceljs · express · ldapjs · ssh2 · undici · ws)에 NTLM 이 없고, 이 Node(OpenSSL 3)는 `createHash('md4')` 를
 *   지원하지 않는다(2026-11-19 이 컨테이너 실측 — `digital envelope routines::unsupported`). MD4 는 RFC 1320 그대로 아래에 둔다.
 * 규격: MS-NLMP(NEGOTIATE · CHALLENGE · AUTHENTICATE 메시지 · NTOWFv2 · NTLMv2 응답 · MIC · 채널 바인딩). 시험은 RFC 1320 MD4 벡터와
 *   MS-NLMP 4.2.4 NTLMv2 예시 값(User/Domain/Password)으로 계산을 대조한다 — **실제 Windows 서버로는 아직 확인하지 못했다**(정직 기록 · 설계 README §7).
 *
 * 하는 일만: 비밀번호는 NT 해시로만 쓰고 메시지에 원문을 싣지 않는다 · LM 칸은 규격대로(시각이 있으면 Z(24) · 없으면 LMv2) · NTLMv1 은 쓰지 않는다.
 * 하지 않는 일: 메시지 봉인(Sealing — WinRM HTTP 5985 의 본문 암호화)은 구현하지 않는다 — 이 모듈은 HTTPS(5986) 위에서만 쓴다(TLS 가 본문을 지킨다).
 */
import crypto from 'node:crypto';

/* ── MD4(RFC 1320) ─────────────────────────────────────────────────────── */
function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }
/** RFC 1320 MD4 — Buffer → 16바이트 Buffer. */
export function md4(input) {
  const msg = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const bitLen = msg.length * 8;
  const padLen = ((msg.length + 8) >> 6 << 6) + 64;   // 512비트 배수(길이 8바이트 자리 포함)
  const buf = Buffer.alloc(padLen);
  msg.copy(buf);
  buf[msg.length] = 0x80;
  buf.writeUInt32LE(bitLen >>> 0, padLen - 8);
  buf.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, padLen - 4);
  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  const F = (x, y, z) => (x & y) | (~x & z);
  const G = (x, y, z) => (x & y) | (x & z) | (y & z);
  const H = (x, y, z) => x ^ y ^ z;
  const X = new Array(16);
  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i += 1) X[i] = buf.readUInt32LE(off + i * 4);
    const aa = a, bb = b, cc = c, dd = d;
    const r1 = (p, q, r, s, k, sh) => rotl((p + F(q, r, s) + X[k]) >>> 0, sh);
    const r2 = (p, q, r, s, k, sh) => rotl((p + G(q, r, s) + X[k] + 0x5a827999) >>> 0, sh);
    const r3 = (p, q, r, s, k, sh) => rotl((p + H(q, r, s) + X[k] + 0x6ed9eba1) >>> 0, sh);
    for (const k of [0, 4, 8, 12]) { a = r1(a, b, c, d, k, 3); d = r1(d, a, b, c, k + 1, 7); c = r1(c, d, a, b, k + 2, 11); b = r1(b, c, d, a, k + 3, 19); }
    for (const k of [0, 1, 2, 3]) { a = r2(a, b, c, d, k, 3); d = r2(d, a, b, c, k + 4, 5); c = r2(c, d, a, b, k + 8, 9); b = r2(b, c, d, a, k + 12, 13); }
    for (const k of [0, 2, 1, 3]) { a = r3(a, b, c, d, k, 3); d = r3(d, a, b, c, k + 8, 9); c = r3(c, d, a, b, k + 4, 11); b = r3(b, c, d, a, k + 12, 15); }
    a = (a + aa) >>> 0; b = (b + bb) >>> 0; c = (c + cc) >>> 0; d = (d + dd) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(a, 0); out.writeUInt32LE(b, 4); out.writeUInt32LE(c, 8); out.writeUInt32LE(d, 12);
  return out;
}

const utf16 = (s) => Buffer.from(String(s ?? ''), 'utf16le');
const hmacMd5 = (key, ...parts) => { const h = crypto.createHmac('md5', key); for (const p of parts) h.update(p); return h.digest(); };

/** NTOWFv1 = MD4(UNICODE(Password)). */
export const ntowfv1 = (password) => md4(utf16(password));
/** NTOWFv2 = HMAC_MD5(NTOWFv1, UNICODE(Uppercase(User) + UserDom)). */
export const ntowfv2 = (user, domain, password) => hmacMd5(ntowfv1(password), utf16(String(user || '').toUpperCase() + String(domain || '')));

/* ── 플래그(MS-NLMP 2.2.2.5) ─────────────────────────────────────────── */
export const FLAGS = Object.freeze({
  UNICODE: 0x00000001, REQUEST_TARGET: 0x00000004, SIGN: 0x00000010, SEAL: 0x00000020, NTLM: 0x00000200,
  ALWAYS_SIGN: 0x00008000, EXTENDED_SESSIONSECURITY: 0x00080000, TARGET_INFO: 0x00800000, VERSION: 0x02000000,
  KEY_128: 0x20000000, KEY_EXCH: 0x40000000, KEY_56: 0x80000000,
});
/**
 * 이 클라이언트가 협상하는 플래그 — 봉인(SEAL) · 키 교환(KEY_EXCH)은 청하지 않는다: HTTP 인증 헤더로만 쓰고(메시지 서명 · 봉인 없음) HTTPS 위에서만 쓴다.
 *   키 교환이 없으면 내보내는 세션 키 = 세션 기본 키(MS-NLMP 3.4.5.1) — MIC 는 그 키로 계산한다. RC4 가 필요 없다(OpenSSL 3 legacy 의존 없음).
 */
export const NEGOTIATE_FLAGS = (FLAGS.UNICODE | FLAGS.REQUEST_TARGET | FLAGS.NTLM | FLAGS.ALWAYS_SIGN | FLAGS.EXTENDED_SESSIONSECURITY
  | FLAGS.TARGET_INFO | FLAGS.VERSION | FLAGS.KEY_128) >>> 0;
const SIG = Buffer.from('NTLMSSP\0', 'latin1');
const VERSION = Buffer.from([10, 0, 0x61, 0x4a, 0, 0, 0, 15]);   // 10.0 build 19041 · NTLMSSP_REVISION_W2K3

/** NEGOTIATE_MESSAGE(Type 1) — 도메인 · 워크스테이션 칸은 비운다(서버가 CHALLENGE 에서 대상 정보를 준다). */
export function negotiateMessage(flags = NEGOTIATE_FLAGS) {
  const b = Buffer.alloc(40);
  SIG.copy(b, 0); b.writeUInt32LE(1, 8); b.writeUInt32LE(flags >>> 0, 12);
  // DomainNameFields(16..23) · WorkstationFields(24..31) = 0 · Version(32..39)
  VERSION.copy(b, 32);
  return b;
}

/** AV_PAIR 목록 읽기(MS-NLMP 2.2.2.1). 모양이 틀리면 던진다. */
export function parseAvPairs(buf) {
  const out = [];
  let o = 0;
  while (o + 4 <= buf.length) {
    const id = buf.readUInt16LE(o); const len = buf.readUInt16LE(o + 2);
    if (o + 4 + len > buf.length) throw new Error('NTLM 대상 정보가 잘렸습니다');
    out.push({ id, value: buf.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
    if (id === 0) return out;
  }
  throw new Error('NTLM 대상 정보에 끝 표지(MsvAvEOL)가 없습니다');
}
export function avPairsBuffer(pairs) {
  const parts = [];
  for (const p of pairs) { const h = Buffer.alloc(4); h.writeUInt16LE(p.id, 0); h.writeUInt16LE(p.value.length, 2); parts.push(h, p.value); }
  return Buffer.concat(parts);
}
export const AV = Object.freeze({ EOL: 0, NB_COMPUTER: 1, NB_DOMAIN: 2, DNS_COMPUTER: 3, DNS_DOMAIN: 4, DNS_TREE: 5, FLAGS: 6, TIMESTAMP: 7, SINGLE_HOST: 8, TARGET_NAME: 9, CHANNEL_BINDINGS: 10 });

/**
 * CHALLENGE_MESSAGE(Type 2) 읽기. 서버가 준 값은 신뢰하지 않는다 — 길이 · 오프셋을 검사하고 상한을 둔다.
 * @returns {{flags:number, challenge:Buffer, targetInfo:Buffer, avPairs:object[], timestamp:Buffer|null, targetName:string}}
 */
export function parseChallenge(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32 || buf.length > 8192) throw new Error('NTLM CHALLENGE 길이가 올바르지 않습니다');
  if (!buf.subarray(0, 8).equals(SIG) || buf.readUInt32LE(8) !== 2) throw new Error('NTLM CHALLENGE 가 아닙니다');
  const field = (at) => { const len = buf.readUInt16LE(at); const off = buf.readUInt32LE(at + 4); if (len && (off + len > buf.length)) throw new Error('NTLM CHALLENGE 칸이 메시지 밖을 가리킵니다'); return buf.subarray(off, off + len); };
  const flags = buf.readUInt32LE(20) >>> 0;
  const challenge = Buffer.from(buf.subarray(24, 32));
  const targetName = buf.length >= 20 ? field(12).toString(flags & FLAGS.UNICODE ? 'utf16le' : 'latin1') : '';
  const targetInfo = buf.length >= 48 ? Buffer.from(field(40)) : Buffer.alloc(0);
  if (!(flags & FLAGS.EXTENDED_SESSIONSECURITY) || !(flags & FLAGS.TARGET_INFO) || !targetInfo.length) throw new Error('서버가 NTLMv2(확장 세션 보안 · 대상 정보)를 주지 않았습니다 — NTLMv1 로는 로그인하지 않습니다');
  const avPairs = parseAvPairs(targetInfo);
  const ts = avPairs.find((p) => p.id === AV.TIMESTAMP);
  return { flags, challenge, targetInfo, avPairs, timestamp: ts ? Buffer.from(ts.value) : null, targetName };
}

/** FILETIME(1601-01-01 부터 100ns) 8바이트 LE. */
export function fileTime(ms = Date.now()) {
  const v = (BigInt(Math.floor(ms)) + 11644473600000n) * 10000n;
  const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b;
}

/* ── 채널 바인딩(RFC 5929 tls-server-end-point · MS-NLMP 3.1.5.2.2) ─────────────── */

/** DER TLV 하나(길이 검사 — 서버 인증서는 장비가 준 값이다). */
function tlv(buf, off) {
  if (off + 2 > buf.length) throw new Error('인증서 DER 이 잘렸습니다');
  const tag = buf[off]; let len = buf[off + 1]; let o = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || o + n > buf.length) throw new Error('인증서 DER 길이가 올바르지 않습니다');
    len = 0; for (let i = 0; i < n; i += 1) len = len * 256 + buf[o + i];
    o += n;
  }
  if (o + len > buf.length) throw new Error('인증서 DER 칸이 밖을 가리킵니다');
  return { tag, start: o, end: o + len };
}
function oidText(b) {
  const out = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length && i < 64; i += 1) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { out.push(v); v = 0; } }
  return out.join('.');
}
/** 인증서(DER)의 서명 알고리즘 OID — Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }. */
export function certSignatureOid(der) {
  const cert = tlv(der, 0);
  if (cert.tag !== 0x30) throw new Error('인증서가 SEQUENCE 가 아닙니다');
  const tbs = tlv(der, cert.start);
  const alg = tlv(der, tbs.end);
  const oid = tlv(der, alg.start);
  if (alg.tag !== 0x30 || oid.tag !== 0x06) throw new Error('인증서 서명 알고리즘을 읽지 못했습니다');
  return oidText(der.subarray(oid.start, oid.end));
}
/**
 * RFC 5929 4.1 — 서명이 해시 하나를 쓰고 그것이 MD5 · SHA-1 이 아니면 그 해시, MD5 · SHA-1 이면 SHA-256. 그 밖(Ed25519 · RSASSA-PSS 등 · 모르는 OID)은 null —
 *   호출부는 AUTHENTICATE 를 보내지 않는다(틀린 바인딩으로 보내면 맞는 비밀번호가 거부돼 계정 정지가 걸린다 · v3.26 반증 F2: Node 의 X509Certificate 에 서명 알고리즘 칸이 없어 늘 SHA-256 이었다).
 */
const SIG_HASH = new Map([
  ['1.2.840.113549.1.1.4', 'sha256'], ['1.2.840.113549.1.1.5', 'sha256'], ['1.2.840.113549.1.1.14', 'sha224'], ['1.2.840.113549.1.1.11', 'sha256'], ['1.2.840.113549.1.1.12', 'sha384'], ['1.2.840.113549.1.1.13', 'sha512'],
  ['1.2.840.10045.4.1', 'sha256'], ['1.2.840.10045.4.3.1', 'sha224'], ['1.2.840.10045.4.3.2', 'sha256'], ['1.2.840.10045.4.3.3', 'sha384'], ['1.2.840.10045.4.3.4', 'sha512'],
  ['1.2.840.10040.4.3', 'sha256'], ['2.16.840.1.101.3.4.3.2', 'sha256'],
]);
export function certHashAlg(der) {
  try { return SIG_HASH.get(certSignatureOid(Buffer.from(der))) || null; } catch { return null; }
}
/**
 * 채널 바인딩 값(MsvAvChannelBindings — 16바이트 MD5). 알고리즘을 정할 수 없으면 던진다(보내지 않는다).
 * @param {Buffer} certDer  서버 인증서 DER
 */
export function channelBindingHash(certDer) {
  const alg = certHashAlg(certDer);
  if (!alg) throw new Error('서버 인증서의 서명 알고리즘으로 채널 바인딩 해시를 정할 수 없습니다(RFC 5929) — 보내지 않습니다');
  const appData = Buffer.concat([Buffer.from('tls-server-end-point:', 'latin1'), crypto.createHash(alg).update(certDer).digest()]);
  // gss_channel_bindings_struct: initiator(addrtype 4 + len 4) · acceptor(4 + 4) · application_data(len 4 + data) — 주소는 비운다
  const head = Buffer.alloc(20); head.writeUInt32LE(appData.length, 16);
  return crypto.createHash('md5').update(Buffer.concat([head, appData])).digest();
}

/**
 * NTLMv2 응답 계산(MS-NLMP 3.3.2) — 순수. 시험이 MS-NLMP 4.2.4 예시 값과 대조한다.
 * @returns {{ntProof:Buffer, ntResponse:Buffer, sessionBaseKey:Buffer}}
 */
export function ntlmv2Response({ ntHash, serverChallenge, clientChallenge, timestamp, targetInfo }) {
  // NTLMv2_CLIENT_CHALLENGE: RespType 1 · HiRespType 1 · 예약 6 · 시각 8 · 클라이언트 챌린지 8 · 예약 4 · 대상 정보 · 예약 4
  const temp = Buffer.concat([Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), timestamp, clientChallenge, Buffer.alloc(4), targetInfo, Buffer.alloc(4)]);
  const ntProof = hmacMd5(ntHash, serverChallenge, temp);
  return { ntProof, ntResponse: Buffer.concat([ntProof, temp]), sessionBaseKey: hmacMd5(ntHash, ntProof) };
}

/**
 * AUTHENTICATE_MESSAGE(Type 3) — NTLMv2 응답 + (서버가 시각을 줬으면) MIC + 채널 바인딩. LM 칸은 Z(24) 또는 LMv2(MS-NLMP 3.3.2).
 * @param {{user:string, domain:string, password:string, workstation?:string, negotiate:Buffer, challenge:object, certDer?:Buffer|null,
 *          clientChallenge?:Buffer, now?:number}} o  clientChallenge · now 는 시험용(기본: 무작위 · 지금). challenge 는 readChallenge 결과(raw 포함).
 * @returns {{message:Buffer, sessionKey:Buffer, flags:number}}
 */
export function authenticateMessage({ user, domain, password, workstation = '', negotiate, challenge, certDer = null, clientChallenge, now } = {}) {
  const ch = challenge;
  if (!ch || !Buffer.isBuffer(ch.raw)) throw new Error('readChallenge 결과(원본 포함)가 필요합니다');
  const cc = clientChallenge || crypto.randomBytes(8);
  const ts = ch.timestamp || fileTime(now ?? Date.now());
  // 대상 정보 — 서버 것을 옮기고(EOL 앞) 우리 표지를 더한다: MIC 를 넣었음(MsvAvFlags 0x2) · 채널 바인딩(서버 인증서 — 없으면 0 16바이트)
  const pairs = ch.avPairs.filter((p) => p.id !== AV.EOL && p.id !== AV.FLAGS && p.id !== AV.CHANNEL_BINDINGS);
  const flagsAv = ch.avPairs.find((p) => p.id === AV.FLAGS);
  const withMic = !!ch.timestamp;
  const avFlags = ((flagsAv && flagsAv.value.length >= 4 ? flagsAv.value.readUInt32LE(0) : 0) | (withMic ? 0x2 : 0)) >>> 0;
  if (avFlags) { const v = Buffer.alloc(4); v.writeUInt32LE(avFlags); pairs.push({ id: AV.FLAGS, value: v }); }
  pairs.push({ id: AV.CHANNEL_BINDINGS, value: certDer ? channelBindingHash(certDer) : Buffer.alloc(16) });
  pairs.push({ id: AV.EOL, value: Buffer.alloc(0) });
  const { ntResponse, sessionBaseKey } = ntlmv2Response({ ntHash: ntowfv2(user, domain, password), serverChallenge: ch.challenge, clientChallenge: cc, timestamp: ts, targetInfo: avPairsBuffer(pairs) });
  const flags = (NEGOTIATE_FLAGS & ch.flags) >>> 0;
  // LM 칸(MS-NLMP 3.3.2): 서버가 시각(MsvAvTimestamp)을 줬으면 Z(24) · 아니면 LMv2(HMAC(NTOWFv2, 서버 챌린지 + 클라이언트 챌린지) + 클라이언트 챌린지) — v3.26 반증(빈 칸은 규격 밖)
  const lm = withMic ? Buffer.alloc(24) : Buffer.concat([hmacMd5(ntowfv2(user, domain, password), ch.challenge, cc), cc]);
  const payload = { lm, nt: ntResponse, dom: utf16(domain), user: utf16(user), ws: utf16(workstation), key: Buffer.alloc(0) };
  const HEAD = 88;   // 서명 8 · 종류 4 · 칸 6×8 · 플래그 4 · 버전 8 · MIC 16
  const order = ['lm', 'nt', 'dom', 'user', 'ws', 'key'];
  const fieldAt = { lm: 12, nt: 20, dom: 28, user: 36, ws: 44, key: 52 };
  let off = HEAD;
  const at = {};
  for (const k of order) { at[k] = off; off += payload[k].length; }
  const msg = Buffer.alloc(off);
  SIG.copy(msg, 0); msg.writeUInt32LE(3, 8);
  for (const k of order) { msg.writeUInt16LE(payload[k].length, fieldAt[k]); msg.writeUInt16LE(payload[k].length, fieldAt[k] + 2); msg.writeUInt32LE(at[k], fieldAt[k] + 4); payload[k].copy(msg, at[k]); }
  msg.writeUInt32LE(flags, 60);
  VERSION.copy(msg, 64);
  // MIC = HMAC_MD5(내보내는 세션 키, NEGOTIATE + CHALLENGE + AUTHENTICATE(MIC 칸 0)) — 키 교환이 없으니 세션 기본 키(MS-NLMP 3.1.5.1.2)
  if (withMic) hmacMd5(sessionBaseKey, negotiate, ch.raw, msg).copy(msg, 72);
  return { message: msg, sessionKey: sessionBaseKey, flags };
}

/** CHALLENGE 를 읽어 원본도 함께 둔다(MIC 계산에 원본 메시지가 든다). */
export function readChallenge(buf) { return { ...parseChallenge(buf), raw: Buffer.from(buf) }; }
