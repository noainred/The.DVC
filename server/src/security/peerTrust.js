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
 * v2.732(B4-03): **읽기 실패(EACCES 등)도 같은 규칙**이고 닫힌 정책을 곧바로 파일에 남긴다(재시작이 observe 로 내려가지 않게 —
 *   failClosed). 원본을 옮기지 못하면 쓰기를 막는다(`loadError.writeBlocked`).
 *
 * 다중 지문(v2.731 A1-01): 같은 주소(host:port) 뒤에 서버가 여럿인 장비(로드밸런서·DNS 라운드로빈 — 서버마다 자체서명 인증서·
 * 호스트키)는 정상적으로 여러 지문을 낸다. 그래서 항목은 신뢰 지문 **목록**(상한 TRUSTED_MAX)을 갖고 승인은 **추가**다(교체는 명시 옵션
 * replace). 개별 지문은 거부(회수)로 뺀다. observe 의 '처음 보는 장비' 는 여전히 '신뢰 지문이 하나도 없는 항목' 이다 — 지문이 있는 장비가
 * 다른 지문을 내면 정책과 무관하게 거부하고, 관리자가 승인하면 그 지문이 목록에 더해진다(보안 유지).
 * 저장 형식: 첫 지문은 예전과 같은 자리(`trusted` 객체)에, 나머지는 `trustedMore` 배열에 둔다 — 이전 판본으로 되돌려 설치해도
 * 첫 지문은 그대로 읽힌다(나머지만 빠진다). 옛 파일(trusted 객체 1개)은 그대로 읽는다. ⚠ `trusted` 를 배열로 바꾸지 말 것 — 되돌림
 * 설치가 모든 장비를 '지문 변경' 으로 거부한다.
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
import { pushAll } from '../util/pushAll.js';
import { logAudit } from '../audit.js';

export const PEER_KINDS = Object.freeze(['ssh', 'tls']);
export const PEER_MODES = Object.freeze(['enforce', 'observe']);
const DEFAULT_PORT = { ssh: 22, tls: 443 };
const ENV_KEY = { ssh: 'SSH_HOSTKEY_POLICY', tls: 'TLS_PEER_POLICY' };
const MAX_ENTRIES = 20000;
const HISTORY_MAX = 8;
/** 한 장비(주소·포트)에 둘 수 있는 신뢰 지문 수 — 로드밸런서 뒤 서버 수로 충분한 값. 넘기면 승인이 거부된다(오래된 것을 조용히 지우지 않는다). */
export const TRUSTED_MAX = 8;
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
let _saveTimer = null;   // 처음 보는 장비 기록의 디바운스 저장(A6-06)
/** 처음 보는 장비(관찰·승인 대기) 기록을 묶어 쓰는 지연(ms). 관리자 동작·바뀐 지문은 즉시 쓴다. */
const SAVE_DEBOUNCE_MS = 2000;

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
  for (const k of ['trusted', 'trustedMore', 'pending', 'rejected', 'firstSeen', 'lastSeen', 'lastSeenCount', 'note', 'history']) {
    if (e[k] != null) o[k] = e[k];
  }
  return o;
}

/** 항목의 신뢰 지문 목록(사본 배열) — 첫 자리는 `trusted`(옛 판본이 읽는 자리), 나머지는 `trustedMore`. */
function trustedOf(e) {
  const out = [];
  if (e?.trusted && typeof e.trusted === 'object' && !Array.isArray(e.trusted)) out.push(e.trusted);
  if (Array.isArray(e?.trustedMore)) for (const t of e.trustedMore) if (t && typeof t === 'object') out.push(t);
  return out;
}

/** 목록을 저장 자리로 되돌린다(빈 목록이면 trusted=null). */
function setTrusted(e, list) {
  const l = (Array.isArray(list) ? list : []).filter((t) => t && typeof t === 'object');
  e.trusted = l[0] || null;
  if (l.length > 1) e.trustedMore = l.slice(1); else delete e.trustedMore;
}

/**
 * 파일에서 읽은 신뢰 지문 정리 — trusted 가 객체(옛 형식)·배열(손으로 고친 파일) 어느 쪽이어도 받고, 지문 모양이 틀린 것·중복은 버린다.
 * 상한을 넘긴 꼬리는 버리고 그 사실을 콘솔에 남긴다(손으로 고친 파일에서만 생긴다).
 */
function sanitizeTrustedList(kind, e) {
  const raw = [];
  if (Array.isArray(e?.trusted)) pushAll(raw, e.trusted); else if (e?.trusted) raw.push(e.trusted);
  if (Array.isArray(e?.trustedMore)) pushAll(raw, e.trustedMore);
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const fp = normalizeFingerprint(kind, t.fp);
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    if (out.length >= TRUSTED_MAX) { dropped++; continue; }
    out.push({ ...t, fp, state: t.state === 'approved' ? 'approved' : 'observed' });
  }
  if (dropped) console.warn(`[peerTrust] ${kind} ${e?.host}:${e?.port} 신뢰 지문이 상한(${TRUSTED_MAX})을 넘어 ${dropped}개를 읽지 않았습니다.`);
  return out;
}

/**
 * v2.732(점검 2회차 B4-03): 읽지 못한 원본을 옆으로 옮기지 못했으면(원본이 그 자리에 남아 있음) **쓰지 않는다** —
 *   빈 승인 목록으로 원본을 덮으면 승인 지문이 영구히 사라지고 다음 기동이 정책 없는 파일을 '기존 현장' 으로 읽어 observe 로 연다.
 *   관리자 동작(승인·거부·삭제·정책)은 **메모리를 바꾸기 전에** 이 검사로 거절한다(저장 못 한 정책 변경이 메모리에만 남지 않게).
 *   status 409 · code 'peer-trust-unwritable' — 화면은 상태의 loadError.writeBlocked 로 사유를 본다.
 */
function assertWritable() {
  if (!_loadError?.writeBlocked) return;
  const e = new Error('peer-trust.json 을 읽지 못했고 원본을 옆으로 옮기지 못해 저장하지 않습니다 — 파일 권한·소유자를 확인한 뒤 포탈을 재시작하세요');
  e.status = 409; e.code = 'peer-trust-unwritable';
  throw e;
}

function persist() {
  const st = load();
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  assertWritable();
  const obj = { v: 1, policy: st.policy, origin: st.origin, entries: [...st.entries.values()].map(entryToJson) };
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 1), { mode: 0o600 });
  _dirty = false;
}

/**
 * 처음 보는 장비 기록(관찰 'observed-new' · 새 승인 대기 'unknown' · enforce 전환 뒤 'not-approved')은 **묶어서** 쓴다(v2.731 A6-06).
 * 연결 핫패스(TLS 핸드셰이크 직후·SSH hostVerifier)에서 장비마다 파일 전체를 직렬화·fsync 하면 업그레이드·새 설치 직후 첫 수집 주기가
 * 장비 수만큼 전체 쓰기를 한다(재현 1,100대 누적 약 4.9초 · 호출당 최대 25ms — 항목이 늘수록 한 번이 길다).
 * 바뀐 지문('changed' — 보안 사건, 감사 로그와 함께)과 관리자 동작(승인·거부·삭제·정책)은 **즉시** persist 한다.
 * 종료 시에는 exitFlush 가 동기로 쓴다(initPeerTrust 가 등록 — 여기서도 등록해 init 없이 쓰는 경로를 덮는다).
 * 정직 기록: SIGKILL·정전이면 지연 창(SAVE_DEBOUNCE_MS)의 '처음 본' 기록을 잃는다 — 다음 연결이 다시 처음 보는 장비로 판정한다
 * (관찰 정책이면 다시 관찰, 승인 정책이면 다시 대기 — 신뢰가 넓어지지는 않는다).
 */
function persistSoon() {
  _dirty = true;
  if (_loadError?.writeBlocked) return; // v2.732 B4-03 — 쓸 수 없는 동안 연결마다 저장 시도·경고를 쌓지 않는다(기동 경고 1줄이 말한다)
  try { registerExitFlush('peer-trust', () => { if (_dirty) persist(); }); } catch { /* */ }
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; if (_dirty) persistSafe(); }, SAVE_DEBOUNCE_MS);
  _saveTimer.unref?.(); // 종료는 exitFlush 가 맡는다 — 이 타이머가 프로세스를 붙잡지 않게
}

/** 미뤄 둔 기록을 지금 쓴다(동기 — 테스트·종료 경로). 쓸 것이 없으면 아무것도 하지 않는다. */
export function flushPeerTrust() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_dirty && _st) persistSafe();
}

/**
 * v2.732(B4-03): 예전에 손상·읽기 실패로 원본을 옆으로 옮긴 흔적(`peer-trust.json.corrupt.*`)이 있는가.
 * 보존 직후 새 파일을 쓰지 못한 채 재시작하면 파일이 '없음' 으로 보여 decideDefaults 가 기존 현장을 observe 로 열었다 —
 * 흔적이 있으면 승인 목록을 잃은 상태이므로 enforce 로 닫는다(관리자가 화면에서 observe 로 바꿀 수 있다).
 */
function lostTrustTrace() {
  try {
    const base = path.basename(FILE());
    return fs.readdirSync(path.dirname(FILE())).find((n) => n.startsWith(`${base}.corrupt.`)) || null;
  } catch { return null; }
}

function decideDefaults(st) {
  const trace = lostTrustTrace();
  const migration = !trace && existingInstall();
  const now = Date.now();
  for (const kind of PEER_KINDS) {
    if (PEER_MODES.includes(st.policy[kind])) continue;
    st.policy[kind] = trace ? 'enforce' : migration ? 'observe' : 'enforce';
    st.origin[kind] = trace ? { origin: 'load-error', at: now, trace } : { origin: migration ? 'upgrade-migration' : 'new-install', at: now };
  }
}

/**
 * v2.732(점검 2회차 B4-03): 읽기 실패(EACCES 등)와 손상은 **같은 규칙**이다 — 원본을 `preserveCorrupt` 로 옆에 보존하고,
 * 두 종류 정책을 **상태에** enforce(origin 'load-error')로 채운 뒤 곧바로 그 상태를 쓴다. 예전 읽기 실패 갈래는 보존도 정책
 * 기록도 없어 ① 첫 연결 기록(2초 묶음 저장)이 원본을 빈 승인 목록으로 덮었고 ② 다음 기동이 정책 키 없는 파일을 기존 현장으로
 * 판정해 **observe(upgrade-migration)** 로 열었다 — 승인 목록을 잃은 채 관찰로 여는 것이 머리말이 막으려던 바로 그 상황이다.
 * 손상 갈래도 보존 뒤 재시작하면 '파일 없음' 이라 같은 하향이 있었다 → 즉시 기록 + decideDefaults 의 흔적 판정.
 * 원본을 옮기지 못했으면(rename 실패 — 파일이 그 자리에 남음) 쓰기를 막는다(`writeBlocked`) — 원본을 덮지 않는다.
 */
function failClosed(st, code, detail = '') {
  let bak = null;
  try { bak = preserveCorrupt(FILE(), code === 'corrupt' ? 'peer-trust 손상' : `peer-trust 읽기 실패(${detail || code})`); } catch { /* */ }
  let stillThere = false;
  if (!bak) { try { fs.lstatSync(FILE()); stillThere = true; } catch { /* 없음 */ } }
  _loadError = { code, ...(detail ? { detail } : {}), ...(bak ? { preserved: path.basename(bak) } : {}), ...(stillThere ? { writeBlocked: true } : {}) };
  const now = Date.now();
  for (const kind of PEER_KINDS) { st.policy[kind] = 'enforce'; st.origin[kind] = { origin: 'load-error', at: now }; }
  _st = st;
  console.warn(`[peerTrust] peer-trust.json 을 ${code === 'corrupt' ? '해석하지' : `읽지(${detail || code})`} 못했습니다 — `
    + (bak ? `원본을 ${path.basename(bak)} 로 보존했습니다. ` : stillThere ? '원본을 옮기지 못해 이 파일에 쓰지 않습니다(권한 확인 후 재시작). ' : '')
    + '승인 목록이 없으므로 SSH·TLS 모두 승인 지문만 허용(enforce)으로 닫습니다.');
  // 닫힌 정책을 곧바로 남긴다 — 그래야 이후 재시작이 observe 로 내려가지 않는다(원본은 이미 옮겼다).
  if (!stillThere) { try { persist(); } catch (e) { console.warn(`[peerTrust] 닫힌 정책 저장 실패: ${e?.message || e}`); } }
  return st;
}

function load() {
  if (_st) return _st;
  const st = emptyState();
  let raw = null;
  try { raw = fs.readFileSync(FILE(), 'utf8'); } catch (e) {
    if (e?.code !== 'ENOENT') return failClosed(st, 'unreadable', String(e?.code || e?.message || e).slice(0, 120));
  }
  if (raw != null) {
    let obj = null;
    try { obj = JSON.parse(raw); } catch { obj = null; }
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.entries)) return failClosed(st, 'corrupt');
    for (const kind of PEER_KINDS) {
      if (PEER_MODES.includes(obj.policy?.[kind])) st.policy[kind] = obj.policy[kind];
      if (obj.origin?.[kind] && typeof obj.origin[kind] === 'object') st.origin[kind] = obj.origin[kind];
    }
    for (const e of obj.entries) {
      if (!e || typeof e !== 'object' || !PEER_KINDS.includes(e.kind)) continue;
      const key = peerKey(e.kind, e.host, e.port);
      const { seenCount, ...rest } = e; // 옛 이름(seenCount) → lastSeenCount(실행 필드 — 백업 지문 제외)
      const ent = { ...rest, ...(rest.lastSeenCount == null && seenCount != null ? { lastSeenCount: seenCount } : {}), host: normalizePeerHost(e.host), port: normPort(e.kind, e.port) };
      setTrusted(ent, sanitizeTrustedList(e.kind, e)); // 옛 형식(trusted 객체 1개)·새 형식(+trustedMore) 둘 다
      st.entries.set(key, ent);
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
  assertWritable(); // v2.732 B4-03 — 저장할 수 없으면 메모리를 바꾸기 전에 거절
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
  const victims = [...st.entries.entries()].filter(([, e]) => !trustedOf(e).some((t) => t.state === 'approved'))
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
  const list = trustedOf(e);
  const t = list.find((x) => x.fp === nfp);
  if (t) {
    if (t.state === 'approved') { _dirty = true; return { ok: true, reason: 'approved', mode, key }; }
    if (mode === 'observe') { _dirty = true; return { ok: true, reason: 'observed', mode, key }; }
    // enforce 로 바뀐 뒤의 관찰 지문 — 승인 전에는 통과시키지 않는다.
    const had = e.pending && e.pending.fp === nfp;
    setPending(e, nfp, 'not-approved', m, now);
    if (had) _dirty = true; else persistSoon(); // 정책 전환 직후 장비마다 전체 쓰기를 하지 않게(A6-06)
    return { ok: false, reason: 'not-approved', mode, key };
  }
  // observe 의 '처음 보는 장비' 는 신뢰 지문이 하나도 없는 항목뿐이다 — 지문이 있는 장비의 다른 지문(두 번째 서버·교체·가로채기)은
  // 정책과 무관하게 거부하고 관리자 승인(추가)을 기다린다(v2.731 A1-01 — 승인하면 목록에 더해져 둘 다 통과한다).
  if (!list.length && mode === 'observe') {
    setTrusted(e, [{ fp: nfp, state: 'observed', at: now, ...m }]);
    e.pending = null;
    pushHistory(e, { at: now, ev: 'observed', fp: nfp });
    capEntries(st);
    persistSoon(); // 처음 보는 장비 — 묶어서 쓴다(A6-06)
    console.warn(`[peerTrust] ${kind} ${e.host}:${e.port} 지문을 처음 관찰했습니다(미승인 · observe 모드) ${nfp}`);
    return { ok: true, reason: 'observed-new', mode, key };
  }
  const reason = list.length ? 'changed' : 'unknown';
  const already = e.pending && e.pending.fp === nfp;
  setPending(e, nfp, reason, m, now);
  if (isNew) capEntries(st);
  if (!already) {
    // 바뀐 지문은 보안 사건이라 즉시 쓴다(감사 로그와 같은 순간). 처음 보는 장비(unknown)는 묶어서 쓴다(A6-06).
    if (reason === 'changed') persistSafe(); else persistSoon();
    console.warn(`[peerTrust] ${kind} ${e.host}:${e.port} ${reason === 'changed' ? '지문이 바뀌었습니다' : '승인되지 않은 지문입니다'} — 연결을 거부했습니다(관리자 승인 필요) ${nfp}`);
    // 그룹 H(S-01 '키 교체 감사'): 승인(또는 관찰)된 지문과 다른 지문은 보안 사건이다 — 감사 로그에도 남긴다(대기 지문마다 1회).
    //   처음 보는 장비(unknown)는 운영 사건이라 이력·콘솔에만 둔다(새 설치에서 장비마다 감사 줄이 쌓이지 않게).
    if (reason === 'changed') {
      try {
        logAudit({ user: 'system', action: '장비 키 변경 감지(연결 거부)', target: `${kind} ${e.host}:${e.port}`, detail: `신뢰 ${list.map((x) => `${x.fp}(${x.state})`).join(', ')} → 제시 ${nfp}` });
      } catch { /* 감사 기록 실패가 판정을 바꾸지 않는다 */ }
    }
  } else _dirty = true;
  return { ok: false, reason, mode, key };
}

/**
 * **읽기 전용** 판정(그룹 H) — 상태를 바꾸지 않고 '지금 연결하면 어떻게 되는가' 만 말한다. 통신 점검(linkcheck)처럼
 * 인증 없이 키만 보고 끊는 경로가 쓴다: 그 경로가 checkPeer 를 부르면 5분 주기 점검이 IP 키로 '관찰' 항목을 쌓고
 * (수집기는 이름으로 접속한다) observe 모드의 TOFU 를 점검이 대신 해 버린다.
 * 반환 { state, wouldPass, mode, key, trustedFp, trustedFps }  (trustedFp = 첫 신뢰 지문 — 예전 호출부 호환, trustedFps = 전부)
 *   state: 'approved' | 'observed' | 'changed' | 'pending' | 'rejected' | 'unknown' | 'bad-fingerprint'
 */
export function peekPeer(kind, host, port, fp) {
  if (!PEER_KINDS.includes(kind)) throw new TypeError(`unknown peer kind: ${kind}`);
  const nfp = normalizeFingerprint(kind, fp);
  const key = peerKey(kind, host, port);
  const { mode } = getPeerPolicy(kind);
  if (!nfp) return { state: 'bad-fingerprint', wouldPass: false, mode, key, trustedFp: null, trustedFps: [] };
  const e = load().entries.get(key);
  const list = trustedOf(e);
  const trustedFps = list.map((x) => x.fp);
  const trustedFp = trustedFps[0] || null;
  const out = (state, wouldPass) => ({ state, wouldPass, mode, key, trustedFp, trustedFps });
  if (!e) return out('unknown', mode === 'observe');
  if ((Array.isArray(e.rejected) ? e.rejected : []).some((r) => r.fp === nfp)) return out('rejected', false);
  const t = list.find((x) => x.fp === nfp);
  if (t) {
    const st = t.state === 'approved' ? 'approved' : 'observed';
    return out(st, st === 'approved' || mode === 'observe');
  }
  if (list.length) return out('changed', false);
  if (e.pending && e.pending.fp === nfp) return out('pending', mode === 'observe');
  return out('unknown', mode === 'observe');
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
 *
 * v2.731(A1-01): 승인은 **추가**다 — 이미 승인·관찰된 다른 지문을 지우지 않는다(로드밸런서 뒤 서버마다 지문이 다르다).
 *   `replace:true` 면 교체(키 교체) — 그 지문 하나만 남기고 나머지는 신뢰하지 않는다(거부 목록에는 넣지 않는다 — 다시 보이면 '바뀐 지문').
 *   목록이 TRUSTED_MAX 에 찼는데 새 지문을 더하면 `trusted-full` — 오래된 지문을 조용히 지우지 않는다(지울 지문은 관리자가 거부로 회수한다).
 * 반환: { ok, key, fp, matchedPresented, trustedCount, added, already, replaced[] }
 */
export function approvePeer(kind, host, port, fp, { by = '', note = '', replace = false } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  const st = load();
  assertWritable(); // v2.732 B4-03 — 저장할 수 없으면 메모리를 바꾸기 전에 거절
  const key = peerKey(kind, host, port);
  const [, h, p] = key.split('|');
  if (!h) return { ok: false, error: 'bad-host' };
  const e = st.entries.get(key) || { kind, host: h, port: Number(p), firstSeen: Date.now() };
  const list = trustedOf(e);
  const nfp = fp ? normalizeFingerprint(kind, fp)
    : (e.pending?.fp || list.find((t) => t.state === 'observed')?.fp || list[0]?.fp || '');
  if (!nfp) return { ok: false, error: fp ? 'bad-fingerprint' : 'nothing-to-approve' };
  const presented = e.pending?.fp || list[0]?.fp || null;
  const now = Date.now();
  const who = String(by || '').slice(0, 64);
  const existing = list.find((t) => t.fp === nfp) || null;
  const meta = e.pending?.fp === nfp ? pickMeta(e.pending) : existing ? pickMeta(existing) : {};
  let next;
  let replaced = [];
  let already = false;
  if (replace) {
    replaced = list.map((t) => t.fp).filter((x) => x !== nfp);
    const prevFp = replaced[0] || existing?.prevFp || null;
    next = [{ fp: nfp, state: 'approved', at: now, by: who, ...(prevFp ? { prevFp } : {}), ...meta }];
  } else if (existing) {
    already = existing.state === 'approved';
    next = list.map((t) => (t.fp === nfp && !already ? { ...t, state: 'approved', at: now, by: who, ...meta } : t));
  } else {
    if (list.length >= TRUSTED_MAX) return { ok: false, error: 'trusted-full', max: TRUSTED_MAX, key, trustedCount: list.length };
    next = [...list, { fp: nfp, state: 'approved', at: now, by: who, ...meta }];
  }
  setTrusted(e, next);
  if (e.pending?.fp === nfp) e.pending = null;
  if (Array.isArray(e.rejected)) e.rejected = e.rejected.filter((r) => r.fp !== nfp);
  if (note) e.note = String(note).slice(0, 200);
  pushHistory(e, { at: now, ev: replace ? 'approved-replace' : 'approved', fp: nfp, by: who, ...(replaced.length ? { replaced: replaced.slice(0, TRUSTED_MAX) } : {}) });
  st.entries.set(key, e);
  persist();
  return {
    ok: true, key, fp: nfp,
    matchedPresented: presented == null ? null : (e.pending?.fp === nfp || presented === nfp || !!existing),
    trustedCount: next.length, added: !existing, already, replaced,
  };
}

/**
 * 거부 — 대기(또는 주어진) 지문을 거부 목록에 넣는다. 거부된 지문은 정책과 무관하게 통과하지 못한다.
 * 신뢰 목록에 있던 지문이면 **그 지문만** 회수한다(같은 주소의 다른 승인 지문은 그대로 — v2.731 A1-01). 응답 `revoked` 가 그 사실을 말한다.
 */
export function rejectPeer(kind, host, port, fp, { by = '' } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  const st = load();
  assertWritable(); // v2.732 B4-03 — 저장할 수 없으면 메모리를 바꾸기 전에 거절
  const key = peerKey(kind, host, port);
  const e = st.entries.get(key);
  const nfp = fp ? normalizeFingerprint(kind, fp) : (e?.pending?.fp || '');
  if (!e || !nfp) return { ok: false, error: 'nothing-to-reject' };
  const now = Date.now();
  e.rejected = [...(Array.isArray(e.rejected) ? e.rejected : []).filter((r) => r.fp !== nfp), { fp: nfp, at: now, by: String(by || '').slice(0, 64) }].slice(-HISTORY_MAX);
  if (e.pending?.fp === nfp) e.pending = null;
  const list = trustedOf(e);
  const revoked = list.some((t) => t.fp === nfp);
  if (revoked) setTrusted(e, list.filter((t) => t.fp !== nfp));
  pushHistory(e, { at: now, ev: revoked ? 'revoked' : 'rejected', fp: nfp, by: String(by || '').slice(0, 64) });
  persist();
  return { ok: true, key, fp: nfp, revoked, trustedCount: trustedOf(e).length };
}

/** 항목 삭제(장비 폐기 등). 다음 연결은 처음 보는 장비로 판정된다. */
export function removePeer(kind, host, port) {
  const st = load();
  assertWritable(); // v2.732 B4-03 — 저장할 수 없으면 메모리를 바꾸기 전에 거절
  const key = peerKey(kind, host, port);
  const had = st.entries.delete(key);
  if (had) persist();
  return { ok: had, key };
}

/** observe 모드에서 쌓인 '관찰' 지문을 한 번에 승인 — enforce 전환 전 단계. 바뀐 지문(대기)은 포함하지 않는다. */
export function approveAllObserved(kind, { by = '' } = {}) {
  if (!PEER_KINDS.includes(kind)) return { ok: false, error: 'unknown-kind' };
  const st = load();
  assertWritable(); // v2.732 B4-03 — 저장할 수 없으면 메모리를 바꾸기 전에 거절
  const now = Date.now();
  let n = 0;
  const who = String(by || '').slice(0, 64);
  for (const e of st.entries.values()) {
    if (e.kind !== kind) continue;
    const list = trustedOf(e);
    if (!list.some((t) => t.state === 'observed')) continue;
    setTrusted(e, list.map((t) => {
      if (t.state !== 'observed') return t;
      pushHistory(e, { at: now, ev: 'approved-bulk', fp: t.fp, by: who });
      n++;
      return { ...t, state: 'approved', at: now, by: who, bulk: true };
    }));
  }
  if (n) persist();
  return { ok: true, approved: n };
}

/**
 * 항목 상태(화면·개수 공용): pending(대기 지문 있음) > observed(미승인 관찰 지문이 하나라도) > approved > rejected-only > none.
 * 승인 지문이 여럿이어도 관찰(미승인) 지문이 남아 있으면 '관찰' 이다 — 초록으로 칠하지 않는다.
 */
function entryState(e) {
  if (e.pending) return 'pending';
  const list = trustedOf(e);
  if (list.some((t) => t.state === 'observed')) return 'observed';
  if (list.some((t) => t.state === 'approved')) return 'approved';
  return Array.isArray(e.rejected) && e.rejected.length ? 'rejected' : 'none';
}

/** 화면용 목록(사본). `trustedList` = 신뢰 지문 전부(첫 자리 = `trusted`). */
export function listPeers({ kind } = {}) {
  const st = load();
  return [...st.entries.values()]
    .filter((e) => !kind || e.kind === kind)
    .map((e) => ({
      ...entryToJson(e),
      trustedList: trustedOf(e).map((t) => ({ ...t })),
      state: entryState(e),
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
      // 장비(항목) 단위 — 미승인 관찰 지문이 하나라도 있으면 '관찰', 아니면 승인 지문이 있으면 '승인'(목록 상태와 같은 우선순위).
      const tl = trustedOf(e);
      if (tl.some((t) => t.state === 'observed')) c.observed++;
      else if (tl.some((t) => t.state === 'approved')) c.approved++;
      if (e.pending) { c.pending++; if (e.pending.reason === 'changed') c.pendingChanged++; }
      if (Array.isArray(e.rejected) && e.rejected.length) c.rejected++;
    }
    out.kinds[kind] = { policy: getPeerPolicy(kind), counts: c };
  }
  return out;
}

/*
 * ── 승인 노드(v2.731 A1-02) ──────────────────────────────────────────────────────────────────────────────
 * peer-trust.json 은 노드(중앙·엣지)마다 따로이고 노드 사이에 승인·보고 경로가 없다. 엣지가 접속하는 장비의 거부 문구는
 * 엣지에서 만들어져 스냅샷 오류로 중앙 화면에 그대로 실리는데, 예전 문구는 '설정 › 장비 신뢰에서 승인' 만 말해서 중앙 관리자가
 * 중앙 화면을 열면 그 장비가 없었다. 거부 문구(proxy/sshExec.js·security/tlsTrust.js)가 이 함수로 '어느 노드에서 승인하는가' 를 싣는다.
 * 엣지 판정 = CENTRAL_URL 설정(config.agent.centralUrl — 중앙으로 push·pull 하는 노드). 이름 = config.agent.name(AGENT_NAME·호스트명).
 * ⚠ 이름에 인증 실패 판정 낱말(401·403·404·인증·auth·permission·invalid·incorrect·login)이 있으면 **이름을 싣지 않는다** —
 *   SSH 문구에 호스트명을 넣지 않는 것과 같은 이유(sshExec 머리말: 문구 판정 \b403\b 등이 수집을 '인증 정지' 시킬 수 있다.
 *   authGuard 는 표지를 먼저 보지만 redfish·errors 처럼 문구만 보는 판정이 남아 있다). 제어 문자는 지우고 64자로 자른다.
 */
const RISKY_NODE_NAME_RE = /\b40[134]\b|인증|auth|permission|invalid|incorrect|login/i;

/** 이 노드가 엣지인가와 문구에 실을 수 있는 이름. 이름을 실을 수 없으면 name:null(지어내지 않는다). */
export function peerApproveNode() {
  const edge = !!String(config.agent?.centralUrl || '').trim();
  if (!edge) return { edge: false, name: null };
  let n = String(config.agent?.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (n.length > 64) n = `${n.slice(0, 64)}…`;
  return { edge: true, name: n && !RISKY_NODE_NAME_RE.test(n) ? n : null };
}

/**
 * 거부 문구용 — { edge, name, text, note }.
 *   text: '이 포탈의 설정 › 장비 신뢰(…)' 또는 '엣지 ‘X’ 포탈의 설정 › 장비 신뢰(…)'
 *   note: 엣지면 '중앙 포탈에서는 승인할 수 없습니다' 를 포함한 한 문장, 중앙이면 ''
 * ⚠ 문구에 '설정 › 장비 신뢰' 를 유지할 것(테스트·화면 안내가 그 글자로 찾는다). 표지 문자열은 호출부가 붙인다.
 */
export function peerApproveWhere() {
  const n = peerApproveNode();
  if (!n.edge) return { ...n, text: '이 포탈의 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서)', note: '' };
  return {
    ...n,
    text: `엣지 ${n.name ? `‘${n.name}’ ` : ''}포탈의 설정 › 장비 신뢰(SSH 호스트키·TLS 인증서)`,
    note: '이 장비는 그 엣지가 접속하므로 중앙 포탈에서는 승인할 수 없습니다',
  };
}

/** 테스트 전용 — 메모리 상태를 버린다(다음 호출이 파일을 다시 읽는다). */
export function _resetPeerTrustForTest() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _st = null; _loadError = null; _dirty = false;
}
