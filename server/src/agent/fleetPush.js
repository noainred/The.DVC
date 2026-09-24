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

import { config, loadVcenterConfig } from '../config.js';
import { reqTimeoutMs } from './envTimeout.js';
import { store } from '../store.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { getFleetInventory } from '../insights/fleetInventory.js';
import { UNREAD_STATUSES } from './inventoryPush.js'; // v2.604 EDGE2604-01: '읽지 못한 vCenter' 판정은 인벤토리 push 와 한 기준

/**
 * v2.604(감사 EDGE2604-01 — 재현): 이 엣지가 **직접 수집하는** vCenter 중 호스트를 아직 읽지 못한 것(순수 판정).
 * 베어메탈 판정(classifyFleet)은 스냅샷의 호스트 목록과 iDRAC 을 대조해 'ESXi 가 아닌 서버' 를 고른다 — 호스트가 비어 있으면
 * ESXi 를 받치는 iDRAC 전부가 **베어메탈로 둔갑**한다(부팅 30초 뒤 첫 push · 재시작 뒤 연결 실패 vCenter). 그 주기는 보내지 않는다.
 *  · 등록돼 있는데 스냅샷에 아직 없는 vCenter(첫 수집 전) → 못 읽음
 *  · 상태가 UNREAD_STATUSES(unreachable·pending·maintenance)이고 그 vCenter 의 호스트가 0 → 못 읽음
 *  · 비활성·위임(site) vCenter 는 이 엣지가 호스트를 가져오지 않으므로 보지 않는다.
 * 반환: 못 읽은 vCenter id 배열(비어 있으면 보내도 된다).
 */
export function unreadHostVcenters(snap, registered = []) {
  const vcs = Array.isArray(snap?.vcenters) ? snap.vcenters : [];
  const hosts = Array.isArray(snap?.hosts) ? snap.hosts : [];
  const byId = new Map(vcs.filter((v) => v && v.id).map((v) => [v.id, v]));
  const hasHosts = (id) => hosts.some((h) => h && h.vcenterId === id);
  const out = [];
  for (const r of registered) {
    if (!r || !r.id || r.enabled === false || r.collectMode === 'site') continue;
    const vc = byId.get(r.id);
    if (!vc) { out.push(r.id); continue; }
    if (vc.status === 'disabled' || vc.collectSource === 'site') continue;
    if (UNREAD_STATUSES.includes(vc.status) && !hasHosts(vc.id)) out.push(r.id);
  }
  return out;
}

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
    let registered = [];
    try { registered = loadVcenterConfig()?.vcenters || []; } catch { registered = []; }
    const unread = unreadHostVcenters(snap, registered);
    if (unread.length) {
      // 조용히 건너뛰지 않는다 — 상태(last)와 콘솔에 사유를 남긴다(v2.549 무음 실패 금지). 중앙은 직전 목록을 유지한다.
      const note = `호스트를 아직 읽지 못한 vCenter ${unread.length}개(${unread.slice(0, 5).join(', ')}) — ESXi 를 받치는 iDRAC 이 베어메탈로 잘못 분류되지 않도록 이번 주기는 보내지 않았습니다`;
      last = { at: Date.now(), sent: 0, error: null, skipped: true, note, unreadVcenters: unread.slice(0, 32) };
      console.warn(`[fleet-push] ${note}`);
      return { ok: false, skipped: true, reason: note };
    }
    const inv = await getFleetInventory(snap);
    // 메타만 — 자격증명/전력 제외. 엣지 베어메탈의 전력은 원격 수집(collector pull) 경로로만
    // 중앙에 반영하므로 watts는 보내지 않는다(이중계상 방지). 중앙은 서비스태그로 dedup해 병합한다.
    const baremetal = (inv.bareMetal || []).map((b) => ({
      fleetId: b.fleetId, name: b.name, model: b.model, serviceTag: b.serviceTag,
      vcenterId: b.vcenterId, source: b.source,
    }));
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/fleet`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ agent: config.agent.name, baremetal, generatedAt: snap.generatedAt }),
      timeoutMs: reqTimeoutMs(process.env.AGENT_PUSH_TIMEOUT_MS, 60_000), retries: 1,
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
