/**
 * 사이트 위임 수집 — 현장 서버(에이전트) 측 push 워커.
 *
 * AGENT_PUSH_INVENTORY=true + CENTRAL_URL 설정 시, 이 서버가 자기 로컬 store에서 수집한
 * vCenter 인벤토리를 vCenter별로 잘라 중앙(OC2)의 /api/central/inventory 로 주기적으로
 * 보낸다. 중앙은 그 vCenter를 직접 폴링하지 않으므로 중앙↔원격vCenter RTT가 사라진다.
 *
 * 통신은 사이트 → 중앙 단방향 아웃바운드(push)라 폐쇄망/NAT 사이트에 유리하다.
 */

import { config } from '../config.js';
import { store } from '../store.js';

let timer = null;
let last = null; // { at, sent, errors }

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

async function pushVcenter(snap, vc) {
  const slice = {
    agent: config.agent.name,
    vcenterId: vc.id,
    vcenter: vc,
    hosts: snap.hosts.filter((h) => h.vcenterId === vc.id),
    vms: snap.vms.filter((v) => v.vcenterId === vc.id),
    datastores: snap.datastores.filter((d) => d.vcenterId === vc.id),
    networks: snap.networks.filter((n) => n.vcenterId === vc.id),
    alarms: snap.alarms.filter((a) => a.vcenterId === vc.id),
    generatedAt: snap.generatedAt,
  };
  const res = await fetch(`${config.agent.centralUrl}/api/central/inventory`, {
    method: 'POST', headers: headers(), body: JSON.stringify(slice), signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`inventory -> ${res.status}`);
}

export async function pushInventoryNow() {
  const snap = store.get();
  if (!snap?.vcenters?.length) return { ok: false, reason: '수집된 vCenter 없음' };
  let sent = 0; const errors = [];
  for (const vc of snap.vcenters) {
    if (!vc.id || vc.status === 'disabled' || vc.collectSource === 'site') continue; // 위임받은 건 재전송 안 함
    try { await pushVcenter(snap, vc); sent++; }
    catch (e) { errors.push(`${vc.id}: ${e.message}`); console.warn(`[inv-push] ${vc.id} 실패: ${e.message}`); }
  }
  last = { at: Date.now(), sent, errors };
  return { ok: errors.length === 0, sent, errors };
}

export function inventoryPushStatus() { return { enabled: !!(config.agent.pushInventory && config.agent.centralUrl), centralUrl: config.agent.centralUrl, intervalMs: config.agent.inventoryIntervalMs, last }; }

export function startInventoryPush() {
  if (!config.agent.pushInventory || !config.agent.centralUrl) return;
  // 첫 수집이 끝난 뒤 보내도록 20초 지연 후 시작, 이후 주기 반복.
  setTimeout(() => pushInventoryNow().catch((e) => console.error('[inv-push] 실패:', e.message)), 20_000).unref?.();
  timer = setInterval(() => pushInventoryNow().catch(() => {}), config.agent.inventoryIntervalMs);
  timer.unref?.();
  console.log(`[inv-push] started → ${config.agent.centralUrl} every ${Math.round(config.agent.inventoryIntervalMs / 1000)}s`);
}
