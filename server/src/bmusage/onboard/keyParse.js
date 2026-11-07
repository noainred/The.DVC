/**
 * bmusage/onboard/keyParse.js — SSH 개인키 판정(순수 · 7b단계 SSH 키 저장소 · 설계 PROFILES §18 · §19).
 *
 * 등록할 때 **키를 직접 읽어** 종류 · 비트 · 지문(SHA256) · 공개키를 만든다 — 사람이 적은 종류 · 지문을 믿지 않는다.
 *  · 파서는 ssh2(`utils.parseKey` — 접속에 쓰는 바로 그 라이브러리)다. 새 의존성 없음. OpenSSH(openssh-key-v1) · PEM(PKCS#1 RSA · SEC1 EC)을 읽는다.
 *    ⚠ PKCS#8 PEM(`BEGIN PRIVATE KEY`)은 ssh2 가 읽지 못한다 — 접속도 못 하므로 등록에서 거부한다(형식 안내).
 *  · 정책(§19): ed25519 권장 · ECDSA 허용 · RSA 2048 비트 미만 거부 · DSA(ssh-dss) 거부 · 공개키만 준 것 거부 · 형식 오류 거부 ·
 *    암호화 키는 passphrase 로 실제로 풀려야 한다(틀리면 거부 — 저장 뒤 접속 때 알게 되면 늦다).
 *  · 지문 공식은 호스트키 지문과 같은 하나(`proxy/sshExec.js sshHostKeyFingerprint` — OpenSSH `ssh-keygen -lf` 표기).
 *  · 반환값에 **개인키 · passphrase 를 싣지 않는다**(호출부가 원문을 따로 들고 봉인한다).
 */
import ssh2 from 'ssh2';
import { sshHostKeyFingerprint } from '../../proxy/sshExec.js';

/** 개인키 원문 상한 — RSA 16384 비트 PEM 도 13KB 안이다. 그 이상은 키가 아니다(정규식 · 파서 입력 상한). */
export const KEY_TEXT_MAX = 16 * 1024;
export const PASSPHRASE_MAX = 1024;
export const RSA_MIN_BITS = 2048;

/** 화면 문구 — 판정 code 하나에 문구 하나(웹은 code 만 보고 이 문구를 그대로 싣는다). */
export const KEY_REJECT = Object.freeze({
  empty: '개인키가 비어 있습니다.',
  'too-long': `개인키가 너무 깁니다(${KEY_TEXT_MAX / 1024}KB 초과 — 키 파일 하나만 붙여 넣으세요).`,
  'public-only': '공개키만 들어 있습니다 — 개인키(BEGIN ... PRIVATE KEY 블록)를 넣으세요. 공개키는 개인키에서 자동으로 만듭니다.',
  'need-passphrase': '암호화된 개인키입니다 — passphrase 를 함께 입력하세요.',
  'bad-passphrase': 'passphrase 로 개인키를 풀지 못했습니다(틀린 passphrase 이거나 손상된 키).',
  'weak-dsa': 'DSA(ssh-dss) 키는 등록할 수 없습니다 — OpenSSH 7.0 부터 기본 비활성인 약한 알고리즘입니다. ed25519 키를 쓰세요.',
  'weak-rsa': `RSA 키는 ${RSA_MIN_BITS} 비트 이상만 등록합니다 — ed25519(권장) 또는 RSA 3072 비트 이상으로 새로 만드세요.`,
  'unsupported-format': '읽을 수 없는 키 형식입니다 — OpenSSH 형식(BEGIN OPENSSH PRIVATE KEY) 또는 PEM(BEGIN RSA/EC PRIVATE KEY)만 받습니다. PKCS#8(BEGIN PRIVATE KEY)은 ‘ssh-keygen -p -f 키파일’ 로 다시 저장하면 OpenSSH 형식이 됩니다(OpenSSH 7.8 이상 기본 형식).',
  'unsupported-type': '지원하지 않는 키 종류입니다(ed25519 · ecdsa · rsa 만).',
  'multi-key': '키가 여러 개 들어 있습니다 — 하나만 넣으세요.',
});

/** ssh2 키 종류 → 표시 종류. 모르면 ''(허용하지 않는다). */
function algoOf(type) {
  const s = String(type || '');
  if (s === 'ssh-ed25519') return 'ed25519';
  if (s === 'ssh-rsa') return 'rsa';
  if (s === 'ssh-dss') return 'dsa';
  if (/^ecdsa-sha2-nistp(256|384|521)$/.test(s)) return 'ecdsa';
  return '';
}

/** SSH wire 공개키 blob 에서 RSA 모듈러스 비트 수(string 'ssh-rsa' · mpint e · mpint n). 못 읽으면 null. */
export function rsaBitsOfBlob(blob) {
  if (!Buffer.isBuffer(blob)) return null;
  let p = 0;
  const str = () => {
    if (p + 4 > blob.length) return null;
    const len = blob.readUInt32BE(p); p += 4;
    if (len > blob.length - p) return null;
    const v = blob.subarray(p, p + len); p += len;
    return v;
  };
  const name = str(); if (!name || name.toString('latin1') !== 'ssh-rsa') return null;
  if (!str()) return null;                   // e
  const n = str(); if (!n || !n.length) return null;
  let i = 0; while (i < n.length && n[i] === 0) i += 1;   // mpint 앞의 0 바이트(부호)는 비트가 아니다
  if (i >= n.length) return null;
  return (n.length - i - 1) * 8 + (32 - Math.clz32(n[i]));
}

/** ECDSA 곡선 비트(이름에서). */
const ecBits = (type) => { const m = /nistp(\d+)$/.exec(String(type || '')); return m ? Number(m[1]) : null; };

/**
 * 개인키 판정.
 * @param {string} text        개인키 원문
 * @param {string} [passphrase]
 * @returns {{ok:true, algo:string, sshType:string, bits:number|null, fingerprint:string, publicKey:string, encrypted:boolean, recommended:boolean}
 *          | {ok:false, code:string, reason:string}}
 */
export function parsePrivateKey(text, passphrase = '') {
  const raw = typeof text === 'string' ? text : '';
  const no = (code) => ({ ok: false, code, reason: KEY_REJECT[code] || KEY_REJECT['unsupported-format'] });
  if (!raw.trim()) return no('empty');
  if (raw.length > KEY_TEXT_MAX) return no('too-long');
  const pass = typeof passphrase === 'string' ? passphrase.slice(0, PASSPHRASE_MAX) : '';
  if (!/PRIVATE KEY-----/.test(raw)) {
    // 공개키 한 줄(ssh-ed25519 AAAA…)은 ssh2 가 '공개키' 로 읽는다 — 개인키가 아니라고 먼저 말한다.
    return /^\s*(ssh-(ed25519|rsa|dss)|ecdsa-sha2-)/.test(raw) ? no('public-only') : no('unsupported-format');
  }
  if ((raw.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g) || []).length > 1) return no('multi-key');
  let parsed;
  try { parsed = ssh2.utils.parseKey(raw, pass || undefined); } catch (e) { parsed = e instanceof Error ? e : new Error(String(e)); }
  if (parsed instanceof Error) {
    const m = String(parsed.message || '');
    if (/no passphrase given/i.test(m)) return no('need-passphrase');
    if (/passphrase|decrypt|bad decrypt/i.test(m)) return no('bad-passphrase');
    return no('unsupported-format');
  }
  if (Array.isArray(parsed)) { if (parsed.length !== 1) return no('multi-key'); parsed = parsed[0]; }
  if (!parsed || typeof parsed.isPrivateKey !== 'function' || !parsed.isPrivateKey()) return no('public-only');
  const sshType = String(parsed.type || '');
  const algo = algoOf(sshType);
  if (algo === 'dsa') return no('weak-dsa');
  if (!algo) return no('unsupported-type');
  let blob = null;
  try { blob = parsed.getPublicSSH(); } catch { blob = null; }
  if (!Buffer.isBuffer(blob) || !blob.length) return no('unsupported-format');
  const bits = algo === 'rsa' ? rsaBitsOfBlob(blob) : algo === 'ecdsa' ? ecBits(sshType) : algo === 'ed25519' ? 256 : null;
  if (algo === 'rsa' && (bits == null || bits < RSA_MIN_BITS)) return no('weak-rsa');
  const fingerprint = sshHostKeyFingerprint(blob);
  if (!fingerprint) return no('unsupported-format');
  return {
    ok: true, algo, sshType, bits, fingerprint,
    // 공개키는 authorized_keys 한 줄 꼴(설명 칸 없이 — 키 파일의 주석은 사람 이름 · 호스트가 실리기 쉬워 싣지 않는다).
    publicKey: `${sshType} ${blob.toString('base64')}`,
    encrypted: !!pass,
    recommended: algo === 'ed25519',
  };
}

/**
 * CSV/Excel 칸에 **비밀 원문**이 들어 있는가(순수 · 판정만 — 값은 돌려주지 않는다). 그 행은 거부한다(§18 '비밀은 파일에 넣지 않는다').
 *  · 개인키 · 공개키 블록 · OpenSSH 키 한 줄 · `password=` / `passwd:` / `pw=` 꼴 · 긴 base64 덩어리(키 본문 조각).
 *  ⚠ 입력은 먼저 자른다(정규식 입력 상한 — 외부 입력 ReDoS 규약). 앵커 없는 무제한 반복을 쓰지 않는다.
 */
export function cellLooksSecret(v) {
  const s = String(v ?? '').slice(0, 4096);
  if (!s) return false;
  // 키 블록 머리 — 대소문자 무시(7b 반증 F11: 소문자 머리글이 지나갔다) · PuTTY ppk 머리 · Private-Lines
  if (/-----begin [a-z0-9 ]{0,40}(private key|openssh)/i.test(s)) return true;
  if (/putty-user-key-file-\d|private-lines\s*:|private-mac\s*:/i.test(s)) return true;
  if (/(^|\s)(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d{3}) AAAA[0-9A-Za-z+/]{16}/.test(s)) return true;
  // 'password=' · '"pw"="x"' · 'pw    = x' 꼴(공백 상한은 위 4KB 절단으로 충분 — 앞뒤가 고정 글자라 선형)
  if (/(^|[^A-Za-z0-9])["']?(pass(word|wd|phrase)?|pw|pwd|secret|비밀번호|암호)["']?\s*[:=]/i.test(s)) return true;
  // 키 본문 조각 — 머리글 없이 붙여 넣은 base64 줄(OpenSSH 70자 · PEM 64자 줄바꿈). 16자 이상 base64 토큰을 이어 붙여
  // 64자 이상이고 대문자 · 소문자 · 숫자가 섞이면 비밀로 본다(일반 영어 문장은 낱말이 짧아 이어지지 않는다).
  let run = '';
  const hit = () => run.length >= 64 && /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
  for (const tok of s.split(/\s+/)) {
    if (tok.length >= 16 && /^[0-9A-Za-z+/=]+$/.test(tok)) { run += tok; if (hit()) return true; } else run = '';
  }
  return false;
}
