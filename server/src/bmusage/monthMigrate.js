/**
 * bmusage/monthMigrate.js — 예전 메인 파일 표(usage_history 원시 90일 · usage_daily 일 롤업)를 시간 단위 파일로 옮긴다(v2.922 · 3a).
 *
 * ── 절차(위험한 수정 — 데이터 보존. 순서를 테스트가 고정한다: bmPerf2921Migrate.test.js) ─────────────────────────
 *   ① copy-raw   예전 원시를 rowid 순 청크로 읽어 → 5분 월 파일(INSERT OR IGNORE · 원시 보존보다 오래된 행은 원시로 옮기지 않는다)
 *                + 1시간 롤업(모든 행 — 파일마다 `_mig` 커서를 **같은 트랜잭션**에서 올려 다시 돌려도 한 번만 더한다).
 *   ② copy-daily 예전 일 롤업 → 1일 연 파일의 사본 표(usage_daily_mig · INSERT OR IGNORE).
 *   ③ verify     **행 수 대조** — 달마다 예전 원시 수 ≤ 월 파일 수, 해마다 예전 일 롤업 수 ≤ 사본 수(≤ 인 이유: 같은 구간에 새 코드가 쓴 행
 *                — 데모 백필 — 이 더해질 수 있다. 모자라면 실패). 대조 전에는 **아무것도 지우지 않는다**.
 *   ④ delete     대조가 통과한 뒤에만 예전 표를 청크로 지운다(rowid ≤ 시작 시 최대 rowid — 경계 밖 행은 건드리지 않는다).
 *   ⑤ done.
 * ── 블로킹 금지 · 재개 ────────────────────────────────────────────────────────
 *   청크(기본 2,000행)마다 시간 기준 양보(createYielder). 진행 상태(커서·단계·센 수)는 청크마다 메인 파일 bm_meta 에 남는다 —
 *   프로세스가 중간에 죽어도 다음 기동이 그 커서부터 잇는다(원시는 IGNORE, 롤업은 파일별 커서라 두 번 더하지 않는다).
 * ── 실패 ─────────────────────────────────────────────────────────────────────
 *   어느 단계든 실패하면 phase='failed'(failedPhase·error·attempts). 그동안 읽기는 **예전 표**가 그 구간의 원본이다(db.readRule) — 이것은
 *   historyRollup 의 ‘원본 폴백’(롤업 대신 원시를 읽는 것)과 다른 일이고 정상 경로다. 한 시간 뒤 다시 시도하고(최대 3회) 그 뒤에는 멈춰 상태로 밝힌다.
 *   대조 실패면 커서를 0 으로 돌려 처음부터 다시 옮긴다(IGNORE · 커서라 중복은 생기지 않는다).
 */
import { mainDbForMigration, readMeta, writeMeta, MIGRATE_KEY } from './db.js';
import * as month from './monthStore.js';
import { createYielder } from '../util/timeSlice.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { loadBmUsageSettings, effectiveRawDays, STORE_DEFAULTS } from './settings.js';
import { dayKey } from '../util/dayKey.js';

export const MIGRATE_CHUNK_ROWS = Math.max(100, Number(process.env.BMUSAGE_MIGRATE_CHUNK_ROWS) || 2_000);
export const MIGRATE_RETRY_MS = 60 * 60_000;
export const MIGRATE_MAX_ATTEMPTS = 3;
const DAY_MS = 86_400_000;

let _running = null;
let _last = null;
export function migrationLast() { return _last; }

function groupByAgent(rows) {
  const m = new Map();
  for (const r of rows) { const a = String(r.agent ?? ''); if (!m.has(a)) m.set(a, []); m.get(a).push(r); }
  return m;
}
function failIfErrors(res, what) {
  if (res && res.ok === false) throw new Error(`${what}: ${(res.errors || []).slice(0, 2).join(' · ') || '쓰기 실패'}`);
}

/**
 * 한 번 돌린다(진행 중이면 공유). 단계가 끝나면 다음 단계로 이어 done 까지 간다 — stopAfterChunks 는 중단 시험용.
 * @param {{chunkRows?:number, sliceMs?:number, stopAfterChunks?:number, now?:number, hooks?:object}} opt
 */
export function runMonthMigration(opt = {}) {
  if (_running) return _running;
  _running = runInner(opt).finally(() => { _running = null; });
  return _running;
}
/** 폴러 틱에서 부른다 — 끝났거나 없으면 아무것도 하지 않는다(기다리지 않는다). */
export function ensureMonthMigration() {
  if (_running) return false;
  runMonthMigration().catch(() => {});
  return true;
}

async function runInner({ chunkRows = MIGRATE_CHUNK_ROWS, sliceMs = 15, stopAfterChunks = Infinity, now = Date.now(), hooks = {} } = {}) {
  const db = await mainDbForMigration();
  if (!db) return { ok: false, reason: 'db-unavailable' };
  let st = readMeta(db, MIGRATE_KEY);
  if (!st || st.phase === 'none' || st.phase === 'done') return { ok: true, phase: st?.phase || 'none' };
  if (st.phase === 'failed') {
    if ((st.attempts || 0) >= MIGRATE_MAX_ATTEMPTS) return { ok: false, phase: 'failed', reason: 'attempts-exhausted' };
    if (now - (st.failedAt || 0) < MIGRATE_RETRY_MS && !hooks.retryNow) return { ok: false, phase: 'failed', reason: 'retry-wait' };
    st = { ...st, phase: st.failedPhase === 'verify' ? 'copy-raw' : (st.failedPhase || 'copy-raw'), error: null };
    if (st.failedPhase === 'verify') { st.rawCursor = 0; st.dailyCursor = 0; st.rawCopied = false; }
  }
  const s = (() => { try { return loadBmUsageSettings(); } catch { return null; } })();
  const rawDays = effectiveRawDays(s || {});
  const hourlyDays = s?.store?.hourlyDays || STORE_DEFAULTS.hourlyDays;
  if (st.rawCopyFrom == null) st.rawCopyFrom = now - rawDays * DAY_MS;
  const hourlyFrom = now - hourlyDays * DAY_MS;
  const save = () => { st.updatedAt = Date.now(); writeMeta(db, MIGRATE_KEY, st); };
  const maybeYield = createYielder(sliceMs);
  let chunks = 0;
  const t0 = Date.now();
  try {
    // ① copy-raw
    if (st.phase === 'copy-raw') {
      const sel = db.prepare('SELECT rowid AS _rid, * FROM usage_history WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?');
      for (;;) {
        const rows = sel.all(st.rawCursor || 0, st.rawMaxRowid || 0, chunkRows);
        if (!rows.length) { st.phase = 'copy-daily'; st.rawCopied = true; save(); break; }
        for (const [agent, list] of groupByAgent(rows)) {
          const recent = list.filter((r) => Number(r.ts) >= st.rawCopyFrom);
          const w = await month.writeServerRows(recent, agent, { rollup: false });
          failIfErrors(w, '원시 옮기기');
          st.copied.raw += w.inserted; st.copied.rawDup += w.duplicates; st.copied.rawOld += list.length - recent.length;
          const forHour = list.filter((r) => Number(r.ts) >= hourlyFrom);
          const h = await month.rollupServerRows(forHour, agent, { ok: true, errors: [] }, { daily: false, migKey: 'legacy_raw', migRowid: '_rid' });
          failIfErrors(h, '1시간 롤업');
          st.copied.hourly += forHour.length;
        }
        st.rawCursor = Number(rows.at(-1)._rid);
        save();
        if (hooks.afterRawChunk) await hooks.afterRawChunk(st);
        chunks += 1;
        if (chunks >= stopAfterChunks) return { ok: true, phase: st.phase, interrupted: true, chunks };
        await maybeYield();
      }
    }
    // ② copy-daily
    if (st.phase === 'copy-daily') {
      const sel = db.prepare('SELECT rowid AS _rid, * FROM usage_daily WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?');
      for (;;) {
        const rows = sel.all(st.dailyCursor || 0, st.dailyMaxRowid || 0, chunkRows);
        if (!rows.length) { st.phase = 'verify'; save(); break; }
        const w = await month.writeDailyMigRows(rows);
        failIfErrors(w, '일 롤업 옮기기');
        st.copied.daily += w.inserted; st.copied.dailyDup += w.duplicates;
        st.dailyCursor = Number(rows.at(-1)._rid);
        save();
        chunks += 1;
        if (chunks >= stopAfterChunks) return { ok: true, phase: st.phase, interrupted: true, chunks };
        await maybeYield();
      }
    }
    // ③ verify — 행 수 대조(지우기 전에)
    if (st.phase === 'verify') {
      if (hooks.beforeVerify) await hooks.beforeVerify(st);
      const v = await verifyCounts(db, st, maybeYield);
      st.verify = v;
      if (!v.ok) throw Object.assign(new Error(`행 수 대조 실패: ${v.mismatch.slice(0, 3).map((x) => `${x.period} 예전 ${x.legacy} > 사본 ${x.target ?? '파일 없음'}`).join(' · ')}`), { phase: 'verify' });
      st.phase = 'delete'; save();
    }
    // ④ delete — 대조 통과 뒤에만
    if (st.phase === 'delete') {
      if (st.verify?.ok !== true) throw Object.assign(new Error('대조 기록 없이 삭제 단계에 들어왔습니다 — 지우지 않습니다.'), { phase: 'verify' });
      st.deleted = st.deleted || { raw: 0, daily: 0 };
      for (const [table, maxRid, k] of [['usage_history', st.rawMaxRowid, 'raw'], ['usage_daily', st.dailyMaxRowid, 'daily']]) {
        for (;;) {
          const r = await chunkedDelete(db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE rowid <= ? LIMIT ?)`), [maxRid || 0], { chunk: chunkRows, label: `bmusage.migrate.${table}` });
          st.deleted[k] += r.deleted; save();
          if (r.done || !r.deleted) break;
        }
      }
      st.phase = 'done'; st.doneAt = Date.now(); save();
      console.log(`[bmusage-db] 시간 단위 파일 마이그레이션 완료 — 원시 ${st.copied.raw}행(보존 밖 ${st.copied.rawOld}행은 1시간 롤업만) · 일 롤업 ${st.copied.daily}행 · 예전 표 삭제 ${st.deleted.raw}+${st.deleted.daily}행. ⚠ 메인 파일 크기는 VACUUM 전에는 줄지 않습니다.`);
    }
    _last = { at: Date.now(), ms: Date.now() - t0, ok: true, phase: st.phase, chunks };
    return { ok: true, phase: st.phase, chunks };
  } catch (e) {
    const failedPhase = e?.phase || st.phase;
    st = { ...st, phase: 'failed', failedPhase, failedAt: Date.now(), attempts: (st.attempts || 0) + 1, error: String(e?.message || e).slice(0, 300) };
    try { save(); } catch { /* 상태 저장도 실패하면 콘솔만 */ }
    console.error(`[bmusage-db] 시간 단위 파일 마이그레이션 실패(${failedPhase}) — 예전 표를 계속 읽습니다(아무것도 지우지 않았습니다): ${st.error}`);
    _last = { at: Date.now(), ms: Date.now() - t0, ok: false, phase: 'failed', failedPhase, error: st.error };
    return { ok: false, phase: 'failed', failedPhase, error: st.error };
  }
}

/**
 * 행 수 대조(순서: 지우기 전). 원시: 달마다 [max(달 시작, 옮긴 하한), min(달 끝, legacyMaxTs+1)) 의 예전 행 수 ≤ 월 파일 행 수.
 *   일 롤업: 해마다 예전 행 수 ≤ 사본 표 행 수. 각 COUNT 는 문장마다 집계 하나다.
 */
export async function verifyCounts(db, st, maybeYield = async () => {}) {
  const mismatch = []; const checked = [];
  const lo = Math.max(st.rawCopyFrom ?? 0, st.legacyMinTs ?? 0);
  const hi = (st.legacyMaxTs ?? -1) + 1;
  if (st.legacyMaxTs != null && hi > lo) {
    for (const k of month.periodsInWindow('raw', lo, hi - 1)) {
      const [a, b] = month.periodRange('raw', k);
      const from = Math.max(a, lo); const to = Math.min(b, hi);
      const legacy = Number(db.prepare('SELECT COUNT(*) c FROM usage_history WHERE ts >= ? AND ts < ? AND rowid <= ?').get(from, to, st.rawMaxRowid || 0)?.c ?? 0);
      const target = await month.countInPeriod('raw', k, 'usage_history', 'ts', from, to);
      checked.push({ period: k, kind: 'raw', legacy, target });
      if (legacy > 0 && (target == null || target < legacy)) mismatch.push({ period: k, kind: 'raw', legacy, target });
      await maybeYield();
    }
  }
  const years = new Set();
  const maxDay = db.prepare('SELECT MAX(day) v FROM usage_daily WHERE rowid <= ?').get(st.dailyMaxRowid || 0)?.v;
  const minDay = db.prepare('SELECT MIN(day) v FROM usage_daily WHERE rowid <= ?').get(st.dailyMaxRowid || 0)?.v;
  if (minDay && maxDay) for (let y = Number(minDay.slice(0, 4)); y <= Number(maxDay.slice(0, 4)); y++) years.add(String(y));
  for (const y of years) {
    const legacy = Number(db.prepare('SELECT COUNT(*) c FROM usage_daily WHERE day >= ? AND day < ? AND rowid <= ?').get(`${y}-01-01`, `${Number(y) + 1}-01-01`, st.dailyMaxRowid || 0)?.c ?? 0);
    const target = await month.countInPeriod('d1', y, 'usage_daily_mig', 'day', `${y}-01-01`, `${Number(y) + 1}-01-01`);
    checked.push({ period: y, kind: 'daily', legacy, target });
    if (legacy > 0 && (target == null || target < legacy)) mismatch.push({ period: y, kind: 'daily', legacy, target });
    await maybeYield();
  }
  return { ok: mismatch.length === 0, at: Date.now(), checked, mismatch, today: dayKey(Date.now()) };
}
export function _resetMigrateForTest() { _running = null; _last = null; }
