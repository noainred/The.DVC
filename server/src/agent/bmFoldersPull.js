/**
 * agent/bmFoldersPull.js — 중앙 → 엣지 **물리서버 폴더 사본**(v2.996 · 설계 docs/design/bm-folders §11 — 묶음 D · 그 엣지 법인 것만).
 *
 * 규약(bmMaintPull · bmUsageConfigPull 과 같은 꼴):
 *  · 주기 인출(기본 10분 — 결정 3) + 화면 '지금 받기'. 실패는 로그 1줄 후 다음 주기(자동 재시도 없음 — resilientFetch GET 재시도 1 만).
 *  · 중앙이 `distribute:false`(개별 토큰이 아님) · 404(구버전 중앙) · 503(중앙 저장소 손상) · 네트워크 실패면 **지난 사본을 그대로 둔다**(지우지 않고 나이를 보인다 — 결정 4).
 *  · 받은 묶음은 엣지가 같은 규칙으로 다시 자른다(edgeCopy.sanitizeBundle) · 가진 판(세대)을 다음 인출의 쿼리로 중앙에 알린다(중앙 '엣지 전달').
 *  · 0건이어도 상태를 남긴다(`_last` · 콘솔 · edgelog/spec.js 등재 — 무음 실패 금지).
 */
import { config, clampIntervalMs, currentVersion } from '../config.js';
import { classifyCentral404 } from './central404.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped } from '../util/readCapped.js';
import { agentHeaders } from './agentNameCarry.js';
const _logOnce = createChangeLogger({ windowMs: 10 * 60_000 });

export const PULL_MS = clampIntervalMs(Number(process.env.AGENT_BM_FOLDERS_PULL_MS) || 10 * 60_000, 10 * 60_000, 60_000);
const BODY_MAX = 8 * 1024 * 1024;
let timer = null; let running = false; let last = null;

function configured() { return !!(config.agent.centralUrl && config.agent.centralToken); }
export function bmFoldersPullStatus() {
  if (!configured()) return { configured: false, intervalMs: PULL_MS, last: { at: 0, ok: false, skipped: true, kind: 'not-configured', note: 'CENTRAL_URL/CENTRAL_TOKEN 없음 — 물리서버 폴더 사본을 받지 않습니다(중앙 자신이면 정상)' } };
  return { configured: true, intervalMs: PULL_MS, last, running };
}

/** 본문 모양(순수). */
export function foldersBodyOk(b) {
  return !!b && typeof b === 'object' && b.ok === true && typeof b.distribute === 'boolean' && (!b.distribute || (!!b.bundle && typeof b.bundle === 'object'));
}

export async function pullBmFoldersNow({ fetchImpl = resilientFetch, now = Date.now, copy = null } = {}) {
  if (!configured()) return bmFoldersPullStatus().last;
  if (running) return { ok: false, reason: '받는 중입니다' };
  running = true;
  try {
    const C = copy || await import('../bmfolders/edgeCopy.js');
    const cur = C.loadCopy();
    const q = new URLSearchParams({ agent: config.agent.name, have: cur.copy?.rev || '' });
    const res = await fetchImpl(`${config.agent.centralUrl}/api/central/bm-folders?${q}`, {
      method: 'GET', timeoutMs: 30_000, retries: 1,
      headers: { ...agentHeaders(config.agent.name), 'X-Central-Token': config.agent.centralToken, 'X-Agent-Version': currentVersion() },
    });
    if (res.status === 404) {
      const c = await classifyCentral404(res);
      last = { at: now(), ok: false, kind: c.kind, note: `${c.reason} — 지난 사본은 그대로 둡니다` };
      if (_logOnce(c.kind, c.reason)) console.warn(`[bm-folders-pull] ${c.reason}`);
      return last;
    }
    if (!res.ok) throw new Error(`bm-folders -> ${res.status}`);
    const body = await readJsonCapped(res, BODY_MAX);
    if (!foldersBodyOk(body)) throw new Error('본문 형식 오류');
    if (!body.distribute) {
      last = { at: now(), ok: true, distribute: false, reason: String(body.reason || '').slice(0, 32), note: '중앙이 사본을 주지 않았습니다(개별 토큰이 아님) — 지난 사본 유지' };
      if (_logOnce('nodist', last.reason)) console.log(`[bm-folders-pull] 사본 없음(${last.reason || '-'}) — 지난 사본 유지`);
      return last;
    }
    const r = C.saveCopy(body.bundle, { now: now() });
    if (!r.ok) throw new Error(r.reason || '사본 저장 실패');
    last = { at: now(), ok: true, corps: r.corps, place: r.place, dropped: r.dropped, rev: String(body.bundle.rev || '').slice(0, 64) };
    if (r.dropped || _logOnce('ok', `${r.corps}|${r.place}`)) console.log(`[bm-folders-pull] 사본 받음 — 법인 ${r.corps} · 배치 ${r.place}${r.dropped ? ` · 형식 밖 ${r.dropped}개 버림` : ''}`);
    return last;
  } catch (e) {
    last = { at: now(), ok: false, error: String(e?.message || e).slice(0, 300) };
    if (_logOnce('fail', last.error)) console.warn(`[bm-folders-pull] 실패(지난 사본 유지): ${last.error}`);
    return last;
  } finally { running = false; }
}

export function startBmFoldersPull() {
  if (timer) return;
  if (!configured()) { last = bmFoldersPullStatus().last; console.log('[bm-folders-pull] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음(중앙 자신이면 정상)'); return; }
  setTimeout(() => pullBmFoldersNow().catch(() => {}), 95_000).unref?.();
  timer = setInterval(() => { if (!running) pullBmFoldersNow().catch(() => {}); }, PULL_MS);
  timer.unref?.();
  console.log(`[bm-folders-pull] started — ${Math.round(PULL_MS / 60_000)}분 주기`);
}
export function _resetBmFoldersPullForTest() { last = null; running = false; }
