/**
 * Agent-side scan worker. When CENTRAL_URL is configured, this instance acts as
 * an agent: it periodically pulls its IP assignment from the central portal (by
 * its AGENT_NAME), scans the assigned range locally for Dell iDRACs, optionally
 * auto-registers the discovered iDRACs into its local registry (so it starts
 * collecting their power), and reports the scan summary back to the central.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { scanForIdracs } from '../idrac/scan.js';
import { registerScanned } from '../idrac/registry.js';
import { pollNow } from '../idrac/poller.js';

let timer = null;
let last = null; // { at, agent, scanned, foundCount, registered, error }
let running = false; // 재진입 가드 — 스캔이 인터벌을 넘기면 중첩 실행돼 이중 스캔/보고, CPU 누적

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

async function pullAssignment() {
  const url = `${config.agent.centralUrl}/api/central/assignment?agent=${encodeURIComponent(config.agent.name)}`;
  const res = await resilientFetch(url, { headers: headers(), timeoutMs: 20_000, retries: 2 });
  if (!res.ok) throw new Error(`assignment -> ${res.status}`);
  return res.json();
}

async function postResult(payload) {
  const url = `${config.agent.centralUrl}/api/central/result`;
  await resilientFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload), timeoutMs: 30_000, retries: 2 });
}

export async function runAgentScan() {
  if (!config.agent.centralUrl) return null;
  if (running) return last; // 이전 주기 진행 중이면 이번 틱 건너뜀
  running = true;
  const started = Date.now();
  try {
    const a = await pullAssignment();
    if (!a?.assigned) { last = { at: Date.now(), agent: config.agent.name, assigned: false }; return last; }

    const scan = await scanForIdracs({ ips: a.ips, username: a.username, password: a.password });

    let registered = 0;
    if (config.agent.autoRegister && scan.found.length) {
      const r = registerScanned(scan.found, a.username, a.password, 'merge');
      if (r.ok) { registered = (r.added || 0) + (r.updated || 0); pollNow().catch(() => {}); }
    }

    await postResult({
      agent: config.agent.name,
      scanned: scan.scanned,
      foundCount: scan.foundCount,
      found: scan.found,
      unreachable: scan.unreachable,
      notIdrac: scan.notIdrac,
      authFailed: scan.authFailed,
      durationMs: Date.now() - started,
    }).catch(() => {});

    last = { at: Date.now(), agent: config.agent.name, assigned: true, scanned: scan.scanned, foundCount: scan.foundCount, registered };
    console.log(`[agent] 스캔 완료: ${config.agent.name} — ${scan.foundCount}/${scan.scanned} iDRAC, ${registered} 등록`);
    return last;
  } catch (err) {
    last = { at: Date.now(), agent: config.agent.name, error: err.message };
    console.warn(`[agent] 스캔 실패: ${err.message}`);
    return last;
  } finally {
    running = false;
  }
}

export function getAgentScanStatus() {
  return { name: config.agent.name, centralUrl: config.agent.centralUrl || null, intervalMs: config.agent.scanIntervalMs, last };
}

export function startAgentScanner() {
  if (!config.agent.centralUrl) return;
  setTimeout(() => runAgentScan(), 8_000).unref?.();
  timer = setInterval(() => runAgentScan(), config.agent.scanIntervalMs);
  timer.unref?.();
  console.log(`[agent] scanner started (name=${config.agent.name}, central=${config.agent.centralUrl}, every ${Math.round(config.agent.scanIntervalMs / 60000)}m)`);
}
