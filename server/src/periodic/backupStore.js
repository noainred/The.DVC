/**
 * periodic/backupStore.js — 백업 적재(3절)의 DB 읽기 · 쓰기. 표는 db.js BACKUP_SCHEMA(periodic.db 안).
 *   규칙은 backupLedger.js(순수), 틱 · 조립 연결은 backupService.js.
 * 규약(perf-db): 관측 한 번 · 확정 한 묶음은 **각각 한 트랜잭션**(안에 await 없음) · 정리는 날 단독 인덱스 + 청크 · '키별 최신' 을 GROUP BY + MAX 로 만들지 않는다
 *   (그날 VM 마다 마지막 결과는 행을 읽어 JS 로 고른다 — 법인 · 날 하나라 행 수가 작다).
 * DB 를 못 열면 null(빈 목록과 구분).
 */
import { getPeriodicDb } from './db.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { dayIndex, dayStartMs } from '../util/dayKey.js';
import { coverStep, sealStatus, sealCounts, refillable, failStreak, SEAL_LAG_MS, REFILL_DAYS, RAW_KEEP_DAYS, PRODUCTS } from './backupLedger.js';

const DAY = 86_400_000;
const dayOf = (t) => dayIndex(t);
const dayStartOf = (d) => dayStartMs(d);
const jsonOr = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const TARGETS_MAX = 20_000;

let _st = null; let _stFor = null;
function stmts(db) {
  if (_stFor === db && _st) return _st;
  _st = {
    insObs: db.prepare(`INSERT OR IGNORE INTO pr_bk_obs(product, vm, ended_at, vc, day, state, started_at, name, reason, reason_pub, run_id, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getCursor: db.prepare('SELECT product, vc, last_at, first_day, sealed_to, active_at FROM pr_bk_cursor WHERE product = ? AND vc = ?'),
    allCursors: db.prepare('SELECT product, vc, last_at, first_day, sealed_to, active_at FROM pr_bk_cursor'),
    putCursor: db.prepare(`INSERT INTO pr_bk_cursor(product, vc, last_at, first_day, sealed_to, active_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(product, vc) DO UPDATE SET last_at = excluded.last_at, first_day = excluded.first_day, sealed_to = excluded.sealed_to, active_at = excluded.active_at`),
    gapSeen: db.prepare(`INSERT INTO pr_bk_seen(product, vc, day, max_gap) VALUES (?, ?, ?, ?)
      ON CONFLICT(product, vc, day) DO UPDATE SET max_gap = MAX(max_gap, excluded.max_gap)`),
    freshSeen: db.prepare(`INSERT INTO pr_bk_seen(product, vc, day, first_at, last_at, n_fresh, targets) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(product, vc, day) DO UPDATE SET first_at = COALESCE(first_at, excluded.first_at), last_at = excluded.last_at, n_fresh = n_fresh + 1,
        targets = COALESCE(excluded.targets, targets)`),
    staleSeen: db.prepare(`INSERT INTO pr_bk_seen(product, vc, day, n_stale) VALUES (?, ?, ?, 1)
      ON CONFLICT(product, vc, day) DO UPDATE SET n_stale = n_stale + 1`),
    getSeen: db.prepare('SELECT first_at, last_at, max_gap, n_fresh, n_stale, targets FROM pr_bk_seen WHERE product = ? AND vc = ? AND day = ?'),
    nextTargets: db.prepare('SELECT targets FROM pr_bk_seen WHERE product = ? AND vc = ? AND day > ? AND targets IS NOT NULL ORDER BY day LIMIT 1'),
    obsOfDay: db.prepare('SELECT vm, ended_at, state, name, reason, reason_pub FROM pr_bk_obs WHERE product = ? AND vc = ? AND day = ?'),
    getDay: db.prepare('SELECT status, sealed_at FROM pr_bk_day WHERE day = ? AND product = ? AND vc = ?'),
    putDay: db.prepare(`INSERT INTO pr_bk_day(day, product, vc, status, targets, ended, ok, warn, fail, norun, sealed_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, product, vc) DO UPDATE SET status = excluded.status, targets = excluded.targets, ended = excluded.ended, ok = excluded.ok, warn = excluded.warn,
        fail = excluded.fail, norun = excluded.norun, sealed_at = excluded.sealed_at, late = excluded.late`),
    delVmDay: db.prepare('DELETE FROM pr_bk_vmday WHERE day = ? AND product = ? AND vc = ?'),
    insVmDay: db.prepare(`INSERT OR REPLACE INTO pr_bk_vmday(day, product, vm, vc, state, name, ended_at, reason, reason_pub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    unknownRefill: db.prepare("SELECT day, product, vc FROM pr_bk_day WHERE day >= ? AND status = 'unknown'"),
    daysBetween: db.prepare('SELECT day, product, vc, status, targets, ended, ok, warn, fail, norun FROM pr_bk_day WHERE day >= ? AND day <= ?'),
    vmDaysBetween: db.prepare('SELECT day, product, vm, vc, state, name, ended_at, reason, reason_pub FROM pr_bk_vmday WHERE day >= ? AND day <= ?'),
    runsOfVm: db.prepare('SELECT ended_at, state FROM pr_bk_obs WHERE product = ? AND vm = ? ORDER BY ended_at DESC LIMIT 40'),
    obsOfVmDays: db.prepare('SELECT day, ended_at, state FROM pr_bk_obs WHERE product = ? AND vm = ? AND day >= ? AND day <= ?'),
    lastOkOfVm: db.prepare("SELECT ended_at FROM pr_bk_obs WHERE product = ? AND vm = ? AND state != 'fail' ORDER BY ended_at DESC LIMIT 1"),
    pruneObs: db.prepare('DELETE FROM pr_bk_obs WHERE rowid IN (SELECT rowid FROM pr_bk_obs WHERE day < ? LIMIT ?)'),
    pruneSeen: db.prepare('DELETE FROM pr_bk_seen WHERE rowid IN (SELECT rowid FROM pr_bk_seen WHERE day < ? LIMIT ?)'),
    pruneDay: db.prepare('DELETE FROM pr_bk_day WHERE rowid IN (SELECT rowid FROM pr_bk_day WHERE day < ? LIMIT ?)'),
    pruneVmDay: db.prepare('DELETE FROM pr_bk_vmday WHERE rowid IN (SELECT rowid FROM pr_bk_vmday WHERE day < ? LIMIT ?)'),
    countObs: db.prepare('SELECT COUNT(*) AS n FROM pr_bk_obs'),
    countDay: db.prepare('SELECT COUNT(*) AS n FROM pr_bk_day'),
    minFirstDay: db.prepare('SELECT MIN(first_day) AS d FROM pr_bk_cursor'),
  };
  _stFor = db;
  return _st;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* 이미 끝남 */ } throw e; }
}

/**
 * 관측 한 번을 쌓는다(한 트랜잭션).
 * @param {{obs:object[], seen:object[], now:number}} a backupLedger.observeOf 결과 + 관측 시각
 * @returns {Promise<{ok:boolean, inserted?:number, dirty?:Array<[string,string,number]>, reason?:string}>} dirty = 이미 확정한 날에 새로 들어온 관측(다시 확정할 법인 · 백업 · 날)
 */
export async function recordCapture({ obs = [], seen = [], now = Date.now() }) {
  const db = await getPeriodicDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  const st = stmts(db);
  try {
    return tx(db, () => {
      let inserted = 0;
      const dirty = new Map();
      for (const o of obs) {
        const day = dayOf(o.endedAt);
        const r = st.insObs.run(o.product, o.vm, o.endedAt, o.vc, day, o.state, o.startedAt ?? null, o.name || null, o.reason ?? null, o.reasonPub ?? null, o.runId ?? null, now);
        if (Number(r.changes) > 0) {
          inserted += 1;
          if (st.getDay.get(day, o.product, o.vc)) dirty.set(`${o.product}|${o.vc}|${day}`, [o.product, o.vc, day]);
        }
      }
      for (const s of seen) {
        const cur = st.getCursor.get(s.product, s.vc);
        const base = { last: cur?.last_at ?? null, first: cur?.first_day ?? null, sealedTo: cur?.sealed_to ?? null };
        if (s.fresh && s.dataAt != null) {
          const step = coverStep(base.last, s.dataAt, { dayOf, dayStartOf });
          if (step.advance) {
            for (const [d, gap] of step.gaps) st.gapSeen.run(s.product, s.vc, d, gap);
            const targets = Array.isArray(s.targets) ? JSON.stringify(s.targets.slice(0, TARGETS_MAX)) : null;
            st.freshSeen.run(s.product, s.vc, dayOf(s.dataAt), s.dataAt, s.dataAt, targets);
            const first = base.first ?? dayOf(s.dataAt);
            // 처음 적재하는 법인 · 백업 — 그 앞날은 확정하지 않는다(적재 전 · 소급 없음)
            st.putCursor.run(s.product, s.vc, s.dataAt, first, base.sealedTo ?? first - 1, now);
            continue;
          }
        } else st.staleSeen.run(s.product, s.vc, dayOf(now));
        if (cur) st.putCursor.run(s.product, s.vc, base.last, base.first, base.sealedTo, now);
      }
      return { ok: true, inserted, dirty: [...dirty.values()] };
    });
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 200) }; }
}

/** 법인 · 백업 · 날 하나를 확정해 쓴다(트랜잭션 안에서 부른다). */
function sealOneTx(st, product, vc, day, cursor, now) {
  const dayEnd = dayStartOf(day + 1);
  const seen = st.getSeen.get(product, vc, day);
  const status = sealStatus({ product, day, dayEnd, firstDay: cursor?.first_day ?? null, cursorAt: cursor?.last_at ?? null, seenRow: seen ? { maxGap: seen.max_gap } : null });
  if (status == null) return null;
  const prev = st.getDay.get(day, product, vc);
  const late = prev ? 1 : 0;
  st.delVmDay.run(day, product, vc);
  if (status !== 'known') {
    st.putDay.run(day, product, vc, 'unknown', null, null, null, null, null, null, now, late);
    return 'unknown';
  }
  const rows = st.obsOfDay.all(product, vc, day).map((r) => ({ vm: r.vm, endedAt: r.ended_at, state: r.state, name: r.name, reason: r.reason, reasonPub: r.reason_pub }));
  // 그날 신선한 관측이 없었는데 확정하는 경우(실행 기록으로 늦게 채움) — 대상 목록은 그 뒤 가장 가까운 날의 것(실행 없음 수의 근거)
  const targets = jsonOr(seen?.targets, null) ?? jsonOr(st.nextTargets.get(product, vc, day)?.targets, null);
  const { counts: c, last } = sealCounts(rows, targets);
  st.putDay.run(day, product, vc, 'known', c.targets, c.ended, c.ok, c.warn, c.fail, c.norun, now, late);
  for (const o of last) if (o.state !== 'ok') st.insVmDay.run(day, product, o.vm, vc, o.state, o.name || null, o.endedAt, o.reason ?? null, o.reasonPub ?? null);
  return 'known';
}

/**
 * 확정 — ① 날이 끝나고 SEAL_LAG 가 지난 날(법인 · 백업마다 확정한 다음 날부터) ② 이미 확정한 날에 늦게 들어온 관측(dirty)
 *   ③ 확인 불가였던 날 중 실행 기록이 남는 백업(Bareos · VM 백업)이고 REFILL_DAYS 안이며 그 뒤 신선하게 읽은 것. 한 트랜잭션.
 *   지금 등록에서 빠진 법인(마지막으로 본 시각이 그날 끝보다 앞)은 확정하지 않고 넘긴다(확인 불가 줄을 쌓지 않는다).
 * @returns {Promise<{ok:boolean, sealed?:number, resealed?:number, reason?:string}>}
 */
export async function sealDue({ now = Date.now(), dirty = [] } = {}) {
  const db = await getPeriodicDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  const st = stmts(db);
  const dueDay = dayOf(now - SEAL_LAG_MS) - 1;   // 끝난 지 SEAL_LAG 가 지난 마지막 날
  const rawFloor = dayOf(now) - RAW_KEEP_DAYS + 1;
  try {
    return tx(db, () => {
      let sealed = 0; let resealed = 0;
      const cursors = new Map(st.allCursors.all().map((c) => [`${c.product}|${c.vc}`, c]));
      for (const c of cursors.values()) {
        if (c.first_day == null) continue;
        let to = c.sealed_to ?? c.first_day - 1;
        const start = Math.max(to + 1, rawFloor);
        for (let d = start; d <= dueDay; d++) {
          // 그날이 끝난 뒤 이 법인 · 백업을 한 번도 보지 못했다(관측이 멈췄거나 등록에서 빠졌다) — 지금은 확정하지 않고 기다린다(건너뛰어 줄을 잃지 않게).
          if (c.active_at == null || c.active_at < dayStartOf(d + 1)) break;
          to = d;
          if (sealOneTx(st, c.product, c.vc, d, c, now) != null) sealed += 1;
        }
        if (to !== c.sealed_to) st.putCursor.run(c.product, c.vc, c.last_at, c.first_day, to, c.active_at);
      }
      const again = new Map((Array.isArray(dirty) ? dirty : []).filter((x) => x[2] >= rawFloor).map((x) => [x.join('|'), x]));
      for (const r of st.unknownRefill.all(dayOf(now) - REFILL_DAYS)) {
        if (!refillable(r.product)) continue;
        const c = cursors.get(`${r.product}|${r.vc}`);
        if (c?.last_at != null && c.last_at >= dayStartOf(r.day + 1)) again.set(`${r.product}|${r.vc}|${r.day}`, [r.product, r.vc, r.day]);
      }
      for (const [product, vc, day] of again.values()) {
        const c = cursors.get(`${product}|${vc}`);
        if (!c || day > (c.sealed_to ?? -Infinity)) continue;   // 아직 확정하지 않은 날 — ①이 한다
        if (sealOneTx(st, product, vc, day, c, now) != null) resealed += 1;
      }
      return { ok: true, sealed, resealed };
    });
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 200) }; }
}

/** 기간(날 d0 ~ d1, 둘 다 포함)의 확정 결과 · 실패 VM. DB 를 못 열면 null. */
export async function ledgerBetween(d0, d1) {
  const db = await getPeriodicDb();
  if (!db) return null;
  const st = stmts(db);
  const dayRows = st.daysBetween.all(d0, d1);
  const vmRows = st.vmDaysBetween.all(d0, d1).map((r) => ({ day: r.day, product: r.product, vm: r.vm, vc: r.vc, state: r.state, name: r.name, endedAt: r.ended_at, reason: r.reason, reasonPub: r.reason_pub }));
  const first = st.minFirstDay.get()?.d;
  return { dayRows, vmRows, firstDay: Number.isFinite(first) ? first : null };
}

/** VM 몇 대의 연속 실패 · 마지막 성공 · 최근 실행(관측 원본 — RAW_KEEP_DAYS 안 · 최근 40건). keys = [`${product}|${vm}`]. */
export async function vmFacts(keys) {
  const db = await getPeriodicDb();
  if (!db) return new Map();
  const st = stmts(db);
  const out = new Map();
  for (const k of keys || []) {
    const i = k.indexOf('|');
    const product = k.slice(0, i); const vm = k.slice(i + 1);
    if (!PRODUCTS.includes(product) || !vm) continue;
    const runs = st.runsOfVm.all(product, vm).map((r) => ({ endedAt: r.ended_at, state: r.state }));
    out.set(k, { streak: failStreak(runs), lastOkAt: st.lastOkOfVm.get(product, vm)?.ended_at ?? null, runs });
  }
  return out;
}

/** VM 몇 대의 날마다 마지막 결과(주간 줄무늬). */
export async function vmDayStates(keys, d0, d1) {
  const db = await getPeriodicDb();
  if (!db) return new Map();
  const st = stmts(db);
  const out = new Map();
  for (const k of keys || []) {
    const i = k.indexOf('|');
    const product = k.slice(0, i); const vm = k.slice(i + 1);
    const last = new Map();
    for (const r of st.obsOfVmDays.all(product, vm, d0, d1)) { const cur = last.get(r.day); if (!cur || r.ended_at > cur.at) last.set(r.day, { at: r.ended_at, state: r.state }); }
    out.set(k, [...last.entries()].map(([day, v]) => ({ day, state: v.state })));
  }
  return out;
}

const _prune = createPruneFlight();
/** 관측 원본 · 범위는 RAW_KEEP_DAYS, 확정 결과는 keepDays 밖을 청크로 지운다. */
export async function pruneBackup(keepDays, now = Date.now()) {
  const db = await getPeriodicDb();
  if (!db) return { deleted: 0 };
  return _prune.run('all', async () => {
    const st = stmts(db);
    const today = dayOf(now);
    let deleted = 0;
    deleted += Number((await chunkedDelete(st.pruneObs, [today - RAW_KEEP_DAYS], { label: 'periodic.bk.obs' }))?.deleted) || 0;
    deleted += Number((await chunkedDelete(st.pruneSeen, [today - RAW_KEEP_DAYS], { label: 'periodic.bk.seen' }))?.deleted) || 0;
    const keep = Number(keepDays);
    if (Number.isFinite(keep) && keep > 0) {
      deleted += Number((await chunkedDelete(st.pruneDay, [today - keep], { label: 'periodic.bk.day' }))?.deleted) || 0;
      deleted += Number((await chunkedDelete(st.pruneVmDay, [today - keep], { label: 'periodic.bk.vmday' }))?.deleted) || 0;
    }
    return { deleted };
  });
}

/** 화면 '적재 상태' — 행 수 · 적재 시작 날. */
export async function backupLedgerInfo() {
  const db = await getPeriodicDb();
  if (!db) return null;
  const st = stmts(db);
  const first = st.minFirstDay.get()?.d;
  return { obs: st.countObs.get()?.n ?? 0, days: st.countDay.get()?.n ?? 0, firstDay: Number.isFinite(first) ? first : null, firstDayAt: Number.isFinite(first) ? dayStartOf(first) : null };
}

export function _resetBackupStoreForTest() { _st = null; _stFor = null; }
export { DAY };
