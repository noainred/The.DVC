/**
 * agent/vmSeriesConfigPull.js — 중앙 → 엣지 실시간 스파이크 수집 설정 배포(v2.510).
 *
 * 사용자 요구: "설정에서 모든 vCenter / 특정 vCenter 를 선택" — 그 설정은 중앙 포탈에서 한다. 위임
 * vCenter 는 엣지가 수집하므로 중앙의 설정(on/off·주기·임계·보존·범위)이 엣지에 내려가야 한다.
 * 스토리지/PDU 설정 pull 과 같은 단방향 아웃바운드(엣지가 주기적으로 GET).
 *
 * 규약
 *  - 중앙이 돌려주는 것은 **이 엣지가 수집하는 vCenter 에 해당하는 targets 만**(다른 법인 id 비노출).
 *  - `VMSERIES_LOCAL_SETTINGS=true` 인 엣지는 중앙 설정을 받지 않는다(현장이 자기 설정을 고정하는 opt-out).
 *  - 받은 값과 로컬 유효 설정이 같으면 저장하지 않는다(불필요한 파일 쓰기·타이머 재무장 방지).
 *  - 실패는 조용히 다음 주기(로그 1줄) — 설정이 안 내려와도 로컬 설정으로 계속 수집한다.
 */
import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { loadVmSeriesSettings, saveVmSeriesSettings } from '../vmseries/settings.js';

const PULL_MS = Number(process.env.AGENT_VMSERIES_CONFIG_PULL_MS) || 10 * 60_000;
let timer = null; let running = false; let last = null;

export function vmSeriesConfigPullStatus() { return { enabled: enabled(), intervalMs: PULL_MS, last }; }

function enabled() {
  return !!(config.agent.centralUrl && config.agent.pushVmSeries) && process.env.VMSERIES_LOCAL_SETTINGS !== 'true';
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function pullVmSeriesConfigNow() {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const url = `${config.agent.centralUrl}/api/central/vmseries-config?agent=${encodeURIComponent(config.agent.name)}`;
    const res = await resilientFetch(url, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { 'X-Agent-Name': config.agent.name, ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) },
    });
    if (res.status === 404) { last = { at: Date.now(), ok: true, applied: false, note: '중앙에 설정 없음(구버전 중앙)' }; return last; }
    if (!res.ok) throw new Error(`vmseries-config -> ${res.status}`);
    const body = await res.json();
    const s = body?.settings;
    if (!s || typeof s !== 'object') throw new Error('설정 본문 없음');
    const cur = loadVmSeriesSettings();
    const next = { enabled: s.enabled, intervalMin: s.intervalMin, retentionDays: s.retentionDays, thresholds: s.thresholds, scope: s.scope, targets: s.targets || {} };
    const curCmp = { enabled: cur.enabled, intervalMin: cur.intervalMin, retentionDays: cur.retentionDays, thresholds: cur.thresholds, scope: cur.scope, targets: cur.targets };
    let applied = false;
    if (!same(curCmp, next)) { saveVmSeriesSettings(next); applied = true; console.log(`[vmseries-pull] 중앙 설정 적용 — enabled=${next.enabled} 주기 ${next.intervalMin}분 범위 ${next.scope}`); }
    last = { at: Date.now(), ok: true, applied };
    return last;
  } catch (e) {
    last = { at: Date.now(), ok: false, error: e?.message || String(e) };
    console.warn(`[vmseries-pull] 실패: ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startVmSeriesConfigPull() {
  if (!enabled() || timer) return;
  setTimeout(() => pullVmSeriesConfigNow().catch(() => {}), 45_000).unref?.();
  timer = setInterval(() => { if (!running) pullVmSeriesConfigNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[vmseries-pull] started → ${config.agent.centralUrl} every ${Math.round(PULL_MS / 60_000)}m`);
}
