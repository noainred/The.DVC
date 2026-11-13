/**
 * agent/bmOnboardPull.js — 중앙 → 엣지 **서버 등록 배포**(7b단계 — 수집 경로 ‘edge’ 로 등록한 서버).
 *
 * 규약(bmUsageConfigPull 과 같은 꼴):
 *  · 주기 인출(기본 10분) · 실패는 로그 1줄 후 다음 주기(자동 재시도 없음 — resilientFetch GET 재시도 1 만).
 *  · 중앙이 `distribute:false`(검증 안 된 이름 등)면 **아무것도 바꾸지 않는다**(지난 적용을 지우지 않는다 — 회선 장애 한 번이 등록을 지우지 않게).
 *  · 404(구버전 중앙)도 바꾸지 않는다. 본문 상한 8MB(5,000행) · 모양 검사 후 `edgeApply.applyEdgeDeployment` 가 같은 분석을 다시 거친다.
 *  · 결과(적용 · 거부 · 지운 수)와 적용한 서명은 **다음 인출의 쿼리**로 중앙에 알린다(숫자 · 서명만 — 이름 · 사유 원문은 이 엣지에만).
 *  · 0건이어도 상태를 남긴다(`_last` · 콘솔 · edgelog/spec.js 등재 — 무음 실패 금지).
 */
import { config, clampIntervalMs, currentVersion } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { agentHeaders } from './agentNameCarry.js';
import { store } from '../store.js';
const _logOnce = createChangeLogger({ windowMs: 10 * 60_000 });

const PULL_MS = clampIntervalMs(Number(process.env.AGENT_BM_ONBOARD_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000);
const BODY_MAX = 8 * 1024 * 1024;
let timer = null; let running = false; let last = null;

function configured() { return !!(config.agent.centralUrl && config.agent.centralToken); }
export function bmOnboardPullStatus() {
  if (!configured()) return { configured: false, intervalMs: PULL_MS, last: { at: 0, ok: false, skipped: true, kind: 'not-configured', note: 'CENTRAL_URL/CENTRAL_TOKEN 없음 — 서버 등록 배포를 받지 않습니다(중앙 자신이면 정상)' } };
  return { configured: true, intervalMs: PULL_MS, last };
}

/** 본문 모양(순수) — 배포 판정 필드가 있어야 한다(봉투 기본 판정 { ok, node } 와 다르다). */
export function onboardBodyOk(b) {
  return !!b && typeof b === 'object' && b.ok === true && typeof b.distribute === 'boolean' && (!b.distribute || (Array.isArray(b.rows) && typeof b.sig === 'string' && /^[0-9a-f]{32}$/.test(b.sig)));
}

export async function pullBmOnboardNow({ fetchImpl = resilientFetch, apply = null } = {}) {
  if (running) return { ok: false, reason: 'pull 진행 중' };
  running = true;
  try {
    const EA = await import('../bmusage/onboard/edgeApply.js');
    const st = EA.readAppliedState().state;
    const r0 = st.result || {};
    const q = new URLSearchParams({ agent: config.agent.name, applied: st.sig || '', ok: String(Number(r0.applied) || 0), rej: String(Number(r0.rejected) || 0), rm: String(Number(r0.removed) || 0) });
    const res = await fetchImpl(`${config.agent.centralUrl}/api/central/bm-onboard?${q}`, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { ...agentHeaders(config.agent.name), 'X-Central-Token': config.agent.centralToken, 'X-Agent-Version': currentVersion() },
    });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: Date.now(), ok: false, kind: c.kind, note: `${c.reason} — 지난 등록은 그대로 둡니다` };
      if (_logOnce(c.kind, c.reason)) console.warn(`[bm-onboard-pull] ${c.reason}`);
      return last;
    }
    if (!res.ok) throw new Error(`bm-onboard -> ${res.status}`);
    const body = await readJsonCapped(res, BODY_MAX);
    if (!onboardBodyOk(body)) throw new Error('배포 본문 형식 오류');
    if (!body.distribute) {
      last = { at: Date.now(), ok: true, distribute: false, reason: String(body.reason || '').slice(0, 32), note: '중앙이 배포를 주지 않았습니다 — 지난 등록은 그대로 둡니다' };
      if (_logOnce('nodist', last.reason)) console.log(`[bm-onboard-pull] 배포 없음(${last.reason || '-'}) — 지난 등록 유지`);
      return last;
    }
    const snap = store.get();
    const corps = (snap?.vcenters || []).filter((v) => v && v.id).map((v) => ({ id: String(v.id), name: String(v.name || v.id) }));
    let myCorps = [];
    try { myCorps = Object.keys((await import('../bmusage/settings.js')).loadBmUsageSettings().corps || {}); } catch { myCorps = []; }
    // v2.954(점검 D-3): 중앙 제거 대기 이름(문자열만 · 상한) — 구 중앙은 없다(null — 적용 상태를 잃은 엣지는 서명을 보고하지 않는다)
    const pending = Array.isArray(body.pending) ? body.pending.filter((x) => typeof x === 'string').slice(0, 5000).map((x) => x.slice(0, 128)) : null;
    const r = await (apply || EA.applyEdgeDeployment)(body.rows, { sig: body.sig, corps, myCorps, pending });
    last = { at: Date.now(), ok: !!r.ok, rows: body.rows.length, sig: body.sig, skipped: !!r.skipped, applied: r.applied || 0, rejected: r.rejected || 0, removed: r.removed || 0, ...(r.reason ? { error: String(r.reason).slice(0, 300) } : {}) };
    if (!r.skipped || !r.ok) console.log(`[bm-onboard-pull] 배포 ${body.rows.length}행 — 적용 ${last.applied} · 거부 ${last.rejected} · 지움 ${last.removed}${r.ok ? '' : ` · 실패: ${last.error}`}`);
    return last;
  } catch (e) {
    last = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 300) };
    if (_logOnce('fail', last.error)) console.warn(`[bm-onboard-pull] 실패(지난 등록 유지): ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startBmOnboardPull() {
  if (timer) return;
  if (!configured()) { last = bmOnboardPullStatus().last; console.log('[bm-onboard-pull] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음(중앙 자신이면 정상)'); return; }
  setTimeout(() => pullBmOnboardNow().catch(() => {}), 75_000).unref?.();
  timer = setInterval(() => { if (!running) pullBmOnboardNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[bm-onboard-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
