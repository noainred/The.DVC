/**
 * pdu/db.js — PDU 시계열 **전용 DB**(사용자 요구: '데이터가 많을 수 있으니 별도 DB').
 *
 * 왜 별도 파일인가: PDU 는 대수 × (본체 1~4 + 뱅크 N + 센서 N) × 짧은 주기라 행이 빨리 는다.
 * 다른 도메인 DB 와 섞으면 prune·VACUUM·잠금이 서로를 방해한다. `CONFIG_DIR/pdu.db` 로 분리.
 *
 * 저장 규약(이 저장소 공통):
 *  - **WAL + synchronous=NORMAL + busy_timeout** (ipam.db 만 예외 — 외부 리더 때문).
 *  - **`ts` 단독 인덱스** — prune 의 `DELETE WHERE ts<?` 는 복합 인덱스로는 탐색이 안 된다.
 *  - **prune 스로틀** — 매 샘플 DELETE 스캔 금지. N 틱마다 1회.
 *  - 값이 없으면 **NULL 로 저장**한다(0 으로 채우면 '측정값 0'과 구분이 사라진다).
 *  - 적재는 **한 트랜잭션**으로 묶는다(수백 행 개별 insert 는 fsync 폭증).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { numOrNull } from '../util/numOrNull.js';

// DB 저장 경로 설정(v2.379)을 따른다 — config.dbDir 이 있으면 그 아래. env 가 최우선.
// v2.451: 이 파일만 configDir 에 고정돼 있어, 경로를 옮겨도 PDU 이력은 계속 CONFIG_DIR 에 쌓였다
// (기본 보존 400일이라 용량 압박 해소라는 원래 목적이 반쪽이 됐다).
const FILE = process.env.PDU_DB || path.join(config.dbDir || config.configDir, 'pdu.db');
const RETAIN_DAYS = Math.max(1, Number(process.env.PDU_RETAIN_DAYS) || 400); // 기본 400일(연 단위 추이)
const PRUNE_EVERY = 20; // 20회 적재마다 1회만 prune

let _db = null;
let _tick = 0;
let _unavailable = false;

// v2.580(BUG-A): **진행 중인 open 을 공유한다** — 예전에는 `_db` 검사와 `await import('node:sqlite')`
// 사이에서 두 번째 호출이 들어오면 같은 파일에 `DatabaseSync` 가 **둘** 만들어지고 첫 핸들이 새어
// 나갔다(v2.580 재현: 동시 2호출 → 같은 파일 fd 2개). `bmusage/db.js`(v2.550)와 같은 패턴이다.
let _opening = null;
async function open() {
  if (_db) return _db;
  if (_unavailable) return null;
  if (_opening) return _opening;
  _opening = openInner().finally(() => { _opening = null; });
  return _opening;
}
async function openInner() {
  if (_db) return _db;
  if (_unavailable) return null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const conn = new DatabaseSync(FILE);
    // v2.447(감사 S4): DB 파일 권한 0600 — 다른 DB 모듈(idrac/metrics/logs/ipam/vmtrack/capacity/ping)은
    // 전부 적용돼 있는데 이 파일만 빠져 있었다. 같은 호스트의 다른 로컬 사용자가 읽을 수 있었다.
    try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
    conn.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;');
    conn.exec(`
      CREATE TABLE IF NOT EXISTS pdu_sample (
        device_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        unit INTEGER NOT NULL,          -- PDU 본체 인덱스(데이지체인 1~4)
        power_w INTEGER,                -- 순시 전력(W)
        energy_kwh REAL,                -- 누적 전력량(kWh) — 카운터
        app_power_w INTEGER,            -- 피상전력(VA)
        pf REAL                         -- 역률
      );
      CREATE INDEX IF NOT EXISTS ix_pdu_sample_ts ON pdu_sample(ts);
      CREATE INDEX IF NOT EXISTS ix_pdu_sample_dev ON pdu_sample(device_id, ts);

      CREATE TABLE IF NOT EXISTS pdu_bank (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL,
        unit INTEGER NOT NULL, bank INTEGER NOT NULL, current_a REAL
      );
      CREATE INDEX IF NOT EXISTS ix_pdu_bank_ts ON pdu_bank(ts);
      CREATE INDEX IF NOT EXISTS ix_pdu_bank_dev ON pdu_bank(device_id, ts);

      CREATE TABLE IF NOT EXISTS pdu_phase (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL,
        unit INTEGER NOT NULL, phase INTEGER NOT NULL, current_a REAL, voltage_v REAL
      );
      CREATE INDEX IF NOT EXISTS ix_pdu_phase_ts ON pdu_phase(ts);

      CREATE TABLE IF NOT EXISTS pdu_env (
        device_id TEXT NOT NULL, ts INTEGER NOT NULL,
        sensor INTEGER NOT NULL, name TEXT, temp_c REAL, humidity_pct REAL
      );
      CREATE INDEX IF NOT EXISTS ix_pdu_env_ts ON pdu_env(ts);
      CREATE INDEX IF NOT EXISTS ix_pdu_env_dev ON pdu_env(device_id, ts);
    `);
    _db = {
      conn,
      insSample: conn.prepare('INSERT INTO pdu_sample (device_id,ts,unit,power_w,energy_kwh,app_power_w,pf) VALUES (?,?,?,?,?,?,?)'),
      insBank: conn.prepare('INSERT INTO pdu_bank (device_id,ts,unit,bank,current_a) VALUES (?,?,?,?,?)'),
      insPhase: conn.prepare('INSERT INTO pdu_phase (device_id,ts,unit,phase,current_a,voltage_v) VALUES (?,?,?,?,?,?)'),
      insEnv: conn.prepare('INSERT INTO pdu_env (device_id,ts,sensor,name,temp_c,humidity_pct) VALUES (?,?,?,?,?,?)'),
    };
    return _db;
  } catch (e) {
    // node:sqlite 미지원 런타임 — 수집 자체는 계속되게 하고 시계열만 포기한다(정직 표기).
    console.error('[pdu-db] 시계열 DB를 열 수 없습니다(시계열 비활성):', e.message);
    _unavailable = true;
    return null;
  }
}

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

/** 스냅샷 1건 적재(한 트랜잭션). 값 없는 항목은 NULL 로 남긴다. */
export async function recordSnapshot(snap) {
  const db = await open();
  if (!db || !snap?.id) return false;
  const ts = Number(snap.collectedAt) || Date.now();
  db.conn.exec('BEGIN');
  try {
    for (const u of snap.units || []) {
      db.insSample.run(String(snap.id), ts, Number(u.index) || 1,
        num(u.powerW), num(u.energyKwh), num(u.appPowerW), num(u.pf));
      for (const b of u.banks || []) db.insBank.run(String(snap.id), ts, Number(u.index) || 1, Number(b.index), num(b.currentA));
      for (const p of u.phases || []) db.insPhase.run(String(snap.id), ts, Number(u.index) || 1, Number(p.index), num(p.currentA), num(p.voltageV));
    }
    for (const s of snap.sensors || []) {
      db.insEnv.run(String(snap.id), ts, Number(s.index) || 1, String(s.name || ''), num(s.tempC), num(s.humidityPct));
    }
    db.conn.exec('COMMIT');
  } catch (e) {
    try { db.conn.exec('ROLLBACK'); } catch { /* */ }
    console.error('[pdu-db] 적재 실패:', e.message);
    return false;
  }
  // prune 은 스로틀 — 매 적재마다 DELETE 스캔하면 폴링이 그만큼 느려진다.
  if (++_tick % PRUNE_EVERY === 0) pruneOld(db);
  return true;
}

function pruneOld(db) {
  const cut = Date.now() - RETAIN_DAYS * 86_400_000;
  try {
    for (const t of ['pdu_sample', 'pdu_bank', 'pdu_phase', 'pdu_env']) {
      db.conn.prepare(`DELETE FROM ${t} WHERE ts < ?`).run(cut); // ts 단독 인덱스가 있어야 풀스캔을 피한다
    }
  } catch (e) { console.error('[pdu-db] prune 실패:', e.message); }
}

/** 조회 창의 상한 — 보존 기간을 넘겨 물어도 의미가 없다(그 뒤엔 prune 돼 행이 없다). */
const MAX_HOURS = RETAIN_DAYS * 24;
const MAX_POINTS = 500;

/**
 * 조회 구간 → `{ since, until, bucketMs }`.
 *
 * ⚠⚠ **`bucketMs` 는 반드시 유한한 양의 정수여야 한다.** 이 값은 `powerSeries`·`envSeries` 에서
 * **템플릿 리터럴로 SQL 에 보간**되므로(`(ts/${bucketMs})`) `Infinity`·`NaN` 이 들어가면 SQLite 가
 * 그것을 **식별자로 파싱**해 `no such column: Infinity` 로 `prepare()` 가 던진다. 두 라우트는
 * async 이고 express 4 는 async throw 를 잡지 않으므로 **그 요청이 영원히 응답 없이 매달리고**
 * 소켓 fd 가 잡힌다(2026-09-21 감사 BUG-01 — `?hours=1e400` 실측 무응답, 요청 40개에 fd +40).
 *
 * 그래서 입력을 **전부 유한수로 좁힌 뒤** 범위를 클램프한다. `numOrNull` 은 `Infinity`·`NaN`·
 * 빈 문자열·객체를 전부 `null` 로 돌려주므로(v2.561) 그것이 1차 방어이고, 2차로 `clamp` 가
 * 상·하한을 건다. 형제 모듈 `sanswitch/perfDb.js` 는 라우트(`routes/api/sanSwitch.js:74`)에서
 * `Math.min(24*90, …)` 로 클램프해 같은 결함을 피하고 있었다 — 여기에는 그 클램프가 없었다.
 *
 * ⚠ 클램프를 라우트가 아니라 **이 헬퍼**에 둔 이유: 두 라우트가 같은 실수를 반복하지 않게 하고,
 * 새 시계열 라우트가 `rangeOf` 를 재사용할 때 자동으로 보호되게 하기 위해서다.
 */
export function rangeOf({ hours, from, to, points } = {}) {
  const clamp = (v, lo, hi, dflt) => {
    const n = numOrNull(v);
    return n == null ? dflt : Math.min(hi, Math.max(lo, n));
  };
  const h = clamp(hours, 1 / 60, MAX_HOURS, 24);          // 1분 ~ 보존기간
  const pts = Math.round(clamp(points, 10, MAX_POINTS, 120));
  const now = Date.now();
  // 시각은 epoch ms 로만 받는다 — 유한하지 않으면 '미지정' 으로 보고 기본값을 쓴다.
  const toMs = numOrNull(to);
  const fromMs = numOrNull(from);
  const until = toMs == null ? now : Math.min(toMs, now + 86_400_000); // 미래는 하루까지만
  const sinceRaw = fromMs == null ? until - h * 3_600_000 : fromMs;
  // from > to 로 뒤집혀 오면 구간이 음수가 된다 — 기본 창으로 되돌린다(빈 결과를 내지 않기 위해).
  // ⚠ 보존 기간보다 더 과거는 받지 않는다 — 그 구간은 prune 돼 행이 없는데 bucketMs 만 거대해져
  //   (epoch 0 을 주면 수백만 시간) 버킷 축이 무의미해진다.
  const floor = until - MAX_HOURS * 3_600_000;
  const since = Math.max(floor, sinceRaw < until ? sinceRaw : until - h * 3_600_000);
  const span = Math.max(1, until - since);
  const bucketMs = Math.max(60_000, Math.round(span / pts));
  // 여기까지 왔는데도 유한하지 않다면 SQL 에 넣지 않는다(있을 수 없지만, 보간이라 마지막 방어).
  return { since, until, bucketMs: Number.isSafeInteger(bucketMs) && bucketMs > 0 ? bucketMs : 60_000 };
}

/**
 * 전력 시계열 — 장비별(또는 전체 합) 버킷 평균/최대.
 * @param deviceIds 조회 대상 장비 id 배열(빈 배열이면 전체)
 */
export async function powerSeries(deviceIds = [], opts = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], unavailable: true };
  const { since, until, bucketMs } = rangeOf(opts);
  const where = deviceIds.length ? `AND device_id IN (${deviceIds.map(() => '?').join(',')})` : '';
  // v2.598 DB2598-03: 데이지체인 PDU 는 한 수집 시각(ts)에 유닛마다 한 행이다. 예전에는 행을 그대로
  // 버킷 평균해 **유닛 평균**(1,000W+500W → 750W)을 장비 전력이라 보여줬다. 안쪽에서 (장비, ts)별로
  // 유닛을 **합산**한 뒤 버킷을 만든다. 그 시각에 전력을 못 읽은 유닛이 하나라도 있으면 합은 부분 합
  // (= 거짓 하락)이므로 NULL 로 두고 평균·최대에서 빼며, 뺀 시각 수를 partialSamples 로 밝힌다.
  const rows = db.conn.prepare(
    `SELECT device_id, (ts/${bucketMs}) AS b, AVG(tot) AS avg_w, MAX(tot) AS max_w,
            SUM(CASE WHEN tot IS NULL THEN 1 ELSE 0 END) AS partial
       FROM (SELECT device_id, ts,
                    CASE WHEN COUNT(power_w) = COUNT(*) THEN SUM(power_w) END AS tot
               FROM pdu_sample WHERE ts >= ? AND ts <= ? ${where}
              GROUP BY device_id, ts)
      GROUP BY device_id, b ORDER BY b ASC`,
  ).all(since, until, ...deviceIds.map(String));
  const out = shape(rows, bucketMs, 'avg_w', 'max_w');
  out.partialSamples = rows.reduce((a, r) => a + Number(r.partial || 0), 0);
  return out;
}

/** 온도/습도 시계열 — 센서 단위. */
export async function envSeries(deviceIds = [], opts = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], unavailable: true };
  const { since, until, bucketMs } = rangeOf(opts);
  const where = deviceIds.length ? `AND device_id IN (${deviceIds.map(() => '?').join(',')})` : '';
  const rows = db.conn.prepare(
    `SELECT device_id || '#' || sensor AS device_id, (ts/${bucketMs}) AS b,
            AVG(temp_c) AS avg_w, MAX(temp_c) AS max_w, AVG(humidity_pct) AS avg_h
       FROM pdu_env WHERE ts >= ? AND ts <= ? ${where}
      GROUP BY device_id, sensor, b ORDER BY b ASC`,
  ).all(since, until, ...deviceIds.map(String));
  const out = shape(rows, bucketMs, 'avg_w', 'max_w');
  // 습도는 같은 버킷 축에 별도 배열로 얹는다.
  const idx = new Map(out.bucketKeys.map((b, i) => [b, i]));
  const byKey = new Map(out.series.map((s) => [s.key, s]));
  for (const r of rows) {
    const s = byKey.get(String(r.device_id));
    if (!s) continue;
    if (!s.humidity) s.humidity = new Array(out.buckets.length).fill(null);
    const i = idx.get(Number(r.b));
    if (i != null) s.humidity[i] = r.avg_h == null ? null : Math.round(Number(r.avg_h));
  }
  return out;
}

function shape(rows, bucketMs, avgCol, maxCol) {
  const bset = [...new Set(rows.map((r) => Number(r.b)))].sort((a, b) => a - b);
  const buckets = bset.map((b) => b * bucketMs);
  const idx = new Map(bset.map((b, i) => [b, i]));
  const byDev = new Map();
  for (const r of rows) {
    const k = String(r.device_id);
    if (!byDev.has(k)) byDev.set(k, { key: k, avg: new Array(buckets.length).fill(null), peak: new Array(buckets.length).fill(null) });
    const s = byDev.get(k);
    const i = idx.get(Number(r.b));
    s.avg[i] = r[avgCol] == null ? null : Math.round(Number(r[avgCol]) * 10) / 10;
    s.peak[i] = r[maxCol] == null ? null : Math.round(Number(r[maxCol]) * 10) / 10;
  }
  const series = [...byDev.values()].map((s) => {
    const v = s.avg.filter((x) => x != null);
    const p = s.peak.filter((x) => x != null);
    return { ...s, avgTotal: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, maxTotal: p.length ? Math.max(...p) : null };
  });
  return { buckets, bucketKeys: bset, bucketMs, series };
}

/** DB 상태(진단 화면용). */
export async function dbStats() {
  const db = await open();
  if (!db) return { unavailable: true, file: FILE };
  const q = (t) => db.conn.prepare(`SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM ${t}`).get();
  let bytes = 0;
  try { bytes = fs.statSync(FILE).size; } catch { /* */ }
  return { file: FILE, bytes, retainDays: RETAIN_DAYS, sample: q('pdu_sample'), env: q('pdu_env'), bank: q('pdu_bank') };
}

export function _resetForTest() { _db = null; _tick = 0; _unavailable = false; }
