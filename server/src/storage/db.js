/**
 * storage/db.js — 스토리지 수집 DB(v2.308, 사용자 요구 '수집한 모든 정보는 DB 에 저장').
 *
 * SQLite(node:sqlite — idrac/db.js 와 동일 백엔드) 파일: CONFIG_DIR/storage-history.db
 *  - api_latest  : OneFS API 영역별 응답 **원문(JSON)** 최신본 — (device, endpoint) 당 1행 갱신.
 *  - api_history : 영역별 수집 성공/실패 이력(원문 아님 — 상태·크기만. 원문 이력까지 쌓으면
 *                  40영역×주기로 DB 가 GB 단위로 폭주한다. 원문은 최신본만, 이력은 메타만 —
 *                  정직 표기: 릴리스 노트에 명시).
 *  - capacity_history : 용량 시계열(전체/HDD/SSD) — 추이 그래프용. 폴링마다 1점.
 *
 * CLAUDE.md 성능 규칙 준수: WAL + synchronous=NORMAL + busy_timeout(단건 insert 실측 최적화),
 * prune 는 매 저장이 아니라 N회마다 1회(스로틀) + ts 단독 인덱스(DELETE WHERE ts<? 풀스캔 방지).
 * node:sqlite 미지원 환경(구버전 Node)은 no-op 폴백 — 수집/화면은 살아있고 DB 만 비활성
 * (available() 로 UI 에 정직하게 표시).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, isSqliteLockError, createLockRetry } from '../util/sqliteOpen.js'; // v2.613 PERSIST2613-03: open 코어는 하나
import { numOrNull } from '../util/numOrNull.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { createYielder } from '../util/timeSlice.js';   // v2.743 DB-01: 합계 추이 조각 사이 양보(시간 기준)
import { pushAll } from '../util/pushAll.js';
import { normalizeResourceList, resourceKey } from './resources.js';   // v2.789 하위 항목
import { nodeLoadRowsOf, sampleRowsOf, METRIC_BY_KEY, NODE_LOAD_GROUPS, NODE_LOAD_METRICS, NODE_LOAD_LIMIT } from './nodeLoad.js';   // v2.926 노드 부하 · v2.932 5분 표본

// DB 저장 경로 설정(v2.379)을 따른다 — dbLocation 이 지정한 dbDir 아래, 없으면 configDir.
// (vmperf/vmtrack 과 동일 규약. MIGRATABLE 에 이 파일이 있어 미적용 시 마이그레이션 후
//  옛 경로에 계속 쓰다 원본 삭제 단계에서 이력이 소실된다 — v2.386 수정.)
const FILE = () => path.join(config.dbDir || config.configDir, 'storage-history.db');
const MAX_JSON_BYTES = 512 * 1024; // 엔드포인트당 원문 상한 — 512KB 초과는 절단 표기(폭주 방지)
/** v2.932 — 없는 열만 ALTER TABLE ADD COLUMN(멱등 · bmusage/db.js v2.919 와 같은 방식). 'duplicate column' 만 삼킨다(잠금은 던진다). */
function ensureColumns(conn, table, cols) {
  let have;
  try { have = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name)); } catch { return 0; }
  let added = 0;
  for (const [col, type] of cols) {
    if (have.has(col)) continue;
    try { conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); added += 1; }
    catch (e) { if (!/duplicate column/i.test(String(e?.message))) throw e; }
  }
  return added;
}

/**
 * 보존 기간(v2.531 — 사용자 요청 "스토리지 사용량 저장을 사용자가 설정에서 지정 · 기본 5년").
 *
 * **두 단계로 나눈다**(사용자 선택 "일 단위 롤업 5년 + 원시 90일"):
 *  · `capacity_history`(원시) — 폴링마다 1점. 짧게 둔다.
 *  · `capacity_daily`(일 롤업) — 하루 1행. 길게 둔다(기본 5년).
 *
 * 왜 나눴나 — 실제 계산: 5년을 원시로 두면 장비당 `폴링/일 × 1,825일` 이다. 10분 주기였을 때
 * 262,800행/장비(20대 ≈ 525만 행 · 400MB 추정)였고, 1시간 주기가 된 뒤에도 43,800행/장비다.
 * 증가량 분석에 필요한 해상도는 **하루 1점**이면 충분하고 그때는 1,825행/장비(20대 3.6만 행)다.
 *
 * ⚠ **환경변수는 하한이 아니라 폴백이다** — 설정 파일(`growthSettings.js`)이 우선이고, 없을 때만
 *   env, 그것도 없으면 기본값이다. 화면이 '어디서 온 값인지' 를 밝힌다(v2.493 규약).
 */
export const RAW_KEEP_DAYS_DEF = 90;
export const DAILY_KEEP_DAYS_DEF = 5 * 365;   // 5년(사용자 지정 기본값)
export const NODE_LOAD_RAW_KEEP_DAYS_DEF = 7;   // v2.926 30일 → v2.932 7일(5분 표본이면 12배 — 저장값이 있으면 그대로다)
export const NODE_LOAD_HOURLY_KEEP_DAYS_DEF = 90;  // v2.932 노드 시간 요약
export const NODE_CLIENT_RAW_KEEP_DAYS_DEF = 2;    // v2.932 클라이언트·프로토콜 원시(5분)
export const NODE_CLIENT_HOURLY_KEEP_DAYS_DEF = 30;
export const NODE_CLIENT_DAILY_KEEP_DAYS_DEF = 365;

/**
 * 일 경계 오프셋(분). 사용자(포탈 운영자)는 **한국**에 있으므로 기본 +9시간이다 —
 * UTC 로 자르면 한국 기준 오전 9시에 날이 바뀌어 '어제 증가량' 이 사람이 세는 하루와 어긋난다.
 * 다른 지역에서 쓰려면 `STORAGE_GROWTH_TZ_OFFSET_MIN` 으로 바꾼다.
 */
// 날짜 경계 코어는 `util/dayKey.js` 하나다(v2.582 ARCH-2 — 세 벌이던 것을 합쳤다). `STORAGE_GROWTH_TZ_OFFSET_MIN`
// 은 그 모듈이 호환으로 계속 읽는다. import 뒤 export(v2.575 재수출 규약).
import { DAY_OFFSET_MIN, DAY_MS, dayIndex, dayStartMs, dayLabel } from "../util/dayKey.js";
export { DAY_OFFSET_MIN, dayIndex, dayStartMs, dayLabel };

/** 보존 일수(설정 → env → 기본). 순환 import 를 피하려고 setter 로 주입받는다. */
let _keepDays = { raw: null, daily: null, nodeRaw: null, nodeHourly: null, clientRaw: null, clientHourly: null, clientDaily: null };
export function setKeepDays({ rawKeepDays, dailyKeepDays, nodeLoadRawKeepDays, nodeLoadHourlyKeepDays, nodeClientRawKeepDays, nodeClientHourlyKeepDays, nodeClientDailyKeepDays } = {}) {
  // ⚠⚠ v2.576: `numOrNull` 로 좁힌다. 예전 형태(`Number.isFinite(Number(v)) ? … : null`)는
  //   `Number(null)`·`Number('')`·`Number([])` 를 전부 **0** 으로 통과시킨다. 여기서 0 이 되면
  //   아래 `keepDays()` 의 `_keepDays.raw ?? 기본값` 이 **0 ?? x === 0** 이라 기본값으로 되돌지
  //   못하고 **보존 0일 = 전량 삭제**가 된다. v2.561 은 `loadGrowthSettings()` 가 명시적 null 을
  //   막고 있다는 근거로 REVIEWED_SAFE 로 뒀지만, 그 근거는 **호출부 하나**에 기댄 것이라
  //   다음 호출부가 생기면 무효가 된다. 결과가 파괴적이므로 sink 에서 막는다.
  _keepDays = { raw: numOrNull(rawKeepDays), daily: numOrNull(dailyKeepDays), nodeRaw: numOrNull(nodeLoadRawKeepDays),
    nodeHourly: numOrNull(nodeLoadHourlyKeepDays), clientRaw: numOrNull(nodeClientRawKeepDays), clientHourly: numOrNull(nodeClientHourlyKeepDays), clientDaily: numOrNull(nodeClientDailyKeepDays) };
}
function keepDays() {
  return {
    raw: _keepDays.raw ?? (Number(process.env.STORAGE_HISTORY_KEEP_DAYS) || RAW_KEEP_DAYS_DEF),
    daily: _keepDays.daily ?? (Number(process.env.STORAGE_DAILY_KEEP_DAYS) || DAILY_KEEP_DAYS_DEF),
    // v2.926 노드 부하 원시 — 노드 × 주기라 용량 원시보다 크다(64 노드 · 1시간 = 하루 1,536행) → 기본을 짧게(30일).
    nodeRaw: _keepDays.nodeRaw ?? (Number(process.env.STORAGE_NODELOAD_KEEP_DAYS) || NODE_LOAD_RAW_KEEP_DAYS_DEF),
    // v2.932 — 노드 시간 요약 · 클라이언트/프로토콜 원시·시간·일(설정 → env → 기본).
    nodeHourly: _keepDays.nodeHourly ?? (Number(process.env.STORAGE_NODELOAD_HOURLY_KEEP_DAYS) || NODE_LOAD_HOURLY_KEEP_DAYS_DEF),
    clientRaw: _keepDays.clientRaw ?? (Number(process.env.STORAGE_NODECLIENT_KEEP_DAYS) || NODE_CLIENT_RAW_KEEP_DAYS_DEF),
    clientHourly: _keepDays.clientHourly ?? (Number(process.env.STORAGE_NODECLIENT_HOURLY_KEEP_DAYS) || NODE_CLIENT_HOURLY_KEEP_DAYS_DEF),
    clientDaily: _keepDays.clientDaily ?? (Number(process.env.STORAGE_NODECLIENT_DAILY_KEEP_DAYS) || NODE_CLIENT_DAILY_KEEP_DAYS_DEF),
  };
}

let _db = null;      // { conn, stmts } | 'unavailable'
let _pruneTick = 0;

// v2.580(BUG-A): **진행 중인 open 을 공유한다** — 예전에는 `_db` 검사와 `await import('node:sqlite')`
// 사이에서 두 번째 호출이 들어오면 같은 파일에 `DatabaseSync` 가 **둘** 만들어지고 첫 핸들이 새어
// 나갔다(v2.580 재현: 동시 2호출 → 같은 파일 fd 2개). `bmusage/db.js`(v2.550)와 같은 패턴이다.
let _opening = null;
// v2.597(감사 L2597-02 — 재현): 첫 open 에서 다른 프로세스가 잠금을 쥐고 있으면('database is locked') 예전에는
// 'unavailable' 로 래치해 **프로세스 수명 동안** 시계열 저장이 꺼졌다. 잠금은 일시적이므로 래치하지 않고 30초 뒤 다시 연다.
// v2.613 PERSIST2613-03: 그 규칙의 원조가 이 파일이었는데 util/sqliteOpen.js 로 뽑은 뒤 여기만 손 사본(_retryAt · 자체
//   isSqliteLockError)으로 남아 있었다 — 잠금 판정·재시도 시각·PRAGMA 순서를 공용 헬퍼로 옮긴다(동작 동일).
const lockRetry = createLockRetry(30_000);
export { isSqliteLockError }; // 판정은 util/sqliteOpen.js 하나(예전 호출부·테스트 호환 재수출)
async function open() {
  if (_db) return _db === 'unavailable' ? null : _db;
  if (lockRetry.blocked()) return null;
  if (_opening) return _opening;
  _opening = openInner().finally(() => { _opening = null; });
  return _opening;
}
async function openInner() {
  if (_db) return _db === 'unavailable' ? null : _db;
  let conn = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    // v2.447(감사 S4) DB 파일 권한 0600 · v2.611(DB2611-01) 기존 -wal/-shm 잔재까지 0600 · v2.597(L2597-02) busy_timeout 을
    // journal_mode 보다 먼저 — 셋 다 openSqlite 가 한다(chmod → busy_timeout → WAL/NORMAL). 잠금이면 핸들을 닫고 던진다.
    conn = openSqlite(new DatabaseSync(FILE()));
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort — openSqlite 가 이미 했다(secAudit2535 스윕 규약 유지) */ }
    conn.exec(`CREATE TABLE IF NOT EXISTS api_latest (
        device_id TEXT NOT NULL, area TEXT NOT NULL, endpoint TEXT NOT NULL,
        ts INTEGER NOT NULL, ok INTEGER NOT NULL, bytes INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0, json TEXT, error TEXT,
        PRIMARY KEY (device_id, endpoint)
      );
      CREATE TABLE IF NOT EXISTS api_history (
        device_id TEXT NOT NULL, area TEXT NOT NULL, ts INTEGER NOT NULL,
        ok INTEGER NOT NULL, bytes INTEGER NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_apih_ts ON api_history (ts);
      CREATE TABLE IF NOT EXISTS capacity_history (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL,
        total_bytes INTEGER, used_bytes INTEGER,
        hdd_total INTEGER, hdd_used INTEGER, ssd_total INTEGER, ssd_used INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_caph_ts ON capacity_history (ts);
      CREATE INDEX IF NOT EXISTS idx_caph_dev_ts ON capacity_history (device_id, ts);
      /* 일 단위 롤업(v2.531) - 증가량 분석의 원천. 하루 1행이라 5년을 담아도 장비당 1,825행이다.
         - last_* = 그 날의 **마지막 관측**. 증가량은 '그 날 끝난 시점' 기준이 사람이 세는 방식과
           맞는다(평균을 쓰면 수집이 몰린 시간대에 값이 끌려간다).
         - max_used 는 정보로만 - 피크가 필요할 때 쓴다(증가량 계산에는 쓰지 않는다).
         - samples = 그 날 적재된 유효 표본 수. '몇 번 봤는지' 를 남겨야 '그 날은 수집이
           1번뿐이었다' 를 화면이 말할 수 있다(조용한 결측 금지). */
      CREATE TABLE IF NOT EXISTS capacity_daily (
        device_id TEXT NOT NULL, day INTEGER NOT NULL, last_ts INTEGER NOT NULL,
        total_bytes INTEGER, used_bytes INTEGER,
        hdd_total INTEGER, hdd_used INTEGER, ssd_total INTEGER, ssd_used INTEGER,
        max_used INTEGER, samples INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (device_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_capd_day ON capacity_daily (day);
      /* 운영 메타(v2.534) — 1회성 마이그레이션 표식과 '이력 재시작' 기록을 담는다.
         용량 이력은 '측정 기준' 이 바뀌면 이전 값과 이어 붙일 수 없다. 그 사실을 남기지
         않으면 화면의 '관측 N일' 이 이유 없이 1일로 줄어 사용자가 수집 장애로 오해한다. */
      CREATE TABLE IF NOT EXISTS storage_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      /* 하위 항목(LUN·파일시스템) 일 롤업(v2.789) — 사용자 요청 "스토리지 사용량을 일간/주간 별로" + 선택 "LUN·파일시스템까지".
         capacity_daily 와 같은 규칙: 하루 1행 · 그 날의 마지막 관측 · 더 늦은 관측만 갱신 · samples 누적 · 보존은 일 롤업 보존일.
         rkey = storage/resources.js resourceKey(종류 + 장비 id, 없으면 이름) — 이름을 바꿔도 이력이 이어진다. name 은 그 날의 이름.
         크기를 못 읽은 항목은 행을 만들지 않는다(0 을 지어내지 않는다). */
      CREATE TABLE IF NOT EXISTS resource_daily (
        device_id TEXT NOT NULL, rkey TEXT NOT NULL, day INTEGER NOT NULL, last_ts INTEGER NOT NULL,
        kind TEXT NOT NULL, name TEXT, pool TEXT, total_bytes INTEGER, used_bytes INTEGER,
        samples INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (device_id, rkey, day)
      );
      CREATE INDEX IF NOT EXISTS idx_resd_day ON resource_daily (day);
      /* 노드 부하 시계열(v2.926) — 네트워크 In/Out(bps) · 디스크 쓰기/읽기(B/s) · CPU %. storage/nodeLoad.js 가 규칙을 갖는다.
         node_load_sample = 스냅샷 1개(장비 × 수집 시각) — 중복 판정(PK) · 그 주기 목록의 노드 수 · 잡 엔진(JSON, 모르면 NULL).
         node_load_history = 노드 × 수집 시각 원시(보존 nodeLoadRawKeepDays, 기본 30일). 목록에 있는 노드는 값이 모두 NULL 이어도 행을 남긴다
           (그래야 그 주기의 클러스터 합계가 부분 합인지 판정한다 — 못 읽은 값은 NULL, 0 이 아니다).
         node_load_daily = 노드 × 일 — 지표마다 sum · n(읽은 표본 수) · max(평균 = sum / n). 보존은 일 롤업 보존일(5년). */
      CREATE TABLE IF NOT EXISTS node_load_sample (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL, nodes INTEGER NOT NULL, jobs TEXT,
        PRIMARY KEY (device_id, ts)
      );
      CREATE INDEX IF NOT EXISTS idx_nls_ts ON node_load_sample (ts);
      CREATE TABLE IF NOT EXISTS node_load_history (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL, node_id INTEGER NOT NULL,
        in_bps REAL, out_bps REAL, disk_in REAL, disk_out REAL, cpu_pct REAL
      );
      CREATE INDEX IF NOT EXISTS idx_nlh_dev_ts ON node_load_history (device_id, ts);
      CREATE INDEX IF NOT EXISTS idx_nlh_ts ON node_load_history (ts);
      CREATE TABLE IF NOT EXISTS node_load_daily (
        device_id TEXT NOT NULL, node_id INTEGER NOT NULL, day INTEGER NOT NULL, samples INTEGER NOT NULL DEFAULT 1,
        in_sum REAL NOT NULL DEFAULT 0, in_n INTEGER NOT NULL DEFAULT 0, in_max REAL,
        out_sum REAL NOT NULL DEFAULT 0, out_n INTEGER NOT NULL DEFAULT 0, out_max REAL,
        din_sum REAL NOT NULL DEFAULT 0, din_n INTEGER NOT NULL DEFAULT 0, din_max REAL,
        dout_sum REAL NOT NULL DEFAULT 0, dout_n INTEGER NOT NULL DEFAULT 0, dout_max REAL,
        cpu_sum REAL NOT NULL DEFAULT 0, cpu_n INTEGER NOT NULL DEFAULT 0, cpu_max REAL,
        PRIMARY KEY (device_id, node_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_nld_dev_day ON node_load_daily (device_id, day);
      CREATE INDEX IF NOT EXISTS idx_nld_day ON node_load_daily (day);
      /* v2.932(2차) — 5분 표본: 노드 시간 요약(원시 7일 밖의 7일 보기·이전 구간) · 노드별 클라이언트(원시 2일 · 시간 30일 · 일 1년) · 노드 × 프로토콜.
         규칙은 storage/nodeLoad.js. 표본 1개 = 트랜잭션 1개. 클라이언트 In/Out 은 B/s(네트워크 노드 값 bps 와 다르다 — 화면이 단위를 붙인다). */
      CREATE TABLE IF NOT EXISTS node_load_hourly (
        device_id TEXT NOT NULL, node_id INTEGER NOT NULL, hour INTEGER NOT NULL, samples INTEGER NOT NULL DEFAULT 1,
        in_sum REAL NOT NULL DEFAULT 0, in_n INTEGER NOT NULL DEFAULT 0, in_max REAL,
        out_sum REAL NOT NULL DEFAULT 0, out_n INTEGER NOT NULL DEFAULT 0, out_max REAL,
        din_sum REAL NOT NULL DEFAULT 0, din_n INTEGER NOT NULL DEFAULT 0, din_max REAL,
        dout_sum REAL NOT NULL DEFAULT 0, dout_n INTEGER NOT NULL DEFAULT 0, dout_max REAL,
        cpu_sum REAL NOT NULL DEFAULT 0, cpu_n INTEGER NOT NULL DEFAULT 0, cpu_max REAL,
        ops_sum REAL NOT NULL DEFAULT 0, ops_n INTEGER NOT NULL DEFAULT 0, ops_max REAL,
        lat_sum REAL NOT NULL DEFAULT 0, lat_n INTEGER NOT NULL DEFAULT 0, lat_max REAL,
        busy_sum REAL NOT NULL DEFAULT 0, busy_n INTEGER NOT NULL DEFAULT 0, busy_max REAL,
        iops_sum REAL NOT NULL DEFAULT 0, iops_n INTEGER NOT NULL DEFAULT 0, iops_max REAL,
        PRIMARY KEY (device_id, node_id, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_nlh2_dev_hour ON node_load_hourly (device_id, hour);
      CREATE INDEX IF NOT EXISTS idx_nlh2_hour ON node_load_hourly (hour);
      CREATE TABLE IF NOT EXISTS node_client_sample (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL, node_id INTEGER NOT NULL, client TEXT NOT NULL, proto TEXT NOT NULL DEFAULT '',
        name TEXT, ops REAL, in_bps REAL, out_bps REAL, lat REAL
      );
      CREATE INDEX IF NOT EXISTS idx_ncs_dev_ts ON node_client_sample (device_id, ts);
      CREATE INDEX IF NOT EXISTS idx_ncs_ts ON node_client_sample (ts);
      CREATE TABLE IF NOT EXISTS node_client_hourly (
        device_id TEXT NOT NULL, node_id INTEGER NOT NULL, client TEXT NOT NULL, proto TEXT NOT NULL DEFAULT '', hour INTEGER NOT NULL,
        name TEXT, samples INTEGER NOT NULL DEFAULT 1,
        ops_sum REAL NOT NULL DEFAULT 0, ops_n INTEGER NOT NULL DEFAULT 0, in_sum REAL NOT NULL DEFAULT 0, in_n INTEGER NOT NULL DEFAULT 0,
        out_sum REAL NOT NULL DEFAULT 0, out_n INTEGER NOT NULL DEFAULT 0, lat_sum REAL NOT NULL DEFAULT 0, lat_n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, node_id, client, proto, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_nch_dev_hour ON node_client_hourly (device_id, hour);
      CREATE INDEX IF NOT EXISTS idx_nch_hour ON node_client_hourly (hour);
      CREATE TABLE IF NOT EXISTS node_client_daily (
        device_id TEXT NOT NULL, node_id INTEGER NOT NULL, client TEXT NOT NULL, proto TEXT NOT NULL DEFAULT '', day INTEGER NOT NULL,
        name TEXT, samples INTEGER NOT NULL DEFAULT 1,
        ops_sum REAL NOT NULL DEFAULT 0, ops_n INTEGER NOT NULL DEFAULT 0, in_sum REAL NOT NULL DEFAULT 0, in_n INTEGER NOT NULL DEFAULT 0,
        out_sum REAL NOT NULL DEFAULT 0, out_n INTEGER NOT NULL DEFAULT 0, lat_sum REAL NOT NULL DEFAULT 0, lat_n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, node_id, client, proto, day)
      );
      CREATE INDEX IF NOT EXISTS idx_ncd_dev_day ON node_client_daily (device_id, day);
      CREATE INDEX IF NOT EXISTS idx_ncd_day ON node_client_daily (day);
      CREATE TABLE IF NOT EXISTS node_proto_hourly (
        device_id TEXT NOT NULL, node_id INTEGER NOT NULL, proto TEXT NOT NULL, hour INTEGER NOT NULL, samples INTEGER NOT NULL DEFAULT 1,
        ops_sum REAL NOT NULL DEFAULT 0, ops_n INTEGER NOT NULL DEFAULT 0, ops_max REAL, lat_sum REAL NOT NULL DEFAULT 0, lat_n INTEGER NOT NULL DEFAULT 0, lat_max REAL,
        PRIMARY KEY (device_id, node_id, proto, hour)
      );
      CREATE INDEX IF NOT EXISTS idx_nph_dev_hour ON node_proto_hourly (device_id, hour);
      CREATE INDEX IF NOT EXISTS idx_nph_hour ON node_proto_hourly (hour);
      CREATE TABLE IF NOT EXISTS node_proto_daily (
        device_id TEXT NOT NULL, node_id INTEGER NOT NULL, proto TEXT NOT NULL, day INTEGER NOT NULL, samples INTEGER NOT NULL DEFAULT 1,
        ops_sum REAL NOT NULL DEFAULT 0, ops_n INTEGER NOT NULL DEFAULT 0, ops_max REAL, lat_sum REAL NOT NULL DEFAULT 0, lat_n INTEGER NOT NULL DEFAULT 0, lat_max REAL,
        PRIMARY KEY (device_id, node_id, proto, day)
      );
      CREATE INDEX IF NOT EXISTS idx_npd_dev_day ON node_proto_daily (device_id, day);
      CREATE INDEX IF NOT EXISTS idx_npd_day ON node_proto_daily (day);`);
    // v2.932 — 1차 표에 열 추가(멱등 · bmusage/db.js v2.919 와 같은 방식: 없는 열만 ALTER).
    ensureColumns(conn, 'node_load_history', [['ops', 'REAL'], ['lat', 'REAL'], ['busy', 'REAL'], ['iops', 'REAL']]);
    ensureColumns(conn, 'node_load_daily', ['ops', 'lat', 'busy', 'iops'].flatMap((k) => [[`${k}_sum`, 'REAL NOT NULL DEFAULT 0'], [`${k}_n`, 'INTEGER NOT NULL DEFAULT 0'], [`${k}_max`, 'REAL']]));
    _db = {
      conn,
      upLatest: conn.prepare(`INSERT INTO api_latest (device_id, area, endpoint, ts, ok, bytes, truncated, json, error)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, endpoint) DO UPDATE SET area=excluded.area, ts=excluded.ts, ok=excluded.ok,
          bytes=excluded.bytes, truncated=excluded.truncated, json=excluded.json, error=excluded.error`),
      insHist: conn.prepare('INSERT INTO api_history (device_id, area, ts, ok, bytes, error) VALUES (?,?,?,?,?,?)'),
      insCap: conn.prepare('INSERT INTO capacity_history (device_id, ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used) VALUES (?,?,?,?,?,?,?,?)'),
      // v2.590 P12: 같은 (장비, 시각) 표본이 다시 오면(중앙 재시작 뒤 엣지 재전송 — 중앙의 중복 차단 `_lastRec` 은 메모리
      // 전용이다) 원시 행도 일 롤업 표본 수도 늘리지 않는다. 유일 인덱스를 새로 걸면 기존 중복 행 때문에 생성이 실패하므로
      // 기존 (device_id, ts) 인덱스로 존재만 확인한다(v2.550.3 규약: 중복이면 롤업을 건드리지 않는다).
      hasCap: conn.prepare('SELECT 1 AS x FROM capacity_history WHERE device_id = ? AND ts = ? LIMIT 1'),
      selAreas: conn.prepare('SELECT area, endpoint, ts, ok, bytes, truncated, error FROM api_latest WHERE device_id = ? ORDER BY area, endpoint'),
      selOne: conn.prepare('SELECT json, ts, ok, truncated, error FROM api_latest WHERE device_id = ? AND endpoint = ?'),
      selCap: conn.prepare('SELECT ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used FROM capacity_history WHERE device_id = ? AND ts >= ? ORDER BY ts LIMIT 5000'),
      // 버킷 다운샘플(v2.318, 추이 그래프): 장기 구간(90일=1.3만 점, 400일=5.7만 점)은 raw 가
      // LIMIT 5000 에 앞부분만 잘려 "최근이 안 보이는" 그래프가 된다 — 시간 버킷 평균으로 축약.
      // AVG 사용: 용량은 완만히 변하는 값이라 버킷 내 평균이 추세를 정직하게 대표(스파이크
      // 관측이 목적이면 raw 를 쓰면 됨 — 단기 구간은 라우트가 raw 경로를 태운다).
      // CAST 필수: node:sqlite 는 JS 숫자를 REAL 로 바인딩해 ts/? 가 실수 나눗셈이 된다 —
      // CAST 없이는 행마다 고유한 몫이 되어 GROUP BY 가 아무것도 묶지 못한다(테스트로 실측).
      selCapBucket: conn.prepare(`SELECT CAST(CAST(ts/? AS INTEGER)*? AS INTEGER) AS ts,
        AVG(total_bytes) AS total_bytes, AVG(used_bytes) AS used_bytes,
        AVG(hdd_total) AS hdd_total, AVG(hdd_used) AS hdd_used, AVG(ssd_total) AS ssd_total, AVG(ssd_used) AS ssd_used
        FROM capacity_history WHERE device_id = ? AND ts >= ? GROUP BY CAST(ts/? AS INTEGER) ORDER BY ts LIMIT 2000`),
      // 전체(모든 장비) 합산 시계열(v2.380) — 목록 화면의 통합 추이용.
      // 장비마다 수집 시각이 조금씩 다르므로 **버킷으로 시각을 정렬한 뒤 장비 합계**를 낸다.
      // 안쪽 쿼리에서 (버킷, 장비)별 평균을 구하고(같은 버킷에 여러 샘플이 있을 수 있음)
      // 바깥에서 장비들을 SUM 한다 — 이 순서가 아니면 샘플 수가 많은 장비가 과대 반영된다.
      // CAST 필수(node:sqlite 는 JS 숫자를 REAL 로 바인딩 — selCapBucket 주석과 같은 이유).
      // v2.594(감사 R2594-05): SQL SUM 은 NULL 을 건너뛴다 — 사용량을 못 읽은 장비가 있으면 used 합은
      // 그 장비를 빼고 total 합은 넣어 **거짓 하락**이 된다. 그 버킷의 사용량은 NULL(선이 끊긴다)이고
      // 빠진 대수를 used_unknown 으로 준다(화면이 밝힌다). hdd/ssd 도 같은 규칙.
      // v2.600 DB2600-01: 장비별 버킷 평균만 SQL 이 하고, **합산은 JS 가 carry-forward 로** 한다
      // (sumCapacityBuckets). 예전 selCapAllBucket 은 버킷 안에 관측이 있는 장비만 SUM 했다 —
      // 수집 주기가 1시간(v2.531)인데 12h·24h 추이는 10분 버킷이라, 엣지 4곳이 서로 다른 분에
      // 수집하면 **점마다 한 엣지 장비만** 합산돼 합계가 실제의 1/4 로 그려졌다(재현: 20대 → 점마다 5대).
      // 점마다 장비 수가 같아서(5·5·5…) 화면의 '구간마다 장비 수가 다르다' 경고도 뜨지 않았다.
      // v2.743(감사 DB-01): 기간 전체를 한 문장으로 GROUP BY 하지 않는다 — 버킷 정배수 시간 조각([lo, hi))으로 나눠 읽고
      // 조각 사이에 양보한다(capacityHistoryAll). 조각 경계가 버킷 경계라 (버킷, 장비) 묶음이 두 조각에 나뉘지 않아 AVG 가
      // 예전 한 문장과 같다(테스트가 예전 문장과 대조한다). 마지막 조각은 위가 열려 있다(엣지 시계가 앞선 표본도 예전처럼 읽는다).
      // ORDER BY 1, 2 — 예전 문장은 ORDER BY 1 이었지만 GROUP BY 정렬이 이미 (버킷, 장비) 순이라 결과 순서는 같다.
      selCapDevBucketSlice: conn.prepare(`SELECT CAST(CAST(ts/? AS INTEGER)*? AS INTEGER) AS ts, device_id,
            AVG(total_bytes) AS total_bytes, AVG(used_bytes) AS used_bytes,
            AVG(hdd_total) AS hdd_total, AVG(hdd_used) AS hdd_used,
            AVG(ssd_total) AS ssd_total, AVG(ssd_used) AS ssd_used
          FROM capacity_history WHERE ts >= ? AND ts < ?
          GROUP BY CAST(ts/? AS INTEGER), device_id
          ORDER BY 1, 2 LIMIT ?`),
      // 조각 시작점 — 첫 표본 이전의 빈 조각을 묻지 않는다(since 가 아주 이르면 수만 조각이 된다). MIN 단독 문장이라 인덱스 끝 한 번이다(v2.550.3).
      selCapMinTsFrom: conn.prepare('SELECT MIN(ts) AS t FROM capacity_history WHERE ts >= ?'),
      selCapDevBucketTail: conn.prepare(`SELECT CAST(CAST(ts/? AS INTEGER)*? AS INTEGER) AS ts, device_id,
            AVG(total_bytes) AS total_bytes, AVG(used_bytes) AS used_bytes,
            AVG(hdd_total) AS hdd_total, AVG(hdd_used) AS hdd_used,
            AVG(ssd_total) AS ssd_total, AVG(ssd_used) AS ssd_used
          FROM capacity_history WHERE ts >= ?
          GROUP BY CAST(ts/? AS INTEGER), device_id
          ORDER BY 1, 2 LIMIT ?`),
      // 일 롤업 upsert — **더 늦은 관측만** last_* 를 갱신한다(엣지 push 가 순서대로 오지 않을 수
      // 있다). max_used 는 항상 최대를 유지하고 samples 는 누적한다.
      /*
       * ⚠⚠ v2.574 BUG-04 — `max_used` 는 **측정값**이라 '못 읽음' 과 '0바이트' 를 구분해야 한다.
       *   예전: `MAX(COALESCE(capacity_daily.max_used, 0), COALESCE(excluded.max_used, 0))`
       *     → 하루 종일 못 읽은 장비의 그날 최대가 **0** 으로 저장된다(= '사용량 0' 이라는 거짓).
       *   도달 경로는 v2.561 이 기록한 그대로다 — `storage/collectors/unitySsh.js:163` 이 풀 목록을
       *   못 읽으면 `usedBytes: null` 을 **정직하게** 내보내고, 수집 주기가 1시간이다.
       *   정답 형태는 CLAUDE.md v2.550.3 이 못 박아 두었고 `bmusage/db.js:209-213` 이 실제로 쓴다:
       *     NULLIF(MAX(IFNULL(x, -1e308), IFNULL(excluded.x, -1e308)), -1e308)
       *   SQL 스칼라 MAX() 는 인자 하나가 NULL 이면 NULL 을 주므로 IFNULL 로 감싸야 하고,
       *   그 하한은 NULLIF 로 **반드시 되돌려야** 한다 — 안 되돌리면 -1e308 이 값으로 저장된다.
       * ⚠ 실측(v2.574): 첫 관측이 null 일 때 예전 형태는 **0**, 새 형태는 **null** 이다.
       */
      upDaily: conn.prepare(`INSERT INTO capacity_daily
          (device_id, day, last_ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used, max_used, samples)
        VALUES (?,?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(device_id, day) DO UPDATE SET
          last_ts     = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.last_ts     ELSE capacity_daily.last_ts     END,
          total_bytes = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.total_bytes ELSE capacity_daily.total_bytes END,
          used_bytes  = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.used_bytes  ELSE capacity_daily.used_bytes  END,
          hdd_total   = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.hdd_total   ELSE capacity_daily.hdd_total   END,
          hdd_used    = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.hdd_used    ELSE capacity_daily.hdd_used    END,
          ssd_total   = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.ssd_total   ELSE capacity_daily.ssd_total   END,
          ssd_used    = CASE WHEN excluded.last_ts > capacity_daily.last_ts THEN excluded.ssd_used    ELSE capacity_daily.ssd_used    END,
          -- v2.574 BUG-04 — COALESCE(..., 0) 은 '못 읽음' 을 '최대 사용량 0바이트' 로 바꾼다.
          -- v2.561 이 used_bytes 는 고쳤는데 여기만 남아 있었다. 근거·정답 형태는 이 함수의
          -- JSDoc 에 적었다(리터럴 안이라 여기에는 백틱을 쓸 수 없다 — v2.550.3 규약).
          max_used    = NULLIF(MAX(IFNULL(capacity_daily.max_used, -1e308), IFNULL(excluded.max_used, -1e308)), -1e308),
          samples     = capacity_daily.samples + 1`),
      selDaily: conn.prepare(`SELECT device_id, day, last_ts, total_bytes, used_bytes,
          hdd_total, hdd_used, ssd_total, ssd_used, max_used, samples
        FROM capacity_daily WHERE device_id = ? AND day >= ? ORDER BY day`),
      selDailyAll: conn.prepare(`SELECT device_id, day, last_ts, total_bytes, used_bytes,
          hdd_total, hdd_used, ssd_total, ssd_used, max_used, samples
        FROM capacity_daily WHERE day >= ? ORDER BY device_id, day`),
      // v2.791: 구간 읽기(보고표 '전체 누적' — 5년 × 장비 수를 한 번에 .all() 하지 않게 조각으로). idx_capd_day 를 탄다.
      selDailyRange: conn.prepare(`SELECT device_id, day, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used
        FROM capacity_daily WHERE day >= ? AND day < ?`),
      // 장비별 **전체 이력 범위**(조회 구간과 무관). 화면의 '관측 N일' 은 이 값이어야 한다 —
      // 조회 구간(예: 90일)으로 대신하면 700일치를 가진 장비가 '92일' 로 보인다(v2.531 실제 결함).
      // capacity_daily 는 하루 1행이라 전 행을 훑어도 20대×5년 = 3.6만 행이다.
      selDailySpan: conn.prepare(`SELECT device_id, MIN(day) AS first_day, MAX(day) AS last_day,
          COUNT(*) AS observed FROM capacity_daily GROUP BY device_id`),
      metaGet: conn.prepare('SELECT v FROM storage_meta WHERE k = ?'),
      metaSet: conn.prepare('INSERT INTO storage_meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      delCapDev: conn.prepare('DELETE FROM capacity_history WHERE device_id = ?'),
      delDailyDev: conn.prepare('DELETE FROM capacity_daily WHERE device_id = ?'),
      // v2.606(DB2606-02): 한 방 DELETE 는 보존일을 줄인 직후 130만 행을 약 1초 동기로 지웠다 — rowid 청크(idx_apih_ts·
      //   capacity_history ts 인덱스)로 끊고 청크 사이에 양보한다(util/chunkedPrune.js).
      prune1: conn.prepare('DELETE FROM api_history WHERE rowid IN (SELECT rowid FROM api_history WHERE ts < ? LIMIT ?)'),
      prune2: conn.prepare('DELETE FROM capacity_history WHERE rowid IN (SELECT rowid FROM capacity_history WHERE ts < ? LIMIT ?)'),
      prune3: conn.prepare('DELETE FROM capacity_daily WHERE day < ?'),
      // v2.789 하위 항목 일 롤업 — capacity_daily 와 같은 upsert 규칙(더 늦은 관측만 갱신).
      upRes: conn.prepare(`INSERT INTO resource_daily
          (device_id, rkey, day, last_ts, kind, name, pool, total_bytes, used_bytes, samples)
        VALUES (?,?,?,?,?,?,?,?,?,1)
        ON CONFLICT(device_id, rkey, day) DO UPDATE SET
          last_ts     = CASE WHEN excluded.last_ts > resource_daily.last_ts THEN excluded.last_ts     ELSE resource_daily.last_ts     END,
          name        = CASE WHEN excluded.last_ts > resource_daily.last_ts THEN excluded.name        ELSE resource_daily.name        END,
          pool        = CASE WHEN excluded.last_ts > resource_daily.last_ts THEN excluded.pool        ELSE resource_daily.pool        END,
          total_bytes = CASE WHEN excluded.last_ts > resource_daily.last_ts THEN excluded.total_bytes ELSE resource_daily.total_bytes END,
          used_bytes  = CASE WHEN excluded.last_ts > resource_daily.last_ts THEN excluded.used_bytes  ELSE resource_daily.used_bytes  END,
          samples     = resource_daily.samples + 1`),
      // 조회는 **일 구간 조각**으로 읽는다(resourceDailyRange — 조각 사이 양보). day 인덱스를 탄다.
      selResRange: conn.prepare(`SELECT device_id, rkey, day, kind, name, pool, total_bytes, used_bytes
        FROM resource_daily WHERE day >= ? AND day < ? ORDER BY device_id, rkey, day`),
      delResDev: conn.prepare('DELETE FROM resource_daily WHERE device_id = ?'),
      // 하위 항목은 장비 × 항목 × 일이라 capacity_daily 보다 크다(Unity 18대 × 20항목 × 5년 ≈ 66만 행) — 청크로 지운다(DB2606-02 규약).
      prune4: conn.prepare('DELETE FROM resource_daily WHERE rowid IN (SELECT rowid FROM resource_daily WHERE day < ? LIMIT ?)'),
      // v2.926 노드 부하 — 적재(스냅샷 1개 = 트랜잭션 1개 · saveNodeLoadPoint) · 조회(nodeLoadQuery — 장비·시각 인덱스) · 정리(청크).
      insNodeSample: conn.prepare('INSERT OR IGNORE INTO node_load_sample (device_id, ts, nodes, jobs) VALUES (?,?,?,?)'),
      insNodeRaw: conn.prepare('INSERT INTO node_load_history (device_id, ts, node_id, in_bps, out_bps, disk_in, disk_out, cpu_pct, ops, lat, busy, iops) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
      // ⚠ max 는 스칼라 max() 를 쓰지 않는다 — SQLite 의 max(a, NULL) 은 NULL 이라 못 읽은 표본 하나가 그 날 최대를 지운다.
      // ⚠ max 는 스칼라 max() 를 쓰지 않는다 — SQLite 의 max(a, NULL) 은 NULL 이라 못 읽은 표본 하나가 그 날 최대를 지운다.
      upNodeDaily: conn.prepare(`INSERT INTO node_load_daily AS T (device_id, node_id, day, samples, in_sum, in_n, in_max, out_sum, out_n, out_max, din_sum, din_n, din_max, dout_sum, dout_n, dout_max, cpu_sum, cpu_n, cpu_max, ops_sum, ops_n, ops_max, lat_sum, lat_n, lat_max, busy_sum, busy_n, busy_max, iops_sum, iops_n, iops_max)
        VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, node_id, day) DO UPDATE SET samples = T.samples + 1,
          in_sum = T.in_sum + excluded.in_sum, in_n = T.in_n + excluded.in_n,
          in_max = CASE WHEN excluded.in_max IS NULL THEN T.in_max WHEN T.in_max IS NULL OR excluded.in_max > T.in_max THEN excluded.in_max ELSE T.in_max END,
          out_sum = T.out_sum + excluded.out_sum, out_n = T.out_n + excluded.out_n,
          out_max = CASE WHEN excluded.out_max IS NULL THEN T.out_max WHEN T.out_max IS NULL OR excluded.out_max > T.out_max THEN excluded.out_max ELSE T.out_max END,
          din_sum = T.din_sum + excluded.din_sum, din_n = T.din_n + excluded.din_n,
          din_max = CASE WHEN excluded.din_max IS NULL THEN T.din_max WHEN T.din_max IS NULL OR excluded.din_max > T.din_max THEN excluded.din_max ELSE T.din_max END,
          dout_sum = T.dout_sum + excluded.dout_sum, dout_n = T.dout_n + excluded.dout_n,
          dout_max = CASE WHEN excluded.dout_max IS NULL THEN T.dout_max WHEN T.dout_max IS NULL OR excluded.dout_max > T.dout_max THEN excluded.dout_max ELSE T.dout_max END,
          cpu_sum = T.cpu_sum + excluded.cpu_sum, cpu_n = T.cpu_n + excluded.cpu_n,
          cpu_max = CASE WHEN excluded.cpu_max IS NULL THEN T.cpu_max WHEN T.cpu_max IS NULL OR excluded.cpu_max > T.cpu_max THEN excluded.cpu_max ELSE T.cpu_max END,
          ops_sum = T.ops_sum + excluded.ops_sum, ops_n = T.ops_n + excluded.ops_n,
          ops_max = CASE WHEN excluded.ops_max IS NULL THEN T.ops_max WHEN T.ops_max IS NULL OR excluded.ops_max > T.ops_max THEN excluded.ops_max ELSE T.ops_max END,
          lat_sum = T.lat_sum + excluded.lat_sum, lat_n = T.lat_n + excluded.lat_n,
          lat_max = CASE WHEN excluded.lat_max IS NULL THEN T.lat_max WHEN T.lat_max IS NULL OR excluded.lat_max > T.lat_max THEN excluded.lat_max ELSE T.lat_max END,
          busy_sum = T.busy_sum + excluded.busy_sum, busy_n = T.busy_n + excluded.busy_n,
          busy_max = CASE WHEN excluded.busy_max IS NULL THEN T.busy_max WHEN T.busy_max IS NULL OR excluded.busy_max > T.busy_max THEN excluded.busy_max ELSE T.busy_max END,
          iops_sum = T.iops_sum + excluded.iops_sum, iops_n = T.iops_n + excluded.iops_n,
          iops_max = CASE WHEN excluded.iops_max IS NULL THEN T.iops_max WHEN T.iops_max IS NULL OR excluded.iops_max > T.iops_max THEN excluded.iops_max ELSE T.iops_max END`),
      upNodeHourly: conn.prepare(`INSERT INTO node_load_hourly AS T (device_id, node_id, hour, samples, in_sum, in_n, in_max, out_sum, out_n, out_max, din_sum, din_n, din_max, dout_sum, dout_n, dout_max, cpu_sum, cpu_n, cpu_max, ops_sum, ops_n, ops_max, lat_sum, lat_n, lat_max, busy_sum, busy_n, busy_max, iops_sum, iops_n, iops_max)
        VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, node_id, hour) DO UPDATE SET samples = T.samples + 1,
          in_sum = T.in_sum + excluded.in_sum, in_n = T.in_n + excluded.in_n,
          in_max = CASE WHEN excluded.in_max IS NULL THEN T.in_max WHEN T.in_max IS NULL OR excluded.in_max > T.in_max THEN excluded.in_max ELSE T.in_max END,
          out_sum = T.out_sum + excluded.out_sum, out_n = T.out_n + excluded.out_n,
          out_max = CASE WHEN excluded.out_max IS NULL THEN T.out_max WHEN T.out_max IS NULL OR excluded.out_max > T.out_max THEN excluded.out_max ELSE T.out_max END,
          din_sum = T.din_sum + excluded.din_sum, din_n = T.din_n + excluded.din_n,
          din_max = CASE WHEN excluded.din_max IS NULL THEN T.din_max WHEN T.din_max IS NULL OR excluded.din_max > T.din_max THEN excluded.din_max ELSE T.din_max END,
          dout_sum = T.dout_sum + excluded.dout_sum, dout_n = T.dout_n + excluded.dout_n,
          dout_max = CASE WHEN excluded.dout_max IS NULL THEN T.dout_max WHEN T.dout_max IS NULL OR excluded.dout_max > T.dout_max THEN excluded.dout_max ELSE T.dout_max END,
          cpu_sum = T.cpu_sum + excluded.cpu_sum, cpu_n = T.cpu_n + excluded.cpu_n,
          cpu_max = CASE WHEN excluded.cpu_max IS NULL THEN T.cpu_max WHEN T.cpu_max IS NULL OR excluded.cpu_max > T.cpu_max THEN excluded.cpu_max ELSE T.cpu_max END,
          ops_sum = T.ops_sum + excluded.ops_sum, ops_n = T.ops_n + excluded.ops_n,
          ops_max = CASE WHEN excluded.ops_max IS NULL THEN T.ops_max WHEN T.ops_max IS NULL OR excluded.ops_max > T.ops_max THEN excluded.ops_max ELSE T.ops_max END,
          lat_sum = T.lat_sum + excluded.lat_sum, lat_n = T.lat_n + excluded.lat_n,
          lat_max = CASE WHEN excluded.lat_max IS NULL THEN T.lat_max WHEN T.lat_max IS NULL OR excluded.lat_max > T.lat_max THEN excluded.lat_max ELSE T.lat_max END,
          busy_sum = T.busy_sum + excluded.busy_sum, busy_n = T.busy_n + excluded.busy_n,
          busy_max = CASE WHEN excluded.busy_max IS NULL THEN T.busy_max WHEN T.busy_max IS NULL OR excluded.busy_max > T.busy_max THEN excluded.busy_max ELSE T.busy_max END,
          iops_sum = T.iops_sum + excluded.iops_sum, iops_n = T.iops_n + excluded.iops_n,
          iops_max = CASE WHEN excluded.iops_max IS NULL THEN T.iops_max WHEN T.iops_max IS NULL OR excluded.iops_max > T.iops_max THEN excluded.iops_max ELSE T.iops_max END`),
      // 클라이언트 · 프로토콜(v2.932) — 같은 upsert 규칙(평균 = sum / n · 이름은 마지막 값).
      insClientRaw: conn.prepare('INSERT INTO node_client_sample (device_id, ts, node_id, client, proto, name, ops, in_bps, out_bps, lat) VALUES (?,?,?,?,?,?,?,?,?,?)'),
      upClientHourly: conn.prepare(`INSERT INTO node_client_hourly AS T (device_id, node_id, client, proto, hour, name, samples, ops_sum, ops_n, in_sum, in_n, out_sum, out_n, lat_sum, lat_n)
        VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, node_id, client, proto, hour) DO UPDATE SET samples = T.samples + 1, name = COALESCE(NULLIF(excluded.name, ''), T.name),
          ops_sum = T.ops_sum + excluded.ops_sum, ops_n = T.ops_n + excluded.ops_n, in_sum = T.in_sum + excluded.in_sum, in_n = T.in_n + excluded.in_n,
          out_sum = T.out_sum + excluded.out_sum, out_n = T.out_n + excluded.out_n, lat_sum = T.lat_sum + excluded.lat_sum, lat_n = T.lat_n + excluded.lat_n`),
      upClientDaily: conn.prepare(`INSERT INTO node_client_daily AS T (device_id, node_id, client, proto, day, name, samples, ops_sum, ops_n, in_sum, in_n, out_sum, out_n, lat_sum, lat_n)
        VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, node_id, client, proto, day) DO UPDATE SET samples = T.samples + 1, name = COALESCE(NULLIF(excluded.name, ''), T.name),
          ops_sum = T.ops_sum + excluded.ops_sum, ops_n = T.ops_n + excluded.ops_n, in_sum = T.in_sum + excluded.in_sum, in_n = T.in_n + excluded.in_n,
          out_sum = T.out_sum + excluded.out_sum, out_n = T.out_n + excluded.out_n, lat_sum = T.lat_sum + excluded.lat_sum, lat_n = T.lat_n + excluded.lat_n`),
      upProtoHourly: conn.prepare(`INSERT INTO node_proto_hourly AS T (device_id, node_id, proto, hour, samples, ops_sum, ops_n, ops_max, lat_sum, lat_n, lat_max)
        VALUES (?,?,?,?,1,?,?,?,?,?,?)
        ON CONFLICT(device_id, node_id, proto, hour) DO UPDATE SET samples = T.samples + 1,
          ops_sum = T.ops_sum + excluded.ops_sum, ops_n = T.ops_n + excluded.ops_n, ops_max = CASE WHEN excluded.ops_max IS NULL THEN T.ops_max WHEN T.ops_max IS NULL OR excluded.ops_max > T.ops_max THEN excluded.ops_max ELSE T.ops_max END,
          lat_sum = T.lat_sum + excluded.lat_sum, lat_n = T.lat_n + excluded.lat_n, lat_max = CASE WHEN excluded.lat_max IS NULL THEN T.lat_max WHEN T.lat_max IS NULL OR excluded.lat_max > T.lat_max THEN excluded.lat_max ELSE T.lat_max END`),
      upProtoDaily: conn.prepare(`INSERT INTO node_proto_daily AS T (device_id, node_id, proto, day, samples, ops_sum, ops_n, ops_max, lat_sum, lat_n, lat_max)
        VALUES (?,?,?,?,1,?,?,?,?,?,?)
        ON CONFLICT(device_id, node_id, proto, day) DO UPDATE SET samples = T.samples + 1,
          ops_sum = T.ops_sum + excluded.ops_sum, ops_n = T.ops_n + excluded.ops_n, ops_max = CASE WHEN excluded.ops_max IS NULL THEN T.ops_max WHEN T.ops_max IS NULL OR excluded.ops_max > T.ops_max THEN excluded.ops_max ELSE T.ops_max END,
          lat_sum = T.lat_sum + excluded.lat_sum, lat_n = T.lat_n + excluded.lat_n, lat_max = CASE WHEN excluded.lat_max IS NULL THEN T.lat_max WHEN T.lat_max IS NULL OR excluded.lat_max > T.lat_max THEN excluded.lat_max ELSE T.lat_max END`),
      // 조회(v2.932) — 창 안 시간 요약을 클라이언트·프로토콜별로 합친다(GROUP BY 는 어차피 구간 스캔 — device_id,hour 인덱스).
      selClientHourly: conn.prepare(`SELECT node_id AS node, client, proto, MAX(name) AS name, SUM(samples) AS samples, SUM(ops_sum) AS ops_sum, SUM(ops_n) AS ops_n,
          SUM(in_sum) AS in_sum, SUM(in_n) AS in_n, SUM(out_sum) AS out_sum, SUM(out_n) AS out_n, SUM(lat_sum) AS lat_sum, SUM(lat_n) AS lat_n
        FROM node_client_hourly WHERE device_id = ? AND hour >= ? AND hour < ? GROUP BY node_id, client, proto LIMIT 20000`),
      selClientDaily: conn.prepare(`SELECT node_id AS node, client, proto, MAX(name) AS name, SUM(samples) AS samples, SUM(ops_sum) AS ops_sum, SUM(ops_n) AS ops_n,
          SUM(in_sum) AS in_sum, SUM(in_n) AS in_n, SUM(out_sum) AS out_sum, SUM(out_n) AS out_n, SUM(lat_sum) AS lat_sum, SUM(lat_n) AS lat_n
        FROM node_client_daily WHERE device_id = ? AND day >= ? AND day <= ? GROUP BY node_id, client, proto LIMIT 20000`),
      selClientLatestTs: conn.prepare('SELECT MAX(ts) AS t FROM node_client_sample WHERE device_id = ? AND node_id = ? AND ts >= ?'),
      selClientAt: conn.prepare('SELECT client, proto, name, ops, in_bps, out_bps, lat FROM node_client_sample WHERE device_id = ? AND node_id = ? AND ts = ? ORDER BY ops DESC LIMIT 200'),
      selProtoHourly: conn.prepare(`SELECT node_id AS node, proto, SUM(samples) AS samples, SUM(ops_sum) AS ops_sum, SUM(ops_n) AS ops_n, MAX(ops_max) AS ops_max, SUM(lat_sum) AS lat_sum, SUM(lat_n) AS lat_n, MAX(lat_max) AS lat_max
        FROM node_proto_hourly WHERE device_id = ? AND hour >= ? AND hour < ? GROUP BY node_id, proto LIMIT 5000`),
      selProtoDaily: conn.prepare(`SELECT node_id AS node, proto, SUM(samples) AS samples, SUM(ops_sum) AS ops_sum, SUM(ops_n) AS ops_n, MAX(ops_max) AS ops_max, SUM(lat_sum) AS lat_sum, SUM(lat_n) AS lat_n, MAX(lat_max) AS lat_max
        FROM node_proto_daily WHERE device_id = ? AND day >= ? AND day <= ? GROUP BY node_id, proto LIMIT 5000`),
      selClientOldestTs: conn.prepare('SELECT MIN(ts) AS t FROM node_client_sample WHERE device_id = ?'),
      selClientOldestHour: conn.prepare('SELECT MIN(hour) AS h FROM node_client_hourly WHERE device_id = ?'),
      pruneClient1: conn.prepare('DELETE FROM node_client_sample WHERE rowid IN (SELECT rowid FROM node_client_sample WHERE ts < ? LIMIT ?)'),
      pruneClient2: conn.prepare('DELETE FROM node_client_hourly WHERE rowid IN (SELECT rowid FROM node_client_hourly WHERE hour < ? LIMIT ?)'),
      pruneClient3: conn.prepare('DELETE FROM node_client_daily WHERE rowid IN (SELECT rowid FROM node_client_daily WHERE day < ? LIMIT ?)'),
      pruneProto1: conn.prepare('DELETE FROM node_proto_hourly WHERE rowid IN (SELECT rowid FROM node_proto_hourly WHERE hour < ? LIMIT ?)'),
      pruneProto2: conn.prepare('DELETE FROM node_proto_daily WHERE rowid IN (SELECT rowid FROM node_proto_daily WHERE day < ? LIMIT ?)'),
      pruneNodeHourly: conn.prepare('DELETE FROM node_load_hourly WHERE rowid IN (SELECT rowid FROM node_load_hourly WHERE hour < ? LIMIT ?)'),
      selNodeJobs: conn.prepare('SELECT ts, nodes, jobs FROM node_load_sample WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts LIMIT 5000'),
      // 가장 오래된 기록 — 집계 하나 · 장비 조건(PK·인덱스 앞부분)이라 인덱스 한 칸만 읽는다(perf-db '집계 하나일 때만 빠르다').
      selNodeOldestTs: conn.prepare('SELECT MIN(ts) AS t FROM node_load_sample WHERE device_id = ?'),
      selNodeOldestDay: conn.prepare('SELECT MIN(day) AS d FROM node_load_daily WHERE device_id = ?'),
      pruneNode1: conn.prepare('DELETE FROM node_load_history WHERE rowid IN (SELECT rowid FROM node_load_history WHERE ts < ? LIMIT ?)'),
      pruneNode2: conn.prepare('DELETE FROM node_load_sample WHERE rowid IN (SELECT rowid FROM node_load_sample WHERE ts < ? LIMIT ?)'),
      pruneNode3: conn.prepare('DELETE FROM node_load_daily WHERE rowid IN (SELECT rowid FROM node_load_daily WHERE day < ? LIMIT ?)'),
      nodeSel: new Map(),   // 묶음·종류별 조회 문장(처음 쓸 때 준비 — nodeLoadStmt)
    };
    lockRetry.ok();
    return _db;
  } catch (e) {
    if (lockRetry.onFail(e)) {
      try { conn?.close(); } catch { /* */ } // 다시 열 것이므로 이 핸들은 닫는다(fd 누수 방지)
      console.warn(`[storage-db] SQLite 잠금(${e.message}) — 30초 뒤 다시 엽니다(비활성으로 고정하지 않음)`);
      return null;
    }
    console.warn(`[storage-db] SQLite 비활성(${e.message}) — API 원문/시계열 DB 저장 없이 동작(최신 스냅샷만)`);
    _db = 'unavailable';
    return null;
  }
}

export async function dbAvailable() { return !!(await open()); }

/** 영역 수집 결과 일괄 저장 — 트랜잭션으로 묶어 fsync 1회(CLAUDE.md 대량 write 규칙). */
export async function saveAreaResults(deviceId, results) {
  const db = await open();
  if (!db) return false;
  const ts = Date.now();
  db.conn.exec('BEGIN');
  try {
    for (const r of results) {
      let json = null, truncated = 0, bytes = 0;
      if (r.ok && r.data !== undefined) {
        json = JSON.stringify(r.data);
        bytes = Buffer.byteLength(json);
        if (bytes > MAX_JSON_BYTES) { json = json.slice(0, MAX_JSON_BYTES); truncated = 1; } // 절단 명시
      }
      db.upLatest.run(deviceId, r.area, r.endpoint, ts, r.ok ? 1 : 0, bytes, truncated, json, r.error || null);
      db.insHist.run(deviceId, r.area, ts, r.ok ? 1 : 0, bytes, r.error || null);
    }
    db.conn.exec('COMMIT');
  } catch (e) { db.conn.exec('ROLLBACK'); throw e; }
  maybePrune(db);
  return true;
}

/**
 * prune 스로틀(CLAUDE.md 시계열 규칙 — 매 저장이 아니라 N회마다 1회).
 *
 * ⚠ **v2.531 결함 수정(D2)**: 예전에는 이 코드가 `saveAreaResults` 안에만 있었다. 그 함수는
 *   `areasCollector.js` 에서만 불리고 그것은 **중앙이 직접 수집하는 PowerScale/Isilon 전용**이다 —
 *   즉 Isilon 이 없거나 전부 엣지 위임인 법인에서는 **`capacity_history` 가 한 번도 정리되지
 *   않고 무한히 쌓였다**. 보존 기간을 설정으로 여는 마당에 집행이 안 되면 설정이 거짓말이 된다.
 *   이제 용량 적재 경로에서도 부른다.
 *
 * ⚠ `(++tick % N) === 0` 을 쓴다 — `% N === 1` 이나 `tick++ % N === 0` 은 **기동 첫 틱에 즉시 참**
 *   이라, 보존기간을 줄이고 재시작하면 첫 틱이 그 차액을 한 번에 지운다(v2.453 규칙).
 */
function maybePrune(db, every = 10) {
  if ((++_pruneTick % every) !== 0) return false;
  // v2.606(DB2606-02): 적재 경로(엣지 push 처리 중일 수 있다)에서는 기다리지 않는다 — 백그라운드 청크 정리(단일 비행).
  runPrune(db).catch((e) => console.warn(`[storage-db] 보존 정리 실패: ${e.message}`));
  return true;
}

// 진행 공유 — 더 늦은 경계(보존일이 더 짧다)로 도는 정리는 이른 경계 요청을 덮는다. 덮지 못하면 끝난 뒤 한 번 더 돈다.
const _pruneFlight = createPruneFlight({ covers: (run, next) => ['cut', 'dayCut', 'nodeCut', 'nodeHourCut', 'clientCut', 'clientHourCut', 'clientDayCut'].every((k) => (run[k] ?? 0) >= (next[k] ?? 0)) });

/**
 * 보존 정리 본체(v2.606 DB2606-02). api_history·capacity_history 는 청크(chunkedDelete), capacity_daily 는 장비 × 일 1행이라
 * 한 문장으로 둔다(audit2603c 허용 목록 사유). 반환: 지운 행 수·상한에 걸려 남았는지.
 * @returns {Promise<{apiHistory:number, capacityHistory:number, capacityDaily:number, done:boolean}>}
 */
function runPrune(db) {
  const { raw, daily, nodeRaw, nodeHourly, clientRaw, clientHourly, clientDaily } = keepDays();
  const now = Date.now();
  const key = { cut: now - raw * DAY_MS, dayCut: dayIndex(now) - daily, nodeCut: now - nodeRaw * DAY_MS,
    nodeHourCut: hourIndex(now) - nodeHourly * 24, clientCut: now - clientRaw * DAY_MS, clientHourCut: hourIndex(now) - clientHourly * 24, clientDayCut: dayIndex(now) - clientDaily };
  return _pruneFlight.run(key, async () => {
    const a = await chunkedDelete(db.prune1, [key.cut], { label: 'storage api_history' });
    const c = await chunkedDelete(db.prune2, [key.cut], { label: 'storage capacity_history' });
    const d = Number(db.prune3.run(key.dayCut)?.changes || 0);
    // v2.789: 하위 항목 일 롤업도 같은 보존일(청크 — 아래 prune4 주석).
    const r = await chunkedDelete(db.prune4, [key.dayCut], { label: 'storage resource_daily' });
    // v2.926: 노드 부하 — 원시·표본은 노드 원시 보존일, 일 롤업은 일 롤업 보존일(청크 — ts·day 단독 인덱스).
    const n1 = await chunkedDelete(db.pruneNode1, [key.nodeCut], { label: 'storage node_load_history' });
    const n2 = await chunkedDelete(db.pruneNode2, [key.nodeCut], { label: 'storage node_load_sample' });
    const n3 = await chunkedDelete(db.pruneNode3, [key.dayCut], { label: 'storage node_load_daily' });
    // v2.932: 노드 시간 요약 · 클라이언트(원시·시간·일) · 프로토콜(시간 = 클라이언트 시간 보존 · 일 = 클라이언트 일 보존).
    const n4 = await chunkedDelete(db.pruneNodeHourly, [key.nodeHourCut], { label: 'storage node_load_hourly' });
    const c1 = await chunkedDelete(db.pruneClient1, [key.clientCut], { label: 'storage node_client_sample' });
    const c2 = await chunkedDelete(db.pruneClient2, [key.clientHourCut], { label: 'storage node_client_hourly' });
    const c3 = await chunkedDelete(db.pruneClient3, [key.clientDayCut], { label: 'storage node_client_daily' });
    const p1 = await chunkedDelete(db.pruneProto1, [key.clientHourCut], { label: 'storage node_proto_hourly' });
    const p2 = await chunkedDelete(db.pruneProto2, [key.clientDayCut], { label: 'storage node_proto_daily' });
    return { apiHistory: a.deleted, capacityHistory: c.deleted, capacityDaily: d, resourceDaily: r.deleted,
      nodeLoadHistory: n1.deleted, nodeLoadSample: n2.deleted, nodeLoadDaily: n3.deleted, nodeLoadHourly: n4.deleted,
      nodeClientSample: c1.deleted, nodeClientHourly: c2.deleted, nodeClientDaily: c3.deleted, nodeProtoHourly: p1.deleted, nodeProtoDaily: p2.deleted,
      done: [a, c, r, n1, n2, n3, n4, c1, c2, c3, p1, p2].every((x) => x.done) };
  });
}

/** 강제 prune(설정 저장 직후 즉시 반영용 — 스로틀을 건너뛴다). 청크로 지우며 끝날 때까지 기다린다. */
export async function pruneNow() {
  const db = await open();
  if (!db) return false;
  await runPrune(db);
  return true;
}

/**
 * 적재해도 되는 용량 점인가(순수 — 테스트가 고정한다).
 *
 * ⚠ **v2.531 결함 수정(D1)**: 예전에는 `snap.ok` 만 봤다. 그런데 `ok` 는 '용량을 읽었다' 가
 *   **아니다** — `unitySsh.js` 는 `ok = (config==='ok' || capacity==='ok')`, `isilonSsh.js` 도
 *   같고, `vplex.js` 는 `ok = config==='ok'` 인데 용량 섹션이 **의도적으로 `skip`** 이다.
 *   그 경우 `snap.capacity` 는 `emptySnapshot` 의 초기값 `{totalBytes:0, usedBytes:0}` 그대로라
 *   **0 바이트 행**이 쌓였다. 증가량 화면에서 이 한 점은 `-106TB → +106TB` 라는 **거짓 급변**이
 *   된다(추이 차트에서도 0 으로 떨어지는 계단이 된다).
 *
 * 판정 기준은 **전체 용량이 유한한 양수**인가 하나다. VPLEX 처럼 자체 용량이 없는 가상화 계층은
 * 애초에 시계열에 들어갈 값이 없으므로 **행을 만들지 않는 것이 정직**하다(0 을 '용량 0' 이라
 * 기록하면 화면이 '0 TB 장비' 라고 말하게 된다).
 * @returns {{ok:boolean, reason?:string}}
 */
export function capacityPointEligible(snap) {
  if (!snap?.ok) return { ok: false, reason: 'collect-failed' };
  const t = Number(snap.capacity?.totalBytes);
  if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: 'no-capacity' };
  /*
   * ⚠ **일부 풀이 합계에서 빠진 주기는 적재하지 않는다**(v2.546, 사용자 선택 '적재 안 함').
   *
   * 다중 풀 장비에서 한 풀의 용량·사용량을 못 읽으면 그 주기만 **측정 기준이 달라진다**
   * (합계가 그 풀만큼 작다). 그대로 적재하면 증가량 화면에 그 날만 `-58TB → +58TB` 라는
   * **거짓 급변**이 찍힌다 — v2.534 가 VMAX 에서 겪은 '측정 기준이 바뀌면 이어 붙이지
   * 않는다' 와 같은 유형이고, 여기서는 하루 단위로 오락가락하므로 더 나쁘다.
   * 그 날은 '수집 없음'(`gapDays`)이 되는 편이 정직하다 — v2.530 '틀린 값은 빈 값보다 나쁘다'.
   *
   * ⚠ 화면 표시(사용률 %)는 **막지 않는다** — 제외 사실을 `capacityBasisNote` 가 밝힌다.
   *   막는 것은 **시계열 적재뿐**이다(v2.528 '막는 것은 주기 수집뿐' 과 같은 경계 감각).
   * ⚠ 구버전 엣지는 이 필드를 보내지 않으므로 예전처럼 적재된다(조용히 실패하지는 않는다).
   */
  const ex = snap.extra || {};
  const skipped = (Number(ex.poolsUnreadable) || 0) + (Number(ex.poolsUsedUnreadable) || 0);
  if (skipped > 0) return { ok: false, reason: 'partial-pools' };
  return { ok: true };
}

/**
 * 용량 시계열 1점 — 정규화 스냅샷에서. 원시 1행 + **일 롤업 upsert** 를 함께 한다.
 * 적재하지 않은 경우 사유를 돌려준다(조용히 버리지 않는다 — 호출부가 로그/화면에 쓸 수 있게).
 * @returns {Promise<{saved:boolean, reason?:string, day?:number}>}
 */
export async function saveCapacityPoint(snap) {
  const db = await open();
  if (!db) return { saved: false, reason: 'db-unavailable' };
  const gate = capacityPointEligible(snap);
  if (!gate.ok) return { saved: false, reason: gate.reason };

  const ts = Number(snap.collectedAt) || Date.now();
  const total = Number(snap.capacity.totalBytes);
  /*
   * ⚠⚠ **'사용량을 못 읽었다'(null) 를 0 으로 적재하지 말 것**(v2.561 에 고친 실제 결함).
   *
   * 예전에는 `Number.isFinite(Number(v)) ? Number(v) : null` 이었는데 `Number(null) === 0` ·
   * `Number.isFinite(0) === true` 라 **null 이 0 으로 적재됐다**. 도달 경로가 실재한다 —
   * `unitySsh.js` 는 풀 목록을 못 읽고 `general/system show` 만 성공하면
   * `{ totalBytes: <읽음>, usedBytes: null }` 을 정직하게 내보내고(`parseSystemSpace` 는
   * 'Total space' 만 있어도 레코드를 돌려준다), `capacityPointEligible` 은 **total 만** 검사한다.
   *
   * 실측 영향(v2.561 재현 — 정상 7일 뒤 그 한 주기만 usedBytes null):
   *   현재 사용량 `27.60T → 0.00T` · 사용률 `23.5% → 0%` ·
   *   남은 용량 `89.94T → 117.54T`(**27.6T 과다** — 없는 공간에 LUN 을 만들게 된다) ·
   *   증가량[1d] **`-27.60T`**(하루에 27.6TB 가 줄었다는 거짓 급변)
   * 그리고 결정적으로 `growth.js:206 unknownUsed`(= 사용량 미상 장비 수)가 **0** 이 되어,
   * 화면이 이미 갖고 있던 정직 안내 — "**사용량을 읽지 못한 장비 N대**가 합계에서 빠졌습니다 —
   * 0 으로 채우지 않았습니다" (`StorageGrowthTool.jsx:149`) — 가 **무력화됐다**.
   * 즉 화면은 '0 으로 채우지 않았다' 고 약속하면서 0 을 보여주고 있었다.
   */
  const used = numOrNull(snap.capacity?.usedBytes);
  const hT = numOrNull(snap.media?.hdd?.totalBytes); const hU = numOrNull(snap.media?.hdd?.usedBytes);
  const sT = numOrNull(snap.media?.ssd?.totalBytes); const sU = numOrNull(snap.media?.ssd?.usedBytes);

  if (db.hasCap.get(snap.deviceId, ts)) return { saved: false, duplicate: true, reason: 'duplicate' };
  db.insCap.run(snap.deviceId, ts, total, used, hT, hU, sT, sU);
  const day = dayIndex(ts);
  db.upDaily.run(snap.deviceId, day, ts, total, used, hT, hU, sT, sU, used);
  const resources = saveResourceRows(db, snap, day, ts);
  maybePrune(db);
  return { saved: true, day, ...(resources ? { resources } : {}) };
}

/**
 * v2.789 — 하위 항목(LUN·파일시스템) 일 롤업 적재. 장비 점이 적재될 때만 부른다(같은 중복·적격 가드를 공유한다).
 * ⚠ 한 스냅샷에 수십~수백 행이므로 **트랜잭션 하나**로 묶는다(CLAUDE.md '대량 SQLite write 는 트랜잭션' — 무트랜잭션
 *   6천 행 25초 블로킹 사고). 안에 await 가 없어 다른 트랜잭션과 겹치지 않는다.
 * ⚠ 크기를 못 읽은 항목은 행을 만들지 않는다 · 사용량을 못 읽으면 null 로 둔다(0 이 아니다).
 * @returns {number} 적재한 행 수
 */
function saveResourceRows(db, snap, day, ts) {
  const raw = snap.extra?.resources;
  if (!Array.isArray(raw) || !raw.length) return 0;
  const { list } = normalizeResourceList(raw);
  const rows = list.filter((r) => r.totalBytes != null);
  if (!rows.length) return 0;
  db.conn.exec('BEGIN');
  try {
    for (const r of rows) {
      db.upRes.run(snap.deviceId, resourceKey(r), day, ts, r.kind, r.name, r.pool, r.totalBytes, r.usedBytes);
    }
    db.conn.exec('COMMIT');
  } catch (e) {
    try { db.conn.exec('ROLLBACK'); } catch { /* */ }
    console.warn(`[storage-db] 하위 항목 일 롤업 적재 실패(${snap.deviceId}): ${e.message}`);
    return 0;
  }
  return rows.length;
}

/**
 * v2.789 — 하위 항목 일 롤업 조회 [fromDay, toDay]. **일 구간 조각**(기본 31일)으로 나눠 읽고 조각 사이에 양보한다
 * (요청 경로의 큰 조회 — perf-db 규약 '조각 + 시간 기준 양보'). deviceIds 가 있으면 그 장비만 돌려준다.
 * @returns {Promise<{device_id:string,rkey:string,day:number,kind:string,name:string,pool:string|null,total_bytes:number,used_bytes:number|null}[]>}
 */
export async function resourceDailyRange(fromDay, toDay, { deviceIds = null, sliceDays = 31 } = {}) {
  const db = await open();
  if (!db) return [];
  const want = deviceIds ? new Set(deviceIds) : null;
  const out = [];
  const yieldNow = createYielder();
  for (let lo = fromDay; lo <= toDay; lo += sliceDays) {
    const hi = Math.min(toDay + 1, lo + sliceDays);
    for (const r of db.selResRange.all(lo, hi)) if (!want || want.has(r.device_id)) out.push(r);
    await yieldNow();
  }
  return out;
}

/**
 * 일 롤업 조회 — 증가량 계산의 원천.
 * @param {string|null} deviceId null 이면 전 장비(장비별로 묶어 돌려준다)
 * @param {number} sinceDay 일 인덱스(포함)
 */
/**
 * v2.791 — 일 롤업 구간 읽기([fromDay, toDay]). 보고표가 '전체 누적'(최대 5년)을 읽을 때 한 번의 동기 `.all()` 로 수십만 행을 만들지 않게
 * `sliceDays` 조각으로 읽고 조각 사이에 시간 기준으로 양보한다(CLAUDE.md '요청 경로의 큰 집계는 조각 + 시간 기준 양보' — resourceDailyRange 와 같은 모양).
 */
export async function dailyRange(fromDay, toDay, { deviceIds = null, sliceDays = 31 } = {}) {
  const db = await open();
  if (!db) return [];
  const want = deviceIds ? new Set(deviceIds) : null;
  const out = [];
  const yieldNow = createYielder();
  for (let lo = fromDay; lo <= toDay; lo += sliceDays) {
    const hi = Math.min(toDay + 1, lo + sliceDays);
    for (const r of db.selDailyRange.all(lo, hi)) if (!want || want.has(r.device_id)) out.push(r);
    await yieldNow();
  }
  return out;
}
export async function dailySeries(deviceId, sinceDay) {
  const db = await open();
  if (!db) return [];
  return deviceId ? db.selDaily.all(deviceId, sinceDay) : db.selDailyAll.all(sinceDay);
}

/**
 * 장비별 전체 이력 범위 — `{deviceId: {firstDay, lastDay, observed}}`.
 * 조회 구간이 잘라 낸 값이 아니라 **그 장비가 실제로 가진 이력**이다.
 */
export async function dailySpans() {
  const db = await open();
  if (!db) return {};
  const out = {};
  for (const r of db.selDailySpan.all()) {
    out[r.device_id] = { firstDay: r.first_day, lastDay: r.last_day, observed: r.observed };
  }
  return out;
}

/** 보존 설정의 현재 실효값(화면이 '어디서 온 값인지' 를 밝히는 데 쓴다). */
export function effectiveKeepDays() { return keepDays(); }

export async function areaSummary(deviceId) {
  const db = await open();
  return db ? db.selAreas.all(deviceId) : [];
}
export async function areaJson(deviceId, endpoint) {
  const db = await open();
  return db ? (db.selOne.get(deviceId, endpoint) || null) : null;
}
/**
 * 용량 시계열 조회. bucketMs>0 이면 시간 버킷 평균으로 다운샘플(장기 구간 — 위 selCapBucket
 * 주석), 0/미지정이면 raw(단기 구간·기존 호출부 호환).
 */
export async function capacityHistory(deviceId, sinceMs, bucketMs = 0) {
  const db = await open();
  if (!db) return [];
  const b = Math.floor(Number(bucketMs) || 0);
  if (b > 0) return db.selCapBucket.all(b, b, deviceId, sinceMs, b);
  return db.selCap.all(deviceId, sinceMs);
}
/** 장비 한 개의 기본 신선도 한계 — 기본 수집 주기(1시간, storage/intervals.js)의 2배. */
export const CAPACITY_CARRY_DEFAULT_MS = 2 * 3_600_000;
/** v2.681(R2D-01): 등록부를 모르는 호출부에서 마지막 행 + 신선도 한계 뒤로 몇 한계 동안 더 '빠진 장비' 로 밝힐지. 그 뒤는 퇴역으로 본다. */
export const RETIRE_GRACE_CARRIES = 3;
/** 유예의 하한 — 하루가 안 된 수집 중단은 '퇴역' 이 아니라 '지금 수집이 멈춘 장비' 로 본다(일 단위 운영 주기 한 번). */
export const RETIRE_GRACE_MIN_MS = 24 * 3_600_000;
const CAP_ALL_POINT_MAX = 2000;

/**
 * (순수) 장비별 버킷 평균 행 → 전체 합계 점. v2.600 DB2600-01.
 *
 * 각 버킷에서 장비마다 **그 시각까지의 마지막 관측**(신선도 한계 안)을 끌어와 더한다(carry-forward).
 * 한계를 넘긴 장비는 그 점에서 빠지고, 빠진 대수는 `missing`(= 그 점에서 기대하는 장비 수 − 그 점의 장비 수.
 * 기대 장비는 v2.681 R2D-01 부터 버킷마다 판정한다 — 함수 본문 주석)으로 밝힌다 — 부분 합을 전체처럼 그리지 않게 화면이 경고한다.
 * 사용량 규칙은 v2.594 그대로: 합에 든 장비 중 하나라도 사용량을 못 읽었으면 그 점 사용량은 null.
 *
 * @param {Array<{ts:number, device_id:string, total_bytes:number, used_bytes:?number,
 *   hdd_total:?number, hdd_used:?number, ssd_total:?number, ssd_used:?number}>} rows ts 오름차순
 * @param {{sinceMs:number, nowMs:number, bucketMs:number, staleMs?:number,
 *   staleByDevice?:Map<string,number>|object}} opts
 */
export function sumCapacityBuckets(rows, { sinceMs, nowMs, bucketMs, staleMs = CAPACITY_CARRY_DEFAULT_MS, staleByDevice = null, knownIds = null } = {}) {
  const b = Math.max(60_000, Number(bucketMs) || 3_600_000);
  const staleOf = (id) => {
    const v = staleByDevice instanceof Map ? staleByDevice.get(id) : staleByDevice?.[id];
    return Number.isFinite(v) && v > 0 ? v : staleMs;
  };
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.device_id != null && Number.isFinite(Number(r.ts))) : [];
  const expected = new Set(list.map((r) => String(r.device_id)));
  // v2.681(R2D-01): '기대 장비' 는 버킷마다 다시 판정한다. 예전에는 조회 행에 한 번이라도 나온 장비 전부라
  // 퇴역(등록 해제·교체)한 장비 하나가 마지막 행 이후 **모든 버킷**을 missing ≥ 1 로 만들었고, 경영 보기 스파크라인이
  // 그 시점부터 통째로 사라졌다(재현: 90일 · 10일째 퇴역 → 60점 중 53점 partial). 신규 장비도 첫 행 이전 구간을 partial 로 만들었다.
  //   · 첫 행 이전에는 기대하지 않는다(그때 없던 장비다).
  //   · knownIds(현재 등록·사용 중 장비 id)가 주어지면: 그 안의 장비는 첫 행 이후 계속 기대한다(지금 수집이 멈춘 장비는 계속 missing).
  //     그 밖의 장비(퇴역)는 마지막 행 + 신선도 한계까지만 — 그 뒤는 '없어진 장비' 다.
  //   · knownIds 가 없으면: 마지막 행 + 신선도 한계 + max(한계 × RETIRE_GRACE_CARRIES, 24시간) 까지 기대한다 — 수집이 멈춘 직후 몇 주기는
  //     missing 으로 밝히고, 그 뒤는 퇴역으로 본다(등록부를 모르는 호출부에서 영구 소멸과 일시 누락을 가르는 유일한 근거가 시간이다).
  //   기대에서 빠진 장비 수는 retiredDevices 로 밝힌다(조용히 빼지 않는다).
  const known = knownIds == null ? null : new Set([...(knownIds instanceof Set ? knownIds : Array.isArray(knownIds) ? knownIds : [])].map(String));
  const span = new Map();   // device_id → {first, last}
  for (const r of list) {
    const id = String(r.device_id); const ts = Number(r.ts);
    const s = span.get(id);
    if (!s) span.set(id, { first: ts, last: ts });
    else { if (ts < s.first) s.first = ts; if (ts > s.last) s.last = ts; }
  }
  const expectUntil = (id) => {
    const s = span.get(id);
    if (known) return known.has(id) ? Infinity : s.last + staleOf(id);
    return s.last + staleOf(id) + Math.max(staleOf(id) * RETIRE_GRACE_CARRIES, RETIRE_GRACE_MIN_MS);
  };
  const untilOf = new Map([...span.keys()].map((id) => [id, expectUntil(id)]));
  const first = Math.floor(Number(sinceMs) / b) * b;
  const lastBucket = Math.floor(Number(nowMs) / b) * b;
  let grid = [];
  for (let t = first; t <= lastBucket; t += b) grid.push(t);
  if (grid.length > CAP_ALL_POINT_MAX) grid = grid.slice(-CAP_ALL_POINT_MAX);
  const latest = new Map();   // device_id → 마지막으로 본 버킷 행
  const out = [];
  let i = 0;
  const addNull = (acc, v) => (v == null ? acc : (acc ?? 0) + Number(v));
  for (const t of grid) {
    while (i < list.length && Number(list[i].ts) <= t) { latest.set(String(list[i].device_id), list[i]); i += 1; }
    let devices = 0; let carried = 0; let usedUnknown = 0;
    let total = null; let used = 0; let hddT = null; let hddU = 0; let hddMiss = false; let ssdT = null; let ssdU = 0; let ssdMiss = false;
    let hddAny = false; let ssdAny = false;
    for (const [id, r] of latest) {
      if (t - Number(r.ts) > staleOf(id)) continue;
      devices += 1;
      if (Number(r.ts) !== t) carried += 1;
      total = addNull(total, r.total_bytes);
      if (r.used_bytes == null) usedUnknown += 1; else used += Number(r.used_bytes);
      if (r.hdd_total != null) { hddT = addNull(hddT, r.hdd_total); if (r.hdd_used == null) hddMiss = true; }
      if (r.hdd_used != null) { hddU += Number(r.hdd_used); hddAny = true; }
      if (r.ssd_total != null) { ssdT = addNull(ssdT, r.ssd_total); if (r.ssd_used == null) ssdMiss = true; }
      if (r.ssd_used != null) { ssdU += Number(r.ssd_used); ssdAny = true; }
    }
    if (!devices) continue;
    let expNow = 0;
    for (const [id, sp] of span) if (t >= sp.first && t <= untilOf.get(id)) expNow += 1;
    out.push({
      ts: t, total_bytes: total,
      used_bytes: usedUnknown ? null : used,
      hdd_total: hddT, hdd_used: hddMiss || !hddAny ? null : hddU,
      ssd_total: ssdT, ssd_used: ssdMiss || !ssdAny ? null : ssdU,
      devices, carried, used_unknown: usedUnknown,
      missing: Math.max(0, expNow - devices),
    });
  }
  const endT = grid.length ? grid[grid.length - 1] : Number(nowMs);
  let retired = 0;
  for (const id of span.keys()) if (untilOf.get(id) < endT) retired += 1;
  return { points: out, expectedDevices: expected.size, retiredDevices: retired, truncated: false };
}

/**
 * 전체 장비 합산 용량 시계열(v2.380 · v2.600 carry-forward) — 목록 화면 통합 추이.
 * 신선도 한계만큼 앞에서부터 읽어 첫 점에도 이전 관측이 이어지게 한다.
 * 반환은 점 배열이고 배열에 `expectedDevices`·`truncated` 를 속성으로 붙인다(기존 호출부 호환).
 */
/** 합계 추이 한 번이 읽는 (버킷, 장비) 행 상한 — 예전 한 문장 판의 LIMIT 과 같은 값이다(넘으면 `truncated`). */
const CAP_ALL_ROWS_MAX = 400000;
/** 조각 목표 폭 — 버킷 정배수로 맞춘다(v2.693 SAN `sliceBounds` 와 같은 6시간). */
const CAP_ALL_SLICE_TARGET_MS = 6 * 3_600_000;

export async function capacityHistoryAll(sinceMs, bucketMs, opts = {}) {
  const db = await open();
  if (!db) return [];
  const b = Math.max(60_000, Number(bucketMs) || 3_600_000);
  const staleMs = Number.isFinite(opts.staleMs) && opts.staleMs > 0 ? opts.staleMs : CAPACITY_CARRY_DEFAULT_MS;
  const sb = opts.staleByDevice;
  const maxStale = Math.max(staleMs, ...(sb instanceof Map ? [...sb.values()] : Object.values(sb || {})).filter((v) => Number.isFinite(v)));
  const since = Number(sinceMs) || 0;
  const nowMs = Number(opts.nowMs) || Date.now();
  try {
    /*
     * v2.743(감사 DB-01): 예전에는 `ts >= since − maxStale` 전체를 한 문장으로 GROUP BY 하고 합산까지 양보 없이 이어 달려,
     *   90일·400일을 고르면 그 시간 동안 이벤트 루프가 멈췄다(CLAUDE.md v2.672·v2.693 '요청 경로의 큰 집계 SQL 은 시간 조각 + 양보').
     *   이제 버킷 정배수 조각([lo, hi))으로 읽고 조각 사이에 시간 기준으로 양보한다(createYielder). 첫 조각의 시작은 예전과 같은
     *   `since − maxStale`(버킷 경계가 아닐 수 있다 — 예전 문장도 거기서 시작했다)이고 끝은 첫 버킷 경계 + 조각 폭이다.
     *   마지막 조각은 위가 열려 있다(지금 이후 시각의 표본도 예전처럼 읽는다). 상한(40만 행)은 앞에서부터 채운다 — 예전과 같다.
     * ⚠ 조각 경계를 버킷 정배수에서 떼지 말 것 — 한 (버킷, 장비) 묶음이 두 조각에 나뉘면 AVG 가 두 행이 되어 결과가 달라진다.
     */
    const width = Math.max(b, Math.floor(CAP_ALL_SLICE_TARGET_MS / b) * b);
    const yielder = createYielder(Number.isFinite(opts.yieldMs) && opts.yieldMs > 0 ? opts.yieldMs : 15);
    const rows = [];
    let lo = since - maxStale;
    // 첫 표본이 그보다 늦으면 그 버킷 경계부터 — 그 사이에는 행이 없으므로 결과가 같다.
    const firstTs = numOrNull(db.selCapMinTsFrom.get(lo)?.t);
    if (firstTs == null) lo = Math.max(lo, nowMs);   // 행이 하나도 없다 — 열린 마지막 조각 한 번만 묻는다
    else lo = Math.max(lo, Math.floor(firstTs / b) * b);
    let hi = Math.floor(lo / b) * b + width;
    while (hi <= nowMs && rows.length < CAP_ALL_ROWS_MAX) {
      pushAll(rows, db.selCapDevBucketSlice.all(b, b, lo, hi, b, CAP_ALL_ROWS_MAX - rows.length));
      lo = hi; hi += width;
      await yielder();
    }
    if (rows.length < CAP_ALL_ROWS_MAX) pushAll(rows, db.selCapDevBucketTail.all(b, b, lo, b, CAP_ALL_ROWS_MAX - rows.length));
    await yielder();
    const r = sumCapacityBuckets(rows, { sinceMs: since, nowMs, bucketMs: b, staleMs, staleByDevice: sb, knownIds: opts.knownIds ?? null });
    const pts = r.points;
    pts.expectedDevices = r.expectedDevices;
    pts.retiredDevices = r.retiredDevices;
    pts.truncated = rows.length >= CAP_ALL_ROWS_MAX;
    return pts;
  } catch (e) { console.warn(`[storage-db] capacityHistoryAll 실패: ${e.message}`); return []; }
}

/* ── 측정 기준 변경에 따른 이력 재시작(v2.534) ────────────────────────────────
 *
 * 왜 필요한가: v2.533 까지 VMAX 는 `physicalCapacity`(used == total)로 사용량을 적재해
 * **모든 행이 100%** 였다. v2.534 가 `system_capacity.usable_used_tb`(데이터 감축 후 실제
 * 기록량)로 바꾸면 그 장비의 사용량이 절반 이하로 떨어진다 — 그대로 두면 증가량 화면에
 * 전환일 하루치 **−1.5PB 짜리 거짓 '감소'** 가 찍힌다(사용자 선택: 해당 장비 이력만 삭제).
 *
 * ⚠ 삭제는 되돌릴 수 없다. 그래서 ① 대상 장비 id 를 호출부가 **명시**해야 하고
 * ② `storage_meta` 마커로 **1회만** 실행되며 ③ 언제·왜·몇 행을 지웠는지 남겨 화면이
 * '측정 기준 변경으로 이력을 재시작했습니다' 라고 말할 수 있게 한다(조용한 삭제 금지).
 */
const RESET_KEY = (id) => `capacity_reset:${id}`;

/**
 * 장비들의 용량 이력(원시 + 일 롤업)을 지우고 재시작 사실을 기록한다.
 * @param {string[]} deviceIds
 * @param {{reason:string, once?:string, at?:number}} opts
 *   once - 이 키가 이미 있으면 **아무 것도 하지 않는다**(1회성 마이그레이션용)
 * @returns {Promise<{ran:boolean, devices:number, rows:number}>}
 */
export async function resetCapacityHistory(deviceIds, { reason = '측정 기준 변경', once = null, at = Date.now() } = {}) {
  const db = await open();
  if (!db) return { ran: false, devices: 0, rows: 0 };
  if (once) {
    const done = db.metaGet.get(`migration:${once}`);
    if (done) return { ran: false, devices: 0, rows: 0 };
  }
  let rows = 0; let devices = 0;
  const ids = [...new Set((deviceIds || []).map((x) => String(x || '')).filter(Boolean))];
  db.conn.exec('BEGIN');
  try {
    for (const id of ids) {
      const a = db.delCapDev.run(id);
      const b = db.delDailyDev.run(id);
      const c = db.delResDev.run(id);   // v2.789 — 하위 항목 이력도 같은 기준 재시작
      const n = Number(a?.changes || 0) + Number(b?.changes || 0) + Number(c?.changes || 0);
      rows += n;
      if (n > 0) devices += 1;
      // 지운 행이 0 이어도 기록한다 — '새로 등록된 장비' 와 '기준이 바뀐 장비' 는 다르다.
      db.metaSet.run(RESET_KEY(id), JSON.stringify({ at, reason, rows: n }));
    }
    if (once) db.metaSet.run(`migration:${once}`, JSON.stringify({ at, devices: ids.length, rows }));
    db.conn.exec('COMMIT');
  } catch (e) {
    try { db.conn.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return { ran: true, devices, rows };
}

/**
 * 장비별 '이력 재시작' 기록 — 증가량 화면이 '관측 N일' 이 왜 짧은지 말할 수 있게 한다.
 * @returns {Promise<Record<string,{at:number, reason:string, rows:number}>>}
 */
/**
 * **0 바이트 용량 행 제거** — 1회(v2.541).
 *
 * 왜 필요한가(사용자 신고 2026-09-17, Unity OC2-unity-03): 수집이 SSH 인증 실패로 전량
 * 실패하는 장비인데 **용량 추이 차트가 0.0 TB 로 그려지고 있었다**. `emptySnapshot` 의
 * 초기값이 `{totalBytes:0, usedBytes:0}` 이라 실패 스냅샷이 그대로 적재되면 그렇게 된다.
 * v2.531 의 `capacityPointEligible()` 이 **지금은** 그것을 막지만(전체 용량이 유한한 양수일
 * 때만 적재), 그 가드가 배포되기 전에 쌓인 행은 DB 에 그대로 남아 있다.
 *
 * ⚠ 남겨 두면 증가량 화면에서 이 한 점이 `−106TB → +106TB` 라는 **거짓 급변**이 되고
 * (CLAUDE.md '감소(−)를 0 으로 깎지 않는다' 때문에 그대로 표시된다), 상세 화면에서는
 * **'용량 0 TB 장비'** 라고 말하게 된다.
 *
 * ⚠ **장비의 이력을 통째로 지우지 않는다** — `total_bytes` 가 없거나 0 이하인 **그 행만**
 * 지운다. 유효한 값이 섞여 있는 장비는 그 값을 잃지 않는다(`resetCapacityHistory` 와
 * 의도적으로 다르다. 그쪽은 '측정 기준이 바뀌어 옛 값이 뜻을 잃은' 경우다).
 *
 * ⚠ **조용히 지우지 않는다** — 행을 잃은 장비마다 `capacity_reset:<id>` 를 남겨 증가량
 * 화면이 '이력 정리' 배지를 띄운다(없으면 '관측 1일' 을 수집 장애로 오해한다).
 *
 * @returns {Promise<{ran:boolean, devices:number, rows:number}>}
 */
/**
 * **테스트 전용** — 적재 가드(`capacityPointEligible`)를 우회해 원시 행을 심는다.
 * v2.531 가드 이전 배포가 남긴 0 바이트 행을 재현하기 위한 것이다(제품 경로에서 쓰지 말 것 —
 * 그 가드가 존재하는 이유가 바로 이런 행을 막는 것이다).
 */
export async function _insertRawCapacityForTest(deviceId, ts, totalBytes, usedBytes) {
  const db = await open();
  if (!db) return false;
  db.insCap.run(deviceId, ts, totalBytes, usedBytes, null, null, null, null);
  db.upDaily.run(deviceId, dayIndex(ts), ts, totalBytes, usedBytes, null, null, null, null, usedBytes);
  return true;
}

export async function purgeZeroCapacityRows({ once = null, reason = '0 바이트 용량 행 제거', at = Date.now() } = {}) {
  const db = await open();
  if (!db) return { ran: false, devices: 0, rows: 0 };
  if (once) {
    const done = db.metaGet.get(`migration:${once}`);
    if (done) return { ran: false, devices: 0, rows: 0 };
  }
  const BAD = 'total_bytes IS NULL OR total_bytes <= 0';
  let rows = 0; let devices = 0;
  db.conn.exec('BEGIN');
  try {
    // 어느 장비가 몇 행을 잃는지 **먼저** 센다(지운 뒤에는 알 수 없다 — 배지의 근거다).
    const per = new Map();
    for (const t of ['capacity_history', 'capacity_daily']) {
      const q = db.conn.prepare(`SELECT device_id AS id, COUNT(*) AS n FROM ${t} WHERE ${BAD} GROUP BY device_id`);
      for (const r of q.all()) per.set(String(r.id), (per.get(String(r.id)) || 0) + Number(r.n || 0));
    }
    for (const t of ['capacity_history', 'capacity_daily']) db.conn.prepare(`DELETE FROM ${t} WHERE ${BAD}`).run();
    for (const [id, n] of per) {
      if (!n) continue;
      rows += n; devices += 1;
      db.metaSet.run(RESET_KEY(id), JSON.stringify({ at, reason, rows: n, kind: 'zero-rows' }));
    }
    if (once) db.metaSet.run(`migration:${once}`, JSON.stringify({ at, devices, rows }));
    db.conn.exec('COMMIT');
  } catch (e) {
    try { db.conn.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return { ran: true, devices, rows };
}

export async function capacityResets() {
  const db = await open();
  if (!db) return {};
  const out = {};
  try {
    const rows = db.conn.prepare("SELECT k, v FROM storage_meta WHERE k LIKE 'capacity_reset:%'").all();
    for (const r of rows) {
      const id = String(r.k).slice('capacity_reset:'.length);
      try { out[id] = JSON.parse(r.v); } catch { /* 손상 행은 건너뛴다 */ }
    }
  } catch { /* 테이블 없음(구 DB) */ }
  return out;
}

/* ── v2.926 노드 부하 시계열 ──────────────────────────────────────────────
 * 규칙은 storage/nodeLoad.js(순수)가 갖고 여기서는 적재·조회만 한다. 호출 지점은 용량 점과 같은 두 곳 — 중앙 직접 수집
 * (poller.collectOneInner)과 엣지 push 수신(storageEdge — 같은 collectedAt 재전송은 그 앞에서 걸러진다). 던지지 않는다.
 */
/**
 * 노드 부하 1점(스냅샷 1개) — 표본 행 + 노드 원시 행 + 노드 일 롤업을 **트랜잭션 하나**로(최대 64 노드 × 3문장).
 * 같은 (장비, 시각) 표본이 이미 있으면 아무것도 쓰지 않는다(일 롤업 이중 집계 방지 — PK 가 판정한다).
 * @returns {Promise<{saved:boolean, reason?:string, duplicate?:boolean, nodes?:number}>}
 */
export async function saveNodeLoadPoint(snap) {
  const r = nodeLoadRowsOf(snap);
  if (!r.ok) return { saved: false, reason: r.reason };
  const db = await open();
  if (!db) return { saved: false, reason: 'db-unavailable' };
  return writeNodeLoad(db, r.deviceId, r.ts, r.nodes, r.jobs, [], []);
}
/**
 * v2.932 — 5분 표본(경량 폴러 · 엣지 표본 고리) 1개. 정제(sampleRowsOf)를 거쳐 노드 행 + 클라이언트 + 프로토콜을 **트랜잭션 하나**로.
 * 같은 (장비, ts) 가 이미 있으면 아무것도 쓰지 않는다(엣지 재전송 · 1시간 스냅샷과 같은 시각도 같은 규칙).
 */
export async function saveNodeLoadSample(deviceId, sample) {
  const r = sampleRowsOf(deviceId, sample);
  if (!r.ok) return { saved: false, reason: r.reason };
  const db = await open();
  if (!db) return { saved: false, reason: 'db-unavailable' };
  return writeNodeLoad(db, r.deviceId, r.ts, r.nodes, null, r.clients, r.protos);
}
export const hourIndex = (ts) => Math.floor(Number(ts) / 3_600_000);
function writeNodeLoad(db, deviceId, ts, nodes, jobs, clients, protos) {
  const day = dayIndex(ts); const hour = hourIndex(ts);
  db.conn.exec('BEGIN');
  try {
    const ins = db.insNodeSample.run(deviceId, ts, nodes.length, jobs ? JSON.stringify(jobs) : null);
    if (!Number(ins?.changes)) { db.conn.exec('ROLLBACK'); return { saved: false, duplicate: true, reason: 'duplicate' }; }
    for (const n of nodes) {
      db.insNodeRaw.run(deviceId, ts, n.id, n.in, n.out, n.din, n.dout, n.cpu, n.ops, n.lat, n.busy, n.iops);
      const args = [];
      for (const m of NODE_LOAD_METRICS) { const v = n[m.key]; args.push(v ?? 0, v == null ? 0 : 1, v ?? null); }
      db.upNodeDaily.run(deviceId, n.id, day, ...args);
      db.upNodeHourly.run(deviceId, n.id, hour, ...args);
    }
    for (const c of clients) {
      db.insClientRaw.run(deviceId, ts, c.node, c.ip, c.proto || '', c.name || null, c.ops, c.in, c.out, c.lat);
      const a = [c.ops ?? 0, c.ops == null ? 0 : 1, c.in ?? 0, c.in == null ? 0 : 1, c.out ?? 0, c.out == null ? 0 : 1, c.lat ?? 0, c.lat == null ? 0 : 1];
      db.upClientHourly.run(deviceId, c.node, c.ip, c.proto || '', hour, c.name || '', ...a);
      db.upClientDaily.run(deviceId, c.node, c.ip, c.proto || '', day, c.name || '', ...a);
    }
    for (const p of protos) {
      const a = [p.ops ?? 0, p.ops == null ? 0 : 1, p.ops ?? null, p.lat ?? 0, p.lat == null ? 0 : 1, p.lat ?? null];
      db.upProtoHourly.run(deviceId, p.node, p.proto, hour, ...a);
      db.upProtoDaily.run(deviceId, p.node, p.proto, day, ...a);
    }
    db.conn.exec('COMMIT');
  } catch (e) {
    try { db.conn.exec('ROLLBACK'); } catch { /* */ }
    console.warn(`[storage-db] 노드 부하 적재 실패(${deviceId}): ${e.message}`);
    return { saved: false, reason: 'db-error' };
  }
  maybePrune(db);
  return { saved: true, nodes: nodes.length, clients: clients.length, day };
}

/** 묶음·종류별 조회 문장(지표 열 이름은 NODE_LOAD_METRICS 의 고정 값 — 사용자 입력이 아니다). */
function nodeLoadStmt(db, group, kind) {
  const key = `${group}|${kind}`;
  if (db.nodeSel.has(key)) return db.nodeSel.get(key);
  const ms = (NODE_LOAD_GROUPS[group] || []).map((k) => METRIC_BY_KEY.get(k));
  let sql;
  if (kind === 'raw') {
    sql = `SELECT node_id AS node, ts, ${ms.map((m) => `${m.col} AS v_${m.key}`).join(', ')}
      FROM node_load_history WHERE device_id = ? AND ts >= ? AND ts < ? ORDER BY ts, node_id LIMIT ?`;
  } else if (kind === 'bucket') {
    // 버킷은 포탈 날짜 경계(오프셋)에 맞춘다 — CAST 필수(node:sqlite 는 수를 REAL 로 묶는다 — selCapBucket 주석).
    sql = `SELECT node_id AS node, CAST(CAST((ts + ?) / ? AS INTEGER) * ? - ? AS INTEGER) AS b,
        ${ms.map((m) => `AVG(${m.col}) AS v_${m.key}, MAX(${m.col}) AS x_${m.key}, COUNT(${m.col}) AS n_${m.key}`).join(', ')}
      FROM node_load_history WHERE device_id = ? AND ts >= ? AND ts < ?
      GROUP BY node_id, CAST((ts + ?) / ? AS INTEGER) ORDER BY 2, 1 LIMIT ?`;
  } else {
    sql = `SELECT node_id AS node, day, ${ms.map((m) => `${m.key}_sum AS s_${m.key}, ${m.key}_n AS n_${m.key}, ${m.key}_max AS x_${m.key}`).join(', ')}
      FROM node_load_daily WHERE device_id = ? AND day >= ? AND day <= ? ORDER BY day, node_id LIMIT ?`;
  }
  const st = db.conn.prepare(sql);
  db.nodeSel.set(key, st);
  return st;
}

/**
 * 노드 부하 조회 — buildNodeLoadSeries 가 받는 행 모양으로 돌려준다.
 * @param {{group:'net'|'disk'|'cpu', kind:'raw'|'bucket'|'daily', from:number, to:number, bucketMs?:number, offsetMin?:number}} q
 * @returns {Promise<{db:boolean, rows:Array<object>, truncated:boolean}>}
 */
export async function nodeLoadQuery(deviceId, { group = 'net', kind = 'raw', from, to, bucketMs = 0, offsetMin = DAY_OFFSET_MIN } = {}) {
  const db = await open();
  if (!db || !NODE_LOAD_GROUPS[group]) return { db: !!db, rows: [], truncated: false };
  const keys = NODE_LOAD_GROUPS[group];
  const st = nodeLoadStmt(db, group, kind);
  const id = String(deviceId);
  let raw; let limit;
  if (kind === 'raw') {
    limit = NODE_LOAD_LIMIT * 400;
    raw = st.all(id, from, to, limit);
    return { db: true, truncated: raw.length >= limit,
      rows: raw.map((r) => ({ node: r.node, ts: r.ts, v: Object.fromEntries(keys.map((k) => [k, r[`v_${k}`]])) })) };
  }
  if (kind === 'bucket') {
    const off = offsetMin * 60_000; const b = Math.max(60_000, Math.floor(bucketMs));
    limit = NODE_LOAD_LIMIT * 200;
    // v2.932: 창이 원시 보존 밖이면(이전 구간) 시간 요약을 버킷으로 묶는다 — 원시 폴백이 아니라 요약으로 내려간다(historyRollup 규약).
    if (from < Date.now() - keepDays().nodeRaw * DAY_MS) {
      const hs = db.conn.prepare(`SELECT node_id AS node, hour, ${keys.map((k) => `${k}_sum AS s_${k}, ${k}_n AS n_${k}, ${k}_max AS x_${k}`).join(', ')}
        FROM node_load_hourly WHERE device_id = ? AND hour >= ? AND hour < ? ORDER BY hour, node_id LIMIT ?`).all(id, hourIndex(from), hourIndex(to - 1) + 1, limit);
      const acc = new Map();
      for (const r of hs) {
        const bts = Math.floor((r.hour * 3_600_000 + off) / b) * b - off;
        const key = `${r.node}|${bts}`;
        const cur = acc.get(key) || { node: r.node, ts: bts, s: {}, n: {}, x: {} };
        for (const k of keys) { cur.s[k] = (cur.s[k] || 0) + (r[`s_${k}`] || 0); cur.n[k] = (cur.n[k] || 0) + (r[`n_${k}`] || 0); if (r[`x_${k}`] != null) cur.x[k] = cur.x[k] == null ? r[`x_${k}`] : Math.max(cur.x[k], r[`x_${k}`]); }
        acc.set(key, cur);
      }
      return { db: true, truncated: hs.length >= limit, source: 'hourly',
        rows: [...acc.values()].sort((a, c) => a.ts - c.ts || a.node - c.node).map((r) => ({ node: r.node, ts: r.ts,
          v: Object.fromEntries(keys.map((k) => [k, r.n[k] > 0 ? r.s[k] / r.n[k] : null])), mx: Object.fromEntries(keys.map((k) => [k, r.x[k] ?? null])), n: Object.fromEntries(keys.map((k) => [k, r.n[k] || 0])) })) };
    }
    raw = st.all(off, b, b, off, id, from, to, off, b, limit);
    return { db: true, truncated: raw.length >= limit,
      rows: raw.map((r) => ({ node: r.node, ts: r.b,
        v: Object.fromEntries(keys.map((k) => [k, r[`v_${k}`]])),
        mx: Object.fromEntries(keys.map((k) => [k, r[`x_${k}`]])),
        n: Object.fromEntries(keys.map((k) => [k, r[`n_${k}`]])) })) };
  }
  limit = NODE_LOAD_LIMIT * 120;
  raw = st.all(id, dayIndex(from), dayIndex(to - 1), limit);
  return { db: true, truncated: raw.length >= limit,
    rows: raw.map((r) => ({ node: r.node, ts: dayStartMs(r.day),
      v: Object.fromEntries(keys.map((k) => [k, r[`n_${k}`] > 0 ? r[`s_${k}`] / r[`n_${k}`] : null])),
      mx: Object.fromEntries(keys.map((k) => [k, r[`x_${k}`]])),
      n: Object.fromEntries(keys.map((k) => [k, r[`n_${k}`]])) })) };
}

/** 창 안의 잡 엔진 표본(원시 보존 안에서만 있다). */
export async function nodeLoadJobs(deviceId, from, to) {
  const db = await open();
  return db ? db.selNodeJobs.all(String(deviceId), from, to) : [];
}

/** 가장 오래된 기록 — 원시 표본 시각 · 일 롤업 날짜(화면이 '몇 칸까지 과거로 갈 수 있나' 를 계산한다). 없으면 null. */
export async function nodeLoadOldest(deviceId) {
  const db = await open();
  if (!db) return { sampleTs: null, day: null };
  const t = db.selNodeOldestTs.get(String(deviceId))?.t;
  const d = db.selNodeOldestDay.get(String(deviceId))?.d;
  return { sampleTs: Number.isFinite(t) ? t : null, day: Number.isFinite(d) ? dayLabel(d) : null };
}

/* ── v2.932 클라이언트 · 프로토콜 조회 ────────────────────────────────── */
const avgOf = (sum, n) => (n > 0 ? sum / n : null);
/**
 * 창 안의 노드별 클라이언트(시간 요약 — 2시간 미만 창은 원시 표본으로). 행: { node, client, proto, name, samples, ops, in, out, lat }(창 평균).
 * 30일보다 긴 창은 일 요약.
 */
export async function nodeClientsQuery(deviceId, { from, to, node = null } = {}) {
  const db = await open();
  if (!db) return { db: false, rows: [] };
  const id = String(deviceId);
  const span = to - from;
  let rows;
  if (span > 31 * DAY_MS) rows = db.selClientDaily.all(id, dayIndex(from), dayIndex(to - 1));
  else rows = db.selClientHourly.all(id, hourIndex(from), hourIndex(to - 1) + 1);
  const out = rows.filter((r) => node == null || r.node === node).map((r) => ({ node: r.node, client: r.client, proto: r.proto, name: r.name || '', samples: r.samples,
    ops: avgOf(r.ops_sum, r.ops_n), in: avgOf(r.in_sum, r.in_n), out: avgOf(r.out_sum, r.out_n), lat: avgOf(r.lat_sum, r.lat_n), opsSum: r.ops_sum }));
  return { db: true, rows: out, source: span > 31 * DAY_MS ? 'daily' : 'hourly' };
}
/** 노드의 가장 최근 표본(원시 · sinceTs 이후)에 있던 클라이언트 — '지금' 열. 없으면 { ts:null, rows:[] }. */
export async function nodeClientsLatest(deviceId, node, sinceTs) {
  const db = await open();
  if (!db) return { ts: null, rows: [] };
  const t = db.selClientLatestTs.get(String(deviceId), node, sinceTs)?.t;
  if (!Number.isFinite(t)) return { ts: null, rows: [] };
  return { ts: t, rows: db.selClientAt.all(String(deviceId), node, t).map((r) => ({ client: r.client, proto: r.proto, name: r.name || '', ops: r.ops, in: r.in_bps, out: r.out_bps, lat: r.lat })) };
}
/** 노드 × 프로토콜(창 평균 · 최대). */
export async function nodeProtoQuery(deviceId, { from, to } = {}) {
  const db = await open();
  if (!db) return { db: false, rows: [] };
  const id = String(deviceId); const span = to - from;
  const rows = span > 31 * DAY_MS ? db.selProtoDaily.all(id, dayIndex(from), dayIndex(to - 1)) : db.selProtoHourly.all(id, hourIndex(from), hourIndex(to - 1) + 1);
  return { db: true, rows: rows.map((r) => ({ node: r.node, proto: r.proto, samples: r.samples, ops: avgOf(r.ops_sum, r.ops_n), opsMax: r.ops_max, lat: avgOf(r.lat_sum, r.lat_n), latMax: r.lat_max })) };
}
/** 창 안에 노드 부하 시간 요약이 있는 노드 id(오름차순) — 쏠림 판정의 노드 집합(ops 0 인 노드도 분모에 넣는다). */
export async function nodeLoadNodeIds(deviceId, { from, to } = {}) {
  const db = await open();
  if (!db) return [];
  if (!db.selNodeIdsHourly) db.selNodeIdsHourly = db.conn.prepare('SELECT DISTINCT node_id AS n FROM node_load_hourly WHERE device_id = ? AND hour >= ? AND hour < ? ORDER BY node_id LIMIT 64');
  return db.selNodeIdsHourly.all(String(deviceId), hourIndex(from), hourIndex(to - 1) + 1).map((r) => r.n);
}
/** 클라이언트 기록의 가장 오래된 시각(원시 · 시간 요약). */
export async function nodeClientOldest(deviceId) {
  const db = await open();
  if (!db) return { sampleTs: null, hourTs: null };
  const t = db.selClientOldestTs.get(String(deviceId))?.t; const h = db.selClientOldestHour.get(String(deviceId))?.h;
  return { sampleTs: Number.isFinite(t) ? t : null, hourTs: Number.isFinite(h) ? h * 3_600_000 : null };
}

export function _resetForTest() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; _pruneFlight.reset(); lockRetry.ok(); }
