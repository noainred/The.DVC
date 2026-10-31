/**
 * bareos/liveStatus.js — 진행 현황판(v2.833 · 사용자 요청 '진행 중인 백업 현황판 — 전체 법인 · 단일 법인 · 백업 속도 상태' · 결정 'Director 상태 조회').
 *
 * 실행 중 잡의 진행량·속도는 FD 가 들고 있어(카탈로그는 끝나야 바이트를 채운다) Director 의 `status client=` 로 묻는다(ops.liveStatus · liveParse).
 * 되돌리면 안 되는 규칙(시험 bareosLive2833):
 *  ① **화면이 열려 있을 때만** 묻는다 — 라우트가 touchLive() 를 부르고, LIVE_IDLE_MS 동안 아무도 보지 않으면 멈춘다(평소 Director 부하 0).
 *  ② 실행 중인 잡이 있는 Director 만 · Director 들은 병렬(LIVE_CONCURRENCY) + **Director 마다 시한**(signal — 세션을 끊는다) · 틱 재진입 가드.
 *     느린(RTT 800ms) 법인 하나가 나머지를 막지 않는다. 엣지 대행 Director 는 앞 요청이 아직 대기열에 있으면 새로 넣지 않는다(쌓지 않는다).
 *  ③ 주기 조회(trigger 'timer') — 인증 정지된 Director 에는 보내지 않는다(service.withDirector). 데모 잡은 데모 Director 일 때만.
 *  ④ 못 읽은 값은 null(0 이 아니다): 조회 실패·아직 묻지 않음·FD 가 그 잡을 모름 → 속도 '모름'. 합계는 아는 값만 더하고 모르는 법인 수를 따로 센다.
 *  ⑤ 메모리만(파일에 쓰지 않는다 — 폴링마다 쓰기 금지) · 흐름은 법인(vCenter)마다 HIST_KEEP 점(Director 하나가 법인 여럿이어도 겹쳐 세지 않게).
 */
import { jobDigests } from './registry.js';
import { onDirector, isDemoActive, effectiveSettings } from './service.js';
import { jobDirectorId, directorById } from './settings.js';
import { hasPending } from './edgeOps.js';
import { isFinalStatus } from './names.js';
import { rateNowOf } from './liveParse.js';
import { LIVE_CLIENTS_MAX } from './ops.js';
import { poolSettled } from '../util/pool.js';

export const LIVE_MS = 30_000;
export const LIVE_IDLE_MS = 120_000;
export const LIVE_DEADLINE_MS = 25_000;
export const LIVE_CONCURRENCY = 8;
export const HIST_KEEP = 60;

let _touchedAt = 0;
let _timer = null;
let _busy = false;
/** Director id → { at, ok, code, clients: { client → { ok, code } }, jobs: Map<jobid, row> } */
const _live = new Map();
/** 법인(vCenter id) → [{ at, rate|null, jobs }] — Director 하나가 법인 여럿을 맡아도 법인마다 따로(합계가 겹쳐 세지지 않게 · Chromium 확인) */
const _hist = new Map();

/** 이 잡이 지금 도는가(포탈이 시작한 실행 pending · Director 스케줄이 돌린 실행은 lastRun 이 끝나지 않은 상태). */
export function runningRunOf(j) {
  if (j?.pending?.jobid) return { jobid: j.pending.jobid, state: j.pending.state || 'queued', level: j.pending.level || '', since: j.pending.since || null, trigger: j.pending.trigger || '', by: j.pending.by || '' };
  const L = j?.lastRun;
  if (L?.jobid && L.status && !isFinalStatus(L.status) && ['running', 'queued', 'waiting'].includes(L.state)) {
    return { jobid: L.jobid, state: L.state, level: L.level || '', since: L.startedAt ?? null, trigger: 'schedule', by: '' };
  }
  return null;
}

/** Director 마다 실행 중 잡과 물을 FD 목록(설정의 법인 FD + 잡의 FD). 데모 잡은 데모 Director 일 때만(③). */
export function liveTargets(jobs, settings, demo) {
  const by = new Map();
  for (const j of jobs) {
    if (!!j.demo !== demo) continue;
    const run = runningRunOf(j);
    if (!run) continue;
    const dir = jobDirectorId(j, settings);
    if (!by.has(dir)) by.set(dir, { directorId: dir, clients: new Set(), jobs: [] });
    const t = by.get(dir);
    t.jobs.push({ job: j, run });
    const site = (settings.sites || []).find((s) => s.vcenterId === j.vcenterId);
    for (const c of [j.client, site?.client]) if (c) t.clients.add(String(c));
  }
  return [...by.values()].map((t) => ({ ...t, clients: [...t.clients].slice(0, LIVE_CLIENTS_MAX) }));
}

const byVc = (jobs) => { const m = new Map(); for (const x of jobs) { const k = x.job.vcenterId; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
function pushHist(key, point) {
  const h = _hist.get(key) || [];
  h.push(point);
  while (h.length > HIST_KEEP) h.shift();
  _hist.set(key, h);
}

/**
 * 한 번 묻기(틱). 던지지 않는다. @returns {Promise<{ asked: string[], skipped: string[] }>}
 * @param {{ now?: number, deadlineMs?: number }} [o]
 */
export async function liveTick({ now = Date.now(), deadlineMs = LIVE_DEADLINE_MS } = {}) {
  if (_busy) return { asked: [], skipped: [], busy: true };
  _busy = true;
  const asked = []; const skipped = [];
  try {
    const settings = effectiveSettings();
    const demo = isDemoActive();
    const targets = liveTargets(jobDigests(), settings, demo);
    // 실행 중 잡이 없어진 Director 는 진행 표시를 지우고, 실행이 끝난 법인은 흐름에 '0 개' 점을 남긴다(멈춘 값을 계속 보이지 않게)
    for (const dir of [..._live.keys()]) if (!targets.some((t) => t.directorId === dir)) _live.delete(dir);
    const activeVc = new Set(targets.flatMap((t) => t.jobs.map((x) => x.job.vcenterId)));
    for (const [vc, h] of _hist) if (!activeVc.has(vc) && h.length && h[h.length - 1].jobs > 0) pushHist(vc, { at: now, rate: 0, jobs: 0 });
    await poolSettled(targets, LIVE_CONCURRENCY, async (t) => {
      const d = directorById(t.directorId, settings);
      if (!demo && d?.agent && hasPending(t.directorId, 'liveStatus')) { skipped.push(t.directorId); return; }   // ② 엣지 대기열에 쌓지 않는다
      if (!t.clients.length) { _live.set(t.directorId, { at: now, ok: false, code: 'no-client', clients: {}, jobs: new Map() }); return; }
      asked.push(t.directorId);
      let res;
      try {
        res = await onDirector(t.directorId, 'liveStatus', { clients: t.clients }, { trigger: 'timer', signal: AbortSignal.timeout(deadlineMs) });
      } catch (e) {
        const prev = _live.get(t.directorId);
        _live.set(t.directorId, { at: now, ok: false, code: e?.code || 'error', clients: prev?.clients || {}, jobs: new Map() });
        for (const [vc, list] of byVc(t.jobs)) pushHist(vc, { at: now, rate: null, jobs: list.length });
        return;
      }
      const jobs = new Map();
      const clients = {};
      for (const c of res?.clients || []) {
        clients[c.client] = c.ok ? { ok: true } : { ok: false, code: c.code || 'error' };
        for (const x of c.jobs || []) if (x?.jobid) jobs.set(x.jobid, x);
      }
      const anyOk = Object.values(clients).some((c) => c.ok);
      _live.set(t.directorId, { at: Date.now(), ok: anyOk, code: anyOk ? '' : (Object.values(clients)[0]?.code || 'error'), clients, jobs });
      // 흐름 점(법인마다): 그 법인의 실행 중 잡 중 FD 가 아는 잡의 지금 속도 합(모르는 잡만 있으면 null — 0 이 아니다)
      for (const [vc, list] of byVc(t.jobs)) {
        let rate = 0; let known = 0;
        for (const { run } of list) { const r = rateNowOf(jobs.get(run.jobid)); if (r !== null) { rate += r; known += 1; } }
        pushHist(vc, { at: now, rate: anyOk && known ? rate : null, jobs: list.length });
      }
    });
  } catch (e) {
    console.warn(`[bareos] 진행 현황 조회 오류: ${String(e?.message || e).slice(0, 200)}`);
  } finally { _busy = false; }
  return { asked, skipped };
}

/** 화면이 열렸다(라우트) — 멈춰 있으면 바로 한 번 묻고 주기 타이머를 켠다(①). 중앙 포탈에서만(엣지는 원장이 없다). */
export function touchLive(now = Date.now()) {
  _touchedAt = now;
  if (_timer) return;
  liveTick().catch(() => {});
  _timer = setInterval(() => {
    if (Date.now() - _touchedAt > LIVE_IDLE_MS) { clearInterval(_timer); _timer = null; return; }
    liveTick().catch(() => {});
  }, LIVE_MS);
  _timer.unref?.();
}
export const liveActive = () => !!_timer;

/** 화면용 사본 — Director 의 마지막 조회(jobs: Map) · 그 법인(vCenter)의 흐름. */
export function liveSnapshot(dir, vcenterId = '') {
  const l = _live.get(dir);
  return { live: l ? { at: l.at, ok: l.ok, code: l.code, jobs: l.jobs } : null, hist: (_hist.get(vcenterId) || []).map((p) => ({ ...p })) };
}

export const _liveBusyForTest = () => _busy;
export function _resetLiveForTest() { if (_timer) { clearInterval(_timer); _timer = null; } _touchedAt = 0; _busy = false; _live.clear(); _hist.clear(); }
