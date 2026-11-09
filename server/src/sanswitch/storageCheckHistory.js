/**
 * sanswitch/storageCheckHistory.js — SAN 스토리지 성능 점검 **결과 이력 + 최근 N회 비교**(v2.954 · 설계 §8.1 '점검 이력').
 *
 * SAN 점검 이력(healthHistory.js · v2.522)과 같은 규약이다 — 파일 `san-storage-check.db` · node:sqlite 없으면 `available:false` 로 정직하게 ·
 * 어레이당 최근 N건만 · 항목 상세는 200자 · 비교는 **상태 전이**(악화 · 호전 · 이제 확인됨 · 확인 불가로) — `compareRuns` 는 그쪽 순수 함수를 그대로 쓴다.
 *
 * 무엇이 '1회' 인가: 스토리지 성능 판정은 스냅샷이 아니라 **창(24시간 평균 · 최근 표본)** 을 보므로 '수집 1회 = 기록 1회' 가 없다.
 * 그래서 어레이마다 **판정이 바뀌었을 때, 또는 마지막 기록에서 1시간이 지났을 때**만 적는다(`MIN_GAP_MS`) — 5분 틱마다 같은 값을 쌓지 않는다.
 * 기록은 알림 틱(storagePerfNotify — 알림이 꺼져 있어도 돈다 · 중앙만)과 점검 탭 '지금 판정' 이 한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { pageArgs } from '../util/pageArgs.js';
import { compareRuns } from './healthHistory.js';
import { CHECK_ITEMS } from './storagePerfCheck.js';

const DB_PATH = () => process.env.SANSTORAGE_CHECK_DB_PATH || path.join(config.dbDir || config.configDir, 'san-storage-check.db');
/** 어레이당 보관 건수 — '최근 10회 비교' 를 늘 채우고 여유(기본 48 — 변화 없으면 1시간 1건이라 이틀치). */
export const MAX_RUNS = Math.max(10, Number(process.env.SANSTORAGE_CHECK_MAX_RUNS) || 48);
/** 바뀐 것이 없을 때 다시 적기까지의 최소 간격. */
export const MIN_GAP_MS = 60 * 60_000;
const LABELS = Object.fromEntries(CHECK_ITEMS.map((i) => [i.k, i.label]));

let x = null; let ready = null; let initError = null;
const _lock = createLockRetry(30_000);

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      array_key TEXT NOT NULL,
      dc TEXT NOT NULL DEFAULT '',
      at INTEGER NOT NULL,
      overall TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0, warn INTEGER NOT NULL DEFAULT 0, bad INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0,
      items TEXT NOT NULL DEFAULT '[]',        -- [{key,label,status,detail}]
      array_side TEXT NOT NULL DEFAULT '{}',   -- {keys:[], lastSampleTs}
      name TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sruns_key ON runs (array_key, dc, at);
    CREATE INDEX IF NOT EXISTS idx_sruns_at ON runs (at);
  `);
  return {
    ins: db.prepare('INSERT INTO runs (array_key, dc, at, overall, ok, warn, bad, unknown, items, array_side, name) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
    lastOf: db.prepare('SELECT id, at, overall, items FROM runs WHERE array_key=? AND dc=? ORDER BY at DESC LIMIT 1'),
    listOf: db.prepare('SELECT * FROM runs WHERE array_key=? AND dc=? ORDER BY at DESC LIMIT ?'),
    countOf: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE array_key=? AND dc=?'),
    trim: db.prepare('DELETE FROM runs WHERE array_key=? AND dc=? AND id NOT IN (SELECT id FROM runs WHERE array_key=? AND dc=? ORDER BY at DESC LIMIT ?)'),
    arrays: db.prepare('SELECT array_key, dc, MAX(name) AS name, COUNT(*) AS runs, MAX(at) AS lastAt FROM runs GROUP BY array_key, dc'),
    recent: db.prepare('SELECT * FROM runs WHERE at>=? ORDER BY at DESC LIMIT ?'),
    stats: db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS mn, MAX(at) AS mx FROM runs'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (ready) return ready;
  if (_lock.blocked()) return null;
  ready = (async () => {
    // eslint-disable-next-line import/no-unresolved
    const { DatabaseSync } = await import('node:sqlite');
    const p = DB_PATH();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    return withOpenCleanup(async () => {
      const db = openSqlite(new DatabaseSync(p));
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      x = { db, st, path: p };
      _lock.ok();
      return x;
    });
  })().catch((e) => {
    if (_lock.onFail(e)) { console.warn(`[san-storage-check] 이력 DB 잠김(${e.message}) — 30초 뒤 다시 엽니다(비활성으로 고정하지 않음)`); return null; }
    initError = e; return null;
  }).finally(() => { ready = null; });
  return ready;
}

/** 저장할 항목 형태(순수) — runCheck 결과 한 어레이의 items 객체 → 배열(근거 · 수치는 넣지 않는다 · 상세 200자). */
export function slimCheckItems(items) {
  return Object.entries(items || {}).map(([key, v]) => ({ key, label: LABELS[key] || key, status: String(v?.status || 'unknown'), detail: String(v?.text || '').slice(0, 200) }));
}
const countsOf = (items) => items.reduce((a, i) => { if (a[i.status] != null) a[i.status] += 1; return a; }, { ok: 0, warn: 0, bad: 0, unknown: 0 });
const sig = (overall, items) => `${overall}|${items.map((i) => `${i.key}=${i.status}`).sort().join(',')}`;

/**
 * 판정이 바뀌었거나 1시간이 지났으면 적는다(순수 판정 — `shouldRecord`). last: { at, overall, items(JSON 또는 배열) }.
 */
export function shouldRecord(last, { at, overall, items }, { minGapMs = MIN_GAP_MS } = {}) {
  if (!last) return { save: true, why: 'first' };
  let prevItems = last.items;
  if (typeof prevItems === 'string') { try { prevItems = JSON.parse(prevItems); } catch { prevItems = []; } }
  if (sig(last.overall, prevItems || []) !== sig(overall, items)) return { save: true, why: 'changed' };
  if (at - Number(last.at) >= minGapMs) return { save: true, why: 'gap' };
  return { save: false, why: 'same' };
}

/**
 * 점검 1회(여러 어레이) 기록. 어레이별로 shouldRecord 를 적용한다. 던지지 않는다.
 * @param {Array} results runCheck().results
 * @returns {{available:boolean, saved:number, skipped:number, reason?:string}}
 */
export async function recordCheckRuns(results = [], { at = Date.now(), minGapMs = MIN_GAP_MS } = {}) {
  const h = await open();
  if (!h) return { available: false, saved: 0, skipped: 0, reason: initError ? String(initError.message).slice(0, 200) : 'node:sqlite 없음' };
  let saved = 0; let skipped = 0;
  h.db.exec('BEGIN');
  try {
    for (const r of results || []) {
      const key = String(r?.key || ''); if (!key) continue;
      const dc = String(r.datacenterId || '');
      const items = slimCheckItems(r.items);
      const overall = String(r.overall || 'unknown');
      const last = h.st.lastOf.get(key, dc);
      const d = shouldRecord(last, { at, overall, items }, { minGapMs });
      if (!d.save) { skipped += 1; continue; }
      const c = countsOf(items);
      h.st.ins.run(key, dc, at, overall, c.ok, c.warn, c.bad, c.unknown, JSON.stringify(items),
        JSON.stringify({ keys: r.arraySide?.keys || [], lastSampleTs: r.arraySide?.lastSampleTs ?? null }), String(r.name || key).slice(0, 120));
      h.st.trim.run(key, dc, key, dc, MAX_RUNS);
      saved += 1;
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { available: true, saved: 0, skipped, reason: String(e.message || e).slice(0, 200) };
  }
  return { available: true, saved, skipped };
}

const rowOf = (r) => ({
  id: r.id, at: Number(r.at), overall: r.overall, name: r.name || r.array_key, key: r.array_key, dc: r.dc,
  counts: { ok: r.ok, warn: r.warn, bad: r.bad, unknown: r.unknown },
  items: (() => { try { return JSON.parse(r.items); } catch { return []; } })(),
  arraySide: (() => { try { return JSON.parse(r.array_side); } catch { return {}; } })(),
});

/**
 * 가장 최근의 **실제 변화**(순수): 1시간 간격 기록은 같은 값이 반복되므로 '마지막 두 건' 비교만으로는 변화를 놓친다 — 최신부터 걸어 내려가
 * 서명이 달라지는 첫 쌍을 찾는다. since 이전이면 null.
 */
export function lastChangeOf(runs = [], since = 0) {
  for (let i = 0; i + 1 < runs.length; i++) {
    const a = runs[i]; const b = runs[i + 1];
    if (sig(a.overall, a.items) === sig(b.overall, b.items)) continue;
    if (a.at < since) return null;
    const c = compareRuns([a, b]);
    return { at: a.at, prevAt: b.at, changes: c.changes, newProblems: c.newProblems, resolved: c.resolved };
  }
  return null;
}

/** 어레이 하나의 최근 N회(최신 먼저) + 비교(마지막 두 건) + 가장 최근의 실제 변화. */
export async function listCheckRuns(arrayKey, dc = '', limit = 10) {
  const h = await open();
  if (!h) return { available: false, runs: [], compare: compareRuns([]), maxRuns: MAX_RUNS };
  const n = pageArgs({ limit }, { def: 10, max: MAX_RUNS }).limit;
  const runs = h.st.listOf.all(String(arrayKey), String(dc || ''), n).map(rowOf);
  return { available: true, runs, compare: compareRuns(runs), lastChange: lastChangeOf(runs, 0), maxRuns: MAX_RUNS };
}

/** 기록된 어레이 목록 + 최근 변화(지난 days 일 · 마지막 두 기록이 다른 어레이). */
export async function checkHistoryOverview({ days = 7, now = Date.now(), limit = 200 } = {}) {
  const h = await open();
  if (!h) return { available: false, arrays: [], changes: [], maxRuns: MAX_RUNS };
  const arrays = h.st.arrays.all().map((a) => ({ key: a.array_key, dc: a.dc, name: a.name || a.array_key, runs: a.runs, lastAt: Number(a.lastAt) }))
    .sort((a, b) => b.lastAt - a.lastAt).slice(0, limit);
  const since = now - days * 86_400_000;
  const changes = [];
  for (const a of arrays) {
    const runs = h.st.listOf.all(a.key, a.dc, MAX_RUNS).map(rowOf);
    const lc = lastChangeOf(runs, since);
    if (!lc) continue;
    // 전이 객체의 key 는 항목 키다 — 어레이 키와 섞이지 않게 arrayKey · item 으로 이름을 가른다.
    for (const ch of lc.changes) changes.push({ at: lc.at, prevAt: lc.prevAt, arrayKey: a.key, dc: a.dc, name: a.name, item: ch.key, label: ch.label, from: ch.from, to: ch.to, dir: ch.dir, detail: ch.detail || '' });
  }
  changes.sort((a, b) => b.at - a.at);
  return { available: true, arrays, changes: changes.slice(0, 500), maxRuns: MAX_RUNS, minGapMs: MIN_GAP_MS };
}

export async function checkHistoryStatus() {
  const h = await open();
  return { available: !!h, path: h ? h.path : DB_PATH(), maxRuns: MAX_RUNS, minGapMs: MIN_GAP_MS,
    error: initError ? String(initError.message).slice(0, 200) : null, ...(h ? h.st.stats.get() : { rows: null, mn: null, mx: null }) };
}

// 보존 정리는 따로 두지 않는다 — 어레이당 MAX_RUNS 로 잘라 표가 유한하다(한 방 DELETE 금지 규약 · perf-db.md).

export function _resetForTest() { x = null; ready = null; initError = null; }
