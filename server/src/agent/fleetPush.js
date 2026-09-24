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

/**
 * v2.605(감사 RECENT2605-01 — 재현): 보류에는 반드시 시한(v2.601 RECENT2601-02 규약). 중앙 central/fleet.js 는 30분
 * (CENTRAL_FLEET_TTL_MS) 무보고 엣지 항목을 **지운다** — 못 읽은 vCenter 하나 때문에 매 주기 통째로 보류하면 30분 뒤
 * 나머지 정상 vCenter 의 베어메탈까지 중앙 통합 인벤토리에서 사라졌다(주석의 '중앙은 직전 목록을 유지' 가 거짓이 됐다).
 * 보류는 FLEET_WITHHOLD_MAX_MS(기본 20분 — 중앙 TTL 30분보다 짧게)까지만 하고, 넘으면 **못 읽은 vCenter 귀속분과
 * 귀속 없는 항목만 빼고** 보낸다(그 둘이 ESXi 를 받치는 iDRAC 이 베어메탈로 둔갑할 수 있는 항목이다). 뺀 개수와
 * 못 읽은 vCenter 는 본문·상태·콘솔에 밝힌다(조용한 축약 금지). ⚠ 뺀 항목은 중앙에서 그 동안 보이지 않는다(정직 기록).
 */
export const FLEET_WITHHOLD_MAX_MS = Math.max(60_000, Number(process.env.AGENT_FLEET_WITHHOLD_MAX_MS) || 20 * 60_000);
let withholdSince = null;

/**
 * 보류 판정(순수 — now·since 를 주입한다). 반환 { mode:'send'|'withhold'|'partial', since }
 *  · unread 0 → send(보류 시작 시각을 지운다)
 *  · 보류 시작 후 maxMs 이내 → withhold · 넘으면 partial
 */
export function fleetWithholdDecision(unread, since, now, maxMs = FLEET_WITHHOLD_MAX_MS) {
  if (!Array.isArray(unread) || !unread.length) return { mode: 'send', since: null };
  const s = since || now;
  return { mode: now - s > maxMs ? 'partial' : 'withhold', since: s };
}

/** 부분 전송에서 뺄 항목 — 못 읽은 vCenter 귀속분 + 귀속 없는 항목(순수). 반환 { keep, dropped } */
export function partialBareMetal(list, unread) {
  const bad = new Set(unread || []);
  const keep = []; let dropped = 0;
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || !b.vcenterId || bad.has(b.vcenterId)) { dropped++; continue; }
    keep.push(b);
  }
  return { keep, dropped };
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
    const dec = fleetWithholdDecision(unread, withholdSince, Date.now());
    withholdSince = dec.since;
    if (dec.mode === 'withhold') {
      // 조용히 건너뛰지 않는다 — 상태(last)와 콘솔에 사유를 남긴다(v2.549 무음 실패 금지). 중앙은 TTL(기본 30분) 동안만 직전 목록을 유지하므로
      //   보류는 FLEET_WITHHOLD_MAX_MS 까지만 한다(v2.605 RECENT2605-01).
      const note = `호스트를 아직 읽지 못한 vCenter ${unread.length}개(${unread.slice(0, 5).join(', ')}) — ESXi 를 받치는 iDRAC 이 베어메탈로 잘못 분류되지 않도록 이번 주기는 보내지 않았습니다(최대 ${Math.round(FLEET_WITHHOLD_MAX_MS / 60_000)}분 보류 뒤에는 그 vCenter 귀속분·귀속 없는 항목만 빼고 보냅니다)`;
      last = { at: Date.now(), sent: 0, error: null, skipped: true, note, unreadVcenters: unread.slice(0, 32), withholdSince };
      console.warn(`[fleet-push] ${note}`);
      return { ok: false, skipped: true, reason: note };
    }
    const inv = await getFleetInventory(snap);
    // 메타만 — 자격증명/전력 제외. 엣지 베어메탈의 전력은 원격 수집(collector pull) 경로로만
    // 중앙에 반영하므로 watts는 보내지 않는다(이중계상 방지). 중앙은 서비스태그로 dedup해 병합한다.
    let baremetal = (inv.bareMetal || []).map((b) => ({
      fleetId: b.fleetId, name: b.name, model: b.model, serviceTag: b.serviceTag,
      vcenterId: b.vcenterId, source: b.source,
    }));
    let partialInfo = null;
    if (dec.mode === 'partial') {
      const { keep, dropped } = partialBareMetal(baremetal, unread);
      baremetal = keep;
      partialInfo = { unreadVcenters: unread.slice(0, 32), withheldItems: dropped, withholdSince };
      console.warn(`[fleet-push] 호스트를 ${Math.round(FLEET_WITHHOLD_MAX_MS / 60_000)}분 넘게 읽지 못한 vCenter ${unread.length}개(${unread.slice(0, 5).join(', ')}) — 그 vCenter 귀속분·귀속 없는 베어메탈 ${dropped}대를 빼고 보냅니다(중앙이 이 엣지 목록을 만료로 지우지 않게)`);
    }
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/fleet`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ agent: config.agent.name, baremetal, generatedAt: snap.generatedAt, ...(partialInfo ? { partial: true, unreadVcenters: partialInfo.unreadVcenters, withheldItems: partialInfo.withheldItems } : {}) }),
      timeoutMs: reqTimeoutMs(process.env.AGENT_PUSH_TIMEOUT_MS, 60_000), retries: 1,
    });
    if (!res.ok) throw new Error(`fleet -> ${res.status}`);
    last = { at: Date.now(), sent: baremetal.length, error: null, ...(partialInfo ? { partial: true, ...partialInfo } : {}) };
    return { ok: true, sent: baremetal.length, ...(partialInfo ? { partial: true, withheldItems: partialInfo.withheldItems } : {}) };
  } catch (e) {
    last = { at: Date.now(), sent: 0, error: e.message };
    console.warn(`[fleet-push] 실패: ${e.message}`);
    return { ok: false, reason: e.message };
  } finally { running = false; }
}

/** 테스트 전용 — 보류 시작 시각 주입/초기화. */
export function _setFleetWithholdSinceForTest(v) { withholdSince = v; }

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
