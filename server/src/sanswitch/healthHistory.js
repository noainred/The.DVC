/**
 * sanswitch/healthHistory.js — SAN 점검 결과 이력 + **최근 N회 비교**(v2.522).
 *
 * 사용자 요청: "점검 결과를 DB 로 저장해서 최근 10번 점검과 비교 하는 기능 만들어줘".
 *
 * ── 설계 ────────────────────────────────────────────────────────────────────────
 * · 파일: `CONFIG_DIR`(또는 `config.dbDir`)/`san-health.db`. node:sqlite 가 없으면 기능을
 *   **비활성으로 정직하게 보고**한다(`available:false`) — 화면이 조용히 빈 표를 보이지 않게.
 * · **`collectedAt` 로 중복을 건다.** 점검은 저장된 스냅샷을 판정하는 것이라, 같은 스냅샷을
 *   두 번 점검하면 **결과가 같다**. 탭을 열 때마다 기록하면 이력이 같은 값으로 부풀어
 *   '최근 10회' 가 10분 안의 같은 값 10개가 된다. 그래서 '수집 1회 = 기록 1회' 다.
 * · 장비당 **최근 N건만** 보관한다(기본 24 — '최근 10회 비교' 를 늘 채우고 여유를 둔다).
 *   상한이 없으면 28대 × 무한이 되고, 기록마다 전량 재직렬화가 아니라 행 삭제로 유지한다.
 * · 항목 상세(`detail`)는 200자로 자른다 — 근거(evidence)는 **저장하지 않는다**(원문 수천 줄).
 *   이력의 목적은 '이번 달에 무엇이 달라졌나' 이고, 원문은 그때의 점검 화면이 갖는다.
 *
 * ⚠ 비교는 **상태 전이**로 말한다 — '악화/호전/유지' 를 구분하고, 새로 생긴 문제와 해소된
 *   문제를 **각각** 센다. 한 숫자로 뭉개면 "지난달과 비슷하다" 는 쓸모없는 말이 된다.
 * ⚠ `unknown`(확인 불가)은 **`ok` 로 흡수하지 않는다**. 지난달 `unknown` → 이번달 `ok` 는
 *   '호전' 이 아니라 **'이제 확인됐다'** 다(명령이 생겼거나 권한이 바뀐 것).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = () => process.env.SANHEALTH_DB_PATH
  || path.join(config.dbDir || config.configDir, 'san-health.db');
/** 장비당 보관 건수 — '최근 10회 비교' 를 늘 채우고 여유를 둔다. */
export const MAX_RUNS = Math.max(10, Number(process.env.SANHEALTH_MAX_RUNS) || 24);

let x = null; let ready = null; let initError = null;

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      at INTEGER NOT NULL,              -- 점검(판정) 시각
      collected_at INTEGER,             -- 판정에 쓴 스냅샷의 수집 시각(중복 판정 기준)
      overall TEXT NOT NULL,
      ok INTEGER NOT NULL DEFAULT 0, warn INTEGER NOT NULL DEFAULT 0,
      bad INTEGER NOT NULL DEFAULT 0, unknown INTEGER NOT NULL DEFAULT 0,
      items TEXT NOT NULL DEFAULT '[]', -- [{key,label,stage,status,detail,usedCmd,usedAlt}]
      ports TEXT NOT NULL DEFAULT '{}', -- {total,bad,warn,ok,idle,unknown,complete}
      baseline_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runs_dev ON runs (device_id, at);
    -- prune 은 \`DELETE WHERE at<?\` 도 쓴다 — ts 단독 인덱스(CLAUDE.md 성능 불변조건).
    CREATE INDEX IF NOT EXISTS idx_runs_at ON runs (at);
  `);
  return {
    ins: db.prepare(`INSERT INTO runs (device_id, at, collected_at, overall, ok, warn, bad, unknown, items, ports, baseline_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    lastOf: db.prepare('SELECT id, at, collected_at FROM runs WHERE device_id=? ORDER BY at DESC LIMIT 1'),
    listOf: db.prepare('SELECT * FROM runs WHERE device_id=? ORDER BY at DESC LIMIT ?'),
    countOf: db.prepare('SELECT COUNT(*) AS n FROM runs WHERE device_id=?'),
    trim: db.prepare(`DELETE FROM runs WHERE device_id=? AND id NOT IN
      (SELECT id FROM runs WHERE device_id=? ORDER BY at DESC LIMIT ?)`),
    devices: db.prepare('SELECT device_id, COUNT(*) AS runs, MAX(at) AS lastAt FROM runs GROUP BY device_id'),
    stats: db.prepare('SELECT COUNT(*) AS rows, MIN(at) AS mn, MAX(at) AS mx FROM runs'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready) {
    ready = (async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const db = new DatabaseSync(p);
      try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      x = { db, st, path: p };
      return x;
    })().catch((e) => { initError = e; return null; });
  }
  return ready;
}

export async function healthHistoryStatus() {
  const h = await open();
  return {
    available: !!h, path: h ? h.path : DB_PATH(), maxRuns: MAX_RUNS,
    error: initError ? String(initError.message || initError).slice(0, 200) : '',
    ...(h ? h.st.stats.get() : { rows: null, mn: null, mx: null }),
  };
}

/** 저장할 항목 형태로 축약(순수) — 근거(evidence)는 넣지 않는다. */
export function slimItems(items) {
  return (items || []).map((i) => ({
    key: i.key, label: i.label, stage: i.stage, status: i.status,
    detail: String(i.detail || '').slice(0, 200),
    ...(i.usedCmd ? { usedCmd: i.usedCmd, usedAlt: !!i.usedAlt } : {}),
  }));
}

/**
 * 점검 1회 기록. **같은 스냅샷(`collectedAt`)이 이미 기록돼 있으면 건너뛴다.**
 * @returns { saved:boolean, reason?:string, id?:number, runs?:number }
 */
export async function recordRun(result, { ports = null } = {}) {
  if (!result?.deviceId) return { saved: false, reason: 'deviceId 없음' };
  const h = await open();
  if (!h) return { saved: false, reason: initError ? String(initError.message).slice(0, 200) : 'node:sqlite 없음' };
  const collectedAt = Number(result.collectedAt) || null;
  const last = h.st.lastOf.get(String(result.deviceId));
  if (last && collectedAt && Number(last.collected_at) === collectedAt) {
    return { saved: false, reason: '같은 수집 시각의 점검이 이미 기록돼 있습니다(수집 1회 = 기록 1회).', id: last.id };
  }
  const c = result.counts || {};
  const at = Date.now();
  h.db.exec('BEGIN');
  try {
    h.st.ins.run(
      String(result.deviceId), at, collectedAt, String(result.overall || 'unknown'),
      Number(c.ok) || 0, Number(c.warn) || 0, Number(c.bad) || 0, Number(c.unknown) || 0,
      JSON.stringify(slimItems(result.items)),
      JSON.stringify(ports ? {
        total: ports.counts?.total ?? null, bad: ports.counts?.bad ?? 0, warn: ports.counts?.warn ?? 0,
        ok: ports.counts?.ok ?? 0, idle: ports.counts?.idle ?? 0, unknown: ports.counts?.unknown ?? 0,
        complete: ports.complete !== false,
      } : {}),
      result.baselineAt ?? null,
    );
    h.st.trim.run(String(result.deviceId), String(result.deviceId), MAX_RUNS);
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { saved: false, reason: String(e.message || e).slice(0, 200) };
  }
  return { saved: true, at, runs: h.st.countOf.get(String(result.deviceId))?.n ?? null };
}

/** 최근 N회 조회(최신 먼저). */
export async function listRuns(deviceId, limit = 10) {
  const h = await open();
  if (!h) return { available: false, runs: [] };
  const n = Math.max(1, Math.min(MAX_RUNS, Number(limit) || 10));
  const rows = h.st.listOf.all(String(deviceId), n).map((r) => ({
    id: r.id, at: Number(r.at), collectedAt: r.collected_at == null ? null : Number(r.collected_at),
    overall: r.overall, counts: { ok: r.ok, warn: r.warn, bad: r.bad, unknown: r.unknown },
    items: (() => { try { return JSON.parse(r.items); } catch { return []; } })(),
    ports: (() => { try { return JSON.parse(r.ports); } catch { return {}; } })(),
    baselineAt: r.baseline_at == null ? null : Number(r.baseline_at),
  }));
  return { available: true, runs: rows, maxRuns: MAX_RUNS };
}

const RANK = { ok: 0, warn: 2, bad: 3, unknown: 1 };

/**
 * **최근 N회 비교**(순수 — 테스트가 고정).
 *
 * @param runs 최신 먼저 정렬된 `listRuns().runs`
 * @returns {{
 *   compared:number, current:object|null, previous:object|null,
 *   changes:Array<{key,label,from,to,dir}>,   // dir: 'worse'|'better'|'nowKnown'|'nowUnknown'
 *   newProblems:string[], resolved:string[],
 *   trend:Array<{at,overall,bad,warn,unknown,ok,portsBad}>,
 *   persistent:Array<{key,label,status,runs}>,  // N회 내내 문제인 항목
 *   note:string
 * }}
 */
export function compareRuns(runs) {
  const list = (runs || []).filter(Boolean);
  const empty = { compared: 0, current: null, previous: null, changes: [], newProblems: [], resolved: [], trend: [], persistent: [], note: '' };
  if (!list.length) return { ...empty, note: '저장된 점검 이력이 없습니다 — 점검을 실행하면 이번 결과부터 쌓입니다.' };
  const trend = list.map((r) => ({
    at: r.at, overall: r.overall, ok: r.counts.ok, warn: r.counts.warn,
    bad: r.counts.bad, unknown: r.counts.unknown, portsBad: r.ports?.bad ?? null,
  })).reverse();   // 차트·표는 오래된 것부터
  const current = list[0];
  if (list.length === 1) {
    return { ...empty, compared: 1, current, trend, note: '비교할 이전 점검이 없습니다 — 다음 점검부터 변화를 가려 줍니다.' };
  }
  const prev = list[1];
  const prevBy = new Map(prev.items.map((i) => [i.key, i]));
  const changes = [];
  for (const it of current.items) {
    const p = prevBy.get(it.key);
    if (!p || p.status === it.status) continue;
    // ⚠ unknown 은 ok 로 흡수하지 않는다 — '확인 불가 → 정상' 은 호전이 아니라 '이제 확인됐다' 다.
    let dir;
    if (p.status === 'unknown') dir = 'nowKnown';
    else if (it.status === 'unknown') dir = 'nowUnknown';
    else dir = RANK[it.status] > RANK[p.status] ? 'worse' : 'better';
    changes.push({ key: it.key, label: it.label || it.key, from: p.status, to: it.status, dir, detail: it.detail || '' });
  }
  const problem = (s) => s === 'bad' || s === 'warn';
  const newProblems = changes.filter((c) => problem(c.to) && !problem(c.from)).map((c) => c.label);
  const resolved = changes.filter((c) => !problem(c.to) && problem(c.from) && c.to !== 'unknown').map((c) => c.label);

  // N회 내내 문제인 항목 — '매달 같은 경고' 를 사람이 알아볼 수 있게.
  const counter = new Map();
  for (const r of list) for (const it of r.items) {
    if (!problem(it.status)) continue;
    const e = counter.get(it.key) || { key: it.key, label: it.label || it.key, status: it.status, runs: 0 };
    e.runs++; counter.set(it.key, e);
  }
  const persistent = [...counter.values()].filter((e) => e.runs === list.length && list.length >= 3)
    .sort((a, b) => b.runs - a.runs);

  return { compared: list.length, current, previous: prev, changes, newProblems, resolved, trend, persistent, note: '' };
}

export async function pruneHealthHistory(retentionDays) {
  const days = Number(retentionDays) || 0;
  if (days <= 0) return { skipped: true, reason: '무제한' };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  const before = Date.now() - days * 86_400_000;
  let n = 0;
  try { n = h.db.prepare('DELETE FROM runs WHERE at < ?').run(before)?.changes ?? 0; } catch { /* */ }
  return { skipped: false, removed: n, before };
}

export async function listHistoryDevices() {
  const h = await open();
  if (!h) return [];
  return h.st.devices.all().map((r) => ({ deviceId: r.device_id, runs: Number(r.runs), lastAt: Number(r.lastAt) }));
}

export function _resetForTest() {
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null;
}
