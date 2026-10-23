/**
 * agent/pduConfigPull.js — 중앙→엣지 PDU 장비 배포 pull(v2.424, storageConfigPull 패턴).
 *
 * 중앙은 폐쇄망/NAT 뒤의 엣지에 명령을 밀어넣을 수 없다. 그래서 엣지가 아웃바운드 GET 으로
 * ① 자기 몫 장비 목록(자격증명 포함 — 엣지가 PDU 에 로그인해야 하므로) ② 수집 주기
 * ③ '지금 수집' 요청을 주기적으로 받아 간다.
 *
 * 반영은 registry.applyPulledDevices — 내 몫을 통째 교체(중앙이 진실의 원천: 중앙에서 지운
 * 장비가 엣지에 유령으로 남지 않게). 저장 시 엣지 자신의 vault 정책으로 재봉인된다.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from '../util/central404.js'; // v2.613 DEPS2613-06·EDGE2613-06: 404 사유(central 꺼짐/거절/엔드포인트 없음) 판정
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices, getDeviceWithSecret, registryLoadError } from '../pdu/registry.js';
import { pullRecoveryNote } from '../util/registryCore.js'; // v2.744(감사 EDGE-03)
import { collectDeviceNow, forgetDevices } from '../pdu/poller.js';
import { pushPduNow, pduPushStatus } from '../pdu/push.js';
import { runtimeIntervals, applyCentralIntervals, startAdaptiveTimer } from '../pdu/intervals.js';
import { applyCentralThresholds } from '../pdu/thresholds.js';

const configPullMs = () => runtimeIntervals().configPullMs;
let _timer = null;
let _lastSig = '';
let _last = null;
let _registryRecovered = null; // v2.744(감사 EDGE-03): 손상 등록부를 중앙 배포분으로 다시 쓴 마지막 기록
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
/*
 * v2.741(LEFT-02): '지금 수집'(collectNow) 작업 — pull 이 기다리지 않는 단일비행 작업(SAN v2.733 C4-02 runCollectJob 과 같은 모양,
 *  스토리지 storageConfigPull 과 같은 판본). 예전에는 pull 이 요청 장비(최대 20대)를 for/await 로 한 대씩 끝까지 수집하고 push 까지
 *  마친 뒤에야 끝나, 그동안 재진입 가드가 다음 설정 pull(장비 추가·삭제·주기 변경·다음 재수집 요청 인출)을 막았다.
 *  · 한 번에 하나만 돈다 · 같은 id 는 대기열에 한 번만 · 장비는 예전처럼 한 대씩 · 이미 수집 중이면 새 세션을 열지 않는다(skipped).
 *  · 대기열이 빈 것을 확인하는 줄과 _collectRunning=false 사이에 await 가 없다.
 *  · v2.602(EDGE2602-05): 실패도 **즉시** push 한다 — 시도한 것이 있으면 묶음 끝에 push(실패 스냅샷도 결과다).
 *  · 수집 도중 중앙이 그 장비를 이 엣지에서 뺐으면 방금 넣은 스냅샷을 지운다(forgetDevices).
 *  · 결과는 상태의 collectJob(진행)·collectRun(마지막으로 끝난 작업)이 말한다.
 */
const COLLECT_QUEUE_MAX = 200;
const _collectQueue = [];
let _collectRunning = false;
let _collectCurrent = null;
let _collectRun = null;
let _collectDone = null;

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
  if (dropped) console.warn(`[pdu-config] '지금 수집' 대기열 상한(${COLLECT_QUEUE_MAX})으로 ${dropped}건을 받지 않았습니다 — 중앙이 시한 뒤 다시 내려보냅니다`);
  if (!_collectRunning && _collectQueue.length) {
    _collectRunning = true;
    _collectDone = runCollectJob().catch((e) => console.warn(`[pdu-config] '지금 수집' 작업 실패: ${e.message}`));
  }
  return { queued, already, dropped };
}

async function runCollectJob() {
  const t0 = Date.now();
  let requested = 0; let collected = 0; let skipped = 0; let failed = 0;
  let pushError = '';
  try {
    for (;;) {
      let batch = 0;
      while (_collectQueue.length) {
        const id = _collectQueue.shift();
        _collectCurrent = id; requested++; batch++;
        try {
          const r = await collectDeviceNow(id);
          if (r?.ok) collected++;
          else if (r?.skipped) { skipped++; if (r?.reason) console.log(`[pdu-config] 재수집 건너뜀(${id}): ${r.reason}`); }
          else { failed++; if (r?.reason) console.warn(`[pdu-config] 재수집 실패(${id}): ${r.reason}`); }
          if (!getDeviceWithSecret(id)) { try { forgetDevices([id]); } catch { /* */ } }
        } catch (e) { failed++; console.warn(`[pdu-config] 재수집 실패(${id}): ${e.message}`); }
        finally { _collectCurrent = null; }
      }
      if (batch) {
        // v2.612 EDGE2612-02: pushPduNow 는 실패를 던지지 않고 {ok:false, reason} 으로 돌려준다 — 반환값도 본다. withheld(보류)는 실패가 아니다.
        pushError = '';
        try {
          const pr = await pushPduNow();
          if (pr && pr.ok === false) { pushError = String(pr.reason || pduPushStatus()?.reason || 'push 실패'); console.warn(`[pdu-config] 재수집 push 실패: ${pushError}`); }
        } catch (e) { pushError = String(e?.message || e); console.warn(`[pdu-config] 재수집 push 실패: ${pushError}`); }
      }
      if (!_collectQueue.length) return;   // ⚠ 이 확인과 finally 의 _collectRunning=false 사이에 await 를 두지 말 것
    }
  } finally {
    _collectRunning = false;
    _collectRun = { at: Date.now(), requested, collected, skipped, failed, durationMs: Date.now() - t0, ...(pushError ? { pushError } : {}) };
  }
}

// 재진입 가드 — 이전 pull 이 간격을 넘기면(고RTT) 다음 틱이 겹쳐 돌아 연결이 누적된다.
let running = false;

export async function pullPduConfigNow() {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pull(); } finally { running = false; }
}

async function _pull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) {
    return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/CENTRAL_TOKEN 미설정)' };
  }
  try {
    const url = `${config.agent.centralUrl}/api/central/pdu-config?agent=${encodeURIComponent(config.agent.name || '')}&intervalsHold=1`;
    const res = await resilientFetch(url, {
      method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken }, timeoutMs: 20_000, retries: 2,
    });
    // v2.613 DEPS2613-06·EDGE2613-06: 404 본문을 읽어 '중앙이 central 을 끔' / '거절' / '엔드포인트 없음(구버전·주소 오류)' 을 가르고
    //   상태·콘솔에 남긴다(curUser·sanSwitch 등 형제 5벌과 같은 규칙 — 예전에는 `<- 404` 만 남아 조치를 고를 수 없었다).
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { at: Date.now(), ok: false, kind: c.kind, reason: c.reason };
      if (_logChange('404', `${c.kind}: ${c.reason}`)) console.warn(`[pdu-config] ${c.reason}`);
      return { ok: false, kind: c.kind, reason: c.reason };
    }
    if (!res.ok) throw new Error(`pdu-config <- ${res.status}`);
    const body = await res.json();

    // 주기를 장비 목록보다 먼저 적용한다. 중앙이 값을 안 주면 빈 객체 → 엣지가 자기 env 로
    // 되돌아간다('중앙 미설정 = 로컬 유지' 계약). 이 호출이 타이머 재무장까지 트리거한다.
    // v2.632(감사 EDGE2632-03): 중앙이 주기 설정 파일을 못 읽으면 intervals 를 빼고 `intervalsUnreadable` 을 싣는다(요청의 intervalsHold=1
    //   이 이 규약을 안다는 표시 — 모르는 구버전 엣지에는 중앙이 503 으로 답한다). 그때는 **적용하지 않고 직전 값을 유지**한다 —
    //   빈 객체로 적용하면 중앙 지정 주기가 풀려 로컬로 돌아간다.
    const intervalsUnreadable = body?.intervalsUnreadable && typeof body.intervalsUnreadable === 'object'
      ? String(body.intervalsUnreadable.reason || '사유 미상').slice(0, 200) : '';
    if (intervalsUnreadable && _logChange('intervals-unreadable', intervalsUnreadable)) console.warn(`[pdu-config] 중앙 주기 설정을 읽지 못해 받지 않았습니다(직전 주기 유지): ${intervalsUnreadable}`);
    const intervalsApplied = intervalsUnreadable ? false : applyCentralIntervals(body?.intervals && typeof body.intervals === 'object' ? body.intervals : {});

    // v2.769(점검 R4-D4-02): 중앙 임계치 — 위임 PDU 경보는 이 엣지가 현장에서 보낸다(pdu/poller.js). 중앙이 값을 실었을 때만 적용하고
    //   (정제는 applyCentralThresholds — 알려진 키·유한수·불리언만), 없거나(옛 중앙·중앙 파일 없음) 못 읽었다고 하면 **직전 값을 유지**한다.
    //   알림 채널 설정은 중앙이 내려보내지 않는다 — 이 엣지의 알림 설정으로 보낸다.
    // v2.770(점검 R5-E1-1): v2.770 중앙은 관리자가 바꾼 키만 보내고, 지정이 없으면 `{}` 를 보낸다 — {} 는 '중앙 지정 없음' 으로 적용해
    //   직전 중앙 값(v2.769 중앙이 보낸 전체 세트 포함)을 지운다(applyCentralThresholds). enabled 는 받지 않는다.
    const thresholdsUnreadable = body?.thresholdsUnreadable && typeof body.thresholdsUnreadable === 'object'
      ? String(body.thresholdsUnreadable.reason || '사유 미상').slice(0, 200) : '';
    if (thresholdsUnreadable && _logChange('thresholds-unreadable', thresholdsUnreadable)) console.warn(`[pdu-config] 중앙 임계치 설정을 읽지 못해 받지 않았습니다(직전 임계치 유지): ${thresholdsUnreadable}`);
    let thresholdsApplied = false;
    if (!thresholdsUnreadable && body?.thresholds && typeof body.thresholds === 'object' && !Array.isArray(body.thresholds)) {
      try { thresholdsApplied = applyCentralThresholds(body.thresholds); } catch (e) { console.warn(`[pdu-config] 중앙 임계치 적용 실패(직전 임계치 유지): ${e.message}`); }
    }

    const devices = Array.isArray(body?.devices) ? body.devices : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      // v2.744(감사 EDGE-03): 손상 등록부를 배포분으로 다시 쓰는 것은 막지 않고(복구) 그 사실을 남긴다 — pullRecoveryNote 머리말.
      const regErr = registryLoadError();
      const ap = applyPulledDevices(devices);
      if (regErr && ap?.ok !== false) {
        _registryRecovered = pullRecoveryNote(regErr, { what: 'PDU 등록부(pdu-devices.json)', restored: devices.length });
        console.warn(`[pdu-config] ${_registryRecovered.note}`);
      }
      if (ap?.removed?.length) forgetDevices(ap.removed);
      _lastSig = sig;
      applied = true;
      console.log(`[pdu-config] 중앙 배포 장비 적용: agent=${config.agent.name} PDU ${devices.length}대`);
    }

    // '지금 수집' 요청 — 구성이 안 바뀌어도 **매 pull 마다** 처리한다(재수집 요청은 흔하다).
    // v2.741(LEFT-02): pull 이 수집을 기다리지 않는다 — 단일비행 작업(runCollectJob)이 한 대씩 수집하고 끝나면 바로 push 한다.
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    const enq = wants.length ? enqueueCollect(wants) : null;

    _last = { at: Date.now(), ok: true, devices: devices.length, applied, intervalsApplied, ...(intervalsUnreadable ? { intervalsUnreadable } : {}),
      thresholdsApplied, ...(thresholdsUnreadable ? { thresholdsUnreadable } : {}),
      collectRequested: wants.length, collectQueued: enq ? enq.queued : 0,
      ...(enq?.already ? { collectAlready: enq.already } : {}), ...(enq?.dropped ? { collectDropped: enq.dropped } : {}) };
    return { ok: true, ...(_last) };
  } catch (e) {
    _last = { at: Date.now(), ok: false, reason: e.message };
    if (_logChange('pull', e.message)) console.warn(`[pdu-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

export function startPduConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullPduConfigNow(), { firstDelayMs: 20_000, name: 'pdu-config-pull' });
  console.log(`[pdu-config] pull started (interval=${Math.round(configPullMs() / 1000)}s)`);
}

export function pduConfigPullStatus() {
  return {
    ..._last, ...(_registryRecovered ? { registryRecovered: _registryRecovered } : {}), intervalMs: configPullMs(),
    // v2.741(LEFT-02): '지금 수집' 작업 — 진행 중 여부·대기·지금 장비 · 마지막으로 끝난 작업 요약(무음 금지). 엣지 로그 표(pull.pdu)가 그대로 보여 준다.
    //   pushError 는 마지막으로 끝난 작업의 push 실패(예전 _last.pushError 자리 — 데이터 흐름 지도가 읽는다).
    collectJob: { running: _collectRunning, queued: _collectQueue.length, current: _collectCurrent },
    ...(_collectRun ? { collectRun: _collectRun } : {}),
    ...(_collectRun?.pushError ? { pushError: _collectRun.pushError } : {}),
  };
}
/** 진행 중인 '지금 수집' 작업이 끝날 때까지 기다린다(없으면 곧바로). 테스트·진단 전용 — 폴러 경로에서 부르지 말 것. */
export function pduCollectJobSettled() { return _collectRunning && _collectDone ? _collectDone : Promise.resolve(); }
