// Bareos 진행 현황판 라우트(v2.833 · 사용자 요청 '진행 중인 백업 현황판 — 전체 법인 · 단일 법인 · 백업 속도 상태').
// 도구 키 bareos-backup(관리자 전용 — 이 화면이 열려 있는 동안 포탈이 Director 에 상태를 묻는다 · 조회 전용 v2.828 화면은 Director 에 닿지 않는 규칙이라 그쪽에 두지 않았다).
// 범위: 법인(vCenter) 조회 범위만(bareosAccess read — 범위 밖 법인은 목록에 없다). 데모 계정은 데모 Director 일 때만 상태 조회를 깨운다.
// 응답에 Director 주소·콘솔 이름·오류 원문 없음(오류는 코드만 — 화면이 문구로 바꾼다).
import { requireRole } from '../../auth/auth.js';
import { isDemoGuest, isAdminDetailUser } from '../../auth/demoGuest.js';
import { scopedVcenterIds, writeScopedVcenterIds } from '../../auth/scope.js';
import { store } from '../../store.js';
import { bareosAccess } from './bareosBackup.js';
import { effectiveSettings, isDemoActive } from '../../bareos/service.js';
import { directorById, directorConn } from '../../bareos/settings.js';
import { jobDigests, registryLoadError } from '../../bareos/registry.js';
import { listGroups } from '../../bareos/groups.js';
import { touchLive, liveSnapshot, runningRunOf, LIVE_MS, LIVE_IDLE_MS } from '../../bareos/liveStatus.js';
import { cancelInfo, CANCEL_WAIT_MS } from '../../bareos/cancelState.js';
import { cancelPlan, groupCanceling } from '../../bareos/groupRunner.js';
import { nextSlot } from '../../bareos/groupSchedule.js';
import { rateNowOf } from '../../bareos/liveParse.js';
import { isFinalStatus } from '../../bareos/names.js';
import { numOrNull } from '../../util/numOrNull.js';
import { memoJson, scopeKey } from './shared.js';
import { relayLimits } from '../../bareos/edgeOps.js';

const adminOnly = requireRole('admin');
/** 느림 판정 — 지난 성공 평균의 이 비율 이하 · 시작하고 이만큼 지난 뒤(막 시작한 잡은 스냅샷 준비로 느리다). */
export const SLOW_RATIO = 0.5;
export const SLOW_AFTER_MS = 5 * 60_000;
/** v2.833.1 멈춤 의심 — 이만큼 넘게 돌았는데 FD 가 진행을 보고하지 않거나(조회는 됐다) 속도가 0. */
export const STUCK_AFTER_MS = 3 * 3_600_000;
/** Director 가 '아직 시작하지 않았다' 고 보는 사유 — 원장이 실행 중이어도 대기로 센다. */
const NOT_STARTED = new Set(['maxjobs', 'created', 'priority', 'starttime']);
const DAY = 86_400_000;
const startOfToday = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
/** 끝난 성공(T·W) 실행 한 줄의 평균 속도(바이트 ÷ 소요) — 값을 다 읽었을 때만(못 읽은 값으로 지어내지 않는다). */
export function rateOfRun(r) {
  if (!r || !(r.status === 'T' || r.status === 'W')) return null;
  const b = numOrNull(r.bytes); const s0 = numOrNull(r.startedAt); const e0 = numOrNull(r.endedAt);
  if (b === null || b <= 0 || s0 === null || e0 === null || e0 <= s0) return null;
  return Math.round(b / ((e0 - s0) / 1000));
}
/**
 * 지난 성공 평균(느림 기준) — 원장 lastRate(v2.833 부터 쌓임), 없으면 원장에 이미 있는 마지막 끝난 실행(lastRun)으로 바로 계산(v2.833.1 —
 * 실제 화면에서 오늘 성공 37건이어도 '끝난 성공 기록 없음' 이었다). @returns {{ bps: number, at: number|null }|null}
 */
export function lastGoodRate(j) {
  const a = numOrNull(j?.lastRate?.bps);
  if (a !== null && a > 0) return { bps: a, at: numOrNull(j.lastRate.at) };
  const L = j?.lastRun;
  const b = isFinalStatus(L?.status) ? rateOfRun(L) : null;
  return b !== null ? { bps: b, at: numOrNull(L.endedAt) } : null;
}

/** 레벨 글자(F·I·D·V) — 'Full'·'F'·'Incremental' 을 한 모양으로. 모르면 ''. */
export const levelKey = (v) => { const c = String(v ?? '').trim().charAt(0).toUpperCase(); return 'FIDV'.includes(c) && c ? c : ''; };
/**
 * v2.858 지난 같은 레벨의 끝난 성공(T·W) 실행 — 진행 현황 상세의 추정 진척 기준(사용자 승인 시안 'Incremental 은 지난 같은 레벨 기준').
 * 원장 lastRun · finishedRuns(v2.858 부터 바이트를 남긴다)에서 지금 실행이 아닌 것 중 jobid 가 가장 큰 것. 바이트를 모르면 null(지어내지 않는다).
 * @returns {{ jobid:number, level:string, status:string, bytes:number, startedAt:number|null, endedAt:number|null }|null}
 */
export function prevSameLevel(j, level, nowJobid = null) {
  const lv = levelKey(level);
  if (!lv) return null;
  let best = null;
  for (const r of [j?.lastRun, ...(Array.isArray(j?.recentRuns) ? j.recentRuns : [])]) {
    if (!r?.jobid || r.jobid === nowJobid || !(r.status === 'T' || r.status === 'W') || levelKey(r.level) !== lv) continue;
    const b = numOrNull(r.bytes);
    if (b === null || b <= 0) continue;
    if (!best || r.jobid > best.jobid) best = { jobid: r.jobid, level: lv, status: r.status, bytes: b, startedAt: numOrNull(r.startedAt), endedAt: numOrNull(r.endedAt) };
  }
  return best;
}

/**
 * 잡 하나의 진행 행(순수에 가까움 — 시험이 직접 부른다).
 * @param {object} j  jobDigests 한 줄 · @param {object} run0  liveStatus.runningRunOf · @param {object|null} live  FD 상태 행(모르면 null) · @param {boolean} liveOk FD 조회 성공
 * @param {{ dirRow?: object|null }} o  dirRow = Director 상태 행({ status, reason }) — 없으면 null
 */
export function runningRow(j, run0, live, liveOk, { now = Date.now(), vm = null, group = '', dirRow = null } = {}) {
  // 실행 중 판정: FD 가 보고하면 · Director 가 'is running' 이면 · 원장이 실행 중이고 Director 가 '아직 시작 전' 사유가 아니면
  const fdRuns = liveOk && !!live;
  const dirRuns = dirRow?.reason === 'running';
  const notStarted = !!dirRow && NOT_STARTED.has(dirRow.reason);
  const state = fdRuns || dirRuns || (run0.state === 'running' && !notStarted) ? 'running' : (run0.state === 'running' ? 'waiting' : run0.state);
  const run = { ...run0, state };
  const rateNow = liveOk ? rateNowOf(live) : null;
  const base = numOrNull(lastGoodRate(j)?.bps);
  const elapsed = Number.isFinite(run.since) ? Math.max(0, now - run.since) : null;
  const slow = rateNow !== null && base !== null && base > 0 && elapsed !== null && elapsed >= SLOW_AFTER_MS && state === 'running' && rateNow <= base * SLOW_RATIO;
  // 멈춤 의심: 오래 도는데 FD 조회는 됐고 그 잡의 진행 보고가 없거나 속도 0(조회 실패면 판정하지 않는다 — 모르는 것을 단정하지 않는다)
  const stuckWhy = state === 'running' && elapsed !== null && elapsed >= STUCK_AFTER_MS && liveOk
    ? (!live ? 'no-report' : rateNow === 0 ? 'zero' : '') : '';
  return {
    // v2.858 실행 중 상세: id(로그 라우트 열쇠) · 잡 구성(Client·Pool·Storage) · 지난 같은 레벨 실행(추정 진척 기준) — 관리자 전용 라우트(Director 주소·비밀 없음)
    id: j.id, client: j.client || '', pool: j.pool || '', storage: j.storage || '',
    prev: prevSameLevel(j, run.level || live?.level || '', run.jobid),
    vmId: j.vmId, vmName: j.vmName || vm?.name || j.vmId, folder: j.folder || vm?.folder || '', group,
    jobid: run.jobid, state, level: run.level || live?.level || '', since: run.since ?? null, elapsed, trigger: run.trigger, by: run.by,
    sizeGb: numOrNull(vm?.storageGB),
    bytes: liveOk && live ? live.bytes ?? null : null, files: liveOk && live ? live.files ?? null : null,
    rateNow, rateAvg: liveOk && live ? live.aveRate ?? null : null,
    baseline: base, ...(slow ? { slow: true } : {}), ...(stuckWhy ? { stuck: stuckWhy } : {}),
    dirStatus: dirRow ? { text: String(dirRow.status || '').slice(0, 200), reason: dirRow.reason || 'other' } : null,
    cancel: cancelInfo(j, now),   // v2.867 멈추는 중(취소를 보낸 실행) · 멈추지 않음(stuck)
  };
}

/** 대기 행들 → 사유별 묶음(건수 · 가장 오래 기다린 보낸 시각 · 원문 한 줄). Director 상태에 없으면 'unknown'. 많은 순. */
export function waitGroups(rows) {
  const g = new Map();
  for (const r of rows) {
    const k = r.dirStatus?.reason || 'unknown';
    const x = g.get(k) || { reason: k, n: 0, oldest: null, text: r.dirStatus?.text || '' };
    x.n += 1;
    if (Number.isFinite(r.since) && (x.oldest === null || r.since < x.oldest)) x.oldest = r.since;
    g.set(k, x);
  }
  return [...g.values()].sort((a, b) => b.n - a.n);
}

/** 법인(vCenter) 하나의 현황. diag = 진단 원문을 실을지(전체 범위 관리자만 — 라우트가 정한다). */
export function corpView(site, settings, digests, { now = Date.now(), vms = new Map(), groupOf = new Map(), vcName = '', diag = false, groups = [], writable = false } = {}) {
  const dir = directorById(site.directorId, settings);
  const demo = isDemoActive();
  const mine = digests.filter((j) => j.vcenterId === site.vcenterId && !!j.demo === demo);
  const { live, hist } = liveSnapshot(site.directorId, site.vcenterId);
  const liveOk = !!live?.ok;
  const dirOk = !!live?.dir?.ok;
  const t0 = startOfToday(now);
  const running = []; let ok = 0; let warn = 0; let fail = 0; let canceled = 0; let bytes = 0; let bytesUnknown = 0;
  const rates = [];
  for (const j of mine) {
    const run = runningRunOf(j);
    if (run) {
      running.push(runningRow(j, run, live?.jobs?.get(run.jobid) || null, liveOk, {
        now, vm: vms.get(j.vmId), group: groupOf.get(j.vmId) || '', dirRow: dirOk ? live.dir.jobs.get(run.jobid) || null : null,
      }));
    }
    // 오늘 끝난 실행 — 원장의 최근 끝난 실행 + lastRun(jobid 로 하나씩)
    const seen = new Set();
    for (const r of [j.lastRun, ...(j.recentRuns || [])]) {
      if (!r?.jobid || seen.has(r.jobid) || !isFinalStatus(r.status) || !(Number(r.endedAt) >= t0)) continue;
      seen.add(r.jobid);
      if (r.status === 'T') ok += 1; else if (r.status === 'W') warn += 1; else if (r.status === 'A') canceled += 1; else fail += 1;
    }
    const L = j.lastRun;
    if (L && isFinalStatus(L.status) && Number(L.endedAt) >= t0 && (L.status === 'T' || L.status === 'W')) { if (Number.isFinite(L.bytes)) bytes += L.bytes; else bytesUnknown += 1; }
    const gr = lastGoodRate(j);
    if (gr && Number(gr.at) >= now - DAY) rates.push(gr.bps);
  }
  running.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (b.rateNow ?? -1) - (a.rateNow ?? -1) || (a.since ?? 0) - (b.since ?? 0));
  const act = running.filter((r) => r.state === 'running');
  const wait = running.filter((r) => r.state !== 'running');
  const known = act.filter((r) => r.rateNow !== null);
  return {
    vcenterId: site.vcenterId, vcName: vcName || site.vcenterId, directorId: site.directorId,
    director: dir ? { name: dir.name, via: dir.agent ? 'edge' : 'central', ready: demo || !!directorConn(dir).conn } : null,
    jobs: mine.length,
    running: act.length, waiting: wait.length,
    // 지금 속도 합 — 실행 중 잡이 있고 그중 아는 값이 있을 때만(모두 모르면 null — 0 이 아니다)
    rateNow: act.length ? (known.length ? known.reduce((s, r) => s + r.rateNow, 0) : null) : 0,
    rateUnknown: act.length - known.length,
    slow: running.filter((r) => r.slow).length,
    stuck: running.filter((r) => r.stuck).length,
    waitGroups: waitGroups(wait),
    today: { ok, warn, fail, canceled, bytes, bytesUnknown },
    rateMedian: median(rates), rateSamples: rates.length,
    live: live ? { at: live.at, ok: live.ok, code: live.code || '', dirOk, dirCode: live.dir?.code || '' } : null,
    hist: hist.map((p) => [p.at, p.rate]),
    rows: running,
    // v2.867 회차 중단 — 이 법인 그룹 중 줄 대기 · 보내는 중 · 이번 회차가 Director 에서 도는 · 멈추는 중인 것(그룹 회차 띠)
    writable,
    stopping: running.filter((r) => r.cancel).length,
    groupRuns: (() => {
      const byVm = new Map(mine.map((j) => [j.vmId, j]));
      const out = [];
      for (const g of groups) {
        if (g.vcenterId !== site.vcenterId) continue;
        const plan = cancelPlan(g, byVm, now);
        const canceling = groupCanceling(g.id);
        if (!plan.phase && !plan.sent && !canceling) continue;
        const nx = nextSlot(g.schedule, now);   // 확인 창 '다음 회차 1회 건너뛰기'(그룹 탭과 같은 값)
        out.push({ id: g.id, name: g.name, total: g.vmIds.length, plan, canceling, next: nx ? { at: nx.at, key: nx.key, level: nx.level, ...(g.skipKey === nx.key ? { skip: true } : {}) } : null, lastFire: g.lastFire ? { at: g.lastFire.at, key: g.lastFire.key || '', trigger: g.lastFire.trigger, level: g.lastFire.level || '', started: g.lastFire.started || 0, canceled: g.lastFire.canceled || null } : null });
      }
      return out;
    })(),
    ...(diag && live ? {
      diag: {
        at: live.at,
        fd: Object.entries(live.clients || {}).map(([client, c]) => ({ client, ok: !!c.ok, code: c.code || '', n: c.n ?? null, raw: c.raw || '' })),
        dir: { ok: dirOk, code: live.dir?.code || '', n: live.dir?.jobs?.size ?? null, raw: live.dir?.raw || '' },
      },
    } : {}),
  };
}

/** v2.867 쓰기 범위 열쇠(법인별 writable 이 사람마다 다르다 — 캐시로 다른 계정의 값을 받지 않게). */
function writeKey(user, snap) {
  try { const w = writeScopedVcenterIds(user, snap); return w ? [...w].sort().join(',') : 'all'; } catch { return 'err'; }
}

export function registerBareosLive(api) {
  /** 진행 현황(전체 법인 — 화면이 법인 하나를 고르면 그 행만 쓴다). 부를 때마다 상태 조회를 깨운다(화면이 열린 동안만 · LIVE_IDLE_MS). */
  api.get('/tools/bareos-backup/live', adminOnly, (req, res) => {
    // 데모 계정은 사람이 등록한 Director 에 닿지 않는다 — 데모 Director 일 때만 깨운다(이 라우트는 Director 를 직접 부르지 않고 폴러를 깨운다)
    if (!isDemoGuest(req.user) || isDemoActive()) touchLive();
    const snap = store.get();
    // 진단 원문(FD·Director 상태 앞 4KB)은 전체 범위 관리자만 — VM 이름·파일 경로가 보일 수 있다(데모 계정은 isAdminDetailUser 가 거른다)
    const diag = !scopedVcenterIds(req.user, snap) && isAdminDetailUser(req.user);
    return memoJson(req, res, 'bareos-live', async () => {
      const settings = effectiveSettings();
      const now = Date.now();
      const sites = settings.sites.filter((s) => bareosAccess(req.user, s.vcenterId, { write: false }) === 0);
      const allow = new Set(sites.map((s) => s.vcenterId));
      const digests = jobDigests().filter((j) => allow.has(j.vcenterId));
      const vms = new Map((snap?.vms || []).filter((v) => allow.has(v.vcenterId)).map((v) => [v.id, v]));
      const groupOf = new Map();
      const groups = listGroups().filter((g) => allow.has(g.vcenterId));
      for (const g of groups) for (const id of g.vmIds) groupOf.set(id, g.name);
      const vcName = new Map((snap?.vcenters || []).map((v) => [v.id, v.name || v.id]));
      const corps = sites.map((s) => corpView(s, settings, digests, { now, vms, groupOf, vcName: vcName.get(s.vcenterId), diag, groups, writable: bareosAccess(req.user, s.vcenterId) === 0 }));
      const act = corps.filter((c) => c.running > 0);
      const knownRate = act.filter((c) => c.rateNow !== null);
      const sum = (k) => corps.reduce((a, c) => a + (c.today[k] || 0), 0);
      return {
        ok: true, now, liveMs: LIVE_MS, idleMs: LIVE_IDLE_MS, demo: isDemoActive(), registryLoadError: !!registryLoadError(),
        relayLimits: relayLimits(),   // v2.858 실행 중 상세가 로그를 읽을 때 엣지 대행 Director 의 화면 시한(숫자를 화면에 박지 않는다)
        cancelWaitMs: CANCEL_WAIT_MS,  // v2.867 '멈추지 않음' 기준(화면 문구 — 숫자를 박지 않는다)
        totals: {
          corps: corps.length, active: act.length, running: corps.reduce((a, c) => a + c.running, 0), waiting: corps.reduce((a, c) => a + c.waiting, 0),
          rateNow: act.length ? (knownRate.length ? knownRate.reduce((a, c) => a + c.rateNow, 0) : null) : 0, rateUnknownCorps: act.length - knownRate.length,
          slow: corps.reduce((a, c) => a + c.slow, 0), stuck: corps.reduce((a, c) => a + c.stuck, 0),
          today: { ok: sum('ok'), warn: sum('warn'), fail: sum('fail'), canceled: sum('canceled'), bytes: sum('bytes'), bytesUnknown: sum('bytesUnknown') },
        },
        corps,
      };
    }, { ttlMs: 5_000, extraKey: `${scopeKey(req.user, snap)}|w${writeKey(req.user, snap)}|d${isDemoActive() ? 1 : 0}|x${diag ? 1 : 0}` });   // x = 진단 원문 공개 여부(키에 없으면 캐시로 샌다) · w = 쓰기 범위(법인별 writable)
  });
}
