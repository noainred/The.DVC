/**
 * iDRAC 자동 발견 폴러 — vCenter별로 저장된 IP 대역을 주기적으로 스캔해 Dell iDRAC을
 * 발견하고 해당 vCenter로 자동 등록한다(IPMS의 주기 IP 스캔과 같은 사용 흐름).
 *
 * 설계(고RTT·다수 vCenter 고려):
 *  - 한 번에 한 사이클만 실행(single-flight). 사이클 내 vCenter는 '순차'로 스캔한다
 *    (각 scanForIdracs가 내부적으로 동시성 32로 도므로, vCenter까지 병렬화하면 소켓이
 *    폭증한다 — 순차로 총 동시성을 제한). 모두 비동기 I/O라 이벤트 루프는 막지 않는다.
 *  - vCenter 단위로 try/catch 격리(느린/실패한 1곳이 나머지를 막지 않음).
 *  - 등록은 기본 'merge'(upsert). 스캔이 일시적으로 0건이면 registerScanned가 no-op이라
 *    replace-vcenter라도 기존 등록을 지우지 않는다(블립으로 인한 대량 삭제 방지).
 *  - 에이전트 위임(agent 지정): 중앙이 못 닿는 사설망은 현장 에이전트가 스캔+현지 등록하도록
 *    잡을 적재(fire-and-forget). 결과 전력은 수집서버(collector) 경로로 병합된다.
 */

import { config } from '../config.js';
import { scanForIdracs } from './scan.js';
import { registerScanned } from './registry.js';
import { pollNow } from './poller.js';
import { enabledScanRanges, recordScanRangeRun, getScanRangeRaw } from './scanRanges.js';
import { enqueueIdracScan } from '../central/idracScanJobs.js';
import { isStopped } from '../security/emergencyStop.js';

let timer = null;
let running = false;
let lastRun = null;     // { at, durationMs, vcenters, found, registered, delegated, errors }
let progress = null;    // { vcenterId, done, total, foundSoFar, idx, totalVcenters, startedAt }

function intervalMs() {
  return config.idrac.scanIntervalMs;
}

/** 한 vCenter 대역을 스캔+등록(또는 위임). 반환 { vcenterId, scanned, found, registered, delegated, error }. */
async function scanOneVcenter(e, onProgress) {
  const ips = e.ranges.join('\n');
  // 위임: 에이전트가 현지에서 스캔+자동등록(noRegister:false). 중앙 토큰 필요.
  if (e.agent && e.agent !== '__local__') {
    if (!config.central.token) return { vcenterId: e.vcenterId, delegated: false, error: '중앙 토큰 미설정으로 위임 불가' };
    const reqId = enqueueIdracScan(e.agent, { ips, username: e.username, password: e.password, vcenterId: e.vcenterId, noRegister: false });
    return { vcenterId: e.vcenterId, delegated: true, agent: e.agent, reqId: reqId || null, error: reqId ? null : '위임 잡 적재 실패(대기 한도 초과)' };
  }
  // 중앙 직접 스캔.
  const r = await scanForIdracs({ ips, username: e.username, password: e.password, onProgress });
  let registered = 0;
  if (r.found.length) {
    // 주기 스캔 등록 모드: merge(기본) 또는 replace-vcenter(found 0건이면 registerScanned가 no-op).
    const reg = registerScanned(r.found, e.username, e.password, e.mode === 'replace-vcenter' ? 'replace-vcenter' : 'merge', e.vcenterId);
    if (reg.ok) registered = (reg.added || 0) + (reg.updated || 0);
  }
  return { vcenterId: e.vcenterId, delegated: false, scanned: r.scanned, found: r.found.length, registered, truncated: r.truncated };
}

/**
 * 한 사이클 실행. opts.vcenterId 지정 시 그 vCenter만(수동 '지금 스캔').
 * opts.manual=true면 enabled 여부와 무관하게 실행(단, 대역/계정은 있어야 함).
 */
export async function runIdracScanOnce(opts = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.' };
  if (isStopped()) return { ok: false, reason: '긴급중단 중' };
  let entries = enabledScanRanges();
  if (opts.vcenterId) {
    const raw = getScanRangeRaw(opts.vcenterId);
    // 수동 단건: enabled가 아니어도 실행하되 대역/계정은 필요.
    if (!raw || !(raw.ranges || []).length || !String(raw.username || '').trim()) {
      return { ok: false, reason: '대상 vCenter의 대역/계정이 없습니다.' };
    }
    entries = [{ vcenterId: String(opts.vcenterId).trim(), ranges: (raw.ranges || []).filter(Boolean), username: String(raw.username).trim(), password: raw.password || '', agent: String(raw.agent || '').trim(), mode: raw.mode || 'merge' }];
  }
  if (!entries.length) { lastRun = { at: Date.now(), skipped: '대상 없음' }; return { ok: false, reason: '스캔할 대역이 없습니다.' }; }

  running = true;
  const started = Date.now();
  const results = [];
  let foundTotal = 0, registeredTotal = 0, delegatedTotal = 0; const errors = [];
  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      progress = { vcenterId: e.vcenterId, done: 0, total: 0, foundSoFar: foundTotal, idx: i, totalVcenters: entries.length, startedAt: started };
      try {
        const r = await scanOneVcenter(e, (done, total) => { progress = { vcenterId: e.vcenterId, done, total, foundSoFar: foundTotal, idx: i, totalVcenters: entries.length, startedAt: started }; });
        results.push(r);
        if (r.delegated) delegatedTotal++;
        foundTotal += (r.found || 0);
        registeredTotal += (r.registered || 0);
        if (r.error) errors.push(`${e.vcenterId}: ${r.error}`);
        recordScanRangeRun(e.vcenterId, { scanned: r.scanned ?? null, found: r.found ?? null, registered: r.registered ?? null, delegated: !!r.delegated, agent: r.agent || null, error: r.error || null });
      } catch (err) {
        errors.push(`${e.vcenterId}: ${err.message}`);
        results.push({ vcenterId: e.vcenterId, error: err.message });
        recordScanRangeRun(e.vcenterId, { error: err.message });
      }
    }
    // 새로 등록된 서버가 있으면 즉시 전력 1회 수집(대시보드에 바로 반영).
    if (registeredTotal > 0) pollNow().catch(() => {});
    lastRun = { at: Date.now(), durationMs: Date.now() - started, vcenters: entries.length, found: foundTotal, registered: registeredTotal, delegated: delegatedTotal, errors, manual: !!opts.manual, results };
    return { ok: true, ...lastRun };
  } catch (e) {
    lastRun = { at: Date.now(), error: e.message };
    return { ok: false, reason: e.message };
  } finally { running = false; progress = null; }
}

/** 비동기 시작(요청 즉시 반환, 창 닫아도 백그라운드 지속). */
export function startIdracScanNow(opts = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.', running: true };
  const entries = opts.vcenterId ? [opts.vcenterId] : enabledScanRanges();
  if (!opts.vcenterId && !entries.length) return { ok: false, reason: '스캔할 대역이 없습니다.' };
  runIdracScanOnce({ ...opts, manual: true }).catch((e) => console.error('[idrac-scan] 백그라운드 스캔 실패:', e.message));
  return { ok: true, started: true };
}

export function idracScanStatus() {
  const enabled = enabledScanRanges();
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return {
    enabledVcenters: enabled.length,
    totalRanges: enabled.reduce((a, e) => a + e.ranges.length, 0),
    intervalMs: intervalMs(),
    running, lastRun,
    progress: progress ? { ...progress, pct } : null,
  };
}

export function rescheduleIdracScanPoller() {
  if (timer) { clearInterval(timer); timer = null; }
  const ms = intervalMs();
  if (ms <= 0) return 0; // 주기 비활성(수동 스캔만)
  timer = setInterval(() => runIdracScanOnce().catch(() => {}), ms);
  timer.unref?.();
  return ms;
}

export function startIdracScanPoller() {
  if (!config.idrac.enabled) { console.log('[idrac-scan] poller disabled (IDRAC_ENABLED=false)'); return; }
  const ms = intervalMs();
  if (ms <= 0) { console.log('[idrac-scan] periodic scan disabled (IDRAC_SCAN_INTERVAL_MS<=0) — manual scan only'); return; }
  // 첫 스캔은 부팅 60초 후(다른 수집과 겹치지 않게), 이후 주기 반복.
  setTimeout(() => runIdracScanOnce().catch((e) => console.error('[idrac-scan] 실패:', e.message)), 60_000).unref?.();
  timer = setInterval(() => runIdracScanOnce().catch(() => {}), ms);
  timer.unref?.();
  console.log(`[idrac-scan] poller started (every ${Math.round(ms / 1000)}s)`);
}
