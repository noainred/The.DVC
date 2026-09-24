/**
 * Portal-embedded iDRAC power poller. On an interval it reads current power
 * from every enabled registered Dell server (Redfish) and appends a sample to
 * the time-series DB. Runs inside the portal process; failures are isolated per
 * server so one unreachable iDRAC never stalls the rest.
 */

import { config } from '../config.js';
import { withJob } from '../perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)
import { loadRegistry } from './registry.js';
import { fetchPower, fetchInventory, fetchSensors } from './redfish.js';
import { pushSensorSample } from './sensorStore.js';
import { fetchOmeDevices } from './ome.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(예전 ome.eachLimited 와 같은 격리 의미)
import { setOmeDevices, dbKey } from './omeCache.js';
import { setInventory, inventoryStale } from './invCache.js';
import { getDb } from './db.js';
import { describeError } from '../util/errors.js';
import { isStopped } from '../security/emergencyStop.js';
import { isMockMode, mockIdracPollTick } from '../mock/seed.js';
import { onSnapshotRefreshed } from '../partfault/hooks.js'; // v2.548: 인벤토리 갱신 직후 파트 장애 판정/push 트리거
import { createAuthGuard, isAuthFailureText } from '../util/authGuard.js';

/**
 * iDRAC·OME 주기 수집의 **인증 실패 정지**(v2.590 — 감사 F1, 계정 잠금 경로).
 *
 * 예전에는 자격증명이 거부돼도 다음 1분 틱에 같은 계정으로 다시 로그인했다. `redfish.js rawGet` 은
 * Basic → Digest → **세션 POST** 3단 폴백을 호출마다 반복하므로 전부 401 인 서버 1대가 **1분에 실패 인증
 * 6회**(실측 — fetchPower + fetchSensors 의 GET 3회 × 폴백)를 만들었다. iDRAC 의 IP Blocking·계정 잠금이
 * 켜진 현장이면 전력·온도 수집 자체가 막히고, 같은 계정을 쓰는 다른 수집(베어메탈 사용률)까지 죽는다.
 * 코어는 `util/authGuard.js` 하나다(v2.535). 규칙: 조용히 멈추지 않는다 · 자격증명이 바뀌면 자동 재개 ·
 * 수동 실행(`POST /idrac/poll`·연결 테스트)은 막지 않는다 · 자격증명 거부(401/403)만 멈춘다.
 *
 * 정지 id 는 이 노드 등록부의 서버 id 다 — 엣지는 자기 등록부·자기 정지 파일을 쓰므로 법인 사이에 충돌하지 않는다.
 */
const authGuard = createAuthGuard({ file: 'idrac-auth-stops.json' });

/** 오류가 iDRAC/OME **자격증명 거부**인가 — 출처(redfish.get)가 붙인 플래그를 먼저 본다. */
export function isIdracAuthError(err) {
  if (!err) return false;
  if (err.authFailed === true || err.status === 401 || err.status === 403) return true;
  // OME(ome.js)는 문구로만 올린다('OME 인증 실패 (사용자/비밀번호 확인)'). 문구 판정은 공용 코어를 쓴다.
  return isAuthFailureText(err.message || '');
}

const stopView = (rec) => (rec ? { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } : null);

/**
 * 이 서버가 인증 실패로 주기 수집이 멈췄는가 — **다른 수집기용 읽기 전용**(베어메탈 사용률이 같은 iDRAC 계정을
 * 쓰므로 함께 본다). ⚠ 기록을 지우지 않는다(peek) — 해제는 이 폴러만 한다(util/authGuard.js peekAuthStop).
 * @param {{id:string, username:string, password:string}} entry 등록부 id 와 같은 자격증명
 */
export function idracAuthStopFor(entry) { return authGuard.peekAuthStop(entry); }

/**
 * 다른 경로가 **같은 서버·같은 자격증명**으로 로그인에 성공했을 때 이 폴러의 정지를 푼다(v2.591 — 감사 R-BM1).
 * 베어메탈 사용률의 '지금 수집'(수동)이 같은 iDRAC 계정으로 텔레메트리를 읽었다면 그 계정은 맞다 — 그런데 이 폴러는
 * 정지된 서버를 주기에서 건너뛰므로 **스스로는 영원히 풀리지 않는다**(비밀번호가 iDRAC 쪽에서 되돌려진 경우 포탈
 * 값이 그대로라 credHash 자동 재개도 없다). ⚠ 기록의 자격증명(credHash)이 넘긴 값과 **같을 때만** 푼다 — 다른
 * 계정의 성공은 저장값이 맞다는 증거가 아니다.
 * @returns {boolean} 풀었으면 true
 */
export function releaseIdracAuthStop(entry) {
  if (!entry?.id || !authGuard.peekAuthStop(entry)) return false;
  return authGuard.clearAuthStop(entry.id);
}

/** 등록부 전체의 정지 기록(id → 보기용). 화면이 서버 행마다 '멈췄다' 를 말하게 한다. */
export function idracAuthStops(registry = null) {
  const out = new Map();
  let list = registry;
  if (!list) { try { list = loadRegistry(); } catch { list = []; } }
  for (const s of list || []) {
    if (!s?.id) continue;
    const rec = authGuard.authStopFor(s);
    if (rec) out.set(String(s.id), stopView(rec));
  }
  return out;
}
export function _resetIdracAuthForTest() { authGuard._resetForTest(); }

// Hardware inventory is largely static — refresh it at most every 30 minutes.
const INVENTORY_MAX_AGE_MS = 30 * 60_000;

let timer = null;
let lastRun = null; // { at, ok, failed, results: [{id, watts?, devices?, error?}] }
let running = false; // 재진입 방지(이전 폴이 끝나기 전 다음 틱이 겹쳐 도는 것 차단)
let pruneTick = 0; // retention prune 스로틀(10틱마다 1회)
const BUSY = Symbol('idrac-poll-busy'); // v2.591(감사 P1): 재진입 가드에 막혔다는 표지(수동 응답이 말하게)

async function pollOnce({ manual = false } = {}) {
  if (running) return BUSY; // 고RTT iDRAC 다수에서 한 주기가 간격을 넘겨 폴이 중첩되는 것 방지
  running = true;
  try {
    return await withJob('idrac.poll', () => pollOnceInner({ manual }));
  } finally {
    running = false;
  }
}

async function pollOnceInner({ manual = false } = {}) {
  // v2.583: 이 카운터는 v2.548 부터 **pollOnce() 안에** 선언돼 있었다 — 쓰는 곳은 이 함수라 실장비(목 모드가
  // 아닌) 폴마다 마지막 줄에서 ReferenceError 가 났고, pollNow 가 잡아 `[idrac] pollNow 실패: invRefreshed is
  // not defined` 를 **폴마다** 찍었다. 그 결과 v2.548 F7(인벤토리 갱신 즉시 파트 장애 판정) 훅은 한 번도 돌지
  // 않았다(목 모드는 위에서 먼저 return 해 드러나지 않았다). 선언을 쓰는 함수로 옮긴다.
  let invRefreshed = 0; // 이번 폴에서 인벤토리를 갱신한 서버 수 → 0 이 아니면 파트 장애 훅
  if (isStopped()) { lastRun = { at: Date.now(), ok: 0, failed: 0, skipped: '긴급중단', results: [] }; return; }
  // mock 데모: 실제 Redfish 폴 대신 합성 전력 샘플 적재(전력 화면이 비지 않게). live/auto엔 무영향.
  if (isMockMode()) {
    try { const { store } = await import('../store.js'); const r = await mockIdracPollTick(store.get?.()); lastRun = { at: Date.now(), ok: r?.measured || 0, failed: 0, mock: true, results: [] }; } catch { /* */ }
    return;
  }
  // live/auto: mock 데모 잔존 항목(id 'mock-')은 실제 폴 대상에서 제외(가짜 주소 폴 잡음 방지).
  const registry = loadRegistry();
  const servers = registry.filter((s) => s.enabled !== false && s.host && s.username && s.password && !String(s.id).startsWith('mock-'));
  // v2.493: 폴 대상에서 제외된 서버를 **이유와 함께** 기록한다. 이전에는 조용히 빠져 lastRun 에
  // 흔적조차 없었다 — 비밀번호 미저장·비활성 서버가 '수집이 멈춘 것' 으로 오해되고, 화면·로그
  // 어디에도 구분 단서가 없었다(2026-09-12 신고 진단 중 확인).
  const skipReason = (s) => (!s.host ? '주소 없음'
    : !s.username ? '계정 없음'
      : !s.password ? '비밀번호 미저장'
        : s.enabled === false ? '비활성(사용 안 함)'
          : String(s.id).startsWith('mock-') ? 'mock 데모 잔존 항목' : '');
  // 필드명은 notPolled — 긴급중단 경로가 `skipped` 를 문자열로 쓰고 있어(위 isStopped 분기) 타입이 섞이면
  // 화면이 둘을 구분할 수 없다.
  const notPolled = registry.filter((s) => !servers.includes(s)).map((s) => ({ id: s.id, name: s.name, reason: skipReason(s) }));
  if (!servers.length) { lastRun = { at: Date.now(), ok: 0, failed: 0, results: [], notPolled }; return; }
  const db = await getDb();
  const ts = Date.now();
  const results = [];
  const samples = []; // 전력 샘플을 모아 폴 종료 후 단일 트랜잭션으로 적재(서버 수만큼 fsync 방지).
  // 동시성 상한 — 무제한 Promise.all은 수백 대에 동시 TLS를 열어 CPU 스파이크/소켓 고갈.
  let authSkipped = 0; // v2.590: 인증 실패 정지로 이번 주기에 건너뛴 서버 수(실패로 세지 않는다 — 새 장애처럼 보인다)
  await poolSettled(servers, config.idrac.pollConcurrency, async (s) => {
    // v2.590: **주기 수집만** 인증 실패 정지 서버를 건너뛴다. 수동 '지금 폴' 은 사람이 1회 누르는 것이라
    // 잠금 위험이 없고, 비밀번호를 고친 뒤 확인할 길을 없애면 안 된다(authGuard 규칙 3).
    const stopped = manual ? null : authGuard.authStopFor(s);
    if (stopped) {
      authSkipped += 1;
      results.push({ id: s.id, name: s.name, type: s.type || 'idrac', authStopped: stopView(stopped) });
      return;
    }
    try {
      if (s.type === 'ome') {
        // One OME -> many devices. Persist a sample per device + cache for lookups.
        const { devices, usedMetricService, count } = await fetchOmeDevices(s);
        let measured = 0;
        for (const d of devices) {
          if (d.watts != null) { samples.push({ serverId: dbKey(s.id, d), watts: d.watts, ts }); measured++; }
        }
        setOmeDevices(s.id, devices, { usedMetricService });
        results.push({ id: s.id, name: s.name, type: 'ome', devices: count, measured, metric: usedMetricService ? 'powermanager' : 'inventory' });
      } else {
        // v2.493: 전력 조회 실패가 **센서·인벤토리 수집을 막지 않게** 개별로 격리한다.
        // 이전에는 fetchPower 가 던지면 이 블록 전체가 catch 로 빠져 온도·CPU 가 통째로 0샘플이
        // 됐다(전력 메트릭만 막힌 iDRAC·라이선스 차이에서 발생 가능). 온도 수집이 전력 수집에
        // 종속될 이유는 없다. 실패 사유는 results 에 남겨 '지금 폴' 응답에서 보이게 한다.
        let powerErr = null;
        const r = await fetchPower(s).catch((e) => { powerErr = e; return null; });
        // v2.602(LEFT2602-04 후속): 섀시 일부의 Power 조회가 실패한 **부분 합**은 적재하지 않는다 — 전력 대시보드·
        //   시간당 롤업이 그것을 그 서버의 전체 전력으로 그린다(오류 없이 틀린 값). 사실은 results·lastRun 에 밝힌다.
        if (r && r.watts != null && !r.partial) samples.push({ serverId: s.id, watts: r.watts, ts });
        // v2.590: 자격증명 거부면 **이번 주기의 나머지(센서·인벤토리)도 시도하지 않고** 정지를 기록한다 —
        // 같은 계정이라 결과가 같고, 폴백 3단(Basic·Digest·세션)이 요청마다 실패 인증을 더한다.
        if (powerErr && isIdracAuthError(powerErr)) {
          const rec = authGuard.markAuthStopped(s.id, s, describeError(powerErr).message);
          console.warn(`[idrac] ${s.name || s.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
          results.push({ id: s.id, name: s.name, type: 'idrac', watts: null, error: describeError(powerErr).message, authStopped: stopView(rec) });
          return;
        }
        if (r) authGuard.clearAuthStop(s.id); // 인증이 통했다 — 정지 기록 해제
        // 온도센서 + CPU 사용량을 매 주기(1분) 수집해 시계열에 적재(차트용, 격리).
        // 시계열에는 팬을 {name,rpm}만 싣는다 — 파트 필드(model/partNumber)는 정적 정보라
        // 1440샘플 시계열에 반복 저장하면 메모리만 낭비(인벤토리 갱신 시에만 보관).
        let sensorFans = null;
        let sensorErr = null;
        try {
          const sn = await fetchSensors(s);
          // v2.590(감사 F7): Thermal 을 하나도 못 읽었으면 **'읽었고 0개' 가 아니다** — 실패로 기록하고
          // 팬 컬렉션을 'failed' 로 올린다(파트 장애가 그 종류의 열린 장애를 닫지 않고 보류한다 — v2.548 F1).
          if (sn.thermalOk === false) sensorErr = new Error(sn.error || 'Thermal 을 읽지 못했습니다');
          else sensorFans = sn.fans;
          // 빈 표본은 적재하지 않는다 — 온도도 CPU 도 없는 점을 매 분 쌓으면 센서 탭이 'N샘플' 을 말하며
          // 정상처럼 보인다. CPU(텔레메트리)만 읽힌 경우는 그 값만 싣는다(온도는 비어 있는 채로 — 지어내지 않는다).
          if (sn.thermalOk !== false || sn.cpuUsagePct != null) {
            pushSensorSample(s.id, { t: ts, cpuUsagePct: sn.cpuUsagePct, temps: sn.thermalOk === false ? [] : sn.temps, fans: (sensorFans || []).map((f) => ({ name: f.name, rpm: f.rpm })) });
          }
        } catch (e) {
          // v2.493: 조용히 삼키지 않는다 — 센서만 실패하는 상황(Thermal 미지원 등)을 진단할 수
          // 있게 사유를 results 에 남긴다(전력 수집과는 무관하게 계속 진행).
          sensorErr = e;
          // 전력은 통했는데 센서만 자격증명 거부(권한 분리 계정 등) — 같은 계정의 반복이므로 정지한다.
          if (isIdracAuthError(e) && !r) {
            const rec = authGuard.markAuthStopped(s.id, s, describeError(e).message);
            console.warn(`[idrac] ${s.name || s.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
            // 인벤토리도 같은 계정이다 — 이번 주기에 더 로그인하지 않는다.
            results.push({ id: s.id, name: s.name, type: 'idrac', watts: null, error: describeError(e).message, authStopped: stopView(rec) });
            return;
          }
        }
        // Refresh rich inventory on a slow cadence (best-effort, non-blocking).
        if (inventoryStale(s.id, INVENTORY_MAX_AGE_MS)) {
          try {
            const inv = await fetchInventory(s);
            // 팬 파트 정보 — Thermal 은 fetchSensors 가 방금 받았으므로 재호출 없이 이관(추가 HTTP 0회).
            if (sensorFans?.length) inv.fans = sensorFans.map(({ name, model, partNumber, manufacturer, health, redundant }) => ({ name, model, partNumber, manufacturer, health, redundant }));
            // v2.548 F1: 팬은 Thermal 경로라 fetchInventory 의 컬렉션 메타에 없다 — 여기서 찍는다.
            if (inv.collections && typeof inv.collections === 'object') inv.collections.fans = sensorFans?.length ? 'ok' : (sensorErr ? 'failed' : 'ok');
            setInventory(s.id, inv);
            invRefreshed += 1;
          } catch { /* keep last */ }
        }
        results.push({
          id: s.id, name: s.name, type: 'idrac', watts: r ? r.watts : null,
          ...(r?.partial ? { powerPartial: true, failedChassis: r.failedChassis, powerPartialReason: r.failedReason || '', powerNotStored: true } : {}),
          ...(powerErr ? { error: describeError(powerErr).message } : {}),
          ...(sensorErr ? { sensorError: describeError(sensorErr).message } : {}),
        });
      }
    } catch (err) {
      const d = describeError(err);
      // OME(fetchOmeDevices)의 자격증명 거부도 같은 규칙으로 멈춘다(v2.590).
      if (isIdracAuthError(err)) {
        const rec = authGuard.markAuthStopped(s.id, s, d.message);
        console.warn(`[idrac] ${s.name || s.id}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
        results.push({ id: s.id, name: s.name, type: s.type || 'idrac', error: d.message, authStopped: stopView(rec) });
        return;
      }
      results.push({ id: s.id, name: s.name, type: s.type || 'idrac', error: d.message });
    }
  });
  // 모든 서버 폴 후 한 트랜잭션으로 배치 적재(insertMany 없으면 개별 insert 폴백).
  try { if (db.insertMany) db.insertMany(samples); else for (const sm of samples) db.insert(sm.serverId, sm.watts, sm.ts); }
  catch (e) { console.warn('[idrac] 전력 적재 실패:', e.message); }
  // Retention pruning — 매 폴 DELETE 스캔 금지(store.js/metrics 샘플러와 동일 스로틀 패턴).
  if (config.idrac.retentionDays > 0 && (++pruneTick % 10 === 0)) {
    try {
      // v2.451: 원본은 rawRetentionDays(설정 시), 롤업은 retentionDays. 0 이면 기존과 동일.
      const keep = config.idrac.retentionDays;
      const raw = config.idrac.rawRetentionDays > 0 ? Math.min(config.idrac.rawRetentionDays, keep) : keep;
      await db.prune(ts - raw * 86_400_000, ts - keep * 86_400_000);
    } catch (e) { console.warn(`[idrac] prune 실패: ${e.message}`); }
  }
  const failed = results.filter((r) => r.error).length;
  // ok 는 '성공' 만 센다 — 정지로 건너뛴 서버(authStopped·error 없음)를 성공으로 세면 거짓이다(v2.590).
  const okCount = results.filter((r) => !r.error && !r.authStopped).length;
  lastRun = { at: ts, ok: okCount, failed, results, notPolled, authStopped: results.filter((r) => r.authStopped).length, authSkipped, manual,
    powerPartial: results.filter((r) => r.powerPartial).length };   // v2.602: 부분 합이라 적재하지 않은 서버 수
  if (lastRun.powerPartial) console.warn(`[idrac] poll: 섀시 일부의 Power 조회 실패로 부분 합이 된 서버 ${lastRun.powerPartial}대 — 전력 적재를 건너뛰었습니다`);
  if (failed) console.warn(`[idrac] poll: ${okCount}/${results.length} 성공${authSkipped ? ` · 인증 실패 정지로 건너뜀 ${authSkipped}` : ''}`);
  // v2.548 F7: 인벤토리가 하나라도 갱신됐으면 파트 장애 판정(중앙)/push(엣지)를 즉시 트리거한다 —
  //   탐지 지연을 '인벤토리 주기 + 몇 초' 로 줄인다(v2.547 은 최대 ~50분). 디바운스는 훅이 한다.
  if (invRefreshed > 0) { try { onSnapshotRefreshed('idrac'); } catch { /* 훅 실패가 폴을 막지 않는다 */ } }
}

export function getPollerStatus() {
  let registry = [];
  try { registry = loadRegistry(); } catch { /* 등록부를 못 읽으면 0 */ }
  const stops = idracAuthStops(registry);
  return {
    enabled: config.idrac.enabled,
    intervalMs: config.idrac.pollIntervalMs,
    servers: registry.length,
    lastRun,
    // v2.590: 인증 실패로 주기 수집이 멈춘 서버 — 재시작 뒤에도(파일) 화면이 말하게 매번 다시 본다.
    authStops: [...stops.entries()].map(([id, v]) => ({ id, name: registry.find((x) => String(x.id) === id)?.name || id, ...v })),
  };
}

/** Trigger an immediate poll (e.g. right after a registry change). */
export async function pollNow({ manual = false } = {}) {
  try { await pollOnce({ manual }); } catch (err) { console.error('[idrac] pollNow 실패:', err.message); }
  return lastRun;
}

/**
 * 수동 '지금 수집' 전용(v2.591 — 감사 P1). `pollNow` 는 재진입 가드에 막혀도 **직전 lastRun** 을 돌려줘
 * 화면이 '수동 1회 수집 — 성공 N' 이라 말했고(이번에 수집한 것이 아니다), 긴급중단이면 `skipped` 를
 * 무시하고 '성공 0 · 실패 0' 이라 했다. 이 함수는 **무엇이 일어났는지**를 나눠 돌려준다.
 * 재진입 가드는 그대로다(동시 실행 금지 — 같은 iDRAC 에 세션이 두 배로 열린다).
 * @returns {Promise<{ran:boolean, busy:boolean, stopped:boolean, lastRun:object|null}>}
 *   busy — 다른 수집(주기 또는 다른 사람의 수동)이 진행 중이라 이번 요청은 **실행하지 않았다**(lastRun 은 직전 것)
 *   stopped — 긴급중단 중이라 수집하지 않았다
 */
export async function pollNowManual() {
  let r;
  try { r = await pollOnce({ manual: true }); } catch (err) { console.error('[idrac] 수동 수집 실패:', err.message); }
  if (r === BUSY) return { ran: false, busy: true, stopped: false, lastRun };
  const stopped = lastRun?.skipped === '긴급중단';
  return { ran: !stopped, busy: false, stopped, lastRun };
}

export function startIdracPoller() {
  if (!config.idrac.enabled) { console.log('[idrac] poller disabled (IDRAC_ENABLED=false)'); return; }
  // initial run shortly after boot, then on the configured interval
  setTimeout(() => pollNow(), 3_000).unref?.();
  timer = setInterval(() => pollNow(), config.idrac.pollIntervalMs);
  timer.unref?.();
  console.log(`[idrac] poller started (every ${Math.round(config.idrac.pollIntervalMs / 1000)}s)`);
}
