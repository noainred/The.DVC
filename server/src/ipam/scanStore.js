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
import { atomicWriteFileSync } from '../util/atomicWrite.js';

const MAX_MERGE = 20_000; // 한 보고당 병합 상한(악의/오작동 에이전트의 대량 주입 방지)

const CFG = path.join(config.configDir, 'ipam-scan.json');
const RES = path.join(config.configDir, 'ipam-scan-results.json');
const REP = path.join(config.configDir, 'ipam-scan-agents.json');
const HIST = path.join(config.configDir, 'ipam-scan-history.json');
export const LOCAL = '__local__';

const MAX_EVENTS = 200;             // IP당 보관 이벤트 수(가장 오래된 것부터 삭제)
const HISTORY_RETENTION_MS = 365 * 86_400_000; // 1년 넘게 안 보인 IP는 이력에서 제거(무한 증식 방지)

const DEFAULTS = {
  enabled: false, ranges: [], ports: DEFAULT_PORTS,
  intervalMs: 3_600_000, concurrency: 128, timeoutMs: 700, reverseDns: true, retentionDays: 30,
};

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function readJson(file, dflt) { if (!fs.existsSync(file)) return dflt; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }

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
  for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'beforeExit']) {
    try { process.once(ev, () => { flushAllNow(); if (ev !== 'exit' && ev !== 'beforeExit') process.exit(0); }); } catch { /* */ }
  }
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
  fs.writeFileSync(CFG, JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** 한 에이전트(기본=로컬)의 설정. */
export function loadScanSettings(agent = LOCAL) {
  const all = loadAll();
  return normalizeCfg(all.agents[agent] || {});
}

/** 에이전트별 설정 저장(부분 업데이트). */
export function saveScanSettings(agent, partial = {}) {
  const all = loadAll();
  const cur = normalizeCfg(all.agents[agent] || {});
  const next = { ...cur };
  if (partial.enabled !== undefined) next.enabled = !!partial.enabled;
  if (partial.ranges !== undefined) next.ranges = (Array.isArray(partial.ranges) ? partial.ranges : String(partial.ranges).split(/[\n,]/)).map((s) => String(s).trim()).filter(Boolean);
  if (partial.ports !== undefined) { const arr = (Array.isArray(partial.ports) ? partial.ports : String(partial.ports).split(/[\s,]+/)).map(Number).filter((n) => n > 0 && n < 65536); if (arr.length) next.ports = arr; }
  if (partial.intervalMs !== undefined) next.intervalMs = clamp(partial.intervalMs, 60_000, 7 * 86_400_000, DEFAULTS.intervalMs);
  if (partial.concurrency !== undefined) next.concurrency = clamp(partial.concurrency, 1, 1024, DEFAULTS.concurrency);
  if (partial.timeoutMs !== undefined) next.timeoutMs = clamp(partial.timeoutMs, 100, 10_000, DEFAULTS.timeoutMs);
  if (partial.reverseDns !== undefined) next.reverseDns = !!partial.reverseDns;
  if (partial.retentionDays !== undefined) next.retentionDays = clamp(partial.retentionDays, 0, 3650, DEFAULTS.retentionDays);
  all.agents[agent] = next;
  saveAll(all);
  return next;
}

export function listScanAgents() {
  const all = loadAll();
  return Object.keys(all.agents).map((name) => ({ name, ...normalizeCfg(all.agents[name]) }));
}

// ---- 결과 ----------------------------------------------------------------
let results = readJson(RES, {}) || {};
registerStore(RES, () => results);
ensureExitFlush();

let scanRevN = 0; // 스캔 결과/이력 변경 리비전(대장 캐시 무효화 키)
export function scanRev() { return scanRevN; }
export function getScanResults() { return results; }
export function scanResultList() { return Object.values(results).sort((a, b) => (a.ip < b.ip ? -1 : 1)); }

const sameList = (a, b) => { const x = a || [], y = b || []; return x.length === y.length && x.every((v, i) => v === y[i]); };

export function mergeScanResults(alive, ts = Date.now(), agent = LOCAL) {
  let changed = false;
  let n = 0;
  for (const h of alive) {
    if (n++ >= MAX_MERGE) break;                 // 대량 주입 상한
    if (!h || !isIpv4(h.ip)) continue;           // 잘못된/오염 IP 키 차단(__proto__, 333.0.0.0 등)
    const prev = results[h.ip];
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
}

// ---- IP 사용 이력 ----------------------------------------------------------
// 어떤 IP가 "사용 시작(up) → 미사용(down)"으로 바뀌는 전이를 기록해 대장에서 추이를 본다.
// up 전이: 스캔에서 새로 보이거나, down 이후 다시 보일 때 기록.
// down 전이: sweepReleases()가 일정 시간 미응답 IP를 '해제'로 마킹할 때 기록.
let history = readJson(HIST, {}) || {};
let histDirty = false;
registerStore(HIST, () => history);

function pushEvent(entry, ev) {
  entry.events.push(ev);
  if (entry.events.length > MAX_EVENTS) entry.events.splice(0, entry.events.length - MAX_EVENTS);
}

function recordSeen(h, ts, agent) {
  const ip = h.ip;
  let e = history[ip];
  if (!e) {
    e = history[ip] = { ip, firstSeen: ts, lastSeen: ts, status: 'up', agent, events: [] };
    pushEvent(e, { ts, type: 'up', hostname: h.hostname || '', ports: h.openPorts || [], agent });
    histDirty = true;
    return;
  }
  e.lastSeen = ts;
  e.agent = agent;
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
  if (!idleMs || idleMs <= 0) return 0;
  let changed = 0;
  for (const e of Object.values(history)) {
    const owned = onlyAgent === undefined || (e.agent || LOCAL) === onlyAgent;
    if (owned && e.status === 'up' && (e.lastSeen || 0) < now - idleMs) {
      e.status = 'down';
      pushEvent(e, { ts: now, type: 'down' });
      changed++;
    }
    // 아주 오래 안 보인 IP의 이력은 정리(무한 증식 방지) — 소유 무관 전역.
    if ((e.lastSeen || 0) < now - HISTORY_RETENTION_MS) { delete history[e.ip]; changed++; }
  }
  if (changed) { histDirty = true; persistHist(); scanRevN++; }
  return changed;
}

function persistHist() {
  if (!histDirty) return;
  histDirty = false;
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
  for (const [ip, r] of Object.entries(results)) if ((r.lastSeen || 0) < cut) { delete results[ip]; changed = true; }
  if (changed) { scheduleWrite(RES); scanRevN++; }
}

export function scanInfo() {
  const list = scanResultList();
  const byAgent = {};
  for (const r of list) byAgent[r.agent || LOCAL] = (byAgent[r.agent || LOCAL] || 0) + 1;
  return { count: list.length, lastSeen: list.reduce((m, r) => Math.max(m, r.lastSeen || 0), 0) || null, byAgent };
}

// ---- 에이전트별 보고 기록(마지막 보고 시각·스캔/응답 수) ----------------------
let reports = readJson(REP, {}) || {};
registerStore(REP, () => reports);

export function recordAgentReport(agent, { scanned = 0, alive = 0, durationMs = null } = {}) {
  const name = agent || LOCAL;
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
  runs.unshift({ at: Date.now(), agent, scanned, alive, durationMs });
  if (runs.length > MAX_RUNS) runs = runs.slice(0, MAX_RUNS);
  scheduleWrite(RUNLOG); // 디바운스 원자 기록
}

export function getScanRuns(limit = 50) { return runs.slice(0, limit); }
