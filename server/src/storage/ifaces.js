/**
 * storage/ifaces.js — Unity SAN · NAS 인터페이스(포트 구성 · 링크 속도 · 처리량 판정)의 순수 규칙(v3.35.0).
 *
 * 사용자 요청(2026-11-23): "유니티 스토리지의 SAN/NAS 인터페이스의 속도 사용량 모니터링/트래킹" — 설계 · 시안 `docs/design/unity-iface/`.
 * 컨펌(2026-11-23 15:17 KST): 표준 검증 · **구성은 SSH 도 읽고 사용량은 REST 장비만** · 알림 포함 · 나머지 기본값.
 *
 * 이 모듈이 갖는 것(DB · 네트워크를 모른다 — 테스트가 고정):
 *  ① 구성 파서 — Unisphere REST(fcPort · ethernetPort · iscsiPortal · fileInterface)와 uemcli(/net/port/fc · /net/port/eth · /net/if)를
 *     **한 모양**(`extra.ifaces`)으로 바꾼다.
 *  ② 판정 하나 — 속도 저하 · 링크 다운 · 미연결 · 포화 근접 · 유휴 · 사용량 못 읽음(서버 · 화면 · 알림이 같은 함수를 쓴다).
 *  ③ 엣지 정제 — 중앙이 받은 `extra.ifaces` 를 아는 필드 · 상한 · 수치로 좁힌다(`central/storageEdge.js narrowStorageSnapshot`).
 *  ④ 변화 비교 — 직전 포트 상태와 비교해 속도 · 링크 변화를 뽑는다(저장은 `storage/db.js saveIfaceState`).
 *
 * ⚠⚠ 정직 기록 — **실장비 미확인**: REST 필드 이름(currentSpeed · requestedSpeed · availableSpeeds · isLinkUp …)과 uemcli 키
 *   (Speed · Requested speed · Available speeds · Health details …)는 Unisphere REST/CLI 문서 지식이 근거이고 이 저장소에서 실장비 출력으로
 *   확인한 적이 없다(arrayPerf.js Unity · LUN 파서 v2.789 와 같은 수준). 그래서 못 읽은 값은 null 로 두고, 왜 비었는지는 `probe` 가 말한다.
 *   첫 실장비 수집의 CLI 원문 · probe 를 보고 파서만 맞추면 된다(설계 문서 §7).
 *
 * 규칙(CLAUDE.md):
 *  - 못 읽은 값은 0 이 아니다(numOrNull). 링크 상태를 모르면 `linkUp:null` — 다운도 정상도 아니다.
 *  - 사용률 = **읽기 · 쓰기(받음 · 보냄) 중 큰 쪽 ÷ 링크 속도**. 링크 용량은 `속도(Gb/s) × 1e9 ÷ 8` 바이트/초 —
 *    SAN 포트 사용량의 `capBpsOf` 와 같은 환산이다(두 화면의 분모를 맞춘다). 송수신 합이 아니라 큰 쪽이라 100% 를 넘지 않는 것이 정상이다.
 *  - 외부 입력(장비 출력) 정규식은 앵커 + 길이를 먼저 자르고 선형으로.
 */
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';
import { parseUemcli, healthOf } from './collectors/uemcliParse.js';

/** 인터페이스 화면 · 수집을 지원하는 타입(1차는 Unity 만 — 사용자 선택). */
export const IFACE_TYPES = Object.freeze(['unity480']);
export const isIfaceType = (t) => IFACE_TYPES.includes(String(t || ''));
export const IFACE_PORT_MAX = 96;
export const IFACE_IF_MAX = 128;
/** 판정 기준 기본값 — 화면에 숫자를 박지 않고 API 가 이 값을 내려 준다(설정은 알림 규칙 임계를 따른다). */
export const IFACE_DEFAULTS = Object.freeze({ busyPct: 80, idlePct: 1 });
/** 포트 종류 · 인터페이스 종류. */
export const PORT_KINDS = Object.freeze(['fc', 'eth']);
export const IF_KINDS = Object.freeze(['iscsi', 'nas', 'other']);

const s = (v, max = 128) => (typeof v === 'string' ? capStr(v.trim(), max) : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));
const lower = (v) => s(v, 200).toLowerCase();

/* ── 속도 해석(순수) ───────────────────────────────────────────────────── */
/**
 * 속도 글자 → Gb/s. `16 Gbps` · `10 Gbps` · `1000 Mbps` · `25G` · `8 Gb/s`. 'auto' · 빈 값 · 모르는 꼴은 null(0 이 아니다).
 * 입력은 40자로 먼저 자른다(외부 입력 — 앵커 있는 선형 정규식).
 */
export function speedTextGbps(v) {
  const t = s(v, 40).toLowerCase();
  if (!t) return null;
  const m = /^(\d{1,6}(?:\.\d{1,3})?)\s?(g|m|k)?(?:bps|b\/s|bit\/s|b)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const unit = m[2] || 'g';
  const g = unit === 'g' ? n : unit === 'm' ? n / 1000 : n / 1e6;
  return g > 0 && g <= 1000 ? Math.round(g * 1000) / 1000 : null;
}
/** 목록 글자(`4 Gbps, 8 Gbps, 16 Gbps, auto`)의 가장 큰 속도 — 하나도 못 읽으면 null. 원소 상한 16. */
export function maxSpeedOfList(v) {
  const items = Array.isArray(v) ? v : s(v, 400).split(',');
  let best = null;
  for (const x of items.slice(0, 16)) {
    const g = typeof x === 'number' ? null : speedTextGbps(x);
    if (g != null && (best == null || g > best)) best = g;
  }
  return best;
}
/** 요청 속도 — 'auto'(자동 협상) · 수(Gb/s) · 모름(null). */
export function requestedOf(v) {
  const t = lower(v);
  if (!t) return null;
  if (t === 'auto' || t.startsWith('auto')) return 'auto';
  return speedTextGbps(t);
}
/**
 * REST 수치 enum → Gb/s(⚠ 문서 지식 — 실장비 미확인). FC 는 `FcSpeedEnum`(Auto 0 · 1 · 2 · 4 · 8 · 16 · 32 = Gb/s),
 * 이더넷은 `EthernetPortSpeedEnum`(Auto 0 · 10 · 100 · 1000 · 10000 · 25000 · 40000 · 100000 = Mb/s). 0 은 'auto'(요청) · 값 없음(현재).
 */
export function restSpeedGbps(v, kind) {
  const n = numOrNull(v);
  if (n == null || n <= 0) return null;
  const g = kind === 'eth' ? n / 1000 : n;
  return g > 0 && g <= 1000 ? g : null;
}
export function restRequested(v, kind) {
  const n = numOrNull(v);
  if (n == null) return null;
  if (n === 0) return 'auto';
  return restSpeedGbps(n, kind);
}
/** 링크 용량(바이트/초) — SAN 포트 사용량 `capBpsOf` 와 같은 환산(Gb/s × 1e9 ÷ 8). 속도를 모르면 null. */
export function linkBytesPs(speedGbps) {
  const g = numOrNull(speedGbps);
  return g != null && g > 0 ? (g * 1e9) / 8 : null;
}
/** 사용률(%) — 받음 · 보냄(bps) 중 큰 쪽 ÷ 링크 속도. 둘 다 모르거나 속도를 모르면 null. 한쪽만 읽혔으면 그쪽으로(최소값). */
export function utilPct(inBps, outBps, speedGbps) {
  const g = numOrNull(speedGbps);
  const a = numOrNull(inBps); const b = numOrNull(outBps);
  if (g == null || !(g > 0) || (a == null && b == null)) return null;
  const big = Math.max(a ?? 0, b ?? 0);
  return Math.round((big / (g * 1e9)) * 1000) / 10;
}

/* ── 링크 상태(순수) ────────────────────────────────────────────────────── */
const DOWN_RE = /link (?:is )?down|link down|not connected|no link|disconnected|cable/;
const EMPTY_RE = /(?:no|not|missing) sfp|sfp (?:is )?(?:not present|missing|removed)|not installed|not present/;
/**
 * 링크 상태 추론 — 명시값(isLinkUp)이 있으면 그것, 없으면 상태 설명 글자 · 현재 속도로. 모르면 null.
 * @returns {{linkUp:boolean|null, sfp:'present'|'absent'|null}}
 */
export function linkStateOf({ isLinkUp = null, speedGbps = null, detail = '' } = {}) {
  const d = lower(detail);
  const sfp = d && EMPTY_RE.test(d) ? 'absent' : null;
  if (typeof isLinkUp === 'boolean') return { linkUp: isLinkUp, sfp };
  if (d && (DOWN_RE.test(d) || sfp)) return { linkUp: false, sfp };
  if (numOrNull(speedGbps) > 0) return { linkUp: true, sfp };
  return { linkUp: null, sfp };
}
/** 상태 단어 → ok/bad/unknown 가까운 짧은 단어(화면 · 판정이 쓴다). uemcli `OK (5)` · REST 단어(unityHealthWord) 둘 다. */
export function healthWordOf(v) {
  const t = healthOf(lower(v));
  if (!t) return '';
  if (/^ok\b/.test(t) || t === 'healthy' || t === 'ok_but') return 'ok';
  return capStr(t, 40);
}

const spOf = (id, sp) => {
  const v = lower(sp && typeof sp === 'object' ? sp.id : sp);
  if (/^sp[ab]$/.test(v)) return v;
  const m = /^(sp[ab])_/.exec(lower(id));
  return m ? m[1] : (v ? capStr(v, 16) : '');
};

/* ── 구성 파서: uemcli(순수) ───────────────────────────────────────────── */
/** `uemcli /net/port/fc show -detail` → FC 포트 배열. 근거 키가 없는 레코드(ID 없음)는 버린다. */
export function parseUemcliFcPorts(text) {
  const out = [];
  for (const r of parseUemcli(text)) {
    const id = s(r.ID, 64);
    if (!id) continue;
    const speedGbps = speedTextGbps(r.Speed ?? r['Current speed']);
    const detail = s(r['Health details'], 300);
    const ls = linkStateOf({ speedGbps, detail });
    out.push({
      id, name: s(r.Name, 80) || id, kind: 'fc', sp: spOf(id, r.SP),
      speedGbps: ls.linkUp === false ? null : speedGbps,
      requested: requestedOf(r['Requested speed']),
      maxGbps: maxSpeedOfList(r['Available speeds'] ?? r['Supported speeds']),
      linkUp: ls.linkUp, sfp: ls.sfp, health: healthWordOf(r['Health state']), healthDetail: detail,
      wwn: s(r.WWN, 64), mtu: null, protocols: 'fc', role: s(r.Role, 32),
    });
  }
  return out;
}
/** `uemcli /net/port/eth show -detail` → 이더넷 포트 배열(관리 · 백엔드 포트도 그대로 담고 role 로 구분한다). */
export function parseUemcliEthPorts(text) {
  const out = [];
  for (const r of parseUemcli(text)) {
    const id = s(r.ID, 64);
    if (!id) continue;
    const speedGbps = speedTextGbps(r.Speed ?? r['Current speed']);
    const detail = s(r['Health details'], 300);
    const linkRaw = lower(r['Link status'] ?? r.Link);
    const isLinkUp = linkRaw === 'up' ? true : linkRaw === 'down' ? false : null;
    const ls = linkStateOf({ isLinkUp, speedGbps, detail });
    out.push({
      id, name: s(r.Name, 80) || id, kind: 'eth', sp: spOf(id, r.SP),
      speedGbps: ls.linkUp === false ? null : speedGbps,
      requested: requestedOf(r['Requested speed']),
      maxGbps: maxSpeedOfList(r['Supported speeds'] ?? r['Available speeds']),
      linkUp: ls.linkUp, sfp: ls.sfp, health: healthWordOf(r['Health state']), healthDetail: detail,
      wwn: '', mtu: numOrNull(r['MTU size'] ?? r.MTU), protocols: s(r.Protocols, 80), role: s(r.Role, 32),
    });
  }
  return out;
}
/** `uemcli /net/if show -detail` → 인터페이스 배열(Type 이 iscsi · file 인 것). IP 가 없으면 버리지 않는다(빈 칸). */
export function parseUemcliIfs(text) {
  const out = [];
  for (const r of parseUemcli(text)) {
    const id = s(r.ID, 64);
    const port = s(r.Port, 64);
    if (!id || !port) continue;
    const type = lower(r.Type);
    const kind = type === 'iscsi' ? 'iscsi' : (type === 'file' || type === 'nas' || s(r['NAS server'])) ? 'nas' : 'other';
    out.push({ id, kind, port, ip: s(r['IP address'], 64), vlan: numOrNull(r['VLAN ID']), nasServer: s(r['NAS server'], 80), role: s(r.Role, 32) });
  }
  return out;
}

/* ── 구성 파서: REST(순수) ─────────────────────────────────────────────── */
const entries = (v) => (Array.isArray(v?.entries) ? v.entries : []).map((e) => e?.content || {}).filter((c) => c && typeof c === 'object');
const restHealthWord = (h) => {
  const v = numOrNull(h?.value);
  if (v == null) return '';
  if (v === 5 || v === 7) return 'ok';
  return ({ 0: 'unknown', 10: 'degraded', 15: 'minor', 20: 'major', 25: 'critical', 30: 'non_recoverable' })[v] || `health:${v}`;
};
const restHealthDetail = (h) => (Array.isArray(h?.descriptions) ? h.descriptions.slice(0, 3).map((x) => s(x, 200)).filter(Boolean).join(' · ') : '');
const restList = (v, kind) => (Array.isArray(v) ? v.slice(0, 16).map((x) => restSpeedGbps(x, kind)).filter((x) => x != null) : []);

export function restFcPorts(json) {
  return entries(json).map((c) => {
    const id = s(c.id, 64);
    if (!id) return null;
    const speedGbps = restSpeedGbps(c.currentSpeed, 'fc');
    const detail = restHealthDetail(c.health);
    const ls = linkStateOf({ isLinkUp: typeof c.isLinkUp === 'boolean' ? c.isLinkUp : null, speedGbps, detail });
    const sp = restList(c.availableSpeeds, 'fc');
    return { id, name: s(c.name, 80) || id, kind: 'fc', sp: spOf(id, c.storageProcessor),
      speedGbps: ls.linkUp === false ? null : speedGbps, requested: restRequested(c.requestedSpeed, 'fc'),
      maxGbps: sp.length ? Math.max(...sp) : null, linkUp: ls.linkUp, sfp: ls.sfp,
      health: restHealthWord(c.health), healthDetail: detail, wwn: s(c.wwn, 64), mtu: null, protocols: 'fc', role: '' };
  }).filter(Boolean);
}
export function restEthPorts(json) {
  return entries(json).map((c) => {
    const id = s(c.id, 64);
    if (!id) return null;
    const speedGbps = restSpeedGbps(c.speed, 'eth');
    const detail = restHealthDetail(c.health);
    const ls = linkStateOf({ isLinkUp: typeof c.isLinkUp === 'boolean' ? c.isLinkUp : null, speedGbps, detail });
    const sp = restList(c.supportedSpeeds, 'eth');
    return { id, name: s(c.name, 80) || id, kind: 'eth', sp: spOf(id, c.storageProcessor),
      speedGbps: ls.linkUp === false ? null : speedGbps, requested: restRequested(c.requestedSpeed, 'eth'),
      maxGbps: sp.length ? Math.max(...sp) : null, linkUp: ls.linkUp, sfp: ls.sfp,
      health: restHealthWord(c.health), healthDetail: detail, wwn: '', mtu: numOrNull(c.mtu), protocols: '', role: '' };
  }).filter(Boolean);
}
export function restIscsiIfs(json) {
  return entries(json).map((c) => {
    const id = s(c.id, 64); const port = s(c.ethernetPort?.id ?? c.ethernetPort, 64);
    return id && port ? { id, kind: 'iscsi', port, ip: s(c.ipAddress, 64), vlan: numOrNull(c.vlanId), nasServer: '', role: '' } : null;
  }).filter(Boolean);
}
export function restFileIfs(json) {
  return entries(json).map((c) => {
    const id = s(c.id, 64); const port = s(c.ipPort?.id ?? c.ipPort, 64);
    const role = numOrNull(c.role);
    return id && port ? { id, kind: 'nas', port, ip: s(c.ipAddress, 64), vlan: numOrNull(c.vlanId),
      nasServer: s(c.nasServer?.name ?? c.nasServer?.id ?? c.nasServer, 80), role: role === 0 ? 'production' : role === 1 ? 'backup' : '' } : null;
  }).filter(Boolean);
}

/* ── 조립 · 정제(순수) ──────────────────────────────────────────────────── */
const PROBE_STATES = Object.freeze(['ok', 'failed', 'skipped', 'unparsed']);
/** 종류별 수집 결과 한 줄 — `{ state, count?, detail?, source }`. */
export function ifaceProbe(state, { source = '', count = null, detail = '' } = {}) {
  return { state: PROBE_STATES.includes(state) ? state : 'failed', source: s(source, 120),
    ...(count != null ? { count: numOrNull(count) } : {}), ...(detail ? { detail: s(detail, 200) } : {}) };
}
function cleanPort(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const id = s(p.id, 64);
  if (!id) return null;
  const kind = PORT_KINDS.includes(p.kind) ? p.kind : null;
  if (!kind) return null;
  const req = p.requested === 'auto' ? 'auto' : numOrNull(p.requested);
  const g = (v) => { const n = numOrNull(v); return n != null && n > 0 && n <= 1000 ? n : null; };
  return {
    id, name: s(p.name, 80) || id, kind, sp: s(p.sp, 16),
    speedGbps: g(p.speedGbps), requested: req === 'auto' ? 'auto' : g(req), maxGbps: g(p.maxGbps),
    linkUp: typeof p.linkUp === 'boolean' ? p.linkUp : null, sfp: p.sfp === 'absent' || p.sfp === 'present' ? p.sfp : null,
    health: s(p.health, 40), healthDetail: s(p.healthDetail, 300), wwn: s(p.wwn, 64),
    mtu: (() => { const n = numOrNull(p.mtu); return n != null && n > 0 && n < 100000 ? n : null; })(),
    protocols: s(p.protocols, 80), role: s(p.role, 32),
  };
}
function cleanIf(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const id = s(x.id, 64); const port = s(x.port, 64);
  if (!id || !port) return null;
  const vlan = numOrNull(x.vlan);
  return { id, kind: IF_KINDS.includes(x.kind) ? x.kind : 'other', port, ip: s(x.ip, 64).replace(/[^\x21-\x7e]/g, ''),
    vlan: vlan != null && Number.isInteger(vlan) && vlan >= 0 && vlan <= 4095 ? vlan : null, nasServer: s(x.nasServer, 80), role: s(x.role, 32) };
}
/**
 * 수집 결과 → `extra.ifaces`(순수). 같은 id 는 처음 것만 · 상한(넘으면 뺀 수를 밝힌다). 포트도 인터페이스도 없고 probe 만 있으면
 * ports:[] 로 싣는다 — '읽었는데 0개' 와 '못 읽음' 은 probe 가 가른다.
 * @returns {{at:number, source:string, ports:Array, interfaces:Array, probe:object, portsDropped?:number, ifsDropped?:number}}
 */
export function buildIfaces({ ports = [], interfaces = [], probe = {}, at = Date.now(), source = '' } = {}) {
  const outP = []; const seen = new Set(); let dropP = 0;
  for (const p of Array.isArray(ports) ? ports : []) {
    const c = cleanPort(p);
    if (!c || seen.has(c.id)) { if (p) dropP += c ? 0 : 1; continue; }
    if (outP.length >= IFACE_PORT_MAX) { dropP += 1; continue; }
    seen.add(c.id); outP.push(c);
  }
  const outI = []; const seenI = new Set(); let dropI = 0;
  for (const x of Array.isArray(interfaces) ? interfaces : []) {
    const c = cleanIf(x);
    if (!c || seenI.has(c.id)) { if (x) dropI += c ? 0 : 1; continue; }
    if (outI.length >= IFACE_IF_MAX) { dropI += 1; continue; }
    seenI.add(c.id); outI.push(c);
  }
  const pr = {};
  if (probe && typeof probe === 'object' && !Array.isArray(probe)) {
    for (const k of ['fc', 'eth', 'ifs']) if (probe[k] && typeof probe[k] === 'object') pr[k] = ifaceProbe(probe[k].state, probe[k]);
  }
  const t = numOrNull(at);
  return { at: t != null && t > 0 ? Math.floor(t) : Date.now(), source: s(source, 120), ports: outP, interfaces: outI, probe: pr,
    ...(dropP ? { portsDropped: dropP } : {}), ...(dropI ? { ifsDropped: dropI } : {}) };
}
/**
 * 엣지가 보낸 `extra.ifaces` 를 좁힌다(중앙 수신 — `central/storageEdge.js`). 객체가 아니면 null. 시각은 수신 시각 이하로 자른다.
 * `o` 의 extra 를 제자리에서 고치고 좁힌 개수를 돌려준다.
 */
export function sanitizeEdgeIfaces(o, now = Date.now()) {
  const ex = o?.extra;
  if (!ex || typeof ex !== 'object' || !Object.hasOwn(ex, 'ifaces') || ex.ifaces == null) return 0;
  const v = ex.ifaces;
  if (typeof v !== 'object' || Array.isArray(v)) { ex.ifaces = null; return 1; }
  const before = (Array.isArray(v.ports) ? v.ports.length : 0) + (Array.isArray(v.interfaces) ? v.interfaces.length : 0);
  const built = buildIfaces({ ports: v.ports, interfaces: v.interfaces, probe: v.probe, at: Math.min(numOrNull(v.at) ?? now, now), source: v.source });
  const prevDrop = (numOrNull(v.portsDropped) || 0);
  if (prevDrop > 0 && prevDrop < 1e6) built.portsDropped = (built.portsDropped || 0) + Math.round(prevDrop);
  ex.ifaces = built;
  const after = built.ports.length + built.interfaces.length;
  return Math.max(0, before - after);
}

/* ── 판정(순수 — 서버 · 화면 · 알림 공용) ─────────────────────────────── */
/**
 * 포트 하나의 판정. tp = 그 기간의 처리량 요약 `{ peakPct, avgPct, nowPct, samples }`(못 읽었으면 null).
 * lastUpAt = 그 포트를 마지막으로 링크 업으로 본 시각(상태 표 — 처음부터 비어 있던 포트는 null).
 * 우선순위: 다운 > 저하 > 포화 근접 > 유휴 > 정상 · 처리량을 못 읽은 것은 `unread` 플래그로 따로(정상에도 이상에도 넣지 않는다).
 * @returns {{state:'down'|'unused'|'slow'|'busy'|'idle'|'ok'|'unknown', issue:boolean, unread:boolean, flags:string[]}}
 */
export function judgePort(port, tp = null, { lastUpAt = null, busyPct = IFACE_DEFAULTS.busyPct, idlePct = IFACE_DEFAULTS.idlePct } = {}) {
  const flags = [];
  if (!port) return { state: 'unknown', issue: false, unread: true, flags };
  const peak = numOrNull(tp?.peakPct);
  const unread = peak == null && numOrNull(tp?.nowPct) == null;
  if (port.linkUp === false) {
    // 직전에 링크 업이던 포트가 내려간 것만 '다운'(문제). 처음부터 비어 있던 포트(SFP 없음 · 케이블 없음)는 미연결.
    const down = numOrNull(lastUpAt) != null;
    return { state: down ? 'down' : 'unused', issue: down, unread: false, flags: down ? ['down'] : [] };
  }
  if (port.linkUp == null) return { state: 'unknown', issue: false, unread, flags };
  const sp = numOrNull(port.speedGbps); const mx = numOrNull(port.maxGbps);
  if (port.requested === 'auto' && sp != null && mx != null && sp < mx) flags.push('slow');
  if (peak != null && peak >= busyPct) flags.push('busy');
  if (peak != null && peak < idlePct && numOrNull(tp?.samples) > 0) flags.push('idle');
  const state = flags.includes('slow') ? 'slow' : flags.includes('busy') ? 'busy' : flags.includes('idle') ? 'idle' : 'ok';
  return { state, issue: state === 'slow' || state === 'busy', unread, flags };
}
/** 고정 속도(사람이 정한 요청 속도)가 최대보다 낮은가 — 저하가 아니라 '고정' 표시용. */
export const isFixedBelowMax = (p) => p && typeof p.requested === 'number' && numOrNull(p.speedGbps) != null && numOrNull(p.maxGbps) != null && p.speedGbps < p.maxGbps;

/**
 * SP 편중 — 같은 종류(FC/이더넷) 포트의 기간 평균 처리량을 SP 별로 더해 비율. 한쪽이 70% 이상이면 skew.
 * 읽은 포트가 한 SP 에만 있거나 합이 0 이면 null(판정하지 않는다). 못 읽은 포트는 더하지 않고 partial 로 센다.
 */
export const SP_SKEW_SHARE = 0.7;
export function spBalance(rows) {
  const by = new Map(); let partial = 0;
  for (const r of rows || []) {
    const sp = s(r?.sp, 16); const v = numOrNull(r?.avgBps);
    if (!sp) continue;
    if (v == null) { partial += 1; continue; }
    by.set(sp, (by.get(sp) || 0) + v);
  }
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  if (by.size < 2 || !(total > 0)) return null;
  const shares = Object.fromEntries([...by.entries()].sort().map(([k, v]) => [k, Math.round((v / total) * 1000) / 10]));
  const top = Math.max(...Object.values(shares));
  return { shares, skew: top >= SP_SKEW_SHARE * 100, partial };
}

/* ── 변화 비교(순수) ────────────────────────────────────────────────────── */
/**
 * 직전 상태(prev: Map id → {speedGbps, linkUp, lastUpAt}) 와 이번 포트 목록 → 변화 + 다음 상태.
 * 변화는 '알 수 있는 값끼리' 만 — 직전 값이나 이번 값이 null(모름)이면 변화로 보지 않는다(못 읽음은 다운이 아니다).
 * 처음 본 포트는 변화가 아니다(기준선). 목록에서 빠진 포트는 상태를 그대로 둔다(포트가 사라졌다고 단정하지 않는다).
 * @returns {{changes:Array<{port:string, field:'speed'|'link', before:string, after:string}>, next:Array<{port, speedGbps, linkUp, lastUpAt}>}}
 */
export function diffPortStates(prev, ports, ts = Date.now()) {
  const changes = []; const next = [];
  const prevMap = prev instanceof Map ? prev : new Map();
  for (const p of ports || []) {
    if (!p?.id) continue;
    const old = prevMap.get(p.id) || null;
    const linkUp = typeof p.linkUp === 'boolean' ? p.linkUp : null;
    const sp = numOrNull(p.speedGbps);
    let lastUpAt = numOrNull(old?.lastUpAt);
    if (linkUp === true) lastUpAt = ts;
    if (old) {
      const oldLink = typeof old.linkUp === 'boolean' ? old.linkUp : null;
      if (oldLink != null && linkUp != null && oldLink !== linkUp) {
        changes.push({ port: p.id, field: 'link', before: oldLink ? speedLabel(old.speedGbps) : 'down', after: linkUp ? speedLabel(sp) : 'down' });
      } else if (oldLink === true && linkUp === true) {
        const o = numOrNull(old.speedGbps);
        if (o != null && sp != null && o !== sp) changes.push({ port: p.id, field: 'speed', before: speedLabel(o), after: speedLabel(sp) });
      }
    }
    next.push({ port: p.id, speedGbps: linkUp === true ? sp : (linkUp === false ? null : numOrNull(old?.speedGbps)), linkUp: linkUp ?? (typeof old?.linkUp === 'boolean' ? old.linkUp : null), lastUpAt });
  }
  return { changes, next };
}
/** 속도 표기(저장 · 화면 공용) — `16 Gb` · `1 Gb` · `0.1 Gb`. 모르면 'up'. */
export function speedLabel(g) {
  const n = numOrNull(g);
  if (n == null || !(n > 0)) return 'up';
  return `${n >= 1 ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 1000} Gb`;
}

/* ── 처리량 단위 이름 ↔ 포트 id ─────────────────────────────────────────── */
/** 포트 id(`spa_fc4` · `spa_iom_0_eth0`)와 표본 단위 이름(`SPA FC4`)을 같은 칸에 — 대소문자 · 구분자 무시. */
export const portMatchKey = (v) => String(v ?? '').trim().toUpperCase().replace(/[\s:_.-]+/g, '');
