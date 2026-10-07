/**
 * sanswitch/perfDb.js — SAN 스위치 포트 사용량(처리량) 시계열 DB(v2.411, 사용자 요구
 * '주기적으로 portperfshow 를 수행해서 포트 사용량 수집하는 DB').
 *
 * 파일: <dbDir|configDir>/sanswitch-perf.db  (storage/db.js 와 동일한 경로 규약)
 *  - port_perf : (device_id, ts, port, bps) — **바이트/초**. portperfshow 가 주는 원단위를
 *                그대로 저장한다. 화면에서 ×8 해 bps 로 환산한다(저장 단계에서 환산하면
 *                나중에 어느 단위였는지 되짚을 수 없다).
 *  - port_meta : 포트에 붙어 있던 장비 이름/속도 스냅샷 — 시계열을 '어느 스토리지의 트래픽'
 *                으로 묶어 보기 위한 것(연결이 바뀌어도 과거 집계가 흔들리지 않게 시점별 저장).
 *
 * CLAUDE.md 성능 규칙 준수:
 *  - WAL + synchronous=NORMAL + busy_timeout=3000
 *  - **대량 insert 는 반드시 트랜잭션**(128포트 × N대 × 주기 — 무트랜잭션이면 fsync 폭주)
 *  - prune 은 매 저장이 아니라 N회마다 1회(스로틀) + **ts 단독 인덱스**(DELETE WHERE ts<? 풀스캔 방지)
 *  - node:sqlite 미지원 환경은 no-op 폴백(수집·화면은 살아있고 DB 만 비활성 — available() 로 정직 표기)
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { loadPerfSettings } from './perfSettings.js';
import { isMockMode } from '../mock/demo/flags.js';
import { numOrNull } from '../util/numOrNull.js';
import { isDemoPerfQuery, demoStorageMulti, demoStorageOne, demoPortSeries } from './demoPerfSynth.js';   // v2.715 목업: 수식으로 만든다
import { createYielder } from '../util/timeSlice.js';   // v2.621(감사 DATA-03): 이월 한계 = 수집 주기 × 2
const lockRetry = createLockRetry();

const FILE = () => path.join(config.dbDir || config.configDir, 'sanswitch-perf.db');
const PRUNE_EVERY = 20;      // N회 저장마다 1회만 prune
let _db = null;              // { conn, ... } | 'unavailable'
let _pruneTick = 0;

// v2.602(감사 CEN2602-05): 엣지가 올리는 포트 번호·메타 문자열의 범위. 포트 번호는 PK 의 일부라 범위가 없으면
//   port_meta 가 엣지 하나로 무한히 커진다(prune 도 없었다). 디렉터 최대 768포트에 여유를 둔 0~4095.
export const PORT_MAX = 4095;
const META_TEXT_MAX = 128;
const portOk = (p) => Number.isInteger(p) && p >= 0 && p <= PORT_MAX;
const metaText = (v) => (typeof v === 'string' ? v : (typeof v === 'number') ? String(v) : '').slice(0, META_TEXT_MAX);

// v2.580(BUG-A): **진행 중인 open 을 공유한다** — 예전에는 `_db` 검사와 `await import('node:sqlite')`
// 사이에서 두 번째 호출이 들어오면 같은 파일에 `DatabaseSync` 가 **둘** 만들어지고 첫 핸들이 새어
// 나갔다(v2.580 재현: 동시 2호출 → 같은 파일 fd 2개). `bmusage/db.js`(v2.550)와 같은 패턴이다.
let _opening = null;
async function open() {
  if (_db) return _db === 'unavailable' ? null : _db;
  if (lockRetry.blocked()) return null;   // 잠금 뒤 재시도 대기(매 호출 3초 busy_timeout 을 태우지 않게)
  if (_opening) return _opening;
  _opening = openInner().finally(() => { _opening = null; });
  return _opening;
}
async function openInner() {
  if (_db) return _db === 'unavailable' ? null : _db;
  let conn = null;   // v2.599 DB2599-02: 실패하면 닫는다(잠금이면 래치하지 않고 다시 연다)
  try {
    const { DatabaseSync } = await import('node:sqlite');
    conn = openSqlite(new DatabaseSync(FILE()));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
    // v2.447(감사 S4): DB 파일 권한 0600 — 다른 DB 모듈(idrac/metrics/logs/ipam/vmtrack/capacity/ping)은
    // 전부 적용돼 있는데 이 파일만 빠져 있었다. 같은 호스트의 다른 로컬 사용자가 읽을 수 있었다.
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`CREATE TABLE IF NOT EXISTS port_perf (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL, port INTEGER NOT NULL, bps INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pp_ts ON port_perf (ts);
      CREATE INDEX IF NOT EXISTS idx_pp_dev_ts ON port_perf (device_id, ts);
      CREATE INDEX IF NOT EXISTS idx_pp_dev_port_ts ON port_perf (device_id, port, ts);
      CREATE TABLE IF NOT EXISTS port_meta (
        device_id TEXT NOT NULL, port INTEGER NOT NULL, ts INTEGER NOT NULL,
        attached_name TEXT, attached_wwn TEXT, speed TEXT, port_type TEXT,
        PRIMARY KEY (device_id, port)
      );`);
    _db = {
      conn,
      ins: conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) VALUES (?,?,?,?)'),
      upMeta: conn.prepare(`INSERT INTO port_meta (device_id, port, ts, attached_name, attached_wwn, speed, port_type)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(device_id, port) DO UPDATE SET ts=excluded.ts, attached_name=excluded.attached_name,
          attached_wwn=excluded.attached_wwn, speed=excluded.speed, port_type=excluded.port_type`),
      // v2.503: importSamples 의 포트별 '더 새로운 메타만 반영' 조회. 예전에는 루프 안에서
      // prepare() 를 새로 만들어 디렉터(512~768포트) push 마다 그만큼 SQL 파싱이 반복됐다.
      metaTs: conn.prepare('SELECT ts FROM port_meta WHERE device_id = ? AND port = ?'),
    };
    return _db;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[sanswitch-perf] ${lockRetry.note()}`); return null; }
    console.warn(`[sanswitch-perf] DB 사용 불가(수집은 계속, 이력만 비활성): ${e.message}`);
    _db = 'unavailable';
    return null;
  }
}

export async function available() { return !!(await open()); }
/** 테스트 전용 — 열린 핸들(조각 집계 대조용). */
export async function _dbForTest() { return open(); }

/**
 * 엣지 → 중앙 중계(v2.423, 사용자 요구 '엣지 스위치도 중앙에서 사용량 분석'). 엣지가 마지막으로 올린 rowid 뒤의 표본을
 * 커서 방식으로 읽는다(전량 재전송 금지 — 고RTT 회선). rows: [{ rowid, d, ts, p, b }]
 */
export async function samplesAfter(rowid = 0, limit = 20_000) {
  const db = await open();
  if (!db) return { rows: [], maxRowid: rowid, unavailable: true };
  const rows = db.conn.prepare('SELECT rowid AS rowid, device_id AS d, ts, port AS p, bps AS b FROM port_perf WHERE rowid > ? ORDER BY rowid LIMIT ?')
    .all(Number(rowid) || 0, Math.max(1, Math.min(100_000, Number(limit) || 20_000)));
  return { rows, maxRowid: rows.length ? Number(rows[rows.length - 1].rowid) : (Number(rowid) || 0) };
}

/** 현재 최대 rowid(중계 커서 리셋 감지용, v2.425). 표가 비면 0. */
export async function maxRowid() {
  const db = await open();
  if (!db) return null;
  const r = db.conn.prepare('SELECT MAX(rowid) AS m FROM port_perf').get();
  return Number(r?.m || 0);
}

/** 장비들의 port_meta(연결 장비 이름·속도) — 중계 시 함께 보내 중앙이 스토리지별로 묶을 수 있게. */
export async function metaFor(deviceIds = []) {
  const db = await open();
  if (!db || !deviceIds.length) return [];
  const ids = [...new Set(deviceIds.map(String))].slice(0, 500);
  return db.conn.prepare(`SELECT device_id AS d, port AS p, ts, attached_name AS name, attached_wwn AS wwn, speed, port_type AS type FROM port_meta WHERE device_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
}

/** 각 장비의 최신 표본 시각(중앙 화면 '엣지 마지막 반영' 표시용). → Map(deviceId → ts) */
export async function latestSampleTs(deviceIds = []) {
  const out = new Map();
  // v2.715 목업: 데모 장비는 표본을 저장하지 않고 조회 때 만든다 — '마지막 표본' 은 지금이다(수집이 멈췄다는 거짓 진단 방지).
  if (isMockMode()) for (const id of deviceIds) if (String(id).startsWith('mock-san-')) out.set(String(id), Date.now());
  const db = await open();
  if (!db || !deviceIds.length) return out;
  const ids = [...new Set(deviceIds.map(String))].slice(0, 500);
  // v2.583(감사 확정 — 반증 에이전트 실측 8.85M 행): `IN (...) GROUP BY device_id` + MAX(ts) 는 SQLite 의 min/max
  //   단축을 끄고 **각 스위치의 인덱스 항목을 전부** 훑었다(665ms/호출 — 화면을 열 때마다). 장비별 단독 MAX 는
  //   `idx_pp_dev_ts` 끝 하나만 읽는다(0.04ms 합계). v2.550.3 이 기록한 '최신 1건씩을 GROUP BY+MAX 로 만들지 말 것' 의 재발.
  const q = db.conn.prepare('SELECT MAX(ts) AS ts FROM port_perf WHERE device_id = ?');
  for (const id of ids) {
    const r = q.get(id);
    if (r && r.ts != null) out.set(id, Number(r.ts));
  }
  return out;
}

/**
 * 중앙: 엣지가 올린 표본을 적재(트랜잭션 1회). 같은 (device, ts, port) 가 이미 있으면 건너뛴다 — 엣지가 부분 성공 뒤
 * 재전송해도 중복이 쌓이지 않게(idx_pp_dev_port_ts 로 탐색). rows: [{d,ts,p,b}], meta: [{d,p,ts,name,wwn,speed,type}]
 * ⚠ 호출자가 소유권(deviceId ∈ devicesForAgent) 을 먼저 걸러야 한다.
 */
export async function importSamples(rows = [], meta = [], retentionDays = 90) {
  invalidatePerfQueries();   // v2.693: 쓰기 뒤에는 기억한 조회 결과를 버린다(방금 넣은 표본이 안 보이면 '저장이 안 됐나' 로 읽힌다)
  const db = await open();
  if (!db) return { inserted: 0, skipped: 0, unavailable: true };
  const ins = db.conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM port_perf WHERE device_id = ? AND port = ? AND ts = ?)');
  let inserted = 0, skipped = 0, metaRejected = 0;
  db.conn.exec('BEGIN');
  try {
    for (const r of rows) {
      const d = String(r.d ?? ''), ts = Number(r.ts), p = Number(r.p), b = Math.max(0, Math.round(Number(r.b)));
      if (!d || !Number.isFinite(ts) || !portOk(p) || !Number.isFinite(b)) { skipped++; continue; }
      const x = ins.run(d, ts, p, b, d, p, ts);
      if (Number(x.changes) > 0) inserted++; else skipped++;
    }
    for (const m of meta) {
      const d = String(m.d ?? ''); const p = Number(m.p);
      if (!d || !portOk(p)) { metaRejected++; continue; }
      // 더 새로운 메타만 반영(엣지 청크가 순서 없이 와도 최신을 유지)
      // v2.503: 예전에는 이 줄에서 포트마다 `prepare()` 를 새로 만들었다 — 디렉터 1대가 512~768포트라
      // 한 요청에 그만큼 SQL 파싱·계획 수립이 반복됐다(같은 파일의 upMeta 는 이미 초기화 때 준비돼 있다).
      const cur = db.metaTs.get(d, p);
      if (cur && Number(cur.ts) > Number(m.ts)) continue;
      db.upMeta.run(d, p, Number(m.ts) || Date.now(), metaText(m.name), metaText(m.wwn), metaText(m.speed), metaText(m.type));
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (inserted > 0) _counts = null;
  if (++_pruneTick % PRUNE_EVERY === 0) pruneInBackground(db, retentionDays);
  // 범위 밖 포트·빈 장비 id 로 버린 메타 개수를 밝힌다(조용히 버리지 않는다).
  return { inserted, skipped, ...(metaRejected ? { metaRejected } : {}) };
}

/**
 * 한 번의 수집 결과 저장. samples = { [port]: bytesPerSec }, meta = [{port, attachedName, ...}].
 * ⚠ 128포트 × 스위치 수를 매 주기 쓰므로 **반드시 트랜잭션**으로 묶는다(CLAUDE.md — 과거 IPAM
 *   무트랜잭션 6천 행이 25초 블로킹을 낸 사고와 같은 종류).
 */
export async function savePerfSample(deviceId, ts, samples = {}, meta = [], retentionDays = 90) {
  invalidatePerfQueries();   // v2.693: 쓰기 뒤에는 기억한 조회 결과를 버린다(방금 넣은 표본이 안 보이면 '저장이 안 됐나' 로 읽힌다)
  const db = await open();
  if (!db) return { saved: 0, skipped: 'DB 비활성' };
  const rows = Object.entries(samples).filter(([, v]) => Number.isFinite(Number(v)));
  db.conn.exec('BEGIN');
  try {
    for (const [port, bps] of rows) db.ins.run(String(deviceId), ts, Number(port), Math.max(0, Math.round(Number(bps))));
    for (const m of meta) {
      db.upMeta.run(String(deviceId), Number(m.port), ts, m.attachedName || '', m.attachedWwn || '', m.speed || '', m.portType || '');
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }

  if (rows.length) _counts = null;
  if (++_pruneTick % PRUNE_EVERY === 0) pruneInBackground(db, retentionDays);
  return { saved: rows.length };
}

/**
 * v2.602(감사 DB2602-01): prune 은 **청크 DELETE + 청크 사이 양보**다(util/chunkedPrune.js, v2.453 규약).
 * 예전 `DELETE FROM port_perf WHERE ts < ?` 한 방은 보존일을 줄이거나 '지금 정리' 를 누르면 수백만 행을 동기로 지워
 * 이벤트 루프가 수 초 멈췄다(감사 재현: 276만 행 5.4초). 청크 사이에 적재가 끼어들 수 있으므로 prune 끼리는 겹치지 않게
 * 한다(단일 비행 — 진행 중이면 그 프라미스를 공유한다). port_meta 도 같은 보존일로 정리한다(CEN2602-05 — 예전에는
 * port_perf 만 지워 메타가 영구히 남았다). 메타 ts 는 수집마다 갱신되므로 보존일 동안 갱신이 없던 포트만 지워진다.
 */
// v2.603(감사 RECENT2603-06 — 재현): 공유는 **같은 보존일일 때만**이다. 예전에는 진행 중인 백그라운드 정리를 무조건
// 공유해, 보존일을 줄이고 '지금 정리' 를 누르면 옛 경계로 도는 정리의 결과(deleted:0)를 돌려받았다(새 경계보다 오래된 행이
// 남은 채로 '정리됨'). 보존일이 다르면 진행 중인 것이 끝난 뒤 새 경계로 한 번 더 돈다(끼리 겹치지 않는 규칙은 그대로).
const _pruneFlight = createPruneFlight();   // util/chunkedPrune.js — 같은 보존일이면 공유, 다르면 끝난 뒤 한 번 더
// v2.719(감사 R2-01): prune 은 청크 사이에 양보하므로 그 동안 조회 감시(restartEngine)가 핸들을 닫으면 준비문이
//   finalize 되어 '이미 지운 청크가 있는데 deleted:0' 이 됐다(재현). 쓰는 동안 핸들을 '사용 중' 으로 잡고, 재시작은
//   사용자가 다 끝난 뒤에 옛 핸들을 닫는다. 대기열에서 늦게 도는 prune 은 넘겨받은 db 대신 지금 핸들을 연다
//   (그 사이 재시작으로 넘겨받은 핸들이 닫혔을 수 있다).
function holdDb(db) { db.users = (db.users || 0) + 1; return () => { db.users -= 1; if (db.retired && db.users <= 0) closeDb(db); }; }
function closeDb(db) { if (db.closed) return; db.closed = true; try { db.conn?.close?.(); } catch { /* 닫기 실패는 무시 — 새로 연다 */ } }
function retireDb(db) { if (!db || db === 'unavailable') return; db.retired = true; if (!(db.users > 0)) closeDb(db); }
function pruneOld(db, retentionDays) {
  const days = Math.max(1, Number(retentionDays) || 90);
  return _pruneFlight.run(days, async () => {
    if (db.retired || db.closed) db = await open();
    if (!db) throw new Error('DB 를 열 수 없습니다');
    const release = holdDb(db);
    try { return await pruneOldInner(db, days); } finally { release(); }
  });
}
async function pruneOldInner(db, days) {
  const cut = Date.now() - days * 86400e3;
  // ts 단독 인덱스(idx_pp_ts)가 rowid 서브쿼리의 풀스캔을 막는다
  const stmt = db.conn.prepare('DELETE FROM port_perf WHERE rowid IN (SELECT rowid FROM port_perf WHERE ts < ? LIMIT ?)');
  const r = await chunkedDelete(stmt, [cut], { label: 'sanswitch-perf.port_perf' });
  const meta = db.conn.prepare('DELETE FROM port_meta WHERE ts < ?').run(cut); // 장비×포트(≤4096) 규모라 한 번에
  if (r.deleted > 0 || Number(meta?.changes) > 0) {
    _counts = null;
    console.log(`[sanswitch-perf] prune ${r.deleted.toLocaleString()}행 삭제(${r.chunks}청크)${r.done ? '' : ' — 상한 도달, 다음 주기에 계속'} · 메타 ${Number(meta?.changes || 0)}행`);
  }
  return { deleted: r.deleted, done: r.done, metaDeleted: Number(meta?.changes || 0) };
}
/** 적재 경로용 — 기다리지 않는다. 실패는 콘솔에 남긴다(조용히 삼키지 않는다). */
function pruneInBackground(db, retentionDays) {
  pruneOld(db, retentionDays).catch((e) => console.warn(`[sanswitch-perf] prune 실패: ${e.message}`));
}

/**
 * 보관 기간 즉시 적용(v2.420, 설정 화면 '지금 정리') — 삭제 행 수를 돌려준다. 한 번에 상한(PRUNE_MAX_ROWS)까지만
 * 지우고 남으면 `done:false` 로 밝힌다(다시 누르거나 다음 주기가 이어서 지운다).
 */
export async function pruneNow(retentionDays) {
  invalidatePerfQueries();   // v2.693: 쓰기 뒤에는 기억한 조회 결과를 버린다(방금 넣은 표본이 안 보이면 '저장이 안 됐나' 로 읽힌다)
  const db = await open();
  if (!db) return { deleted: 0, unavailable: true };
  try {
    const r = await pruneOld(db, retentionDays);
    return { deleted: r.deleted, done: r.done, metaDeleted: r.metaDeleted };
  } catch (e) { console.warn(`[sanswitch-perf] prune 실패: ${e.message}`); return { deleted: 0, error: e.message }; }
}

/**
 * 조회 구간(v2.420) — hours(최근 N시간) 또는 from/to(사용자 지정 기간, ms). 버킷 폭은 구간을 points 개로 나눈 값
 * (하한 60초). 구간이 길수록 버킷이 넓어져 평균은 더 평탄해진다(화면 설명에 명시).
 */
/*
 * v2.693 — 시간 조각 집계(운영 멈춤 대응). 2026-10-04 운영 중앙이 이벤트 루프를 **701초** 멈췄고(stallwatch — JS 스택 없음 =
 *   네이티브 동기 호출), 직전 두 멈춤(19초·15초)은 이 모듈의 조회였다(확정 아님 — 정직 기록). 예전 조회는 법인의 **전 스위치 × 전 포트 ×
 *   요청 기간**(최대 366일)을 SQL 한 문장으로 GROUP BY 해 그 동안 포탈 전체가 응답하지 않았다.
 *   지금은 장비마다·버킷 정배수 시간 조각(기본 6시간, 버킷이 더 크면 버킷 하나)마다 따로 묻고 조각 사이에 **시간 기준으로 양보**한다
 *   (v2.672 createYielder). 버킷 경계에 조각을 맞추므로 한 (장비, 포트, 버킷) 그룹은 정확히 한 조각에만 들어가고, 결과는 예전 한 문장과
 *   **같다**(테스트가 대조한다). 한 조각 비용은 '스위치 1대 × 6시간' 이라 장비 수·기간에 비례해 커지지 않는다.
 */
const SLICE_TARGET_MS = 6 * 3600_000;
export function sliceBounds(since, until, bucketMs) {
  const b = Math.max(1, Math.floor(Number(bucketMs) || 1));
  const width = Math.max(b, Math.floor(SLICE_TARGET_MS / b) * b);
  const out = [];
  let lo = Number(since);
  const end = Number(until);
  let next = (Math.floor(lo / b) * b) + width;            // 첫 조각 끝도 버킷 경계(정배수)에 둔다
  while (lo <= end) {
    const hi = Math.min(end, next - 1);                    // ts 는 정수 — 조각 끝은 다음 경계 - 1(포함)
    out.push([lo, hi]);
    lo = next; next += width;
  }
  return out;
}

/**
 * (device, port, b) 버킷 집계를 장비·조각 단위로 나눠 실행한다. 반환 행 모양은 예전 단일 문장과 같다.
 * @param {{ ports?: number[]|null, lastTs?: boolean, yielder?: Function }} opt
 */
export async function bucketAgg(db, deviceIds, since, until, bucketMs, { ports = null, lastTs = false, yielder = createYielder(15), sort = true, gen = null } = {}) {
  const pf = ports?.length ? ` AND port IN (${ports.map(() => '?').join(',')})` : '';
  const stmt = db.conn.prepare(
    `SELECT device_id, port, (ts / ${bucketMs}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps${lastTs ? ', MAX(ts) AS last_ts' : ''}
       FROM port_perf WHERE device_id = ? AND ts >= ? AND ts <= ?${pf}
      GROUP BY port, b`,
  );
  const slices = sliceBounds(since, until, bucketMs);
  const rows = [];
  for (const id of deviceIds) {
    for (const [lo, hi] of slices) {
      const part = stmt.all(String(id), lo, hi, ...(ports || []));
      for (const r of part) rows.push(r);
      await yielder();
      if (gen != null) checkCancel(gen);   // v2.715: 감시가 엔진을 재시작했으면 여기서 멈춘다
    }
  }
  // v2.713: 정렬이 필요 없는 호출자(storageSeriesMulti — 버킷 목록을 따로 정렬한다)는 sort:false. 데모 SAN 86대·24h(33만 행)에서
  //   이 정렬 하나가 양보 없이 약 0.3초를 먹었다.
  if (sort) rows.sort((x, y) => Number(x.b) - Number(y.b));
  return rows;
}

/*
 * v2.693 — 같은 조회는 한 번만, 무거운 조회는 한 번에 하나만. 화면 두세 곳(트래픽 카드·법인별 사용량·포트 차트)이 같은 기간을
 *   동시에 열면 같은 집계가 겹쳐 돌았다. 결과는 PERF_QUERY_TTL_MS(기본 20초) 기억한다 — 표본 주기(기본 5분)보다 훨씬 짧아 낡음은
 *   무시할 수 있고, 응답의 until 이 그 사실을 말한다. 진행 중인 같은 조회는 합류한다. 서로 다른 조회는 줄을 서서 하나씩 돈다.
 */
const PERF_QUERY_TTL_MS = Math.max(0, Number(process.env.SANSW_PERF_QUERY_TTL_MS ?? 20_000) || 0);
const _qcache = new Map();          // key → { at, promise }
let _chain = Promise.resolve();
let _queryStats = { runs: 0, joined: 0, cached: 0, maxQueue: 0, queued: 0, lastMs: null, maxMs: 0 };
/*
 * v2.715 — 조회 감시(사용자 지시 "SAN 사용량 조회가 1분이 넘어가면 그 서비스를 재시작해 전체 서비스를 복원"):
 *   한 조회가 PERF_QUERY_MAX_MS(기본 60초)를 넘으면 **조회 엔진만** 재시작한다 — 그 조회를 실패로 끝내 기다리던 요청에
 *   사유를 돌려주고, 취소 세대(_cancelGen)를 올려 진행 중인 집계가 다음 양보 지점에서 멈추게 하고, 기억한 결과를 버리고,
 *   DB 핸들을 다시 연다. 뒤에 줄 선 다른 조회는 곧바로 이어서 돈다. 포탈 프로세스 전체를 재시작하지 않는다 — 집계는 양보하며
 *   돌기 때문에 다른 화면은 살아 있고, 프로세스 재시작은 모든 사용자의 세션·폴러를 함께 끊는다.
 */
// 빈 값·숫자 아님·범위(10초~1시간) 밖은 기본 60초(Number('') === 0 이 시한 0 이 되지 않게 — TIM2605-04 규약).
const _qmEnv = numOrNull(process.env.SANSW_PERF_QUERY_MAX_MS ?? 60000);
const PERF_QUERY_MAX_MS = _qmEnv != null && _qmEnv >= 10_000 && _qmEnv <= 3_600_000 ? Math.round(_qmEnv) : 60_000;
let _cancelGen = 0;
let _restarts = { count: 0, lastAt: null, lastKey: null, lastMs: null };
/** 진행 중인 집계가 양보 지점마다 부른다 — 감시가 엔진을 재시작했으면 그 자리에서 멈춘다. */
function checkCancel(gen) { if (gen !== _cancelGen) { const e = new Error('조회 엔진이 재시작되어 이 집계를 멈췄습니다'); e.cancelled = true; throw e; } }
function restartEngine(key, ms) {
  _cancelGen += 1;
  _qgen += 1; _qcache.clear();
  _restarts = { count: _restarts.count + 1, lastAt: Date.now(), lastKey: String(key).slice(0, 200), lastMs: ms };
  retireDb(_db);   // v2.719(감사 R2-01): 진행 중인 prune 이 쥔 핸들은 그 prune 이 끝난 뒤에 닫는다
  _db = null;
  console.warn(`[sanswitch-perf] 사용량 조회가 ${Math.round(ms / 1000)}초를 넘어 조회 엔진을 재시작했습니다(${_restarts.count}회째) — 대기 중인 다른 조회는 이어서 돕니다.`);
}
export function perfQueryStats() { return { ..._queryStats, ttlMs: PERF_QUERY_TTL_MS, maxQueryMs: PERF_QUERY_MAX_MS, restarts: { ..._restarts } }; }
function heavyQuery(key, fn) {
  const now = Date.now();
  for (const [k, v] of _qcache) if (now - v.at > PERF_QUERY_TTL_MS && v.done) _qcache.delete(k);
  const hit = _qcache.get(key);
  if (hit) { if (hit.done) _queryStats.cached++; else _queryStats.joined++; return hit.promise; }
  _queryStats.queued++; _queryStats.maxQueue = Math.max(_queryStats.maxQueue, _queryStats.queued);
  const entry = { at: now, done: false, promise: null, gen: _qgen };
  const run = _chain.then(async () => {
    _queryStats.queued--; _queryStats.runs++;
    const t0 = Date.now();
    const gen = _cancelGen;
    let timer = null;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        restartEngine(key, Date.now() - t0);
        const e = new Error(`SAN 사용량 조회가 ${Math.round(PERF_QUERY_MAX_MS / 1000)}초를 넘어 조회 엔진을 재시작했습니다. 잠시 뒤 다시 시도하세요.`);
        e.code = 'query-restarted'; reject(e);
      }, PERF_QUERY_MAX_MS);
    });
    try { return await Promise.race([fn(gen), watchdog]); } finally {
      clearTimeout(timer);
      const ms = Date.now() - t0; _queryStats.lastMs = ms; _queryStats.maxMs = Math.max(_queryStats.maxMs, ms);
    }
  });
  _chain = run.catch(() => {});
  entry.promise = run.then((v) => { entry.done = true; entry.at = Date.now(); if (PERF_QUERY_TTL_MS <= 0 || entry.gen !== _qgen) { if (_qcache.get(key) === entry) _qcache.delete(key); } return v; },
    (e) => { _qcache.delete(key); throw e; });
  _qcache.set(key, entry);
  if (_qcache.size > 200) { const first = _qcache.keys().next().value; _qcache.delete(first); }
  return entry.promise;
}
/** 기억한 조회 결과를 버린다(진행 중인 조회는 끝나면 새로 기억하지 않도록 세대를 올린다). */
let _qgen = 0;
export function invalidatePerfQueries() { _qgen += 1; _qcache.clear(); }
const qkey = (name, o) => JSON.stringify([name, o]);

/** v2.715: 목업 데모 장비의 포트 정보(장비×포트 수천 행 — 작다). DB 를 못 열면 빈 배열(그러면 시리즈도 빈다). */
async function demoMeta(deviceIds) {
  const db = await open();
  if (!db) return [];
  const ids = deviceIds.map(String);
  const out = [];
  const q = db.conn.prepare('SELECT device_id, port, attached_name, speed, port_type FROM port_meta WHERE device_id = ?');
  for (const id of ids) for (const r of q.all(id)) out.push(r);
  return out;
}

export function rangeOf({ hours = 24, from = null, to = null, points = 120 } = {}) {
  const now = Date.now();
  let since, until;
  if (Number.isFinite(Number(from)) && Number(from) > 0) {
    since = Number(from);
    until = Number.isFinite(Number(to)) && Number(to) > since ? Number(to) : now;
  } else {
    until = now;
    since = now - Math.max(1, hours) * 3600e3;
  }
  const span = Math.max(60_000, until - since);
  const bucketMs = Math.max(60_000, Math.round(span / Math.max(10, points)));
  return { since, until, bucketMs, spanHours: span / 3600e3 };
}

/**
 * 포트별 시계열. 데이터가 많으면 화면이 못 그리므로 **버킷 평균**으로 내려준다
 * (버킷 = 요청 구간을 points 개로 나눈 폭). 원시 점을 수만 개 던지면 브라우저가 멈춘다.
 * @returns { buckets:[ts...], series:[{port, name, speed, avg[], max}], bucketMs }
 */
export async function portSeries(deviceId, { hours = 24, ports = null, points = 120, from = null, to = null } = {}) {
  if (isDemoPerfQuery(isMockMode(), [deviceId])) {
    const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
    return demoPortSeries(String(deviceId), await demoMeta([deviceId]), { since, until, bucketMs, ports });
  }
  return heavyQuery(qkey('port', { deviceId: String(deviceId), hours, ports, points, from, to }), async (gen) => {
    const db = await open();
    if (!db) return { buckets: [], series: [], bucketMs: 0, unavailable: true };
    const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
    const rows = await bucketAgg(db, [String(deviceId)], since, until, bucketMs, { ports, gen });   // v2.693: 조각 + 양보
    return { ...shape(db, deviceId, rows, bucketMs, since), until };
  });
}

function shape(db, deviceId, rows, bucketMs, since) {
  const bucketSet = [...new Set(rows.map((r) => Number(r.b)))].sort((a, b) => a - b);
  const buckets = bucketSet.map((b) => b * bucketMs);
  const idx = new Map(bucketSet.map((b, i) => [b, i]));
  const metaRows = db.conn.prepare('SELECT port, attached_name, speed, port_type FROM port_meta WHERE device_id = ?').all(String(deviceId));
  const meta = new Map(metaRows.map((m) => [Number(m.port), m]));
  const byPort = new Map();
  for (const r of rows) {
    const p = Number(r.port);
    if (!byPort.has(p)) {
      const m = meta.get(p) || {};
      byPort.set(p, { port: p, name: m.attached_name || '', speed: m.speed || '', portType: m.port_type || '',
        avg: new Array(buckets.length).fill(null), peak: new Array(buckets.length).fill(null), max: 0 });
    }
    const s = byPort.get(p);
    s.avg[idx.get(Number(r.b))] = Math.round(Number(r.avg_bps));
    s.peak[idx.get(Number(r.b))] = Math.round(Number(r.max_bps)); // 버킷 안 원시 표본 최댓값(v2.420 '피크 기준' 보기)
    s.max = Math.max(s.max, Math.round(Number(r.max_bps)));
  }
  return { buckets, bucketMs, since, series: [...byPort.values()].sort((a, b) => a.port - b.port) };
}

/**
 * 연결 장비(스토리지 어레이)별 집계 — 사용자 요구 '포트 사용량을 분석해서 스토리지 사용량을
 * 볼 수 있게'. 같은 어레이에 여러 포트가 물려 있으므로(SYMMETRIX 의 SAF-1d/3d/5d…) 포트
 * 처리량을 **어레이 단위로 합산**해야 그 스토리지가 실제로 얼마나 쓰이는지 보인다.
 */
export async function storageSeries(deviceId, opt = {}) {
  const { hours = 24, points = 120, from = null, to = null } = opt;
  if (isDemoPerfQuery(isMockMode(), [deviceId])) {
    const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
    return demoStorageOne(await demoMeta([deviceId]), { since, until, bucketMs, storageKey });
  }
  return heavyQuery(qkey('storage', { deviceId: String(deviceId), hours, points, from, to }), (gen) => storageSeriesInner(deviceId, { hours, points, from, to, gen }));
}
async function storageSeriesInner(deviceId, { hours = 24, points = 120, from = null, to = null, gen = null } = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], unavailable: true };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const rows = await bucketAgg(db, [String(deviceId)], since, until, bucketMs, { gen });   // v2.693: 조각 + 양보
  const metaRows = db.conn.prepare('SELECT port, attached_name FROM port_meta WHERE device_id = ?').all(String(deviceId));
  const groupOf = new Map(metaRows.map((m) => [Number(m.port), storageKey(m.attached_name)]));

  const bucketSet = [...new Set(rows.map((r) => Number(r.b)))].sort((a, b) => a - b);
  const buckets = bucketSet.map((b) => b * bucketMs);
  const idx = new Map(bucketSet.map((b, i) => [b, i]));
  // ⚠ 버킷 배열을 0 으로 채우면 안 된다(v2.415 에서 잡은 결함): 버킷 목록은 **조회에 포함된 전
  // 장비의 합집합**이라, 다른 스위치의 표본 시각 때문에 생긴 빈 버킷이 이 스토리지의 '트래픽 0'
  // 으로 계산되어 평균이 내려갔다. 그래서 **조회 범위를 넓히면 같은 스토리지의 평균이 떨어지는**
  // 현상이 생겼다(실측: OC2 가 단독 조회 4.16 Gbps, 전체 조회 3.81 Gbps).
  // null 로 두고 값이 있는 버킷만 평균에 넣는다. 차트도 null 을 끊긴 구간으로 그린다.
  const byGroup = new Map();
  for (const r of rows) {
    const g = groupOf.get(Number(r.port)) || '(미확인)';
    if (!byGroup.has(g)) byGroup.set(g, { key: g, ports: new Set(), sum: new Array(buckets.length).fill(null), peak: new Array(buckets.length).fill(null) });
    const s = byGroup.get(g);
    s.ports.add(Number(r.port));
    const i = idx.get(Number(r.b));
    s.sum[i] = (s.sum[i] ?? 0) + Math.round(Number(r.avg_bps));
    // 피크 시리즈(v2.420): 버킷 안 **포트별 원시 샘플 최댓값(MAX)** 을 포트 간 합산. 평균 시리즈보다 피크에 가깝지만
    // 포트마다 최댓값 시각이 다를 수 있어 '동시 발생 총량'의 상한(≥ 실제 동시 피크)이다 — 화면 설명에 명시.
    s.peak[i] = (s.peak[i] ?? 0) + Math.round(Number(r.max_bps));
  }
  const series = [...byGroup.values()]
    .map((s) => {
      const vals = s.sum.filter((v) => v != null);
      const pv = s.peak.filter((v) => v != null);
      return {
        key: s.key, ports: [...s.ports].sort((a, b) => a - b), sum: s.sum, peak: s.peak,
        avgTotal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
        maxTotal: vals.length ? Math.max(...vals) : 0,
        peakAvg: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : 0,
        peakTotal: pv.length ? Math.max(...pv) : 0,
      };
    })
    .sort((a, b) => b.avgTotal - a.avgTotal);
  return { buckets, bucketMs, since, until, series };
}

/**
 * 연결 장비 이름 → 스토리지 식별 키(순수).
 * 'SYMMETRIX::000497700230::SAF-1d 4::FC::…' 처럼 `::` 로 나뉜 이름은 **앞 두 세그먼트**가
 * 제품군+어레이 시리얼이라 그것이 곧 장비 식별자다(뒤는 디렉터 포트·펌웨어라 장비가 같아도 다르다).
 * `::` 가 없으면(HBA 등) 이름 앞부분을 그대로 쓴다.
 */
export function storageKey(name) {
  const s = String(name || '').trim();
  if (!s) return '(미확인)';
  if (s.includes('::')) return s.split('::').slice(0, 2).join('::');
  return s.slice(0, 40);
}

/**
 * 여러 스위치를 가로질러 **연결 스토리지별로 합산**한 시계열(v2.412, 사용자 요구
 * '법인을 선택하면 그 법인의 모든 스토리지 사용량을 분석').
 *
 * 왜 스위치 하나로는 부족한가: 스토리지 어레이는 이중화를 위해 **팹 A/B 두 스위치에 나눠**
 * 물린다(OC2-1/OC2-2, OC2-3/OC2-4 처럼). 스위치 한 대만 보면 그 어레이가 실제로 쓰는
 * 트래픽의 절반만 보인다. 법인 안의 모든 스위치를 합쳐야 어레이의 진짜 사용량이 나온다.
 *
 * @param deviceIds 합산할 스위치 id 배열(법인 필터 결과)
 * @returns { buckets, bucketMs, series:[{ key, ports:[{deviceId,port}], deviceIds[], sum[], avgTotal, maxTotal }] }
 */
export async function storageSeriesMulti(deviceIds = [], opt = {}) {
  const { hours = 24, points = 120, groupOf = null, from = null, to = null, carryMs = null } = opt;
  if (isDemoPerfQuery(isMockMode(), deviceIds)) {
    const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
    return demoStorageMulti(await demoMeta(deviceIds), { since, until, bucketMs, groupOf, storageKey, carryMs: carryMs ?? defaultCarryMs() });
  }
  const key = qkey('multi', { ids: deviceIds.map(String), hours, points, from, to, carryMs, groupOf: groupOf ? [...groupOf.entries()] : null });
  return heavyQuery(key, (gen) => storageSeriesMultiInner(deviceIds, { hours, points, groupOf, from, to, carryMs, gen }));
}
async function storageSeriesMultiInner(deviceIds = [], { hours = 24, points = 120, groupOf = null, from = null, to = null, carryMs = null, gen = null } = {}) {
  const db = await open();
  if (!db || !deviceIds.length) return { buckets: [], series: [], bucketMs: 0, unavailable: !db };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const ph = deviceIds.map(() => '?').join(',');
  // v2.693: 장비·조각 단위 + 양보(예전 IN(전 장비) × 전 기간 한 문장이 운영 멈춤 후보였다 — 위 bucketAgg 머리말).
  // v2.713: 아래 행·시리즈 조립도 양보한다 — 데모 모드 SAN 86대·24h(33만 행)에서 조립만 양보 없이 약 2초 멈췄다(stallwatch 실측,
  //   멈춘 지점 이 함수). 같은 yielder 를 조회와 조립이 같이 쓴다.
  const yielder = createYielder(15);
  const rows = await bucketAgg(db, deviceIds.map(String), since, until, bucketMs, { lastTs: true, yielder, sort: false, gen });
  const metaRows = db.conn.prepare(`SELECT device_id, port, attached_name FROM port_meta WHERE device_id IN (${ph})`)
    .all(...deviceIds.map(String));
  const storageOf = new Map(metaRows.map((m) => [`${m.device_id}|${m.port}`, storageKey(m.attached_name)]));
  /*
   * v2.621(감사 DATA-03 — 재현: 1h 조회 22버킷 전부 절반 값·avgTotal 125MB/s, 정답 250): 팹 A/B 스위치의 캡처 시각은 수십 초
   *   어긋난다. 버킷(1h 60초·6h 180초)이 수집 주기(기본 5분)보다 짧으면 한 버킷에 한 스위치 표본만 들어가 **그 버킷의 합이
   *   어레이 트래픽의 절반**이 됐다(v2.415 의 null 처리는 '버킷 전체가 빈' 경우만 막는다). storage/db.js sumCapacityBuckets
   *   (v2.600 DB2600-01)와 같은 판단 — 이 스토리지 포트 중 일부만 표본이 있는 버킷은 나머지 포트의 직전 표본을
   *   한계(carryMs, 기본 수집 주기 × 2) 안에서 이월해 채우고, 조회 시작 직전 표본도 한계 안이면 들여온다(시작 버킷이 절반이
   *   되지 않게). 자기 표본이 하나도 없는 버킷은 예전처럼 빈 칸이다(v2.415 — 다른 장비의 표본 시각이 만든 버킷을 채우지 않는다).
   *   그래도 빠진 포트(한 번 본 뒤 한계를 넘겨 표본이 없는 포트)가 있는 버킷은 **부분 합을 그리지 않는다** — sum·peak 를 null 로
   *   두고 그 버킷 번호를 partial 로 밝힌다(평균·최대에서도 빠진다). 조회 구간에서 한 번도 보이지 않은 포트는 알 수 없으므로 세지 않는다.
   */
  const lim = Number.isFinite(Number(carryMs)) && Number(carryMs) > 0 ? Number(carryMs) : defaultCarryMs();
  const carryIn = new Map();   // `${device}|${port}` → { avg, max, ts } — 조회 시작 직전(한계 안) 마지막 표본
  for (const r of db.conn.prepare(
    `SELECT device_id, port, bps, MAX(ts) AS ts FROM port_perf WHERE device_id IN (${ph}) AND ts >= ? AND ts < ? GROUP BY device_id, port`,
  ).all(...deviceIds.map(String), since - lim, since)) {
    carryIn.set(`${r.device_id}|${Number(r.port)}`, { avg: Math.round(Number(r.bps)), max: Math.round(Number(r.bps)), ts: Number(r.ts) });
  }

  const bucketSet = [...new Set(rows.map((r) => Number(r.b)))].sort((a, b) => a - b);
  const buckets = bucketSet.map((b) => b * bucketMs);
  const idx = new Map(bucketSet.map((b, i) => [b, i]));
  const byGroup = new Map();
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    if ((ri & 1023) === 0) { await yielder(); if (gen != null) checkCancel(gen); }
    const st = storageOf.get(`${r.device_id}|${Number(r.port)}`) || '(미확인)';
    // groupOf 가 주어지면(법인별 분리) 같은 어레이라도 **법인마다 따로** 집계한다 —
    // 복수 법인을 한꺼번에 보면서도 법인 구분이 사라지지 않게(사용자 요구, v2.414).
    const g = groupOf ? (groupOf.get(String(r.device_id)) ?? '') : null;
    const gk = groupOf ? `${g}\u0000${st}` : st;
    // 0 이 아니라 null 로 시작한다 — 버킷은 조회에 포함된 전 장비의 합집합이라, 비어 있는
    // 버킷을 0 으로 세면 조회 범위를 넓힐수록 평균이 내려간다(위 storageSeries 머리말 참조).
    if (!byGroup.has(gk)) byGroup.set(gk, { key: st, group: g, ports: new Map(), cells: new Map() });
    const s = byGroup.get(gk);
    const pk = `${r.device_id}|${Number(r.port)}`;
    s.ports.set(pk, { deviceId: String(r.device_id), port: Number(r.port) });
    let cell = s.cells.get(pk);
    if (!cell) { cell = new Map(); s.cells.set(pk, cell); }
    cell.set(idx.get(Number(r.b)), { avg: Math.round(Number(r.avg_bps)), max: Math.round(Number(r.max_bps)), ts: Number(r.last_ts) });
  }
  const series = [];
  for (const s of byGroup.values()) {
    await yielder();
    if (gen != null) checkCancel(gen);
    const n = buckets.length;
    const sum = new Array(n).fill(null);
    const peak = new Array(n).fill(null);
    const partial = [];
    let carriedCells = 0;
    // 포트별 진행 상태(직전 표본) — 버킷을 앞에서부터 훑는다.
    const state = [...s.cells.entries()].map(([pk, cell]) => ({ cell, last: carryIn.get(pk) || null }));
    for (let i = 0; i < n; i++) {
      // 이 스토리지의 포트 중 이 버킷에 **자기 표본이 하나도 없으면** 빈 칸 그대로다(v2.415 — 다른 장비 때문에 생긴 버킷을
      //   채우지 않는다). 이월은 '일부 포트만 표본이 있는' 버킷을 완성하는 데만 쓴다.
      if (!state.some((p) => p.cell.has(i))) continue;
      let acc = null; let pacc = null; let missing = 0; let carried = 0;
      for (const p of state) {
        const own = p.cell.get(i);
        let v = null;
        if (own) { v = own; p.last = own; }
        else if (p.last) {
          if (buckets[i] - p.last.ts <= lim) { v = p.last; carried += 1; }
          else missing += 1;                       // 본 적은 있는데 한계를 넘겨 표본이 없다 — 이 버킷의 합은 부분 합이다
        }
        if (v) { acc = (acc ?? 0) + v.avg; pacc = (pacc ?? 0) + v.max; }
      }
      if (missing > 0) { partial.push(i); continue; }   // 부분 합은 그리지 않는다(null)
      sum[i] = acc; peak[i] = pacc;
      carriedCells += carried;
    }
    const vals = sum.filter((v) => v != null);
    const pv = peak.filter((v) => v != null);
    const ports = [...s.ports.values()];
    series.push({
      key: s.key, group: s.group, ports, deviceIds: [...new Set(ports.map((p) => p.deviceId))], sum, peak,
      avgTotal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,   // 버킷 평균 합의 평균
      maxTotal: vals.length ? Math.max(...vals) : 0,                                 // 버킷 평균 합의 최댓값
      peakAvg: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : 0,           // 버킷 피크 합의 평균
      peakTotal: pv.length ? Math.max(...pv) : 0,                                    // 버킷 피크 합의 최댓값(기간 내 최고 피크)
      // v2.621(감사 DATA-03): 빠진 포트가 있어 그리지 않은 버킷(번호)과 직전 표본으로 채운 (포트×버킷) 칸 수 — 조용히 채우거나 빼지 않는다.
      partial, partialBuckets: partial.length, carriedCells,
    });
  }
  series.sort((a, b) => b.avgTotal - a.avgTotal);
  return { buckets, bucketMs, since, until, series, carryMs: lim };
}

/** v2.621(감사 DATA-03): 이월 한계 기본값 = 포트 사용량 수집 주기 × 2(storage sumCapacityBuckets 와 같은 배수). 설정을 못 읽으면 기본 주기(5분) × 2. */
function defaultCarryMs() {
  try { const iv = Number(loadPerfSettings()?.intervalMs); if (Number.isFinite(iv) && iv > 0) return iv * 2; } catch { /* 설정 못 읽음 — 기본값 */ }
  return 2 * 5 * 60_000;
}

/**
 * 스토리지 식별 키에서 **어레이 시리얼로 보이는 조각**을 뽑는다(순수).
 * 'SYMMETRIX::000497700230' → '000497700230'. 이 값으로 등록된 스토리지 장비의 시리얼과
 * 대조해 용량 사용률을 함께 보여줄 수 있다.
 * ⚠ 확신할 수 없으면 빈 문자열을 돌려준다 — 억지로 맞춘 매칭은 엉뚱한 어레이의 용량을
 *   붙여 보여주게 되고, 그건 없느니만 못하다.
 */
export function arraySerialOf(key) {
  const seg = String(key || '').split('::');
  if (seg.length < 2) return '';
  const s = seg[1].trim();
  // 시리얼처럼 보이는 것만(영숫자 6자 이상, 공백 없음). 'SAF-1d 4' 같은 포트 표기는 배제.
  return /^[A-Za-z0-9-]{6,}$/.test(s) ? s : '';
}

/**
 * 연결 대상이 **스토리지 어레이인지 호스트(HBA)인지** 판정(순수, v2.412).
 *
 * 왜 필요한가: 법인 단위로 합산하면 서버 HBA 가 각각 하나의 '연결 대상'으로 잡혀 표를
 * 뒤덮는다(실측: 어레이 2개에 HBA 64개). 사용자가 보려는 것은 **스토리지**이므로 기본은
 * 어레이만 보여주고, 호스트는 따로 골라 볼 수 있게 한다.
 *
 * 판정 순서
 *  1. 등록된 스토리지 장비의 시리얼과 일치 → **확실한 어레이**(matched)
 *  2. 이름이 `::` 로 나뉜 벤더 심볼릭 이름(SYMMETRIX::…, PowerStore::…) → 어레이(추정)
 *  3. 그 외(Emulex PPN-…, QLE2692 FW:… 같은 HBA 표기) → 호스트
 *
 * ⚠ 2번은 **추정**이다. 어레이가 평평한 이름으로 보고하면 호스트로 분류된다 — 그래서 화면에
 *   '호스트' 필터를 남겨 두고, 어디에 속했는지 확인할 수 있게 한다(숨기지 않는다).
 */
export function endpointKind(key, { matched = false } = {}) {
  if (matched) return 'array';
  const s = String(key || '');
  if (s === '(미확인)') return 'unknown';
  return s.includes('::') ? 'array' : 'host';
}

/**
 * 보관 현황(설정 화면 표시용).
 * v2.602(감사 DB2602-02): 설정 화면이 **20초마다** 이 함수를 부른다(SanSwitchPerf.jsx) — v2.550.3 이 '폴링하지 않는 진단
 * 경로' 로 제외한 전제가 틀렸다. 예전 `COUNT(*), MIN(ts), MAX(ts)` 한 쿼리(aggregate 셋 → 인덱스 전량 스캔) +
 * `COUNT(DISTINCT device_id)` 가 300만 행에서 303ms 였다. MIN·MAX 는 **단독 쿼리 둘**(인덱스 양끝 조회)로 나누고,
 * 행 수·장비 수·24시간 적재 수는 60초 캐시하되 **캐시임을 `countsAt` 으로 밝힌다**(v2.550.3 bmusage 와 같은 규약).
 * 적재·prune 이 행 수를 바꾸면 캐시를 버린다.
 */
const COUNTS_TTL_MS = 60_000;
let _counts = null;   // { at, rows, devices, rowsLastDay }
export async function perfDbStats({ now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { available: false };
  try {
    const oldest = db.conn.prepare('SELECT MIN(ts) AS v FROM port_perf').get();
    const newest = db.conn.prepare('SELECT MAX(ts) AS v FROM port_perf').get();
    if (!_counts || now - _counts.at >= COUNTS_TTL_MS || now < _counts.at) {
      const n = db.conn.prepare('SELECT COUNT(*) AS n FROM port_perf').get();
      const d = db.conn.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM port_perf').get();
      const day = db.conn.prepare('SELECT COUNT(*) AS n FROM port_perf WHERE ts >= ?').get(now - 86400e3);
      _counts = { at: now, rows: Number(n?.n || 0), devices: Number(d?.n || 0), rowsLastDay: Number(day?.n || 0) };
    }
    let fileBytes = 0;
    for (const suf of ['', '-wal']) { try { fileBytes += fs.statSync(FILE() + suf).size; } catch { /* */ } }
    return { available: true, rows: _counts.rows, oldest: Number(oldest?.v || 0), newest: Number(newest?.v || 0), devices: _counts.devices, file: FILE(),
      fileBytes, rowsLastDay: _counts.rowsLastDay, countsAt: _counts.at };
  } catch (e) { return { available: true, error: e.message }; }
}

export function _resetForTest() { _qcache.clear(); _chain = Promise.resolve(); lockRetry.ok(); try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; _counts = null; _pruneFlight.reset(); }
