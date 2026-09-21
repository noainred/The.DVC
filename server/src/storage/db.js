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
import { numOrNull } from '../util/numOrNull.js';

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
  // ⚠⚠ v2.576: `numOrNull` 로 좁힌다. 예전 형태(`Number.isFinite(Number(v)) ? … : null`)는
  //   `Number(null)`·`Number('')`·`Number([])` 를 전부 **0** 으로 통과시킨다. 여기서 0 이 되면
  //   아래 `keepDays()` 의 `_keepDays.raw ?? 기본값` 이 **0 ?? x === 0** 이라 기본값으로 되돌지
  //   못하고 **보존 0일 = 전량 삭제**가 된다. v2.561 은 `loadGrowthSettings()` 가 명시적 null 을
  //   막고 있다는 근거로 REVIEWED_SAFE 로 뒀지만, 그 근거는 **호출부 하나**에 기댄 것이라
  //   다음 호출부가 생기면 무효가 된다. 결과가 파괴적이므로 sink 에서 막는다.
  _keepDays = { raw: numOrNull(rawKeepDays), daily: numOrNull(dailyKeepDays) };
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
      CREATE INDEX IF NOT EXISTS idx_capd_day ON capacity_daily (day);
      /* 운영 메타(v2.534) — 1회성 마이그레이션 표식과 '이력 재시작' 기록을 담는다.
         용량 이력은 '측정 기준' 이 바뀌면 이전 값과 이어 붙일 수 없다. 그 사실을 남기지
         않으면 화면의 '관측 N일' 이 이유 없이 1일로 줄어 사용자가 수집 장애로 오해한다. */
      CREATE TABLE IF NOT EXISTS storage_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`);
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
      // 장비별 **전체 이력 범위**(조회 구간과 무관). 화면의 '관측 N일' 은 이 값이어야 한다 —
      // 조회 구간(예: 90일)으로 대신하면 700일치를 가진 장비가 '92일' 로 보인다(v2.531 실제 결함).
      // capacity_daily 는 하루 1행이라 전 행을 훑어도 20대×5년 = 3.6만 행이다.
      selDailySpan: conn.prepare(`SELECT device_id, MIN(day) AS first_day, MAX(day) AS last_day,
          COUNT(*) AS observed FROM capacity_daily GROUP BY device_id`),
      metaGet: conn.prepare('SELECT v FROM storage_meta WHERE k = ?'),
      metaSet: conn.prepare('INSERT INTO storage_meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      delCapDev: conn.prepare('DELETE FROM capacity_history WHERE device_id = ?'),
      delDailyDev: conn.prepare('DELETE FROM capacity_daily WHERE device_id = ?'),
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
      const n = Number(a?.changes || 0) + Number(b?.changes || 0);
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

export function _resetForTest() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; }
