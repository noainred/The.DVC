/**
 * agent/sanSwitchConfigPull.js — 중앙→엣지 SAN 스위치 배포 pull(v2.410, storageConfigPull 패턴).
 * 중앙이 이 엣지 앞으로 지정한 스위치 목록(자격증명 포함 — 엣지가 스위치에 로그인해야 한다)을
 * 아웃바운드 GET 으로 주기 수집해 로컬 레지스트리에 반영한다(폐쇄망/NAT 엣지 동작).
 */
import crypto from 'node:crypto';
import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { classifyCentral404 } from './central404.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices, getDeviceWithSecret } from '../sanswitch/registry.js';
import { dropSnapshot, flushSnapshotsNow } from '../sanswitch/store.js';
import { collectDeviceNow, testDeviceConnection } from '../sanswitch/poller.js';
import { applyCentralPerfSettings } from '../sanswitch/perfSettings.js';
import { pushSanSwitchNow } from '../sanswitch/push.js';
import { pollPerfOnce } from '../sanswitch/perfPoller.js';
import { pushPerfNow } from '../sanswitch/perfPush.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
const _log404 = createChangeLogger({ windowMs: 10 * 60_000 }); // v2.600 EDGE2600-06

export const configPullMs = () => clampIntervalMs(Number(process.env.SANSW_CONFIG_PULL_MS) || 5 * 60_000, 5 * 60_000, 60_000); // v2.600 EDGE2600-05: 상태 보고 주기도 실제(상한 적용) 값

let _timer = null;
let _lastSig = '';
let _last = null;
let _perfCollectPush = null; // v2.603 EDGE2603-03: 포트 사용량 '지금 수집' 대행 뒤 push 의 결과
let _collectPush = null; // v2.601 EDGE2601-06: '지금 수집' 직후 push 의 결과(상태 화면·엣지 로그용)

/**
 * v2.601(감사 EDGE2601-06): '지금 수집' 직후 push — 진행 중이던 주기 push 는 재수집 **전** 스냅샷을 보냈으므로 끝난 뒤 한 번 더 보낸다.
 * v2.613(감사 EDGE2613-03): 그 '끝난 뒤 한 번 더' 는 이제 `sanswitch/push.js` 가 **프라미스 + `_again`** 으로 해결한다(storage·pdu 와
 *   같은 표준 경로 — storageConfigPull 이 `await pushStorageNow()` 하는 것과 같다). 예전의 사유 문자열(`'이전 push 진행 중'`) 대조 +
 *   2초×90회 재시도 루프는 지웠다 — 문구 하나가 바뀌면 루프가 조용히 무력화되는 결합이었다. 합류한 호출은 재전송 결과를 그대로 받는다.
 *   결과는 `_collectPush` 와 콘솔에 남긴다.
 */
export async function pushAfterCollect() {
  let r;
  try { r = await pushSanSwitchNow(); } catch (e) { r = { ok: false, reason: e.message }; }
  recordCollectPush(r);
  return r;
}
function recordCollectPush(r) {
  _collectPush = { at: Date.now(), ok: !!r?.ok, ...(r?.ok ? {} : { reason: r?.reason || '알 수 없음' }) };
  if (!r?.ok) console.warn(`[sanswitch-config] 재수집 결과 push 실패: ${r?.reason || '알 수 없음'}`);
}
/*
 * v2.733(점검 3회차 C4-02): '지금 수집'(collectNow) 작업 — pull 이 기다리지 않는 단일비행 작업.
 *  · 한 번에 하나만 돈다(_collectRunning). 돌고 있는 동안 온 요청은 대기열에 더하고(같은 id 는 한 번만), 작업이 이어서 처리한다 —
 *    새 작업을 겹쳐 띄우지 않는다(동시 세션 상한 규약 — 예전과 같이 장비는 한 대씩).
 *  · 대기열이 빈 것을 확인하는 줄과 _collectRunning=false 사이에 await 가 없다(finally 가 같은 동기 구간) — 그 사이에 들어온 요청이
 *    '작업이 돈다' 고 믿고 버려지지 않게.
 *  · 장비 파일은 장비마다 쓰지 않고 한 묶음 끝에 한 번(flushSnapshotsNow) 쓴다 — collectDeviceNow 에 flush:false 를 넘긴다.
 *  · 수집한 것이 있으면 묶음 끝에 push 한다(예전과 같다 — 중앙 claim→ack 의 결과 확인이 이 push 다).
 *  · 수집 도중 중앙이 그 장비를 이 엣지에서 뺐으면(설정 pull 이 이제 막히지 않으므로 생길 수 있다) 방금 넣은 스냅샷을 지운다.
 */
const COLLECT_QUEUE_MAX = 200;
const _collectQueue = [];
let _collectRunning = false;
let _collectCurrent = null;
let _collectRun = null;

/** 호스트 키(대소문자·앞뒤 공백 무시 — 같은 스위치는 같은 키). 빈 값이면 잠그지 않는다. */
export function sanHostKey(host) { return String(host ?? '').trim().toLowerCase(); }
const _hostLocks = new Map(); // 호스트 키 → 꼬리 프라미스(대기 순서 = 등록 순서)
/**
 * 같은 호스트에 대한 작업(연결 테스트 대행·'지금 수집')을 차례로 돌린다 — 같은 장비에 SSH 세션을 겹치지 않게.
 * 잠금 등록(_hostLocks.set)은 호출과 같은 동기 구간에서 일어난다(먼저 부른 쪽이 먼저 돈다). 다른 호스트는 서로 기다리지 않는다.
 */
async function withHostLock(host, fn) {
  const key = sanHostKey(host);
  if (!key) return fn();
  const prev = _hostLocks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  _hostLocks.set(key, tail);
  try { await prev; return await fn(); }
  finally { release(); if (_hostLocks.get(key) === tail) _hostLocks.delete(key); }
}

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
  if (dropped) console.warn(`[sanswitch-config] '지금 수집' 대기열 상한(${COLLECT_QUEUE_MAX})으로 ${dropped}건을 받지 않았습니다 — 중앙이 시한 뒤 다시 내려보냅니다`);
  if (!_collectRunning && _collectQueue.length) {
    _collectRunning = true;
    runCollectJob().catch((e) => console.warn(`[sanswitch-config] '지금 수집' 작업 실패: ${e.message}`));
  }
  return { queued, already, dropped };
}

async function runCollectJob() {
  const t0 = Date.now();
  let requested = 0; let collected = 0; let busy = 0; let failed = 0;
  try {
    for (;;) {
      let batch = 0;
      while (_collectQueue.length) {
        const id = _collectQueue.shift();
        _collectCurrent = id; requested++;
        try {
          const dev = getDeviceWithSecret(id);
          const ok = await withHostLock(dev?.host, () => collectDeviceNow(id, { flush: false }));
          if (ok) { collected++; batch++; } else { busy++; console.log(`[sanswitch-config] ${id} 는 이미 수집 중 — 그 결과로 대신합니다`); }
          if (!getDeviceWithSecret(id)) { try { dropSnapshot(id); } catch { /* */ } }
        } catch (e) { failed++; console.warn(`[sanswitch-config] 재수집 실패 ${id}: ${e.message}`); }
        finally { _collectCurrent = null; }
      }
      try { flushSnapshotsNow(); } catch { /* 실패는 store 가 콘솔·상태에 남긴다 */ }
      if (batch) await pushAfterCollect(); // 결과를 push 주기까지 기다리지 않게(v2.601 EDGE2601-06: 진행 중이면 끝난 뒤 다시)
      if (!_collectQueue.length) return;   // ⚠ 이 확인과 finally 의 _collectRunning=false 사이에 await 를 두지 말 것
    }
  } finally {
    _collectRunning = false;
    _collectRun = { at: Date.now(), requested, collected, busy, failed, durationMs: Date.now() - t0 };
  }
}

// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
// 재진입 가드(single-flight) — 수동 실행 API 도 같은 함수를 부르므로 가드를 공유한다.
let running = false;

export async function pullSanSwitchConfigNow(...args) {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pull(...args); } finally { running = false; }
}

async function _pull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  try {
    const url = `${config.agent.centralUrl}/api/central/sanswitch-config?agent=${encodeURIComponent(config.agent.name || '')}`;
    const res = await resilientFetch(url, { method: 'GET', headers: { 'X-Central-Token': config.agent.centralToken }, timeoutMs: 20_000, retries: 2 });
    // v2.600 EDGE2600-06: 404 본문으로 '중앙이 central 을 끔' 과 '엔드포인트 없음' 을 가르고 상태·콘솔에 남긴다(예전엔 값만 돌려줬다).
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      _last = { ...(_last || {}), at: Date.now(), ok: false, error: c.reason, kind: c.kind };
      if (_log404(c.kind, c.reason)) console.warn(`[sanswitch-config] ${c.reason}`);
      return { ok: false, reason: c.reason, kind: c.kind };
    }
    if (!res.ok) throw new Error(`sanswitch-config <- ${res.status}`);
    const body = await res.json();
    const devices = body?.devices || [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      // 중앙에서 빠진 장비의 로컬 스냅샷도 함께 제거(낡은 스냅샷이 매 주기 push 되어 orphan 으로 남는 것 방지).
      applyPulledDevices(devices, { onRemoved: (ids) => ids.forEach((id) => { try { dropSnapshot(id); } catch { /* */ } }) });
      _lastSig = sig;
      applied = true;
      console.log(`[sanswitch-config] 중앙 배포 스위치 적용: agent=${config.agent.name} ${devices.length}대`);
    }
    // 포트 사용량 수집 설정(v2.423): 중앙이 지정한 값을 적용(SANSW_PERF_LOCAL=1 이면 무시). 켜짐이 바뀌면 다음 틱부터 수집.
    let perfApplied = false;
    // v2.632(감사 EDGE2632-02): 중앙이 포트 사용량 설정 파일을 못 읽으면 perf 를 빼고 사유를 싣는다 — 적용하지 않고(직전 값 유지) 상태·콘솔에 남긴다.
    const perfUnreadable = body?.perfSettingsUnreadable && typeof body.perfSettingsUnreadable === 'object'
      ? String(body.perfSettingsUnreadable.reason || '사유 미상').slice(0, 200) : '';
    if (perfUnreadable && _log404('perf-unreadable', perfUnreadable)) console.warn(`[sanswitch-config] 중앙 포트 사용량 설정을 읽지 못해 받지 않았습니다(직전 설정 유지): ${perfUnreadable}`);
    if (body?.perf) { try { perfApplied = applyCentralPerfSettings(body.perf); if (perfApplied) console.log(`[sanswitch-config] 중앙 포트 사용량 설정 적용: ${JSON.stringify(body.perf)}`); } catch (e) { console.warn(`[sanswitch-config] perf 설정 적용 실패: ${e.message}`); } }
    // 연결 테스트 대행(v2.421): 중앙 등록 화면의 테스트를 현지에서 실행하고 결과(추적 로그 포함)를 회신한다.
    // pull 자체를 막지 않도록 비동기로 돌린다(테스트는 최대 60초).
    // v2.733(점검 3회차 C4-02): '지금 수집'(collectNow)보다 **먼저** 시작한다. 예전에는 같은 응답의 collectNow(최대 20대)를 한 대씩
    //   끝까지 await 한 **뒤에야** 테스트를 시작해, 중앙 테스트 시한(sanswitch/testRuns.js — startedAt 기준 대기 10분 + 결과 5분)을
    //   수집 시간이 먹었다(재현: 응답 없는 스위치 3대 12초 뒤에야 테스트 시작 — 운영 시한 60초면 10대 안팎에서 '엣지 응답 없음').
    //   같은 장비(호스트)에 세션이 겹치지 않게 테스트·재수집은 호스트 잠금(withHostLock)을 공유한다 — 먼저 등록된 쪽이 먼저 돈다.
    const tests = Array.isArray(body?.testNow) ? body.testNow.slice(0, 5) : [];
    for (const t of tests) runDelegatedTest(t).catch((e) => console.warn(`[sanswitch-config] 테스트 대행 실패 ${t?.id}: ${e.message}`));
    // '지금 수집' 요청 — 구성이 안 바뀌어도 **매 pull 마다** 처리한다(재수집은 흔한 요청).
    // v2.733(C4-02): pull 이 기다리지 않는다 — 별도 단일비행 작업(runCollectJob)이 한 대씩 순서대로 수집하고 끝나면 push 한다
    //   (CVP 형제와 같다). 예전에는 루프 동안 재진입 가드가 다음 설정 pull(장비 추가·삭제·포트 사용량 설정·다음 테스트 인출)까지 막았다.
    //   순차·장비 시한·'이미 수집 중이면 새 세션을 열지 않는다'(collectDeviceNow 의 _inFlight) 규약은 그대로다.
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    const enq = wants.length ? enqueueCollect(wants) : null;
    /**
     * 포트 사용량 '지금 수집' 대행(v2.517). 중앙에서 버튼을 누르면 엣지 위임 장비는 이 플래그로만
     * 실행된다(중앙은 엣지에 명령을 밀어넣을 수 없다 — pull 구조).
     *
     * · `force: true` — 설정이 꺼져 있어도 관리자가 눌러 시험할 수 있게(중앙 라우트와 같은 의미론).
     * · **await 하지 않는다** — portperfshow 캡처는 표본 시간(기본 8초)×장비 수라 pull 응답을 붙잡으면
     *   설정 반영·연결 테스트 대행이 그만큼 밀린다. 재진입 가드가 중복 실행을 막는다.
     * · 수집 뒤 즉시 push — 표본이 0건이어도 상태 하트비트가 올라가 중앙이 사유를 본다.
     */
    let perfCollect = false;
    if (body?.perfCollectNow === true) {
      perfCollect = true;
      (async () => {
        const r = await pollPerfOnce({ force: true });
        console.log(`[sanswitch-config] 중앙 요청 포트 사용량 수집: ${r.ok ? `성공 ${r.collected}대 / 실패 ${r.failed}대` : `건너뜀(${r.reason})`}`);
        // v2.603(감사 EDGE2603-03): push 결과를 버리지 않는다 — 예전엔 반환값을 보지 않아 거절·실패가 무음이었다.
        //   pushPerfNow 는 이제 진행 중인 주기 push 가 끝난 뒤 한 번 더 보내고 그 결과를 돌려준다.
        let p;
        try { p = await pushPerfNow(); } catch (e) { p = { ok: false, reason: e.message }; }
        _perfCollectPush = { at: Date.now(), ok: !!p?.ok, ...(p?.ok ? { sent: p.sent ?? 0 } : { reason: p?.reason || '알 수 없음' }) };
        if (!p?.ok) console.warn(`[sanswitch-config] 포트 사용량 수집 결과 push 실패: ${p?.reason || '알 수 없음'}`);
      })().catch((e) => console.warn(`[sanswitch-config] 포트 사용량 수집 대행 실패: ${e.message}`));
    }
    // v2.733(C4-02): 수집 결과(collected)는 이 pull 이 끝난 뒤에 나온다 — 상태의 collectRun(마지막으로 끝난 작업)이 말한다.
    const collectQueued = enq ? enq.queued : 0;
    const collectAlready = enq ? enq.already : 0;
    _last = { at: Date.now(), applied, count: devices.length, collectRequested: wants.length, collectQueued, ...(collectAlready ? { collectAlready } : {}), ...(enq?.dropped ? { collectDropped: enq.dropped } : {}), testRequested: tests.length, perfApplied, perfCollect, ...(perfUnreadable ? { perfSettingsUnreadable: perfUnreadable } : {}) };
    return { ok: true, applied, unchanged: !applied, count: devices.length, collectRequested: wants.length, collectQueued, testRequested: tests.length, perfApplied, perfCollect };
  } catch (e) {
    _last = { at: Date.now(), error: e.message };
    if (_logChange('pull', e.message)) console.warn(`[sanswitch-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

async function runDelegatedTest(t) {
  const device = t?.device && typeof t.device === 'object' ? t.device : null;
  if (!t?.id || !device) return;
  // v2.733(C4-02): 같은 호스트의 '지금 수집' 과 세션을 겹치지 않는다(호스트 잠금 — 등록 순서대로). ⚠ 이 줄 앞에 await 를 두지 말 것 —
  //   _pull 이 테스트를 수집보다 먼저 부르는 것으로 '테스트가 먼저' 를 보장한다(잠금 등록이 호출과 같은 동기 구간에 있어야 한다).
  const result = await withHostLock(device.host, () => testDeviceConnection(device, { timeoutMs: Math.min(120_000, Number(t.timeoutMs) || 60_000), verbose: !!t.verbose, ranOn: config.agent.name || '엣지' }));
  const res = await resilientFetch(`${config.agent.centralUrl}/api/central/sanswitch-test-result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': config.agent.centralToken },
    body: JSON.stringify({ agent: config.agent.name || '', id: t.id, result }), timeoutMs: 20_000, retries: 2,
  });
  if (!res.ok) throw new Error(`sanswitch-test-result <- ${res.status}`);
}

export function startSanSwitchConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullSanSwitchConfigNow(), { firstDelayMs: 20_000, name: 'SAN 스위치 설정 pull' });
}
export function sanSwitchConfigPullStatus() {
  return {
    ..._last, ...(_collectPush ? { collectPush: _collectPush } : {}), ...(_perfCollectPush ? { perfCollectPush: _perfCollectPush } : {}), intervalMs: configPullMs(),
    // v2.733(C4-02): '지금 수집' 작업 — 진행 중 여부·대기·지금 장비 · 마지막으로 끝난 작업 요약(무음 금지).
    collectJob: { running: _collectRunning, queued: _collectQueue.length, current: _collectCurrent },
    ...(_collectRun ? { collectRun: _collectRun } : {}),
  };
}
