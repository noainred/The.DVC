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
import { isDemoPerfQuery, demoStorageMultiAsync, demoStorageOne, demoPortSeries } from './demoPerfSynth.js';   // v2.715 목업: 수식으로 만든다
import { createYielder } from '../util/timeSlice.js';   // v2.621(감사 DATA-03): 이월 한계 = 수집 주기 × 2
import { G15, G1H, alignDown, alignUp, snapBucketMs, rollupGranularity, planSegments, rollupChunkBuckets } from './perfRollup.js';   // v2.728 SAN 2차
const lockRetry = createLockRetry();
const DAY = 86_400_000;
// v2.728(SAN 2차): 15분 집계 표 보관 일수 — 24시간·3일 같은 짧은 구간만 이 표를 쓴다(그보다 길면 1시간 표). 빈 값·범위 밖은 31일.
const R15_DAYS = (() => { const n = numOrNull(process.env.SANSW_PERF_ROLLUP_15M_DAYS ?? 31); return n != null && n >= 2 && n <= 400 ? Math.round(n) : 31; })();
const rollupDays = () => { try { const n = Number(loadPerfSettings()?.rollupRetentionDays); return Number.isFinite(n) && n > 0 ? n : 730; } catch { return 730; } };

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
    // v2.728(SAN 2차) — 집계 표. 한 행 = (장비 번호, 집계 버킷, 포트)의 표본 수·합·최대·마지막 시각(perfRollup.js 머리말).
    //   PK 순서가 (dev, b, port) 인 이유: 조회가 '장비 하나 × 시간 구간' 이라 그 순서로 붙어 있어야 연속으로 읽힌다(디스크 읽기).
    //   WITHOUT ROWID — 행이 PK 순서로 저장되고 rowid 인덱스가 따로 없다. 장비 id 는 정수로 바꿔 둔다(pp_dev — 행당 약 15바이트).
    conn.exec(`CREATE TABLE IF NOT EXISTS pp_dev (id INTEGER PRIMARY KEY, device_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS pp_15m (dev INTEGER NOT NULL, b INTEGER NOT NULL, port INTEGER NOT NULL,
        n INTEGER NOT NULL, s INTEGER NOT NULL, mx INTEGER NOT NULL, lt INTEGER NOT NULL, PRIMARY KEY (dev, b, port)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS pp_1h (dev INTEGER NOT NULL, b INTEGER NOT NULL, port INTEGER NOT NULL,
        n INTEGER NOT NULL, s INTEGER NOT NULL, mx INTEGER NOT NULL, lt INTEGER NOT NULL, PRIMARY KEY (dev, b, port)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS pp_meta (k TEXT PRIMARY KEY, v INTEGER);`);
    // complete_since — 이 시각 이후는 집계 표가 완성돼 있다. 처음 만들 때는 '다음 정시'(그 전 원본은 아직 집계 표에 없다).
    //   백필이 거꾸로 내려가며 이 값을 낮추고, 끝나면 0(전 구간 완성 — 이후 적재는 전부 집계 표에도 같이 들어간다).
    if (!conn.prepare("SELECT v FROM pp_meta WHERE k = 'complete_since'").get()) {
      conn.prepare("INSERT INTO pp_meta (k, v) VALUES ('complete_since', ?)").run(alignUp(Date.now(), G1H));
    }
    const upsert = (t) => conn.prepare(`INSERT INTO ${t} (dev, b, port, n, s, mx, lt) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(dev, b, port) DO UPDATE SET n = n + excluded.n, s = s + excluded.s, mx = MAX(mx, excluded.mx), lt = MAX(lt, excluded.lt)`);
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
      // v2.728(SAN 2차) 집계 표
      insDev: conn.prepare('INSERT OR IGNORE INTO pp_dev (device_id) VALUES (?)'),
      getDev: conn.prepare('SELECT id FROM pp_dev WHERE device_id = ?'),
      up15: upsert('pp_15m'),
      up1h: upsert('pp_1h'),
      devNo: new Map(),
      completeSince: Number(conn.prepare("SELECT v FROM pp_meta WHERE k = 'complete_since'").get()?.v ?? 0),
    };
    scheduleRollupBackfill();
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

/** v2.728: 장비 id → 집계 표의 장비 번호(pp_dev). create=false 면 없을 때 null(조회 경로 — 표를 늘리지 않는다). */
function devNoOf(db, deviceId, create = true) {
  const id = String(deviceId);
  const hit = db.devNo.get(id);
  if (hit != null) return hit;
  if (create) db.insDev.run(id);
  const r = db.getDev.get(id);
  if (!r) return null;
  const n = Number(r.id);
  db.devNo.set(id, n);
  return n;
}

/**
 * v2.728(SAN 2차): 방금 원본에 **실제로 들어간** 표본을 집계 표 두 개에 더한다. 반드시 원본 INSERT 와 **같은 트랜잭션** 안에서
 * 부른다 — 따로 커밋하면 중간에 죽었을 때 원본과 집계가 어긋나고, 그 어긋남은 다시 맞출 길이 없다.
 * 같은 (장비, 버킷, 포트) 끼리 먼저 묶어 한 번만 upsert 한다(5분 주기 128포트 저장이면 표마다 128회).
 * 15분 표는 보관 기간(R15_DAYS) 안의 표본만 더한다 — 그보다 오래된 늦은 전송분은 어차피 지워질 행이다.
 * @param items [{ d, ts, p, b }]
 */
function addRollups(db, items) {
  if (!items.length) return;
  const cut15 = Date.now() - R15_DAYS * DAY;
  const acc15 = new Map(); const acc1h = new Map();
  const add = (acc, g, dev, it) => {
    const b = Math.floor(it.ts / g);
    const k = `${dev}|${b}|${it.p}`;
    let a = acc.get(k);
    if (!a) { a = [dev, b, it.p, 0, 0, -1, 0]; acc.set(k, a); }
    a[3] += 1; a[4] += it.b;
    if (it.b > a[5]) a[5] = it.b;
    if (it.ts > a[6]) a[6] = it.ts;
  };
  for (const it of items) {
    const dev = devNoOf(db, it.d);
    add(acc1h, G1H, dev, it);
    if (it.ts >= cut15) add(acc15, G15, dev, it);
  }
  for (const a of acc15.values()) db.up15.run(...a);
  for (const a of acc1h.values()) db.up1h.run(...a);
}
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
  // v2.728(SAN 1차): 적재마다 기억한 조회 결과를 버리지 않는다 — 엣지 전송 1회·스위치 1대 저장마다 지워서 트래픽 카드가
  //   매분 다시 집계했고, 진행 중인 같은 조회에 합류하지 못해 한 번 더 돌았다(v2.727 조사 실측 ②③). 기억은 수집 주기 동안
  //   유지되고(perfQueryTtlMs) 새 표본은 그 안에 반영된다. 사람이 '지금 수집'·'지금 정리' 를 누르면 그때 버린다.
  const db = await open();
  if (!db) return { inserted: 0, skipped: 0, unavailable: true };
  const ins = db.conn.prepare('INSERT INTO port_perf (device_id, ts, port, bps) SELECT ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM port_perf WHERE device_id = ? AND port = ? AND ts = ?)');
  let inserted = 0, skipped = 0, metaRejected = 0;
  const added = [];   // v2.728: 실제로 들어간 표본만 집계 표에 더한다(중복 재전송은 원본에서 걸러졌다 — 두 번 세지 않는다)
  db.conn.exec('BEGIN');
  try {
    for (const r of rows) {
      const d = String(r.d ?? ''), ts = Number(r.ts), p = Number(r.p), b = Math.max(0, Math.round(Number(r.b)));
      if (!d || !Number.isFinite(ts) || !portOk(p) || !Number.isFinite(b)) { skipped++; continue; }
      const x = ins.run(d, ts, p, b, d, p, ts);
      if (Number(x.changes) > 0) { inserted++; added.push({ d, ts, p, b }); } else skipped++;
    }
    addRollups(db, added);
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
  // v2.728(SAN 1차): 저장마다 기억을 버리지 않는다(importSamples 머리말과 같은 이유).
  const db = await open();
  if (!db) return { saved: 0, skipped: 'DB 비활성' };
  const rows = Object.entries(samples).filter(([, v]) => Number.isFinite(Number(v)));
  const added = [];
  db.conn.exec('BEGIN');
  try {
    for (const [port, bps] of rows) {
      const b = Math.max(0, Math.round(Number(bps)));
      db.ins.run(String(deviceId), ts, Number(port), b);
      added.push({ d: String(deviceId), ts: Number(ts), p: Number(port), b });
    }
    addRollups(db, added);
    for (const m of meta) {
      db.upMeta.run(String(deviceId), Number(m.port), ts, m.attachedName || '', m.attachedWwn || '', m.speed || '', m.portType || '');
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }

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
  // v2.728(SAN 2차): 집계 표는 원본과 **따로** 지운다 — 1시간 표는 rollupRetentionDays(기본 730일), 15분 표는 R15_DAYS(31일).
  //   WITHOUT ROWID 라 rowid 청크를 못 쓴다 — 장비마다 PK 앞부분(dev, b)으로 범위를 잡아 청크로 지운다(인덱스를 더 두지 않는다).
  const rolled = await pruneRollups(db);
  if (r.deleted > 0 || Number(meta?.changes) > 0 || rolled.deleted > 0) {
    console.log(`[sanswitch-perf] prune ${r.deleted.toLocaleString()}행 삭제(${r.chunks}청크)${r.done ? '' : ' — 상한 도달, 다음 주기에 계속'} · 메타 ${Number(meta?.changes || 0)}행 · 집계 ${rolled.deleted.toLocaleString()}행`);
  }
  return { deleted: r.deleted, done: r.done, metaDeleted: Number(meta?.changes || 0), rollupDeleted: rolled.deleted };
}

/** v2.728: 집계 표 보관 기간 정리. 장비 번호는 pp_dev(장비 수십~수백 개)에서 읽는다. */
async function pruneRollups(db, now = Date.now()) {
  let deleted = 0;
  const devs = db.conn.prepare('SELECT id FROM pp_dev').all().map((x) => Number(x.id));
  for (const [tbl, g, days] of [['pp_1h', G1H, rollupDays()], ['pp_15m', G15, R15_DAYS]]) {
    const cutB = Math.floor((now - days * DAY) / g);
    const stmt = db.conn.prepare(`DELETE FROM ${tbl} WHERE (dev, b, port) IN (SELECT dev, b, port FROM ${tbl} WHERE dev = ? AND b < ? LIMIT ?)`);
    for (const dev of devs) {
      const r = await chunkedDelete(stmt, [dev, cutB], { label: `sanswitch-perf.${tbl}` });
      deleted += r.deleted;
    }
  }
  return { deleted };
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
    return { deleted: r.deleted, done: r.done, metaDeleted: r.metaDeleted, rollupDeleted: r.rollupDeleted ?? 0 };
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
 * v2.728(SAN 2차·F): 포트별 버킷 누적 — 행 객체 대신 **숫자 배열**에 바로 더한다. 예전 집계는 (장비×포트×버킷) 마다 행 객체와
 *   셀 객체를 만들어 40대×128포트 조회 1회에 힙이 약 436MB 늘었다(v2.727 조사 실측). 포트마다 Float64Array(4 × 버킷 수)
 *   — [n…, s…, mx…, lt…] — 하나면 같은 조회가 수십 MB 다.
 * 원본과 집계 표 두 곳에서 읽은 (n, s, mx, lt) 를 같은 칸에 합치므로 경계 자투리가 정확히 맞물린다(perfRollup.js 머리말).
 * @returns {{ qb0:number, nb:number, ports: Map<string, {deviceId:string, port:number, a:Float64Array}>, plan:object|null }}
 */
export async function aggPorts(db, deviceIds, since, until, bucketMs, { ports = null, yielder = createYielder(15), ctx = null, now = Date.now() } = {}) {
  const bm = Math.max(1, Math.floor(Number(bucketMs)));
  const qb0 = Math.floor(since / bm);
  const nb = Math.max(0, Math.floor(until / bm) - qb0 + 1);
  const out = new Map();
  const cell = (d, p) => {
    const k = `${d}|${p}`;
    let x = out.get(k);
    if (!x) { x = { deviceId: d, port: p, a: new Float64Array(4 * nb) }; x.a.fill(-1, 2 * nb, 3 * nb); out.set(k, x); }
    return x;
  };
  // 행은 배열 [port, qb, n, s, mx, lt] 로 받는다(setReturnArrays — 행마다 객체를 만들지 않는다. 없는 런타임이면 객체를 같은 순서로 푼다).
  const addRow = (d, r) => {
    const i = Number(r[1]) - qb0;
    if (!(i >= 0 && i < nb)) return;
    const n = Number(r[2]) || 0; if (n <= 0) return;
    const x = cell(d, Number(r[0])); const a = x.a;
    a[i] += n; a[nb + i] += Number(r[3]) || 0;
    const mx = Number(r[4]); if (mx > a[2 * nb + i]) a[2 * nb + i] = mx;
    const lt = Number(r[5]); if (lt > a[3 * nb + i]) a[3 * nb + i] = lt;
  };
  const asArrays = (stmt) => {
    if (typeof stmt?.setReturnArrays === 'function') { stmt.setReturnArrays(true); return (...a) => stmt.all(...a); }
    return (...a) => stmt.all(...a).map((o) => [o.port, o.qb, o.n, o.s, o.mx, o.lt]);
  };
  const pf = ports?.length ? ` AND port IN (${ports.map(() => '?').join(',')})` : '';
  const pargs = ports || [];
  const g = rollupGranularity(bm);
  let plan = null;
  if (g) plan = planSegments({ since, until, g, availFrom: rollupAvailFrom(db, g, now), rawOldest: rawOldestTs(db, now) });
  const rawSegs = plan ? plan.raw : (until >= since ? [[since, until + 1]] : []);
  const rawStmt = asArrays(db.conn.prepare(
    `SELECT port, (ts / ${bm}) AS qb, COUNT(*) AS n, SUM(bps) AS s, MAX(bps) AS mx, MAX(ts) AS lt
       FROM port_perf WHERE device_id = ? AND ts >= ? AND ts <= ?${pf} GROUP BY port, qb`,
  ));
  const tbl = g === G1H ? 'pp_1h' : 'pp_15m';
  const k = g ? bm / g : 1;
  // 집계 표는 GROUP BY 하지 않는다 — addRow 가 같은 칸에 n·s 를 더하고 mx·lt 의 최댓값을 잡으므로 결과가 같다. 기본키 (dev, b, port)
  //   범위만 훑으면 되고, GROUP BY 를 두면 SQLite 가 임시 B-tree 로 정렬해 조회 시간의 절반을 썼다(24시간 · 40대 프로파일 실측).
  const rollStmt = plan?.rollup ? asArrays(db.conn.prepare(
    `SELECT port, (b / ${k}) AS qb, n, s, mx, lt FROM ${tbl} WHERE dev = ? AND b >= ? AND b < ?${pf}`,
  )) : null;
  for (const id0 of deviceIds) {
    const id = String(id0);
    // 원본 구간 — v2.693 과 같은 6시간 조각(버킷 정배수 경계) + 조각마다 양보
    for (const [lo, hi] of rawSegs) {
      if (!(hi > lo)) continue;
      for (const [a, b] of sliceBounds(lo, hi - 1, bm)) {
        for (const r of rawStmt(id, a, b, ...pargs)) addRow(id, r);
        await yielder();
        checkCancel(ctx);
      }
    }
    // 집계 표 구간 — 한 문장이 읽는 버킷 수를 묶는다(1시간 표 30일 · 15분 표 7일)
    if (rollStmt) {
      const dev = devNoOf(db, id, false);
      if (dev == null) continue;   // 집계 표에 한 번도 들어온 적 없는 장비 — 원본 구간만으로 끝난다
      const [rs, re] = plan.rollup;
      const step = rollupChunkBuckets(g);
      for (let b = rs / g; b < re / g; b += step) {
        for (const r of rollStmt(dev, b, Math.min(re / g, b + step), ...pargs)) addRow(id, r);
        await yielder();
        checkCancel(ctx);
      }
    }
  }
  return { qb0, nb, ports: out, plan };
}

/**
 * (device, port, b) 버킷 집계 — 예전 한 문장 집계와 같은 행 모양(device_id, port, b, avg_bps, max_bps[, last_ts]).
 * v2.728: aggPorts 위에서 만든다(집계 표 + 원본 자투리). 장비 하나 화면(portSeries·storageSeries)과 테스트 대조가 쓴다.
 * @param {{ ports?: number[]|null, lastTs?: boolean, yielder?: Function }} opt
 */
export async function bucketAgg(db, deviceIds, since, until, bucketMs, { ports = null, lastTs = false, yielder = createYielder(15), sort = true, gen = null, ctx = null, now = Date.now() } = {}) {
  const r = await aggPorts(db, deviceIds, since, until, bucketMs, { ports, yielder, ctx: ctx || (gen != null ? { gen } : null), now });
  const { qb0, nb } = r;
  const rows = [];
  for (const x of r.ports.values()) {
    const a = x.a;
    for (let i = 0; i < nb; i++) {
      const n = a[i];
      if (!(n > 0)) continue;
      const row = { device_id: x.deviceId, port: x.port, b: qb0 + i, avg_bps: a[nb + i] / n, max_bps: a[2 * nb + i] };
      if (lastTs) row.last_ts = a[3 * nb + i];
      rows.push(row);
    }
  }
  if (sort) rows.sort((x, y) => Number(x.b) - Number(y.b));
  return rows;
}

/** v2.728: 원본의 가장 오래된 표본 시각(인덱스 끝 하나 — MIN 단독). 60초 기억 — 조회마다 부르지만 값은 prune 때만 바뀐다. */
function rawOldestTs(db, now = Date.now()) {
  if (db._oldest && now - db._oldest.at < 60_000) return db._oldest.v;
  const r = db.conn.prepare('SELECT MIN(ts) AS v FROM port_perf').get();
  const v = r?.v == null ? null : Number(r.v);
  db._oldest = { at: now, v };
  return v;
}

/**
 * v2.728: 이 시각 이후는 그 집계 표로 읽어도 결과가 원본과 같다. 두 조건의 늦은 쪽:
 *  ① complete_since — 그 전의 원본은 아직 백필되지 않았다.
 *  ② 보관 기간 — 1시간 표는 rollupRetentionDays, 15분 표는 R15_DAYS 보다 오래된 행은 지워졌거나(정리) 처음부터 만들지 않았다.
 */
function rollupAvailFrom(db, g, now = Date.now()) {
  const cs = Number(db.completeSince) || 0;
  const days = g === G1H ? rollupDays() : R15_DAYS;
  return Math.max(cs, now - days * DAY + g);
}

/*
 * v2.693 — 같은 조회는 한 번만, 무거운 조회는 한 번에 하나만. 화면 두세 곳(트래픽 카드·법인별 사용량·포트 차트)이 같은 기간을
 *   동시에 열면 같은 집계가 겹쳐 돌았다. 진행 중인 같은 조회는 합류한다.
 * v2.728(SAN 1차) — 세 가지를 바꿨다(v2.727 조사 실측 ②③④⑤):
 *   ② 기억 시간은 **수집 주기**(설정 intervalMs, 30초~5분)다. 예전 20초는 트래픽 카드 갱신(60초)보다 짧아 기억이 사실상 쓰이지 않았고,
 *      적재(스위치 1대·엣지 전송 1회)마다 기억을 통째로 지웠다. 새 표본은 기억 시간 안에 반영된다 — 표본 자체가 그 주기로 온다.
 *      사람이 '지금 수집'·'지금 정리' 를 누르면 그때 버린다(invalidatePerfQueries). env SANSW_PERF_QUERY_TTL_MS 로 고정할 수 있다.
 *   ③ 버릴 때 **진행 중인 조회는 지우지 않는다** — 지우면 같은 요청이 합류하지 못하고 한 번 더 돌았다(실행 2회·합류 0회 실측).
 *      진행 중인 것은 끝난 뒤 기억하지 않을 뿐이다(세대 번호).
 *   ④ 줄은 두 개다 — 법인 단위(여러 장비) 조회와 장비 하나 조회. 무거운 법인 조회 셋 뒤에 선 장비 하나 조회(혼자면 50ms)가
 *      18.8초를 기다렸다. 같은 줄 안에서는 예전처럼 하나씩이다.
 *   ⑤ 요청한 화면이 모두 떠나면(브라우저가 연결을 끊으면) 그 조회를 멈춘다 — 아직 줄에 있으면 실행하지 않고, 도는 중이면 다음
 *      양보 지점에서 멈춘다. 같은 조회를 기다리는 다른 요청이 있으면 멈추지 않는다(signal 이 없는 내부 호출자도 끝까지 기다린다).
 */
const _ttlEnv = numOrNull(process.env.SANSW_PERF_QUERY_TTL_MS);
/** 지금 쓰는 기억 시간(ms). env 가 있으면 그 값(0 = 기억 안 함), 없으면 수집 주기를 30초~5분으로 자른 값. */
export function perfQueryTtlMs() {
  if (_ttlEnv != null && _ttlEnv >= 0) return Math.round(_ttlEnv);
  let iv = 5 * 60_000;
  try { const n = Number(loadPerfSettings()?.intervalMs); if (Number.isFinite(n) && n > 0) iv = n; } catch { /* 기본 5분 */ }
  return Math.min(5 * 60_000, Math.max(30_000, iv));
}
const _qcache = new Map();          // key → { at, promise, done, gen, waiters, abandoned }
const _chains = { multi: Promise.resolve(), single: Promise.resolve() };
let _queryStats = { runs: 0, joined: 0, cached: 0, maxQueue: 0, queued: 0, lastMs: null, maxMs: 0, abandoned: 0, skipped: 0 };
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
/**
 * 진행 중인 집계가 양보 지점마다 부른다 — 감시가 엔진을 재시작했거나(gen) 요청한 화면이 모두 떠났으면(entry.abandoned) 멈춘다.
 * ctx 는 { gen, entry } 또는 예전 호출자의 gen 숫자. null 이면 검사하지 않는다(테스트·내부 직접 호출).
 */
function checkCancel(ctx) {
  if (ctx == null) return;
  const gen = typeof ctx === 'number' ? ctx : ctx.gen;
  if (gen != null && gen !== _cancelGen) { const e = new Error('조회 엔진이 재시작되어 이 집계를 멈췄습니다'); e.cancelled = true; throw e; }
  if (ctx.entry?.abandoned) { const e = new Error('요청한 화면이 모두 닫혀 이 집계를 멈췄습니다'); e.code = 'abandoned'; throw e; }
}
function restartEngine(key, ms) {
  _cancelGen += 1;
  invalidatePerfQueries();
  _restarts = { count: _restarts.count + 1, lastAt: Date.now(), lastKey: String(key).slice(0, 200), lastMs: ms };
  retireDb(_db);   // v2.719(감사 R2-01): 진행 중인 prune 이 쥔 핸들은 그 prune 이 끝난 뒤에 닫는다
  _db = null;
  console.warn(`[sanswitch-perf] 사용량 조회가 ${Math.round(ms / 1000)}초를 넘어 조회 엔진을 재시작했습니다(${_restarts.count}회째) — 대기 중인 다른 조회는 이어서 돕니다.`);
}
export function perfQueryStats() { return { ..._queryStats, ttlMs: perfQueryTtlMs(), maxQueryMs: PERF_QUERY_MAX_MS, restarts: { ..._restarts } }; }

/** 요청자 하나를 이 조회에 붙인다. signal 이 없으면 끝까지 기다리는 요청자다(멈추지 않게 무한으로 센다). */
function attachWaiter(key, entry, signal) {
  if (!signal) { entry.waiters = Infinity; return; }
  if (signal.aborted) return;
  entry.waiters += 1;
  signal.addEventListener('abort', () => {
    entry.waiters -= 1;
    if (entry.waiters <= 0 && !entry.done && !entry.abandoned) {
      entry.abandoned = true;
      _queryStats.abandoned++;
      if (_qcache.get(key) === entry) _qcache.delete(key);   // 다음 같은 요청은 새로 계산한다(멈춘 결과에 합류하지 않게)
    }
  }, { once: true });
}

function heavyQuery(key, fn, { lane = 'multi', signal = null } = {}) {
  const now = Date.now();
  const ttl = perfQueryTtlMs();
  for (const [k, v] of _qcache) if (v.done && now - v.at > ttl) _qcache.delete(k);
  const hit = _qcache.get(key);
  if (hit && !hit.abandoned) {
    if (hit.done) _queryStats.cached++; else { _queryStats.joined++; attachWaiter(key, hit, signal); }
    return hit.promise;
  }
  const ln = _chains[lane] ? lane : 'multi';
  _queryStats.queued++; _queryStats.maxQueue = Math.max(_queryStats.maxQueue, _queryStats.queued);
  const entry = { at: now, done: false, promise: null, gen: _qgen, waiters: 0, abandoned: false };
  attachWaiter(key, entry, signal);
  if (signal?.aborted && entry.waiters === 0) entry.abandoned = true;
  const run = _chains[ln].then(async () => {
    _queryStats.queued--;
    if (entry.abandoned) {   // 줄에서 기다리는 동안 요청한 화면이 모두 떠났다 — 실행하지 않는다
      _queryStats.skipped++;
      const e = new Error('요청한 화면이 모두 닫혀 이 조회를 실행하지 않았습니다'); e.code = 'abandoned'; throw e;
    }
    _queryStats.runs++;
    const t0 = Date.now();
    const ctx = { gen: _cancelGen, entry };
    let timer = null;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => {
        restartEngine(key, Date.now() - t0);
        const e = new Error(`SAN 사용량 조회가 ${Math.round(PERF_QUERY_MAX_MS / 1000)}초를 넘어 조회 엔진을 재시작했습니다. 잠시 뒤 다시 시도하세요.`);
        e.code = 'query-restarted'; reject(e);
      }, PERF_QUERY_MAX_MS);
    });
    try { return await Promise.race([fn(ctx), watchdog]); } finally {
      clearTimeout(timer);
      const ms = Date.now() - t0; _queryStats.lastMs = ms; _queryStats.maxMs = Math.max(_queryStats.maxMs, ms);
    }
  });
  _chains[ln] = run.catch(() => {});
  entry.promise = run.then((v) => {
    entry.done = true; entry.at = Date.now();
    if (ttl <= 0 || entry.gen !== _qgen) { if (_qcache.get(key) === entry) _qcache.delete(key); }
    return v;
  }, (e) => { if (_qcache.get(key) === entry) _qcache.delete(key); throw e; });
  // 요청자가 모두 떠난 채 실패하면 아무도 받지 않는다 — 처리되지 않은 거부로 남지 않게 붙여 둔다(호출자는 따로 받는다).
  entry.promise.catch(() => {});
  _qcache.set(key, entry);
  if (_qcache.size > 200) { const first = _qcache.keys().next().value; if (_qcache.get(first)?.done) _qcache.delete(first); }
  return entry.promise;
}
/** 기억한 조회 결과를 버린다. 진행 중인 조회는 지우지 않는다 — 합류는 그대로 되고, 끝나면 새로 기억하지 않는다(세대 번호). */
let _qgen = 0;
export function invalidatePerfQueries() {
  _qgen += 1;
  for (const [k, v] of _qcache) if (v.done) _qcache.delete(k);
}
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
  // v2.728(SAN 2차): 버킷을 집계 표(15분·1시간)의 정배수로 맞춘다(perfRollup.snapBucketMs) — 그래야 집계 표를 쓸 수 있다.
  //   15분 표 보관 기간(R15_DAYS)보다 오래된 구간은 1시간 정배수로(15분 표는 그 구간에 없다).
  const raw = Math.max(60_000, Math.round(span / Math.max(10, points)));
  const bucketMs = snapBucketMs(raw, { allow15: since >= now - R15_DAYS * DAY });
  return { since, until, bucketMs, spanHours: span / 3600e3 };
}

/**
 * 포트별 시계열. 데이터가 많으면 화면이 못 그리므로 **버킷 평균**으로 내려준다
 * (버킷 = 요청 구간을 points 개로 나눈 폭). 원시 점을 수만 개 던지면 브라우저가 멈춘다.
 * @returns { buckets:[ts...], series:[{port, name, speed, avg[], max}], bucketMs }
 */
export async function portSeries(deviceId, { hours = 24, ports = null, points = 120, from = null, to = null, signal = null } = {}) {
  // v2.732(감사 B6-07): 데모 수식도 같은 기억·합류·줄을 탄다(키는 'demo-' 접두 — mock↔live 전환 뒤 실제 조회 결과와 섞이지 않게).
  const demo = isDemoPerfQuery(isMockMode(), [deviceId]);
  return heavyQuery(qkey(demo ? 'demo-port' : 'port', { deviceId: String(deviceId), hours, ports, points, from, to }), async (ctx) => {
    if (demo) {
      const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
      return demoPortSeries(String(deviceId), await demoMeta([deviceId]), { since, until, bucketMs, ports });
    }
    const db = await open();
    if (!db) return { buckets: [], series: [], bucketMs: 0, unavailable: true };
    const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
    const rows = await bucketAgg(db, [String(deviceId)], since, until, bucketMs, { ports, ctx });   // v2.693: 조각 + 양보 · v2.728: 집계 표
    return { ...shape(db, deviceId, rows, bucketMs, since), until, computedAt: Date.now() };
  }, { lane: 'single', signal });
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
  const { hours = 24, points = 120, from = null, to = null, signal = null } = opt;
  const demo = isDemoPerfQuery(isMockMode(), [deviceId]);   // v2.732(B6-07): 데모도 기억·합류(키 이름을 나눈다)
  return heavyQuery(qkey(demo ? 'demo-storage' : 'storage', { deviceId: String(deviceId), hours, points, from, to }),
    (ctx) => (demo ? demoStorageOneFor(deviceId, { hours, points, from, to }) : storageSeriesInner(deviceId, { hours, points, from, to, ctx })), { lane: 'single', signal });
}
async function demoStorageOneFor(deviceId, { hours, points, from, to }) {
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  return demoStorageOne(await demoMeta([deviceId]), { since, until, bucketMs, storageKey });
}
async function storageSeriesInner(deviceId, { hours = 24, points = 120, from = null, to = null, ctx = null } = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], unavailable: true };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const rows = await bucketAgg(db, [String(deviceId)], since, until, bucketMs, { ctx });   // v2.693: 조각 + 양보 · v2.728: 집계 표
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
  return { buckets, bucketMs, since, until, series, computedAt: Date.now() };
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
  const { hours = 24, points = 120, groupOf = null, from = null, to = null, carryMs = null, signal = null } = opt;
  const keyOpts = { ids: deviceIds.map(String), hours, points, from, to, carryMs, groupOf: groupOf ? [...groupOf.entries()] : null };
  if (isDemoPerfQuery(isMockMode(), deviceIds)) {
    // v2.732(감사 B6-07): 데모 수식은 기억·합류 없이 60초 폴링마다 다시 계산했다(데모 260대 1회 약 430ms — 결과는 같은 조건이면 같다).
    //   live 와 같은 heavyQuery(기억 TTL = 수집 주기·같은 줄·감시)를 타고, 계산은 시간 기준으로 양보하며 취소 확인을 한다.
    //   키는 'demo-multi' — mock→live 전환 직후 기억한 데모 결과가 실제 조회 자리에 나가지 않게 이름을 나눈다.
    return heavyQuery(qkey('demo-multi', keyOpts), async (ctx) => {
      const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
      const yielder = createYielder(15);
      return demoStorageMultiAsync(await demoMeta(deviceIds), { since, until, bucketMs, groupOf, storageKey, carryMs: carryMs ?? defaultCarryMs() },
        async () => { checkCancel(ctx); await yielder(); });
    }, { lane: 'multi', signal });
  }
  const key = qkey('multi', keyOpts);
  return heavyQuery(key, (ctx) => storageSeriesMultiInner(deviceIds, { hours, points, groupOf, from, to, carryMs, ctx }), { lane: 'multi', signal });
}
async function storageSeriesMultiInner(deviceIds = [], { hours = 24, points = 120, groupOf = null, from = null, to = null, carryMs = null, ctx = null } = {}) {
  const db = await open();
  if (!db || !deviceIds.length) return { buckets: [], series: [], bucketMs: 0, unavailable: !db };
  const { since, until, bucketMs } = rangeOf({ hours, from, to, points });
  const ph = deviceIds.map(() => '?').join(',');
  // v2.693: 장비·조각 단위 + 양보(예전 IN(전 장비) × 전 기간 한 문장이 운영 멈춤 후보였다 — 위 bucketAgg 머리말).
  // v2.713: 아래 행·시리즈 조립도 양보한다 — 같은 yielder 를 조회와 조립이 같이 쓴다.
  // v2.728(SAN 2차·F): 행 객체 대신 포트별 숫자 배열(aggPorts) — 조회 1회의 힙 사용이 포트 수 × 버킷 수 × 32바이트다.
  const yielder = createYielder(15);
  const agg = await aggPorts(db, deviceIds.map(String), since, until, bucketMs, { yielder, ctx });
  const { qb0, nb } = agg;
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

  // 버킷 목록 = 조회에 포함된 전 장비 중 **표본이 있는** 버킷의 합집합(예전 행 기반 집계와 같은 규칙).
  const any = new Uint8Array(nb);
  for (const x of agg.ports.values()) for (let i = 0; i < nb; i++) if (x.a[i] > 0) any[i] = 1;
  const pos = [];   // 버킷 순번 → aggPorts 칸 번호
  for (let i = 0; i < nb; i++) if (any[i]) pos.push(i);
  const buckets = pos.map((i) => (qb0 + i) * bucketMs);
  const n = buckets.length;
  const byGroup = new Map();
  let seen = 0;
  for (const x of agg.ports.values()) {
    if ((++seen & 255) === 0) { await yielder(); checkCancel(ctx); }
    const pk = `${x.deviceId}|${x.port}`;
    const st = storageOf.get(pk) || '(미확인)';
    // groupOf 가 주어지면(법인별 분리) 같은 어레이라도 **법인마다 따로** 집계한다 —
    // 복수 법인을 한꺼번에 보면서도 법인 구분이 사라지지 않게(사용자 요구, v2.414).
    const g = groupOf ? (groupOf.get(String(x.deviceId)) ?? '') : null;
    const gk = groupOf ? `${g}\u0000${st}` : st;
    if (!byGroup.has(gk)) byGroup.set(gk, { key: st, group: g, ports: [] });
    byGroup.get(gk).ports.push({ pk, x, last: carryIn.get(pk) || null });
  }
  const series = [];
  for (const s of byGroup.values()) {
    await yielder();
    checkCancel(ctx);
    const sum = new Array(n).fill(null);
    const peak = new Array(n).fill(null);
    const partial = [];
    let carriedCells = 0;
    // 포트별 진행 상태(직전 표본) — 버킷을 앞에서부터 훑는다.
    const state = s.ports.map((p) => ({ a: p.x.a, last: p.last }));
    for (let j = 0; j < n; j++) {
      const i = pos[j];
      // 이 스토리지의 포트 중 이 버킷에 **자기 표본이 하나도 없으면** 빈 칸 그대로다(v2.415 — 다른 장비 때문에 생긴 버킷을
      //   채우지 않는다). 이월은 '일부 포트만 표본이 있는' 버킷을 완성하는 데만 쓴다.
      let own = false;
      for (const p of state) if (p.a[i] > 0) { own = true; break; }
      if (!own) continue;
      let acc = null; let pacc = null; let missing = 0; let carried = 0;
      for (const p of state) {
        const cnt = p.a[i];
        let v = null;
        if (cnt > 0) { v = { avg: Math.round(p.a[nb + i] / cnt), max: Math.round(p.a[2 * nb + i]), ts: p.a[3 * nb + i] }; p.last = v; }
        else if (p.last) {
          if (buckets[j] - p.last.ts <= lim) { v = p.last; carried += 1; }
          else missing += 1;                       // 본 적은 있는데 한계를 넘겨 표본이 없다 — 이 버킷의 합은 부분 합이다
        }
        if (v) { acc = (acc ?? 0) + v.avg; pacc = (pacc ?? 0) + v.max; }
      }
      if (missing > 0) { partial.push(j); continue; }   // 부분 합은 그리지 않는다(null)
      sum[j] = acc; peak[j] = pacc;
      carriedCells += carried;
    }
    const vals = sum.filter((v) => v != null);
    const pv = peak.filter((v) => v != null);
    const ports = s.ports.map((p) => ({ deviceId: p.x.deviceId, port: p.x.port }));
    series.push({
      key: s.key, group: s.group, ports, deviceIds: [...new Set(ports.map((p) => p.deviceId))], sum, peak,
      // v2.720(감사 B1-05): 모든 버킷이 부분 합으로 비워졌으면(vals 0개) 0 이 아니라 null(측정 없음) — 0 은 '트래픽 없음' 이라는 거짓이다.
      avgTotal: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,   // 버킷 평균 합의 평균
      maxTotal: vals.length ? Math.max(...vals) : null,                                 // 버킷 평균 합의 최댓값
      peakAvg: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : null,           // 버킷 피크 합의 평균
      peakTotal: pv.length ? Math.max(...pv) : null,                                    // 버킷 피크 합의 최댓값(기간 내 최고 피크)
      // v2.621(감사 DATA-03): 빠진 포트가 있어 그리지 않은 버킷(번호)과 직전 표본으로 채운 (포트×버킷) 칸 수 — 조용히 채우거나 빼지 않는다.
      partial, partialBuckets: partial.length, carriedCells,
    });
  }
  series.sort((a, b) => (b.avgTotal ?? -1) - (a.avgTotal ?? -1));   // v2.720(B1-05): 측정 없음(null)은 뒤로
  return { buckets, bucketMs, since, until, series, carryMs: lim, computedAt: Date.now(), source: sourceOf(agg.plan) };
}

/** v2.728: 이 조회가 어디서 읽었는지 — 화면 각주용('원본' / '집계 표 + 원본 자투리'). */
function sourceOf(plan) {
  if (!plan?.rollup) return { kind: 'raw' };
  return { kind: 'rollup', headApprox: !!plan.headApprox };
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
 * v2.728(SAN 1차) — **전체 행 세기를 없앴다.** 설정 화면이 20초마다 부르는데 COUNT(*)·COUNT(DISTINCT)·24시간 COUNT 가
 *   운영 DB(약 1억 행 추정)에서는 캐시에 있어도 수 초, 디스크에서 읽으면 **수십 초~수 분 동안 포탈 전체를 멈췄다**(합성 2,065만 행에서
 *   디스크 읽기 40.7초 실측 — v2.727 이전 조사 보고). 60초 캐시(v2.602)는 그 멈춤을 1분에 한 번으로 줄였을 뿐이다.
 *   이제 전부 인덱스 끝 하나만 읽는다(합계 수 ms):
 *    · 행 수 ≈ MAX(rowid) − MIN(rowid) + 1 — 정리(prune)가 오래된 것부터 지우므로 대개 맞지만, 늦게 온 엣지 전송분이 지워지며 생긴
 *      틈은 세므로 **실제보다 클 수 있다**(`rowsApprox:true` — 화면이 '약' 으로 말한다).
 *    · 24시간 적재 ≈ MAX(rowid) − (24시간 전 첫 표본의 rowid) + 1 — 같은 이유로 어림값이다.
 *    · 스위치 수 = port_meta(포트 정보 — 장비 × 포트 수천 행)의 장비 수. 표본은 없고 포트 정보만 남은 장비가 있으면 그만큼 많다.
 *   MIN·MAX 는 한 문장에 두 개를 넣지 않는다(v2.550.3 — 둘이면 인덱스를 통째로 훑는다).
 */
export async function perfDbStats({ now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { available: false };
  try {
    const one = (sql, ...a) => db.conn.prepare(sql).get(...a);
    const oldest = one('SELECT MIN(ts) AS v FROM port_perf');
    const newest = one('SELECT MAX(ts) AS v FROM port_perf');
    const lo = one('SELECT MIN(rowid) AS v FROM port_perf');
    const hi = one('SELECT MAX(rowid) AS v FROM port_perf');
    const dayFirst = one('SELECT rowid AS v FROM port_perf WHERE ts >= ? ORDER BY ts LIMIT 1', now - DAY);
    const devs = one('SELECT COUNT(DISTINCT device_id) AS v FROM port_meta');
    const hiN = hi?.v == null ? null : Number(hi.v);
    const rows = hiN == null || lo?.v == null ? 0 : Math.max(0, hiN - Number(lo.v) + 1);
    const rowsLastDay = hiN == null || dayFirst?.v == null ? 0 : Math.max(0, hiN - Number(dayFirst.v) + 1);
    let fileBytes = 0;
    for (const suf of ['', '-wal']) { try { fileBytes += fs.statSync(FILE() + suf).size; } catch { /* */ } }
    return { available: true, rows, rowsApprox: true, oldest: Number(oldest?.v || 0), newest: Number(newest?.v || 0), devices: Number(devs?.v || 0),
      devicesSource: 'meta', file: FILE(), fileBytes, rowsLastDay, rollup: rollupStatus(db, now) };
  } catch (e) { return { available: true, error: e.message }; }
}

/* ── v2.728(SAN 2차) 집계 표 백필 ───────────────────────────────────────────────────────────────────────────────
 * 집계 표를 처음 만든 순간 그 전의 원본(운영 DB 약 1억 행 추정)은 집계 표에 없다. 백그라운드에서 **최근부터 거꾸로** 6시간 조각씩
 * 원본을 집계해 채우고, 조각을 끝낼 때마다 complete_since 를 그만큼 낮춘다(조회는 그 시각 이후만 집계 표를 쓴다 — 그 전은 원본).
 *  · 조각 = 정시 경계에 맞춘 6시간 × 장비 하나. 한 문장이 읽는 원본은 포트 128개면 약 9천 행이다.
 *  · INSERT OR REPLACE — 원본이 진실의 원천이다. 그 조각에 이미 들어온 늦은 엣지 전송분(실시간 upsert)도 원본에 있으므로 다시 계산해
 *    덮으면 정확하다. 문장 하나는 동기로 끝나므로 그 사이에 적재가 끼어들지 않는다.
 *  · 40ms 일하고 80ms 쉰다(v2.675 metrics 백필과 같은 리듬) — 이벤트 루프를 길게 잡지 않는다. 재시작하면 complete_since 부터 잇는다.
 *  · 끝나면 complete_since = 0(전 구간 완성). 그 뒤의 적재는 전부 실시간으로 집계 표에도 들어간다.
 *  · 원본은 지우지 않는다(보존 정책 그대로). SANSW_PERF_ROLLUP_BACKFILL=0 이면 돌지 않는다(그때 조회는 집계 표를 만든 뒤 구간만 쓴다).
 */
const BF_SLICE_MS = 6 * G1H;
const _bfDelayEnv = numOrNull(process.env.SANSW_PERF_ROLLUP_BACKFILL_DELAY_MS ?? 120000);
const BF_DELAY_MS = _bfDelayEnv != null && _bfDelayEnv >= 0 && _bfDelayEnv <= 86_400_000 ? Math.round(_bfDelayEnv) : 120_000;
let _bfTimer = null;
let _bfRun = null;
let _bf = { state: 'idle', startedAt: null, finishedAt: null, slices: 0, statements: 0, error: null, devices: 0 };

function setCompleteSince(db, v) {
  db.conn.prepare("INSERT INTO pp_meta (k, v) VALUES ('complete_since', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(v);
  db.completeSince = v;
}

/** 원본에 있는 장비 id 목록 — idx_pp_dev_ts 를 건너뛰며 찾는다(v2.675 loose index scan — GROUP BY 는 인덱스를 통째로 훑는다). */
function rawDeviceIds(db) {
  return db.conn.prepare(`WITH RECURSIVE d(x) AS (
      SELECT (SELECT MIN(device_id) FROM port_perf)
      UNION ALL SELECT (SELECT MIN(device_id) FROM port_perf WHERE device_id > d.x) FROM d WHERE d.x IS NOT NULL
    ) SELECT x FROM d WHERE x IS NOT NULL`).all().map((r) => String(r.x));
}

/**
 * 백필을 끝까지(또는 maxMs 까지) 돌린다. 테스트는 workMs/restMs 를 0 으로 준다.
 * @returns {Promise<object>} 상태(rollupStatus 와 같은 모양)
 */
export async function runRollupBackfill({ workMs = 40, restMs = 80, maxMs = Infinity, now = null } = {}) {
  if (_bfRun) return _bfRun;
  _bfRun = (async () => {
    let db = await open();
    if (!db) return { state: 'unavailable' };
    const t0 = Date.now();
    _bf = { ..._bf, state: 'running', startedAt: _bf.startedAt || t0, error: null };
    let release = holdDb(db);
    try {
      const devs = rawDeviceIds(db);
      _bf.devices = devs.length;
      const ins1h = (c) => c.prepare(`INSERT OR REPLACE INTO pp_1h (dev, b, port, n, s, mx, lt)
        SELECT ?, ts / ${G1H}, port, COUNT(*), SUM(bps), MAX(bps), MAX(ts) FROM port_perf WHERE device_id = ? AND ts >= ? AND ts < ? GROUP BY ts / ${G1H}, port`);
      const ins15 = (c) => c.prepare(`INSERT OR REPLACE INTO pp_15m (dev, b, port, n, s, mx, lt)
        SELECT ?, ts / ${G15}, port, COUNT(*), SUM(bps), MAX(bps), MAX(ts) FROM port_perf WHERE device_id = ? AND ts >= ? AND ts < ? GROUP BY ts / ${G15}, port`);
      let s1h = ins1h(db.conn); let s15 = ins15(db.conn);
      let sliceT = Date.now();
      for (;;) {
        if (db.retired || db.closed) {   // 조회 감시가 엔진을 재시작했다 — 새 핸들로 잇는다
          release(); db = await open(); if (!db) throw new Error('DB 를 다시 열 수 없습니다');
          release = holdDb(db); s1h = ins1h(db.conn); s15 = ins15(db.conn);
        }
        const cs = Number(db.completeSince) || 0;
        if (cs <= 0) { _bf.state = 'done'; break; }
        const oldest = db.conn.prepare('SELECT MIN(ts) AS v FROM port_perf').get()?.v;
        if (oldest == null || cs <= alignDown(Number(oldest), G1H)) { setCompleteSince(db, 0); _bf.state = 'done'; break; }
        const hi = cs; const lo = cs - BF_SLICE_MS;
        const nowMs = now ?? Date.now();
        const lo15 = Math.max(lo, alignUp(nowMs - R15_DAYS * DAY, G15));
        for (const id of devs) {
          const dev = devNoOf(db, id);
          s1h.run(dev, id, lo, hi); _bf.statements++;
          if (lo15 < hi) { s15.run(dev, id, lo15, hi); _bf.statements++; }
          if (Date.now() - sliceT >= workMs) {
            if (restMs > 0) await new Promise((r) => setTimeout(r, restMs).unref?.());
            else await new Promise((r) => setImmediate(r));
            sliceT = Date.now();
          }
        }
        setCompleteSince(db, lo);
        _bf.slices++;
        if (Date.now() - t0 > maxMs) { _bf.state = 'paused'; break; }
      }
      if (_bf.state === 'done') {
        _bf.finishedAt = Date.now();
        console.log(`[sanswitch-perf] 집계 표 백필 완료 — 조각 ${_bf.slices}개 · 문장 ${_bf.statements}개 · 장비 ${_bf.devices}대 · ${Math.round((_bf.finishedAt - (_bf.startedAt || t0)) / 1000)}초`);
      }
    } catch (e) {
      _bf.state = 'error'; _bf.error = String(e?.message || e).slice(0, 300);
      console.warn(`[sanswitch-perf] 집계 표 백필 실패(다음 기동 때 이어서 합니다): ${_bf.error}`);
    } finally { release(); }
    return rollupStatus(db, Date.now());
  })().finally(() => { _bfRun = null; });
  return _bfRun;
}

function scheduleRollupBackfill() {
  if (String(process.env.SANSW_PERF_ROLLUP_BACKFILL ?? '') === '0') { _bf.state = 'off'; return; }
  if (_bfTimer || _bf.state === 'done') return;
  _bfTimer = setTimeout(() => { _bfTimer = null; runRollupBackfill().catch(() => {}); }, BF_DELAY_MS);
  _bfTimer.unref?.();
}

/** 집계 표 상태 — 설정 화면 '보관 현황' 이 보여 준다. 진행률은 원본 기간 중 집계 표로 채운 비율(시각 기준 어림). */
function rollupStatus(db, now = Date.now()) {
  const cs = Number(db?.completeSince) || 0;
  let oldest = null;
  try { const r = db.conn.prepare('SELECT MIN(ts) AS v FROM port_perf').get(); oldest = r?.v == null ? null : Number(r.v); } catch { /* */ }
  let pct = null;
  if (cs <= 0) pct = 100;
  else if (oldest != null && now > oldest) pct = Math.max(0, Math.min(100, Math.round(((now - Math.max(cs, oldest)) / (now - oldest)) * 100)));
  return {
    completeSince: cs || 0, oldestRaw: oldest, pct, state: cs <= 0 ? 'done' : _bf.state,
    slices: _bf.slices, startedAt: _bf.startedAt, finishedAt: _bf.finishedAt, error: _bf.error,
    retention: { rawDays: (() => { try { return loadPerfSettings().retentionDays; } catch { return null; } })(), m15Days: R15_DAYS, h1Days: rollupDays() },
  };
}

export function _resetForTest() {
  _qcache.clear(); _chains.multi = Promise.resolve(); _chains.single = Promise.resolve(); lockRetry.ok();
  try { _db?.conn?.close?.(); } catch { /* */ }
  _db = null; _pruneTick = 0; _pruneFlight.reset();
  if (_bfTimer) { clearTimeout(_bfTimer); _bfTimer = null; }
  _bf = { state: 'idle', startedAt: null, finishedAt: null, slices: 0, statements: 0, error: null, devices: 0 };
}
