/**
 * agent/storageConfigPull.js — 중앙→엣지 스토리지 장비 배포 pull(v2.302, gpuGuestConfigPull 패턴).
 * 중앙이 이 엣지 앞으로 지정한 장비 목록(자격증명 포함 — 엣지가 장비에 로그인해야 하므로)을
 * 아웃바운드 GET 으로 주기 수집해 로컬 레지스트리에 반영한다(폐쇄망/NAT 엣지 동작).
 * 반영은 registry.applyPulledDevices — 내 몫을 통째 교체(중앙이 진실의 원천: 중앙에서 지운
 * 장비가 엣지에 유령으로 남지 않게). 저장 시 엣지 자신의 vault 정책으로 재봉인된다.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from '../util/central404.js'; // v2.613 DEPS2613-06·EDGE2613-06: 404 사유(central 꺼짐/거절/엔드포인트 없음) 판정
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices, getDeviceWithSecret } from '../storage/registry.js';
import { dropSnapshot } from '../storage/store.js';
import { collectDeviceNow } from '../storage/poller.js';
import { flushSnapshotsNow } from '../storage/store.js'; // v2.733(C4-03): 재수집 묶음 끝에 한 번 쓴다
import { pushStorageNow } from '../storage/push.js';
import { runtimeIntervals, applyCentralIntervals, startAdaptiveTimer } from '../storage/intervals.js';

// v2.409: 주기는 중앙 배포값(storage/intervals.js)을 매번 조회 — 모듈 로드 시 상수로 굳히지 않는다.
// ⚠ 이 pull 주기 자체도 중앙이 지정할 수 있다. 길게 잡아 두면 '주기를 줄이라'는 지시도 그만큼
//   늦게 도착한다(엣지가 물어보러 와야 아는 구조 — 중앙은 엣지에 밀어넣을 수 없다).
const configPullMs = () => runtimeIntervals().configPullMs;
let _timer = null;
let _lastSig = '';
let _last = null;
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
/*
 * v2.741(LEFT-02): '지금 수집'(collectNow) 작업 — pull 이 기다리지 않는 단일비행 작업(SAN v2.733 C4-02 runCollectJob 과 같은 모양).
 *  예전에는 pull 이 요청 장비(최대 20대)를 for/await 로 한 대씩 끝까지 수집하고 push 까지 마친 뒤에야 끝나, 그동안 재진입 가드가
 *  다음 설정 pull(장비 추가·삭제·주기 변경·다음 재수집 요청 인출)을 막았다(장비 시한 180초 × 20대면 한 시간).
 *  · 한 번에 하나만 돈다(_collectRunning). 돌고 있는 동안 온 요청은 대기열에 더하고(같은 id 는 한 번만), 작업이 이어서 처리한다 —
 *    장비는 예전처럼 한 대씩(동시 세션 상한 규약). '이미 수집 중' 이면 새 세션을 열지 않는다(collectDeviceNow 의 false).
 *  · 대기열이 빈 것을 확인하는 줄과 _collectRunning=false 사이에 await 가 없다(finally 가 같은 동기 구간) — 그 사이에 들어온 요청이
 *    '작업이 돈다' 고 믿고 버려지지 않게.
 *  · 스냅샷 파일은 묶음 끝에 한 번(flushSnapshotsNow) · 시도한 것이 있으면 묶음 끝에 push(예전과 같다 — 실패 스냅샷도 결과다).
 *  · 수집 도중 중앙이 그 장비를 이 엣지에서 뺐으면(이제 pull 이 막히지 않으므로 생길 수 있다) 방금 넣은 스냅샷을 지운다.
 *  · 결과(수집 수·push 실패)는 이 pull 이 끝난 뒤에 나온다 — 상태의 collectJob(진행)·collectRun(마지막으로 끝난 작업)이 말한다.
 */
const COLLECT_QUEUE_MAX = 200;
const _collectQueue = [];
let _collectRunning = false;
let _collectCurrent = null;
let _collectRun = null;
let _collectDone = null;   // 진행 중 작업의 프라미스(테스트·진단이 끝을 기다릴 때)

/** 대기열에 더하고 작업이 없으면 띄운다. @returns {{queued:number, already:number, dropped:number}} */
function enqueueCollect(ids) {
  let queued = 0; let already = 0; let dropped = 0;
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw : (raw == null ? '' : String(raw));
    if (!id) continue;
    if (id === _collectCurrent || _collectQueue.includes(id)) { already++; continue; }
    if (_collectQueue.length >= COLLECT_QUEUE_MAX) { dropped++; continue; }
    _collectQueue.push(id); queued++;
  }
  if (dropped) console.warn(`[storage-config] '지금 수집' 대기열 상한(${COLLECT_QUEUE_MAX})으로 ${dropped}건을 받지 않았습니다 — 중앙이 시한 뒤 다시 내려보냅니다`);
  if (!_collectRunning && _collectQueue.length) {
    _collectRunning = true;
    _collectDone = runCollectJob().catch((e) => console.warn(`[storage-config] '지금 수집' 작업 실패: ${e.message}`));
  }
  return { queued, already, dropped };
}

async function runCollectJob() {
  const t0 = Date.now();
  let requested = 0; let collected = 0; let busy = 0; let failed = 0;
  let pushError = '';
  try {
    for (;;) {
      let batch = 0;
      while (_collectQueue.length) {
        const id = _collectQueue.shift();
        _collectCurrent = id; requested++; batch++;
        try {
          // v2.591 L1: false = 이미 수집 중(주기 수집) — 그 결과가 곧 push 되므로 새 세션을 열지 않는다.
          // v2.733(C4-03): 장비마다 스냅샷 파일을 쓰지 않는다 — 묶음 끝에 한 번(아래).
          if (await collectDeviceNow(String(id), { flush: false })) collected++;
          else { busy++; console.log(`[storage-config] ${id} 는 이미 수집 중 — 그 결과로 대신합니다`); }
          if (!getDeviceWithSecret(id)) { try { dropSnapshot(id); } catch { /* */ } }
        } catch (e) { failed++; console.warn(`[storage-config] 재수집 실패(${id}): ${e.message}`); } // 실패 스냅샷도 push 로 전달됨
        finally { _collectCurrent = null; }
      }
      // v2.733(C4-03): 묶음 끝에 스냅샷 파일을 한 번 쓴다 — flushSnapshotsNow 는 던지지 않는다(실패는 store 가 콘솔·상태에 남긴다).
      try { flushSnapshotsNow(); } catch { /* store 가 남긴다 */ }
      if (batch) {
        // v2.612 EDGE2612-02: 반환값을 본다 — pushStorageNow 는 실패를 {ok:false} 로 돌려주고(던지지 않는다) 상태 전용 push 실패는
        //   statusSent:false 다. withheld(보류)는 실패가 아니다. 결과를 push 주기(≤5분)까지 기다리지 않게 바로 보낸다.
        pushError = '';
        try {
          const pr = await pushStorageNow();
          if (pr && pr.ok === false) pushError = String(pr.reason || 'push 실패');
          else if (pr && pr.statusSent === false && !pr.statusSkipped) pushError = '상태 push 가 중앙에 닿지 않았습니다';
        } catch (e) { pushError = String(e?.message || e); }
        if (pushError) console.warn(`[storage-config] 재수집 push 실패: ${pushError}`);
      }
      if (!_collectQueue.length) return;   // ⚠ 이 확인과 finally 의 _collectRunning=false 사이에 await 를 두지 말 것
    }
  } finally {
    _collectRunning = false;
    _collectRun = { at: Date.now(), requested, collected, busy, failed, durationMs: Date.now() - t0, ...(pushError ? { pushError } : {}) };
  }
}

// 재진입 가드(single-flight) — CLAUDE.md 성능 불변조건: setInterval(()=>asyncFn()) 폴러는
// 이전 주기가 간격을 넘기면(고RTT·중앙 지연) 다음 틱이 겹쳐 돌아 연결·CPU 가 누적된다.
// 수동 실행 API 도 같은 exported 함수를 부르므로 가드를 공유한다(inventoryPush 와 동일 패턴).
let running = false;

export async function pullStorageConfigNow(...args) {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pullStorageConfigNow(...args); } finally { running = false; }
}

async function _pullStorageConfigNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/storage-config?agent=${encodeURIComponent(config.agent.name || '')}&intervalsHold=1`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken }, timeoutMs: 20_000, retries: 2 });
    // v2.613 DEPS2613-06·EDGE2613-06: 404 본문을 읽어 '중앙이 central 을 끔' / '거절' / '엔드포인트 없음(구버전·주소 오류)' 을 가르고
    //   상태·콘솔에 남긴다(curUser·sanSwitch 등 형제 5벌과 같은 규칙 — 예전에는 `<- 404` 만 남아 조치를 고를 수 없었다).
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { at: Date.now(), ok: false, kind: c.kind, error: c.reason };
      if (_logChange('404', `${c.kind}: ${c.reason}`)) console.warn(`[storage-config] ${c.reason}`);
      return { ok: false, kind: c.kind, reason: c.reason };
    }
    if (!res.ok) throw new Error(`storage-config <- ${res.status}`);
    const body = await res.json();
    // 수집 주기 배포(v2.409) — 장비 목록보다 먼저 적용한다. 중앙이 값을 안 주면 빈 객체가 되어
    // 엣지가 자기 portal.env 값으로 되돌아간다('중앙 미설정 = 로컬 유지' 계약, intervals.js).
    // 이 호출이 타이머 재무장까지 트리거하므로, 새 주기는 다음 틱을 기다리지 않고 바로 먹는다.
    // v2.632(감사 EDGE2632-03): 중앙이 주기 설정 파일을 못 읽으면 intervals 를 빼고 `intervalsUnreadable` 을 싣는다(요청의 intervalsHold=1
    //   이 이 규약을 안다는 표시 — 모르는 구버전 엣지에는 중앙이 503 으로 답한다). 그때는 **적용하지 않고 직전 값을 유지**한다 —
    //   빈 객체로 적용하면 중앙 지정 주기가 풀려 로컬로 돌아간다.
    const intervalsUnreadable = body?.intervalsUnreadable && typeof body.intervalsUnreadable === 'object'
      ? String(body.intervalsUnreadable.reason || '사유 미상').slice(0, 200) : '';
    if (intervalsUnreadable && _logChange('intervals-unreadable', intervalsUnreadable)) console.warn(`[storage-config] 중앙 주기 설정을 읽지 못해 받지 않았습니다(직전 주기 유지): ${intervalsUnreadable}`);
    const intervalsApplied = intervalsUnreadable ? { applied: false, held: true } : applyCentralIntervals(body?.intervals && typeof body.intervals === 'object' ? body.intervals : {});
    const devices = body?.devices || [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      const ap = applyPulledDevices(devices);
      for (const id of ap?.removed || []) dropSnapshot(id);   // v2.596(EF-3): 빠진 장비의 스냅샷은 push 에서 빠져야 한다
      if (ap?.removed?.length) console.log(`[storage-config] 이 엣지에서 빠진 장비 ${ap.removed.length}대의 로컬 스냅샷을 지웠습니다`);
      _lastSig = sig;
      applied = true;
      console.log(`[storage-config] 중앙 배포 장비 적용: agent=${config.agent.name} 장비 ${devices.length}대`);
    }
    // '지금 수집' 요청(v2.316, 사용자 버그 신고 — 엣지 장비의 수집 버튼이 무동작이던 문제):
    // 중앙이 collectRequests 큐에 남긴 요청을 collectNow 로 받는다. ⚠ 위의 '변경 없음' 판정과
    // 무관하게 **매 pull 마다** 처리해야 한다(구성은 안 바뀌어도 재수집 요청은 흔함) — 그래서
    // 조기 return 이던 unchanged 분기를 없앴다.
    // v2.741(LEFT-02): pull 이 수집을 기다리지 않는다 — 단일비행 작업(runCollectJob)이 한 대씩 수집하고 끝나면 바로 push 한다.
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    if (wants.length) console.log(`[storage-config] 중앙 재수집 요청 ${wants.length}건 수신 — 수집 작업에 넣습니다`);
    const enq = wants.length ? enqueueCollect(wants) : null;
    const collectQueued = enq ? enq.queued : 0;
    _last = { at: Date.now(), applied, count: devices.length, collectRequested: wants.length, collectQueued,
      ...(enq?.already ? { collectAlready: enq.already } : {}), ...(enq?.dropped ? { collectDropped: enq.dropped } : {}),
      intervals: runtimeIntervals(), intervalsApplied: !!intervalsApplied.applied, ...(intervalsUnreadable ? { intervalsUnreadable } : {}) };
    return { ok: true, applied, unchanged: !applied, count: devices.length, collectRequested: wants.length, collectQueued,
      intervals: runtimeIntervals(), intervalsApplied: !!intervalsApplied.applied };
  } catch (e) {
    _last = { at: Date.now(), error: e.message };
    if (_logChange('pull', e.message)) console.warn(`[storage-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

export function startStorageConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullStorageConfigNow(), { firstDelayMs: 10_000, name: '설정 pull' });
}
export function storageConfigPullStatus() {
  return {
    ...(_last || {}),
    // v2.741(LEFT-02): '지금 수집' 작업 — 진행 중 여부·대기·지금 장비 · 마지막으로 끝난 작업 요약(무음 금지). 엣지 로그 표(pull.storage)가
    //   이 값을 그대로 보여 준다. pushError 는 마지막으로 끝난 작업의 push 실패(예전 _last.pushError 자리 — 데이터 흐름 지도가 읽는다).
    collectJob: { running: _collectRunning, queued: _collectQueue.length, current: _collectCurrent },
    ...(_collectRun ? { collectRun: _collectRun } : {}),
    ...(_collectRun?.pushError ? { pushError: _collectRun.pushError } : {}),
  };
}
/** 진행 중인 '지금 수집' 작업이 끝날 때까지 기다린다(없으면 곧바로). 테스트·진단 전용 — 폴러 경로에서 부르지 말 것. */
export function storageCollectJobSettled() { return _collectRunning && _collectDone ? _collectDone : Promise.resolve(); }
