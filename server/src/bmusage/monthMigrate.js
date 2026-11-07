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

// v2.922(반증 D11): 2,000행 청크가 한 번에 최대 92ms 멈췄다(1,000대 실측 — v2.693 기준 50ms 초과) → 500.
export const MIGRATE_CHUNK_ROWS = Math.max(100, Number(process.env.BMUSAGE_MIGRATE_CHUNK_ROWS) || 500);
export const MIGRATE_RETRY_MS = 60 * 60_000;
export const MIGRATE_MAX_ATTEMPTS = 3;
/** v2.922(반증 D6): 시도를 다 쓴 뒤에도 영구 정지하지 않는다 — 이만큼 지나면 횟수를 0 으로 돌리고 다시 시도한다(재시작해도 0 부터). */
export const MIGRATE_EXHAUSTED_RETRY_MS = 6 * 60 * 60_000;
const HOUR_MS = 3_600_000;
let _attemptsResetThisProcess = false;
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
    // v2.922(반증 D6): 재시작하면 시도 횟수를 0 부터(프로세스당 한 번) · 다 쓴 뒤에는 6시간 뒤 다시 0 부터 — 일시 오류 3번으로 영구 정지하지 않는다.
    if (!_attemptsResetThisProcess && (st.attempts || 0) > 0) { st = { ...st, attempts: 0, attemptsResetAt: now, attemptsResetBy: 'restart' }; writeMeta(db, MIGRATE_KEY, st); }
    _attemptsResetThisProcess = true;
    if ((st.attempts || 0) >= MIGRATE_MAX_ATTEMPTS) {
      if (now - (st.failedAt || 0) < MIGRATE_EXHAUSTED_RETRY_MS && !hooks.retryNow) {
        _last = { at: Date.now(), ok: false, phase: 'failed', reason: 'attempts-exhausted', nextRetryAt: (st.failedAt || 0) + MIGRATE_EXHAUSTED_RETRY_MS, attempts: st.attempts, error: st.error, failedPhase: st.failedPhase };
        return { ok: false, phase: 'failed', reason: 'attempts-exhausted', nextRetryAt: _last.nextRetryAt };
      }
      st = { ...st, attempts: 0, attemptsResetAt: now, attemptsResetBy: 'exhausted-wait' };
    }
    if (now - (st.failedAt || 0) < MIGRATE_RETRY_MS && !hooks.retryNow) {
      _last = { at: Date.now(), ok: false, phase: 'failed', reason: 'retry-wait', nextRetryAt: (st.failedAt || 0) + MIGRATE_RETRY_MS, attempts: st.attempts, error: st.error, failedPhase: st.failedPhase };
      return { ok: false, phase: 'failed', reason: 'retry-wait', nextRetryAt: _last.nextRetryAt };
    }
    st = { ...st, phase: st.failedPhase === 'verify' ? 'copy-raw' : (st.failedPhase || 'copy-raw'), error: null };
    if (st.failedPhase === 'verify') { st.rawCursor = 0; st.dailyCursor = 0; st.rawCopied = false; }
  }
  const s = (() => { try { return loadBmUsageSettings(); } catch { return null; } })();
  const rawDays = effectiveRawDays(s || {});
  const hourlyDays = s?.store?.hourlyDays || STORE_DEFAULTS.hourlyDays;
  /*
   * v2.922(반증 D4): 경계는 **정시**로 맞추고 처음 한 번 고정한다 — 한 시간 버킷이 ‘원시에서 다시 집계(보존 안)’ 와 ‘커서로 더하기(보존 밖)’
   *   두 방식에 갈라지지 않게(갈라지면 재집계가 커서로 더한 몫을 지운다). 대조도 같은 경계를 쓴다.
   */
  if (st.rawCopyFrom == null) st.rawCopyFrom = month.hourOf(now - rawDays * DAY_MS);
  if (st.hourlyFrom == null) st.hourlyFrom = month.hourOf(now - hourlyDays * DAY_MS);
  const hourlyFrom = st.hourlyFrom;
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
          /*
           * v2.922(반증 D4):
           *  · 보존 안(≥ rawCopyFrom): 원시로 옮기고(IGNORE) 그 행들의 시간 버킷을 **전부** 보정 대기로 — 1시간 롤업은 원시에서 다시 집계한다.
           *    라이브가 같은 (agent,key,ts) 를 먼저 넣었어도 원시는 한 행이라 두 번 세지 않고(m3), 재개해도 같은 값이다.
           *  · 보존 밖(< rawCopyFrom, ≥ hourlyFrom): 원시에 없으므로 커서로 더한다 — 커서 키는 **agent 별**(`legacy_raw|<agent>`).
           *    예전에는 파일당 키 하나라 첫 agent 가 커서를 청크 최대 rowid 까지 올려 둘째 agent 의 행을 건너뛰었다(m1 — 11행 손실).
           */
          const recent = list.filter((r) => Number(r.ts) >= st.rawCopyFrom);
          const w = await month.writeServerRows(recent, agent, { rollup: false, pend: 'all', pendDaily: false });
          failIfErrors(w, '원시 옮기기');
          st.copied.raw += w.inserted; st.copied.rawDup += w.duplicates; st.copied.rawOld += list.length - recent.length;
          await maybeYield();   // v2.931(점검 E1-04): 쓰기 · 롤업 · 보정 사이에도 양보(예전에는 청크 사이에서만 — 청크 하나가 120~150ms 연속)
          const old = list.filter((r) => Number(r.ts) >= hourlyFrom && Number(r.ts) < st.rawCopyFrom);
          const h = await month.rollupServerRows(old, agent, { ok: true, errors: [] }, { daily: false, migKey: `legacy_raw|${agent}`, migRowid: '_rid' });
          failIfErrors(h, '1시간 롤업');
          st.copied.hourly += old.length + recent.filter((r) => Number(r.ts) >= hourlyFrom).length;
          await maybeYield();
        }
        /*
         * 이번 청크의 보정 대기(보존 안 버킷)를 원시에서 다시 집계 — 1일은 건드리지 않는다(예전 일 롤업은 사본 표가 갖는다).
         * v2.931(점검 E1-04): 보정 안에서 버킷 사이 시간 기준 양보(이 실행의 양보기를 넘긴다) · 시간 상한 없음(이 청크의 대기를 다 끝내야 대조가 맞는다 — 남기면 hourly 불일치) ·
         *   재시도 간격 무시(마이그레이션은 자기 재시도 정책이 있다 — 실패를 바로 failed 로 올린다). 남은 대기(deferred·skipped)도 실패로 본다.
         */
        const rp = await month.repairPending({ dailyLiveAfter: st.legacyMaxTs ?? null, budgetMs: Infinity, yielder: maybeYield, ignoreBackoff: true });
        if (rp.errors.length || rp.deferred || rp.skipped) throw new Error(`1시간 재집계: ${rp.errors.slice(0, 2).join(' · ') || `남은 대기 ${rp.deferred + rp.skipped}건`}`);
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
      if (!v.ok) throw Object.assign(new Error(`행 수 대조 실패: ${v.mismatch.slice(0, 3).map((x) => `${x.kind} ${x.period} 예전 ${x.legacy} · 사본 ${x.target ?? '파일 없음'}`).join(' · ')}`), { phase: 'verify' });
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
  /*
   * v2.922(반증 D4): 1시간 롤업 표본 수 대조 — 예전 원시 중 [hourlyFrom, legacyMaxTs] 의 행(보존 밖 30~90일 포함 — 그 구간은 삭제 뒤 1시간 롤업에만 남는다)
   *   = 1시간 롤업 samples 합. 예전 행만 있는 시간(경계 시간 앞)은 **같아야** 하고(빠짐·이중 계수 둘 다 잡는다), 업그레이드 경계 시간은 라이브 행이
   *   섞이므로 ≥ 다. 이 비교가 성립하려고 옮기는 동안 예전 표 보존 정리(pruneUsage)와 1시간 파일 보존은 멈춘다.
   *   ⚠ 예전 행과 같은 (agent,key,ts) 를 라이브가 먼저 넣었으면 원시는 한 행이라 1시간 합이 예전 행 수보다 작다 — 그 수(rawDup 중 보존 안)는 빼고 본다.
   */
  if (st.legacyMaxTs != null && st.hourlyFrom != null) {
    const edge = month.hourOf(st.legacyMaxTs);
    for (const k of month.periodsInWindow('h1', st.hourlyFrom, st.legacyMaxTs)) {
      const [a, b] = month.periodRange('h1', k);
      const from = Math.max(a, st.hourlyFrom); const to = Math.min(b, edge);
      if (to > from) {
        const legacy = Number(db.prepare('SELECT COUNT(*) c FROM usage_history WHERE ts >= ? AND ts < ? AND rowid <= ?').get(from, to, st.rawMaxRowid || 0)?.c ?? 0);
        const target = await month.hourlySamplesInPeriod(k, from, to);
        const allow = from >= (st.rawCopyFrom ?? Infinity) ? (st.copied?.rawDup || 0) : 0;
        checked.push({ period: k, kind: 'hourly', legacy, target });
        if (legacy > 0 && (target == null || target > legacy || target < legacy - allow)) mismatch.push({ period: k, kind: 'hourly', legacy, target });
      }
      if (edge >= a && edge < b) {
        const legacy = Number(db.prepare('SELECT COUNT(*) c FROM usage_history WHERE ts >= ? AND ts <= ? AND rowid <= ?').get(edge, st.legacyMaxTs, st.rawMaxRowid || 0)?.c ?? 0);
        const target = await month.hourlySamplesInPeriod(k, edge, edge + HOUR_MS);
        checked.push({ period: `${k}@edge`, kind: 'hourly-edge', legacy, target });
        if (legacy > 0 && (target == null || target < legacy - (st.copied?.rawDup || 0))) mismatch.push({ period: `${k}@edge`, kind: 'hourly-edge', legacy, target });
      }
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
