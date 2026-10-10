/**
 * 장비 TLS 상대 인증(2026-10-09 검토 S-02) — 자격증명을 보내는 HTTPS 연결이 **정말 그 장비인지** 확인한다.
 *
 * 왜: vCenter·Horizon·스토리지·SAN·iDRAC/OME·NSX·CVP 수집은 자체서명 장비 호환을 위해 인증서 검증을 꺼 두는 것이
 * 기본이었다(env 를 'true' 로 둘 때만 검증). 그 상태에서 경로를 가로챈 쪽은 자기 서버로 접속을 유도해 로그인 비밀번호·AD 계정·
 * 세션 토큰을 그대로 받는다. TLS 로 암호화돼도 상대가 누구인지 확인하지 않으면 그 상대에게 비밀을 보내는 것이다.
 *
 * 판정(연결마다, **핸드셰이크 직후·HTTP 요청 바이트를 보내기 전**):
 *   ① CA 체인 — 시스템(Node 기본) 루트 + 사설 CA 번들(CONFIG_DIR/tls-ca-bundle.pem)로 체인이 맞고 호스트 이름도 맞으면 통과
 *   ② 장비별 지문 — ①이 아니면 peerTrust 의 승인 지문(SHA-256)과 대조한다(정책 enforce: 승인된 것만 · observe: 처음 보는 장비는
 *      관찰 기록 후 통과, 바뀐 지문은 거부 — security/peerTrust.js 머리말)
 *   ③ 그 밖은 소켓을 파기하고 `ERR_TLS_PEER_UNTRUSTED` 로 실패한다 — 요청·자격증명은 나가지 않는다.
 *
 * 모드(env — security/tlsMode.js): 미설정 = 위 판정('verify') · true = ①만('strict') · false = **명시적 예외**('insecure' —
 * 예전처럼 어떤 인증서든 받는다. tlsTrustStatus().exceptions 에 드러난다).
 *
 * 규칙
 *   - 전역 디스패처(setGlobalDispatcher)·전역 CA(tls.setDefaultCACertificates)를 바꾸지 않는다 — 수집기별 로컬 Agent 의 connect 함수다.
 *   - 거부 오류는 인증 실패와 **다른 코드·문구**다(`authFailed` 를 붙이지 않고 '인증 실패'·401 같은 낱말을 쓰지 않는다) —
 *     authGuard 가 이 거부를 자격증명 거부로 읽어 주기 수집을 '인증 정지' 시키면 안 된다.
 *   - TLS 세션 재사용: 판정을 통과한 연결의 세션만 기억한다(재개 연결은 인증서를 다시 보내지 않으므로 — 재개는 처음 판정한 서버의
 *     마스터 비밀을 가진 쪽만 할 수 있다). 승인 지문 경로로 통과한 세션은 재개 때도 peerTrust 를 다시 묻는다(그 사이 거부·삭제 반영).
 *   - IP 등록 장비는 SNI 를 보내지 않는다(RFC 6066 — undici 와 같은 규칙). 호스트 이름 검사는 IP SAN 으로 한다.
 */
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildConnector } from 'undici';
import { config } from '../config.js';
import { checkPeer, getPeerPolicy, normalizeFingerprint, peerApproveWhere } from './peerTrust.js';
import { tlsModeInfo, TLS_VERIFY_MODES } from './tlsMode.js';

export { tlsModeFromEnv, tlsModeInfo, TLS_VERIFY_MODES } from './tlsMode.js';

export const TLS_PEER_ERROR_CODE = 'ERR_TLS_PEER_UNTRUSTED';
export const CA_BUNDLE_FILE = 'tls-ca-bundle.pem';
const CA_BUNDLE_MAX_BYTES = 4194304;     // 4MB — 사설 CA 번들로 충분한 크기
const CA_BUNDLE_MAX_CERTS = 500;
const SESSION_MAX = 512;                 // 연결 대상별 검증된 TLS 세션(연결 함수마다)
const SESSION_TTL_MS = 600000;           // 10분 — 그 뒤에는 인증서를 다시 받아 판정한다
const RECENT_MAX = 50;
const WARN_EVERY_MS = 600000;            // 같은 대상·같은 사유의 콘솔 경고는 10분에 1줄
const WARN_KEYS_MAX = 2000;

const BEGIN = '-----BEGIN CERTIFICATE-----';
const END = '-----END CERTIFICATE-----';

/** 화면·문구용 이름 */
const LABEL = {
  vcenter: 'vCenter', nsx: 'NSX', idrac: 'iDRAC/BMC', ome: 'OME', horizon: 'Horizon',
  storage: '스토리지 REST', sanswitch: 'SAN 스위치 REST', cvp: 'CVP',
};

/** TLS 상대 인증 실패. `code` 는 인증 실패와 겹치지 않는다. */
export class TlsPeerError extends Error {
  constructor(message, info) {
    super(message);
    this.name = 'TlsPeerError';
    this.code = TLS_PEER_ERROR_CODE;
    this.tlsPeer = info;
  }
}

/** 오류 사슬(cause) 안의 TlsPeerError(없으면 null) — 호출부가 문구·종류를 고를 때 쓴다. */
export function tlsPeerErrorOf(err) {
  for (let e = err, i = 0; e && i < 6; e = e.cause, i += 1) {
    if (e.code === TLS_PEER_ERROR_CODE) return e;
  }
  return null;
}
export const isTlsPeerError = (err) => !!tlsPeerErrorOf(err);
/** fetch 가 던진 'fetch failed' 대신 판정 오류 자체를 돌려준다(문구 = 대상·지문·조치). 아니면 원래 오류. */
export const unwrapTlsPeer = (err) => tlsPeerErrorOf(err) || err;

/* ── 사설 CA 번들 ─────────────────────────────────────────────────────────── */

let _bundle = { key: 'none', certs: [], info: { present: false } };
let _bundleCheckedAt = 0;

export function caBundlePath() { return path.join(config.configDir, CA_BUNDLE_FILE); }

/** PEM 블록 선형 추출(정규식 없이 indexOf — 긴 입력에서 역추적이 없다). */
function pemBlocks(text) {
  const out = [];
  let otherBlocks = 0;
  let pos = 0;
  for (;;) {
    const b = text.indexOf(BEGIN, pos);
    if (b < 0) break;
    const e = text.indexOf(END, b + BEGIN.length);
    if (e < 0) { out.push({ bad: 'END 표식 없음' }); break; }
    out.push({ pem: text.slice(b, e + END.length) });
    pos = e + END.length;
    if (out.length > CA_BUNDLE_MAX_CERTS) break;
  }
  // 인증서가 아닌 블록(개인키 등)은 쓰지 않는다 — 개수만 밝힌다(번들에 개인키를 두면 안 된다).
  for (let p = 0; ;) {
    const i = text.indexOf('-----BEGIN ', p);
    if (i < 0) break;
    if (!text.startsWith(BEGIN, i)) otherBlocks++;
    p = i + 11;
  }
  return { blocks: out, otherBlocks };
}

const cnOf = (s) => {
  if (!s) return '';
  if (typeof s === 'object') return String(s.CN || s.O || '').slice(0, 200);
  const m = /(?:^|\n|,\s*)CN=([^\n,]{1,200})/.exec(String(s));
  return m ? m[1] : String(s).slice(0, 200);
};

function parseBundle(text) {
  const { blocks, otherBlocks } = pemBlocks(text);
  const certs = [];
  const items = [];
  const errors = [];
  const now = Date.now();
  blocks.forEach((b, idx) => {
    if (b.bad) { errors.push({ index: idx + 1, reason: b.bad }); return; }
    try {
      const x = new crypto.X509Certificate(b.pem);
      const exp = Date.parse(x.validTo);
      items.push({
        subject: cnOf(x.subject), issuer: cnOf(x.issuer), validTo: x.validTo, fingerprint256: x.fingerprint256,
        ca: x.ca === true, expired: Number.isFinite(exp) ? exp < now : null,
      });
      certs.push(b.pem);
    } catch (e) {
      errors.push({ index: idx + 1, reason: `인증서를 읽지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)})` });
    }
  });
  return { certs, items, errors, otherBlocks, truncated: blocks.length > CA_BUNDLE_MAX_CERTS };
}

/** 번들을 읽는다(파일 mtime·size 가 그대로면 다시 읽지 않는다 · 1초에 한 번만 stat). */
export function loadCaBundle({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - _bundleCheckedAt < 1000) return _bundle;
  _bundleCheckedAt = now;
  const file = caBundlePath();
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (e?.code === 'ENOENT') {
      if (_bundle.key !== 'none') _bundle = { key: 'none', certs: [], info: { present: false, file } };
      else _bundle.info = { present: false, file };
      return _bundle;
    }
    const key = `err|${e?.code || ''}`;
    if (_bundle.key !== key) _bundle = { key, certs: [], info: { present: true, file, error: `읽지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)})` } };
    return _bundle;
  }
  const key = `${st.mtimeMs}|${st.size}|${st.ino}`;
  if (!force && key === _bundle.key) return _bundle;
  if (!st.isFile()) { _bundle = { key, certs: [], info: { present: true, file, error: '파일이 아닙니다' } }; return _bundle; }
  if (st.size > CA_BUNDLE_MAX_BYTES) {
    _bundle = { key, certs: [], info: { present: true, file, error: `크기 상한(${CA_BUNDLE_MAX_BYTES} 바이트)을 넘었습니다 — 쓰지 않습니다`, bytes: st.size } };
    console.warn(`[tlsTrust] ${file} 이(가) 크기 상한을 넘어 사설 CA 번들을 쓰지 않습니다(${st.size} 바이트).`);
    return _bundle;
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    _bundle = { key, certs: [], info: { present: true, file, error: `읽지 못했습니다(${String(e?.code || e?.message || e).slice(0, 80)})` } };
    return _bundle;
  }
  const p = parseBundle(text);
  _bundle = {
    key, certs: p.certs,
    info: {
      present: true, file, bytes: st.size, mtime: st.mtimeMs, loadedAt: now,
      certs: p.certs.length, notCa: p.items.filter((x) => !x.ca).length, expired: p.items.filter((x) => x.expired === true).length,
      errors: p.errors, otherBlocks: p.otherBlocks, truncated: p.truncated, items: p.items.slice(0, 100),
    },
  };
  if (p.errors.length || p.otherBlocks) {
    console.warn(`[tlsTrust] 사설 CA 번들 ${file}: 인증서 ${p.certs.length}개를 읽었고 읽지 못한 블록 ${p.errors.length}개 · 인증서가 아닌 블록 ${p.otherBlocks}개는 쓰지 않습니다.`);
  }
  return _bundle;
}

let _defaultRoots = null;
/** Node 기본 신뢰 저장소(NODE_EXTRA_CA_CERTS 포함 — `ca` 를 주면 기본 저장소를 **대체**하므로 합친다). */
function defaultRoots() {
  if (_defaultRoots) return _defaultRoots;
  let list = null;
  try { if (typeof tls.getCACertificates === 'function') list = tls.getCACertificates('default'); } catch { list = null; }
  if (!Array.isArray(list) || !list.length) {
    list = [...tls.rootCertificates];
    const extra = process.env.NODE_EXTRA_CA_CERTS;
    if (extra) {
      try { list = list.concat(pemBlocks(fs.readFileSync(extra, 'utf8')).blocks.filter((b) => b.pem).map((b) => b.pem)); } catch { /* Node 가 이미 경고한다 */ }
    }
  }
  _defaultRoots = list;
  return list;
}

const CTX_KEYS = ['minVersion', 'maxVersion', 'ciphers', 'secureOptions', 'ecdhCurve', 'sigalgs'];
const _ctxCache = new Map(); // `${bundleKey}|${optsKey}` → SecureContext

function secureContextFor(tlsOpts, bundle) {
  const ctxOpts = {};
  for (const k of CTX_KEYS) if (tlsOpts[k] !== undefined) ctxOpts[k] = tlsOpts[k];
  const key = `${bundle.key}|${JSON.stringify(ctxOpts)}`;
  let ctx = _ctxCache.get(key);
  if (ctx) return ctx;
  if (_ctxCache.size > 32) _ctxCache.clear();
  // 번들이 비어 있으면 ca 를 주지 않는다 — Node 기본 저장소(NODE_EXTRA_CA_CERTS 포함)를 그대로 쓴다.
  ctx = tls.createSecureContext(bundle.certs.length ? { ...ctxOpts, ca: [...defaultRoots(), ...bundle.certs] } : ctxOpts);
  _ctxCache.set(key, ctx);
  return ctx;
}

/* ── 상태·기록 ─────────────────────────────────────────────────────────────── */

const _subsystems = new Map(); // name → { name, label, mode, envKey, envRaw, unknownEnv, counts, lastRejectAt }
const _recent = [];            // 최근 거부(화면용)
const _warned = new Map();     // `${subsystem}|${host}|${port}|${reason}` → at

function registerSubsystem(name, { mode, envKey, envRaw, unknownEnv, label, strictHint }) {
  let s = _subsystems.get(name);
  if (!s) {
    s = { name, label: label || LABEL[name] || name, modes: {}, envKey: envKey || '', envRaw: envRaw ?? null, unknownEnv: !!unknownEnv,
      strictHint: strictHint || '', counts: { chain: 0, pin: 0, observed: 0, resumed: 0, insecure: 0, rejected: 0, plain: 0 }, lastRejectAt: null };
    _subsystems.set(name, s);
  }
  if (strictHint) s.strictHint = strictHint;
  s.modes[mode] = true;
  if (envKey) { s.envKey = envKey; s.envRaw = envRaw ?? null; s.unknownEnv = !!unknownEnv; }
  return s;
}

function noteReject(sub, info) {
  sub.counts.rejected++;
  sub.lastRejectAt = Date.now();
  _recent.push({ at: sub.lastRejectAt, subsystem: sub.name, host: info.host, port: info.port, reason: info.reason,
    chainError: info.chainError || null, fingerprint: info.fingerprint || null, mode: info.mode });
  if (_recent.length > RECENT_MAX) _recent.splice(0, _recent.length - RECENT_MAX);
  const wk = `${sub.name}|${info.host}|${info.port}|${info.reason}|${info.fingerprint || ''}`;
  const last = _warned.get(wk) || 0;
  if (Date.now() - last > WARN_EVERY_MS) {
    if (_warned.size > WARN_KEYS_MAX) _warned.clear();
    _warned.set(wk, Date.now());
    console.warn(`[tlsTrust] ${info.message}`);
  }
}

const CHAIN_TEXT = {
  CERT_HAS_EXPIRED: '인증서가 만료됐습니다',
  CERT_NOT_YET_VALID: '인증서 유효 기간이 아직 시작되지 않았습니다',
  ERR_TLS_CERT_ALTNAME_INVALID: '인증서의 이름이 접속 주소와 다릅니다',
  DEPTH_ZERO_SELF_SIGNED_CERT: '자체서명 인증서입니다',
  SELF_SIGNED_CERT_IN_CHAIN: '신뢰하지 않는 자체서명 CA 가 서명했습니다',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '신뢰하는 CA 가 서명하지 않았습니다',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: '신뢰하는 CA 가 서명하지 않았습니다',
  UNABLE_TO_GET_ISSUER_CERT: '신뢰하는 CA 가 서명하지 않았습니다',
};
const PIN_TEXT = {
  unknown: '승인된 지문이 없습니다',
  changed: '이전에 기록된 인증서와 지문이 다릅니다(인증서 교체·중간자 가능성, 또는 같은 주소 뒤 다른 서버 — 로드밸런서면 서버마다 지문을 확인해 추가 승인하거나 발급 CA 를 등록)',
  rejected: '관리자가 거부한 지문입니다',
  'not-approved': '관찰만 된 지문이고 아직 승인되지 않았습니다',
  'bad-fingerprint': '인증서 지문을 읽지 못했습니다',
  'no-cert': '장비가 인증서를 내지 않았습니다',
  'resumed-unknown': '기억하지 않은 TLS 세션이 재개됐습니다',
};

/**
 * 거부 문구. v2.731(A1-02): 승인할 노드를 말한다 — 엣지가 만든 문구는 스냅샷 오류로 중앙 화면에 실리는데 승인 저장소·CA 번들·env 는
 * 노드마다 따로라 중앙에서는 조치할 수 없다(peerTrust.js peerApproveWhere). ⚠ '장비 인증서를 신뢰할 수 없어 연결을 끊었습니다' 는
 * 표지(util/authGuard.js PEER_REJECT_MARKERS·로그 분석 probe)라 바꾸지 말 것.
 */
function buildMessage({ sub, host, port, mode, chainError, reason, fingerprint }) {
  const where = `${sub.label} ${host}:${port}`;
  const chain = chainError ? `CA 검증: ${CHAIN_TEXT[chainError] || chainError}` : '';
  const pin = mode === 'strict' ? '' : `지문: ${PIN_TEXT[reason] || reason}`;
  const why = [chain, pin].filter(Boolean).join(' · ');
  const fp = fingerprint ? ` · 제시된 인증서 SHA-256 ${fingerprint}` : '';
  let node = { text: '설정 › 장비 신뢰(SSH 호스트키·TLS 인증서)', note: '' };
  try { node = peerApproveWhere(); } catch { /* 문구만 덜 구체적이 된다 — 거부 판정은 그대로 */ }
  const fix = mode === 'strict'
    ? `${sub.envKey ? `${sub.envKey}=true(엄격 — CA 체인만 허용)` : 'CA 체인만 허용(엄격)'}이므로 사설 CA 를 CONFIG_DIR/${CA_BUNDLE_FILE} 로 등록하거나 ${sub.strictHint || (sub.envKey ? `${sub.envKey} 를 지워 승인 지문을 허용하세요` : '승인 지문을 허용하도록 설정을 바꾸세요')}`
    : `${node.text} 화면에서 이 지문을 확인해 승인하거나, 사설 CA 를 CONFIG_DIR/${CA_BUNDLE_FILE} 로 등록하세요`;
  return `${where} 장비 인증서를 신뢰할 수 없어 연결을 끊었습니다(요청·자격증명은 보내지 않았습니다) — ${why}${fp} — ${fix}${node.note ? `(${node.note})` : ''}`;
}

/* ── 판정 ──────────────────────────────────────────────────────────────────── */

/**
 * 핸드셰이크가 끝난 TLS 소켓을 판정한다(node:https 경로는 'secureConnect' 에서 불러 쓴다).
 * @returns {{ok:boolean, via?:string, reason?:string, fingerprint?:string, meta?:object, error?:TlsPeerError}}
 */
export function judgeTlsSocket(socket, { subsystem = 'other', mode = 'verify', host, port, idName, cached = null } = {}) {
  const sub = _subsystems.get(subsystem) || registerSubsystem(subsystem, { mode });
  const p = Number(port) || 443;
  const reject = (reason, extra = {}) => {
    const info = { host, port: p, mode, reason, ...extra };
    info.message = buildMessage({ sub, ...info });
    noteReject(sub, info);
    return { ok: false, reason, fingerprint: extra.fingerprint || null, error: new TlsPeerError(info.message, { subsystem, ...info }) };
  };
  if (typeof socket.isSessionReused === 'function' && socket.isSessionReused()) {
    // 재개된 세션은 인증서를 다시 보내지 않는다(getPeerCertificate 가 빈 객체 — Node 22 실측). 판정을 통과한 세션만 기억하므로
    // 재개 = 처음 판정한 서버와 같은 마스터 비밀. 지문 경로로 통과했던 세션은 그 사이의 거부·삭제를 반영하려 다시 묻는다.
    if (!cached) return reject('resumed-unknown');
    if (cached.via === 'pin' && mode !== 'strict') {
      const r = checkPeer('tls', host, p, cached.fingerprint, cached.meta || {});
      if (!r.ok) return reject(r.reason, { fingerprint: cached.fingerprint });
    }
    sub.counts.resumed++;
    return { ok: true, via: cached.via, fingerprint: cached.fingerprint, meta: cached.meta };
  }
  const cert = (typeof socket.getPeerCertificate === 'function' && socket.getPeerCertificate(false)) || {};
  const fingerprint = normalizeFingerprint('tls', cert.fingerprint256 || '');
  if (!fingerprint) return reject(cert.fingerprint256 ? 'bad-fingerprint' : 'no-cert');
  const meta = { subject: cnOf(cert.subject), issuer: cnOf(cert.issuer), validTo: cert.valid_to || '' };
  // 체인·이름: Node 가 rejectUnauthorized:false 여도 판정은 해 둔다(authorized/authorizationError). 이름은 직접 다시 본다.
  let chainError = null;
  if (!socket.authorized) chainError = String(socket.authorizationError?.code || socket.authorizationError || 'UNKNOWN');
  if (!chainError) {
    let nameErr = null;
    try { nameErr = tls.checkServerIdentity(idName || host, cert); } catch (e) { nameErr = e; }
    if (nameErr) chainError = 'ERR_TLS_CERT_ALTNAME_INVALID';
  }
  if (!chainError) { sub.counts.chain++; return { ok: true, via: 'chain', fingerprint, meta }; }
  if (mode === 'strict') return reject('chain', { chainError, fingerprint });
  const r = checkPeer('tls', host, p, fingerprint, meta);
  if (r.ok) {
    if (r.reason === 'approved') sub.counts.pin++; else sub.counts.observed++;
    return { ok: true, via: 'pin', reason: r.reason, fingerprint, meta };
  }
  return reject(r.reason, { chainError, fingerprint });
}

/* ── undici connect 함수 ───────────────────────────────────────────────────── */

const CTX_OR_VERIFY_KEYS = new Set([...CTX_KEYS, 'ca', 'rejectUnauthorized', 'timeout', 'checkServerIdentity', 'secureContext']);

/**
 * 장비 수집기 Agent 의 `connect` 함수를 만든다 — `new Agent({ connect: deviceTlsConnect({...}) })`.
 * @param {object} o
 * @param {string} o.subsystem   'vcenter' | 'nsx' | 'idrac' | 'ome' | 'horizon' | 'storage' | 'sanswitch' | 'cvp' …
 * @param {string} [o.envKey]    모드를 정한 env 이름(상태·문구용)
 * @param {*}      [o.envRaw]    그 env 원문(process.env.X) — mode 를 생략하면 이것으로 정한다
 * @param {string} [o.mode]      'verify' | 'strict' | 'insecure'
 * @param {object} [o.tls]       tls.connect 옵션(lookup·minVersion·ciphers·secureOptions·timeout …). rejectUnauthorized·ca 는 무시한다.
 * @param {string} [o.strictHint] 엄격 모드 거부 문구의 조치(env 가 아닌 화면 설정으로 엄격을 켜는 수집기 — CVP)
 */
export function deviceTlsConnect({ subsystem, envKey = '', envRaw, mode, tls: tlsOpts = {}, label, strictHint } = {}) {
  const info = tlsModeInfo(envRaw);
  const m = TLS_VERIFY_MODES.includes(mode) ? mode : info.mode;
  const sub = registerSubsystem(subsystem, { mode: m, envKey, envRaw: envKey ? info.raw : null, unknownEnv: envKey ? info.unknown : false, label, strictHint });
  if (envKey && info.unknown) console.warn(`[tlsTrust] ${envKey}='${info.raw}' 은(는) 모르는 값입니다 — 검증(승인 지문 허용)으로 동작합니다(true=엄격 · false=예외).`);
  const timeout = Number.isFinite(Number(tlsOpts.timeout)) && Number(tlsOpts.timeout) > 0 ? Number(tlsOpts.timeout) : undefined;
  const base = {};
  for (const [k, v] of Object.entries(tlsOpts)) if (!CTX_OR_VERIFY_KEYS.has(k)) base[k] = v;

  if (m === 'insecure') {
    // 명시적 예외 — 예전 동작 그대로(어떤 인증서든). 상태가 '예외 사용 중' 으로 말한다.
    console.warn(`[tlsTrust] ⚠ ${sub.label}: ${envKey || '설정'} 으로 인증서 검증 예외를 쓰고 있습니다 — 이 경로의 자격증명은 상대 확인 없이 전송됩니다.`);
    const raw = buildConnector({ ...tlsOpts, rejectUnauthorized: false, ...(timeout ? { timeout } : {}) });
    return function connect(opts, cb) {
      if (opts?.protocol === 'https:') sub.counts.insecure++; else sub.counts.plain++;
      return raw(opts, cb);
    };
  }

  const plain = buildConnector({ ...base, ...(timeout ? { timeout } : {}) });
  const sessions = new Map(); // `${idName}|${port}` → { session, via, fingerprint, meta, at, bundleKey }
  const remember = (key, session, v, bundleKey) => {
    if (!session) return;
    if (sessions.size >= SESSION_MAX && !sessions.has(key)) sessions.delete(sessions.keys().next().value);
    sessions.set(key, { session, via: v.via, fingerprint: v.fingerprint, meta: v.meta, at: Date.now(), bundleKey });
  };

  return function connect(opts, callback) {
    if (opts?.protocol !== 'https:') { sub.counts.plain++; return plain(opts, callback); }
    const hostname = String(opts.hostname || '');
    const port = Number(opts.port) || 443;
    const sni = opts.servername || base.servername || (net.isIP(hostname) ? '' : hostname);
    const idName = sni || hostname;
    const bundle = loadCaBundle();
    const key = `${idName}|${port}`;
    let cached = sessions.get(key) || null;
    if (cached && (cached.bundleKey !== bundle.key || Date.now() - cached.at > SESSION_TTL_MS)) { sessions.delete(key); cached = null; }
    const connector = buildConnector({
      ...base,
      secureContext: secureContextFor(tlsOpts, bundle),
      rejectUnauthorized: false,           // 판정은 아래에서 — Node 가 먼저 끊으면 승인 지문 경로를 쓸 수 없다
      maxCachedSessions: 0,                // 세션은 판정을 통과한 것만 직접 기억한다
      ...(cached ? { session: cached.session } : {}),
      ...(timeout ? { timeout } : {}),
    });
    let verdict = null;
    let lastSession = null;
    const sock = connector(opts, (err, socket) => {
      if (err) return callback(err);
      let v;
      try {
        v = judgeTlsSocket(socket, { subsystem, mode: m, host: hostname, port, idName, cached });
      } catch (e) {
        v = { ok: false, error: new TlsPeerError(`${sub.label} ${hostname}:${port} 인증서 판정 중 오류 — 연결을 끊었습니다(${String(e?.message || e).slice(0, 120)})`, { subsystem, host: hostname, port, reason: 'internal' }) };
      }
      if (!v.ok) {
        sessions.delete(key);
        try { socket.destroy(v.error); } catch { /* 이미 닫힘 */ }
        return callback(v.error);
      }
      verdict = v;
      if (lastSession) remember(key, lastSession, v, bundle.key);
      return callback(null, socket);
    });
    // TLS 1.2 는 핸드셰이크 중, 1.3 은 그 뒤(티켓)에 온다 — 판정을 통과한 소켓의 것만 기억한다.
    sock.on('session', (s) => { lastSession = s; if (verdict) remember(key, s, verdict, bundle.key); });
    return sock;
  };
}

/* ── 상태 ──────────────────────────────────────────────────────────────────── */

/**
 * 화면·진단용 상태 — 사설 CA 번들 로드 결과, 수집기별 모드·예외 env, 판정 횟수, 최근 거부.
 * 비밀은 없다(지문·호스트·포트뿐). 범위 계정에 낼지는 라우트가 정한다(전 법인 장비 주소가 들어 있다).
 */
export function tlsTrustStatus() {
  const b = loadCaBundle();
  const subsystems = [..._subsystems.values()].map((s) => ({
    subsystem: s.name, label: s.label, modes: Object.keys(s.modes), envKey: s.envKey || null, envRaw: s.envRaw,
    unknownEnv: s.unknownEnv, exception: !!s.modes.insecure, strict: !!s.modes.strict,
    counts: { ...s.counts }, lastRejectAt: s.lastRejectAt,
  })).sort((a, z) => (a.subsystem < z.subsystem ? -1 : 1));
  let peerPolicy = null;
  try { peerPolicy = getPeerPolicy('tls'); } catch { peerPolicy = null; }
  return {
    caBundle: { ...b.info, file: caBundlePath() },
    defaultRoots: { count: defaultRoots().length, extraEnv: !!process.env.NODE_EXTRA_CA_CERTS },
    peerPolicy,
    subsystems,
    exceptions: subsystems.filter((s) => s.exception).map((s) => ({ subsystem: s.subsystem, label: s.label, envKey: s.envKey })),
    recentRejects: [..._recent].reverse(),
  };
}

/** 테스트 전용 */
export function _resetTlsTrustForTest() {
  _bundle = { key: 'none', certs: [], info: { present: false } };
  _bundleCheckedAt = 0;
  _ctxCache.clear();
  _recent.length = 0;
  _warned.clear();
  for (const s of _subsystems.values()) { for (const k of Object.keys(s.counts)) s.counts[k] = 0; s.lastRejectAt = null; }
}
