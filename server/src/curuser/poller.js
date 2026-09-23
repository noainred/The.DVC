/**
 * curuser/poller.js — '현재 사용자' 주기 수집(v2.520). 기본 10분(사용자 지정 "10분마다 db 에 저장해줘").
 *
 * CLAUDE.md 규약 전부 적용:
 *  · 재진입 가드(폴러 + 수동 '지금 수집' 이 **같은 가드를 공유**한다 — net/monitor.runMonitorNow 패턴)
 *  · 적응형 타이머 + 설정 변경 즉시 재무장(주기를 모듈 로드 시 굳히지 않는다)
 *  · vCenter 동시 수집 제한 + 법인 단위 시한(느린 1곳이 다음 주기를 막지 않는다)
 *  · site 위임·mock·비활성 vCenter 는 건너뛴다(엣지가 push — 중앙은 직접 SOAP 를 걸지 않는다)
 *  · prune 은 `(++tick % N) === 0`(기동 첫 틱을 피한다 — v2.453)
 *
 * ── 이 폴러가 가벼운 이유(정직 기록) ────────────────────────────────────────────
 * 게스트 계정 경로(`gpu/guestops.js`)는 VM 마다 게스트 프로세스를 띄우고 결과 파일을 회수한다.
 * 이 경로는 **법인마다 SOAP 조회 1~2회**뿐이다(대상 moref 250개씩 청크). 400대를 봐도 왕복은
 * 2회다 — 그래서 per-VM 타임아웃이 아니라 **법인 단위 시한**을 쓴다.
 *
 * ── 시계열을 '전체 latest 로부터' 다시 계산하는 이유 ───────────────────────────
 * 전체 합계(고유 사용자 **합집합**)는 위임 법인까지 합쳐야 맞다. 위임 법인은 엣지가 push 한
 * `latest` 행으로만 존재하므로, 이번 주기에 중앙이 직접 읽은 법인만으로 합계를 쓰면 **위임
 * 법인이 통째로 빠진 합계**가 DB 에 남는다. 그래서 적재 직후 `latestRecords()` 전량으로
 * 다시 집계한다(행 수 ≤ maxVms 로 유계 — 비용은 무시할 수준).
 */
import { store } from '../store.js';
import { loadVcenterConfig } from '../config.js';
import { isMockVcenter } from '../mock/generator.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { withJob } from '../perf/monitor.js';
import { describeError } from '../util/errors.js';
import { isStopped } from '../security/emergencyStop.js';
import { load as loadCurUserSettings, staleAfterMs, onCurUserSettingsChange } from './settings.js';
import { resolveTargets } from './scope.js';
import { collectVcenterCurUsers, mockRecords } from './collect.js';
import { commitCurUser, latestRecords, pruneCurUser, curUserDbStatus } from './db.js';
import { refreshKinds } from './report.js';
import { aggregateAll, seriesRow } from './aggregate.js';
import { recordCurUserActivity } from './activityLog.js';
import { pushCurUserRecords, curUserPushEnabled } from '../agent/curUserPush.js';
import { poolSettled } from '../util/pool.js'; // v2.579: 동시성 풀 단일 소스
import { vcAuthGuard, isVcAuthError } from '../vcenter/restClient.js';
import { authStopView } from '../util/authGuard.js';

const CONCURRENCY_CAP = 8;
const PRUNE_EVERY_RUNS = 6;                       // 10분 × 6 = 1시간에 1회
const FIRST_DELAY_MS = Number(process.env.CURUSER_FIRST_DELAY_MS) || 120_000;  // 첫 인벤토리 수집 뒤

let running = false;
let tick = 0;
let lastResult = null;
let lastRunTs = 0;
let timer = null;
const inFlight = new Map();                       // vcenterId -> startedAt ('진행중' 구획의 원천)

export function curUserPollerStatus() {
  const s = loadCurUserSettings();
  return {
    running, lastResult, lastRunTs,
    intervalMs: s.intervalMs, enabled: s.enabled,
    guestPublishMs: s.guestPublishMs, staleAfterMs: staleAfterMs(s),
    concurrency: Math.min(CONCURRENCY_CAP, s.concurrency),
    inFlight: [...inFlight.entries()].map(([id, at]) => ({ deviceId: id, at })),
  };
}

// v2.579(ARCH-01): 풀 스캐폴드는 util/pool.js 하나다 — 항목별 결과 모양(예전 그대로)만 여기서 입힌다.
async function pool(items, n, fn) {
  return (await poolSettled(items, n, fn)).map((r) => (r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: r.reason }));
}

/** 이번 주기의 시계열 행을 **전체 latest** 로부터 다시 만든다(위 머리말 참조). */
async function writeSeries(ts, s, vcNameOf) {
  const all = refreshKinds(await latestRecords(), { now: ts, staleAfterMs: staleAfterMs(s) });
  const agg = aggregateAll(all, { vcNameOf });
  const series = [
    { vcenterId: '', ...seriesRow(agg.total) },
    ...agg.vcenters.map((v) => ({ vcenterId: v.vcenterId, ...seriesRow(v) })),
  ];
  await commitCurUser({ ts, records: [], series });
  return { series: series.length, users: agg.total.users };
}

/** 수집 1회(자동·수동 공용 — 같은 재진입 가드). */
export async function runCurUserNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 수집이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    if (isStopped()) { lastResult = { at: Date.now(), trigger, skipped: '긴급중단' }; return { ok: false, ...lastResult }; }
    const s = loadCurUserSettings();
    if (!s.enabled && trigger !== 'manual') return { ok: false, reason: '수집이 꺼져 있습니다(설정에서 켜세요).' };
    const db = await curUserDbStatus();
    if (!db.available) return { ok: false, reason: `DB 를 쓸 수 없습니다: ${db.error || 'node:sqlite 없음'}` };

    const snap = store.get();
    if (!snap?.vms?.length) return { ok: false, reason: '수집된 VM 스냅샷이 없습니다(첫 인벤토리 폴링 전).' };
    const scope = resolveTargets(snap.vms || [], s);
    if (!scope.targets.length) {
      lastRunTs = Date.now();
      lastResult = { at: lastRunTs, trigger, vcenters: 0, targets: 0, records: 0, skipped: scope.skipped.length, errors: [], ms: Date.now() - started };
      return { ok: true, ...lastResult, reason: '대상 VM 이 없습니다(설정에서 폴더를 지정하고 켜세요).' };
    }

    const mock = snap.source === 'mock';
    const reg = mock ? [] : (loadVcenterConfig().vcenters || []);
    const vcNameOf = (id) => (snap.vcenters || []).find((v) => v.id === id)?.name || id;
    const byVc = new Map();
    for (const t of scope.targets) {
      if (!byVc.has(t.vcenterId)) byVc.set(t.vcenterId, []);
      byVc.get(t.vcenterId).push(t);
    }

    const skippedVc = [];
    const jobs = [];
    for (const [vcId, targets] of byVc) {
      if (mock) { jobs.push({ vcId, vc: { id: vcId, name: vcNameOf(vcId) }, targets, mock: true }); continue; }
      const vc = reg.find((x) => x.id === vcId);
      if (!vc) { skippedVc.push({ vcenterId: vcId, why: 'not-registered' }); continue; }
      if (vc.enabled === false || vc.maintenance) { skippedVc.push({ vcenterId: vcId, why: vc.maintenance ? 'maintenance' : 'disabled' }); continue; }
      if (vc.collectMode === 'site') { skippedVc.push({ vcenterId: vcId, why: 'site' }); continue; }   // 엣지가 push
      if (vc.mock === true || isMockVcenter(vc)) { skippedVc.push({ vcenterId: vcId, why: 'mock' }); continue; }
      // v2.591(감사 F1): 인벤토리 수집(store)과 **같은 vCenter 계정**이다. 그 계정이 인증 실패로 멈춰 있으면 주기
      //   수집은 로그인하지 않는다(읽기 전용 조회 — 해제는 주 폴러·연결 테스트만 한다). 수동 실행은 막지 않는다.
      //   조용히 빼지 않는다 — 사유 'auth-stopped' 와 정지 기록(시각·횟수)을 결과에 싣는다.
      if (trigger !== 'manual') {
        const st = vcAuthGuard.peekAuthStop(vc);
        if (st) { skippedVc.push({ vcenterId: vcId, why: 'auth-stopped', authStopped: authStopView(st) }); continue; }
      }
      jobs.push({ vcId, vc, targets, mock: false });
    }

    const results = await pool(jobs, Math.min(CONCURRENCY_CAP, s.concurrency), (j) => withJob(`curuser.collect:${j.vcId}`, async () => {
      inFlight.set(j.vcId, Date.now());
      const t0 = Date.now();
      try {
        const r = j.mock
          ? { records: mockRecords(j.targets), error: null, morefs: j.targets.length, ms: 0 }
          : await collectVcenterCurUsers(j.vc, j.targets, { now: Date.now(), staleAfterMs: staleAfterMs(s), timeoutMs: s.vmTimeoutMs });
        // 작업 로그 — 실패 주기의 수치는 **null** 이다(0 으로 채우면 '사용자 0명' 이라는 거짓).
        const okRecs = r.records.filter((x) => x.ok);
        const uniq = new Set(okRecs.flatMap((x) => (x.users || []).map((u) => String(u.name || '').trim().toLowerCase())).filter(Boolean));
        recordCurUserActivity({
          deviceId: j.vcId, name: j.vc.name || j.vcId, source: 'central',
          ok: !r.error, durationMs: Date.now() - t0, error: r.error || null,
          vms: r.error ? null : r.records.length, users: r.error ? null : uniq.size,
        });
        return { vcenterId: j.vcId, ...r };
      } finally { inFlight.delete(j.vcId); }
    }));

    const errors = []; const records = []; const collectedVc = [];
    results.forEach((r, i) => {
      const j = jobs[i];
      if (!r?.ok) {
        const d = describeError(r?.error);
        const rec = (!j.mock && isVcAuthError(r?.error)) ? vcAuthGuard.markAuthStopped(j.vc.id, j.vc, d.message) : null;
        errors.push({ vcenterId: j.vcId, error: d.message, hint: d.hint || '', ...(rec ? { authStopped: authStopView(rec) } : {}) });
        recordCurUserActivity({ deviceId: j.vcId, name: j.vc.name || j.vcId, source: 'central', ok: false, durationMs: null, error: d.message, vms: null, users: null });
        return;
      }
      const v = r.value;
      if (v.error) {
        // v2.591: 로그인 거부면 주 폴러와 같은 기록에 시도를 올린다 — 화면의 '정지(N회)' 가 실제 실패 로그인 수와 맞게.
        const rec = (!j.mock && v.authFailed) ? vcAuthGuard.markAuthStopped(j.vc.id, j.vc, v.error) : null;
        errors.push({ vcenterId: j.vcId, error: v.error, ...(rec ? { authStopped: authStopView(rec) } : {}) });
        if (rec) console.warn(`[curuser] ${j.vcId}: vCenter 인증 실패 — 주기 수집 정지(${rec.attempts}회). 비밀번호를 고치면 자동 재개합니다`);
      }
      if (v.records.length) { records.push(...v.records); collectedVc.push(j.vcId); }
    });

    const ts = Date.now();
    // 이번 주기에 **실제로 읽은** 법인만 교체한다 — 실패한 법인의 직전 값을 지우면 화면이
    // '발행기 없음' 으로 뒤바뀐다(수집 실패와 값 없음은 다르다).
    const commit = await commitCurUser({ ts, records, series: [], replaceVcenters: collectedVc });
    const ser = commit.ok ? await writeSeries(ts, s, vcNameOf) : { series: 0, users: null };

    let pushed = null;
    if (!mock && curUserPushEnabled() && records.length) {
      try { pushed = await pushCurUserRecords(records, { generatedAt: ts }); }
      catch (e) { pushed = { ok: false, error: String(e?.message || e).slice(0, 200) }; }
    }

    if ((++tick % PRUNE_EVERY_RUNS) === 0) { try { await pruneCurUser(s.retentionDays, { every: 1 }); } catch { /* */ } }

    lastRunTs = ts;
    lastResult = {
      at: ts, trigger, vcenters: jobs.length, targets: scope.targets.length, records: records.length,
      skipped: scope.skipped.length, skippedVcenters: skippedVc, overLimit: scope.overLimit,
      users: ser.users, errors, pushed, mock, ms: Date.now() - started, commit,
    };
    return { ok: errors.length === 0, ...lastResult };
  } finally { running = false; }
}

/** 적응형 타이머 기동 — 주기·on/off 변경은 즉시 재무장된다. */
export function startCurUserPoller() {
  if (timer) return;
  const getMs = () => Math.max(60_000, loadCurUserSettings().intervalMs);
  timer = startAdaptiveTimer(getMs, async () => {
    if (running) return;                              // 재진입 가드
    if (!loadCurUserSettings().enabled) return;       // opt-in
    try { await runCurUserNow('auto'); } catch (e) { console.warn(`[curuser] 폴러 틱 오류: ${e.message}`); }
  }, { firstDelayMs: FIRST_DELAY_MS, name: 'curuser', subscribe: onCurUserSettingsChange });
  const s = loadCurUserSettings();
  if (s.enabled) console.log(`[curuser] started — 주기 ${Math.round(s.intervalMs / 60_000)}분 · 동시 ${Math.min(CONCURRENCY_CAP, s.concurrency)} · 첫 실행 ${Math.round(FIRST_DELAY_MS / 1000)}초 후${curUserPushEnabled() ? ' · 중앙 push 켜짐' : ''}`);
}

export function stopCurUserPoller() { timer?.stop?.(); timer = null; }
