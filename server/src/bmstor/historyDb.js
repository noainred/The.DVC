/**
 * bmstor/historyDb.js — 베어메탈 스토리지 디스크 사용량 이력 **전용 DB**(v2.635, 사용자 요청 "별도의 DB").
 *
 * 파일: `config.dbDir || CONFIG_DIR` 아래 `bmstor-history.db`(`insights/dbLocation.js MIGRATABLE` 등재).
 *
 * ── 행 수를 먼저 계산했다(CLAUDE.md v2.504 규칙) ───────────────────────────────
 *  서버 32대 + 그룹 8개 + 합계 1 = 41계열 × 2회/일 = 하루 82행 → **5년 보존 약 15만 행**.
 *  서버 1,000대(등록부 상한)여도 5년 약 370만 행 — 계열이 적고 간격이 길어 작다.
 *
 * 한 슬롯(12시간)에 계열당 **한 행**이다(PK `(kind,key,slot)`). 같은 슬롯에 다시 적재하면 **더 온전한 값일 때만**
 * 덮는다(부분 합 → 온전한 합, 또는 읽은 대수가 늘었을 때). 온전한 값을 나중의 부분 합이 덮지 않는다.
 * prune 은 `ts` 단독 인덱스 + 청크 DELETE(`util/chunkedPrune.js`) · 스로틀 `(++tick % N) === 0`(v2.453).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';

const DB_PATH = () => process.env.BMSTOR_HISTORY_DB_PATH
  || path.join(config.dbDir || config.configDir, 'bmstor-history.db');

let x = null;         // { db, st, path }
let ready = null;
let initError = null;
const lockRetry = createLockRetry();
let tick = 0;

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bm_history (
      kind TEXT NOT NULL,                -- 'total' | 'group' | 'server'
      key TEXT NOT NULL,                 -- total: '' · group: 그룹 이름('' = 그룹 없음) · server: 서버 id
      slot INTEGER NOT NULL,             -- 12시간 슬롯 번호(KST 0시·12시 경계)
      ts INTEGER NOT NULL,               -- 실제 적재 시각(ms)
      name TEXT NOT NULL DEFAULT '',     -- 적재 시점의 이름(서버가 지워진 뒤에도 알아볼 수 있게)
      total_bytes INTEGER NOT NULL,
      used_bytes INTEGER NOT NULL,
      avail_bytes INTEGER NOT NULL,
      servers INTEGER NOT NULL DEFAULT 0, -- 이 계열에 속한 활성 서버 수
      read INTEGER NOT NULL DEFAULT 0,    -- 그중 값을 읽어 더한 서버 수
      partial INTEGER NOT NULL DEFAULT 0, -- 1 = 부분 합(못 읽은 서버·못 찾은 마운트가 있다)
      PRIMARY KEY (kind, key, slot)
    );
    -- ⚠ prune(DELETE WHERE ts<?)·기간 조회는 ts 단독 인덱스가 있어야 풀스캔을 피한다(복합 PK 로는 탈 수 없다).
    CREATE INDEX IF NOT EXISTS idx_bm_history_ts ON bm_history (ts);
  `);
  return {
    // 같은 슬롯에서는 더 온전한 값만 덮는다(부분 → 온전, 또는 읽은 대수 증가).
    up: db.prepare(`INSERT INTO bm_history (kind, key, slot, ts, name, total_bytes, used_bytes, avail_bytes, servers, read, partial)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(kind, key, slot) DO UPDATE SET ts=excluded.ts, name=excluded.name, total_bytes=excluded.total_bytes,
        used_bytes=excluded.used_bytes, avail_bytes=excluded.avail_bytes, servers=excluded.servers, read=excluded.read,
        partial=excluded.partial
      WHERE excluded.partial < bm_history.partial
         OR (excluded.partial = bm_history.partial AND excluded.read > bm_history.read)`),
    range: db.prepare(`SELECT kind, key, slot, ts, name, total_bytes, used_bytes, avail_bytes, servers, read, partial
      FROM bm_history WHERE ts >= ? AND ts <= ? ORDER BY ts`),
    rangeKind: db.prepare(`SELECT kind, key, slot, ts, name, total_bytes, used_bytes, avail_bytes, servers, read, partial
      FROM bm_history WHERE ts >= ? AND ts <= ? AND kind = ? ORDER BY ts`),
    totalOfSlot: db.prepare("SELECT partial, read FROM bm_history WHERE kind = 'total' AND key = '' AND slot = ?"),
    // ⚠ MIN·MAX 는 **따로** 부른다 — 한 쿼리에 aggregate 둘을 쓰면 인덱스를 통째로 훑는다(v2.550.3 실측).
    minTs: db.prepare('SELECT MIN(ts) AS v FROM bm_history'),
    maxTs: db.prepare('SELECT MAX(ts) AS v FROM bm_history'),
    count: db.prepare('SELECT COUNT(*) AS n FROM bm_history'),
    prune: db.prepare('DELETE FROM bm_history WHERE rowid IN (SELECT rowid FROM bm_history WHERE ts < ? LIMIT ?)'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = (async () => withOpenCleanup(async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const db = openSqlite(new DatabaseSync(p));   // chmod 0600 · busy_timeout 먼저 · 잠금이면 닫고 던진다
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      lockRetry.ok();
      x = { db, st, path: p };
      return x;
    }))().catch((e) => { if (lockRetry.onFail(e)) { ready = null; return null; } initError = e; return null; });
  }
  return ready;
}

const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

/** 한 슬롯의 행을 트랜잭션 1회로 적재한다. */
export async function commitBmHistory({ slot, ts, rows = [] }) {
  const h = await open();
  if (!h) return { ok: false, reason: initError ? String(initError.message || initError).slice(0, 200) : (lockRetry.note() || 'node:sqlite 없음') };
  let written = 0;
  h.db.exec('BEGIN');
  try {
    for (const r of rows) {
      const res = h.st.up.run(String(r.kind), String(r.key ?? ''), int(slot), int(ts), String(r.name || '').slice(0, 200),
        int(r.totalBytes), int(r.usedBytes), int(r.availBytes), int(r.servers), int(r.read), r.partial ? 1 : 0);
      if (res && res.changes) written += 1;
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, reason: String(e.message || e).slice(0, 200) };
  }
  return { ok: true, written, rows: rows.length };
}

/** 이 슬롯에 합계 행이 이미 있는가 — `{ exists, partial, read }`. 재시작 뒤 같은 슬롯을 다시 적재하지 않게. */
export async function totalOfSlot(slot) {
  const h = await open();
  if (!h) return null;
  const r = h.st.totalOfSlot.get(int(slot));
  return r ? { exists: true, partial: !!r.partial, read: Number(r.read) } : { exists: false, partial: false, read: 0 };
}

/** 기간 조회(시간 오름차순). kind 를 주면 그 종류만. */
export async function bmHistoryRange(fromTs, toTs, { kind = null } = {}) {
  const h = await open();
  if (!h) return { available: false, rows: [], span: null };
  const rows = (kind ? h.st.rangeKind.all(int(fromTs), int(toTs), String(kind)) : h.st.range.all(int(fromTs), int(toTs)))
    .map((r) => ({
      kind: r.kind, key: r.key, slot: Number(r.slot), ts: Number(r.ts), name: r.name,
      totalBytes: Number(r.total_bytes), usedBytes: Number(r.used_bytes), availBytes: Number(r.avail_bytes),
      servers: Number(r.servers), read: Number(r.read), partial: !!r.partial,
    }));
  const mn = h.st.minTs.get()?.v; const mx = h.st.maxTs.get()?.v;
  // ⚠ span.first 는 '수집 시작' 이 아니라 max(시작, 보존 경계) 다 — 화면이 단정하지 않게 그대로 준다(v2.578 D1).
  return { available: true, rows, span: mn == null ? null : { first: Number(mn), last: Number(mx) } };
}

/** 상태(화면·서비스 점검용). 행 수는 참고값이라 부를 때만 센다(폴링 경로가 아니다). */
export async function bmHistoryDbStatus({ withCount = false } = {}) {
  const h = await open();
  let rows = null;
  if (h && withCount) { try { rows = Number(h.st.count.get()?.n ?? 0); } catch { rows = null; } }
  return {
    available: !!h,
    path: h ? h.path : DB_PATH(),
    error: initError ? String(initError.message || initError).slice(0, 200) : (h ? '' : lockRetry.note()),
    rows,
  };
}

const _pruneFlight = createPruneFlight();
/** 보존 정리 — N회에 한 번(첫 호출은 건너뛴다 — v2.453). days 0 = 전부 보관. */
export async function pruneBmHistory(retentionDays, { every = 12 } = {}) {
  if ((++tick % Math.max(1, every)) !== 0) return { skipped: true };
  const days = Number(retentionDays) || 0;
  if (days <= 0) return { skipped: true, reason: '전부 보관' };
  const h = await open();
  if (!h) return { skipped: true, reason: 'DB 없음' };
  return _pruneFlight.run(days, async () => {
    const before = Date.now() - days * 86_400_000;
    try {
      const r = await chunkedDelete(h.st.prune, [before], { label: 'bmstor.history' });
      return { skipped: false, deleted: r.deleted, before, done: r.done };
    } catch (e) {
      console.warn(`[bmstor-history] prune 실패: ${e?.message || e}`);
      return { skipped: false, deleted: 0, before, done: false, error: String(e?.message || e).slice(0, 200) };
    }
  });
}

export function _resetBmHistoryDbForTest() {
  lockRetry.ok();
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; tick = 0; _pruneFlight.reset();
}
