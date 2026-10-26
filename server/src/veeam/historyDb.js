/**
 * veeam/historyDb.js — Veeam 일 단위 이력 DB(v2.788 · veeam-history.db).
 *
 * 왜: 사용자 요청 '라이선스 만료 알림·추이' 와 v2.789 '저장소 소진 예측' 은 **지난 값**이 있어야 그린다 — 마지막 결과만 들고 있는
 *   veeam-latest.json·veeam-em-latest.json 으로는 추이를 만들 수 없다. 그래서 v2.788 부터 하루 한 점씩 쌓는다(그날의 마지막 값으로 덮는다).
 *
 * 표(키 + 날짜가 기본 키 — 같은 날 다시 쓰면 갱신, 이중 계수 없음 · ON CONFLICT DO UPDATE):
 *   license_daily(src, day, ts, used, licensed, sockets_used, sockets_licensed, expires, support_expires) — src = 'vbr:<서버 id>'
 *   repo_daily(src, repo, day, ts, capacity, free, backup_size) — src = 'em:<EM id>' · repo = '<백업 서버>|<저장소 이름>'
 * 값을 못 읽었으면 NULL(0 이 아니다 — util/numOrNull.js 규칙).
 * 보관: 400일(KEEP_DAYS) — prune 은 쓰기 N회마다 1회(기동 첫 회 금지) · day 단독 인덱스 · 청크 삭제(util/chunkedPrune.js).
 * 한 번의 기록은 한 트랜잭션(대량 쓰기를 행마다 커밋하지 않는다 — CLAUDE.md 성능 규칙).
 * node:sqlite 를 못 쓰면 기록은 건너뛰고(경고 1회) 조회는 빈 목록 — 화면은 '이력 없음' 으로 말한다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { dayIndex } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';

export const KEEP_DAYS = 400;
const PRUNE_EVERY = 24;
const dbPath = () => config.veeamHistory?.dbPath || path.join(config.configDir, 'veeam-history.db');

let _db = null;
let _opening = null;
let unavailable = false;
let _warned = false;
let _writes = 0;
const _lock = createLockRetry(30_000);

function initSqlite(file) {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = openSqlite(new DatabaseSync(file));
    try { fs.chmodSync(file, 0o600); } catch { /* best effort — v2.503 S-5 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS license_daily (
        src TEXT NOT NULL, day INTEGER NOT NULL, ts INTEGER NOT NULL,
        used REAL, licensed REAL, sockets_used REAL, sockets_licensed REAL, expires INTEGER, support_expires INTEGER,
        PRIMARY KEY (src, day)
      );
      CREATE INDEX IF NOT EXISTS idx_lic_day ON license_daily (day);
      CREATE TABLE IF NOT EXISTS repo_daily (
        src TEXT NOT NULL, repo TEXT NOT NULL, day INTEGER NOT NULL, ts INTEGER NOT NULL,
        capacity REAL, free REAL, backup_size REAL,
        PRIMARY KEY (src, repo, day)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_day ON repo_daily (day);
    `);
    return {
      raw: db,
      upLic: db.prepare(`INSERT INTO license_daily (src, day, ts, used, licensed, sockets_used, sockets_licensed, expires, support_expires)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(src, day) DO UPDATE SET ts=excluded.ts, used=excluded.used, licensed=excluded.licensed, sockets_used=excluded.sockets_used,
          sockets_licensed=excluded.sockets_licensed, expires=excluded.expires, support_expires=excluded.support_expires
        WHERE excluded.ts >= license_daily.ts`),
      upRepo: db.prepare(`INSERT INTO repo_daily (src, repo, day, ts, capacity, free, backup_size) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(src, repo, day) DO UPDATE SET ts=excluded.ts, capacity=excluded.capacity, free=excluded.free, backup_size=excluded.backup_size
        WHERE excluded.ts >= repo_daily.ts`),
      licSince: db.prepare('SELECT src, day, used, licensed, sockets_used, sockets_licensed, expires, support_expires FROM license_daily WHERE day >= ? ORDER BY src, day'),
      delLic: db.prepare('DELETE FROM license_daily WHERE rowid IN (SELECT rowid FROM license_daily WHERE day < ? LIMIT ?)'),
      delRepo: db.prepare('DELETE FROM repo_daily WHERE rowid IN (SELECT rowid FROM repo_daily WHERE day < ? LIMIT ?)'),
      repoSince: db.prepare('SELECT src, repo, day, capacity, free, backup_size FROM repo_daily WHERE day >= ? ORDER BY src, repo, day'),
    };
  });
}

/** DB 핸들(없으면 null). 진행 중인 open 을 공유한다(동시 첫 호출이 두 번 열지 않게 — test/arch2580). 잠금이면 래치하지 않고 30초 뒤 다시. */
export async function getHistoryDb() {
  if (_db) return _db;
  if (unavailable || _lock.blocked()) return null;
  if (!_opening) {
    _opening = withOpenCleanup(() => initSqlite(dbPath()))
      .then((db) => { _lock.ok(); return db; })
      .catch((e) => {
        if (!_lock.onFail(e)) unavailable = true;
        if (!_warned) { _warned = true; console.warn(`[veeam-history] 이력 DB 를 열지 못했습니다 — 라이선스·저장소 추이를 쌓지 않습니다: ${String(e?.message || e).slice(0, 200)}`); }
        return null;
      });
  }
  const p = _opening;
  const db = await p;
  if (db) _db = db; else if (_opening === p) _opening = null;
  return db;
}

async function maybePrune(db) {
  if ((++_writes % PRUNE_EVERY) !== 0) return;   // 기동 첫 쓰기에서는 돌지 않는다
  const cut = dayIndex(Date.now()) - KEEP_DAYS;
  try {
    await chunkedDelete(db.delLic, [cut]);
    await chunkedDelete(db.delRepo, [cut]);
  } catch (e) { console.warn(`[veeam-history] 오래된 이력 정리 실패(다음에 다시): ${String(e?.message || e).slice(0, 200)}`); }
}

const n = (v) => numOrNull(v);
/** 라이선스 한 점(B&R 서버 1대). lic = veeam/parse.js licenseOf 결과. */
export async function recordLicenseDaily(src, lic, ts = Date.now()) {
  if (!lic || typeof lic !== 'object') return false;
  const db = await getHistoryDb();
  if (!db) return false;
  db.upLic.run(String(src).slice(0, 200), dayIndex(ts), ts, n(lic.instances?.used), n(lic.instances?.licensed), n(lic.sockets?.used), n(lic.sockets?.licensed),
    n(lic.expires), n(lic.supportExpires));
  await maybePrune(db);
  return true;
}

/** 저장소 여러 개를 한 트랜잭션으로. rows = [{ key, capacity, free, backupSize }]. */
export async function recordRepoDaily(src, rows, ts = Date.now()) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.key === 'string' && r.key).slice(0, 2000);
  if (!list.length) return 0;
  const db = await getHistoryDb();
  if (!db) return 0;
  const day = dayIndex(ts);
  db.raw.exec('BEGIN');
  try {
    for (const r of list) db.upRepo.run(String(src).slice(0, 200), r.key.slice(0, 300), day, ts, n(r.capacity), n(r.free), n(r.backupSize));
    db.raw.exec('COMMIT');
  } catch (e) { try { db.raw.exec('ROLLBACK'); } catch { /* */ } throw e; }
  await maybePrune(db);
  return list.length;
}

/** 최근 N일 라이선스 이력 — src → [[day, used, licensed]]. DB 가 없으면 null(모름 — 빈 이력과 구분). */
export async function licenseHistory(days = 90, now = Date.now()) {
  const db = await getHistoryDb();
  if (!db) return null;
  const out = {};
  for (const r of db.licSince.all(dayIndex(now) - days)) (out[r.src] ||= []).push([r.day, r.used, r.licensed]);
  return out;
}
/** 최근 N일 저장소 이력 — 'src|repo' → [[day, capacity, free]]. */
export async function repoHistory(days = 90, now = Date.now()) {
  const db = await getHistoryDb();
  if (!db) return null;
  const out = {};
  for (const r of db.repoSince.all(dayIndex(now) - days)) (out[`${r.src}#${r.repo}`] ||= []).push([r.day, r.capacity, r.free]);
  return out;
}

export function _resetHistoryDbForTest() { try { _db?.raw.close(); } catch { /* */ } _db = null; _opening = null; unavailable = false; _warned = false; _writes = 0; _lock.ok(); }
