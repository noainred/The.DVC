/**
 * Portal-embedded iDRAC power poller. On an interval it reads current power
 * from every enabled registered Dell server (Redfish) and appends a sample to
 * the time-series DB. Runs inside the portal process; failures are isolated per
 * server so one unreachable iDRAC never stalls the rest.
 */

import { config } from '../config.js';
import { withJob } from '../perf/monitor.js'; // v2.498: 스톨 발생 시 '진행 중 작업' 표시(계측 전용)
import { loadRegistry, correctHpeServiceTag } from './registry.js';
import { fetchPower, fetchInventory, fetchSensors, fetchSensorCollection, pruneSensorPaths, sensorPathKeyOf } from './redfish.js';
import { setThermalDetail, setSensorCollection, sensorCollectionStale } from './sensorDetailCache.js'; // v2.659 센서 상세
import { pushSensorSample, setSensorPollCycle, markSensorPollStart } from './sensorStore.js';
import { fetchOmeDevices } from './ome.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스(예전 ome.eachLimited 와 같은 격리 의미)
import { setOmeDevices, dbKey } from './omeCache.js';
import { setInventory, getInventory, inventoryStale, isForcedStale, staleMarkOf } from './invCache.js';
import { getDb } from './db.js';
import { describeError } from '../util/errors.js';
import { isStopped } from '../security/emergencyStop.js';
import { isMockMode, mockIdracPollTick } from '../mock/seed.js';
import { onSnapshotRefreshed } from '../partfault/hooks.js'; // v2.548: 인벤토리 갱신 직후 파트 장애 판정/push 트리거
import { createAuthGuard, isAuthFailureText, authStopView } from '../util/authGuard.js';

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

const stopView = authStopView;   // 127회차: 사본 대신 공용(못 읽음 표지 unread 를 떨구지 않는다)

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
    // 130회차(127 반증): 보기만 한다(peekAuthStop) — 이 함수는 폴러 상태 · 목록 조회가 등록부 **전체**에 부른다. authStopFor 면 못 읽는 창에서 이번 주기에
    //   수집하지 않는 서버가 자격 지문의 탐침을 받아 가 결과가 오지 않았다(시한 10분씩 지연). 주기 수집의 문(pollOnce)은 그대로 authStopFor 다.
    const rec = authGuard.peekAuthStop(s);
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
let _runningSince = null; // v2.634: 진행 중인 주기의 시작 시각
let _lastDurationMs = null; // v2.634: 직전 주기 소요
let pruneTick = 0; // retention prune 스로틀(10틱마다 1회)
let _sensorPathPruneAt = 0; // v2.689(C-07): 센서 경로 캐시 정리 — 인벤토리 주기(30분)에 한 번
/**
 * v2.689(C-07): Enterprise 대체 경로(redfish.fetchUsageSensors)의 센서 경로 캐시를 등록부 기준으로 정리한다.
 * live = 등록부 전체(비활성·비밀번호 미저장 포함 — 지우지 않는 쪽). 등록부가 비었으면 못 읽었을 수도 있어 퇴역 판정을 하지 않는다.
 */
export function pruneSensorPathCache(registry, now = Date.now()) {
  const list = Array.isArray(registry) ? registry : [];
  const live = list.length ? new Set(list.filter((s) => s && s.host).map((s) => sensorPathKeyOf(s))) : null;
  return pruneSensorPaths(live, now);
}
const BUSY = Symbol('idrac-poll-busy'); // v2.591(감사 P1): 재진입 가드에 막혔다는 표지(수동 응답이 말하게)

// 이벤트 읽기(그 서버들만)와 정규 · 수동 주기는 **전역으로 서로 기다리지 않는다** — 겹침은 서버 단위로만 피한다(같은 iDRAC 에 세션이 겹치지 않게).
//   전역 가드를 나눠 쓰면 이벤트를 계속 보내는 느린 장비가 함대 수집을 밀어냈고(2회차 Q1), 기다리게 하면 굶었으며(3회차 R2), 양보 분기는 걸리지 않았다(4회차 엣지 #1).
//   · 이벤트 읽기는 정규 주기가 지금 읽고 있는 **그 서버만** 끝나기를 기다렸다가 읽는다(건너뛰면 그 장비의 인벤토리를 정규 주기가 떠안아 주기가 간격을 넘겼다 — 5회차 성능 D1).
//   · 정규 주기는 이벤트 읽기가 맡았거나 맡을 서버의 인벤토리는 읽지 않는다(이벤트 쪽이 읽는다) · 지금 읽고 있는 서버는 그 주기에 건너뛴다(eventBusy).
//   · 두 쪽이 **동시 상한 하나**(pollConcurrency)를 함께 쓴다(각자 풀을 쓰면 세션이 상한의 두 배까지 갔다 — 5회차 성능 D2).
//   · 자리가 나면 **정규 · 수동 주기 대기자에게 먼저** 넘긴다 — 이벤트 읽기(한 대에 인벤토리까지 요청 수 배)가 FIFO 로 번갈아 자리를 쥐면 상한이 작을 때
//     느린 장비 하나의 이벤트만으로 함대 정규 수집이 밀렸다(6회차 성능 P1: 상한 1 에서 정규 4/12).
//   · 단 상한이 2 이상이면 이벤트 읽기에 **몫**(상한의 1/4 · 최소 1)을 둔다 — 정규 대기자가 있어도 그 몫까지는 이벤트에 먼저 넘긴다.
//     몫이 없으면 함대가 상한보다 클 때 이벤트 읽기가 남은 정규 주기를 다 기다렸다(7회차 엣지 #4: 기본 16 · 함대 160 에서 이벤트 → 첫 요청 12.7초).
//     상한 1 은 몫 0 — 정규 먼저(6회차 P1).
//   · 이벤트 읽기에는 **전용 자리 1**(상한 밖 — 사용자 결정 2026-11-27)을 더 둔다: 전체 iDRAC 동시 세션 ≤ IDRAC_POLL_CONCURRENCY + 1.
//     상한 1(몫 0)이면 이벤트 읽기는 **전용 자리만** 쓴다 — 정규 주기의 하나뿐인 자리를 쥐지 않는다(6회차 성능 P1 남긴 것). 묶음이 여럿 함께 돌 때 둘째 읽기가
//     주기 사이의 빈 공용 자리를 받아 다음 주기 시작을 그 읽기만큼 밀었다(반증 12a F1 — 1.8초). 몫이 있으면(상한 2 이상) 전용이 차 있을 때 공용 자리(몫 · 정규 먼저 규칙)로 간다.
//     같은 장비 동시 세션은 여전히 1(_eventIds · _cycleInflight).
//   · 이벤트 묶음은 **여러 개가 함께 돈다**(v3.52 설계 ④ — 사용자 결정 2026-11-27). 예전에는 한 번에 하나(_eventRunning)라 느린 서버 하나가 낀 묶음이 끝날 때까지
//     다른 서버의 이벤트가 기다렸다. 묶음 수 상한은 eventSub(EVT_BATCH_CONC) · 장비 세션 상한은 위 자리(공용 + 전용)가 지킨다 · 같은 서버를 두 묶음이 함께 읽지 않는다(_eventIds).
let _eventBatches = 0;            // 진행 중인 이벤트 묶음 수(진단용)
const _eventIds = new Set();      // 이벤트 읽기가 지금 읽는 서버
const _eventPending = new Map();  // 서버 → 그 서버를 맡은 진행 중 이벤트 묶음 수(아직 안 읽은 것 포함) — 정규 주기는 이 서버의 인벤토리를 새로 읽기 시작하지 않는다
const pendAdd = (id) => { _eventPending.set(id, (_eventPending.get(id) || 0) + 1); };
const pendDel = (id) => { const n = (_eventPending.get(id) || 0) - 1; if (n > 0) _eventPending.set(id, n); else _eventPending.delete(id); };
const _cycleInflight = new Map(); // 정규 주기가 지금 읽고 있는 서버 → 끝나면 풀리는 약속
const _slot = { n: 0, ev: 0, ded: 0, q: [], qe: [] };    // 정규 · 이벤트가 함께 쓰는 동시 상한 · ev = 이벤트 읽기가 쥔 공용 자리 · ded = 이벤트 전용 자리(상한 밖) · q = 정규 · 수동 대기 · qe = 이벤트 읽기 대기
export const EVENT_DEDICATED_SLOTS = 1;   // 이벤트 읽기 전용 자리 수(상한 밖)
export function _eventStateForTest() { return { batches: _eventBatches, pending: _eventPending.size, reading: _eventIds.size }; }
export function _slotStateForTest() { return { n: _slot.n, ev: _slot.ev, ded: _slot.ded, q: _slot.q.length, qe: _slot.qe.length }; }
const slotMax = () => Math.max(1, Number(config.idrac.pollConcurrency) || 1);
const eventShare = (max) => (max > 1 ? Math.max(1, Math.floor(max / 4)) : 0);   // 정규 대기자가 있어도 이벤트에 먼저 넘기는 자리 수(7회차 엣지 #4)
async function acquireSlot(kind = 'cycle') {
  const max = slotMax();
  if (kind === 'event') {
    // 전용 자리 먼저(상한 밖 — 정규 주기 자리를 쓰지 않는다). 돌려주는 값 'd'(전용) · 's'(공용) — releaseSlot('event', 그 값)
    if (_slot.ded < EVENT_DEDICATED_SLOTS) { _slot.ded += 1; return 'd'; }
    // 공용 자리: 바로 잡는 길은 이벤트 몫이 남았을 때만 — 몫 밖(상한 1 등)은 늘 줄에 서고 한 틱 늦게 받는다. 정규 주기가 읽던 그 서버를 기다리던 이벤트는
    //   그 방문이 끝나는 순간(done) 깨어나 정규 작업자가 다음 서버 자리를 잡기 전에 빈 자리를 가로챘다(7회차 성능 P2 — 상한 1 에서 정규 2~3/12)
    if (_slot.n < max && _slot.ev < eventShare(max)) { _slot.n += 1; _slot.ev += 1; return 's'; }
    return new Promise((r) => { _slot.qe.push(r); setImmediate(drainEventSlots); });   // 넘겨주는 쪽(drain · release)이 n · ev · ded 를 맞추고 'd' · 's' 로 깨운다
  }
  if (_slot.n < max) { _slot.n += 1; return; }
  await new Promise((r) => { _slot.q.push(r); });   // 풀어 주는 쪽이 자리를 그대로 넘긴다(n 그대로)
}
// 정규 대기자 먼저(6회차 성능 P1) — 이벤트 몫이 남았으면 그 몫까지는 이벤트 먼저(7회차 엣지 #4). 정규 작업자는 서버 하나를 끝내고 다음 서버 자리를
//   **다음 마이크로태스크에** 잡으므로, 정규 대기자가 없을 때 이벤트 대기자에게는 한 틱(setImmediate) 늦게 넘긴다 — 바로 넘기면 주기 도중 자리를 이벤트가 가로챘다.
function releaseSlot(kind = 'cycle', token = 's') {
  if (kind === 'event' && token === 'd') {   // 전용 자리 — 기다리는 이벤트가 있으면 그대로 넘기고, 없으면 비운다(공용 자리와 섞지 않는다)
    const w = _slot.qe.shift();
    if (w) w('d'); else _slot.ded -= 1;
    return;
  }
  if (kind === 'event') _slot.ev -= 1;
  if (_slot.qe.length && _slot.ev < eventShare(slotMax())) { _slot.ev += 1; _slot.qe.shift()('s'); return; }   // n 그대로 넘긴다
  const r = _slot.q.shift();
  if (r) { r(); return; }
  _slot.n -= 1;
  if (_slot.qe.length) setImmediate(drainEventSlots);
}
function drainEventSlots() {
  const max = slotMax();
  while (_slot.qe.length && _slot.ded < EVENT_DEDICATED_SLOTS) { _slot.ded += 1; _slot.qe.shift()('d'); }
  const share = eventShare(max);
  // 몫 0(상한 1)이면 공용 자리를 빌리지 않는다 — 정규 대기자가 없는 주기 사이에 빌리면 다음 주기가 그 읽기를 기다린다(반증 12a F1)
  while (share > 0 && _slot.n < max && _slot.qe.length && (!_slot.q.length || _slot.ev < share)) { _slot.n += 1; _slot.ev += 1; _slot.qe.shift()('s'); }
}
async function pollOnce({ manual = false, only = null, onRefreshed = null, onServerDone = null } = {}) {
  if (only) {
    // 이벤트 묶음끼리는 막지 않는다(설계 ④) — 지금 읽는 서버 표시(_eventIds)는 서버를 실제로 읽기 시작할 때 넣고 다 읽으면 바로 뺀다(5회차 엣지 #2)
    const eventLeft = new Set([...only].map(String));   // 이 묶음이 맡은 표시 중 아직 내려놓지 않은 것(서버마다 다 읽으면 바로 · 나머지는 끝에)
    for (const id of eventLeft) pendAdd(id);
    _eventBatches += 1;
    try { return await withJob('idrac.poll.event', () => pollOnceInner({ manual, only, onRefreshed, eventLeft, onServerDone })); } finally { for (const id of eventLeft) pendDel(id); _eventBatches -= 1; }
  }
  if (running) return BUSY; // 고RTT iDRAC 다수에서 한 주기가 간격을 넘겨 폴이 중첩되는 것 방지
  running = true;
  try {
    return await withJob('idrac.poll', () => pollOnceInner({ manual, only }));
  } finally {
    running = false;
    // 주기가 도중에 던졌으면 끝을 알리지 못했다 — 경과를 소요로 남겨 '영원히 도는 주기' 로 보이지 않게 한다.
    if (_runningSince != null) {
      try { setSensorPollCycle({ durationMs: Date.now() - _runningSince, intervalMs: config.idrac.pollIntervalMs }); } catch { /* */ }
    }
    _runningSince = null;
  }
}

/**
 * only(v3.52 디버깅 1회차 성능 P2) — 장비 이벤트를 보낸 서버들만 한 번 읽는다(Set<id>). 함대 전체 주기를 돌리지 않는다.
 *   그 서버들의 전력 · 센서 · 인벤토리는 정규 주기와 같은 코드로 읽고, **주기 상태**(lastRun · 주기 소요 · 센서 주기 시작 · prune)는 건드리지 않는다
 *   (한 대짜리 실행이 ‘마지막 주기 1대’ · ‘주기 0.3초’ 로 보이면 신선도 판정이 흔들린다). 파트 장애 훅도 부르지 않는다 — 호출부(eventSub)가 바로 판정한다(P5 — 두 번 돌지 않게).
 *   돌려주는 값 — 읽은 서버 수(servers)와 인벤토리를 다시 읽은 서버 수.
 */
async function pollOnceInner({ manual = false, only = null, onRefreshed = null, eventLeft = null, onServerDone = null } = {}) {
  // v2.583: 이 카운터는 v2.548 부터 **pollOnce() 안에** 선언돼 있었다 — 쓰는 곳은 이 함수라 실장비(목 모드가
  // 아닌) 폴마다 마지막 줄에서 ReferenceError 가 났고, pollNow 가 잡아 `[idrac] pollNow 실패: invRefreshed is
  // not defined` 를 **폴마다** 찍었다. 그 결과 v2.548 F7(인벤토리 갱신 즉시 파트 장애 판정) 훅은 한 번도 돌지
  // 않았다(목 모드는 위에서 먼저 return 해 드러나지 않았다). 선언을 쓰는 함수로 옮긴다.
  let invRefreshed = 0; // 이번 폴에서 인벤토리를 갱신한 서버 수 → 0 이 아니면 파트 장애 훅
  let evRefreshed = 0;
  const invRead = new Set();   // 이벤트 읽기에서 인벤토리를 실제로 다시 읽은 서버(나머지는 unread — 인증 정지 · 장비 오류)
  const skippedForCycle = [];   // 이벤트 읽기에서 정규 주기와 겹쳐 뺀 서버(호출부가 다시 잡는다)  // 그 가운데 장비 이벤트로 다시 읽기 표시가 된 서버(바쁨 재시도 소진 · 묶음 상한으로 미룬 것) — 훅이 urgent 로 보낸다
  // 이벤트 읽기는 긴급중단 · 데모에서 주기 상태를 바꾸지 않는다 · 긴급중단이면 읽지 못한 서버(unread)를 돌려 호출부가 재읽기 표지를 세운다(해제 뒤 첫 주기가 다시 읽고 urgent — 디버깅 6회차 보안 #2)
  if (only && (isStopped() || isMockMode())) return { servers: 0, invRefreshed: 0, skipped: [], unread: isStopped() ? [...only] : [] };
  if (isStopped()) { lastRun = { at: Date.now(), ok: 0, failed: 0, skipped: '긴급중단', results: [] }; return; }
  // mock 데모: 실제 Redfish 폴 대신 합성 전력 샘플 적재(전력 화면이 비지 않게). live/auto엔 무영향.
  if (isMockMode()) {
    // v2.708: 전력은 데모 곡선(demo/idrac.js demoPowerNow — 백필과 같은 곡선)으로 넘긴다.
    let demoMod = null;
    try { demoMod = await import('../mock/demo/idrac.js'); } catch { /* 데모 모듈 없음 — 예전 근사값 */ }
    try { const { store } = await import('../store.js'); const snap = store.get?.(); const wattsOf = demoMod ? await demoMod.demoPowerNow(snap).catch(() => null) : null; const r = await mockIdracPollTick(snap, { wattsOf }); lastRun = { at: Date.now(), ok: r?.measured || 0, failed: 0, mock: true, results: [] }; } catch { /* */ }
    // v2.708: 데모 — 센서·센서 상세·인벤토리·추이 백필(전력만 있던 mock 을 실제 폴러와 같은 저장소로 채운다). 장비 접속 0.
    try {
      const { store } = await import('../store.js');
      const d = demoMod ? await demoMod.mockIdracDemoTick(store.get?.()) : null;
      if (d && lastRun) lastRun = { ...lastRun, demo: true, sensors: d.servers, inventoryRefreshed: d.inventoryRefreshed };
    } catch (e) { console.warn(`[idrac] mock 데모 틱 실패: ${e?.message || e}`); }
    return;
  }
  // live/auto: mock 데모 잔존 항목(id 'mock-')은 실제 폴 대상에서 제외(가짜 주소 폴 잡음 방지).
  const registry = loadRegistry();
  if (!only && Date.now() - _sensorPathPruneAt >= INVENTORY_MAX_AGE_MS) {
    _sensorPathPruneAt = Date.now();
    try { pruneSensorPathCache(registry); } catch { /* 캐시 정리 실패가 폴을 막지 않는다 */ }
  }
  const servers = registry.filter((s) => s.enabled !== false && s.host && s.username && s.password && !String(s.id).startsWith('mock-')
    && (!only || (only.has(String(s.id)) && s.type !== 'ome')));
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
  if (only && !servers.length) return { servers: 0, invRefreshed: 0, skipped: [] };
  if (!servers.length) { lastRun = { at: Date.now(), ok: 0, failed: 0, results: [], notPolled }; return; }
  const db = await getDb();
  // v2.634: ts 는 **주기 시작 시각**이다(prune·lastRun.startedAt 용). 표본 시각에는 쓰지 않는다 — 한 주기가
  //   길어지면(대상 980대·불통 iDRAC 다수) 주기 시작 시각으로 찍힌 표본이 전부 '15분 이상 미갱신' 으로 보여
  //   법인 전산실 온도가 통째로 비었다(2026-09-28 사용자 신고 0/980). 표본은 그 서버를 **실제로 읽은 시각**이다
  //   (v2.550.3 bmusage 와 같은 규약).
  const ts = Date.now();
  if (!only) { _runningSince = ts; markSensorPollStart(ts); }
  const results = [];
  const samples = []; // 전력 샘플을 모아 폴 종료 후 단일 트랜잭션으로 적재(서버 수만큼 fsync 방지).
  // 동시성 상한 — 무제한 Promise.all은 수백 대에 동시 TLS를 열어 CPU 스파이크/소켓 고갈.
  let authSkipped = 0; // v2.590: 인증 실패 정지로 이번 주기에 건너뛴 서버 수(실패로 세지 않는다 — 새 장애처럼 보인다)
  await poolSettled(servers, config.idrac.pollConcurrency, async (s) => {
    const sid = String(s.id);
    // 서버마다 읽기 직전에 확인하고 표시한다(같은 틱 안의 확인 · 표시라 둘이 같은 서버를 함께 잡지 않는다)
    if (only) {
      // 정규 주기가 지금 읽는 서버 — 그 서버만 끝나기를 기다린다(5회차 성능 D1). 정규 주기는 _eventPending 의 인벤토리를 새로 읽기 시작하지 않는다 —
      //   다만 이미 읽고 있던 인벤토리는 끝까지 기다리므로 느린 장비면 길다(6회차 엣지 #2). 그래서 판정은 묶음 끝이 아니라 서버마다(eventSub judgeLoop)
      for (let i = 0; i < 4 && _cycleInflight.has(sid); i += 1) await _cycleInflight.get(sid);
      if (_cycleInflight.has(sid)) { skippedForCycle.push(sid); return; }   // 그래도 겹치면(새 주기가 다시 잡음) 이벤트 쪽이 다시 시도한다(5회차 엣지 #1)
      let tok = await acquireSlot('event');
      // 자리를 기다리는 동안 정규 주기가 그 서버를 잡았으면 — 빼고 끝내지 않고 자리를 놓고 그 방문이 끝나기를 기다렸다 다시 잡는다(몇 번까지).
      //   빼면 30초 뒤 다시 시도로 넘어가 주기 꼬리의 서버는 다시 시도 5번이 다 빠지기도 했다(7회차 엣지 #2: 42~58초)
      for (let i = 0; i < 4 && _cycleInflight.has(sid); i += 1) { releaseSlot('event', tok); await _cycleInflight.get(sid); tok = await acquireSlot('event'); }
      if (_cycleInflight.has(sid)) { releaseSlot('event', tok); skippedForCycle.push(sid); return; }
      // 다른 이벤트 묶음이 지금 이 서버를 읽는 중 — 같은 장비에 세션을 둘 열지 않는다. 그 읽기는 이 이벤트 전에 시작했을 수 있어 빼고 다시 잡게 돌려준다(설계 ④ · eventSub 는 도는 묶음의 서버를 새 묶음에 넣지 않는다)
      if (_eventIds.has(sid)) { releaseSlot('event', tok); skippedForCycle.push(sid); return; }
      _eventIds.add(sid);
      try { await pollServer(s); } finally {
        _eventIds.delete(sid); if (eventLeft?.delete(sid)) pendDel(sid); releaseSlot('event', tok);
        // 이 서버는 이 묶음에서 끝났다 — 호출부(eventSub)가 묶음 전체를 기다리지 않고 이 서버의 새 이벤트를 다음 묶음에 넣게(반증 12a F2)
        // read — 인벤토리를 실제로 다시 읽었는가(못 읽었으면 호출부가 그 자리에서 재읽기 표지를 세운다 — 묶음 끝에 세우면 그 사이 다른 묶음이 성공한 읽기보다 뒤에 서 지워지지 않았다: 반증 13a G1)
        if (onServerDone) { try { onServerDone(sid, { read: invRead.has(sid) }); } catch { /* 알림 실패가 읽기를 막지 않는다 */ } }
      }
      return;
    }
    await acquireSlot();
    if (_eventIds.has(sid)) { releaseSlot(); results.push({ id: s.id, name: s.name, type: s.type || 'idrac', eventBusy: true }); return; }   // 이벤트 읽기가 지금 읽는 서버 — 이번 주기는 건너뛴다
    let done = null; _cycleInflight.set(sid, new Promise((r) => { done = r; }));
    try { await pollServer(s); } finally { _cycleInflight.delete(sid); done(); releaseSlot(); }
  });
  async function pollServer(s) {
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
        const readAt = Date.now(); // v2.634: 이 장비를 실제로 읽은 시각
        let measured = 0;
        for (const d of devices) {
          if (d.watts != null) { samples.push({ serverId: dbKey(s.id, d), watts: d.watts, ts: readAt }); measured++; }
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
        const powerAt = Date.now(); // v2.634: 이 서버의 전력을 실제로 읽은 시각
        // v2.602(LEFT2602-04 후속): 섀시 일부의 Power 조회가 실패한 **부분 합**은 적재하지 않는다 — 전력 대시보드·
        //   시간당 롤업이 그것을 그 서버의 전체 전력으로 그린다(오류 없이 틀린 값). 사실은 results·lastRun 에 밝힌다.
        if (r && r.watts != null && !r.partial) samples.push({ serverId: s.id, watts: r.watts, ts: powerAt });
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
          const sensorAt = Date.now(); // v2.634: 이 서버의 센서를 실제로 읽은 시각
          // v2.590(감사 F7): Thermal 을 하나도 못 읽었으면 **'읽었고 0개' 가 아니다** — 실패로 기록하고
          // 팬 컬렉션을 'failed' 로 올린다(파트 장애가 그 종류의 열린 장애를 닫지 않고 보류한다 — v2.548 F1).
          if (sn.thermalOk === false) sensorErr = new Error(sn.error || 'Thermal 을 읽지 못했습니다');
          else { sensorFans = sn.fans; setThermalDetail(s.id, sn.thermalDetail, sensorAt); }
          // 빈 표본은 적재하지 않는다 — 온도도 CPU 도 없는 점을 매 분 쌓으면 센서 탭이 'N샘플' 을 말하며
          // 정상처럼 보인다. CPU(텔레메트리)만 읽힌 경우는 그 값만 싣는다(온도는 비어 있는 채로 — 지어내지 않는다).
          if (sn.thermalOk !== false || sn.cpuUsagePct != null) {
            pushSensorSample(s.id, { t: sensorAt, cpuUsagePct: sn.cpuUsagePct, temps: sn.thermalOk === false ? [] : sn.temps, fans: (sensorFans || []).map((f) => ({ name: f.name, rpm: f.rpm })) });
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
        // 이벤트를 보낸 서버는 인벤토리를 늘 다시 읽는다(그것이 이유다 — 강제 표지 상한과 무관) · 정규 주기는 이벤트 묶음이 맡은 서버의 인벤토리를 읽지 않는다(이벤트 쪽 — 5회차 성능 D1)
        if (only || (inventoryStale(s.id, INVENTORY_MAX_AGE_MS) && !_eventPending.has(String(s.id)))) {
          const forced = isForcedStale(s.id); const mark = staleMarkOf(s.id);   // 읽기 시작 때의 표지 순번 — 그 뒤에 선 표지는 남긴다(5회차 엣지 #1)
          // 컬렉션마다 ‘마지막으로 됐던 상태’ 기준(collBase) — 바로 앞 읽기가 실패였어도 그 전에 ok 였으면 ok 로 남는다. 바로 앞 저장값을 기준으로 쓰면 바쁜 읽기 둘째부터
          //   기준이 ‘실패’ 로 바뀌어 읽음으로 치고 표지까지 지웠다(반증 15a J1). 늘 실패하는 컬렉션(GPU 없음)은 기준이 실패라 세지 않는다
          const prevInv = getInventory(s.id);
          const prevBase = prevInv ? (prevInv.collBase && typeof prevInv.collBase === 'object' ? prevInv.collBase : (prevInv.collections || null)) : null;
          try {
            const inv = await fetchInventory(s);
            // 팬 파트 정보 — Thermal 은 fetchSensors 가 방금 받았으므로 재호출 없이 이관(추가 HTTP 0회).
            if (sensorFans?.length) inv.fans = sensorFans.map(({ name, model, partNumber, manufacturer, health, redundant, state }) => ({ name, model, partNumber, manufacturer, health, redundant, ...(state ? { state } : {}) })); // v2.612 COL2612-08: 빈 슬롯(state)
            // v2.548 F1: 팬은 Thermal 경로라 fetchInventory 의 컬렉션 메타에 없다 — 여기서 찍는다.
            if (inv.collections && typeof inv.collections === 'object') inv.collections.fans = sensorFans?.length ? 'ok' : (sensorErr ? 'failed' : 'ok');
            // 기준 물려주기 — 이번에 ok 면 ok, 실패면 앞 기준 그대로(없으면 실패)
            if (inv.collections && typeof inv.collections === 'object') inv.collBase = Object.fromEntries(Object.entries(inv.collections).map(([k, v]) => [k, v === 'ok' ? 'ok' : (prevBase?.[k] === 'ok' ? 'ok' : 'failed')]));
            setInventory(s.id, inv, { mark });
            invRefreshed += 1;
            // 이벤트 읽기는 장비에 닿았고 부품 컬렉션이 모두 읽혔을 때만 ‘읽음’ — fetchInventory 는 503 · 404 에도 던지지 않고 reachable:false · 컬렉션 failed 를 돌려줘
            //   읽음으로 쳐 재읽기 표지가 지워지고 30분 동안 다시 읽지 않았다(반증 14a H1). 못 읽음이면 호출부가 표지를 세워 다음 정규 주기가 한 번 다시 읽는다(urgent)
            //   늘 실패하는 컬렉션(GPU 없는 서버 등)은 세지 않는다 — 앞 읽기에서 ‘ok’ 였던 컬렉션이 이번에 실패했을 때만(장비가 잠시 바쁨 · 부분 응답). 앞 읽기가 없으면 닿았는지만 본다
            const coll = inv?.collections && typeof inv.collections === 'object' ? inv.collections : {};
            const fullRead = inv?.reachable === true && !Object.entries(coll).some(([k, v]) => v === 'failed' && prevBase?.[k] === 'ok');
            if (only) {
              if (fullRead) invRead.add(String(s.id));
              // 판정은 다시 읽은 서버마다 깨운다(6회차 엣지 #2) — 못 읽은 컬렉션은 전이가 보류하므로 깨워도 닫히지 않는다
              if (onRefreshed) { try { onRefreshed(String(s.id)); } catch { /* 판정 고리 실패가 읽기를 막지 않는다 */ } }
            }
            if (forced) evRefreshed += 1;
            // v2.611(감사 COL2611-01): v2.610 스캔이 HPE 의 제품번호(SKU)를 서비스태그로 등록했으면 시리얼로 1회 교정한다.
            if (inv.system?.hpe) { try { correctHpeServiceTag(s.id, { sku: inv.system.sku, serial: inv.system.serialNumber }); } catch { /* 교정 실패가 수집을 막지 않는다 */ } }
          } catch { /* keep last */ }
        }
        // v2.659: Sensors 컬렉션(전압·전류·전력·퍼센트까지)은 인벤토리와 같은 느린 주기로만 — 매 주기 읽으면
        //   서버당 GET 이 수십 번 늘 수 있다. 실패는 사유만 남기고 폴을 막지 않는다. 인증 거부는 위에서 이미 걸러졌다.
        let collErr = null;
        if (sensorCollectionStale(s.id, INVENTORY_MAX_AGE_MS)) {
          try { setSensorCollection(s.id, await fetchSensorCollection(s)); }
          catch (e) { collErr = e; setSensorCollection(s.id, { ok: false, sensors: [], error: describeError(e).message }); }
        }
        results.push({
          id: s.id, name: s.name, type: 'idrac', watts: r ? r.watts : null,
          ...(collErr ? { sensorCollectionError: describeError(collErr).message } : {}),
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
  }
  // 모든 서버 폴 후 한 트랜잭션으로 배치 적재(insertMany 없으면 개별 insert 폴백).
  try { if (db.insertMany) db.insertMany(samples); else for (const sm of samples) db.insert(sm.serverId, sm.watts, sm.ts); }
  catch (e) { console.warn('[idrac] 전력 적재 실패:', e.message); }
  if (only) {   // 이벤트 읽기 — 주기 상태 · prune · 훅은 건드리지 않는다(위 주석)
    const unread = servers.map((s) => String(s.id)).filter((id) => !invRead.has(id) && !skippedForCycle.includes(id));   // 인증 정지 · 장비 오류로 못 읽은 서버 — 호출부가 재읽기 표지를 세운다(6회차 보안 #2)
    return { servers: servers.length - skippedForCycle.length, invRefreshed, skipped: skippedForCycle, unread };
  }
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
  const okCount = results.filter((r) => !r.error && !r.authStopped && !r.eventBusy).length;
  const finishedAt = Date.now();
  const durationMs = finishedAt - ts;
  _runningSince = null;
  _lastDurationMs = durationMs;
  // 신선도 판정(법인 전산실 온도 등)이 '주기가 얼마나 걸리는가' 를 보고 경계를 넓힐 수 있게 알린다.
  setSensorPollCycle({ durationMs, intervalMs: config.idrac.pollIntervalMs, at: finishedAt });
  if (durationMs > 3 * config.idrac.pollIntervalMs) {
    console.warn(`[idrac] poll: 한 주기가 ${Math.round(durationMs / 1000)}초 걸렸습니다(대상 ${servers.length}대 · 주기 ${Math.round(config.idrac.pollIntervalMs / 1000)}초 · 동시 ${config.idrac.pollConcurrency}) — 그동안 다음 주기는 건너뜁니다`);
  }
  lastRun = { at: ts, startedAt: ts, finishedAt, durationMs, servers: servers.length, ok: okCount, failed, results, notPolled, authStopped: results.filter((r) => r.authStopped).length, authSkipped, manual,
    powerPartial: results.filter((r) => r.powerPartial).length,   // v2.602: 부분 합이라 적재하지 않은 서버 수
    eventBusy: results.filter((r) => r.eventBusy).length };   // 이벤트 읽기가 그때 읽던 서버라 이 주기에 건너뛴 수 — 화면이 ‘성공 · 실패’ 밖으로 따로 말한다(디버깅 6회차 화면 G3)
  if (lastRun.powerPartial) console.warn(`[idrac] poll: 섀시 일부의 Power 조회 실패로 부분 합이 된 서버 ${lastRun.powerPartial}대 — 전력 적재를 건너뛰었습니다`);
  if (failed) console.warn(`[idrac] poll: ${okCount}/${results.length} 성공${authSkipped ? ` · 인증 실패 정지로 건너뜀 ${authSkipped}` : ''}`);
  // v2.548 F7: 인벤토리가 하나라도 갱신됐으면 파트 장애 판정(중앙)/push(엣지)를 즉시 트리거한다 —
  //   탐지 지연을 '인벤토리 주기 + 몇 초' 로 줄인다(v2.547 은 최대 ~50분). 디바운스는 훅이 한다.
  if (invRefreshed > 0) { try { onSnapshotRefreshed('idrac', { urgent: evRefreshed > 0 }); } catch { /* 훅 실패가 폴을 막지 않는다 */ } }
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
    // v2.634: 지금 도는 주기가 언제 시작했는지(없으면 null) · 직전 주기 소요 — 주기가 간격을 넘기면 다음 틱은 건너뛴다.
    runningSince: _runningSince,
    runningForMs: _runningSince ? Date.now() - _runningSince : null,
    lastDurationMs: _lastDurationMs,
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
/**
 * v3.52 ⑬ 장애 바로 받기 — 이벤트를 받은 뒤 그 서버들만 바로 읽는다(수동이 아님 — 인증 정지 서버는 그대로 건너뛴다).
 * 묶음끼리는 함께 돈다(설계 ④) · 정규 주기 · 다른 묶음이 읽던 서버는 skipped 로 돌려준다(호출부가 다시 잡는다).
 * @returns {Promise<{ busy:boolean, servers:number, invRefreshed:number, skipped:string[], unread:string[] }>} busy 는 이제 늘 false(호출부 호환)
 */
export async function pollNowForEvent(ids = [], { onRefreshed = null, onServerDone = null } = {}) {
  const only = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!only.size) return { busy: false, servers: 0, invRefreshed: 0 };
  let r;
  try { r = await pollOnce({ manual: false, only, onRefreshed: typeof onRefreshed === 'function' ? onRefreshed : null, onServerDone: typeof onServerDone === 'function' ? onServerDone : null }); } catch (err) { console.error('[idrac] 이벤트 뒤 수집 실패:', err.message); }
  if (r === BUSY) return { busy: true };
  return { busy: false, servers: Number(r?.servers) || 0, invRefreshed: Number(r?.invRefreshed) || 0, skipped: Array.isArray(r?.skipped) ? r.skipped : [], unread: Array.isArray(r?.unread) ? r.unread : [] };
}

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
