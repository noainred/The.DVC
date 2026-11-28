/**
 * periodic/backupStore.js — 백업 적재(3절)의 DB 읽기 · 쓰기. 표는 db.js BACKUP_SCHEMA(periodic.db 안).
 *   규칙은 backupLedger.js(순수), 틱 · 조립 연결은 backupService.js.
 * 규약(perf-db): 관측 한 번 · 확정 한 묶음은 트랜잭션(안에 await 없음) — 큰 첫 관측은 관측 줄을 조각 트랜잭션으로 나누고 사이에 양보한다(OR IGNORE 라 멱등) ·
 *   기간 조회 · 연속 실패 조회는 조각 사이에 시간 기준 양보(createYielder) · 정리는 날로 시작하는 키 + 시간 기준 청크 · '키별 최신' 을 GROUP BY + MAX 로 만들지 않는다
 *   (그날 VM 마다 마지막 결과는 행을 읽어 JS 로 고른다 — 법인 · 날 하나라 행 수가 작다). DB 를 못 열면 null(빈 목록과 구분).
 */
import { getPeriodicDb } from './db.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { createYielder } from '../util/timeSlice.js';
import { dayIndex, dayStartMs } from '../util/dayKey.js';
import { coverSegments, sealStatus, sealCounts, refillable, failStreak, SEAL_LAG_MS, REFILL_DAYS, RAW_KEEP_DAYS, PRODUCTS } from './backupLedger.js';

const DAY = 86_400_000;
const dayOf = (t) => dayIndex(t);
const dayStartOf = (d) => dayStartMs(d);
const jsonOr = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const TARGETS_MAX = 20_000;
/** 관측 줄을 한 트랜잭션에 넣는 상한 — 첫 관측(수만 줄)이 이벤트 루프를 수백 ms 막지 않게(성능 축 P4). */
const OBS_TX_MAX = 4_000;
/** 확정이 밀렸을 때 법인 · 백업 하나가 한 번에 확정하는 날 수(나머지는 다음 관측 — 성능 축 P6). */
const SEAL_BATCH_DAYS = 7;
/** 기간 조회 조각(날). */
const READ_SLICE_DAYS = 7;

let _st = null; let _stFor = null;
/** 그날 대상 목록을 마지막으로 쓴 글자(같으면 다시 쓰지 않는다 — 성능 축 P7 · 재시작 뒤 첫 관측은 한 번 쓴다). */
const _targetsSig = new Map();

function stmts(db) {
  if (_stFor === db && _st) return _st;
  _st = {
    insObs: db.prepare(`INSERT OR IGNORE INTO pr_bk_obs(product, vm, ended_at, vc, day, state, started_at, name, reason, reason_pub, run_id, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getCursor: db.prepare('SELECT product, vc, last_at, first_day, sealed_to, active_at, src FROM pr_bk_cursor WHERE product = ? AND vc = ?'),
    allCursors: db.prepare('SELECT product, vc, last_at, first_day, sealed_to, active_at, src FROM pr_bk_cursor'),
    putCursor: db.prepare(`INSERT INTO pr_bk_cursor(product, vc, last_at, first_day, sealed_to, active_at, src) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product, vc) DO UPDATE SET last_at = excluded.last_at, first_day = excluded.first_day, sealed_to = excluded.sealed_to, active_at = excluded.active_at, src = excluded.src`),
    gapSeen: db.prepare(`INSERT INTO pr_bk_seen(product, vc, day, max_gap, lossy) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(product, vc, day) DO UPDATE SET max_gap = MAX(max_gap, excluded.max_gap), lossy = MAX(lossy, excluded.lossy)`),
    freshSeen: db.prepare(`INSERT INTO pr_bk_seen(product, vc, day, first_at, last_at, n_fresh, targets) VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(product, vc, day) DO UPDATE SET first_at = COALESCE(first_at, excluded.first_at), last_at = excluded.last_at, n_fresh = n_fresh + 1,
        targets = COALESCE(excluded.targets, targets)`),
    staleSeen: db.prepare(`INSERT INTO pr_bk_seen(product, vc, day, n_stale) VALUES (?, ?, ?, 1)
      ON CONFLICT(product, vc, day) DO UPDATE SET n_stale = n_stale + 1`),
    getSeen: db.prepare('SELECT first_at, last_at, max_gap, lossy, n_fresh, n_stale, targets FROM pr_bk_seen WHERE product = ? AND vc = ? AND day = ?'),
    obsOfDay: db.prepare('SELECT vm, ended_at, state, name, reason, reason_pub FROM pr_bk_obs WHERE product = ? AND vc = ? AND day = ?'),
    getDay: db.prepare('SELECT status, sealed_at FROM pr_bk_day WHERE day = ? AND product = ? AND vc = ?'),
    putDay: db.prepare(`INSERT INTO pr_bk_day(day, product, vc, status, targets, ended, ok, warn, fail, norun, sealed_at, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, product, vc) DO UPDATE SET status = excluded.status, targets = excluded.targets, ended = excluded.ended, ok = excluded.ok, warn = excluded.warn,
        fail = excluded.fail, norun = excluded.norun, sealed_at = excluded.sealed_at, late = excluded.late`),
    delVmDay: db.prepare('DELETE FROM pr_bk_vmday WHERE day = ? AND product = ? AND vc = ?'),
    insVmDay: db.prepare(`INSERT OR REPLACE INTO pr_bk_vmday(day, product, vm, vc, state, name, ended_at, reason, reason_pub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    unknownRefill: db.prepare("SELECT day, product, vc FROM pr_bk_day WHERE day >= ? AND status = 'unknown'"),
    daysBetween: db.prepare('SELECT day, product, vc, status, targets, ended, ok, warn, fail, norun FROM pr_bk_day WHERE day >= ? AND day <= ?'),
    vmFailsBetween: db.prepare("SELECT day, product, vm, vc, state, name, ended_at, reason, reason_pub FROM pr_bk_vmday WHERE day >= ? AND day <= ? AND state = 'fail'"),
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

/** 관측 줄 묶음 넣기(트랜잭션 안) — 새로 넣은 수 · 이미 확정한 날에 새로 들어온 줄(다시 확정할 법인 · 백업 · 날). */
function insertObs(st, list, now, dirty) {
  let inserted = 0;
  for (const o of list) {
    const day = dayOf(o.endedAt);
    const r = st.insObs.run(o.product, o.vm, o.endedAt, o.vc, day, o.state, o.startedAt ?? null, o.name || null, o.reason ?? null, o.reasonPub ?? null, o.runId ?? null, now);
    if (Number(r.changes) > 0) {
      inserted += 1;
      if (st.getDay.get(day, o.product, o.vc)) dirty.set(`${o.product}|${o.vc}|${day}`, [o.product, o.vc, day]);
    }
  }
  return inserted;
}

/**
 * 관측 한 번을 쌓는다. 관측 줄이 많으면(첫 관측) 앞 조각들을 따로 트랜잭션으로 넣고 사이에 양보한 뒤, 마지막 트랜잭션이 나머지 줄 · 관측 범위 · 커서를 쓴다.
 * @param {{obs:object[], seen:object[], now:number}} a backupLedger.observeOf 결과 + 관측 시각
 * @returns {Promise<{ok:boolean, inserted?:number, dirty?:Array<[string,string,number]>, reason?:string}>}
 */
export async function recordCapture({ obs = [], seen = [], now = Date.now() }) {
  const db = await getPeriodicDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  const st = stmts(db);
  const dirty = new Map();
  let inserted = 0;
  try {
    let i = 0;
    while (obs.length - i > OBS_TX_MAX) {
      const part = obs.slice(i, i + OBS_TX_MAX);
      inserted += tx(db, () => insertObs(st, part, now, dirty));
      i += OBS_TX_MAX;
      await new Promise((r) => setImmediate(r));
    }
    const rest = i ? obs.slice(i) : obs;
    const sigs = [];   // 커밋한 뒤에만 기억한다(되돌린 트랜잭션이 '썼다' 로 남지 않게)
    tx(db, () => {
      inserted += insertObs(st, rest, now, dirty);
      for (const s of seen) {
        const cur = st.getCursor.get(s.product, s.vc);
        const base = { last: cur?.last_at ?? null, first: cur?.first_day ?? null, sealedTo: cur?.sealed_to ?? null, src: cur?.src ?? null };
        if (s.fresh && s.dataAt != null) {
          const step = coverSegments(base.last, s.dataAt, { dayOf, dayStartOf, product: s.product, horizon: s.horizon, windowMs: s.windowMs });
          if (step.advance) {
            // 결과 출처가 바뀌었으면(복제 — 담당 엣지 교대 · 중앙 ↔ 엣지) 그 틈은 잃은 틈 — 옛 출처가 끝낸 실행을 새 출처 기록은 모른다(반증 F5)
            const srcChanged = s.src != null && base.src != null && s.src !== base.src;
            for (const [d, gap, lossy] of step.segs) st.gapSeen.run(s.product, s.vc, d, gap, lossy || srcChanged ? 1 : 0);
            const day = dayOf(s.dataAt);
            let targets = Array.isArray(s.targets) ? JSON.stringify(s.targets.slice(0, TARGETS_MAX)) : null;
            const sk = `${s.product}|${s.vc}|${day}`;
            if (targets != null && _targetsSig.get(sk) === targets) targets = null;   // 같은 목록 — 다시 쓰지 않는다(COALESCE 가 둔다)
            else if (targets != null) sigs.push([sk, targets]);
            st.freshSeen.run(s.product, s.vc, day, s.dataAt, s.dataAt, targets);
            const first = base.first ?? dayOf(s.dataAt);
            // 처음 적재하는 법인 · 백업 — 그 앞날은 확정하지 않는다(적재 전 · 소급 없음)
            st.putCursor.run(s.product, s.vc, s.dataAt, first, base.sealedTo ?? first - 1, now, s.src ?? base.src);
            continue;
          }
        } else st.staleSeen.run(s.product, s.vc, dayOf(now));
        if (cur) st.putCursor.run(s.product, s.vc, base.last, base.first, base.sealedTo, now, base.src);
      }
    });
    for (const [k, v] of sigs) { _targetsSig.delete(k); _targetsSig.set(k, v); }
    while (_targetsSig.size > 2_000) _targetsSig.delete(_targetsSig.keys().next().value);
    return { ok: true, inserted, dirty: [...dirty.values()] };
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 200), inserted }; }
}

/** 법인 · 백업 · 날 하나를 확정해 쓴다(트랜잭션 안에서 부른다). */
function sealOneTx(st, product, vc, day, cursor, now) {
  const dayEnd = dayStartOf(day + 1);
  const seen = st.getSeen.get(product, vc, day);
  const status = sealStatus({ product, day, dayEnd, firstDay: cursor?.first_day ?? null, cursorAt: cursor?.last_at ?? null,
    seenRow: seen ? { maxGap: seen.max_gap, lossy: Number(seen.lossy) > 0 } : null });
  if (status == null) return null;
  const prev = st.getDay.get(day, product, vc);
  const late = prev ? 1 : 0;
  st.delVmDay.run(day, product, vc);
  if (status !== 'known') {
    st.putDay.run(day, product, vc, 'unknown', null, null, null, null, null, null, now, late);
    return 'unknown';
  }
  const rows = st.obsOfDay.all(product, vc, day).map((r) => ({ vm: r.vm, endedAt: r.ended_at, state: r.state, name: r.name, reason: r.reason, reasonPub: r.reason_pub }));
  // 대상 목록은 그날 신선한 관측의 것만 — 없으면(그날 내내 못 읽고 늦게 채운 날) 대상 · 실행 없음은 모름(null). 다른 날 목록으로 지어내지 않는다(반증 F3 · R1).
  const targets = jsonOr(seen?.targets, null);
  const { counts: c, last } = sealCounts(rows, targets);
  st.putDay.run(day, product, vc, 'known', c.targets, c.ended, c.ok, c.warn, c.fail, c.norun, now, late);
  for (const o of last) if (o.state === 'fail') st.insVmDay.run(day, product, o.vm, vc, o.state, o.name || null, o.endedAt, o.reason ?? null, o.reasonPub ?? null);
  return 'known';
}

/**
 * 확정 — ① 날이 끝나고 SEAL_LAG 가 지난 날(법인 · 백업마다 확정한 다음 날부터 · 한 번에 SEAL_BATCH_DAYS 까지) ② 이미 확정한 날에 늦게 들어온 관측(dirty)
 *   ③ 확인 불가였던 날 중 실행 기록이 남는 백업(Bareos · VM 백업)이고 REFILL_DAYS 안이며 그 뒤 신선하게 읽은 것(잃은 틈이 있던 날은 다시 확정해도 확인 불가). 한 트랜잭션.
 *   지금 등록에서 빠진 법인(마지막으로 본 시각이 그날 끝보다 앞)은 확정하지 않고 기다린다 — 3절은 그 줄을 '확정 대기' 로 확인 불가에 넣는다(pendingOf).
 * @returns {Promise<{ok:boolean, sealed?:number, resealed?:number, reason?:string}>}
 */
export async function sealDue({ now = Date.now(), dirty = [] } = {}) {
  const db = await getPeriodicDb();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  const st = stmts(db);
  const dueDay = dueDayOf(now);
  const rawFloor = dayOf(now) - RAW_KEEP_DAYS + 1;
  try {
    return tx(db, () => {
      let sealed = 0; let resealed = 0;
      const cursors = new Map(st.allCursors.all().map((c) => [`${c.product}|${c.vc}`, c]));
      for (const c of cursors.values()) {
        if (c.first_day == null) continue;
        let to = c.sealed_to ?? c.first_day - 1;
        const start = Math.max(to + 1, rawFloor);
        for (let d = start; d <= Math.min(dueDay, start + SEAL_BATCH_DAYS - 1); d++) {
          // 그날이 끝난 뒤 이 법인 · 백업을 한 번도 보지 못했다(관측이 멈췄거나 등록에서 빠졌다) — 지금은 확정하지 않고 기다린다(건너뛰어 줄을 잃지 않게).
          if (c.active_at == null || c.active_at < dayStartOf(d + 1)) break;
          to = d;
          if (sealOneTx(st, c.product, c.vc, d, c, now) != null) sealed += 1;
        }
        if (to !== c.sealed_to) st.putCursor.run(c.product, c.vc, c.last_at, c.first_day, to, c.active_at, c.src ?? null);
      }
      const again = new Map((Array.isArray(dirty) ? dirty : []).filter((x) => x[2] >= rawFloor).map((x) => [x.join('|'), x]));
      for (const r of st.unknownRefill.all(dayOf(now) - REFILL_DAYS)) {
        if (!refillable(r.product)) continue;
        const c = cursors.get(`${r.product}|${r.vc}`);
        if (c?.last_at == null || c.last_at < dayStartOf(r.day + 1)) continue;
        const seen = st.getSeen.get(r.product, r.vc, r.day);
        if (seen && Number(seen.lossy) > 0) continue;   // 잃은 틈이 있던 날 — 다시 봐도 확인 불가(매 관측 같은 일을 되풀이하지 않는다)
        again.set(`${r.product}|${r.vc}|${r.day}`, [r.product, r.vc, r.day]);
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

/** 확정할 때가 된 마지막 날(날이 끝나고 SEAL_LAG 가 지난 날). */
export const dueDayOf = (now) => dayOf(now - SEAL_LAG_MS) - 1;

/**
 * 기간의 확정 결과(앞 기간 p0 부터 이번 기간 끝 d1 까지 — 작다) · 이번 기간(d0 ~ d1)의 실패 VM 줄(조각 사이 양보) · 적재 시작 날 · 확정 대기 줄.
 *   DB 를 못 열면 null.
 */
export async function ledgerFor({ p0, d0, d1, now = Date.now() }) {
  const db = await getPeriodicDb();
  if (!db) return null;
  const st = stmts(db);
  const maybeYield = createYielder(15);
  const dayRows = st.daysBetween.all(p0, d1);
  await maybeYield();
  const vmRows = [];
  for (let a = d0; a <= d1; a += READ_SLICE_DAYS) {
    for (const r of st.vmFailsBetween.all(a, Math.min(d1, a + READ_SLICE_DAYS - 1))) {
      vmRows.push({ day: r.day, product: r.product, vm: r.vm, vc: r.vc, state: r.state, name: r.name, endedAt: r.ended_at, reason: r.reason, reasonPub: r.reason_pub });
    }
    await maybeYield();
  }
  const first = st.minFirstDay.get()?.d;
  return { dayRows, vmRows, firstDay: Number.isFinite(first) ? first : null, pending: pendingOf(st.allCursors.all(), dayRows, { d0: p0, d1, dueDay: dueDayOf(now) }) };
}

/** 이보다 오래 보지 못한 법인 · 백업은 '없어졌다' 로 본다 — 확정 대기로 세지 않는다(지운 vCenter 가 앞으로의 모든 회차에 확인 불가로 남지 않게). */
export const RETIRE_MS = 7 * DAY;
/** 확정할 때가 지났는데 아직 확정하지 않은(그 법인을 날 끝 뒤 보지 못해 기다리는) 법인 · 백업 · 날(순수). */
export function pendingOf(cursors, dayRows, { d0, d1, dueDay }) {
  const have = new Set((dayRows || []).map((r) => `${r.day}|${r.product}|${r.vc}`));
  const out = [];
  for (const c of cursors || []) {
    if (c.first_day == null || c.active_at == null) continue;
    const from = Math.max(d0, c.first_day, (c.sealed_to ?? c.first_day - 1) + 1);
    for (let d = from; d <= Math.min(d1, dueDay); d++) {
      if (c.active_at < dayStartOf(d) - RETIRE_MS) break;
      if (!have.has(`${d}|${c.product}|${c.vc}`)) out.push({ product: c.product, vc: c.vc, day: d });
    }
  }
  return out;
}

/** VM 몇 대의 연속 실패 · 마지막 성공 · 최근 실행(관측 원본 — RAW_KEEP_DAYS 안 · 최근 40건). keys = [`${product}|${vm}`]. 키 사이 양보(성능 축 P2). */
export async function vmFacts(keys) {
  const db = await getPeriodicDb();
  if (!db) return new Map();
  const st = stmts(db);
  const maybeYield = createYielder(15);
  const out = new Map();
  for (const k of keys || []) {
    const i = k.indexOf('|');
    const product = k.slice(0, i); const vm = k.slice(i + 1);
    if (!PRODUCTS.includes(product) || !vm) continue;
    const runs = st.runsOfVm.all(product, vm).map((r) => ({ endedAt: r.ended_at, state: r.state }));
    out.set(k, { streak: failStreak(runs), lastOkAt: st.lastOkOfVm.get(product, vm)?.ended_at ?? null, runs });
    await maybeYield();
  }
  return out;
}

/** VM 몇 대의 날마다 마지막 결과(주간 줄무늬). 키 사이 양보. */
export async function vmDayStates(keys, d0, d1) {
  const db = await getPeriodicDb();
  if (!db) return new Map();
  const st = stmts(db);
  const maybeYield = createYielder(15);
  const out = new Map();
  for (const k of keys || []) {
    const i = k.indexOf('|');
    const product = k.slice(0, i); const vm = k.slice(i + 1);
    const last = new Map();
    for (const r of st.obsOfVmDays.all(product, vm, d0, d1)) { const cur = last.get(r.day); if (!cur || r.ended_at > cur.at) last.set(r.day, { at: r.ended_at, state: r.state }); }
    out.set(k, [...last.entries()].map(([day, v]) => ({ day, state: v.state })));
    await maybeYield();
  }
  return out;
}

const _prune = createPruneFlight();
/** 관측 원본 · 범위는 RAW_KEEP_DAYS, 확정 결과는 keepDays 밖을 시간 기준 청크로 지운다(한 청크 50ms 목표 — 성능 축 P3). */
export async function pruneBackup(keepDays, now = Date.now()) {
  const db = await getPeriodicDb();
  if (!db) return { deleted: 0 };
  return _prune.run('all', async () => {
    const st = stmts(db);
    const today = dayOf(now);
    const o = (label) => ({ label, targetMs: 50 });
    let deleted = 0;
    deleted += Number((await chunkedDelete(st.pruneObs, [today - RAW_KEEP_DAYS], o('periodic.bk.obs')))?.deleted) || 0;
    deleted += Number((await chunkedDelete(st.pruneSeen, [today - RAW_KEEP_DAYS], o('periodic.bk.seen')))?.deleted) || 0;
    const keep = Number(keepDays);
    if (Number.isFinite(keep) && keep > 0) {
      deleted += Number((await chunkedDelete(st.pruneDay, [today - keep], o('periodic.bk.day')))?.deleted) || 0;
      deleted += Number((await chunkedDelete(st.pruneVmDay, [today - keep], o('periodic.bk.vmday')))?.deleted) || 0;
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

export function _resetBackupStoreForTest() { _st = null; _stFor = null; _targetsSig.clear(); }
export { DAY };
