/**
 * agent/curUserConfigPull.js — 중앙 → 엣지 '현재 사용자' 설정 배포(v2.520).
 *
 * 폴더 범위·주기·보존은 중앙 포탈에서 관리자가 정한다. 위임 법인은 엣지가 수집하므로 그 설정이
 * 엣지에 내려가야 한다(vmseries·스토리지 설정 pull 과 같은 단방향 아웃바운드 GET).
 *
 * 규약
 *  · 중앙은 **이 엣지가 소유한 vCenter 항목만** 내려준다(다른 법인 id 비노출).
 *  · `CURUSER_LOCAL=1` 엣지는 받지 않는다(`curuser/settings.js applyCentral` 이 집행).
 *  · **전 키를 채워 보내지 않는다** — 중앙이 지정한 키만 병합한다(현장 portal.env 설정을
 *    통째로 덮어쓰는 사고를 막는 storage/intervals.js v2.409 규약과 같은 방향).
 *  · 실패는 조용히 다음 주기(로그 1줄) — 설정이 안 내려와도 로컬 설정으로 계속 수집한다.
 */
import { config, clampIntervalMs } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { applyCentral } from '../curuser/settings.js';
import { curUserPushEnabled } from './curUserPush.js';
const _log404 = createChangeLogger({ windowMs: 10 * 60_000 }); // v2.600 EDGE2600-06: 같은 404 사유는 10분에 한 줄

const PULL_MS = clampIntervalMs(Number(process.env.AGENT_CURUSER_CONFIG_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000); // v2.600 EDGE2600-05
let timer = null; let running = false; let last = null;

export function curUserConfigPullStatus() { return { enabled: enabled(), intervalMs: PULL_MS, last }; }
function enabled() { return curUserPushEnabled() && String(process.env.CURUSER_LOCAL || '') !== '1'; }

export async function pullCurUserConfigNow() {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const url = `${config.agent.centralUrl}/api/central/curuser-config?agent=${encodeURIComponent(config.agent.name)}`;
    const res = await resilientFetch(url, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { 'X-Agent-Name': config.agent.name, ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) },
    });
    // v2.600 EDGE2600-06: 404 본문을 읽어 '중앙이 central 을 끔'(ok:false — 설정을 못 받는다)과 '엔드포인트 없음'을 가른다.
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: Date.now(), ok: c.kind === 'no-endpoint', applied: false, kind: c.kind, note: c.reason };
      if (_log404(c.kind, c.reason)) console.warn(`[curuser-pull] ${c.reason}`);
      return last;
    }
    if (!res.ok) throw new Error(`curuser-config -> ${res.status}`);
    const body = await res.json();
    const s = body?.settings;
    if (!s || typeof s !== 'object') throw new Error('설정 본문 없음');
    const applied = applyCentral(s);
    if (applied) console.log(`[curuser-pull] 중앙 설정 적용 — enabled=${s.enabled} 주기 ${Math.round((s.intervalMs || 0) / 60_000)}분 · 법인 ${Object.keys(s.vcenters || {}).length}곳`);
    last = { at: Date.now(), ok: true, applied };
    return last;
  } catch (e) {
    last = { at: Date.now(), ok: false, error: e?.message || String(e) };
    console.warn(`[curuser-pull] 실패: ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startCurUserConfigPull() {
  if (!enabled() || timer) return;
  setTimeout(() => pullCurUserConfigNow().catch(() => {}), 50_000).unref?.();
  timer = setInterval(() => { if (!running) pullCurUserConfigNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[curuser-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
