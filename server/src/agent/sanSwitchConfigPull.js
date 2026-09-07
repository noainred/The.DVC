/**
 * agent/sanSwitchConfigPull.js — 중앙→엣지 SAN 스위치 배포 pull(v2.410, storageConfigPull 패턴).
 * 중앙이 이 엣지 앞으로 지정한 스위치 목록(자격증명 포함 — 엣지가 스위치에 로그인해야 한다)을
 * 아웃바운드 GET 으로 주기 수집해 로컬 레지스트리에 반영한다(폐쇄망/NAT 엣지 동작).
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices } from '../sanswitch/registry.js';
import { dropSnapshot } from '../sanswitch/store.js';
import { collectDeviceNow, testDeviceConnection } from '../sanswitch/poller.js';
import { pushSanSwitchNow } from '../sanswitch/push.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';

export const configPullMs = () => Math.max(60_000, Number(process.env.SANSW_CONFIG_PULL_MS) || 5 * 60_000);

let _timer = null;
let _lastSig = '';
let _last = null;
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
    if (res.status === 404) return { ok: false, reason: '중앙에 SAN 스위치 배포 엔드포인트 없음(중앙 버전이 낮음)' };
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
    // '지금 수집' 요청 — 구성이 안 바뀌어도 **매 pull 마다** 처리한다(재수집은 흔한 요청).
    const wants = Array.isArray(body?.collectNow) ? body.collectNow.slice(0, 20) : [];
    let collected = 0;
    for (const id of wants) {
      try { await collectDeviceNow(id); collected++; } catch (e) { console.warn(`[sanswitch-config] 재수집 실패 ${id}: ${e.message}`); }
    }
    if (collected) await pushSanSwitchNow().catch(() => {}); // 결과를 push 주기까지 기다리지 않게
    // 연결 테스트 대행(v2.421): 중앙 등록 화면의 테스트를 현지에서 실행하고 결과(추적 로그 포함)를 회신한다.
    // pull 자체를 막지 않도록 비동기로 돌린다(테스트는 최대 60초).
    const tests = Array.isArray(body?.testNow) ? body.testNow.slice(0, 5) : [];
    for (const t of tests) runDelegatedTest(t).catch((e) => console.warn(`[sanswitch-config] 테스트 대행 실패 ${t?.id}: ${e.message}`));
    _last = { at: Date.now(), applied, count: devices.length, collectRequested: wants.length, collected, testRequested: tests.length };
    return { ok: true, applied, unchanged: !applied, count: devices.length, collectRequested: wants.length, collected, testRequested: tests.length };
  } catch (e) {
    _last = { at: Date.now(), error: e.message };
    return { ok: false, reason: e.message };
  }
}

async function runDelegatedTest(t) {
  const device = t?.device && typeof t.device === 'object' ? t.device : null;
  if (!t?.id || !device) return;
  const result = await testDeviceConnection(device, { timeoutMs: Math.min(120_000, Number(t.timeoutMs) || 60_000), verbose: !!t.verbose, ranOn: config.agent.name || '엣지' });
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
export function sanSwitchConfigPullStatus() { return { ..._last, intervalMs: configPullMs() }; }
