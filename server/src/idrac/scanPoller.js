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
import { saveUnsupportedServers } from '../central/unsupportedServers.js'; // v2.495: 중앙 직접 스캔의 미지원 서버 보관
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js'; // v2.478(감사 B5/S12): 원자적 쓰기 + 손상 시 preserveCorrupt — 크래시 1회로 설정이 소실되고 다음 저장이 빈 값으로 덮어쓰는 사고 방지
import { scanForIdracs, scanPartialReasons } from './scan.js';
import { registerScanned, hasHpeInDatacenter } from './registry.js';
import { pollNow } from './poller.js';
import { enabledScanRanges, recordScanRangeRun, getScanRangeRaw, scanRangesForDatacenter, lastScanCycleAt, scanEntryRuntime, scanEntryReady } from './scanRanges.js';
import { appendIdracScanLog } from './scanLog.js';
import { enqueueIdracScan, cancelPendingIdracScanJobs } from '../central/idracScanJobs.js';
import { pushIdracScan, iloEdgeGate, edgeVersionOf } from '../central/idracScanPush.js';
import { isStopped } from '../security/emergencyStop.js';
import { makeScanAuthPolicy } from './scanAuth.js';

let timer = null;      // 주기 타이머(setTimeout 체인 — 32비트 한계 초과 주기 지원)
let bootTimer = null;  // 부팅 60초 첫 스캔 타이머(주기 변경/끔 시 함께 취소)
let running = false;
// v2.611(감사 TIM2611-04): 누가 잡고 있는지 — 'periodic'(주기) · 'manual'(지금 스캔) · 'adhoc'(설정 화면 임시 스캔).
//   임시 스캔(routes/admin/idracScan.js POST /idrac/scan 로컬)이 같은 잠금을 공유해 연타·주기 스캔과 겹쳐 같은 대역에
//   같은 계정으로 로그인이 곱해지지 않게 한다(bulkRun '연타가 로그인 시도를 곱하지 않게' 와 같은 규약).
let runningKind = null;
let stopRequested = false; // 사용자 '스캔 중지' — 진행 중 사이클을 안전하게 끊는다
// v2.591(감사 C3): 키는 `datacenters` 다(대역은 법인 단위). 예전 주석이 `vcenters` 라 적어 웹이 그 키를 읽었고
//   '최근 전체/주기 스캔' 요약이 **항상 빠졌다**. 구버전 화면 호환으로 같은 값을 `vcenters` 에도 싣는다.
let lastRun = null;     // { at, durationMs, datacenters, vcenters(=datacenters), found, registered, delegated, errors }
let progress = null;    // { vcenterId, done, total, foundSoFar, idx, totalVcenters, startedAt }

// 주기(런타임 설정) — 웹에서 변경 시 CONFIG_DIR/idrac-scan-settings.json에 보존(업그레이드 유지).
// 미설정이면 환경변수/기본값(IDRAC_SCAN_INTERVAL_MS, 6h). 0 = 주기 비활성(수동 스캔만).
const SETTINGS_FILE = path.join(config.configDir, 'idrac-scan-settings.json');
let settingsCache;
function loadScanSettingsFile() {
  if (settingsCache !== undefined) return settingsCache;
  try { settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch (e) { preserveCorrupt(SETTINGS_FILE, e.message); settingsCache = null; } // 파일 없음(ENOENT)이면 preserveCorrupt 는 no-op
  return settingsCache;
}
/**
 * 스캔 주기 클램프 — 0 = 주기 끔(유지), 그 밖은 [10분, 30일].
 * v2.620(SRV2620-05): 예전에는 저장 경로(setIdracScanIntervalMs)만 잘랐고 **로드 경로는 파일 값을 그대로** 썼다 — 손으로 고친 파일·
 *   백업 복원으로 `intervalMs: 1000` 이면 1초 주기 전 대역 프로빙이 됐다(v2.602 TIM2602-04 '로드에도 저장과 같은 범위' 규약의 누락).
 *   저장·로드·env 기본값이 이 함수 하나를 지난다.
 */
export function clampScanIntervalMs(ms) {
  let v = Math.max(0, Math.min(30 * 86_400_000, Number(ms) || 0)); // 상한 30일
  if (v > 0) v = Math.max(600_000, v); // 하한 10분 — 소수 시간 오입력으로 초 단위 전 대역 프로빙 폭주 방지
  return v;
}
function intervalMs() {
  const s = loadScanSettingsFile();
  const raw = (s && s.intervalMs !== '' && s.intervalMs != null && Number.isFinite(Number(s.intervalMs))) ? Number(s.intervalMs) : config.idrac.scanIntervalMs;
  return clampScanIntervalMs(raw);
}

/** 주기 변경(웹 설정) — ms 단위(0=주기 끔). 저장 후 타이머 즉시 재적용. */
export function setIdracScanIntervalMs(ms) {
  const v = clampScanIntervalMs(ms);
  settingsCache = { ...(loadScanSettingsFile() || {}), intervalMs: v };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2), { mode: 0o600 });
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
async function scanOneDatacenter(e, onProgress, trigger = 'periodic') {
  const ips = e.ranges.join('\n');
  // 위임: 에이전트가 현지에서 스캔+자동등록(noRegister:false).
  if (e.agent && e.agent !== '__local__') {
    // v2.611(감사 EDGE2611-01·RECENT2611-03): 위임 전 엣지 버전 게이트 — iLO 전용 대역을 iLO 를 모르는 엣지(< 2.610)·버전 미상
    //   엣지에 보내지 않는다(구버전은 빈 계정으로 전 호스트에 로그인한다). Dell+iLO 대역은 보내되 구버전이면 iLO 가 적용되지
    //   않는다는 사실을 lastRun 에 남긴다. push 경로는 pushIdracScan 이 같은 판정을 한 번 더 한다(수동 PUSH 대비).
    const hasIlo = Boolean(e.ilo && e.ilo.username && e.ilo.password);
    const hasDell = Boolean(String(e.username || '').trim() && e.password);
    const gate = iloEdgeGate({ hasDell, hasIlo, version: edgeVersionOf(e.agent) });
    if (!gate.delegate) {
      console.warn(`[idrac-scan] ${e.datacenterId}: ${gate.reason}`);
      return { datacenterId: e.datacenterId, delegated: false, held: true, agent: e.agent, heldReason: gate.reason, edgeVersion: gate.edgeVersion || '', error: null };
    }
    const iloNote = gate.iloIgnored ? gate.note : null;
    // dispatch=push: 중앙이 수집 서버 URL로 엣지에 직접 스캔 전송(엣지 폴링 불필요). 중앙 토큰 불요.
    if (e.dispatch === 'push') {
      const pr = pushIdracScan(e.agent, { ips, username: e.username, password: e.password, ilo: e.ilo || null, datacenterId: e.datacenterId, noRegister: false, service: e.service, trigger, rangeId: e.id || '' });
      if (pr.held) return { datacenterId: e.datacenterId, delegated: false, held: true, agent: e.agent, heldReason: pr.reason, edgeVersion: pr.edgeVersion || '', error: null };
      return { datacenterId: e.datacenterId, delegated: true, dispatch: 'push', agent: e.agent, reqId: pr.reqId || null, error: pr.ok ? null : pr.reason, iloNote };
    }
    // 기본(poll): 에이전트가 중앙으로 폴링해 잡을 인출. 중앙 토큰 필요.
    if (!config.central.token) return { datacenterId: e.datacenterId, delegated: false, error: '중앙 토큰 미설정으로 위임 불가' };
    const reqId = enqueueIdracScan(e.agent, { ips, username: e.username, password: e.password, ilo: e.ilo || null, datacenterId: e.datacenterId, noRegister: false, service: e.service, trigger, rangeId: e.id || '' });
    return { datacenterId: e.datacenterId, delegated: true, dispatch: 'poll', agent: e.agent, reqId: reqId || null, error: reqId ? null : '위임 잡 적재 실패(대기 한도 초과)', iloNote };
  }
  // 중앙 직접 스캔 → 발견한 iDRAC을 그 법인(DataCenter)에 등록(법인 DB).
  // v2.591(감사 F3): 주기 스캔은 직전 인증 실패 IP·주 폴러 정지 서버를 건너뛴다(수동은 전부 시도하되 기록한다).
  const started = Date.now();
  const ilo = e.ilo && e.ilo.username && e.ilo.password ? e.ilo : null;   // v2.610: HPE iLO 계정(선택)
  const authPolicy = makeScanAuthPolicy({ rangeId: e.id || e.datacenterId || '', username: e.username, password: e.password, ilo, periodic: trigger === 'periodic' });
  const r = await scanForIdracs({ ips, username: e.username, password: e.password, ilo, onProgress, shouldAbort: () => stopRequested, authPolicy });
  let registered = 0;
  // v2.495: 비-Dell(미지원) 서버 보관 — 중앙 직접 스캔은 agent '' 키. 중단된 스캔은 부분 결과라 저장하지 않는다(직전 보존).
  if (!r.aborted) {
    try { saveUnsupportedServers({ agent: '', datacenterId: e.datacenterId || '', service: e.service || '', trigger: 'periodic' }, r.unsupported || [], { count: r.unsupportedCount, truncated: r.unsupportedTruncated }); }
    catch (err) { console.warn('[idrac-scan] 미지원 서버 저장 실패:', err?.message); }
  }
  // replace-datacenter는 이 법인의 기존 등록을 '발견 목록'으로 통째 교체한다. 스캔이 중단
  // (aborted)되거나 IP 상한으로 절단(truncated)돼 부분 결과면, 스캔 안 된 서버가 삭제된다
  // (자격증명·전력 이력까지). 부분 결과일 때는 merge로 강등해 데이터 손실을 막는다.
  // v2.591: 인증 정지로 건너뛴 IP 가 있으면 부분 결과다 — replace 로 두면 **건너뛴 등록 서버가 삭제**된다.
  // v2.611(감사 RECENT2611-01): 사유 판정은 scan.js scanPartialReasons 하나(엣지 localScan.js 와 같은 규칙) — 계정이 없어
  //   시도하지 않은 서버(noCreds)·인증 실패 서버·(iLO 계정 없이) 이미 등록된 HPE 가 있으면 replace 가 그 등록을 지운다.
  const partialReasons = e.mode === 'replace-datacenter' ? scanPartialReasons(r, { registeredHpe: hasHpeInDatacenter(e.datacenterId) }) : [];
  const partial = partialReasons.length > 0;
  const effectiveMode = (e.mode === 'replace-datacenter' && !partial) ? 'replace-datacenter' : 'merge';
  if (partial) console.warn(`[idrac-scan] ${e.datacenterId}: 부분 결과라 법인 교체(replace-datacenter) 대신 병합(merge)으로 등록합니다 — ${partialReasons.join(' · ')}`);
  if (r.found.length) {
    const reg = registerScanned(r.found, e.username, e.password, effectiveMode, '', e.datacenterId, { ilo });
    if (reg.ok) registered = (reg.added || 0) + (reg.updated || 0);
  }
  // v2.591(감사 C5): 무응답·인증실패·소요를 싣는다 — 위임 회신(central/idracScanJobs.js)과 같은 모양. 예전에는 빠져
  //   비밀번호가 틀려도 '최근 결과' 가 '성공 · 발견 0대' 로 보였다(형제 비대칭).
  return {
    datacenterId: e.datacenterId, delegated: false, scanned: r.scanned, found: r.found.length, registered, truncated: r.truncated, aborted: r.aborted,
    modeDowngraded: e.mode === 'replace-datacenter' && partial, modeDowngradedReason: partial ? partialReasons.join(' · ') : null, unsupported: r.unsupportedCount || 0,
    unreachable: r.unreachable ?? null, authFailed: r.authFailed ?? null, authFailReason: r.authFailReason || null,
    blocked: r.blocked ?? null, authSkipped: r.authSkipped || 0, authSkippedRegistered: r.authSkippedRegistered || 0,
    // v2.610: 벤더별 — iLO 계정이 있는 대역만 hpe 값이 의미를 갖는다(없으면 iloEnabled:false).
    iloEnabled: !!r.iloEnabled, dellFound: r.dellFound ?? r.found.length, hpeFound: r.hpeFound || 0, hpeDetected: r.hpeDetected || 0, hpeAuthFailed: r.hpeAuthFailed || 0, noCreds: r.noCreds || 0,
    noCredsIps: Array.isArray(r.noCredsIps) ? r.noCredsIps : [], noCredsTruncated: !!r.noCredsTruncated,
    durationMs: Date.now() - started,
  };
}

/**
 * 한 사이클 실행. opts.vcenterId 지정 시 그 vCenter만(수동 '지금 스캔').
 * opts.manual=true면 enabled 여부와 무관하게 실행(단, 대역/계정은 있어야 함).
 */
export async function runIdracScanOnce(opts = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.' };
  if (isStopped()) return { ok: false, reason: '긴급중단 중' };
  let entries = enabledScanRanges();
  if (opts.id) {
    // 수동 단건(엔트리 하나): enabled가 아니어도 실행하되 대역/계정/비밀번호는 필요.
    const raw = getScanRangeRaw(opts.id);
    // v2.610: 계정은 iDRAC 또는 HPE iLO 중 하나만 있어도 된다(둘 다 없을 때만 거절).
    if (!raw || !(raw.ranges || []).length) return { ok: false, reason: '대상 항목의 대역이 없습니다.' };
    if (!scanEntryReady(raw)) {
      return { ok: false, reason: '대상 항목에 스캔 계정이 없습니다 — iDRAC 계정·비밀번호 또는 HPE iLO 계정·비밀번호를 스캔 대역 수정에서 입력하세요.' };
    }
    entries = [scanEntryRuntime(raw.id, raw)];
  } else if (opts.datacenterId) {
    // 한 법인의 모든 서비스 엔트리(비밀번호/대역/계정 갖춘 것만).
    entries = scanRangesForDatacenter(opts.datacenterId)
      .filter((e) => scanEntryReady(e))
      .map((e) => scanEntryRuntime(e.id, e));
    if (!entries.length) return { ok: false, reason: '대상 법인에 스캔 가능한 대역/계정이 없습니다.' };
  }
  if (!entries.length) { lastRun = { at: Date.now(), skipped: '대상 없음' }; return { ok: false, reason: '스캔할 대역이 없습니다.' }; }

  running = true;
  runningKind = opts.manual ? 'manual' : 'periodic';
  const started = Date.now();
  const results = [];
  let foundTotal = 0, registeredTotal = 0, delegatedTotal = 0, heldTotal = 0; const errors = [];
  try {
    for (let i = 0; i < entries.length; i++) {
      if (stopRequested) { errors.push('사용자가 스캔을 중지했습니다.'); break; }
      const e = entries[i];
      const trigger = opts.manual ? 'manual' : 'periodic';
      const entryStart = Date.now();
      progress = { datacenterId: e.datacenterId, done: 0, total: 0, foundSoFar: foundTotal, idx: i, totalDatacenters: entries.length, startedAt: started };
      try {
        // scanForIdracs는 onProgress(done, total, foundNow)로 현재 DC의 실시간 발견 수를 준다.
        // 이전엔 3번째 인자를 버리고 foundTotal(직전 DC까지 누계)만 써서 스캔 중 '발견 0대'로
        // 보이다가 끝에 점프했다 → 누계 + 현재 DC 실시간을 합산해 표시.
        const r = await scanOneDatacenter(e, (done, total, foundNow = 0) => { progress = { datacenterId: e.datacenterId, done, total, foundSoFar: foundTotal + foundNow, idx: i, totalDatacenters: entries.length, startedAt: started }; }, trigger);
        results.push(r);
        if (r.delegated) delegatedTotal++;
        if (r.held) heldTotal++;
        foundTotal += (r.found || 0);
        registeredTotal += (r.registered || 0);
        if (r.error) errors.push(`${e.datacenterId}: ${r.error}`);
        // v2.441: 위임이면 reqId 를 함께 남긴다 — 나중에 에이전트가 결과를 회신할 때
        // recordScanRangeRunByReqId 가 이 값으로 짝을 찾아 발견/등록 수치를 채운다.
        // (예전에는 '던짐' 만 기록돼 '최근 결과' 가 영원히 '위임(AZ) · 시각' 이었다.)
        if (e.id && r.held) {
          // v2.611: 위임 보류(엣지 버전) — 실패가 아니라 '보내지 않았다' 이다. 화면(scanRunText)이 '보류' 로 사유를 말한다.
          recordScanRangeRun(e.id, { held: true, heldReason: r.heldReason || '', agent: r.agent || null, edgeVersion: r.edgeVersion || '', delegated: false, error: null });
        } else if (e.id) {
          recordScanRangeRun(e.id, {
            scanned: r.scanned ?? null, found: r.found ?? null, registered: r.registered ?? null,
            blocked: r.blocked ?? null, // v2.537: 차단 대역이라 찌르지 않은 IP 수(조용한 제외 금지)
            // v2.591(감사 C5·F3): 위임 회신과 같은 필드 — 화면(scanRunText)이 '(무응답 N · 인증실패 N)'·소요를 그린다.
            ...(r.delegated ? {} : {
              unreachable: r.unreachable ?? null, authFailed: r.authFailed ?? null,
              authSkipped: r.authSkipped || 0, durationMs: r.durationMs ?? null,
              // v2.610: HPE 판별·등록 대수 — 화면 '최근 결과' 가 'HPE N대' 를 말한다.
              hpeDetected: r.hpeDetected || 0, hpeDetectedApprox: false, hpeFound: r.hpeFound || 0, iloEnabled: !!r.iloEnabled,
              // v2.611(감사 RECENT2611-04): 계정이 없어 시도하지 않은 서버 — 화면이 '계정 없어 시도 안 함 N' 을 말한다.
              noCreds: r.noCreds || 0,
              ...(r.modeDowngraded ? { modeDowngraded: true, modeDowngradedReason: r.modeDowngradedReason || '' } : {}),
            }),
            ...(r.iloNote ? { iloNote: r.iloNote } : {}),
            delegated: !!r.delegated, agent: r.agent || null, error: r.error || null,
            ...(r.delegated ? { reqId: r.reqId || '', dispatch: r.dispatch || e.dispatch || 'poll', dispatchedAt: Date.now(), pending: true } : {}),
          });
        }
        // 스캔 로그(이력) 적재 — 위임은 '요청' 단계로 기록하고, 결과는 에이전트 회신 시
        // setIdracScanResult 훅이 별도 1건(phase=result)으로 남긴다(reqId로 짝 맞춤).
        appendIdracScanLog({
          trigger, phase: r.delegated ? 'dispatch' : 'result', kind: (r.delegated || r.held) ? 'delegated' : 'central',
          datacenterId: e.datacenterId, service: e.service, agent: (r.delegated || r.held) ? (r.agent || e.agent) : '',
          dispatch: r.delegated ? (r.dispatch || e.dispatch) : '', reqId: r.reqId || '',
          scanned: r.scanned ?? null, found: r.found ?? null, registered: r.registered ?? null,
          durationMs: r.delegated ? null : Date.now() - entryStart, error: r.error || null, stopped: r.aborted,
          ...(r.delegated ? {} : { unreachable: r.unreachable ?? null, authFailed: r.authFailed ?? null, authSkipped: r.authSkipped || 0, noCreds: r.held ? null : (r.noCreds || 0) }),
          ...(r.held ? { error: r.heldReason || '위임 보류' } : {}),
        });
        if (!r.delegated && (r.authSkipped || 0) > 0) console.warn(`[idrac-scan] ${e.datacenterId}: 인증 실패 정지로 ${r.authSkipped}개 IP 를 건너뛰었습니다(주기 스캔 — 계정을 고치거나 '지금 스캔' 으로 확인)`);
      } catch (err) {
        errors.push(`${e.datacenterId}: ${err.message}`);
        results.push({ datacenterId: e.datacenterId, error: err.message });
        if (e.id) recordScanRangeRun(e.id, { error: err.message });
        appendIdracScanLog({ trigger, phase: 'result', kind: (e.agent && e.agent !== '__local__') ? 'delegated' : 'central', datacenterId: e.datacenterId, service: e.service, agent: e.agent !== '__local__' ? e.agent : '', durationMs: Date.now() - entryStart, error: err.message });
      }
    }
    // 새로 등록된 서버가 있으면 즉시 전력 1회 수집(대시보드에 바로 반영).
    if (registeredTotal > 0) pollNow().catch(() => {});
    const authSkippedTotal = results.reduce((a, x) => a + (x.authSkipped || 0), 0);
    const noCredsTotal = results.reduce((a, x) => a + (x.noCreds || 0), 0);
    lastRun = { at: Date.now(), durationMs: Date.now() - started, datacenters: entries.length, vcenters: entries.length, found: foundTotal, registered: registeredTotal, delegated: delegatedTotal, errors, manual: !!opts.manual, stopped: stopRequested || undefined, ...(authSkippedTotal ? { authSkipped: authSkippedTotal } : {}), ...(noCredsTotal ? { noCreds: noCredsTotal } : {}), ...(heldTotal ? { held: heldTotal } : {}), results };
    return { ok: true, ...lastRun };
  } catch (e) {
    lastRun = { at: Date.now(), error: e.message };
    return { ok: false, reason: e.message };
  } finally { running = false; runningKind = null; progress = null; stopRequested = false; }
}

/** 스캔 잠금 사유 문구 — 진행 중인 쪽이 무엇인지 밝힌다(조치가 다르다: 주기는 기다리면 끝나고, 임시 스캔은 다른 관리자가 돌리는 것). */
export function scanBusyReason(kind = runningKind) {
  const who = kind === 'periodic' ? '주기 스캔' : kind === 'manual' ? "'지금 스캔'" : kind === 'adhoc' ? '다른 임시 스캔' : '다른 스캔';
  return `${who}이 진행 중입니다 — 끝난 뒤 다시 시도하세요(같은 대역에 같은 계정으로 로그인이 겹치지 않게 한 번에 하나만 돕니다).`;
}

/**
 * v2.611(감사 TIM2611-04): 임시 스캔용 잠금 — 주기·'지금 스캔' 과 **같은** running 을 쓴다.
 * @returns {{ok:true}|{ok:false, busy:true, by:string|null, reason:string}}
 * 반드시 finally 에서 releaseScan() 을 부를 것.
 */
export function tryAcquireScan(kind = 'adhoc') {
  if (running) return { ok: false, busy: true, by: runningKind, reason: scanBusyReason(runningKind) };
  running = true; runningKind = kind;
  return { ok: true };
}
export function releaseScan() { running = false; runningKind = null; stopRequested = false; }
/** v2.612 EDGE2612-01: 잠그지 않고 진행 여부만 본다(폴링 워커가 잡을 인출하기 전에 — 진행 중이면 인출하지 않아 잡이 대기열에 남는다). */
export function scanLockBusy() { return running ? { busy: true, by: runningKind, reason: scanBusyReason(runningKind) } : null; }

/** 비동기 시작(요청 즉시 반환, 창 닫아도 백그라운드 지속). */
export function startIdracScanNow(opts = {}) {
  if (running) return { ok: false, reason: '이미 스캔 중입니다.', running: true };
  // 대역/계정 검증은 여기서 동기로 — runIdracScanOnce의 resolve({ok:false})는 아래 fire-and-forget에서
  // 버려지므로, 검증 실패를 '시작됨'으로 응답하지 않도록 사전에 걸러 사유를 그대로 돌려준다.
  if (opts.id) {
    const raw = getScanRangeRaw(opts.id);
    if (!raw || !(raw.ranges || []).length) return { ok: false, reason: '대상 항목의 대역이 없습니다.' };
    if (!scanEntryReady(raw)) {
      return { ok: false, reason: '대상 항목에 스캔 계정이 없습니다 — iDRAC 계정·비밀번호 또는 HPE iLO 계정·비밀번호를 스캔 대역 수정에서 입력하세요.' };
    }
  } else if (opts.datacenterId) {
    const list = scanRangesForDatacenter(opts.datacenterId).filter((e) => scanEntryReady(e));
    if (!list.length) return { ok: false, reason: '대상 법인에 스캔 가능한 대역/계정이 없습니다.' };
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
    running, runningKind, lastRun,
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
  // 재시작(업그레이드)이 스캔을 앞당기지 않게 한다 — 마지막 스캔 시각을 기준으로 '다음 예정 시각'에
  // 첫 실행을 맞춘다. 아직 주기가 안 지났으면 재시작만으로 스캔하지 않는다(무조건 60초 후 실행 버그 수정).
  const last = lastScanCycleAt();
  const now = Date.now();
  const BOOT_MIN = 60_000; // 미실행/기한초과 시에도 다른 수집과 겹치지 않게 60초는 지연
  let firstDelay;
  if (last <= 0) firstDelay = BOOT_MIN;                       // 한 번도 스캔한 적 없음 → 최초 1회
  else if (now - last >= ms) firstDelay = BOOT_MIN;           // 이미 주기 경과(기한 초과) → 곧 실행
  else firstDelay = Math.max(BOOT_MIN, (last + ms) - now);    // 아직 주기 전 → 다음 예정 시각까지 대기
  // 32비트 타이머 한계를 넘는 지연(장주기)도 조각으로 나눠 대기(armScanTimer와 동일 패턴).
  const step = (left) => {
    const d = Math.min(left, MAX_TIMER_MS);
    bootTimer = setTimeout(() => {
      if (left - d > 0) return step(left - d); // 아직 남음 → 계속 대기(스캔 안 함)
      bootTimer = null;
      runIdracScanOnce().catch((e) => console.error('[idrac-scan] 실패:', e.message));
      armScanTimer(ms); // 이후 주기 반복
    }, d);
    bootTimer.unref?.();
  };
  step(firstDelay);
  console.log(`[idrac-scan] poller started — first scan in ${Math.round(firstDelay / 1000)}s (last=${last ? new Date(last).toISOString() : 'never'}), then every ${Math.round(ms / 1000)}s`);
}
