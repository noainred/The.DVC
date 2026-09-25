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
import { applyPulledDevices } from '../pdu/registry.js';
import { collectDeviceNow, forgetDevices } from '../pdu/poller.js';
import { pushPduNow, pduPushStatus } from '../pdu/push.js';
import { runtimeIntervals, applyCentralIntervals, startAdaptiveTimer } from '../pdu/intervals.js';

const configPullMs = () => runtimeIntervals().configPullMs;
let _timer = null;
let _lastSig = '';
let _last = null;
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
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
    const url = `${config.agent.centralUrl}/api/central/pdu-config?agent=${encodeURIComponent(config.agent.name || '')}`;
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
    const intervalsApplied = applyCentralIntervals(body?.intervals || {});

    const devices = Array.isArray(body?.devices) ? body.devices : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      const ap = applyPulledDevices(devices);
      if (ap?.removed?.length) forgetDevices(ap.removed);
      _lastSig = sig;
      applied = true;
      console.log(`[pdu-config] 중앙 배포 장비 적용: agent=${config.agent.name} PDU ${devices.length}대`);
    }

    // '지금 수집' 요청 — 구성이 안 바뀌어도 **매 pull 마다** 처리한다(재수집 요청은 흔하다).
    // 요청 장비를 즉시 수집하고 바로 push 해 push 주기를 기다리지 않게 한다.
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    // v2.602(EDGE2602-05): 실패도 **즉시** push 한다(스토리지·SAN 과 같은 규칙) — 예전에는 성공이 1건이라도 있을 때만
    //   push 해, 실패 스냅샷이 다음 정기 push 까지 중앙에 닿지 않았다(사용자는 '지금 수집' 을 눌렀는데 결과가 안 보인다).
    let collected = 0;
    let failed = 0;
    let pushError = '';
    if (wants.length) {
      for (const id of wants) {
        try {
          const r = await collectDeviceNow(String(id));
          if (r?.ok) collected++;
          else { failed++; if (r?.reason) console.warn(`[pdu-config] 재수집 실패(${id}): ${r.reason}`); }
        } catch (e) { failed++; console.warn(`[pdu-config] 재수집 실패(${id}): ${e.message}`); }
      }
      // v2.612 EDGE2612-02: pushPduNow 는 실패를 던지지 않고 {ok:false, reason} 으로 돌려준다 — 반환값도 본다
      //   (예전에는 catch 만 있어 pushError 가 한 번도 채워지지 않았다). withheld(보류)는 실패가 아니다.
      try {
        const pr = await pushPduNow();
        if (pr && pr.ok === false) { pushError = String(pr.reason || pduPushStatus()?.reason || 'push 실패'); console.warn(`[pdu-config] 재수집 push 실패: ${pushError}`); }
      } catch (e) { pushError = String(e?.message || e); console.warn(`[pdu-config] 재수집 push 실패: ${pushError}`); }
    }

    _last = { at: Date.now(), ok: true, devices: devices.length, applied, intervalsApplied, collected, collectRequested: wants.length, collectFailed: failed, ...(pushError ? { pushError } : {}) };
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

export function pduConfigPullStatus() { return { ..._last, intervalMs: configPullMs() }; }
