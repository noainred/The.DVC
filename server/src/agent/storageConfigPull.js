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
import { applyPulledDevices } from '../storage/registry.js';
import { dropSnapshot } from '../storage/store.js';
import { collectDeviceNow } from '../storage/poller.js';
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
    const url = `${config.agent.centralUrl}/api/central/storage-config?agent=${encodeURIComponent(config.agent.name || '')}`;
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
    const intervalsApplied = applyCentralIntervals(body?.intervals || {});
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
    // 조기 return 이던 unchanged 분기를 없앴다. 요청 장비를 즉시 수집하고 바로 push 해
    // 결과가 push 주기(≤5분)를 기다리지 않고 중앙 화면에 반영되게 한다.
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    let collected = 0;
    let pushError = '';
    if (wants.length) {
      console.log(`[storage-config] 중앙 재수집 요청 ${wants.length}건 수신 — 즉시 수집`);
      for (const id of wants) {
        // v2.591 L1: false = 이미 수집 중(주기 수집) — 그 결과가 곧 push 되므로 새 세션을 열지 않는다.
        try { if (await collectDeviceNow(String(id))) collected++; else console.log(`[storage-config] ${id} 는 이미 수집 중 — 그 결과로 대신합니다`); }
        catch (e) { console.warn(`[storage-config] 재수집 실패(${id}): ${e.message}`); } // 실패 스냅샷도 push 로 전달됨
      }
      // v2.612 EDGE2612-02: 반환값을 본다 — pushStorageNow 는 실패를 {ok:false} 로 돌려주고(던지지 않는다) 상태 전용 push 실패는
      //   statusSent:false 다. 예전에는 무시해 '지금 수집' 결과가 중앙에 닿지 않아도 흔적이 없었다. withheld(보류)는 실패가 아니다.
      try {
        const pr = await pushStorageNow();
        if (pr && pr.ok === false) pushError = String(pr.reason || 'push 실패');
        else if (pr && pr.statusSent === false && !pr.statusSkipped) pushError = '상태 push 가 중앙에 닿지 않았습니다';
      } catch (e) { pushError = String(e?.message || e); }
      if (pushError) console.warn(`[storage-config] 재수집 push 실패: ${pushError}`);
    }
    _last = { at: Date.now(), applied, count: devices.length, collectRequested: wants.length, collected, ...(pushError ? { pushError } : {}),
      intervals: runtimeIntervals(), intervalsApplied: !!intervalsApplied.applied };
    return { ok: true, applied, unchanged: !applied, count: devices.length, collectRequested: wants.length, collected, ...(pushError ? { pushError } : {}),
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
export function storageConfigPullStatus() { return _last; }
