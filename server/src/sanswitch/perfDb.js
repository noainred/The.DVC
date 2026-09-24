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
import { chunkedDelete } from '../util/chunkedPrune.js';
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
  const db = await open();
  const out = new Map();
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
let _pruning = null;
let _pruningDays = null;
function pruneOld(db, retentionDays) {
  const days = Math.max(1, Number(retentionDays) || 90);
  if (_pruning && _pruningDays === days) return _pruning;
  if (_pruning) return _pruning.catch(() => {}).then(() => pruneOld(db, retentionDays));
  const cut = Date.now() - days * 86400e3;
  _pruningDays = days;
  _pruning = (async () => {
    // ts 단독 인덱스(idx_pp_ts)가 rowid 서브쿼리의 풀스캔을 막는다
    const stmt = db.conn.prepare('DELETE FROM port_perf WHERE rowid IN (SELECT rowid FROM port_perf WHERE ts < ? LIMIT ?)');
    const r = await chunkedDelete(stmt, [cut], { label: 'sanswitch-perf.port_perf' });
    const meta = db.conn.prepare('DELETE FROM port_meta WHERE ts < ?').run(cut); // 장비×포트(≤4096) 규모라 한 번에
    if (r.deleted > 0 || Number(meta?.changes) > 0) {
      _counts = null;
      console.log(`[sanswitch-perf] prune ${r.deleted.toLocaleString()}행 삭제(${r.chunks}청크)${r.done ? '' : ' — 상한 도달, 다음 주기에 계속'} · 메타 ${Number(meta?.changes || 0)}행`);
    }
    return { deleted: r.deleted, done: r.done, metaDeleted: Number(meta?.changes || 0) };
  })().finally(() => { _pruning = null; _pruningDays = null; });
  return _pruning;
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
  const db = await open();
  if (!db) return { buckets: [], series: [], bucketMs: 0, unavailable: true };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const filter = ports?.length ? ` AND port IN (${ports.map(() => '?').join(',')})` : '';
  const rows = db.conn.prepare(
    `SELECT port, (ts / ${bucketMs}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps
       FROM port_perf WHERE device_id = ? AND ts >= ? AND ts <= ?${filter}
      GROUP BY port, b ORDER BY b ASC`,
  ).all(String(deviceId), since, until, ...(ports || []));
  return { ...shape(db, deviceId, rows, bucketMs, since), until };
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
export async function storageSeries(deviceId, { hours = 24, points = 120, from = null, to = null } = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], unavailable: true };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const rows = db.conn.prepare(
    `SELECT p.port AS port, (p.ts / ${bucketMs}) AS b, AVG(p.bps) AS avg_bps, MAX(p.bps) AS max_bps
       FROM port_perf p WHERE p.device_id = ? AND p.ts >= ? AND p.ts <= ?
      GROUP BY p.port, b ORDER BY b ASC`,
  ).all(String(deviceId), since, until);
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
export async function storageSeriesMulti(deviceIds = [], { hours = 24, points = 120, groupOf = null, from = null, to = null } = {}) {
  const db = await open();
  if (!db || !deviceIds.length) return { buckets: [], series: [], bucketMs: 0, unavailable: !db };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const ph = deviceIds.map(() => '?').join(',');
  const rows = db.conn.prepare(
    `SELECT device_id, port, (ts / ${bucketMs}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps
       FROM port_perf WHERE device_id IN (${ph}) AND ts >= ? AND ts <= ?
      GROUP BY device_id, port, b ORDER BY b ASC`,
  ).all(...deviceIds.map(String), since, until);
  const metaRows = db.conn.prepare(`SELECT device_id, port, attached_name FROM port_meta WHERE device_id IN (${ph})`)
    .all(...deviceIds.map(String));
  const storageOf = new Map(metaRows.map((m) => [`${m.device_id}|${m.port}`, storageKey(m.attached_name)]));

  const bucketSet = [...new Set(rows.map((r) => Number(r.b)))].sort((a, b) => a - b);
  const buckets = bucketSet.map((b) => b * bucketMs);
  const idx = new Map(bucketSet.map((b, i) => [b, i]));
  const byGroup = new Map();
  for (const r of rows) {
    const st = storageOf.get(`${r.device_id}|${Number(r.port)}`) || '(미확인)';
    // groupOf 가 주어지면(법인별 분리) 같은 어레이라도 **법인마다 따로** 집계한다 —
    // 복수 법인을 한꺼번에 보면서도 법인 구분이 사라지지 않게(사용자 요구, v2.414).
    const g = groupOf ? (groupOf.get(String(r.device_id)) ?? '') : null;
    const gk = groupOf ? `${g}\u0000${st}` : st;
    // 0 이 아니라 null 로 시작한다 — 버킷은 조회에 포함된 전 장비의 합집합이라, 비어 있는
    // 버킷을 0 으로 세면 조회 범위를 넓힐수록 평균이 내려간다(위 storageSeries 머리말 참조).
    if (!byGroup.has(gk)) byGroup.set(gk, { key: st, group: g, ports: new Map(), sum: new Array(buckets.length).fill(null), peak: new Array(buckets.length).fill(null) });
    const s = byGroup.get(gk);
    s.ports.set(`${r.device_id}|${Number(r.port)}`, { deviceId: String(r.device_id), port: Number(r.port) });
    const i = idx.get(Number(r.b));
    s.sum[i] = (s.sum[i] ?? 0) + Math.round(Number(r.avg_bps));
    s.peak[i] = (s.peak[i] ?? 0) + Math.round(Number(r.max_bps)); // 포트별 버킷 MAX 의 합(위 storageSeries 주석 참조)
  }
  const series = [...byGroup.values()].map((s) => {
    const vals = s.sum.filter((v) => v != null);
    const pv = s.peak.filter((v) => v != null);
    const ports = [...s.ports.values()];
    return {
      key: s.key, group: s.group, ports, deviceIds: [...new Set(ports.map((p) => p.deviceId))], sum: s.sum, peak: s.peak,
      avgTotal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,   // 버킷 평균 합의 평균
      maxTotal: vals.length ? Math.max(...vals) : 0,                                 // 버킷 평균 합의 최댓값
      peakAvg: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : 0,           // 버킷 피크 합의 평균
      peakTotal: pv.length ? Math.max(...pv) : 0,                                    // 버킷 피크 합의 최댓값(기간 내 최고 피크)
    };
  }).sort((a, b) => b.avgTotal - a.avgTotal);
  return { buckets, bucketMs, since, until, series };
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

export function _resetForTest() { lockRetry.ok(); try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; _counts = null; _pruning = null; _pruningDays = null; }
