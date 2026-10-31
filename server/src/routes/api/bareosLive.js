// Bareos 진행 현황판 라우트(v2.833 · 사용자 요청 '진행 중인 백업 현황판 — 전체 법인 · 단일 법인 · 백업 속도 상태').
// 도구 키 bareos-backup(관리자 전용 — 이 화면이 열려 있는 동안 포탈이 Director 에 상태를 묻는다 · 조회 전용 v2.828 화면은 Director 에 닿지 않는 규칙이라 그쪽에 두지 않았다).
// 범위: 법인(vCenter) 조회 범위만(bareosAccess read — 범위 밖 법인은 목록에 없다). 데모 계정은 데모 Director 일 때만 상태 조회를 깨운다.
// 응답에 Director 주소·콘솔 이름·오류 원문 없음(오류는 코드만 — 화면이 문구로 바꾼다).
import { requireRole } from '../../auth/auth.js';
import { isDemoGuest } from '../../auth/demoGuest.js';
import { store } from '../../store.js';
import { bareosAccess } from './bareosBackup.js';
import { effectiveSettings, isDemoActive } from '../../bareos/service.js';
import { directorById, directorConn } from '../../bareos/settings.js';
import { jobDigests, registryLoadError } from '../../bareos/registry.js';
import { listGroups } from '../../bareos/groups.js';
import { touchLive, liveSnapshot, runningRunOf, LIVE_MS, LIVE_IDLE_MS } from '../../bareos/liveStatus.js';
import { rateNowOf } from '../../bareos/liveParse.js';
import { isFinalStatus } from '../../bareos/names.js';
import { numOrNull } from '../../util/numOrNull.js';
import { memoJson, scopeKey } from './shared.js';

const adminOnly = requireRole('admin');
/** 느림 판정 — 지난 성공 평균의 이 비율 이하 · 시작하고 이만큼 지난 뒤(막 시작한 잡은 스냅샷 준비로 느리다). */
export const SLOW_RATIO = 0.5;
export const SLOW_AFTER_MS = 5 * 60_000;
const DAY = 86_400_000;
const startOfToday = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

/**
 * 잡 하나의 진행 행(순수에 가까움 — 시험이 직접 부른다).
 * @param {object} j  jobDigests 한 줄 · @param {object} run  liveStatus.runningRunOf · @param {object|null} live  FD 상태 행(모르면 null) · @param {boolean} liveOk 그 Director 조회 성공
 */
export function runningRow(j, run0, live, liveOk, { now = Date.now(), vm = null, group = '' } = {}) {
  // FD 가 그 jobid 를 '실행 중' 으로 보고하면 실행 중이다 — 원장 상태는 주기 폴러(기본 60초)가 바꿔 그 사이 '대기' 로 보였다
  const run = liveOk && live && run0.state !== 'running' ? { ...run0, state: 'running' } : run0;
  const rateNow = liveOk ? rateNowOf(live) : null;
  const base = numOrNull(j.lastRate?.bps);
  const elapsed = Number.isFinite(run.since) ? Math.max(0, now - run.since) : null;
  const slow = rateNow !== null && base !== null && base > 0 && elapsed !== null && elapsed >= SLOW_AFTER_MS && run.state === 'running' && rateNow <= base * SLOW_RATIO;
  return {
    vmId: j.vmId, vmName: j.vmName || vm?.name || j.vmId, folder: j.folder || vm?.folder || '', group,
    jobid: run.jobid, state: run.state, level: run.level || live?.level || '', since: run.since ?? null, elapsed, trigger: run.trigger, by: run.by,
    sizeGb: numOrNull(vm?.storageGB),
    bytes: liveOk && live ? live.bytes ?? null : null, files: liveOk && live ? live.files ?? null : null,
    rateNow, rateAvg: liveOk && live ? live.aveRate ?? null : null,
    baseline: base, ...(slow ? { slow: true } : {}),
  };
}

/** 법인(vCenter) 하나의 현황. */
export function corpView(site, settings, digests, { now = Date.now(), vms = new Map(), groupOf = new Map(), vcName = '' } = {}) {
  const dir = directorById(site.directorId, settings);
  const demo = isDemoActive();
  const mine = digests.filter((j) => j.vcenterId === site.vcenterId && !!j.demo === demo);
  const { live, hist } = liveSnapshot(site.directorId, site.vcenterId);
  const liveOk = !!live?.ok;
  const t0 = startOfToday(now);
  const running = []; let ok = 0; let warn = 0; let fail = 0; let canceled = 0; let bytes = 0; let bytesUnknown = 0;
  const rates = [];
  for (const j of mine) {
    const run = runningRunOf(j);
    if (run) running.push(runningRow(j, run, live?.jobs?.get(run.jobid) || null, liveOk, { now, vm: vms.get(j.vmId), group: groupOf.get(j.vmId) || '' }));
    // 오늘 끝난 실행 — 원장의 최근 끝난 실행 + lastRun(jobid 로 하나씩)
    const seen = new Set();
    for (const r of [j.lastRun, ...(j.recentRuns || [])]) {
      if (!r?.jobid || seen.has(r.jobid) || !isFinalStatus(r.status) || !(Number(r.endedAt) >= t0)) continue;
      seen.add(r.jobid);
      if (r.status === 'T') ok += 1; else if (r.status === 'W') warn += 1; else if (r.status === 'A') canceled += 1; else fail += 1;
    }
    const L = j.lastRun;
    if (L && isFinalStatus(L.status) && Number(L.endedAt) >= t0 && (L.status === 'T' || L.status === 'W')) { if (Number.isFinite(L.bytes)) bytes += L.bytes; else bytesUnknown += 1; }
    if (j.lastRate && Number(j.lastRate.at) >= now - DAY && Number.isFinite(j.lastRate.bps)) rates.push(j.lastRate.bps);
  }
  running.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) || (b.rateNow ?? -1) - (a.rateNow ?? -1));
  const act = running.filter((r) => r.state === 'running');
  const known = act.filter((r) => r.rateNow !== null);
  return {
    vcenterId: site.vcenterId, vcName: vcName || site.vcenterId, directorId: site.directorId,
    director: dir ? { name: dir.name, via: dir.agent ? 'edge' : 'central', ready: demo || !!directorConn(dir).conn } : null,
    jobs: mine.length,
    running: act.length, waiting: running.length - act.length,
    // 지금 속도 합 — 실행 중 잡이 있고 그중 아는 값이 있을 때만(모두 모르면 null — 0 이 아니다)
    rateNow: act.length ? (known.length ? known.reduce((s, r) => s + r.rateNow, 0) : null) : 0,
    rateUnknown: act.length - known.length,
    slow: running.filter((r) => r.slow).length,
    today: { ok, warn, fail, canceled, bytes, bytesUnknown },
    rateMedian: median(rates), rateSamples: rates.length,
    live: live ? { at: live.at, ok: live.ok, code: live.code || '' } : null,
    hist: hist.map((p) => [p.at, p.rate]),
    rows: running,
  };
}

export function registerBareosLive(api) {
  /** 진행 현황(전체 법인 — 화면이 법인 하나를 고르면 그 행만 쓴다). 부를 때마다 상태 조회를 깨운다(화면이 열린 동안만 · LIVE_IDLE_MS). */
  api.get('/tools/bareos-backup/live', adminOnly, (req, res) => {
    // 데모 계정은 사람이 등록한 Director 에 닿지 않는다 — 데모 Director 일 때만 깨운다(이 라우트는 Director 를 직접 부르지 않고 폴러를 깨운다)
    if (!isDemoGuest(req.user) || isDemoActive()) touchLive();
    const snap = store.get();
    return memoJson(req, res, 'bareos-live', async () => {
      const settings = effectiveSettings();
      const now = Date.now();
      const sites = settings.sites.filter((s) => bareosAccess(req.user, s.vcenterId, { write: false }) === 0);
      const allow = new Set(sites.map((s) => s.vcenterId));
      const digests = jobDigests().filter((j) => allow.has(j.vcenterId));
      const vms = new Map((snap?.vms || []).filter((v) => allow.has(v.vcenterId)).map((v) => [v.id, v]));
      const groupOf = new Map();
      for (const g of listGroups()) if (allow.has(g.vcenterId)) for (const id of g.vmIds) groupOf.set(id, g.name);
      const vcName = new Map((snap?.vcenters || []).map((v) => [v.id, v.name || v.id]));
      const corps = sites.map((s) => corpView(s, settings, digests, { now, vms, groupOf, vcName: vcName.get(s.vcenterId) }));
      const act = corps.filter((c) => c.running > 0);
      const knownRate = act.filter((c) => c.rateNow !== null);
      const sum = (k) => corps.reduce((a, c) => a + (c.today[k] || 0), 0);
      return {
        ok: true, now, liveMs: LIVE_MS, idleMs: LIVE_IDLE_MS, demo: isDemoActive(), registryLoadError: !!registryLoadError(),
        totals: {
          corps: corps.length, active: act.length, running: corps.reduce((a, c) => a + c.running, 0), waiting: corps.reduce((a, c) => a + c.waiting, 0),
          rateNow: act.length ? (knownRate.length ? knownRate.reduce((a, c) => a + c.rateNow, 0) : null) : 0, rateUnknownCorps: act.length - knownRate.length,
          slow: corps.reduce((a, c) => a + c.slow, 0),
          today: { ok: sum('ok'), warn: sum('warn'), fail: sum('fail'), canceled: sum('canceled'), bytes: sum('bytes'), bytesUnknown: sum('bytesUnknown') },
        },
        corps,
      };
    }, { ttlMs: 5_000, extraKey: `${scopeKey(req.user, snap)}|d${isDemoActive() ? 1 : 0}` });
  });
}
