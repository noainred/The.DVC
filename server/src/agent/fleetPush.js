/**
 * 엣지 베어메탈 push 워커 — 현장(에이전트) 포탈이 자기 데이터센터의 베어메탈 서버 목록을
 * 중앙(OC2)의 /api/central/fleet 로 주기적으로 보낸다.
 *
 * 전력이 수집되는 베어메탈은 이미 원격 전력(remotePowerByHost) 경로로 중앙에 잡히지만,
 * '전력 미보고' 베어메탈(등록만 됐거나 전원오프)은 그 경로로 안 보이므로 여기서 메타데이터를
 * 보내 중앙의 통합 인벤토리(DC별)에서도 보이게 한다. 본문은 작아(메타만) gzip 없이 보낸다.
 *
 * CENTRAL_URL 설정 시 동작(=에이전트). AGENT_PUSH_FLEET=false 로 끌 수 있다.
 */

import { config } from '../config.js';
import { store } from '../store.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { getFleetInventory } from '../insights/fleetInventory.js';

let timer = null;
let last = null;     // { at, sent, error }
let running = false;  // single-flight

const ENABLED = process.env.AGENT_PUSH_FLEET !== 'false';

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pushFleetNow() {
  if (!config.agent.centralUrl || !ENABLED) return { ok: false, reason: '비활성' };
  if (running) return { ok: false, reason: '이전 push 진행 중' };
  running = true;
  try {
    const snap = store.get();
    const inv = await getFleetInventory(snap);
    // 메타만 — 자격증명/전력 시계열 제외. 중앙은 서비스태그로 dedup해 병합한다.
    const baremetal = (inv.bareMetal || []).map((b) => ({
      fleetId: b.fleetId, name: b.name, model: b.model, serviceTag: b.serviceTag,
      watts: b.watts, vcenterId: b.vcenterId, source: b.source,
    }));
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/fleet`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ agent: config.agent.name, baremetal, generatedAt: snap.generatedAt }),
      timeoutMs: Number(process.env.AGENT_PUSH_TIMEOUT_MS) || 60_000, retries: 1,
    });
    if (!res.ok) throw new Error(`fleet -> ${res.status}`);
    last = { at: Date.now(), sent: baremetal.length, error: null };
    return { ok: true, sent: baremetal.length };
  } catch (e) {
    last = { at: Date.now(), sent: 0, error: e.message };
    console.warn(`[fleet-push] 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  } finally { running = false; }
}

export function fleetPushStatus() {
  return { enabled: !!(config.agent.centralUrl && ENABLED), centralUrl: config.agent.centralUrl, last };
}

export function startFleetPush() {
  if (!config.agent.centralUrl || !ENABLED) return;
  // 첫 수집 이후 보내도록 30초 지연 후 시작, 이후 인벤토리 push 주기와 동일하게 반복.
  setTimeout(() => pushFleetNow().catch(() => {}), 30_000).unref?.();
  timer = setInterval(() => pushFleetNow().catch(() => {}), config.agent.inventoryIntervalMs || 300_000);
  timer.unref?.();
  console.log(`[fleet-push] started → ${config.agent.centralUrl}`);
}
