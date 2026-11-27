/**
 * svcstatus/poller.js — 중앙이 재는 대상의 주기 측정(v3.54 — **중앙 전용**: CENTRAL_URL 이 있는 엣지 노드에서는 돌지 않는다.
 * 엣지 노드는 `agent/svcStatusWorker.js` 가 자기 몫을 재서 올린다).
 *
 * 규약(perf-db.md): 재진입 가드는 수동 실행과 공유 · **주기 상한**(끝나지 않는 주기가 가드를 영원히 붙잡지 않게 — 가드는 주기 번호) ·
 *   동시성 풀(util/pool.js) · 항목 시한(측정 시한 + DNS 시한 + 여유) · 주기는 `startAdaptiveTimer` + 설정 변경 리스너(모듈 로드 때 굳히지 않는다) ·
 *   적재는 주기마다 트랜잭션 하나 · prune 은 `(++tick % N) === 0`(기동 첫 틱 금지) · 설정을 못 읽은 주기에는 보존 정리를 건너뛴다(기본 보존일로 지우지 않게) ·
 *   평소 계산 · 메일은 측정 주기 **밖**(자기 가드 — 메일이 측정을 붙잡지 않게).
 * 데모(mock): 데모 항목은 합성 측정(실제 접속 없음), 사람이 등록한 항목은 mock 에서도 실제로 잰다 · 데모 엣지 보고는 중앙 수신 함수에 합성 보고를 넣는다
 *   (정제 · 저장 경로가 실데이터와 같다 — linkcheck demoEdgeReports 와 같은 꼴) · 첫 주기 전 8일 이력을 한 번 백필(있으면 덮지 않는다).
 */
import { config } from '../config.js';
import { startAdaptiveTimer } from '../util/adaptiveTimer.js';
import { poolSettled } from '../util/pool.js';
import { loadSvcStatusSettings, svcStatusSettingsLoadError, svcStatusUsingLastGood, onSvcStatusSettingsChange } from './settings.js';
import { getPlan, putEdgeReport, invalidatePlan } from './service.js';
import { probeTcp, DNS_TIMEOUT_MS } from './probe.js';
import { timeoutFor } from './judge.js';
import { unitKey } from './view.js';
import * as db from './db.js';
import { isMockMode } from '../mock/demo/flags.js';
import { demoSvcResult, DEMO_SILENT_EDGE } from '../mock/demo/svcstatus.js';
import { svcStatusMailTick, svcStatusMailInfo } from './notify.js';

const PRUNE_EVERY = 30;               // 주기 30번에 한 번(60초 주기 = 30분)
const BASELINE_TICK_MS = 10 * 60_000; // 평소 재계산 틱(대상마다 1시간 간격 · 처음 표본이 모이면 곧바로)
const ITEM_SLACK_MS = 5_000;
const BACKFILL_CHUNK = 1_500;          // 데모 백필 한 트랜잭션의 행 수(실측 — 아래 시험 svcStatus354 ⑧ 가 루프 멈춤 상한을 본다)
let _timer = null; let _baseTimer = null; let _mailTimer = null;
let _running = 0;                     // 진행 중인 주기 번호(0 = 없음)
let _seq = 0; let _startedAt = 0;
let _tick = 0;
let _last = null; let _stuckReleases = 0;
let _baseBusy = false; let _lastBase = null;
let _demoBackfilled = false;
let _wake = null;

export function svcStatusPollerStatus() {
  const s = safeSettings();
  return {
    enabled: s.enabled !== false, intervalMs: s.intervalMs, running: _running !== 0, last: _last,
    stuckReleases: _stuckReleases, baseline: _lastBase, mail: svcStatusMailInfo(), ...(isMockMode() ? { demo: true } : {}),
  };
}
function safeSettings() { try { return loadSvcStatusSettings(); } catch { return { intervalMs: 60_000, enabled: true }; } }
const isEdgeNode = () => !!config.agent?.centralUrl;

/** 주기 상한 — 주기 × 3 과 5분 중 큰 값. 넘긴 주기는 가드를 놓는다(늦게 끝나도 새 주기의 가드를 풀지 않는다). */
export function cycleMaxMs(intervalMs) { return Math.max(5 * 60_000, (Number(intervalMs) || 60_000) * 3); }

/**
 * 한 주기. 수동 실행(`trigger:'manual'`, `onlyId`)과 가드를 공유한다.
 * @returns {Promise<object>}
 */
export async function pollSvcStatusOnce({ trigger = 'timer', onlyId = '', now = () => Date.now(), probe = probeTcp, planDeps = null } = {}) {
  if (isEdgeNode()) return { ok: false, skipped: 'edge-node' };
  const settings = loadSvcStatusSettings();
  if (_running) {
    if (Date.now() - _startedAt <= cycleMaxMs(settings.intervalMs)) return { ok: false, skipped: 'already-running' };
    _stuckReleases += 1;
    console.warn(`[svc-status] 앞 주기가 상한(${Math.round(cycleMaxMs(settings.intervalMs) / 1000)}초)을 넘겨 가드를 놓습니다.`);
  }
  if (settings.enabled === false && trigger !== 'manual') { _last = { at: Date.now(), ms: 0, trigger, disabled: true }; return { ok: true, disabled: true }; }
  const my = ++_seq; _running = my; _startedAt = Date.now();
  const t0 = Date.now();
  try {
    const plan = await getPlan({ force: true, ...(planDeps ? { deps: planDeps } : {}) });   // planDeps — 시험 주입(등록부 대신 카탈로그 결과)
    const mock = !!plan.mock;
    if (mock && !_demoBackfilled) await demoBackfill(plan, settings);
    const latest = await db.latestRows();
    const baseOf = new Map((latest || []).map((r) => [unitKey(r.id, r.host, r.port), Number(r.base_ms) || null]));
    let mine = plan.rows.filter((r) => r.plan === 'central');
    if (onlyId) mine = mine.filter((r) => r.id === onlyId);
    const downId = demoDownId(plan.rows);
    const results = await poolSettled(mine, settings.concurrency, async (r) => {
      const ts = now();
      if (mock && r.demo) return { r, ts, res: demoSvcResult(r, { ts, now: ts, downId }) };
      const timeoutMs = timeoutFor(baseOf.get(unitKey(r.id, r.host, r.port)), settings);
      const res = await withDeadline(probe({ host: r.host, port: r.port }, { timeoutMs, dnsTimeoutMs: DNS_TIMEOUT_MS }), timeoutMs + DNS_TIMEOUT_MS + ITEM_SLACK_MS);
      return { r, ts, res };
    });
    const rows = []; let skipped = 0; let failed = 0;
    for (const x of results) {
      if (x.status !== 'fulfilled' || !x.value?.res) { skipped += 1; continue; }
      const { r, ts, res } = x.value;
      if (!res.ok) failed += 1;
      rows.push({ id: r.id, host: r.host, port: r.port, kind: r.kind, ts, ok: res.ok, ms: res.ms, fk: res.fk, by: 'central' });
    }
    rows.sort((a, b) => a.ts - b.ts);
    const rec = rows.length ? await db.recordResults(rows, { settings }) : { ok: true, stored: 0 };
    // 데모 엣지 보고(보고하지 않는 데모 엣지 하나 — 못 잼 시연).
    let demoEdges = 0;
    if (mock && !onlyId) demoEdges = await demoEdgeReports(plan, now(), downId);
    // 보존 정리 — 설정을 처음부터 못 읽은 주기에는 건너뛴다(기본 보존일로 지우지 않게).
    let prune = null;
    if ((++_tick % PRUNE_EVERY) === 0) {
      if (svcStatusSettingsLoadError() && !svcStatusUsingLastGood()) prune = { skipped: 'settings-unreadable' };
      else prune = await db.pruneSvcStatus({ retentionDays: settings.retentionDays });
    }
    _last = {
      at: Date.now(), ms: Date.now() - t0, trigger, measured: rows.length, failed, skipped,
      edgeTargets: plan.rows.filter((r) => r.plan === 'edge').length, stored: rec.stored ?? 0,
      dbOk: !rec.dbUnavailable, ...(demoEdges ? { demoEdges } : {}), ...(prune ? { prune } : {}),
      heldKinds: plan.heldKinds,
    };
    if (rec.dbUnavailable) console.warn('[svc-status] 측정 DB 를 쓸 수 없어 이번 측정을 저장하지 못했습니다(svc-status.db 확인).');
    return { ok: true, measured: rows.length, failed, skipped };   // skipped = 측정하지 못한 대상 수(항목 시한 · 예외)
  } catch (e) {
    _last = { at: Date.now(), ms: Date.now() - t0, trigger, ok: false, error: String(e?.message || e).slice(0, 300) };
    console.warn(`[svc-status] 주기 실패: ${_last.error}`);
    return { ok: false, reason: _last.error };
  } finally {
    if (_running === my) _running = 0;   // 늦게 끝난 옛 주기가 새 주기의 가드를 풀지 않게
  }
}

function withDeadline(p, ms) {
  let timer = null;
  return Promise.race([p, new Promise((res) => { timer = setTimeout(() => res({ ok: false, ms: null, fk: 'timeout' }), ms); })])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** 데모 끊김 대상 — 데모 스토리지 중 id 정렬 첫째(결정적). */
function demoDownId(rows) {
  const st = rows.filter((r) => r.demo && r.kind === 'storage' && (r.plan === 'central' || r.plan === 'edge')).map((r) => r.id).sort();
  return st[0] || '';
}

async function demoEdgeReports(plan, ts, downId) {
  const byEdge = new Map();
  for (const r of plan.rows) if (r.plan === 'edge' && r.demo) { if (!byEdge.has(r.by)) byEdge.set(r.by, []); byEdge.get(r.by).push(r); }
  let n = 0;
  for (const [agent, list] of byEdge) {
    if (agent.toLowerCase() === DEMO_SILENT_EDGE.toLowerCase()) continue;
    const results = list.map((r) => { const res = demoSvcResult(r, { ts, now: ts, downId }); return { id: r.id, host: r.host, port: r.port, ok: res.ok, ms: res.ms, fk: res.fk, a: 0 }; });
    try { await putEdgeReport(agent, { at: ts, version: '', results }, { now: ts }); n += 1; } catch { /* 데모 보고 실패는 다음 주기 */ }
  }
  return n;
}

/** 데모 이력 백필 — 한 번 · 이력이 있으면 덮지 않음 · 5분 간격 8일 · 하루치마다 양보. */
async function demoBackfill(plan, settings) {
  const targets = plan.rows.filter((r) => r.demo && (r.plan === 'central' || (r.plan === 'edge' && r.by.toLowerCase() !== DEMO_SILENT_EDGE.toLowerCase())));
  if (!targets.length) return;   // 데모 등록부가 아직 비었다 — 다음 기회
  const latest = await db.latestRows();
  if (latest == null) return;
  _demoBackfilled = true;
  if (latest.length) return;     // 이력이 있다 — 덮지 않는다
  const now = Date.now();
  const downId = demoDownId(plan.rows);
  const STEP = 5 * 60_000;
  const from = now - db.RAW_DAYS * 86_400_000 + STEP;
  let total = 0;
  // ⚠ 트랜잭션 하나는 동기다 — 묶음을 작게(BACKFILL_CHUNK 행) 나누고 묶음 사이에 양보한다(하루치 2만 행을 한 번에 쓰면 루프가 수백 ms 멈춘다).
  let rows = [];
  const flush = async () => { if (!rows.length) return; const rec = await db.recordResults(rows, { settings }); total += rec.stored || 0; rows = []; await new Promise((res) => setImmediate(res)); };
  for (let ts = from; ts < now - STEP; ts += STEP) {
    for (const r of targets) { const res = demoSvcResult(r, { ts, now, downId }); rows.push({ id: r.id, host: r.host, port: r.port, kind: r.kind, ts, ok: res.ok, ms: res.ms, fk: res.fk, by: r.plan === 'edge' ? r.by : 'central' }); }
    if (rows.length >= BACKFILL_CHUNK) await flush();
  }
  await flush();
  await db.refreshBaselines({ force: true });
  console.log(`[mock] 포탈 서비스 상태 데모 이력 ${total}건 백필(대상 ${targets.length}개 · ${db.RAW_DAYS}일)`);
}

/** 평소 재계산 틱(자기 가드 — 측정 주기와 겹쳐도 서로 붙잡지 않는다). */
export async function svcStatusBaselineTick() {
  if (_baseBusy || isEdgeNode()) return { ok: false, skipped: true };
  _baseBusy = true;
  const t0 = Date.now();
  try {
    const r = await db.refreshBaselines();
    _lastBase = { at: Date.now(), ms: Date.now() - t0, updated: r.updated ?? 0, ok: r.ok !== false };
    return r;
  } catch (e) {
    _lastBase = { at: Date.now(), ok: false, error: String(e?.message || e).slice(0, 200) };
    console.warn(`[svc-status] 평소 계산 실패: ${_lastBase.error}`);
    return { ok: false };
  } finally { _baseBusy = false; }
}

/** 지금 측정 — 라우트용(가드 공유). 엣지 대상은 여기서 재지 않는다. */
export function runSvcStatusNow(onlyId = '') { return pollSvcStatusOnce({ trigger: 'manual', onlyId }); }

export function startSvcStatusPoller() {
  if (isEdgeNode()) return;          // 엣지 노드는 svcStatusWorker 가 맡는다
  if (_timer) return _timer;
  _timer = startAdaptiveTimer(() => safeSettings().intervalMs, () => pollSvcStatusOnce(), {
    firstDelayMs: 30_000, name: 'svc-status',
    subscribe: (cb) => onSvcStatusSettingsChange(() => { invalidatePlan(); cb(); }),
  });
  _baseTimer = startAdaptiveTimer(() => BASELINE_TICK_MS, () => svcStatusBaselineTick(), { firstDelayMs: 5 * 60_000, name: 'svc-status-baseline' });
  // 상태 변화 메일 — 1분 틱(측정 주기 밖 · 자기 가드). 측정 주기를 길게 둬도 메일은 다음 1분 안에 나간다.
  _mailTimer = startAdaptiveTimer(() => 60_000, () => svcStatusMailTick(), { firstDelayMs: 90_000, name: 'svc-status-mail' });
  _wake = onSvcStatusSettingsChange(() => invalidatePlan());
  return _timer;
}
export function stopSvcStatusPoller() { _timer?.stop?.(); _baseTimer?.stop?.(); _mailTimer?.stop?.(); _wake?.(); _timer = null; _baseTimer = null; _mailTimer = null; _wake = null; }
export function _resetSvcStatusPollerForTest() { _running = 0; _seq = 0; _tick = 0; _last = null; _stuckReleases = 0; _demoBackfilled = false; _baseBusy = false; _lastBase = null; }
