/**
 * agent/partFaultConfigPull.js — 중앙 → 엣지 '파트 장애' 스위치 배포(v2.548 F3).
 *
 * 기능 켜짐/꺼짐은 중앙 관리자가 정한다(엣지별로도). 위임 법인은 엣지가 판정·push 하므로 그 값이
 * 엣지에 내려가야 한다(curuser·vmseries·스토리지 설정 pull 과 같은 단방향 아웃바운드 GET).
 * 이 저장소의 `agent/*ConfigPull.js` 8개 중 파트 장애만 빠져 있었다(조사 F3).
 *
 * 규약: 실패는 조용히 다음 주기(로그 1줄) — 설정이 안 내려와도 로컬 스위치(env)로 계속 동작한다.
 * 404(구버전 중앙)면 '중앙에 설정 없음' 으로 남기고 로컬 값을 쓴다.
 */
import { config, clampIntervalMs } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyCentral } from '../partfault/settings.js';
const _log404 = createChangeLogger({ windowMs: 10 * 60_000 }); // v2.600 EDGE2600-06: 같은 404 사유는 10분에 한 줄

const PULL_MS = clampIntervalMs(Number(process.env.AGENT_PARTFAULT_CONFIG_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000); // v2.600 EDGE2600-05: 상한 추가
let timer = null; let running = false; let last = null;

export function partFaultConfigPullStatus() { return { configured: configured(), intervalMs: PULL_MS, last }; }
function configured() { return !!(config.agent.centralUrl && config.agent.centralToken); }

export async function pullPartFaultConfigNow() {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const url = `${config.agent.centralUrl}/api/central/partfault-config?agent=${encodeURIComponent(config.agent.name)}`;
    const res = await resilientFetch(url, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { 'X-Agent-Name': config.agent.name, 'X-Central-Token': config.agent.centralToken },
    });
    // v2.600 EDGE2600-06: 404 본문을 읽어 '중앙이 central 을 끔'(ok:false — 설정을 못 받는다)과 '엔드포인트 없음'을 가른다.
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: Date.now(), ok: c.kind === 'no-endpoint', applied: false, kind: c.kind, note: c.reason + ' — 로컬 스위치 사용' };
      if (_log404(c.kind, c.reason)) console.warn(`[partfault-pull] ${c.reason}`);
      return last;
    }
    if (!res.ok) throw new Error(`partfault-config -> ${res.status}`);
    const body = await res.json();
    const s = body?.settings;
    if (!s || typeof s !== 'object') throw new Error('설정 본문 없음');
    const applied = applyCentral(s);
    if (applied) console.log(`[partfault-pull] 중앙 설정 적용 — enabled=${s.enabled}`);
    last = { at: Date.now(), ok: true, applied, enabled: s.enabled };
    return last;
  } catch (e) {
    last = { at: Date.now(), ok: false, error: e?.message || String(e) };
    console.warn(`[partfault-pull] 실패: ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startPartFaultConfigPull() {
  if (timer) return;
  if (!configured()) { console.log('[partfault-pull] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음(중앙 자신이면 정상)'); return; }
  setTimeout(() => pullPartFaultConfigNow().catch(() => {}), 40_000).unref?.();
  timer = setInterval(() => { if (!running) pullPartFaultConfigNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[partfault-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
