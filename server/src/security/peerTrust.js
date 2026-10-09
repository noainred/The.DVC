/**
 * 장비 상대 신뢰 저장소(2026-10-09 검토 S-01 SSH 호스트키 · S-02 TLS 인증서) — '이 주소의 장비가 정말 그 장비인가'.
 *
 * 왜 필요한가: ssh2 는 hostVerifier 가 없으면 어떤 호스트키든 받아들이고, 자체서명 장비 호환을 위해 TLS 검증을 끈
 * 경로는 어떤 인증서든 받아들인다. 경로를 가로챈 쪽이 자기 서버로 접속을 유도하면 포탈은 비밀번호를 그대로 보낸다.
 * 여기서는 (종류, 호스트, 포트)마다 신뢰한 지문을 들고 있다가 연결이 내민 지문과 대조한다. **대조는 비밀번호를
 * 보내기 전에** 이뤄져야 한다(SSH 는 hostVerifier, TLS 는 핸드셰이크 직후·HTTP 요청 전) — 그 배선은 호출자 몫이다.
 *
 * 정책(종류마다)
 *   - enforce : 관리자가 승인한 지문만 통과. 모르는 지문·바뀐 지문은 거부하고 '승인 대기(pending)' 로 기록한다.
 *   - observe : 처음 보는 장비는 지문을 '관찰(observed)' 로 기록하고 통과(화면에 '미승인' 개수로 보인다 — 무음 TOFU 아님).
 *               한 번 기록된 장비의 지문이 **바뀌면 거부**한다(변경은 관리자 재승인). 기존 현장의 전환 단계다.
 * 기본값(사용자 승인 — 기본값 전환): 새 설치는 enforce. 이 기능 이전부터 장비를 등록해 쓰던 설치는 업그레이드 첫 기동에
 * observe 로 시작한다(업그레이드 즉시 전 장비 수집이 끊기지 않게) — 그 사실(origin 'upgrade-migration')을 상태가 말하고,
 * 관리자가 관찰 지문을 확인·승인한 뒤 enforce 로 바꾼다. env `SSH_HOSTKEY_POLICY`·`TLS_PEER_POLICY` 가 있으면 그 값이 이긴다.
 *
 * 저장: `peer-trust.json`(설정 — 백업 대상, 비밀 아님). 상태 변경(관찰·대기·승인·거부·삭제·정책)마다 원자 쓰기.
 * 연결마다 바뀌는 `lastSeen`·`lastSeenCount` 는 메모리에서만 갱신하고 다음 상태 변경·종료 flush 때 함께 쓴다
 * (필드 이름이 last* 라 백업 '변경 감시' 지문에서도 빠진다 — backup/service.js RUN_FIELD_RE · peer-trust.json 은 MIXED_STATE_FILES).
 * ⚠ 연결마다 바뀌는 필드를 새로 만들면 **last* 이름**을 쓸 것 — 아니면 종료 flush 마다 '설정 변경' 백업이 생긴다(2026-10-09 리드 요청 —
 *   예전 이름 `seenCount` 가 그랬다. 읽을 때는 옛 이름도 받아 옮긴다).
 * 손상 파일은 preserveCorrupt 로 보존하고 **두 종류 모두 enforce 로 닫는다**(승인 목록을 잃은 채 observe 로 열면
 * 그 사이 공격자 키가 '관찰' 로 들어온다). 상태의 `loadError` 가 그 사실을 말한다.
 *
 * 호스트 정규화: 소문자 · 끝 점 제거 · IPv6 대괄호 제거·표준형. IPv4 는 정규형만 숫자로 다루고 비정규 표기(선행 0)는
 * 글자 그대로 별개 키다(실제 접속은 그것을 8진수로 해석한다 — normalizePeerHost 주석). 이름과 IP 는 같은 장비여도
 * 다른 키다(포탈은 둘이 같은지 모른다 — 지어내지 않는다). 주소·포트가 바뀌면 기존 지문을 승계하지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { strictIpv4Num, numToIp } from '../util/ipv4.js';
import { registerExitFlush } from '../util/exitFlush.js';
import { logAudit } from '../audit.js';

export const PEER_KINDS = Object.freeze(['ssh', 'tls']);
export const PEER_MODES = Object.freeze(['enforce', 'observe']);
const DEFAULT_PORT = { ssh: 22, tls: 443 };
const ENV_KEY = { ssh: 'SSH_HOSTKEY_POLICY', tls: 'TLS_PEER_POLICY' };
const MAX_ENTRIES = 20000;
const HISTORY_MAX = 8;
// 이 기능 이전부터 쓰던 설치인지 판단하는 장비 등록부(하나라도 내용이 있으면 '기존 현장').
const EXISTING_MARKERS = [
  'vcenters.json', 'storage-devices.json', 'sanswitch-devices.json', 'pdu-devices.json', 'cvp-servers.json',
  'idrac.json', 'bm-storage.json', 'horizon.json', 'nsx.json', 'collectors.json', 'credentials.json',
  'rma-agents.json', 'gpu-physical.json',
  // 그룹 H(S-01): SSH 를 쓰는 나머지 등록부 — 웹 SSH 매핑·에이전트 배포 대상·중계 토폴로지·캡처 감시·GPU 게스트·베어메탈 사용률.
  //   이것만 쓰던 현장이 '새 설치' 로 판정되면 업그레이드 직후 그 SSH 접속이 전부 승인 대기로 끊긴다.
  'remote-access.json', 'agent-deploy-targets.json', 'relay-topology.json', 'capture-monitors.json', 'gpu-guest.json',
  'bmusage-settings.json',
];

const FILE = () => path.join(config.configDir, 'peer-trust.json');

let _st = null;          // { v, policy:{ssh,tls}, origin:{ssh,tls}, entries: Map<key, entry> }
let _loadError = null;
let _dirty = false;

function emptyState() {
  return { v: 1, policy: {}, origin: {}, entries: new Map() };
}

export function normalizePeerHost(host) {
  // 키 구분자('|')·공백·제어 문자는 호스트 이름에 올 수 없다 — 지워 두어 키 분해(split('|'))가 어긋나지 않게 한다. 길이 상한 255.
  let h = String(host ?? '').trim().toLowerCase().replace(/[|\s\u0000-\u001f\u007f]/g, '').slice(0, 255);
  if (!h) return '';
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  const n = strictIpv4Num(h);
  if (typeof n === 'number') return numToIp(n);
  // 그룹 H(S-01): 선행 0 같은 비정규 IPv4('010.0.0.1')는 **10진으로 접지 않는다** — 실제 접속(net.connect → dns.lookup →
  //   glibc inet_aton)은 그 표기를 **8진수(8.0.0.1)** 로 해석한다(CLAUDE.md v2.589 SEC 계열). '10.0.0.1' 키로 접으면 다른 목적지의
  //   키가 그 주소의 승인 지문으로 쌓이거나 대조된다. 글자 그대로(소문자) 별개 키로 둔다 — 같은 장비여도 지어내 합치지 않는다.
  if (net.isIPv6(h)) {
    try { return new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, ''); } catch { return h; }
  }
  return h;
}

function normPort(kind, port) {
  const p = Math.floor(Number(port));
  return p >= 1 && p <= 65535 ? p : DEFAULT_PORT[kind];
}

export function peerKey(kind, host, port) {
  return `${kind}|${normalizePeerHost(host)}|${normPort(kind, port)}`;
}

/** 지문 표기 정규화 — ssh 'SHA256:<base64>'(패딩 제거), tls 대문자 16진 ':' 구분. 모양이 틀리면 ''. */
export function normalizeFingerprint(kind, fp) {
  const s = String(fp ?? '').trim();
  if (!s || s.length > 200) return '';
  if (kind === 'ssh') {
    const m = s.match(/^(?:sha256:)?([A-Za-z0-9+/]{43})=?$/i);
    return m ? `SHA256:${m[1]}` : '';
  }
  const hex = s.replace(/^sha256:/i, '').replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return '';
  return hex.match(/../g).join(':');
}

function envPolicy(kind) {
  const v = String(process.env[ENV_KEY[kind]] ?? '').trim().toLowerCase();
  return PEER_MODES.includes(v) ? v : null;
}

function existingInstall() {
  for (const f of EXISTING_MARKERS) {
    try {
      const st = fs.statSync(path.join(config.configDir, f));
      if (st.isFile() && st.size > 2) return true;
    } catch { /* 없음 */ }
  }
  return false;
}

function entryToJson(e) {
  const o = { kind: e.kind, host: e.host, port: e.port };
  for (const k of ['trusted', 'pending', 'rejected', 'firstSeen', 'lastSeen', 'lastSeenCount', 'note', 'history']) {
    if (e[k] != null) o[k] = e[k];
  }
  return o;
}

function persist() {
  const st = load();
  const obj = { v: 1, policy: st.policy, origin: st.origin, entries: [...st.entries.values()].map(entryToJson) };
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 1), { mode: 0o600 });
  _dirty = false;
}

function decideDefaults(st) {
  const migration = existingInstall();
  const now = Date.now();
  for (const kind of PEER_KINDS) {
    if (PEER_MODES.includes(st.policy[kind])) continue;
    st.policy[kind] = migration ? 'observe' : 'enforce';
    st.origin[kind] = { origin: migration ? 'upgrade-migration' : 'new-install', at: now };
  }
}

function load() {
  if (_st) return _st;
  const st = emptyState();
  let raw = null;
  try { raw = fs.readFileSync(FILE(), 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') { _loadError = { code: 'unreadable', detail: String(e?.code || e?.message || e).slice(0, 120) }; }
  }
  if (raw != null) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.entries)) {
      try { preserveCorrupt(FILE(), 'peer-trust 손상'); } catch { /* */ }
      _loadError = { code: 'corrupt' };
      console.warn('[peerTrust] peer-trust.json 을 읽지 못했습니다(손상 원본 보존) — 승인 목록이 없으므로 SSH·TLS 모두 승인 지문만 허용(enforce)으로 닫습니다.');
      for (const kind of PEER_KINDS) { st.policy[kind] = 'enforce'; st.origin[kind] = { origin: 'load-error', at: Date.now() }; }
      _st = st;
      return st;
    }
    for (const kind of PEER_KINDS) {
      if (PEER_MODES.includes(obj.policy?.[kind])) st.policy[kind] = obj.policy[kind];
      if (obj.origin?.[kind] && typeof obj.origin[kind] === 'object') st.origin[kind] = obj.origin[kind];
    }
    for (const e of obj.entries) {
      if (!e || typeof e !== 'object' || !PEER_KINDS.includes(e.kind)) continue;
      const key = peerKey(e.kind, e.host, e.port);
      const { seenCount, ...rest } = e; // 옛 이름(seenCount) → lastSeenCount(실행 필드 — 백업 지문 제외)
      st.entries.set(key, { ...rest, ...(rest.lastSeenCount == null && seenCount != null ? { lastSeenCount: seenCount } : {}), host: normalizePeerHost(e.host), port: normPort(e.kind, e.port) });
    }
  }
  const missing = PEER_KINDS.some((k) => !PEER_MODES.includes(st.policy[k]));
  _st = st;
  if (missing && !_loadError) {
    decideDefaults(st);
    try { persist(); } catch (e) { console.warn(`[peerTrust] 기본 정책 저장 실패: ${e?.message || e}`); }
  }
  return st;
}

/** 기동 초기에 부른다 — 장비가 등록되기 전에 '새 설치/기존 현장' 판단을 굳힌다(idempotent). */
export function initPeerTrust() {
  load();
  try { registerExitFlush('peer-trust', () => { if (_dirty) persist(); }); } catch { /* */ }
  return peerTrustStatus();
}

export function getPeerPolicy(kind) {
  if (!PEER_KINDS.includes(kind)) throw new TypeError(`unknown peer kind: ${kind}`);
  const env = envPolicy(kind);
  if (env) return { mode: env, source: 'env', envKey: ENV_KEY[kind] };
  const st = load();
  return { mode: st.policy[kind] || 'enforce', source: 'file', ...(st.origin[kind] || {}) };
}

export function setPeerPolicy(kind, mode, { by = '' } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  if (!PEER_MODES.includes(mode)) return { ok: false, error: 'unknown-mode' };
  if (envPolicy(kind)) return { ok: false, error: 'env-forced', envKey: ENV_KEY[kind] };
  const st = load();
  st.policy[kind] = mode;
  st.origin[kind] = { origin: 'admin', at: Date.now(), by: String(by || '').slice(0, 64) };
  persist();
  return { ok: true, policy: getPeerPolicy(kind) };
}

function pushHistory(e, ev) {
  e.history = [...(Array.isArray(e.history) ? e.history : []), ev].slice(-HISTORY_MAX);
}

function capEntries(st) {
  if (st.entries.size <= MAX_ENTRIES) return;
  // 승인되지 않은 오래된 항목부터 버린다(승인 지문은 지우지 않는다).
  const victims = [...st.entries.entries()].filter(([, e]) => !e.trusted || e.trusted.state !== 'approved')
    .sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
  for (const [k] of victims) { if (st.entries.size <= MAX_ENTRIES) break; st.entries.delete(k); }
}

/**
 * 연결이 내민 지문을 판정한다. 반환 { ok, reason, mode, key }.
 * reason: 'approved' | 'observed' | 'observed-new' | 'unknown' | 'changed' | 'rejected' | 'not-approved' | 'bad-fingerprint'
 * meta(선택): { algo, subject, issuer, validTo, label } — 화면 표시용(아는 필드만 저장).
 */
export function checkPeer(kind, host, port, fp, meta = {}) {
  if (!PEER_KINDS.includes(kind)) throw new TypeError(`unknown peer kind: ${kind}`);
  const nfp = normalizeFingerprint(kind, fp);
  const key = peerKey(kind, host, port);
  const { mode } = getPeerPolicy(kind);
  if (!nfp) return { ok: false, reason: 'bad-fingerprint', mode, key };
  const st = load();
  const now = Date.now();
  let e = st.entries.get(key);
  const isNew = !e;
  if (!e) {
    const [, h, p] = key.split('|');
    e = { kind, host: h, port: Number(p), firstSeen: now };
    st.entries.set(key, e);
  }
  e.lastSeen = now;
  e.lastSeenCount = (Number(e.lastSeenCount) || 0) + 1;
  const m = pickMeta(meta);
  const rejectedFps = Array.isArray(e.rejected) ? e.rejected : [];
  if (rejectedFps.some((r) => r.fp === nfp)) { _dirty = true; return { ok: false, reason: 'rejected', mode, key }; }
  const t = e.trusted;
  if (t && t.fp === nfp) {
    if (t.state === 'approved') { _dirty = true; return { ok: true, reason: 'approved', mode, key }; }
    if (mode === 'observe') { _dirty = true; return { ok: true, reason: 'observed', mode, key }; }
    // enforce 로 바뀐 뒤의 관찰 지문 — 승인 전에는 통과시키지 않는다.
    setPending(e, nfp, 'not-approved', m, now);
    persistSafe();
    return { ok: false, reason: 'not-approved', mode, key };
  }
  if (!t && mode === 'observe') {
    e.trusted = { fp: nfp, state: 'observed', at: now, ...m };
    e.pending = null;
    pushHistory(e, { at: now, ev: 'observed', fp: nfp });
    capEntries(st);
    persistSafe();
    console.warn(`[peerTrust] ${kind} ${e.host}:${e.port} 지문을 처음 관찰했습니다(미승인 · observe 모드) ${nfp}`);
    return { ok: true, reason: 'observed-new', mode, key };
  }
  const reason = t ? 'changed' : 'unknown';
  const already = e.pending && e.pending.fp === nfp;
  setPending(e, nfp, reason, m, now);
  if (isNew) capEntries(st);
  if (!already) {
    persistSafe();
    console.warn(`[peerTrust] ${kind} ${e.host}:${e.port} ${reason === 'changed' ? '지문이 바뀌었습니다' : '승인되지 않은 지문입니다'} — 연결을 거부했습니다(관리자 승인 필요) ${nfp}`);
    // 그룹 H(S-01 '키 교체 감사'): 승인(또는 관찰)된 지문과 다른 지문은 보안 사건이다 — 감사 로그에도 남긴다(대기 지문마다 1회).
    //   처음 보는 장비(unknown)는 운영 사건이라 이력·콘솔에만 둔다(새 설치에서 장비마다 감사 줄이 쌓이지 않게).
    if (reason === 'changed') {
      try {
        logAudit({ user: 'system', action: '장비 키 변경 감지(연결 거부)', target: `${kind} ${e.host}:${e.port}`, detail: `신뢰 ${t.fp}(${t.state}) → 제시 ${nfp}` });
      } catch { /* 감사 기록 실패가 판정을 바꾸지 않는다 */ }
    }
  } else _dirty = true;
  return { ok: false, reason, mode, key };
}

/**
 * **읽기 전용** 판정(그룹 H) — 상태를 바꾸지 않고 '지금 연결하면 어떻게 되는가' 만 말한다. 통신 점검(linkcheck)처럼
 * 인증 없이 키만 보고 끊는 경로가 쓴다: 그 경로가 checkPeer 를 부르면 5분 주기 점검이 IP 키로 '관찰' 항목을 쌓고
 * (수집기는 이름으로 접속한다) observe 모드의 TOFU 를 점검이 대신 해 버린다.
 * 반환 { state, wouldPass, mode, key, trustedFp }
 *   state: 'approved' | 'observed' | 'changed' | 'pending' | 'rejected' | 'unknown' | 'bad-fingerprint'
 */
export function peekPeer(kind, host, port, fp) {
  if (!PEER_KINDS.includes(kind)) throw new TypeError(`unknown peer kind: ${kind}`);
  const nfp = normalizeFingerprint(kind, fp);
  const key = peerKey(kind, host, port);
  const { mode } = getPeerPolicy(kind);
  if (!nfp) return { state: 'bad-fingerprint', wouldPass: false, mode, key, trustedFp: null };
  const e = load().entries.get(key);
  const trustedFp = e?.trusted?.fp || null;
  if (!e) return { state: 'unknown', wouldPass: mode === 'observe', mode, key, trustedFp };
  if ((Array.isArray(e.rejected) ? e.rejected : []).some((r) => r.fp === nfp)) return { state: 'rejected', wouldPass: false, mode, key, trustedFp };
  if (e.trusted && e.trusted.fp === nfp) {
    const st = e.trusted.state === 'approved' ? 'approved' : 'observed';
    return { state: st, wouldPass: st === 'approved' || mode === 'observe', mode, key, trustedFp };
  }
  if (e.trusted) return { state: 'changed', wouldPass: false, mode, key, trustedFp };
  if (e.pending && e.pending.fp === nfp) return { state: 'pending', wouldPass: mode === 'observe', mode, key, trustedFp };
  return { state: 'unknown', wouldPass: mode === 'observe', mode, key, trustedFp };
}

function setPending(e, fp, reason, meta, now) {
  if (!e.pending || e.pending.fp !== fp) {
    e.pending = { fp, reason, at: now, ...meta };
    pushHistory(e, { at: now, ev: `pending-${reason}`, fp });
  }
}

function pickMeta(meta = {}) {
  const o = {};
  for (const k of ['algo', 'subject', 'issuer', 'validTo', 'label']) {
    if (meta[k] != null && meta[k] !== '') o[k] = String(meta[k]).slice(0, 200);
  }
  return o;
}

function persistSafe() {
  try { persist(); } catch (e) { _dirty = true; console.warn(`[peerTrust] 저장 실패: ${e?.message || e}`); }
}

/**
 * 승인 — fp 를 주면 그 지문을 승인한다(관리자가 별도 채널로 확인한 지문). 생략하면 대기 지문을, 대기가 없으면 관찰 지문을 승인.
 * 주어진 fp 가 대기·관찰 지문과 다르면 그대로 승인하되(장비 교체 전에 미리 등록) 응답의 `matchedPresented:false` 로 밝힌다.
 */
export function approvePeer(kind, host, port, fp, { by = '', note = '' } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  const st = load();
  const key = peerKey(kind, host, port);
  const [, h, p] = key.split('|');
  if (!h) return { ok: false, error: 'bad-host' };
  const e = st.entries.get(key) || { kind, host: h, port: Number(p), firstSeen: Date.now() };
  const nfp = fp ? normalizeFingerprint(kind, fp) : (e.pending?.fp || e.trusted?.fp || '');
  if (!nfp) return { ok: false, error: fp ? 'bad-fingerprint' : 'nothing-to-approve' };
  const presented = e.pending?.fp || e.trusted?.fp || null;
  const now = Date.now();
  const meta = e.pending?.fp === nfp ? pickMeta(e.pending) : e.trusted?.fp === nfp ? pickMeta(e.trusted) : {};
  const prevFp = e.trusted?.fp && e.trusted.fp !== nfp ? e.trusted.fp : (e.trusted?.prevFp || null);
  e.trusted = { fp: nfp, state: 'approved', at: now, by: String(by || '').slice(0, 64), ...(prevFp ? { prevFp } : {}), ...meta };
  if (e.pending?.fp === nfp) e.pending = null;
  if (Array.isArray(e.rejected)) e.rejected = e.rejected.filter((r) => r.fp !== nfp);
  if (note) e.note = String(note).slice(0, 200);
  pushHistory(e, { at: now, ev: 'approved', fp: nfp, by: String(by || '').slice(0, 64) });
  st.entries.set(key, e);
  persist();
  return { ok: true, key, fp: nfp, matchedPresented: presented == null ? null : presented === nfp };
}

/** 거부 — 대기(또는 주어진) 지문을 거부 목록에 넣는다. 거부된 지문은 정책과 무관하게 통과하지 못한다. */
export function rejectPeer(kind, host, port, fp, { by = '' } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  const st = load();
  const key = peerKey(kind, host, port);
  const e = st.entries.get(key);
  const nfp = fp ? normalizeFingerprint(kind, fp) : (e?.pending?.fp || '');
  if (!e || !nfp) return { ok: false, error: 'nothing-to-reject' };
  const now = Date.now();
  e.rejected = [...(Array.isArray(e.rejected) ? e.rejected : []).filter((r) => r.fp !== nfp), { fp: nfp, at: now, by: String(by || '').slice(0, 64) }].slice(-HISTORY_MAX);
  if (e.pending?.fp === nfp) e.pending = null;
  if (e.trusted?.fp === nfp) e.trusted = null;
  pushHistory(e, { at: now, ev: 'rejected', fp: nfp, by: String(by || '').slice(0, 64) });
  persist();
  return { ok: true, key, fp: nfp };
}

/** 항목 삭제(장비 폐기 등). 다음 연결은 처음 보는 장비로 판정된다. */
export function removePeer(kind, host, port) {
  const st = load();
  const key = peerKey(kind, host, port);
  const had = st.entries.delete(key);
  if (had) persist();
  return { ok: had, key };
}

/** observe 모드에서 쌓인 '관찰' 지문을 한 번에 승인 — enforce 전환 전 단계. 바뀐 지문(대기)은 포함하지 않는다. */
export function approveAllObserved(kind, { by = '' } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  const st = load();
  const now = Date.now();
  let n = 0;
  for (const e of st.entries.values()) {
    if (e.kind !== kind || e.trusted?.state !== 'observed') continue;
    e.trusted = { ...e.trusted, state: 'approved', at: now, by: String(by || '').slice(0, 64), bulk: true };
    pushHistory(e, { at: now, ev: 'approved-bulk', fp: e.trusted.fp, by: String(by || '').slice(0, 64) });
    n++;
  }
  if (n) persist();
  return { ok: true, approved: n };
}

/** 화면용 목록(사본). 상태: approved · observed · pending(대기 지문 있음) · rejected-only. */
export function listPeers({ kind } = {}) {
  const st = load();
  return [...st.entries.values()]
    .filter((e) => !kind || e.kind === kind)
    .map((e) => ({
      ...entryToJson(e),
      state: e.pending ? 'pending' : e.trusted?.state || (Array.isArray(e.rejected) && e.rejected.length ? 'rejected' : 'none'),
    }))
    .sort((a, b) => (a.kind === b.kind ? (a.host < b.host ? -1 : a.host > b.host ? 1 : a.port - b.port) : a.kind < b.kind ? -1 : 1));
}

export function peerTrustStatus() {
  const st = load();
  const out = { loadError: _loadError, kinds: {} };
  for (const kind of PEER_KINDS) {
    const c = { approved: 0, observed: 0, pending: 0, pendingChanged: 0, rejected: 0 };
    for (const e of st.entries.values()) {
      if (e.kind !== kind) continue;
      if (e.trusted?.state === 'approved') c.approved++;
      else if (e.trusted?.state === 'observed') c.observed++;
      if (e.pending) { c.pending++; if (e.pending.reason === 'changed') c.pendingChanged++; }
      if (Array.isArray(e.rejected) && e.rejected.length) c.rejected++;
    }
    out.kinds[kind] = { policy: getPeerPolicy(kind), counts: c };
  }
  return out;
}

/** 테스트 전용 — 메모리 상태를 버린다(다음 호출이 파일을 다시 읽는다). */
export function _resetPeerTrustForTest() { _st = null; _loadError = null; _dirty = false; }
