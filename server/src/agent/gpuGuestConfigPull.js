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
import { resilientFetch } from '../util/resilientFetch.js';
import { saveGpuGuestSettings } from '../gpu/settings.js';

let timer = null;
let last = null; // { at, applied, at:서버지정시각, error }
let lastSig = '';

function headers() {
  return { ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pullGpuGuestConfigNow() {
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
    lastSig = sig;
    last = { at: Date.now(), applied: true, srvAt: body.at || 0 };
    console.log(`[gpu-guest-config] 중앙 배포 설정 적용: agent=${config.agent.name} vcenters=${Object.keys(body.settings.vcenters || {}).length}`);
    return { ok: true, applied: true };
  } catch (e) {
    last = { at: Date.now(), applied: false, error: e.message };
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
