/**
 * vmpower/db.js — VM 전원 구간 저장(v3.39.0). VM 추적 DB(vm-track.db — vmtrack/db.js getDb)의 같은 연결에 표 3개를 더한다
 *   (업그레이드에 보존되는 파일 · 새 DB 파일을 만들지 않는다). node:sqlite 가 없으면 null — 화면은 '사용 불가' 로 정직하게 말한다.
 *
 *   power_spans : VM 의 '같은 상태가 이어진 구간' 한 행(spans.js 머리 주석) — 전환이 있을 때만 행이 생긴다.
 *   power_watch : vCenter 별 첫 · 마지막 관측 시각(10분마다 한 행 갱신) + 소급 여부.
 *   power_gaps  : 관측이 GAP_MS 넘게 끊긴 구간(그 사이는 '기록 없음').
 * 쓰기는 vCenter 하나당 트랜잭션 하나(CLAUDE.md — 대량 write 는 트랜잭션). 정리는 끝난 구간만(진행 중 구간은 지우지 않는다).
 */
import { getDb, addMissingColumns } from '../vmtrack/db.js';
import { createYielder } from '../util/timeSlice.js';

const prepared = new WeakMap();   // db → 문장 묶음(연결이 다시 열리면 다시 만든다)

function ensure(x) {
  const hit = prepared.get(x.db);
  if (hit) return hit;
  const { db } = x;
  db.exec(`
    CREATE TABLE IF NOT EXISTS power_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vcenter_id TEXT NOT NULL, vm_id TEXT NOT NULL, name TEXT,
      state TEXT NOT NULL,           -- 'on' | 'off'
      start_ts INTEGER NOT NULL,     -- 이 상태를 처음 본 시각
      start_lo INTEGER,              -- 바뀐 창의 앞 끝(직전 관측). NULL = 기록 시작 전부터 이 상태
      end_ts INTEGER,                -- 이 상태로 마지막 본 시각. NULL = 진행 중
      src TEXT NOT NULL DEFAULT 'watch'  -- 'watch'(10분 관측) | 'backfill'(VM 추적 12시간 슬롯에서 소급) | 'appear' | 'backfill-appear'(목록에 나타남)
    );
    CREATE INDEX IF NOT EXISTS idx_pspans_vm ON power_spans (vcenter_id, vm_id, start_ts);
    CREATE INDEX IF NOT EXISTS idx_pspans_open ON power_spans (vcenter_id) WHERE end_ts IS NULL;
    CREATE INDEX IF NOT EXISTS idx_pspans_end ON power_spans (end_ts);   -- 정리(end_ts<?) 풀스캔 방지
    CREATE TABLE IF NOT EXISTS power_watch (
      vcenter_id TEXT PRIMARY KEY, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, backfilled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS power_gaps (
      vcenter_id TEXT NOT NULL, from_ts INTEGER NOT NULL, to_ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pgaps_vc ON power_gaps (vcenter_id, to_ts);
    CREATE INDEX IF NOT EXISTS idx_pgaps_to ON power_gaps (to_ts);
  `);
  // v3.42.0(재검토 #10): 보존 정리로 그 앞 구간을 지운 시각 — 남은 첫 구간을 '처음 Power On' 으로 지어내지 않게.
  addMissingColumns(db, 'power_watch', [['pruned_to', 'INTEGER']]);
  const st = {
    openOf: db.prepare('SELECT id, vm_id, state, start_ts FROM power_spans WHERE vcenter_id=? AND end_ts IS NULL'),
    watchOf: db.prepare('SELECT first_ts, last_ts, backfilled, pruned_to FROM power_watch WHERE vcenter_id=?'),
    repairWatch: db.prepare('UPDATE power_watch SET last_ts=? WHERE vcenter_id=?'),
    markPruned: db.prepare('UPDATE power_watch SET pruned_to=MAX(COALESCE(pruned_to, 0), ?)'),
    staleWatchVcs: db.prepare('SELECT vcenter_id FROM power_watch WHERE last_ts<?'),
    dropOpenOfVc: db.prepare('DELETE FROM power_spans WHERE vcenter_id=? AND end_ts IS NULL'),
    dropGapsOfVc: db.prepare('DELETE FROM power_gaps WHERE vcenter_id=?'),
    dropWatch: db.prepare('DELETE FROM power_watch WHERE vcenter_id=?'),
    upsertWatch: db.prepare(`INSERT INTO power_watch (vcenter_id, first_ts, last_ts, backfilled) VALUES (?, ?, ?, ?)
      ON CONFLICT(vcenter_id) DO UPDATE SET last_ts=excluded.last_ts, backfilled=MAX(power_watch.backfilled, excluded.backfilled)`),
    insSpan: db.prepare('INSERT INTO power_spans (vcenter_id, vm_id, name, state, start_ts, start_lo, end_ts, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    closeSpan: db.prepare('UPDATE power_spans SET end_ts=? WHERE id=? AND end_ts IS NULL'),
    insGap: db.prepare('INSERT INTO power_gaps (vcenter_id, from_ts, to_ts) VALUES (?, ?, ?)'),
    // 상한에 걸리면 **최근 것**을 남긴다(지금 상태 · 마지막 전환은 최신 쪽) — 최신부터 읽고 호출부에서 시간순으로 되돌린다.
    spansOfVm: db.prepare('SELECT state, start_ts, start_lo, end_ts, src FROM power_spans WHERE vcenter_id=? AND vm_id=? ORDER BY start_ts DESC LIMIT ?'),
    gapsOf: db.prepare('SELECT from_ts, to_ts FROM power_gaps WHERE vcenter_id=? AND to_ts>=? ORDER BY from_ts DESC LIMIT ?'),
    // 소급 원천(VM 추적 표 — 같은 연결)
    trackChangesOf: db.prepare("SELECT vm_id, kind, ts FROM changes WHERE vcenter_id=? AND kind IN ('powered_off','powered_on') ORDER BY ts"),
    trackSlotsOf: db.prepare('SELECT ts FROM snaps WHERE vcenter_id=? ORDER BY ts'),
    trackFirstSeenOf: db.prepare('SELECT vm_id, first_seen FROM roster WHERE vcenter_id=?'),
    pruneSpans: db.prepare('DELETE FROM power_spans WHERE id IN (SELECT id FROM power_spans WHERE end_ts IS NOT NULL AND end_ts<? LIMIT 2000)'),
    pruneGaps: db.prepare('DELETE FROM power_gaps WHERE rowid IN (SELECT rowid FROM power_gaps WHERE to_ts<? LIMIT 2000)'),
    maxWatch: db.prepare('SELECT MAX(last_ts) AS mx FROM power_watch'),
  };
  const out = { db, st };
  prepared.set(db, out);
  return out;
}

/** 표가 준비된 연결(없으면 null — node:sqlite 없음 · 추적 DB 초기화 실패). */
export async function powerDb() {
  const x = await getDb();
  if (!x) return null;
  return ensure(x);
}

export async function openSpansOf(vcenterId) {
  const p = await powerDb();
  if (!p) return null;
  return new Map(p.st.openOf.all(String(vcenterId)).map((r) => [r.vm_id, { id: r.id, state: r.state, start: Number(r.start_ts) }]));
}

export async function watchOf(vcenterId) {
  const p = await powerDb();
  if (!p) return null;
  const r = p.st.watchOf.get(String(vcenterId));
  return r ? { firstTs: Number(r.first_ts), lastTs: Number(r.last_ts), backfilled: !!r.backfilled, prunedTo: r.pruned_to == null ? null : Number(r.pruned_to) } : null;
}

export async function lastWatchTs() {
  const p = await powerDb();
  if (!p) return 0;
  return Number(p.st.maxWatch.get()?.mx || 0);
}

const SRC_OK = new Set(['watch', 'backfill', 'appear', 'backfill-appear']);

/** 시계가 앞으로 튀었다 돌아온 경우 — 미래에 찍힌 마지막 관측을 지금으로 되돌린다(그 사이 관측은 건너뛴다 · 재검토 #7). */
export async function repairWatch(vcenterId, ts) {
  const p = await powerDb();
  if (!p) return;
  p.st.repairWatch.run(ts, String(vcenterId));
}

function inTx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
}

/** 관측 1회 적용(planObservation 의 결과) — 트랜잭션 하나. */
export async function commitObservation(vcenterId, plan, ts) {
  const p = await powerDb();
  if (!p) return { ok: false };
  const vc = String(vcenterId);
  return inTx(p.db, () => {
    if (plan.gap) p.st.insGap.run(vc, plan.gap.from, plan.gap.to);
    for (const c of plan.close || []) p.st.closeSpan.run(c.end, c.id);
    for (const s of plan.insert || []) p.st.insSpan.run(vc, s.vmId, s.name || '', s.state, s.start, s.lo ?? null, null, SRC_OK.has(s.src) ? s.src : 'watch');
    p.st.upsertWatch.run(vc, ts, ts, 0);
    return { ok: true, gap: !!plan.gap, closed: (plan.close || []).length, opened: (plan.insert || []).length };
  });
}

/** 소급 원천 읽기 — VM 추적의 전원 전환 · 슬롯 시각 · first_seen. */
export async function backfillSourceOf(vcenterId) {
  const p = await powerDb();
  if (!p) return null;
  const vc = String(vcenterId);
  return {
    changes: p.st.trackChangesOf.all(vc).map((r) => ({ vmId: r.vm_id, kind: r.kind, ts: Number(r.ts) })),
    snapTs: p.st.trackSlotsOf.all(vc).map((r) => Number(r.ts)),
    firstSeen: new Map(p.st.trackFirstSeenOf.all(vc).map((r) => [r.vm_id, Number(r.first_seen)])),
  };
}

/**
 * 소급 결과 적재 + 첫 관측 기록 — 트랜잭션 하나. 이미 열린 구간이 있으면(경합 · 재시도) 아무것도 하지 않는다(중복 구간 금지).
 */
export async function commitBackfill(vcenterId, rows, ts, gaps = []) {
  const p = await powerDb();
  if (!p) return { ok: false };
  const vc = String(vcenterId);
  return inTx(p.db, () => {
    if (p.st.watchOf.get(vc) || p.st.openOf.all(vc).length) return { ok: true, skipped: true };
    let n = 0; let bf = 0;
    for (const s of rows || []) {
      p.st.insSpan.run(vc, s.vmId, s.name || '', s.state, s.start, s.lo ?? null, s.end ?? null, SRC_OK.has(s.src) ? s.src : 'watch');
      n++; if (String(s.src).startsWith('backfill')) bf++;
    }
    for (const g of gaps || []) p.st.insGap.run(vc, g.from, g.to);   // 소급 기간 중 추적이 비었던 구간(재검토 #5)
    p.st.upsertWatch.run(vc, ts, ts, 1);
    return { ok: true, inserted: n, backfill: bf };
  });
}

export const SPANS_LIMIT = 20000;
export const GAPS_LIMIT = 5000;

export async function spansOfVm(vcenterId, vmId, { limit = SPANS_LIMIT } = {}) {
  const p = await powerDb();
  if (!p) return null;
  return p.st.spansOfVm.all(String(vcenterId), String(vmId), limit).reverse().map((r) => ({
    state: r.state, start: Number(r.start_ts), lo: r.start_lo == null ? null : Number(r.start_lo), end: r.end_ts == null ? null : Number(r.end_ts), src: r.src,
  }));
}

export async function gapsOf(vcenterId, sinceTs, { limit = GAPS_LIMIT } = {}) {
  const p = await powerDb();
  if (!p) return [];
  return p.st.gapsOf.all(String(vcenterId), Number(sinceTs) || 0, limit).reverse().map((r) => ({ from: Number(r.from_ts), to: Number(r.to_ts) }));
}

/**
 * 보존 기간보다 오래 전에 **끝난** 구간 · 끊김만 지운다 — 2,000행 조각 + 시간 양보.
 *   보존 기간 넘게 관측되지 않은 vCenter(등록 삭제 · 장기 중단)는 열린 구간 · 끊김 · 관측 행까지 지운다(재검토 #14 — 영구히 남았다).
 *   지웠으면 pruned_to 를 남긴다(남은 첫 구간을 '처음' 으로 지어내지 않게 — 재검토 #10).
 */
export async function prunePower(cutTs) {
  const p = await powerDb();
  if (!p) return { ok: false };
  const y = createYielder(15);
  let spans = 0; let gaps = 0; let vcs = 0;
  for (const r of p.st.staleWatchVcs.all(cutTs)) {
    inTx(p.db, () => { spans += Number(p.st.dropOpenOfVc.run(r.vcenter_id).changes || 0); gaps += Number(p.st.dropGapsOfVc.run(r.vcenter_id).changes || 0); p.st.dropWatch.run(r.vcenter_id); });
    vcs++;
    await y();
  }
  for (let i = 0; i < 500; i++) {
    const a = Number(p.st.pruneSpans.run(cutTs).changes || 0);
    const b = Number(p.st.pruneGaps.run(cutTs).changes || 0);
    spans += a; gaps += b;
    if (!a && !b) break;
    await y();
  }
  if (spans) p.st.markPruned.run(cutTs);
  return { ok: true, spans, gaps, vcs };
}
