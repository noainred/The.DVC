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

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { scanForIdracs } from './scan.js';
import { registerScanned } from './registry.js';
import { pollNow } from './poller.js';
import { enabledScanRanges, recordScanRangeRun, getScanRangeRaw } from './scanRanges.js';
import { enqueueIdracScan, cancelPendingIdracScanJobs } from '../central/idracScanJobs.js';
import { isStopped } from '../security/emergencyStop.js';

let timer = null;      // 주기 타이머(setTimeout 체인 — 32비트 한계 초과 주기 지원)
let bootTimer = null;  // 부팅 60초 첫 스캔 타이머(주기 변경/끔 시 함께 취소)
let running = false;
let stopRequested = false; // 사용자 '스캔 중지' — 진행 중 사이클을 안전하게 끊는다
let lastRun = null;     // { at, durationMs, vcenters, found, registered, delegated, errors }
let progress = null;    // { vcenterId, done, total, foundSoFar, idx, totalVcenters, startedAt }

// 주기(런타임 설정) — 웹에서 변경 시 CONFIG_DIR/idrac-scan-settings.json에 보존(업그레이드 유지).
// 미설정이면 환경변수/기본값(IDRAC_SCAN_INTERVAL_MS, 6h). 0 = 주기 비활성(수동 스캔만).
const SETTINGS_FILE = path.join(config.configDir, 'idrac-scan-settings.json');
let settingsCache;
function loadScanSettingsFile() {
  if (settingsCache !== undefined) return settingsCache;
  try { settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { settingsCache = null; }
  return settingsCache;
}
function intervalMs() {
  const s = loadScanSettingsFile();
  return (s && Number.isFinite(Number(s.intervalMs))) ? Number(s.intervalMs) : config.idrac.scanIntervalMs;
}

/** 주기 변경(웹 설정) — ms 단위(0=주기 끔). 저장 후 타이머 즉시 재적용. */
export function setIdracScanIntervalMs(ms) {
  let v = Math.max(0, Math.min(30 * 86_400_000, Number(ms) || 0)); // 상한 30일
  if (v > 0) v = Math.max(600_000, v); // 하한 10분 — 소수 시간 오입력으로 초 단위 전 대역 프로빙 폭주 방지
  settingsCache = { ...(loadScanSettingsFile() || {}), intervalMs: v };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2), { mode: 0o600 });
  } catch (e) { return { ok: false, reason: `저장 실패: ${e.message}` }; }
  rescheduleIdracScanPoller();
  return { ok: true, intervalMs: v };
}

/**
 * 스캔 중지 — ① 진행 중인 중앙 직접 스캔은 다음 IP/법인부터 중단(진행 중 probe만 마침),
 * ② 아직 에이전트가 인출하지 않은 '대기' 위임 잡은 취소한다. 이미 에이전트가 가져간(진행 중)
 * 위임 잡은 원격에서 멈출 수 없어 그대로 완료된다(결과는 무해).
 */
export function stopIdracScanNow() {
  const wasRunning = running;
  if (running) stopRequested = true;
  const canceledJobs = cancelPendingIdracScanJobs();
  return { ok: true, stoppingCentral: wasRunning, canceledJobs };
}

/** 한 법인(DataCenter) 대역을 스캔+등록(또는 위임). 반환 { datacenterId, scanned, found, registered, delegated, error }. */
async function scanOneDatacenter(e, onProgress) {
  const ips = e.ranges.join('\n');
  // 위임: 에이전트가 현지에서 스캔+자동등록(noRegister:false). 중앙 토큰 필요.
  if (e.agent && e.agent !== '__local__') {
    if (!config.central.token) return { datacenterId: e.datacenterId, delegated: false, error: '중앙 토큰 미설정으로 위임 불가' };
    const reqId = enqueueIdracScan(e.agent, { ips, username: e.username, password: e.password, datacenterId: e.datacenterId, noRegister: false });
    return { datacenterId: e.datacenterId, delegated: true, agent: e.agent, reqId: reqId || null, error: reqId ? null : '위임 잡 적재 실패(대기 한도 초과)' };
  }
  // 중앙 직접 스캔 → 발견한 iDRAC을 그 법인(DataCenter)에 등록(법인 DB).
  const r = await scanForIdracs({ ips, username: e.username, password: e.password, onProgress, shouldAbort: () => stopRequested });
  let registered = 0;
  if (r.found.length) {
    const reg = registerScanned(r.found, e.username, e.password, e.mode === 'replace-datacenter' ? 'replace-datacenter' : 'merge', '', e.datacenterId);
    if (reg.ok) registered = (reg.added || 0) + (reg.updated || 0);
  }
  return { datacenterId: e.datacenterId, delegated: false, scanned: r.scanned, found: r.found.length, registered, truncated: r.truncated };
}

/**
 * 한 사이클 실행. opts.vcenterId 지정 시 그 vCenter만(수동 '지금 스캔').
 * opts.manual=true면 enabled 여부와 무관하게 실행(단, 대역/계정은 있어야 함).
 */
export async function runIdracScanOnce(opts = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.' };
  if (isStopped()) return { ok: false, reason: '긴급중단 중' };
  let entries = enabledScanRanges();
  if (opts.datacenterId) {
    const raw = getScanRangeRaw(opts.datacenterId);
    // 수동 단건: enabled가 아니어도 실행하되 대역/계정/비밀번호는 필요.
    if (!raw || !(raw.ranges || []).length || !String(raw.username || '').trim()) {
      return { ok: false, reason: '대상 법인의 대역/계정이 없습니다.' };
    }
    if (!String(raw.password || '')) {
      return { ok: false, reason: '대상 법인의 iDRAC 비밀번호가 없습니다(스캔 대역 수정에서 입력하세요).' };
    }
    entries = [{ datacenterId: String(opts.datacenterId).trim(), ranges: (raw.ranges || []).filter(Boolean), username: String(raw.username).trim(), password: raw.password || '', agent: String(raw.agent || '').trim(), mode: raw.mode || 'merge' }];
  }
  if (!entries.length) { lastRun = { at: Date.now(), skipped: '대상 없음' }; return { ok: false, reason: '스캔할 대역이 없습니다.' }; }

  running = true;
  const started = Date.now();
  const results = [];
  let foundTotal = 0, registeredTotal = 0, delegatedTotal = 0; const errors = [];
  try {
    for (let i = 0; i < entries.length; i++) {
      if (stopRequested) { errors.push('사용자가 스캔을 중지했습니다.'); break; }
      const e = entries[i];
      progress = { datacenterId: e.datacenterId, done: 0, total: 0, foundSoFar: foundTotal, idx: i, totalDatacenters: entries.length, startedAt: started };
      try {
        const r = await scanOneDatacenter(e, (done, total) => { progress = { datacenterId: e.datacenterId, done, total, foundSoFar: foundTotal, idx: i, totalDatacenters: entries.length, startedAt: started }; });
        results.push(r);
        if (r.delegated) delegatedTotal++;
        foundTotal += (r.found || 0);
        registeredTotal += (r.registered || 0);
        if (r.error) errors.push(`${e.datacenterId}: ${r.error}`);
        recordScanRangeRun(e.datacenterId, { scanned: r.scanned ?? null, found: r.found ?? null, registered: r.registered ?? null, delegated: !!r.delegated, agent: r.agent || null, error: r.error || null });
      } catch (err) {
        errors.push(`${e.datacenterId}: ${err.message}`);
        results.push({ datacenterId: e.datacenterId, error: err.message });
        recordScanRangeRun(e.datacenterId, { error: err.message });
      }
    }
    // 새로 등록된 서버가 있으면 즉시 전력 1회 수집(대시보드에 바로 반영).
    if (registeredTotal > 0) pollNow().catch(() => {});
    lastRun = { at: Date.now(), durationMs: Date.now() - started, datacenters: entries.length, found: foundTotal, registered: registeredTotal, delegated: delegatedTotal, errors, manual: !!opts.manual, stopped: stopRequested || undefined, results };
    return { ok: true, ...lastRun };
  } catch (e) {
    lastRun = { at: Date.now(), error: e.message };
    return { ok: false, reason: e.message };
  } finally { running = false; progress = null; stopRequested = false; }
}

/** 비동기 시작(요청 즉시 반환, 창 닫아도 백그라운드 지속). */
export function startIdracScanNow(opts = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.', running: true };
  // 대역/계정 검증은 여기서 동기로 — runIdracScanOnce의 resolve({ok:false})는 아래 fire-and-forget에서
  // 버려지므로, 검증 실패를 '시작됨'으로 응답하지 않도록 사전에 걸러 사유를 그대로 돌려준다.
  if (opts.datacenterId) {
    const raw = getScanRangeRaw(opts.datacenterId);
    if (!raw || !(raw.ranges || []).length || !String(raw.username || '').trim()) {
      return { ok: false, reason: '대상 법인의 대역/계정이 없습니다.' };
    }
    if (!String(raw.password || '')) {
      return { ok: false, reason: '대상 법인의 iDRAC 비밀번호가 없습니다(스캔 대역 수정에서 입력하세요).' };
    }
  } else if (!enabledScanRanges().length) {
    return { ok: false, reason: '스캔할 대역이 없습니다.' };
  }
  runIdracScanOnce({ ...opts, manual: true }).then(
    (r) => { if (r && r.ok === false && r.reason) console.error('[idrac-scan] 백그라운드 스캔 미실행:', r.reason); },
    (e) => console.error('[idrac-scan] 백그라운드 스캔 실패:', e.message),
  );
  return { ok: true, started: true };
}

export function idracScanStatus() {
  const enabled = enabledScanRanges();
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return {
    enabledDatacenters: enabled.length,
    totalRanges: enabled.reduce((a, e) => a + e.ranges.length, 0),
    intervalMs: intervalMs(),
    running, lastRun,
    progress: progress ? { ...progress, pct } : null,
  };
}

// Node 타이머는 지연이 2^31-1ms(≈596시간)를 넘으면 1ms로 강제된다(TimeoutOverflowWarning).
// 주기 상한이 30일(720h)이므로 setInterval 대신 한계 미만 조각으로 나눈 setTimeout 체인을 쓴다.
const MAX_TIMER_MS = 2_147_000_000;
function armScanTimer(ms) {
  const step = (left) => {
    const d = Math.min(left, MAX_TIMER_MS);
    timer = setTimeout(() => {
      if (left - d > 0) return step(left - d);
      runIdracScanOnce().catch(() => {});
      step(ms);
    }, d);
    timer.unref?.();
  };
  step(ms);
}

export function rescheduleIdracScanPoller() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  const ms = intervalMs();
  if (ms <= 0) return 0; // 주기 비활성(수동 스캔만)
  armScanTimer(ms);
  return ms;
}

export function startIdracScanPoller() {
  if (!config.idrac.enabled) { console.log('[idrac-scan] poller disabled (IDRAC_ENABLED=false)'); return; }
  const ms = intervalMs();
  if (ms <= 0) { console.log('[idrac-scan] periodic scan disabled (IDRAC_SCAN_INTERVAL_MS<=0) — manual scan only'); return; }
  // 첫 스캔은 부팅 60초 후(다른 수집과 겹치지 않게), 이후 주기 반복.
  bootTimer = setTimeout(() => { bootTimer = null; runIdracScanOnce().catch((e) => console.error('[idrac-scan] 실패:', e.message)); }, 60_000);
  bootTimer.unref?.();
  armScanTimer(ms);
  console.log(`[idrac-scan] poller started (every ${Math.round(ms / 1000)}s)`);
}
