/**
 * vmpower/db.js — VM 전원 구간 저장(v3.39.0). VM 추적 DB(vm-track.db — vmtrack/db.js getDb)의 같은 연결에 표 3개를 더한다
 *   (업그레이드에 보존되는 파일 · 새 DB 파일을 만들지 않는다). node:sqlite 가 없으면 null — 화면은 '사용 불가' 로 정직하게 말한다.
 *
 *   power_spans : VM 의 '같은 상태가 이어진 구간' 한 행(spans.js 머리 주석) — 전환이 있을 때만 행이 생긴다.
 *   power_watch : vCenter 별 첫 · 마지막 관측 시각(10분마다 한 행 갱신) + 소급 여부.
 *   power_gaps  : 관측이 GAP_MS 넘게 끊긴 구간(그 사이는 '기록 없음').
 * 쓰기는 vCenter 하나당 트랜잭션 하나(CLAUDE.md — 대량 write 는 트랜잭션). 정리는 끝난 구간만(진행 중 구간은 지우지 않는다).
 */
import { getDb } from '../vmtrack/db.js';
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
      src TEXT NOT NULL DEFAULT 'watch'  -- 'watch'(10분 관측) | 'backfill'(VM 추적 12시간 슬롯에서 소급)
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
  const st = {
    openOf: db.prepare('SELECT id, vm_id, state, start_ts FROM power_spans WHERE vcenter_id=? AND end_ts IS NULL'),
    watchOf: db.prepare('SELECT first_ts, last_ts, backfilled FROM power_watch WHERE vcenter_id=?'),
    upsertWatch: db.prepare(`INSERT INTO power_watch (vcenter_id, first_ts, last_ts, backfilled) VALUES (?, ?, ?, ?)
      ON CONFLICT(vcenter_id) DO UPDATE SET last_ts=excluded.last_ts, backfilled=MAX(power_watch.backfilled, excluded.backfilled)`),
    insSpan: db.prepare('INSERT INTO power_spans (vcenter_id, vm_id, name, state, start_ts, start_lo, end_ts, src) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    closeSpan: db.prepare('UPDATE power_spans SET end_ts=? WHERE id=? AND end_ts IS NULL'),
    insGap: db.prepare('INSERT INTO power_gaps (vcenter_id, from_ts, to_ts) VALUES (?, ?, ?)'),
    spansOfVm: db.prepare('SELECT state, start_ts, start_lo, end_ts, src FROM power_spans WHERE vcenter_id=? AND vm_id=? ORDER BY start_ts LIMIT 20000'),
    gapsOf: db.prepare('SELECT from_ts, to_ts FROM power_gaps WHERE vcenter_id=? AND to_ts>=? ORDER BY from_ts LIMIT 5000'),
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
  return r ? { firstTs: Number(r.first_ts), lastTs: Number(r.last_ts), backfilled: !!r.backfilled } : null;
}

export async function lastWatchTs() {
  const p = await powerDb();
  if (!p) return 0;
  return Number(p.st.maxWatch.get()?.mx || 0);
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
    for (const s of plan.insert || []) p.st.insSpan.run(vc, s.vmId, s.name || '', s.state, s.start, s.lo ?? null, null, 'watch');
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
export async function commitBackfill(vcenterId, rows, ts) {
  const p = await powerDb();
  if (!p) return { ok: false };
  const vc = String(vcenterId);
  return inTx(p.db, () => {
    if (p.st.watchOf.get(vc) || p.st.openOf.all(vc).length) return { ok: true, skipped: true };
    let n = 0; let bf = 0;
    for (const s of rows || []) {
      p.st.insSpan.run(vc, s.vmId, s.name || '', s.state, s.start, s.lo ?? null, s.end ?? null, s.src === 'backfill' ? 'backfill' : 'watch');
      n++; if (s.src === 'backfill') bf++;
    }
    p.st.upsertWatch.run(vc, ts, ts, 1);
    return { ok: true, inserted: n, backfill: bf };
  });
}

export async function spansOfVm(vcenterId, vmId) {
  const p = await powerDb();
  if (!p) return null;
  return p.st.spansOfVm.all(String(vcenterId), String(vmId)).map((r) => ({
    state: r.state, start: Number(r.start_ts), lo: r.start_lo == null ? null : Number(r.start_lo), end: r.end_ts == null ? null : Number(r.end_ts), src: r.src,
  }));
}

export async function gapsOf(vcenterId, sinceTs) {
  const p = await powerDb();
  if (!p) return [];
  return p.st.gapsOf.all(String(vcenterId), Number(sinceTs) || 0).map((r) => ({ from: Number(r.from_ts), to: Number(r.to_ts) }));
}

/** 보존 기간보다 오래 전에 **끝난** 구간 · 끊김만 지운다 — 2,000행 조각 + 시간 양보. */
export async function prunePower(cutTs) {
  const p = await powerDb();
  if (!p) return { ok: false };
  const y = createYielder(15);
  let spans = 0; let gaps = 0;
  for (let i = 0; i < 500; i++) {
    const a = Number(p.st.pruneSpans.run(cutTs).changes || 0);
    const b = Number(p.st.pruneGaps.run(cutTs).changes || 0);
    spans += a; gaps += b;
    if (!a && !b) break;
    await y();
  }
  return { ok: true, spans, gaps };
}
