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

const FILE = () => path.join(config.dbDir || config.configDir, 'sanswitch-perf.db');
const PRUNE_EVERY = 20;      // N회 저장마다 1회만 prune
let _db = null;              // { conn, ... } | 'unavailable'
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
      CREATE TABLE IF NOT EXISTS port_perf (
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
  for (const r of db.conn.prepare(`SELECT device_id AS d, MAX(ts) AS ts FROM port_perf WHERE device_id IN (${ids.map(() => '?').join(',')}) GROUP BY device_id`).all(...ids)) out.set(String(r.d), Number(r.ts));
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
  let inserted = 0, skipped = 0;
  db.conn.exec('BEGIN');
  try {
    for (const r of rows) {
      const d = String(r.d ?? ''), ts = Number(r.ts), p = Number(r.p), b = Math.max(0, Math.round(Number(r.b)));
      if (!d || !Number.isFinite(ts) || !Number.isInteger(p) || !Number.isFinite(b)) { skipped++; continue; }
      const x = ins.run(d, ts, p, b, d, p, ts);
      if (Number(x.changes) > 0) inserted++; else skipped++;
    }
    for (const m of meta) {
      const d = String(m.d ?? ''); const p = Number(m.p);
      if (!d || !Number.isInteger(p)) continue;
      // 더 새로운 메타만 반영(엣지 청크가 순서 없이 와도 최신을 유지)
      // v2.503: 예전에는 이 줄에서 포트마다 `prepare()` 를 새로 만들었다 — 디렉터 1대가 512~768포트라
      // 한 요청에 그만큼 SQL 파싱·계획 수립이 반복됐다(같은 파일의 upMeta 는 이미 초기화 때 준비돼 있다).
      const cur = db.metaTs.get(d, p);
      if (cur && Number(cur.ts) > Number(m.ts)) continue;
      db.upMeta.run(d, p, Number(m.ts) || Date.now(), String(m.name || ''), String(m.wwn || ''), String(m.speed || ''), String(m.type || ''));
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (++_pruneTick % PRUNE_EVERY === 0) pruneOld(db, retentionDays);
  return { inserted, skipped };
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

  if (++_pruneTick % PRUNE_EVERY === 0) pruneOld(db, retentionDays);
  return { saved: rows.length };
}

function pruneOld(db, retentionDays) {
  try {
    const cut = Date.now() - Math.max(1, Number(retentionDays) || 90) * 86400e3;
    return db.conn.prepare('DELETE FROM port_perf WHERE ts < ?').run(cut); // ts 단독 인덱스로 탐색
  } catch (e) { console.warn(`[sanswitch-perf] prune 실패: ${e.message}`); return null; }
}

/** 보관 기간 즉시 적용(v2.420, 설정 화면 '지금 정리') — 삭제 행 수를 돌려준다. */
export async function pruneNow(retentionDays) {
  const db = await open();
  if (!db) return { deleted: 0, unavailable: true };
  const r = pruneOld(db, retentionDays);
  return { deleted: Number(r?.changes || 0) };
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

/** 보관 현황(설정 화면 표시용). */
export async function perfDbStats() {
  const db = await open();
  if (!db) return { available: false };
  try {
    const r = db.conn.prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM port_perf').get();
    const d = db.conn.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM port_perf').get();
    const day = db.conn.prepare('SELECT COUNT(*) AS n FROM port_perf WHERE ts >= ?').get(Date.now() - 86400e3);
    let fileBytes = 0;
    for (const suf of ['', '-wal']) { try { fileBytes += fs.statSync(FILE() + suf).size; } catch { /* */ } }
    return { available: true, rows: Number(r?.n || 0), oldest: Number(r?.oldest || 0), newest: Number(r?.newest || 0), devices: Number(d?.n || 0), file: FILE(),
      fileBytes, rowsLastDay: Number(day?.n || 0) };
  } catch (e) { return { available: true, error: e.message }; }
}

export function _resetForTest() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; }
