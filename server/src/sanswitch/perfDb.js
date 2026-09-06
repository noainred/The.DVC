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
    db.conn.prepare('DELETE FROM port_perf WHERE ts < ?').run(cut); // ts 단독 인덱스로 탐색
  } catch (e) { console.warn(`[sanswitch-perf] prune 실패: ${e.message}`); }
}

/**
 * 포트별 시계열. 데이터가 많으면 화면이 못 그리므로 **버킷 평균**으로 내려준다
 * (버킷 = 요청 구간을 points 개로 나눈 폭). 원시 점을 수만 개 던지면 브라우저가 멈춘다.
 * @returns { buckets:[ts...], series:[{port, name, speed, avg[], max}], bucketMs }
 */
export async function portSeries(deviceId, { hours = 24, ports = null, points = 120 } = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], bucketMs: 0, unavailable: true };
  const since = Date.now() - Math.max(1, hours) * 3600e3;
  const bucketMs = Math.max(60_000, Math.round((hours * 3600e3) / Math.max(10, points)));
  const filter = ports?.length ? ` AND port IN (${ports.map(() => '?').join(',')})` : '';
  const rows = db.conn.prepare(
    `SELECT port, (ts / ${bucketMs}) AS b, AVG(bps) AS avg_bps, MAX(bps) AS max_bps
       FROM port_perf WHERE device_id = ? AND ts >= ?${filter}
      GROUP BY port, b ORDER BY b ASC`,
  ).all(String(deviceId), since, ...(ports || []));
  return shape(db, deviceId, rows, bucketMs, since);
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
        avg: new Array(buckets.length).fill(null), max: 0 });
    }
    const s = byPort.get(p);
    s.avg[idx.get(Number(r.b))] = Math.round(Number(r.avg_bps));
    s.max = Math.max(s.max, Math.round(Number(r.max_bps)));
  }
  return { buckets, bucketMs, since, series: [...byPort.values()].sort((a, b) => a.port - b.port) };
}

/**
 * 연결 장비(스토리지 어레이)별 집계 — 사용자 요구 '포트 사용량을 분석해서 스토리지 사용량을
 * 볼 수 있게'. 같은 어레이에 여러 포트가 물려 있으므로(SYMMETRIX 의 SAF-1d/3d/5d…) 포트
 * 처리량을 **어레이 단위로 합산**해야 그 스토리지가 실제로 얼마나 쓰이는지 보인다.
 */
export async function storageSeries(deviceId, { hours = 24, points = 120 } = {}) {
  const db = await open();
  if (!db) return { buckets: [], series: [], unavailable: true };
  const since = Date.now() - Math.max(1, hours) * 3600e3;
  const bucketMs = Math.max(60_000, Math.round((hours * 3600e3) / Math.max(10, points)));
  const rows = db.conn.prepare(
    `SELECT p.port AS port, (p.ts / ${bucketMs}) AS b, AVG(p.bps) AS avg_bps
       FROM port_perf p WHERE p.device_id = ? AND p.ts >= ?
      GROUP BY p.port, b ORDER BY b ASC`,
  ).all(String(deviceId), since);
  const metaRows = db.conn.prepare('SELECT port, attached_name FROM port_meta WHERE device_id = ?').all(String(deviceId));
  const groupOf = new Map(metaRows.map((m) => [Number(m.port), storageKey(m.attached_name)]));

  const bucketSet = [...new Set(rows.map((r) => Number(r.b)))].sort((a, b) => a - b);
  const buckets = bucketSet.map((b) => b * bucketMs);
  const idx = new Map(bucketSet.map((b, i) => [b, i]));
  const byGroup = new Map();
  for (const r of rows) {
    const g = groupOf.get(Number(r.port)) || '(미확인)';
    if (!byGroup.has(g)) byGroup.set(g, { key: g, ports: new Set(), sum: new Array(buckets.length).fill(0), total: 0 });
    const s = byGroup.get(g);
    s.ports.add(Number(r.port));
    const v = Math.round(Number(r.avg_bps));
    s.sum[idx.get(Number(r.b))] += v;
    s.total += v;
  }
  const series = [...byGroup.values()]
    .map((s) => ({ key: s.key, ports: [...s.ports].sort((a, b) => a - b), sum: s.sum, avgTotal: s.total / Math.max(1, buckets.length) }))
    .sort((a, b) => b.avgTotal - a.avgTotal);
  return { buckets, bucketMs, since, series };
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

/** 보관 현황(설정 화면 표시용). */
export async function perfDbStats() {
  const db = await open();
  if (!db) return { available: false };
  try {
    const r = db.conn.prepare('SELECT COUNT(*) AS n, MIN(ts) AS oldest, MAX(ts) AS newest FROM port_perf').get();
    const d = db.conn.prepare('SELECT COUNT(DISTINCT device_id) AS n FROM port_perf').get();
    return { available: true, rows: Number(r?.n || 0), oldest: Number(r?.oldest || 0), newest: Number(r?.newest || 0), devices: Number(d?.n || 0), file: FILE() };
  } catch (e) { return { available: true, error: e.message }; }
}

export function _resetForTest() { try { _db?.conn?.close?.(); } catch { /* */ } _db = null; _pruneTick = 0; }
