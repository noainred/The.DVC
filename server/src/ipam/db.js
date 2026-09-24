/**
 * Shareable IP ledger store — a standalone SQLite DB so OTHER programs can read
 * the current IP inventory (table `ip_records`). Mirrors the iDRAC store: uses
 * Node's built-in node:sqlite (no external deps; needs --experimental-sqlite),
 * with an NDJSON fallback when the module is unavailable.
 *
 * The whole ledger is replaced on every snapshot refresh (it is a current-state
 * inventory, not time-series), so external consumers always see a consistent set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { config } from '../config.js';
import { COLUMNS, toRecord } from './record.js';
import { createLockRetry, openSqlite, withOpenCleanup } from '../util/sqliteOpen.js';

const DB_PATH = config.ipam.dbPath;

let impl = null;
let ready = null;

// 이 행 수 미만은 워커로 넘기지 않는다 — 전송 오버헤드가 인라인 적재보다 커서 역효과.
const MIN_OFFLOAD_ROWS = Number(process.env.IPAM_WRITE_MIN_ROWS || 500);
// 0 이면 오프로딩 완전 비활성(항상 인라인).
const OFFLOAD_ENABLED = process.env.IPAM_WRITE_WORKER !== '0';

// v2.603(감사 DB2603-01): 뒤늦게 추가된 열. 예전에는 열마다 `try { ALTER } catch { /* already present */ }` 로 **모든** 오류를
//   '이미 있음' 으로 삼켜, 외부 리더가 잠금을 쥔 순간(SQLITE_BUSY)에 ALTER 가 실패하면 열이 없는 채로 INSERT prepare 가
//   'no such column' 으로 던지고 그 실패가 NDJSON 폴백으로 **프로세스 수명 동안 굳었다**(경고 문구도 'node:sqlite 사용 불가' 라는
//   틀린 원인). 이제 ① table_info 로 **없는 열만** ALTER 하고 ② 'duplicate column name' 만 삼키며 ③ 잠금이면 다시 던져
//   getImpl 이 래치하지 않고 잠시 뒤 다시 연다(util/sqliteOpen.js 규약 — ipam.db 는 외부 리더 공유라 WAL 전환은 하지 않는다).
export const MIGRATE_COLUMNS = ['scope', 'server_type', 'os_name', 'os_version', 'discovery', 'reconcile', 'mgmt_status', 'mgmt_owner',
  'label', 'device_type', 'first_seen', 'last_seen', 'usage_status', 'applied_by', 'range_policy_spec'];

/** 없는 열만 추가한다. 잠금·그 밖의 오류는 던진다('이미 있음' 경합만 삼킨다). @returns {string[]} 추가한 열 */
export function migrateIpRecordColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(ip_records)').all().map((r) => r.name));
  const added = [];
  for (const col of MIGRATE_COLUMNS) {
    if (have.has(col)) continue;
    try { db.exec(`ALTER TABLE ip_records ADD COLUMN ${col} TEXT`); added.push(col); }
    catch (e) { if (!/duplicate column name/i.test(String(e?.message || ''))) throw e; }
  }
  return added;
}

const lockRetry = createLockRetry(Number(process.env.IPAM_DB_LOCK_RETRY_MS) > 0 ? Number(process.env.IPAM_DB_LOCK_RETRY_MS) : 30_000);

function initSqlite() {
  // 시도가 실패하면 그 시도에서 연 핸들을 닫는다(withOpenCleanup — 잠금 재시도가 핸들을 쌓지 않게).
  // eslint-disable-next-line import/no-unresolved
  return withOpenCleanup(() => import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // ipam.db는 외부 프로그램이 직접 읽는 공유 파일 — WAL(-wal/-shm 파일 필요)은 외부 리더
    // 호환이 불확실해 저널 모드는 기본(DELETE) 유지, busy_timeout만 적용(리더 락 시 즉시
    // SQLITE_BUSY 실패 대신 3초 대기 — store의 서명 재시도 로직과 결합돼 유실 방지).
    const db = openSqlite(new DatabaseSync(DB_PATH), { wal: false, busyMs: 3000 });
    db.exec(`
      CREATE TABLE IF NOT EXISTS ip_records (
        ip TEXT NOT NULL,
        ip_num INTEGER,
        vcenter_id TEXT NOT NULL,
        vcenter_name TEXT,
        owner_type TEXT NOT NULL,
        server_type TEXT,
        owner_name TEXT NOT NULL,
        power_state TEXT,
        guest_os TEXT,
        os_name TEXT,
        os_version TEXT,
        host_name TEXT,
        cluster TEXT,
        scope TEXT,
        multi_homed INTEGER DEFAULT 0,
        duplicate INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ip_records_ip ON ip_records (ip);
      CREATE INDEX IF NOT EXISTS idx_ip_records_vc ON ip_records (vcenter_id);
    `);
    migrateIpRecordColumns(db); // 구버전 DB 의 열 추가(없는 열만 · 잠금은 던진다)
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const del = db.prepare('DELETE FROM ip_records');
    const ins = db.prepare(`INSERT INTO ip_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    const countStmt = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ip_records');
    // One transaction → a single commit/fsync for the whole snapshot, instead
    // of thousands of auto-committed inserts that would block the event loop.
    const syncInline = (rows, updatedAt) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        del.run();
        for (const r of rows) ins.run(...toRecord(r, updatedAt));
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    };
    return {
      kind: 'sqlite',
      // 트랜잭션으로 fsync 는 1회지만 바인딩·INSERT 는 여전히 동기 CPU 작업이다.
      // 대량 스냅샷은 쓰기 워커로 넘겨 메인 이벤트 루프를 비운다(워커 불가 시 인라인).
      sync: async (rows, updatedAt) => {
        if (await syncViaWorker(rows, updatedAt)) return;
        syncInline(rows, updatedAt);
      },
      syncInline,
      info: () => { const r = countStmt.get(); return { count: r?.n || 0, updatedAt: r?.at || null }; },
    };
  }));
}

// ── 쓰기 워커 ────────────────────────────────────────────────────────────────
// 워커는 지연 생성하고, 한 번 실패하면 이후엔 인라인만 쓴다(재시도 폭주 방지).
let writeWorker = null;
let writeWorkerBroken = false;
let writeSeq = 0;
const writePending = new Map();

function spawnWriteWorker() {
  const worker = new Worker(new URL('./writeWorker.js', import.meta.url), {
    workerData: { dbPath: DB_PATH },
  });
  worker.on('message', (msg) => {
    const task = writePending.get(msg.id);
    if (!task) return;
    writePending.delete(msg.id);
    if (msg.ok) task.resolve(true);
    else task.reject(new Error(msg.error || 'ipam write worker 실패'));
    if (!writePending.size) worker.unref();      // 유휴 워커가 프로세스 종료를 막지 않게
  });
  const onDown = (err) => {
    // 워커가 죽으면 대기 중이던 요청은 인라인으로 되돌린다(호출자가 폴백을 타게 false).
    writeWorker = null;
    writeWorkerBroken = true;
    if (err) console.warn(`[ipam] 쓰기 워커 종료(${err.message || err}) — 인라인 적재로 폴백합니다.`);
    for (const [, task] of writePending) task.resolve(false);
    writePending.clear();
  };
  worker.on('error', onDown);
  worker.on('exit', (code) => { if (code !== 0) onDown(new Error(`exit ${code}`)); });
  return worker;
}

/** 워커로 적재를 시도한다. 오프로딩하지 않았거나 실패하면 false(호출자가 인라인 수행). */
async function syncViaWorker(rows, updatedAt) {
  if (!OFFLOAD_ENABLED || writeWorkerBroken || rows.length < MIN_OFFLOAD_ROWS) return false;
  try {
    if (!writeWorker) writeWorker = spawnWriteWorker();
  } catch (err) {
    writeWorkerBroken = true;
    console.warn(`[ipam] 쓰기 워커 생성 실패(${err.message}) — 인라인 적재를 사용합니다.`);
    return false;
  }
  const id = ++writeSeq;
  const done = new Promise((resolve, reject) => writePending.set(id, { resolve, reject }));
  writeWorker.ref();
  try {
    // v2.594(감사 PERF-2594-01): 행 객체 전체를 구조화 복제하면 워커가 쓰지 않는 키까지 복사한다(원장이 바뀐 틱마다
    //   메인 스레드 약 30ms). 워커가 쓰는 레코드 배열(컬럼 순서 값)만 보낸다 — toRecord 는 두 쪽이 같은 모듈을 쓴다.
    writeWorker.postMessage({ id, records: rows.map((r) => toRecord(r, updatedAt)) });
    return await done;
  } catch (err) {
    writePending.delete(id);
    console.warn(`[ipam] 워커 적재 실패(${err.message}) — 인라인으로 다시 시도합니다.`);
    return false;
  }
}

function initJsonFallback() {
  const file = DB_PATH.replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    kind: 'ndjson',
    sync: (rows, updatedAt) => {
      const lines = rows.map((r) => JSON.stringify(Object.fromEntries(COLUMNS.map((c, i) => [c, toRecord(r, updatedAt)[i]]))));
      fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    },
    info: () => {
      try {
        const txt = fs.readFileSync(file, 'utf8').trim();
        const n = txt ? txt.split('\n').length : 0;
        let at = null;
        if (n) { try { at = JSON.parse(txt.split('\n')[0]).updated_at; } catch { /* ignore */ } }
        return { count: n, updatedAt: at };
      } catch { return { count: 0, updatedAt: null }; }
    },
  };
}

async function getImpl() {
  if (impl) return impl;
  // v2.603 DB2603-01: 잠금으로 실패한 직후에는 매 호출마다 3초 busy_timeout 을 태우지 않는다 — 재시도 시각까지 이번 동기화는 실패로 둔다
  //   (store 는 서명을 성공 뒤에만 기록하므로 다음 주기에 다시 쓴다). NDJSON 으로 굳히지 않는다.
  if (!ready && lockRetry.blocked()) throw Object.assign(new Error(lockRetry.note() || 'ipam.db 잠김'), { ipamLocked: true });
  if (!ready) {
    ready = initSqlite().then((v) => { lockRetry.ok(); return v; }, (err) => {
      if (lockRetry.onFail(err)) {
        ready = null; // 래치하지 않는다 — 재시도 시각 뒤 다시 연다
        console.warn(`[ipam] ipam.db 가 잠겨 있어 열지 못했습니다(${err.message}) — NDJSON 으로 바꾸지 않고 잠시 뒤 다시 엽니다.`);
        throw Object.assign(new Error(lockRetry.note() || 'ipam.db 잠김'), { ipamLocked: true });
      }
      console.warn(`[ipam] node:sqlite 사용 불가(${err.code || err.message}); NDJSON 폴백 사용.`);
      return initJsonFallback();
    });
  }
  impl = await ready;
  return impl;
}

/** Replace the entire shared ledger with the given rows. Best-effort. 성공 여부를 반환한다. */
export async function syncLedger(rows) {
  try {
    const i = await getImpl();
    // sync 는 워커 오프로딩 시 Promise 를 돌려준다 — await 하지 않으면 실패가
    // unhandled rejection 으로 새고 호출자는 성공했다고 믿는다.
    await i.sync(rows, new Date().toISOString());
    return true;
  } catch (err) {
    console.warn(`[ipam] 레저 저장 실패: ${err.message}`);
    return false;
  }
}

/** DB location + record count, for the admin UI. */
export async function ledgerInfo() {
  let i;
  try { i = await getImpl(); } catch (e) {
    // 잠금으로 아직 열지 못했다 — 개수를 지어내지 않는다(null) · 사유를 싣는다.
    if (e?.ipamLocked) return { path: DB_PATH, kind: 'sqlite', count: null, updatedAt: null, locked: true, note: String(e.message || '') };
    throw e;
  }
  return { path: i.kind === 'sqlite' ? DB_PATH : DB_PATH.replace(/\.db$/, '') + '.ndjson', kind: i.kind, ...i.info() };
}
