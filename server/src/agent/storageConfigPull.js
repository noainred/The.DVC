/**
 * agent/storageConfigPull.js — 중앙→엣지 스토리지 장비 배포 pull(v2.302, gpuGuestConfigPull 패턴).
 * 중앙이 이 엣지 앞으로 지정한 장비 목록(자격증명 포함 — 엣지가 장비에 로그인해야 하므로)을
 * 아웃바운드 GET 으로 주기 수집해 로컬 레지스트리에 반영한다(폐쇄망/NAT 엣지 동작).
 * 반영은 registry.applyPulledDevices — 내 몫을 통째 교체(중앙이 진실의 원천: 중앙에서 지운
 * 장비가 엣지에 유령으로 남지 않게). 저장 시 엣지 자신의 vault 정책으로 재봉인된다.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyPulledDevices } from '../storage/registry.js';
import { collectDeviceNow } from '../storage/poller.js';
import { pushStorageNow } from '../storage/push.js';

const INTERVAL_MS = Math.max(60_000, Number(process.env.STORAGE_CONFIG_PULL_MS) || 5 * 60_000);
let _timer = null;
let _lastSig = '';
let _last = null;
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
    if (!res.ok) throw new Error(`storage-config <- ${res.status}`);
    const body = await res.json();
    const devices = body?.devices || [];
    const sig = crypto.createHash('sha1').update(JSON.stringify(devices)).digest('hex');
    let applied = false;
    if (sig !== _lastSig) {
      applyPulledDevices(devices);
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
    if (wants.length) {
      console.log(`[storage-config] 중앙 재수집 요청 ${wants.length}건 수신 — 즉시 수집`);
      for (const id of wants) {
        try { await collectDeviceNow(String(id)); collected++; }
        catch (e) { console.warn(`[storage-config] 재수집 실패(${id}): ${e.message}`); } // 실패 스냅샷도 push 로 전달됨
      }
      try { await pushStorageNow(); } catch (e) { console.warn(`[storage-config] 재수집 push 실패: ${e.message}`); }
    }
    _last = { at: Date.now(), applied, count: devices.length, collectRequested: wants.length, collected };
    return { ok: true, applied, unchanged: !applied, count: devices.length, collectRequested: wants.length, collected };
  } catch (e) { _last = { at: Date.now(), error: e.message }; return { ok: false, reason: e.message }; }
}

export function startStorageConfigPull() {
  if (_timer || !config.agent.centralUrl || !config.agent.centralToken) return;
  setTimeout(() => pullStorageConfigNow().catch(() => {}), 10_000);
  _timer = setInterval(() => pullStorageConfigNow().catch(() => {}), INTERVAL_MS);
  _timer.unref?.();
}
export function storageConfigPullStatus() { return _last; }
