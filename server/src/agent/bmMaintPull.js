/**
 * agent/bmMaintPull.js — 중앙 → 엣지 **정비 창 배포**(8a단계 — 그 엣지 법인의 진행 중 · 예정 창).
 *
 * 규약(bmOnboardPull · bmUsageConfigPull 과 같은 꼴):
 *  · 주기 인출(기본 10분) · 실패는 로그 1줄 후 다음 주기(자동 재시도 없음 — resilientFetch GET 재시도 1 만).
 *  · 중앙이 `distribute:false`(검증 안 된 이름) · 404(구버전 중앙) · 503(중앙 창 파일 손상) · 네트워크 실패면 **아무것도 바꾸지 않는다** —
 *    지난 배포본은 받은 지 24시간(store.DEPLOY_TTL_MS)까지만 판정에 들어간다(억제 시한 — 중앙이 지운 창이 끊긴 엣지에서 계속 억제하지 않게).
 *  · 받은 창은 `store.saveDeployed` 가 **같은 정규화(normalizeWindow)** 로 다시 자른다(엣지는 중앙 문자열을 그대로 믿지 않는다 · 형식 밖은 버리고 센다).
 *  · 적용한 서명은 **다음 인출의 쿼리**로 중앙에 알린다(숫자 · 서명만). 0건이어도 상태를 남긴다(`_last` · 콘솔 · edgelog/spec.js 등재 — 무음 실패 금지).
 */
import { config, clampIntervalMs, currentVersion } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { agentHeaders } from './agentNameCarry.js';
const _logOnce = createChangeLogger({ windowMs: 10 * 60_000 });

const PULL_MS = clampIntervalMs(Number(process.env.AGENT_BM_MAINT_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000);
const BODY_MAX = 4 * 1024 * 1024;
let timer = null; let running = false; let last = null;

function configured() { return !!(config.agent.centralUrl && config.agent.centralToken); }
export function bmMaintPullStatus() {
  if (!configured()) return { configured: false, intervalMs: PULL_MS, last: { at: 0, ok: false, skipped: true, kind: 'not-configured', note: 'CENTRAL_URL/CENTRAL_TOKEN 없음 — 정비 창 배포를 받지 않습니다(중앙 자신이면 정상)' } };
  return { configured: true, intervalMs: PULL_MS, last };
}

/** 본문 모양(순수) — 배포 판정 필드가 있어야 한다(봉투 기본 판정 { ok, node } 와 다르다). */
export function maintBodyOk(b) {
  return !!b && typeof b === 'object' && b.ok === true && typeof b.distribute === 'boolean'
    && (!b.distribute || (Array.isArray(b.windows) && typeof b.sig === 'string' && /^[0-9a-f]{32}$/.test(b.sig)));
}

export async function pullBmMaintNow({ fetchImpl = resilientFetch, now = Date.now } = {}) {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const ST = await import('../bmusage/maint/store.js');
    const dep = ST.loadDeployed();
    const q = new URLSearchParams({ agent: config.agent.name, applied: dep && !dep.unreadable ? dep.sig || '' : '' });
    const res = await fetchImpl(`${config.agent.centralUrl}/api/central/bm-maint?${q}`, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { ...agentHeaders(config.agent.name), 'X-Central-Token': config.agent.centralToken, 'X-Agent-Version': currentVersion() },
    });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: now(), ok: false, kind: c.kind, note: `${c.reason} — 지난 배포본은 그대로 둡니다(받은 지 24시간까지만 씁니다)` };
      if (_logOnce(c.kind, c.reason)) console.warn(`[bm-maint-pull] ${c.reason}`);
      return last;
    }
    if (!res.ok) throw new Error(`bm-maint -> ${res.status}`);
    const body = await readJsonCapped(res, BODY_MAX);
    if (!maintBodyOk(body)) throw new Error('배포 본문 형식 오류');
    if (!body.distribute) {
      last = { at: now(), ok: true, distribute: false, reason: String(body.reason || '').slice(0, 32), note: '중앙이 배포를 주지 않았습니다 — 지난 배포본은 받은 지 24시간까지만 씁니다' };
      if (_logOnce('nodist', last.reason)) console.log(`[bm-maint-pull] 배포 없음(${last.reason || '-'}) — 지난 배포본 유지(24시간 시한)`);
      return last;
    }
    const r = ST.saveDeployed(body.windows, { sig: body.sig, now: now() });
    last = { at: now(), ok: true, windows: body.windows.length, kept: r.n, dropped: r.dropped, sig: body.sig };
    if (r.dropped || _logOnce('ok', `${r.n}`)) console.log(`[bm-maint-pull] 정비 창 ${r.n}개 받음${r.dropped ? ` · 형식 밖 ${r.dropped}개 버림` : ''}`);
    return last;
  } catch (e) {
    last = { at: now(), ok: false, error: String(e?.message || e).slice(0, 300) };
    if (_logOnce('fail', last.error)) console.warn(`[bm-maint-pull] 실패(지난 배포본 유지 · 24시간 시한): ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startBmMaintPull() {
  if (timer) return;
  if (!configured()) { last = bmMaintPullStatus().last; console.log('[bm-maint-pull] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음(중앙 자신이면 정상)'); return; }
  setTimeout(() => pullBmMaintNow().catch(() => {}), 80_000).unref?.();
  timer = setInterval(() => { if (!running) pullBmMaintNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[bm-maint-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
