/**
 * cvp/db.js — CloudVision(CVP) 수집 전용 DB(v2.608, 사용자 요청 "데이터 용량이 많으니까 별도의 DB 로").
 *
 * 파일: <dbDir|configDir>/cvp.db — 0600 · WAL(util/sqliteOpen) · insights/dbLocation MIGRATABLE 등재.
 *
 * 표(행 수 계산·결정 근거는 docs/CVP.md '용량 계산'):
 *  - device_latest (PK agent,cvp_id,device_key) — 인벤토리·버전·부품·BGP 최신값(장비당 1행).
 *  - port_latest   (PK agent,cvp_id,device_key,port) — 포트 구성 + 마지막 처리량·사용률·오류(포트당 1행).
 *  - port_sample   원시(지표를 열로 — v2.550 bmusage 규약) · **링크가 올라온 포트만** · 기본 7일.
 *                  UNIQUE(agent,cvp_id,device_key,port,ts) — 엣지 재전송 중복을 걸러 롤업 이중 계수를 막는다(INSERT OR IGNORE + changes).
 *  - port_daily    일 롤업(평균 = 합/표본수 · 최대) · 기본 730일. **null 은 평균의 분모에 넣지 않는다.** 하루 경계는 util/dayKey.
 *  agent '' = 이 노드가 직접 수집한 행. 중앙은 엣지 push 를 인증된 엣지 이름으로 적재한다.
 *
 * 규약: 진행 중인 open 공유(_opening — v2.580 BUG-A) · 잠금은 래치하지 않고 재시도(createLockRetry — v2.599) ·
 *   대량 쓰기는 트랜잭션 1회 · 최신 upsert 는 `WHERE excluded.ts > ts`(엣지 push 는 순서대로 오지 않는다 — v2.531) ·
 *   '최신 1건씩' 을 GROUP BY + MAX 로 만들지 않는다(최신 전용 표 — v2.550.3) · prune 은 createPruneFlight + chunkedDelete ·
 *   ts 단독 인덱스 · COUNT(*) 는 짧게 캐시하고 캐시임을 밝힌다(countsAt).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';
import { dayIndex, dayStartMs, DAY_MS } from '../util/dayKey.js';
import { numOrNull } from '../util/numOrNull.js';
import { capStr } from '../util/capStr.js';

export const LOCAL_AGENT = '';
const lockRetry = createLockRetry();
const FILE = () => path.join(config.dbDir || config.configDir, 'cvp.db');
let _db = null;       // { conn, st } | 'unavailable'
let _opening = null;
let _counts = null;   // { at, device, port, sample, daily }
const pruneFlight = createPruneFlight({ covers: (a, b) => a.raw <= b.raw && a.daily <= b.daily });

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
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    conn = openSqlite(new DatabaseSync(FILE()));
    try { fs.chmodSync(FILE(), 0o600); } catch { /* best effort */ }
    conn.exec(`CREATE TABLE IF NOT EXISTS device_latest (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, ts INTEGER NOT NULL,
        hostname TEXT, model TEXT, serial TEXT, mgmt_ip TEXT, eos_version TEXT, streaming INTEGER,
        telemetry TEXT, parts_json TEXT, parts_at INTEGER, bgp_json TEXT, ports_read INTEGER, extra_json TEXT,
        PRIMARY KEY (agent, cvp_id, device_key));
      CREATE TABLE IF NOT EXISTS port_latest (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, port TEXT NOT NULL, ts INTEGER NOT NULL,
        descr TEXT, speed_bps REAL, oper TEXT, admin TEXT, vlan TEXT, lag TEXT,
        in_bps REAL, out_bps REAL, in_util REAL, out_util REAL, in_err INTEGER, out_err INTEGER,
        PRIMARY KEY (agent, cvp_id, device_key, port));
      CREATE TABLE IF NOT EXISTS port_sample (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, port TEXT NOT NULL, ts INTEGER NOT NULL,
        in_bps REAL, out_bps REAL, in_util REAL, out_util REAL, in_err INTEGER, out_err INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_ps_key ON port_sample (agent, cvp_id, device_key, port, ts);
      CREATE INDEX IF NOT EXISTS idx_ps_ts ON port_sample (ts);
      CREATE TABLE IF NOT EXISTS port_daily (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, port TEXT NOT NULL, day INTEGER NOT NULL,
        samples INTEGER NOT NULL DEFAULT 0,
        in_bps_sum REAL NOT NULL DEFAULT 0, in_bps_n INTEGER NOT NULL DEFAULT 0, in_bps_max REAL,
        out_bps_sum REAL NOT NULL DEFAULT 0, out_bps_n INTEGER NOT NULL DEFAULT 0, out_bps_max REAL,
        in_util_sum REAL NOT NULL DEFAULT 0, in_util_n INTEGER NOT NULL DEFAULT 0, in_util_max REAL,
        out_util_sum REAL NOT NULL DEFAULT 0, out_util_n INTEGER NOT NULL DEFAULT 0, out_util_max REAL,
        in_err_sum INTEGER, out_err_sum INTEGER,
        PRIMARY KEY (agent, cvp_id, device_key, port, day));
      CREATE INDEX IF NOT EXISTS idx_pd_day ON port_daily (day);`);
    const maxOf = (col) => `NULLIF(MAX(IFNULL(port_daily.${col},-1e308), IFNULL(excluded.${col},-1e308)), -1e308)`;
    const st = {
      upDevice: conn.prepare(`INSERT INTO device_latest (agent,cvp_id,device_key,ts,hostname,model,serial,mgmt_ip,eos_version,streaming,telemetry,parts_json,parts_at,bgp_json,ports_read,extra_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key) DO UPDATE SET ts=excluded.ts, hostname=excluded.hostname, model=excluded.model, serial=excluded.serial,
          mgmt_ip=excluded.mgmt_ip, eos_version=excluded.eos_version, streaming=excluded.streaming, telemetry=excluded.telemetry,
          parts_json=CASE WHEN excluded.parts_at IS NULL THEN device_latest.parts_json ELSE excluded.parts_json END,
          parts_at=CASE WHEN excluded.parts_at IS NULL THEN device_latest.parts_at ELSE excluded.parts_at END,
          bgp_json=excluded.bgp_json, ports_read=excluded.ports_read, extra_json=excluded.extra_json
        WHERE excluded.ts > device_latest.ts`),
      upPort: conn.prepare(`INSERT INTO port_latest (agent,cvp_id,device_key,port,ts,descr,speed_bps,oper,admin,vlan,lag,in_bps,out_bps,in_util,out_util,in_err,out_err)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key,port) DO UPDATE SET ts=excluded.ts, descr=excluded.descr, speed_bps=excluded.speed_bps, oper=excluded.oper,
          admin=excluded.admin, vlan=excluded.vlan, lag=excluded.lag, in_bps=excluded.in_bps, out_bps=excluded.out_bps, in_util=excluded.in_util,
          out_util=excluded.out_util, in_err=excluded.in_err, out_err=excluded.out_err
        WHERE excluded.ts > port_latest.ts`),
      delPortsOld: conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=? AND device_key=? AND ts < ?'),
      insSample: conn.prepare('INSERT OR IGNORE INTO port_sample (agent,cvp_id,device_key,port,ts,in_bps,out_bps,in_util,out_util,in_err,out_err) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      upDaily: conn.prepare(`INSERT INTO port_daily (agent,cvp_id,device_key,port,day,samples,in_bps_sum,in_bps_n,in_bps_max,out_bps_sum,out_bps_n,out_bps_max,
          in_util_sum,in_util_n,in_util_max,out_util_sum,out_util_n,out_util_max,in_err_sum,out_err_sum)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key,port,day) DO UPDATE SET samples=port_daily.samples+1,
          in_bps_sum=port_daily.in_bps_sum+excluded.in_bps_sum, in_bps_n=port_daily.in_bps_n+excluded.in_bps_n, in_bps_max=${maxOf('in_bps_max')},
          out_bps_sum=port_daily.out_bps_sum+excluded.out_bps_sum, out_bps_n=port_daily.out_bps_n+excluded.out_bps_n, out_bps_max=${maxOf('out_bps_max')},
          in_util_sum=port_daily.in_util_sum+excluded.in_util_sum, in_util_n=port_daily.in_util_n+excluded.in_util_n, in_util_max=${maxOf('in_util_max')},
          out_util_sum=port_daily.out_util_sum+excluded.out_util_sum, out_util_n=port_daily.out_util_n+excluded.out_util_n, out_util_max=${maxOf('out_util_max')},
          in_err_sum=CASE WHEN excluded.in_err_sum IS NULL THEN port_daily.in_err_sum ELSE IFNULL(port_daily.in_err_sum,0)+excluded.in_err_sum END,
          out_err_sum=CASE WHEN excluded.out_err_sum IS NULL THEN port_daily.out_err_sum ELSE IFNULL(port_daily.out_err_sum,0)+excluded.out_err_sum END`),
    };
    _db = { conn, st };
    lockRetry.ok();
    return _db;
  } catch (e) {
    try { conn?.close(); } catch { /* 이미 닫힘 */ }
    if (lockRetry.onFail(e)) { console.warn(`[cvp-db] ${lockRetry.note()}`); return null; }
    console.warn(`[cvp-db] DB 사용 불가(수집 화면은 동작, 이력·최신값 저장만 비활성): ${e.message}`);
    _db = 'unavailable';
    return null;
  }
}

export async function available() { return !!(await open()); }

const txt = (v, n = 256) => { const s = capStr(v, n); return s === '' ? null : s; };
const jsonOrNull = (v, max = 256 * 1024) => {
  if (v == null) return null;
  try { const s = JSON.stringify(v); return s.length > max ? null : s; } catch { return null; }
};
const parseJson = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };
const boolInt = (v) => (v === true ? 1 : v === false ? 0 : null);

/** 포트 행이 원시 표본으로 적재될 만한가 — 링크가 올라와 있고 지표가 하나라도 있다. */
export const sampleWorthy = (p) => !!p && p.oper === 'up' && ['inBps', 'outBps', 'inUtil', 'outUtil', 'inErr', 'outErr'].some((k) => p[k] != null);

/**
 * 장비 레코드 목록을 적재한다(트랜잭션 1회). 엣지 push·로컬 수집 공용.
 * device: { key, ts, hostname, model, serial, mgmtIp, eosVersion, streaming, telemetry, parts(undefined=이번에 안 읽음·null=못 읽음·배열),
 *   partsAt, partsMissingKinds, bgp(null|배열), ports(null|배열) } · ports[]: { name, desc, speedBps, oper, admin, vlan, lag, inBps.. }
 * @param {{agent:string, cvpId:string, devices:object[], samples?:boolean}} a  samples=true 면 포트 지표를 원시 표본으로도 넣는다(로컬 수집).
 * @returns {Promise<{devices:number, ports:number, samples:number, duplicates:number, unavailable?:boolean}>}
 */
export async function saveDevices({ agent = LOCAL_AGENT, cvpId, devices = [], samples = false }) {
  const db = await open();
  if (!db) return { devices: 0, ports: 0, samples: 0, duplicates: 0, unavailable: true };
  const { st, conn } = db;
  let nd = 0; let np = 0; let ns = 0; let dup = 0;
  conn.exec('BEGIN');
  try {
    for (const d of devices) {
      const ts = numOrNull(d.ts);
      const key = txt(d.key, 128);
      if (!key || ts == null) continue;
      const partsAt = d.parts === undefined ? null : (numOrNull(d.partsAt) ?? ts);
      const extra = d.partsMissingKinds || d.cvpVersion ? { partsMissingKinds: Array.isArray(d.partsMissingKinds) ? d.partsMissingKinds.slice(0, 8) : undefined } : null;
      st.upDevice.run(agent, cvpId, key, ts, txt(d.hostname), txt(d.model), txt(d.serial), txt(d.mgmtIp, 64), txt(d.eosVersion, 64),
        boolInt(d.streaming), txt(d.telemetry, 32), d.parts === undefined ? null : jsonOrNull(d.parts), partsAt,
        jsonOrNull(d.bgp), Array.isArray(d.ports) ? 1 : 0, jsonOrNull(extra));
      nd++;
      if (Array.isArray(d.ports)) {
        for (const p of d.ports) {
          const name = txt(p?.name, 64);
          if (!name) continue;
          st.upPort.run(agent, cvpId, key, name, ts, txt(p.desc, 200), numOrNull(p.speedBps), txt(p.oper, 16), txt(p.admin, 16), txt(p.vlan, 32), txt(p.lag, 64),
            numOrNull(p.inBps), numOrNull(p.outBps), numOrNull(p.inUtil), numOrNull(p.outUtil), numOrNull(p.inErr), numOrNull(p.outErr));
          np++;
          if (samples && sampleWorthy(p)) {
            const r = insertSample(st, [agent, cvpId, key, name, ts, p.inBps, p.outBps, p.inUtil, p.outUtil, p.inErr, p.outErr]);
            if (r) ns++; else dup++;
          }
        }
        // 이번 목록에 없는 포트(장비에서 사라진 것)는 지운다 — 목록을 읽었을 때만.
        st.delPortsOld.run(agent, cvpId, key, ts);
      }
    }
    conn.exec('COMMIT');
  } catch (e) { try { conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (nd || ns) _counts = null;
  return { devices: nd, ports: np, samples: ns, duplicates: dup };
}

/** 원시 표본 1행 + 일 롤업(표본이 새로 들어갔을 때만 — 재전송 이중 계수 방지). 반환: 새로 넣었는가. */
function insertSample(st, [agent, cvpId, key, port, ts, inBps, outBps, inUtil, outUtil, inErr, outErr]) {
  const v = [numOrNull(inBps), numOrNull(outBps), numOrNull(inUtil), numOrNull(outUtil), numOrNull(inErr), numOrNull(outErr)];
  const r = st.insSample.run(agent, cvpId, key, port, ts, ...v);
  if (Number(r.changes) === 0) return false;
  const [ib, ob, iu, ou, ie, oe] = v;
  st.upDaily.run(agent, cvpId, key, port, dayIndex(ts),
    ib ?? 0, ib == null ? 0 : 1, ib, ob ?? 0, ob == null ? 0 : 1, ob,
    iu ?? 0, iu == null ? 0 : 1, iu, ou ?? 0, ou == null ? 0 : 1, ou, ie, oe);
  return true;
}

/**
 * 중앙: 엣지 push 의 원시 표본 행 적재. rows: [[cvpId, deviceKey, port, ts, inBps, outBps, inUtil, outUtil, inErr, outErr], …]
 * ⚠ 호출자가 소유권(cvpId ∈ serversForAgent(agent))을 먼저 걸러야 한다.
 */
export async function importSamples(agent, rows = []) {
  const db = await open();
  if (!db) return { inserted: 0, duplicates: 0, unavailable: true };
  let ins = 0; let dup = 0;
  db.conn.exec('BEGIN');
  try {
    for (const r of rows) {
      if (insertSample(db.st, [agent, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]])) ins++; else dup++;
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (ins) _counts = null;
  return { inserted: ins, duplicates: dup };
}

/**
 * 그 agent·cvp 의 장비 중 keepKeys 에 없는 것을 지운다(인벤토리를 **온전히** 읽었을 때만 부를 것 — 일부만 보고 지우면 거짓 삭제).
 * cvpIds 가 주어지면 그 agent 의 **그 밖의 cvp** 행도 지운다(등록부에서 빠진 CVP).
 */
export async function pruneDevices(agent, keepByCvp = {}, { cvpIds = null } = {}) {
  const db = await open();
  if (!db) return { removed: 0 };
  let removed = 0;
  db.conn.exec('BEGIN');
  try {
    if (Array.isArray(cvpIds)) {
      const keep = new Set(cvpIds.map(String));
      const have = db.conn.prepare('SELECT DISTINCT cvp_id AS c FROM device_latest WHERE agent=?').all(agent).map((r) => r.c);
      for (const c of have) if (!keep.has(c)) {
        removed += Number(db.conn.prepare('DELETE FROM device_latest WHERE agent=? AND cvp_id=?').run(agent, c).changes);
        db.conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=?').run(agent, c);
      }
    }
    for (const [cvpId, keys] of Object.entries(keepByCvp)) {
      if (!Array.isArray(keys)) continue;
      const keep = new Set(keys.map(String));
      const have = db.conn.prepare('SELECT device_key AS k FROM device_latest WHERE agent=? AND cvp_id=?').all(agent, cvpId).map((r) => r.k);
      for (const k of have) if (!keep.has(k)) {
        removed += Number(db.conn.prepare('DELETE FROM device_latest WHERE agent=? AND cvp_id=? AND device_key=?').run(agent, cvpId, k).changes);
        db.conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=? AND device_key=?').run(agent, cvpId, k);
      }
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (removed) _counts = null;
  return { removed };
}

/** 최신 장비 목록(행 → 공개 모양). agent 가 null 이면 전부. */
export async function listDeviceRows({ agent = null, cvpId = null } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const where = []; const args = [];
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  const rows = db.conn.prepare(`SELECT * FROM device_latest ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY cvp_id, hostname LIMIT 20000`).all(...args);
  // 포트 요약은 장비별 집계 1회(GROUP BY 는 합계라 '최신 1건' 문제와 무관 — port_latest 는 이미 최신 표다).
  const pw = []; const pa = [];
  if (agent != null) { pw.push('agent=?'); pa.push(agent); }
  if (cvpId != null) { pw.push('cvp_id=?'); pa.push(cvpId); }
  const ports = db.conn.prepare(`SELECT agent, cvp_id, device_key, COUNT(*) AS total, SUM(oper='up') AS up, SUM(oper='down') AS down FROM port_latest ${pw.length ? `WHERE ${pw.join(' AND ')}` : ''} GROUP BY agent, cvp_id, device_key`).all(...pa);
  const pmap = new Map(ports.map((r) => [`${r.agent}\u0000${r.cvp_id}\u0000${r.device_key}`, { total: Number(r.total), up: Number(r.up || 0), down: Number(r.down || 0) }]));
  return { rows: rows.map((r) => rowToDevice(r, pmap.get(`${r.agent}\u0000${r.cvp_id}\u0000${r.device_key}`))) };
}

function rowToDevice(r, portSum) {
  const parts = parseJson(r.parts_json);
  const bgp = parseJson(r.bgp_json);
  return {
    agent: r.agent, cvpId: r.cvp_id, key: r.device_key, collectedAt: Number(r.ts),
    hostname: r.hostname || '', model: r.model || '', serial: r.serial || '', mgmtIp: r.mgmt_ip || '', eosVersion: r.eos_version || '',
    streaming: r.streaming == null ? null : r.streaming === 1,
    telemetry: r.telemetry || '',
    partsList: Array.isArray(parts) ? parts : null, partsAt: r.parts_at == null ? null : Number(r.parts_at),
    bgpPeers: Array.isArray(bgp) ? bgp : null,
    portsRead: r.ports_read === 1,
    ports: r.ports_read === 1 ? (portSum || { total: 0, up: 0, down: 0 }) : null,
    extra: parseJson(r.extra_json) || {},
  };
}

/** 장비 하나의 최신(부품·BGP 원소 포함) + 포트 목록. */
export async function deviceDetail(agent, cvpId, key) {
  const db = await open();
  if (!db) return null;
  const r = db.conn.prepare('SELECT * FROM device_latest WHERE agent=? AND cvp_id=? AND device_key=?').get(agent, cvpId, key);
  if (!r) return null;
  const ports = db.conn.prepare('SELECT * FROM port_latest WHERE agent=? AND cvp_id=? AND device_key=? ORDER BY port LIMIT 4096').all(agent, cvpId, key)
    .map((p) => ({ name: p.port, desc: p.descr || '', speedBps: p.speed_bps, oper: p.oper || 'unknown', admin: p.admin || 'unknown', vlan: p.vlan || '', lag: p.lag || '',
      inBps: p.in_bps, outBps: p.out_bps, inUtil: p.in_util, outUtil: p.out_util, inErr: p.in_err, outErr: p.out_err, ts: Number(p.ts) }));
  const pSum = { total: ports.length, up: ports.filter((p) => p.oper === 'up').length, down: ports.filter((p) => p.oper === 'down').length };
  return { device: rowToDevice(r, pSum), ports: r.ports_read === 1 ? ports : null };
}

/** 한 장비의 모든 행(엣지 push 용) — 장비 레코드 모양으로. */
export async function deviceRecordsFor(agent, cvpId) {
  const db = await open();
  if (!db) return null;
  const devs = db.conn.prepare('SELECT * FROM device_latest WHERE agent=? AND cvp_id=?').all(agent, cvpId);
  const portsBy = new Map();
  for (const p of db.conn.prepare('SELECT * FROM port_latest WHERE agent=? AND cvp_id=?').all(agent, cvpId)) {
    const k = p.device_key;
    if (!portsBy.has(k)) portsBy.set(k, []);
    portsBy.get(k).push({ name: p.port, desc: p.descr || '', speedBps: p.speed_bps, oper: p.oper, admin: p.admin, vlan: p.vlan || '', lag: p.lag || '',
      inBps: p.in_bps, outBps: p.out_bps, inUtil: p.in_util, outUtil: p.out_util, inErr: p.in_err, outErr: p.out_err });
  }
  return devs.map((r) => {
    const x = parseJson(r.extra_json) || {};
    return {
      key: r.device_key, ts: Number(r.ts), hostname: r.hostname || '', model: r.model || '', serial: r.serial || '', mgmtIp: r.mgmt_ip || '',
      eosVersion: r.eos_version || '', streaming: r.streaming == null ? null : r.streaming === 1, telemetry: r.telemetry || '',
      parts: r.parts_at == null ? undefined : parseJson(r.parts_json), partsAt: r.parts_at == null ? null : Number(r.parts_at),
      ...(Array.isArray(x.partsMissingKinds) ? { partsMissingKinds: x.partsMissingKinds } : {}),
      bgp: parseJson(r.bgp_json), ports: r.ports_read === 1 ? (portsBy.get(r.device_key) || []) : null,
    };
  });
}

/** 엣지 push 커서 — rowid 뒤의 원시 표본(로컬 행만). */
export async function samplesAfter(rowid = 0, limit = 20_000) {
  const db = await open();
  if (!db) return { rows: [], maxRowid: Number(rowid) || 0, unavailable: true };
  const rows = db.conn.prepare(`SELECT rowid AS rowid, cvp_id, device_key, port, ts, in_bps, out_bps, in_util, out_util, in_err, out_err
      FROM port_sample WHERE rowid > ? AND agent = '' ORDER BY rowid LIMIT ?`)
    .all(Number(rowid) || 0, Math.max(1, Math.min(100_000, Number(limit) || 20_000)));
  return {
    rows: rows.map((r) => [r.cvp_id, r.device_key, r.port, Number(r.ts), r.in_bps, r.out_bps, r.in_util, r.out_util, r.in_err, r.out_err]),
    maxRowid: rows.length ? Number(rows[rows.length - 1].rowid) : (Number(rowid) || 0),
  };
}
export async function maxRowid() {
  const db = await open();
  if (!db) return null;
  return Number(db.conn.prepare('SELECT MAX(rowid) AS m FROM port_sample').get()?.m || 0);
}

/**
 * 포트 추이. 요청 기간이 원시 보존일 안이면 원시(`raw`), 넘으면 일 롤업(`daily` — 평균·최대를 함께. 뜻이 다르다).
 * @returns {{ points: object[], source:'raw'|'daily', intervalMs:number, truncated?:boolean }}
 */
export async function portSeries({ agent, cvpId, key, port, hours = 24, rawRetentionDays = 7, intervalMs = 300_000, now = Date.now() }) {
  const db = await open();
  const h = Math.max(1, Math.min(24 * 3650, Number(hours) || 24));
  if (!db) return { points: [], source: 'raw', intervalMs, unavailable: true };
  const from = now - h * 3600_000;
  const LIMIT = 5000;
  if (h <= rawRetentionDays * 24) {
    const rows = db.conn.prepare(`SELECT ts, in_bps, out_bps, in_util, out_util, in_err, out_err FROM port_sample
        WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND ts>=? ORDER BY ts DESC LIMIT ?`).all(agent, cvpId, key, port, from, LIMIT + 1);
    const truncated = rows.length > LIMIT;
    const pts = rows.slice(0, LIMIT).reverse().map((r) => ({ ts: Number(r.ts), inBps: r.in_bps, outBps: r.out_bps, inUtil: r.in_util, outUtil: r.out_util, inErr: r.in_err, outErr: r.out_err }));
    return { points: pts, source: 'raw', intervalMs, ...(truncated ? { truncated: true, limit: LIMIT } : {}) };
  }
  const rows = db.conn.prepare(`SELECT * FROM port_daily WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND day>=? ORDER BY day LIMIT ?`)
    .all(agent, cvpId, key, port, dayIndex(from), LIMIT);
  const avg = (s, n) => (Number(n) > 0 ? Number(s) / Number(n) : null);
  const pts = rows.map((r) => ({
    ts: dayStartMs(r.day), inBps: avg(r.in_bps_sum, r.in_bps_n), outBps: avg(r.out_bps_sum, r.out_bps_n),
    inUtil: avg(r.in_util_sum, r.in_util_n), outUtil: avg(r.out_util_sum, r.out_util_n),
    inBpsMax: r.in_bps_max, outBpsMax: r.out_bps_max, inUtilMax: r.in_util_max, outUtilMax: r.out_util_max,
    inErr: r.in_err_sum, outErr: r.out_err_sum, samples: Number(r.samples),
  }));
  return { points: pts, source: 'daily', intervalMs: DAY_MS };
}

let _pruneTick = 0;
export const PRUNE_EVERY = 12;
/** 보존 정리 — 스로틀은 호출자가 `(++tick % N) === 0` 로(기동 첫 틱에 돌지 않게). 여기서는 요청을 공유만 한다. */
export async function prune({ rawRetentionDays = 7, dailyRetentionDays = 730, now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { deleted: 0, unavailable: true };
  const rawCut = now - Math.max(1, rawRetentionDays) * DAY_MS;
  const dayCut = dayIndex(now) - Math.max(1, dailyRetentionDays);
  return pruneFlight.run({ raw: rawCut, daily: dayCut }, async () => {
    const a = await chunkedDelete(db.conn.prepare('DELETE FROM port_sample WHERE rowid IN (SELECT rowid FROM port_sample WHERE ts < ? LIMIT ?)'), [rawCut]);
    const b = await chunkedDelete(db.conn.prepare('DELETE FROM port_daily WHERE rowid IN (SELECT rowid FROM port_daily WHERE day < ? LIMIT ?)'), [dayCut]);
    if (a.deleted || b.deleted) _counts = null;
    return { deleted: a.deleted + b.deleted, raw: a.deleted, daily: b.deleted, done: a.done && b.done };
  });
}
/** 폴러 틱마다 부른다 — N 틱에 한 번만 실제로 정리한다. */
export async function maybePrune(settings) {
  if ((++_pruneTick % PRUNE_EVERY) !== 0) return null;
  try { return await prune(settings); } catch (e) { console.warn(`[cvp-db] 보존 정리 실패: ${e.message}`); return null; }
}

/** 행 수(60초 캐시 — 캐시임을 countsAt 으로 밝힌다). */
export async function dbStats() {
  const db = await open();
  if (!db) return { available: false, note: lockRetry.note() || '' };
  if (!_counts || Date.now() - _counts.at > 60_000) {
    const c = (t) => Number(db.conn.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n || 0);
    _counts = { at: Date.now(), device: c('device_latest'), port: c('port_latest'), sample: c('port_sample'), daily: c('port_daily') };
  }
  let bytes = null;
  try { bytes = fs.statSync(FILE()).size; try { bytes += fs.statSync(`${FILE()}-wal`).size; } catch { /* wal 없음 */ } } catch { /* */ }
  return { available: true, file: FILE(), bytes, rows: { device: _counts.device, port: _counts.port, sample: _counts.sample, daily: _counts.daily }, countsAt: _counts.at };
}

export function _resetForTest() {
  try { if (_db && _db !== 'unavailable') _db.conn.close(); } catch { /* */ }
  _db = null; _opening = null; _counts = null; _pruneTick = 0; pruneFlight.reset(); lockRetry.ok();
}
