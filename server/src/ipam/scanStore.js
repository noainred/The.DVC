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
import { DEFAULT_PORTS } from './scan.js';

const CFG = path.join(config.configDir, 'ipam-scan.json');
const RES = path.join(config.configDir, 'ipam-scan-results.json');
export const LOCAL = '__local__';

const DEFAULTS = {
  enabled: false, ranges: [], ports: DEFAULT_PORTS,
  intervalMs: 3_600_000, concurrency: 128, timeoutMs: 700, reverseDns: true, retentionDays: 30,
};

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
function readJson(file, dflt) { if (!fs.existsSync(file)) return dflt; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }

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

export function getScanResults() { return results; }
export function scanResultList() { return Object.values(results).sort((a, b) => (a.ip < b.ip ? -1 : 1)); }

export function mergeScanResults(alive, ts = Date.now(), agent = LOCAL) {
  for (const h of alive) results[h.ip] = { ip: h.ip, openPorts: h.openPorts, services: h.services, hostname: h.hostname || '', lastSeen: ts, agent };
  persist();
}

export function pruneScanResults(retentionDays) {
  if (!retentionDays) return;
  const cut = Date.now() - retentionDays * 86_400_000;
  let changed = false;
  for (const [ip, r] of Object.entries(results)) if ((r.lastSeen || 0) < cut) { delete results[ip]; changed = true; }
  if (changed) persist();
}

function persist() {
  try { fs.mkdirSync(path.dirname(RES), { recursive: true }); fs.writeFileSync(RES, JSON.stringify(results, null, 2), { mode: 0o600 }); } catch { /* best effort */ }
}

export function scanInfo() {
  const list = scanResultList();
  const byAgent = {};
  for (const r of list) byAgent[r.agent || LOCAL] = (byAgent[r.agent || LOCAL] || 0) + 1;
  return { count: list.length, lastSeen: list.reduce((m, r) => Math.max(m, r.lastSeen || 0), 0) || null, byAgent };
}
