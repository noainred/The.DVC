/**
 * IP 스캔 설정(에이전트별) + 결과 저장소.
 * - 설정: config/ipam-scan.json → { agents: { [name]: cfg } }
 *     "__local__" = 이 포탈(중앙)에서 직접 스캔하는 설정.
 *     그 외 이름 = 해당 분산 에이전트가 중앙에서 읽어가 자기 사이트에서 스캔할 설정.
 * - 결과: config/ipam-scan-results.json (ip → 열린포트/서비스/호스트명/최근확인/agent)
 *   → IP 대장(ledger)이 이 결과를 병합해 물리/기타 서버 IP를 채운다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { DEFAULT_PORTS, isIpv4 } from './scan.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { getOverrides } from './overrides.js';
import { getPolicies, isCoveredByAnyPolicy } from './rangePolicies.js';
import { registerExitFlush } from '../util/exitFlush.js'; // v2.582 ARCH-4: 디바운스 저장은 종료 시 동기 flush 를 등록한다
import { ipToNum } from '../util/ipv4.js';
import { numOrNull } from '../util/numOrNull.js';
import { agentKeyOf, agentValueOf } from '../util/agentKey.js'; // v2.604 RECENT2604-01

const MAX_MERGE = 20_000; // 한 보고당 병합 상한(악의/오작동 에이전트의 대량 주입 방지)
// v2.603(감사 CEN2603-02): **전체** 상한. MAX_MERGE 는 한 호출에만 걸려, 배정 범위가 없는 토큰이 보고를 반복하면 results·history 가
//   무한히 쌓였다(그 IP 들이 원장 행이 되어 CEN2603-03 RangeError 로 이어졌다). 기본 262,144 = /14 한 개 분량. 넘치면 **새 IP 만**
//   받지 않고 개수를 돌려준다 — 이미 있는 IP(다른 엣지 것 포함)는 밀어내지 않는다(조용한 상한 금지 — 호출부가 응답·로그에 싣는다).
const _capEnv = numOrNull(process.env.IPAM_SCAN_RESULTS_MAX);
export const MAX_SCAN_IPS = _capEnv != null && _capEnv > 0 ? Math.floor(_capEnv) : 262_144;
export const MAX_HIST_IPS = MAX_SCAN_IPS * 2; // 이력은 결과보다 오래 남는다(1년) — 여유를 둔다
let _histCapped = 0;   // 이력 상한으로 만들지 않은 이력 항목 수(누적 — scanInfo 가 밝힌다)
let _resultCount = 0;   // Object.keys(results).length 를 매 원소 세지 않게(v2.589 규약) — 새 IP 를 넣을 때만 늘린다
let _histCount = 0;

// v2.593(감사 DEPS-03): 손으로 쓴 사본이 '10..1.1'·'0x0a.1.1.1' 을 받았다 — IPv4 파서는 util/ipv4.js 하나다(v2.586).
const _ipNum = ipToNum;
// 운영자가 관리(수동 override 또는 대역 정책)하는 IP인지 판단하는 '예측자'를 1회 구성해 반환.
// 루프 안에서 매번 override 맵/정책 목록을 다시 읽지 않도록 컨텍스트를 캡처하고,
// 활성 정책이 하나도 없으면 findPolicy 자체를 건너뛴다(대다수 환경에서 O(N)로 동작).
function managedChecker() {
  const ovMap = getOverrides();
  const hasPolicies = getPolicies().some((p) => p.enabled !== false);
  // ⚠ 회귀 방지(v2.287, 확정 버그 #11): 여기서 findPolicy(ip, '') 를 쓰면 claimedVcenterId 가
  // 붙은(특정 법인 귀속) 대역정책이 스코프 불일치로 제외돼, 귀속 정책으로만 관리되는 IP 가
  // '미관리'로 오판되고 스캔 결과·이력이 보존기간 후 삭제됐다. 관리 여부는 귀속 무관(어떤 활성
  // 정책이든 덮으면 관리)으로 판단한다.
  return (ip) => (Object.prototype.hasOwnProperty.call(ovMap, ip)) || (hasPolicies && isCoveredByAnyPolicy(_ipNum(ip)));
}

const CFG = path.join(config.configDir, 'ipam-scan.json');
const RES = path.join(config.configDir, 'ipam-scan-results.json');
const REP = path.join(config.configDir, 'ipam-scan-agents.json');
const HIST = path.join(config.configDir, 'ipam-scan-history.json');
export const LOCAL = '__local__';

const MAX_EVENTS = 200;             // IP당 보관 이벤트 수(가장 오래된 것부터 삭제)
const HISTORY_RETENTION_MS = 365 * 86_400_000; // 1년 넘게 안 보인 IP는 이력에서 제거(무한 증식 방지)

const DEFAULTS = {
  enabled: false, ranges: [], ports: DEFAULT_PORTS,
  intervalMs: 3_600_000, concurrency: 128, timeoutMs: 700, reverseDns: true, ping: false, retentionDays: 30,
};

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
// ⚠ v2.583 감사 #23: 손상 파일을 **조용히** 기본값으로 넘기면 다음 디바운스 저장이 온전했던 원본(사용자가 입력한
//   에이전트별 스캔 범위·포트, 1년치 up/down 이력)을 빈 값으로 덮어쓴다. 보존(.corrupt.<ts>) + 경고 후 기본값.
function readJson(file, dflt) {
  if (!fs.existsSync(file)) return dflt;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    preserveCorrupt(file, e?.message || String(e));
    console.warn(`[ipam] ${path.basename(file)} 파싱 실패(${e?.message || e}) — 손상본을 .corrupt 로 보존하고 기본값으로 시작합니다.`);
    return dflt;
  }
}

// ---- 디바운스 원자적 쓰기 ---------------------------------------------------
// 분산 에이전트가 POST /ip-scan-result로 보고할 때마다 전체 results.json·history.json을
// '동기' writeFileSync 하던 것을 제거한다. 30개 에이전트 동시 보고 시 매 보고가 대형 JSON을
// 동기 직렬화·기록 → 이벤트 루프 블로킹(고RTT 환경 취약). 대신 dirty 플래그를 세우고 짧게
// 디바운스해 '한 번'만 atomicWriteFileSync(임시파일+rename)로 기록한다. 프로세스 종료 시
// flushAllNow()로 잔여 dirty를 동기 보존(데이터 유실 방지).
const WRITE_DEBOUNCE_MS = Number(process.env.IPAM_WRITE_DEBOUNCE_MS) || 1500;
const _stores = new Map(); // file -> { getData, dirty, timer }

function registerStore(file, getData) { _stores.set(file, { getData, dirty: false, timer: null }); }
function scheduleWrite(file) {
  const st = _stores.get(file);
  if (!st) return;
  st.dirty = true;
  if (st.timer) return; // 이미 예약됨 → 버스트를 1회로 합침
  st.timer = setTimeout(() => { st.timer = null; flushStore(file); }, WRITE_DEBOUNCE_MS);
  st.timer.unref?.();
}
function flushStore(file) {
  const st = _stores.get(file);
  if (!st || !st.dirty) return;
  st.dirty = false;
  try { atomicWriteFileSync(file, JSON.stringify(st.getData(), null, 2), { mode: 0o600 }); }
  catch (e) { st.dirty = true; console.warn(`[ipam] 저장 실패(${path.basename(file)}): ${e.message}`); }
}
/** 모든 dirty 저장소를 즉시 동기 기록(프로세스 종료 직전 데이터 보존용). */
export function flushAllNow() { for (const file of _stores.keys()) { const st = _stores.get(file); if (st?.timer) { clearTimeout(st.timer); st.timer = null; } flushStore(file); } }
let _exitHooked = false;
function ensureExitFlush() {
  if (_exitHooked) return; _exitHooked = true;
  // v2.447(감사 I3): 시그널에서는 flush 만 — process.exit 를 부르면 index.js 의 정상 종료가
  // 실행되지 못한다(진행 중 HTTP 응답이 끊김). 'exit' 훅이 있어 flush 자체는 보장된다.
  // v2.582 ARCH-4: 공용 레지스트리(util/exitFlush.js) — 시그널 훅은 index.js gracefulExit 이 process.exit 으로 exit 를 낸다.
  registerExitFlush('ipam/scanStore', flushAllNow);
}

function normalizeCfg(p = {}) {
  return {
    enabled: !!p.enabled,
    ranges: Array.isArray(p.ranges) ? p.ranges.filter(Boolean) : [],
    ports: Array.isArray(p.ports) && p.ports.length ? p.ports.map(Number).filter((n) => n > 0 && n < 65536) : DEFAULT_PORTS,
    intervalMs: clamp(p.intervalMs, 60_000, 7 * 86_400_000, DEFAULTS.intervalMs),
    concurrency: clamp(p.concurrency, 1, 1024, DEFAULTS.concurrency),
    timeoutMs: clamp(p.timeoutMs, 100, 10_000, DEFAULTS.timeoutMs),
    reverseDns: p.reverseDns !== false,
    // ICMP ping 병행(v2.359) — 포트가 전부 닫힌 서버도 생존 감지. v2.360: 기본 OFF(opt-in).
    // 프로세스/FD 폭주로 포탈이 먹통이 된 장애(v2.359) 이후, 명시적으로 켤 때만 동작하고
    // 켜더라도 ping 전용 동시성 상한(scan.js PING_MAX)으로 소수만 동시에 실행된다.
    ping: p.ping === true,
    retentionDays: clamp(p.retentionDays, 0, 3650, DEFAULTS.retentionDays),
  };
}

function loadAll() {
  const p = readJson(CFG, {}) || {};
  // 구버전(단일 설정) 마이그레이션: 최상위에 ranges가 있으면 __local__로 이전.
  if (!p.agents && (p.ranges || p.enabled !== undefined)) return { agents: { [LOCAL]: normalizeCfg(p) } };
  return { agents: p.agents && typeof p.agents === 'object' ? p.agents : {} };
}

function saveAll(all) {
  fs.mkdirSync(path.dirname(CFG), { recursive: true });
  atomicWriteFileSync(CFG, JSON.stringify(all, null, 2));
}

/** 한 에이전트(기본=로컬)의 설정. */
export function loadScanSettings(agent = LOCAL) {
  const all = loadAll();
  // v2.604(감사 RECENT2604-01 — 재현): 이름은 **대소문자 무시**로 찾는다(util/agentKey.js — v2.597 L2597-03 과 같은 규칙).
  //   예전에는 글자 그대로라 설정이 'edge-seoul', 토큰이 'Edge-Seoul' 이면 배정(?agent=)은 200 assigned:true 인데 결과
  //   (토큰 이름)는 범위 0 → v2.603 의 409 unassigned 로 **스캔은 돌고 결과만 전량 거부**됐다.
  return normalizeCfg(agentValueOf(all.agents, agent) || {});
}

/** 에이전트별 설정 저장(부분 업데이트). */
export function saveScanSettings(agent, partial = {}) {
  const all = loadAll();
  // v2.604 RECENT2604-01: 대소문자만 다른 기존 키가 있으면 그 키를 갱신한다(같은 엣지의 설정이 두 벌로 갈라지지 않게).
  const key = agentKeyOf(all.agents, agent) ?? agent;
  const cur = normalizeCfg(all.agents[key] || {});
  const next = { ...cur };
  if (partial.enabled !== undefined) next.enabled = !!partial.enabled;
  if (partial.ranges !== undefined) next.ranges = (Array.isArray(partial.ranges) ? partial.ranges : String(partial.ranges).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
  if (partial.ports !== undefined) { const arr = (Array.isArray(partial.ports) ? partial.ports : String(partial.ports).split(/[\s,]+/)).map(Number).filter((n) => n > 0 && n < 65536); if (arr.length) next.ports = arr; }
  if (partial.intervalMs !== undefined) next.intervalMs = clamp(partial.intervalMs, 60_000, 7 * 86_400_000, DEFAULTS.intervalMs);
  if (partial.concurrency !== undefined) next.concurrency = clamp(partial.concurrency, 1, 1024, DEFAULTS.concurrency);
  if (partial.timeoutMs !== undefined) next.timeoutMs = clamp(partial.timeoutMs, 100, 10_000, DEFAULTS.timeoutMs);
  if (partial.reverseDns !== undefined) next.reverseDns = !!partial.reverseDns;
  if (partial.ping !== undefined) next.ping = !!partial.ping; // v2.359 — 누락 시 저장이 조용히 무시됨
  if (partial.retentionDays !== undefined) next.retentionDays = clamp(partial.retentionDays, 0, 3650, DEFAULTS.retentionDays);
  all.agents[key] = next;
  saveAll(all);
  return next;
}

export function listScanAgents() {
  const all = loadAll();
  return Object.keys(all.agents).map((name) => ({ name, ...normalizeCfg(all.agents[name]) }));
}

// ---- 결과 ----------------------------------------------------------------
// v2.601(감사 CEN2601-01): 엣지가 보낸 alive[] 원소는 **아는 필드·타입만** 담는다. 예전에는 openPorts·
//   services·hostname 을 받은 그대로 저장해, 원소 하나({openPorts:{a:1}, services:'x', hostname:{}})가
//   대장(ledger.js)의 .join/.map 에서 던져 **매 주기 ipam.db 저장이 실패**하고 /tools/ipam/insights 가 500 이었다.
//   정제는 저장 함수 안에 둔다(라우트가 아니라 — 디스크에서 읽은 옛 파일도 같은 정제를 거친다. v2.598 CENTRAL 규약).
const MAX_PORTS = 256, MAX_SERVICES = 64, MAX_SVC_LEN = 64, MAX_HOST_LEN = 255;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f]/g;
function cleanPorts(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const p of v) {
    if (out.length >= MAX_PORTS) break;
    if (typeof p !== 'number' && typeof p !== 'string') continue;
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) out.push(n);
  }
  return out;
}
function cleanServices(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const s of v) {
    if (out.length >= MAX_SERVICES) break;
    if (typeof s !== 'string' && typeof s !== 'number') continue;
    const t = String(s).replace(CTRL_RE, '').slice(0, MAX_SVC_LEN);
    if (t) out.push(t);
  }
  return out;
}
function cleanHostname(v) {
  return typeof v === 'string' ? v.replace(CTRL_RE, '').slice(0, MAX_HOST_LEN) : '';
}
/** alive 원소 하나를 아는 필드로 좁힌다(순수 — 테스트가 직접 부른다). ip 는 호출부가 isIpv4 로 검사한다. */
export function cleanAliveHost(h) {
  return { ip: h.ip, openPorts: cleanPorts(h.openPorts), services: cleanServices(h.services), hostname: cleanHostname(h.hostname) };
}
function cleanStoredResults(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [ip, r] of Object.entries(raw)) {
    if (!r || typeof r !== 'object' || !isIpv4(ip)) continue;
    out[ip] = { ...cleanAliveHost({ ...r, ip }), lastSeen: numOrNull(r.lastSeen) ?? 0, agent: typeof r.agent === 'string' ? r.agent : LOCAL };
  }
  return out;
}
let results = cleanStoredResults(readJson(RES, {}));
_resultCount = Object.keys(results).length;
registerStore(RES, () => results);
ensureExitFlush();

let scanRevN = 0; // 스캔 결과/이력 변경 리비전(대장 캐시 무효화 키)
export function scanRev() { return scanRevN; }
export function getScanResults() { return results; }
export function scanResultList() { return Object.values(results).sort((a, b) => (a.ip < b.ip ? -1 : 1)); }

const sameList = (a, b) => { const x = a || [], y = b || []; return x.length === y.length && x.every((v, i) => v === y[i]); };

/** @returns {{merged:number, capped:number}} 병합한 IP 수 · 전체 상한(MAX_SCAN_IPS)으로 받지 않은 새 IP 수 */
export function mergeScanResults(alive, ts = Date.now(), agent = LOCAL) {
  let changed = false;
  let n = 0; let merged = 0; let capped = 0; const histCappedBefore = _histCapped;
  for (const raw of alive) {
    if (n++ >= MAX_MERGE) break;                 // 대량 주입 상한
    if (!raw || typeof raw !== 'object' || !isIpv4(raw.ip)) continue; // 잘못된/오염 IP 키 차단(__proto__, 333.0.0.0 등)
    const h = cleanAliveHost(raw);               // v2.601 CEN2601-01: 아는 필드·타입만
    const prev = results[h.ip];
    // v2.603 CEN2603-02: 새 IP 는 결과 전체 상한 안에서만 받는다. 이력은 따로 상한(MAX_HIST_IPS)을 두고 넘치면 **이력 항목만** 만들지 않는다
    //   (이력은 1년 보존이라 결과 prune 뒤에도 남는다 — 이력 상한으로 결과를 막으면 IP 가 바뀐 대역이 1년 동안 안 들어온다).
    if (!prev && _resultCount >= MAX_SCAN_IPS) { capped++; continue; }
    if (!prev) _resultCount++;
    merged++;
    // 분산 멀티에이전트: 더 오래된(stale) 보고가 최신 관측을 덮어쓰지 않게 한다.
    if (prev && (prev.lastSeen || 0) > ts) { recordSeen(h, ts, agent); continue; }
    // 실제 내용(포트/서비스/호스트명/에이전트) 변화가 있을 때만 리비전을 올린다(불필요한 대장 재계산 방지).
    if (!prev || !sameList(prev.openPorts, h.openPorts) || !sameList(prev.services, h.services)
      || (prev.hostname || '') !== (h.hostname || '') || prev.agent !== agent) changed = true;
    results[h.ip] = { ip: h.ip, openPorts: h.openPorts, services: h.services, hostname: h.hostname || '', lastSeen: ts, agent };
    recordSeen(h, ts, agent); // IP 사용 이력(온라인 전환) 갱신
  }
  if (histDirty) changed = true; // up/down 전이·신규 이력도 대장(usageStatus/firstSeen)에 영향
  scheduleWrite(RES);   // 디바운스 원자 기록(동기 블로킹 제거)
  persistHist();
  if (changed) scanRevN++;
  if (_histCapped > histCappedBefore) console.warn(`[ipam] IP 사용 이력 상한(${MAX_HIST_IPS}개) — 새 이력 ${_histCapped - histCappedBefore}개를 만들지 않았습니다(스캔 결과는 받았습니다)`);
  if (capped) console.warn(`[ipam] 스캔 결과 전체 상한(${MAX_SCAN_IPS}개) — ${agent} 보고의 새 IP ${capped}개를 받지 않았습니다(IPAM_SCAN_RESULTS_MAX)`);
  return { merged, capped };
}


// ---- IP 사용 이력 ----------------------------------------------------------
// 어떤 IP가 "사용 시작(up) → 미사용(down)"으로 바뀌는 전이를 기록해 대장에서 추이를 본다.
// up 전이: 스캔에서 새로 보이거나, down 이후 다시 보일 때 기록.
// down 전이: sweepReleases()가 일정 시간 미응답 IP를 '해제'로 마킹할 때 기록.
let history = readJson(HIST, {}) || {};
_histCount = Object.keys(history).length;
// 두 관심사를 분리한다:
//  histDirty      = 대장(ledger)에 영향 있는 이력 변화(신규 IP / up·down 전이) → scanRev 증가 유발.
//  histPersistDirty = 디스크 기록만 필요한 변화(안정 IP 의 lastSeen 전진) → scanRev 는 올리지 않는다.
// 겸용(과거)이면 lastSeen 전진마다 scanRev 가 올라 매 스캔 전 대장이 재계산된다(불필요한 부하 회귀).
let histDirty = false;
let histPersistDirty = false;
registerStore(HIST, () => history);

function pushEvent(entry, ev) {
  entry.events.push(ev);
  if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
}

function recordSeen(h, ts, agent) {
  const ip = h.ip;
  let e = history[ip];
  if (!e) {
    if (_histCount >= MAX_HIST_IPS) { _histCapped++; return; } // v2.603 CEN2603-02: 이력만 건너뛴다(결과는 받았다)
    _histCount++;
    e = history[ip] = { ip, firstSeen: ts, lastSeen: ts, status: 'up', agent, events: [] };
    pushEvent(e, { ts, type: 'up', hostname: h.hostname || '', ports: h.openPorts || [], agent });
    histDirty = true;
    return;
  }
  // 최신 관측만 반영 — stale(오래된) 보고가 lastSeen을 뒤로 돌려 IP가 조기 down 처리되지 않게 한다.
  // lastSeen 전진은 **디스크 기록만** 필요(histPersistDirty) — 안 켜면 안정(status='up') IP 의
  // 갱신된 lastSeen 이 디스크에 안 써져(persistHist 는 dirty 일 때만 기록), 재시작 후 오래된
  // lastSeen 으로 sweep 이 그 IP 를 가짜 down 처리한다. 단 내용 변화가 아니므로 histDirty(=scanRev)
  // 는 올리지 않는다(안 그러면 매 스캔 대장 재계산 — CLAUDE.md 불필요 재계산 방지 위반).
  if (ts > (e.lastSeen || 0)) { e.lastSeen = ts; e.agent = agent; histPersistDirty = true; }
  if (e.status !== 'up') {
    e.status = 'up';
    pushEvent(e, { ts, type: 'up', hostname: h.hostname || '', ports: h.openPorts || [], agent });
    histDirty = true;
  }
}

/**
 * 일정 시간(idleMs) 이상 응답이 없던 'up' IP를 '해제(down)'로 마킹한다.
 * opts.agent를 주면 그 에이전트가 마지막으로 보고한 IP만 대상으로 한다 — 중앙이 직접 스캔한
 * 로컬 대역만 down 처리하고, 원격 사이트 에이전트 소유 IP를 중앙 스캔이 오탐 down하지 않게 한다.
 */
export function sweepReleases(idleMs, opts = {}) {
  const now = typeof opts === 'number' ? opts : (opts.now || Date.now());
  const onlyAgent = typeof opts === 'object' ? opts.agent : undefined;
  // opts.idleMsByAgent(Map name→ms): 소유 에이전트별 임계 — 주기가 긴(최대 7일) 원격 에이전트의
  // IP를 로컬 주기 기준으로 일괄 판정하면 스캔 사이마다 가짜 down/up 플립이 생긴다.
  const byAgent = (typeof opts === 'object' && opts.idleMsByAgent instanceof Map) ? opts.idleMsByAgent : null;
  if ((!idleMs || idleMs <= 0) && !byAgent) return 0;
  let changed = 0;
  const isManaged = managedChecker(); // 루프 시작 시 1회 구성(O(N) 유지)
  for (const e of Object.values(history)) {
    const owned = onlyAgent === undefined || (e.agent || LOCAL) === onlyAgent;
    const eff = byAgent ? (byAgent.get(e.agent || LOCAL) ?? idleMs) : idleMs;
    if (owned && e.status === 'up' && eff > 0 && (e.lastSeen || 0) < now - eff) {
      e.status = 'down';
      pushEvent(e, { ts: now, type: 'down' });
      changed++;
    }
    // 아주 오래 안 보인 IP의 이력은 정리(무한 증식 방지). 단, 운영자가 관리(override/대역정책)하는
    // IP는 사용 추이를 계속 보존한다(관리 대상의 이력 손실 방지).
    if ((e.lastSeen || 0) < now - HISTORY_RETENTION_MS && !isManaged(e.ip)) { delete history[e.ip]; _histCount--; changed++; }
  }
  if (changed) { histDirty = true; persistHist(); scanRevN++; }
  return changed;
}

function persistHist() {
  if (!histDirty && !histPersistDirty) return; // ledger 변화 또는 lastSeen 전진 중 하나라도 있으면 기록
  histDirty = false;
  histPersistDirty = false;
  scheduleWrite(HIST); // 디바운스 원자 기록
}

/** 한 IP의 사용 이력(없으면 null). */
export function getIpHistory(ip) { return history[ip] || null; }

/** ip → { firstSeen, lastSeen, status } 요약 맵(대장 주석용). */
export function getIpHistoryMap() {
  const m = {};
  for (const e of Object.values(history)) m[e.ip] = { firstSeen: e.firstSeen, lastSeen: e.lastSeen, status: e.status };
  return m;
}

/** ip → { firstSeen, lastSeen, status, agent, events[] } 전체 맵(시간축 시각화용 — up/down 전이 시계열 포함). */
export function getAllHistoryEvents() {
  const m = {};
  for (const e of Object.values(history)) {
    m[e.ip] = { firstSeen: e.firstSeen, lastSeen: e.lastSeen, status: e.status, agent: e.agent || '', events: e.events || [] };
  }
  return m;
}

export function pruneScanResults(retentionDays) {
  if (!retentionDays) return;
  const cut = Date.now() - retentionDays * 86_400_000;
  let changed = false;
  const isManaged = managedChecker();
  // 관리(override/대역정책) IP의 스캔 결과는 보존(보존기간 초과여도 운영 가시성 유지).
  for (const [ip, r] of Object.entries(results)) if ((r.lastSeen || 0) < cut && !isManaged(ip)) { delete results[ip]; _resultCount--; changed = true; }
  if (changed) { scheduleWrite(RES); scanRevN++; }
}

export function scanInfo() {
  const list = scanResultList();
  const byAgent = {};
  for (const r of list) byAgent[r.agent || LOCAL] = (byAgent[r.agent || LOCAL] || 0) + 1;
  return { count: list.length, max: MAX_SCAN_IPS, historyMax: MAX_HIST_IPS, ...(_histCapped ? { historyCapped: _histCapped } : {}), lastSeen: list.reduce((m, r) => Math.max(m, r.lastSeen || 0), 0) || null, byAgent };
}

// ---- 에이전트별 보고 기록(마지막 보고 시각·스캔/응답 수) ----------------------
let reports = readJson(REP, {}) || {};
registerStore(REP, () => reports);

export function recordAgentReport(agent, { scanned = 0, alive = 0, durationMs = null } = {}) {
  const name = agent || LOCAL;
  // v2.601 CEN2601-01: 엣지 본문의 수치를 그대로 저장하지 않는다(객체·문자열이 화면·이력으로 새지 않게).
  scanned = numOrNull(scanned); alive = numOrNull(alive); durationMs = numOrNull(durationMs);
  reports[name] = { at: Date.now(), scanned, alive };
  scheduleWrite(REP); // 디바운스 원자 기록(에이전트 보고 핫패스 비차단)
  recordRun({ agent: name, scanned, alive, durationMs }); // 완료된 스캔 이력에 추가
}

export function getAgentReports() { return reports; }

// ---- 스캔 실행 이력(완료된 스캔 로그, 최근 N건) ------------------------------
const RUNLOG = path.join(config.configDir, 'ipam-scan-runs.json');
const MAX_RUNS = 200;
let runs = (() => { const r = readJson(RUNLOG, {}); return Array.isArray(r?.runs) ? r.runs : []; })();
registerStore(RUNLOG, () => ({ runs }));

export function recordRun({ agent = LOCAL, scanned = 0, alive = 0, durationMs = null } = {}) {
  runs.unshift({ at: Date.now(), agent: String(agent), scanned: numOrNull(scanned), alive: numOrNull(alive), durationMs: numOrNull(durationMs) });
  if (runs.length > MAX_RUNS) runs = runs.slice(0, MAX_RUNS);
  scheduleWrite(RUNLOG); // 디바운스 원자 기록
}

export function getScanRuns(limit = 50) { return runs.slice(0, limit); }
