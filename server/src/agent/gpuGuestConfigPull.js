/**
 * 중앙→엣지 GPU 게스트 설정 배포 — 엣지(agent) 측 pull 워커.
 *
 * 중앙 UI에서 이 엣지 앞으로 지정한 GPU 게스트 수집 설정(공용/별도 계정·SSH 접속 IP·수집 방식
 * 등)을 아웃바운드 GET으로 주기적으로 가져와 로컬 gpu-guest.json에 병합 적용한다. 폐쇄망/NAT
 * 엣지도 중앙이 직접 push하지 않고 엣지가 pull하므로 동작한다(gpuGuestPush와 대칭).
 *
 * 적용은 saveGpuGuestSettings(=병합)로 하므로 로컬에만 있는 항목은 보존된다. 내용이 바뀌지
 * 않으면(서명 동일) 파일을 다시 쓰지 않는다.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { saveGpuGuestSettings } from '../gpu/settings.js';

let timer = null;
let last = null; // { at, applied, at:서버지정시각, error }
// v2.591(3차 감사 PR-7): 실패를 상태뿐 아니라 콘솔에도(같은 사유는 10분에 한 번) — 403·5xx 가 저널 어디에도 안 남았다.
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
let lastSig = '';
// 재진입 가드(single-flight) — CLAUDE.md 성능 불변조건: setInterval(()=>asyncFn()) 폴러는
// 이전 주기가 간격을 넘기면(고RTT·중앙 지연) 다음 틱이 겹쳐 돌아 연결·CPU 가 누적된다.
// 수동 실행 API 도 같은 exported 함수를 부르므로 가드를 공유한다(inventoryPush 와 동일 패턴).
let running = false;

function headers() {
  return { ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pullGpuGuestConfigNow(...args) {
  if (running) return { ok: false, reason: '이전 pull 진행 중(겹침 방지)' };
  running = true;
  try { return await _pullGpuGuestConfigNow(...args); } finally { running = false; }
}

async function _pullGpuGuestConfigNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'pull 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  const url = `${config.agent.centralUrl}/api/central/gpu-guest-config?agent=${encodeURIComponent(config.agent.name || '')}`;
  try {
    const res = await resilientFetch(url, { method: 'GET', headers: headers(), timeoutMs: 20_000, retries: 2 });
    if (!res.ok) throw new Error(`gpu-guest-config <- ${res.status}`);
    const body = await res.json();
    if (!body || !body.assigned || !body.settings) { last = { at: Date.now(), applied: false, reason: '중앙 지정 없음' }; return { ok: true, applied: false }; }
    const sig = crypto.createHash('sha1').update(JSON.stringify(body.settings)).digest('hex');
    if (sig === lastSig) { last = { at: Date.now(), applied: false, reason: '변경 없음', srvAt: body.at || 0 }; return { ok: true, applied: false, unchanged: true }; }
    saveGpuGuestSettings(body.settings); // 로컬 gpu-guest.json에 병합
    // v2.597(LC2597-02): 중앙이 바꾼 주기를 두 폴러에 즉시 적용 — 예전에는 파일만 바뀌고 재시작 전까지 옛 주기로 돌았다.
    try { (await import('../gpu/poller.js')).rescheduleGpuGuestPoller?.(); } catch (e) { console.warn(`[gpu-guest-config] 폴러 재무장 실패: ${e.message}`); }
    try { (await import('../gpu/physicalPoller.js')).reschedulePhysicalPoller?.(); } catch (e) { console.warn(`[gpu-guest-config] 물리 GPU 폴러 재무장 실패: ${e.message}`); }
    lastSig = sig;
    last = { at: Date.now(), applied: true, srvAt: body.at || 0 };
    console.log(`[gpu-guest-config] 중앙 배포 설정 적용: agent=${config.agent.name} vcenters=${Object.keys(body.settings.vcenters || {}).length}`);
    return { ok: true, applied: true };
  } catch (e) {
    last = { at: Date.now(), applied: false, error: e.message };
    if (_logChange('pull', e.message)) console.warn(`[gpu-guest-config] 중앙 설정 pull 실패: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function gpuGuestConfigPullStatus() {
  return { enabled: !!(config.agent.centralUrl && config.agent.centralToken), centralUrl: config.agent.centralUrl, last };
}

export function startGpuGuestConfigPull() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return;
  const intervalMs = Math.max(30_000, config.agent.inventoryIntervalMs || 60_000);
  // 기동 직후 1회(설정을 먼저 받아 첫 폴에 반영), 이후 주기 반복.
  setTimeout(() => pullGpuGuestConfigNow().catch((e) => console.error('[gpu-guest-config] pull 실패:', e.message)), 8_000).unref?.();
  timer = setInterval(() => pullGpuGuestConfigNow().catch(() => {}), intervalMs);
  timer.unref?.();
  console.log(`[gpu-guest-config] pull started <- ${config.agent.centralUrl} every ${Math.round(intervalMs / 1000)}s`);
}
