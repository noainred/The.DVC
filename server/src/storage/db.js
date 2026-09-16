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

// DB 저장 경로 설정(v2.379)을 따른다 — dbLocation 이 지정한 dbDir 아래, 없으면 configDir.
// (vmperf/vmtrack 과 동일 규약. MIGRATABLE 에 이 파일이 있어 미적용 시 마이그레이션 후
//  옛 경로에 계속 쓰다 원본 삭제 단계에서 이력이 소실된다 — v2.386 수정.)
const FILE = () => path.join(config.dbDir || config.configDir, 'storage-history.db');
const MAX_JSON_BYTES = 512 * 1024; // 엔드포인트당 원문 상한 — 512KB 초과는 절단 표기(폭주 방지)

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

/**
 * 일 경계 오프셋(분). 사용자(포탈 운영자)는 **한국**에 있으므로 기본 +9시간이다 —
 * UTC 로 자르면 한국 기준 오전 9시에 날이 바뀌어 '어제 증가량' 이 사람이 세는 하루와 어긋난다.
 * 다른 지역에서 쓰려면 `STORAGE_GROWTH_TZ_OFFSET_MIN` 으로 바꾼다.
 */
export const DAY_OFFSET_MIN = Number.isFinite(Number(process.env.STORAGE_GROWTH_TZ_OFFSET_MIN))
  ? Number(process.env.STORAGE_GROWTH_TZ_OFFSET_MIN) : 540;
const DAY_MS = 86_400_000;
/** epoch ms → 일 인덱스(오프셋 적용). 순수 — 테스트가 고정한다. */
export function dayIndex(ts, offsetMin = DAY_OFFSET_MIN) {
  return Math.floor((Number(ts) + offsetMin * 60_000) / DAY_MS);
}
/** 일 인덱스 → 그 날의 시작 epoch ms(오프셋 적용). */
export function dayStartMs(day, offsetMin = DAY_OFFSET_MIN) {
  return Number(day) * DAY_MS - offsetMin * 60_000;
}
/** 일 인덱스 → `YYYY-MM-DD`(그 지역의 날짜). */
export function dayLabel(day, offsetMin = DAY_OFFSET_MIN) {
  return new Date(dayStartMs(day, offsetMin) + offsetMin * 60_000).toISOString().slice(0, 10);
}

/** 보존 일수(설정 → env → 기본). 순환 import 를 피하려고 setter 로 주입받는다. */
let _keepDays = { raw: null, daily: null };
export function setKeepDays({ rawKeepDays, dailyKeepDays } = {}) {
  _keepDays = {
    raw: Number.isFinite(Number(rawKeepDays)) ? Number(rawKeepDays) : null,
    daily: Number.isFinite(Number(dailyKeepDays)) ? Number(dailyKeepDays) : null,
  };
}
function keepDays() {
  return {
    raw: _keepDays.raw ?? (Number(process.env.STORAGE_HISTORY_KEEP_DAYS) || RAW_KEEP_DAYS_DEF),
    daily: _keepDays.daily ?? (Number(process.env.STORAGE_DAILY_KEEP_DAYS) || DAILY_KEEP_DAYS_DEF),
  };
}

let _db = null;      // { conn, stmts } | 'unavailable'
let _pruneTick = 0;

async function open() {
  if (_db) return _db === 'unavailable' ? null : _db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(FILE());
    // v2.447(감사 S4): DB 파일 권한 0600 — 다른 DB 모듈(idrac/metrics/logs/ipam/vmtrack/capacity/ping)은
    // 전부 적용돼 있는데 이 파일만 빠져 있었다. 같은 호스트의 다른 로컬 사용자가 읽을 수 있었다.
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS api_latest (
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
      CREATE INDEX IF NOT EXISTS idx_capd_day ON capacity_daily (day);`);
    _db = {
      conn,
      upLatest: conn.prepare(`INSERT INTO api_latest (device_id, area, endpoint, ts, ok, bytes, truncated, json, error)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(device_id, endpoint) DO UPDATE SET area=excluded.area, ts=excluded.ts, ok=excluded.ok,
          bytes=excluded.bytes, truncated=excluded.truncated, json=excluded.json, error=excluded.error`),
      insHist: conn.prepare('INSERT INTO api_history (device_id, area, ts, ok, bytes, error) VALUES (?,?,?,?,?,?)'),
      insCap: conn.prepare('INSERT INTO capacity_history (device_id, ts, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used) VALUES (?,?,?,?,?,?,?,?)'),
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
      selCapAllBucket: conn.prepare(`SELECT ts, SUM(total_bytes) AS total_bytes, SUM(used_bytes) AS used_bytes,
          SUM(hdd_total) AS hdd_total, SUM(hdd_used) AS hdd_used, SUM(ssd_total) AS ssd_total, SUM(ssd_used) AS ssd_used,
          COUNT(*) AS devices
        FROM (
          SELECT CAST(CAST(ts/? AS INTEGER)*? AS INTEGER) AS ts, device_id,
            AVG(total_bytes) AS total_bytes, AVG(used_bytes) AS used_bytes,
            AVG(hdd_total) AS hdd_total, AVG(hdd_used) AS hdd_used,
            AVG(ssd_total) AS ssd_total, AVG(ssd_used) AS ssd_used
          FROM capacity_history WHERE ts >= ?
          GROUP BY CAST(ts/? AS INTEGER), device_id
        ) GROUP BY ts ORDER BY ts LIMIT 2000`),
      // 일 롤업 upsert — **더 늦은 관측만** last_* 를 갱신한다(엣지 push 가 순서대로 오지 않을 수
      // 있다). max_used 는 항상 최대를 유지하고 samples 는 누적한다.
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
          max_used    = MAX(COALESCE(capacity_daily.max_used, 0), COALESCE(excluded.max_used, 0)),
          samples     = capacity_daily.samples + 1`),
      selDaily: conn.prepare(`SELECT device_id, day, last_ts, total_bytes, used_bytes,
          hdd_total, hdd_used, ssd_total, ssd_used, max_used, samples
        FROM capacity_daily WHERE device_id = ? AND day >= ? ORDER BY day`),
      selDailyAll: conn.prepare(`SELECT device_id, day, last_ts, total_bytes, used_bytes,
          hdd_total, hdd_used, ssd_total, ssd_used, max_used, samples
        FROM capacity_daily WHERE day >= ? ORDER BY device_id, day`),
      // 장비별 **전체 이력 범위**(조회 구간과 무관). 화면의 '관측 N일' 은 이 값이어야 한다 —
      // 조회 구간(예: 90일)으로 대신하면 700일치를 가진 장비가 '92일' 로 보인다(v2.531 실제 결함).
      // capacity_daily 는 하루 1행이라 전 행을 훑어도 20대×5년 = 3.6만 행이다.
      selDailySpan: conn.prepare(`SELECT device_id, MIN(day) AS first_day, MAX(day) AS last_day,
          COUNT(*) AS observed FROM capacity_daily GROUP BY device_id`),
      prune1: conn.prepare('DELETE FROM api_history WHERE ts < ?'),
      prune2: conn.prepare('DELETE FROM capacity_history WHERE ts < ?'),
      prune3: conn.prepare('DELETE FROM capacity_daily WHERE day < ?'),
    };
    return _db;
  } catch (e) {
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
  const { raw, daily } = keepDays();
  const cut = Date.now() - raw * DAY_MS;
  db.prune1.run(cut);
  db.prune2.run(cut);
  db.prune3.run(dayIndex(Date.now()) - daily);
  return true;
}

/** 강제 prune(설정 저장 직후 즉시 반영용 — 스로틀을 건너뛴다). */
export async function pruneNow() {
  const db = await open();
  if (!db) return false;
  const { raw, daily } = keepDays();
  const cut = Date.now() - raw * DAY_MS;
  db.prune1.run(cut); db.prune2.run(cut); db.prune3.run(dayIndex(Date.now()) - daily);
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
  const used = Number.isFinite(Number(snap.capacity?.usedBytes)) ? Number(snap.capacity.usedBytes) : null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const hT = n(snap.media?.hdd?.totalBytes); const hU = n(snap.media?.hdd?.usedBytes);
  const sT = n(snap.media?.ssd?.totalBytes); const sU = n(snap.media?.ssd?.usedBytes);

  db.insCap.run(snap.deviceId, ts, total, used, hT, hU, sT, sU);
  const day = dayIndex(ts);
  db.upDaily.run(snap.deviceId, day, ts, total, used, hT, hU, sT, sU, used);
  maybePrune(db);
  return { saved: true, day };
}

/**
 * 일 롤업 조회 — 증가량 계산의 원천.
 * @param {string|null} deviceId null 이면 전 장비(장비별로 묶어 돌려준다)
 * @param {number} sinceDay 일 인덱스(포함)
 */
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
/**
 * 전체 장비 합산 용량 시계열(v2.380) — 목록 화면 통합 추이.
 * bucketMs 는 필수다(장비별 수집 시각이 달라 버킷 없이는 합산 시점을 맞출 수 없다).
 * 반환 각 점의 devices 는 그 버킷에 데이터가 있던 장비 수 — 일부 장비만 수집된 구간을
 * '전체 감소'로 오독하지 않게 화면에 함께 보여준다.
 */
export async function capacityHistoryAll(sinceMs, bucketMs) {
  const db = await open();
  if (!db) return [];
  const b = Math.max(60_000, Number(bucketMs) || 3_600_000);
  // ⚠ 다른 함수처럼 문(statement)은 db 의 평면 속성이다(db.selCapBucket 등). db.st 는
  //   존재하지 않아 TypeError → catch 가 삼켜 전체 합산 추이가 항상 빈 배열이었다(v2.386 수정).
  try { return db.selCapAllBucket.all(b, b, Number(sinceMs) || 0, b); }
  catch (e) { console.warn(`[storage-db] capacityHistoryAll 실패: ${e.message}`); return []; }
}

export function _resetForTest() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; }
