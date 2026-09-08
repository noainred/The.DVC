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
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices } from '../pdu/registry.js';
import { collectDeviceNow } from '../pdu/poller.js';
import { pushPduNow } from '../pdu/push.js';
import { runtimeIntervals, applyCentralIntervals, startAdaptiveTimer } from '../pdu/intervals.js';

const configPullMs = () => runtimeIntervals().configPullMs;
let _timer = null;
let _lastSig = '';
let _last = null;
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
    if (!res.ok) throw new Error(`pdu-config <- ${res.status}`);
    const body = await res.json();

    // 주기를 장비 목록보다 먼저 적용한다. 중앙이 값을 안 주면 빈 객체 → 엣지가 자기 env 로
    // 되돌아간다('중앙 미설정 = 로컬 유지' 계약). 이 호출이 타이머 재무장까지 트리거한다.
    const intervalsApplied = applyCentralIntervals(body?.intervals || {});

    const devices = Array.isArray(body?.devices) ? body.devices : [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      applyPulledDevices(devices);
      _lastSig = sig;
      applied = true;
      console.log(`[pdu-config] 중앙 배포 장비 적용: agent=${config.agent.name} PDU ${devices.length}대`);
    }

    // '지금 수집' 요청 — 구성이 안 바뀌어도 **매 pull 마다** 처리한다(재수집 요청은 흔하다).
    // 요청 장비를 즉시 수집하고 바로 push 해 push 주기를 기다리지 않게 한다.
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    let collected = 0;
    for (const id of wants) {
      const r = await collectDeviceNow(String(id));
      if (r.ok) collected++;
    }
    if (collected) await pushPduNow();

    _last = { at: Date.now(), ok: true, devices: devices.length, applied, intervalsApplied, collected };
    return { ok: true, ...(_last) };
  } catch (e) {
    _last = { at: Date.now(), ok: false, reason: e.message };
    return { ok: false, reason: e.message };
  }
}

export function startPduConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  _timer = startAdaptiveTimer(configPullMs, () => pullPduConfigNow(), { firstDelayMs: 20_000, name: 'pdu-config-pull' });
  console.log(`[pdu-config] pull started (interval=${Math.round(configPullMs() / 1000)}s)`);
}

export function pduConfigPullStatus() { return { ..._last, intervalMs: configPullMs() }; }
