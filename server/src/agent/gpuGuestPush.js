/**
 * 게스트 GPU 수집 위임 — 현장 서버(에이전트) 측 push 워커.
 *
 * 포탈(중앙)이 ESXi 망에 직접 못 가는 환경에서, ESXi 망에 닿는 현장 agent가 게스트
 * OS(nvidia-smi)에서 수집한 GPU 사용률을 중앙의 /api/central/gpu-guest-data 로 주기적으로
 * push 한다. 중앙은 이 값을 로컬 폴러와 동일한 게스트 오버레이로 받아 표시한다.
 *
 * 전제: 이 agent에서 GPU 게스트 수집(startGpuGuestPoller)이 동작해 gpu/store.js 오버레이가
 * 채워져 있어야 한다(설정 › GPU 게스트 수집을 이 agent에서 구성). 통신은 사이트→중앙
 * 단방향 아웃바운드라 폐쇄망/NAT 사이트에 유리하다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readCentralReply, dropSummaryOf, warnDrop } from './centralReply.js'; // v2.606 EDGE2606-03
import { getGuestGpuVms, getGuestGpuAllHosts } from '../gpu/store.js';
import { getGpuGuestDiag, gpuGuestStatus } from '../gpu/poller.js';

/**
 * v2.605(감사 EDGE2605-02 — 재현): 중앙 setGuestGpu 는 이 엣지의 항목을 **전부 지우고 교체**한다. 예전에는 고정 35초 지연만 두고
 * 첫 게스트 폴이 끝났는지 보지 않아, 재시작 직후 빈 목록(hosts:[] vms:[] diag:null)을 보내 중앙의 그 법인 GPU 사용률을 지웠다
 * (인벤토리 v2.600 EDGE2600-04 의 형제). 첫 폴(lastRun) 전에는 보내지 않는다 — 보류에는 시한을 둔다(v2.601 규약).
 */
export const GPU_GUEST_PUSH_WITHHOLD_MAX_MS = Math.max(60_000, Number(process.env.AGENT_GPU_GUEST_WITHHOLD_MAX_MS) || 15 * 60_000);
let _withholdSince = null;
let _pollerStatus = () => gpuGuestStatus();
/** 첫 폴 전 보류 판정(순수). 반환 { withhold, since } */
/*
 * v2.606(EDGE2606-01): '첫 폴이 끝났다' 만으로는 부족했다 — 인벤토리 첫 수집 전(빈 스냅샷)·인증 정지·로그인 실패로 돈 폴도
 * lastRun 을 찍어 빈 목록이 나갔다. 이제 **모든 대상 vCenter 를 읽은 폴**(lastRun.unreadVcenters 가 비어 있음)에만
 * 통과하고, 못 읽은 vCenter 가 남으면 같은 시한(maxMs) 동안 보류한다(보류에는 시한 — v2.601). 반환 reason 은 보류 사유.
 */
export function gpuGuestPushWithhold(lastRun, since, now, maxMs = GPU_GUEST_PUSH_WITHHOLD_MAX_MS) {
  const unread = lastRun && Array.isArray(lastRun.unreadVcenters) ? lastRun.unreadVcenters.length : 0;
  if (lastRun && !unread) return { withhold: false, since: null };
  const s = since || now;
  const out = { withhold: now - s <= maxMs, since: s };
  return lastRun ? { ...out, reason: 'unread-vcenters', unread } : out;
}
/** 테스트 전용 — 게스트 폴러 상태 주입/복원. */
export function _setGuestPollerStatusForTest(fn) { _pollerStatus = fn || (() => gpuGuestStatus()); _withholdSince = null; }

let timer = null;
let last = null; // { at, hosts, vms, error }
// 재진입 가드(single-flight) — CLAUDE.md 성능 불변조건: setInterval(()=>asyncFn()) 폴러는
// 이전 주기가 간격을 넘기면(고RTT·중앙 지연) 다음 틱이 겹쳐 돌아 연결·CPU 가 누적된다.
// 수동 실행 API 도 같은 exported 함수를 부르므로 가드를 공유한다(inventoryPush 와 동일 패턴).
let running = false;

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function pushGpuGuestNow(...args) {
  if (running) return { ok: false, reason: '이전 push 진행 중(겹침 방지)' };
  running = true;
  try { return await _pushGpuGuestNow(...args); } finally { running = false; }
}

async function _pushGpuGuestNow() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return { ok: false, reason: 'push 비활성화(CENTRAL_URL/TOKEN 미설정)' };
  let lastRun = null;
  try { lastRun = _pollerStatus()?.lastRun || null; } catch { lastRun = null; }
  const wh = gpuGuestPushWithhold(lastRun, _withholdSince, Date.now());
  _withholdSince = wh.since;
  if (wh.withhold) {
    const note = '게스트 GPU 첫 수집이 아직 끝나지 않아 보내지 않았습니다(빈 목록을 보내면 중앙의 이 엣지 GPU 사용률이 지워집니다)';
    last = { at: Date.now(), hosts: 0, vms: 0, skipped: true, note };
    console.log(`[gpu-guest-push] ${note}`);
    return { ok: false, skipped: true, reason: note };
  }
  const hosts = [...getGuestGpuAllHosts().entries()].map(([hostId, v]) => ({ hostId, utilPct: v.utilPct }));
  const vms = getGuestGpuVms().map((v) => ({ vmId: v.vmId, utilPct: v.utilPct, utilNA: !!v.utilNA, memUsedPct: v.memUsedPct ?? null, host: v.host, vcenterId: v.vcenterId }));
  const diag = getGpuGuestDiag(); // 선별 깔때기 + VM별 성공/실패(웹 '수집 진단'에서 표시)
  // 진단은 데이터가 없어도(=어디서 막혔는지가 핵심) 항상 보낸다.
  try {
    const res = await resilientFetch(`${config.agent.centralUrl}/api/central/gpu-guest-data`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ agent: config.agent.name, hosts, vms, diag }), timeoutMs: 30_000, retries: 2,
    });
    if (!res.ok) throw new Error(`gpu-guest -> ${res.status}`);
    // v2.606 EDGE2606-03: 200 이어도 중앙이 미등록 vCenter 항목(unregistered)·상한(omitted)·미검증 이름을 뺄 수 있다 — 상태·콘솔에.
    const drop = dropSummaryOf(await readCentralReply(res));
    last = { at: Date.now(), hosts: hosts.length, vms: vms.length, ...(drop ? { centralDropped: drop } : {}) };
    console.log(`[gpu-guest-push] sent → ${config.agent.centralUrl} hosts=${hosts.length} vms=${vms.length}`);
    warnDrop('gpu-guest-push', drop);
    return { ok: true, hosts: hosts.length, vms: vms.length, ...(drop ? { centralDropped: drop } : {}) };
  } catch (e) {
    last = { at: Date.now(), hosts: 0, vms: 0, error: e.message };
    console.warn(`[gpu-guest-push] 실패: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export function gpuGuestPushStatus() {
  return { enabled: !!(config.agent.centralUrl && config.agent.centralToken), centralUrl: config.agent.centralUrl, last };
}

export function startGpuGuestPush() {
  if (!config.agent.centralUrl || !config.agent.centralToken) return;
  // 게스트 수집(첫 폴)이 끝난 뒤 보내도록 35초 지연 후 시작, 이후 주기 반복.
  const intervalMs = Math.max(30_000, config.agent.inventoryIntervalMs || 60_000);
  setTimeout(() => pushGpuGuestNow().catch((e) => console.error('[gpu-guest-push] 실패:', e.message)), 35_000).unref?.();
  timer = setInterval(() => pushGpuGuestNow().catch(() => {}), intervalMs);
  timer.unref?.();
  console.log(`[gpu-guest-push] started → ${config.agent.centralUrl} every ${Math.round(intervalMs / 1000)}s`);
}
