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
 *  - cvp_fault_state (PK agent,cvp_id,device_key,fault_key) — **지금 열린 장애**(v2.640, 판정은 faults.js). 파트 수만큼만 존재.
 *  - cvp_fault_event  전이만 append(open/change/close) · 보존은 dailyRetentionDays · `at` 단독 인덱스 + (agent,cvp_id,device_key,at).
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
import { portsSummary } from './parse.js';

export const LOCAL_AGENT = '';
const lockRetry = createLockRetry();
const FILE = () => path.join(config.dbDir || config.configDir, 'cvp.db');
let _db = null;       // { conn, st } | 'unavailable'
let _opening = null;
let _counts = null;   // { at, device, port, sample, daily }
const pruneFlight = createPruneFlight({ covers: (a, b) => a.raw <= b.raw && a.daily <= b.daily && (a.ev ?? 0) <= (b.ev ?? 0) });

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
        in_bps REAL, out_bps REAL, in_util REAL, out_util REAL, in_err INTEGER, out_err INTEGER, rate_ts INTEGER,
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
        in_err_n INTEGER NOT NULL DEFAULT 0, out_err_n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, cvp_id, device_key, port, day));
      CREATE INDEX IF NOT EXISTS idx_pd_day ON port_daily (day);
      CREATE TABLE IF NOT EXISTS cvp_fault_state (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, fault_key TEXT NOT NULL,
        kind TEXT NOT NULL, label TEXT, detail TEXT, state TEXT NOT NULL,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, hold_reason TEXT, notified_at INTEGER, device_name TEXT,
        PRIMARY KEY (agent, cvp_id, device_key, fault_key));
      CREATE TABLE IF NOT EXISTS cvp_fault_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, device_name TEXT,
        fault_key TEXT NOT NULL, kind TEXT NOT NULL, label TEXT, event TEXT NOT NULL,
        state TEXT, prev_state TEXT, detail TEXT, close_reason TEXT);
      CREATE INDEX IF NOT EXISTS idx_cfe_at ON cvp_fault_event (at);
      CREATE INDEX IF NOT EXISTS idx_cfe_dev ON cvp_fault_event (agent, cvp_id, device_key, at);
      CREATE TABLE IF NOT EXISTS device_sample (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, ts INTEGER NOT NULL, cpu_pct REAL, mem_pct REAL);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_ds_key ON device_sample (agent, cvp_id, device_key, ts);
      CREATE INDEX IF NOT EXISTS idx_ds_ts ON device_sample (ts);
      CREATE TABLE IF NOT EXISTS cvp_event (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, ev_key TEXT NOT NULL, ts INTEGER NOT NULL,
        severity TEXT NOT NULL, title TEXT, descr TEXT, ev_type TEXT, devices_json TEXT, ack INTEGER, updated_at INTEGER, deleted INTEGER, seen_at INTEGER NOT NULL,
        PRIMARY KEY (agent, cvp_id, ev_key, ts));
      CREATE INDEX IF NOT EXISTS idx_ce_ts ON cvp_event (ts);
      CREATE INDEX IF NOT EXISTS idx_ce_seen ON cvp_event (seen_at);`);
    addDailyErrCountCols(conn);
    addDeviceInfoCols(conn);
    const maxOf = (col) => `NULLIF(MAX(IFNULL(port_daily.${col},-1e308), IFNULL(excluded.${col},-1e308)), -1e308)`;
    const st = {
      upDevice: conn.prepare(`INSERT INTO device_latest (agent,cvp_id,device_key,ts,hostname,model,serial,mgmt_ip,eos_version,streaming,telemetry,parts_json,parts_at,bgp_json,ports_read,extra_json,info_json,sys_ts,cpu_pct,mem_pct,mem_total)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key) DO UPDATE SET ts=excluded.ts, hostname=excluded.hostname, model=excluded.model, serial=excluded.serial,
          mgmt_ip=excluded.mgmt_ip, eos_version=excluded.eos_version, streaming=excluded.streaming, telemetry=excluded.telemetry,
          parts_json=CASE WHEN excluded.parts_at IS NULL THEN device_latest.parts_json ELSE excluded.parts_json END,
          parts_at=CASE WHEN excluded.parts_at IS NULL THEN device_latest.parts_at ELSE excluded.parts_at END,
          bgp_json=excluded.bgp_json, ports_read=excluded.ports_read,
          extra_json=CASE WHEN excluded.parts_at IS NULL THEN device_latest.extra_json ELSE excluded.extra_json END,
          info_json=excluded.info_json,
          sys_ts=CASE WHEN excluded.sys_ts IS NULL OR IFNULL(device_latest.sys_ts,0) > excluded.sys_ts THEN device_latest.sys_ts ELSE excluded.sys_ts END,
          cpu_pct=CASE WHEN excluded.sys_ts IS NULL OR IFNULL(device_latest.sys_ts,0) > excluded.sys_ts THEN device_latest.cpu_pct ELSE excluded.cpu_pct END,
          mem_pct=CASE WHEN excluded.sys_ts IS NULL OR IFNULL(device_latest.sys_ts,0) > excluded.sys_ts THEN device_latest.mem_pct ELSE excluded.mem_pct END,
          mem_total=CASE WHEN excluded.sys_ts IS NULL OR IFNULL(device_latest.sys_ts,0) > excluded.sys_ts THEN device_latest.mem_total ELSE excluded.mem_total END
        WHERE excluded.ts > device_latest.ts`),
      // v2.641 ③: CPU·메모리 — 원시(7일, port_sample 과 같은 보존) + 최신값은 device_latest 열. 엣지 push 의 devSamples 도 여기로 온다.
      insDevSample: conn.prepare('INSERT OR IGNORE INTO device_sample (agent,cvp_id,device_key,ts,cpu_pct,mem_pct) VALUES (?,?,?,?,?,?)'),
      sysLatest: conn.prepare(`UPDATE device_latest SET sys_ts=?, cpu_pct=?, mem_pct=?, mem_total=COALESCE(?, mem_total)
        WHERE agent=? AND cvp_id=? AND device_key=? AND IFNULL(sys_ts,0) < ?`),
      // v2.641 ④: 이벤트 — (agent,cvp,key,ts) upsert. seen_at 은 그 이벤트를 **처음 받은 시각**(보존 기준 — 이벤트 시각이 아니다).
      upEvent: conn.prepare(`INSERT INTO cvp_event (agent,cvp_id,ev_key,ts,severity,title,descr,ev_type,devices_json,ack,updated_at,deleted,seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,ev_key,ts) DO UPDATE SET severity=excluded.severity, title=excluded.title, descr=excluded.descr, ev_type=excluded.ev_type,
          devices_json=excluded.devices_json, ack=excluded.ack, updated_at=excluded.updated_at, deleted=excluded.deleted`),
      upPort: conn.prepare(`INSERT INTO port_latest (agent,cvp_id,device_key,port,ts,descr,speed_bps,oper,admin,vlan,lag,in_bps,out_bps,in_util,out_util,in_err,out_err,rate_ts)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key,port) DO UPDATE SET ts=excluded.ts, descr=excluded.descr, speed_bps=excluded.speed_bps, oper=excluded.oper,
          admin=excluded.admin, vlan=excluded.vlan, lag=excluded.lag,
          in_bps=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_bps ELSE excluded.in_bps END,
          out_bps=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_bps ELSE excluded.out_bps END,
          in_util=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_util ELSE excluded.in_util END,
          out_util=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_util ELSE excluded.out_util END,
          in_err=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_err ELSE excluded.in_err END,
          out_err=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_err ELSE excluded.out_err END,
          rate_ts=MAX(IFNULL(port_latest.rate_ts,0), excluded.rate_ts)
        WHERE excluded.ts > port_latest.ts`),
      // 원시 표본이 오면 그 포트의 마지막 처리량도 갱신한다(엣지는 구성이 바뀌지 않은 장비 레코드를 매번 보내지 않는다 — push.js).
      rateFromSample: conn.prepare(`UPDATE port_latest SET in_bps=?, out_bps=?, in_util=?, out_util=?, in_err=?, out_err=?, rate_ts=?
        WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND IFNULL(rate_ts,0) < ?`),
      // v2.611(EDGE2611-04): 행이 **있으면** 센다(ts 는 더 클 때만 오른다) — changes 가 '중앙에 그 장비 행이 있는가' 를 말해야
      //   엣지가 없는 행을 touch 로만 보내는 것을 알아채고 레코드를 다시 보낸다(예전 `AND ts < ?` 는 같은 ts 재전송을 0 으로 셌다).
      touchDevice: conn.prepare('UPDATE device_latest SET ts=MAX(ts, ?) WHERE agent=? AND cvp_id=? AND device_key=?'),
      delPortsOld: conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=? AND device_key=? AND ts < ?'),
      selDevTs: conn.prepare('SELECT ts FROM device_latest WHERE agent=? AND cvp_id=? AND device_key=?'),
      insSample: conn.prepare('INSERT OR IGNORE INTO port_sample (agent,cvp_id,device_key,port,ts,in_bps,out_bps,in_util,out_util,in_err,out_err) VALUES (?,?,?,?,?,?,?,?,?,?,?)'),
      upDaily: conn.prepare(`INSERT INTO port_daily (agent,cvp_id,device_key,port,day,samples,in_bps_sum,in_bps_n,in_bps_max,out_bps_sum,out_bps_n,out_bps_max,
          in_util_sum,in_util_n,in_util_max,out_util_sum,out_util_n,out_util_max,in_err_sum,out_err_sum,in_err_n,out_err_n)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key,port,day) DO UPDATE SET samples=port_daily.samples+1,
          in_bps_sum=port_daily.in_bps_sum+excluded.in_bps_sum, in_bps_n=port_daily.in_bps_n+excluded.in_bps_n, in_bps_max=${maxOf('in_bps_max')},
          out_bps_sum=port_daily.out_bps_sum+excluded.out_bps_sum, out_bps_n=port_daily.out_bps_n+excluded.out_bps_n, out_bps_max=${maxOf('out_bps_max')},
          in_util_sum=port_daily.in_util_sum+excluded.in_util_sum, in_util_n=port_daily.in_util_n+excluded.in_util_n, in_util_max=${maxOf('in_util_max')},
          out_util_sum=port_daily.out_util_sum+excluded.out_util_sum, out_util_n=port_daily.out_util_n+excluded.out_util_n, out_util_max=${maxOf('out_util_max')},
          in_err_sum=CASE WHEN excluded.in_err_sum IS NULL THEN port_daily.in_err_sum ELSE IFNULL(port_daily.in_err_sum,0)+excluded.in_err_sum END,
          out_err_sum=CASE WHEN excluded.out_err_sum IS NULL THEN port_daily.out_err_sum ELSE IFNULL(port_daily.out_err_sum,0)+excluded.out_err_sum END,
          in_err_n=port_daily.in_err_n+excluded.in_err_n, out_err_n=port_daily.out_err_n+excluded.out_err_n`),
      // ── 장애 전이(v2.640, faults.js) — 전이만 적재. state 표는 파트 수만큼만 존재하고 event 는 open/change/close 만 append.
      fOpen: conn.prepare(`INSERT INTO cvp_fault_state (agent,cvp_id,device_key,fault_key,kind,label,detail,state,first_seen,last_seen,hold_reason,notified_at,device_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
        ON CONFLICT(agent,cvp_id,device_key,fault_key) DO UPDATE SET kind=excluded.kind, label=excluded.label, detail=excluded.detail, state=excluded.state,
          last_seen=excluded.last_seen, hold_reason=NULL, device_name=excluded.device_name`),
      fChange: conn.prepare('UPDATE cvp_fault_state SET state=?, detail=?, label=?, last_seen=?, hold_reason=NULL, device_name=? WHERE agent=? AND cvp_id=? AND device_key=? AND fault_key=?'),
      fSustain: conn.prepare('UPDATE cvp_fault_state SET detail=?, last_seen=?, hold_reason=NULL WHERE agent=? AND cvp_id=? AND device_key=? AND fault_key=?'),
      fHold: conn.prepare('UPDATE cvp_fault_state SET hold_reason=? WHERE agent=? AND cvp_id=? AND device_key=? AND fault_key=?'),
      fDel: conn.prepare('DELETE FROM cvp_fault_state WHERE agent=? AND cvp_id=? AND device_key=? AND fault_key=?'),
      fGet: conn.prepare('SELECT * FROM cvp_fault_state WHERE agent=? AND cvp_id=? AND device_key=? AND fault_key=?'),
      fNotified: conn.prepare('UPDATE cvp_fault_state SET notified_at=? WHERE agent=? AND cvp_id=? AND device_key=? AND fault_key=?'),
      fEvent: conn.prepare(`INSERT INTO cvp_fault_event (at,agent,cvp_id,device_key,fault_key,device_name,kind,label,event,state,prev_state,detail,close_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
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

/**
 * v2.611(DB2611-06): 일 롤업 오류 합의 표본 수 열 — 없는 열만 더한다(table_info 로 확인 · 'duplicate column name' 만 삼킨다 —
 * 잠금 등 다른 오류를 '열 있음' 으로 삼키면 이후 upsert 가 매번 실패한다: v2.603 DB2603-01 규약).
 */
function addDailyErrCountCols(conn) {
  const have = new Set(conn.prepare('PRAGMA table_info(port_daily)').all().map((r) => r.name));
  for (const col of ['in_err_n', 'out_err_n']) {
    if (have.has(col)) continue;
    try { conn.exec(`ALTER TABLE port_daily ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); }
    catch (e) { if (!/duplicate column name/i.test(String(e?.message || ''))) throw e; }
  }
}

/** v2.641: device_latest 의 개요·CPU·메모리 열 — 없는 열만 더한다(DB2603-01 규약: 'duplicate column name' 만 삼킨다). */
function addDeviceInfoCols(conn) {
  const have = new Set(conn.prepare('PRAGMA table_info(device_latest)').all().map((r) => r.name));
  for (const [col, type] of [['info_json', 'TEXT'], ['sys_ts', 'INTEGER'], ['cpu_pct', 'REAL'], ['mem_pct', 'REAL'], ['mem_total', 'REAL']]) {
    if (have.has(col)) continue;
    try { conn.exec(`ALTER TABLE device_latest ADD COLUMN ${col} ${type}`); }
    catch (e) { if (!/duplicate column name/i.test(String(e?.message || ''))) throw e; }
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
/** 0~100 퍼센트만(범위 밖은 null — 지어낸 100% 로 자르지 않는다: v2.578 D3). */
const pctOrNull = (v) => { const n = numOrNull(v); return n == null || n < 0 || n > 100 ? null : n; };
/**
 * v2.641 ②: 장비 개요 — 아는 필드만 저장(엣지가 보낸 값도 cvpEdge.cleanDevice 가 먼저 좁힌다). 없으면 null(행의 개요를 지운다 —
 *   이번 주기에 못 읽었다는 뜻이다. '예전 값' 을 지금 값처럼 두지 않는다).
 */
export const INFO_KEYS = Object.freeze(['mac', 'fqdn', 'hwRevision', 'bootAt', 'status', 'complianceCode', 'complianceIndication', 'container', 'ztpMode', 'mlag', 'internalVersion', 'lifecycle', 'bugs', 'readKinds', 'portsEmpty', 'bgpEmpty']);
function infoOf(d) {
  const src = d && typeof d.info === 'object' && d.info ? d.info : {};
  const out = {};
  for (const k of INFO_KEYS) {
    const v = Object.hasOwn(src, k) ? src[k] : Object.hasOwn(d || {}, k) ? d[k] : undefined;
    if (v !== undefined && v !== null && v !== '') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 포트 행이 원시 표본으로 적재될 만한가 — 링크가 올라와 있고 지표가 하나라도 있다. */
export const sampleWorthy = (p) => !!p && p.oper === 'up' && ['inBps', 'outBps', 'inUtil', 'outUtil', 'inErr', 'outErr'].some((k) => p[k] != null);

/**
 * 장비 레코드 목록을 적재한다(트랜잭션 1회). 엣지 push·로컬 수집 공용.
 * device: { key, ts, hostname, model, serial, mgmtIp, eosVersion, streaming, telemetry, parts(undefined=이번에 안 읽음·null=못 읽음·배열),
 *   partsAt, partsMissingKinds, bgp(null|배열), ports(null|배열) } · ports[]: { name, desc, speedBps, oper, admin, vlan, lag, inBps.. }
 * @param {{agent:string, cvpId:string, devices:object[], samples?:boolean}} a  samples=true 면 포트 지표를 원시 표본으로도 넣는다(로컬 수집).
 * @returns {Promise<{devices:number, ports:number, samples:number, duplicates:number, unavailable?:boolean}>}
 */
/**
 * v2.612 PERF2612-02: 장비 SAVE_TXN_DEVICES 대씩 트랜잭션을 나누고 **COMMIT 뒤** 양보한다(importSamples 와 같은 모양 — v2.611 DB2611-04).
 *   예전에는 CVP 한 대분(1,000대 × 64포트)을 한 트랜잭션으로 써 매 주기 약 0.6초 이벤트 루프가 멈췄다. 한 장비의 포트·표본·
 *   delPortsOld 는 같은 트랜잭션 안에 남으므로 재전송 이중 계수 방지는 그대로다.
 */
export const SAVE_TXN_DEVICES = 30;
export async function saveDevices({ agent = LOCAL_AGENT, cvpId, devices = [], samples = false, txnDevices = SAVE_TXN_DEVICES }) {
  const db = await open();
  if (!db) return { devices: 0, ports: 0, samples: 0, duplicates: 0, unavailable: true };
  const { st, conn } = db;
  let nd = 0; let np = 0; let ns = 0; let dup = 0; let stalePorts = 0;
  const per = Math.max(1, Math.floor(Number(txnDevices)) || SAVE_TXN_DEVICES);
  const list = Array.isArray(devices) ? devices : [];
  for (let i = 0; i < list.length; i += per) {
    if (i > 0) await new Promise((r) => setImmediate(r));
    conn.exec('BEGIN');
    try {
      for (const d of list.slice(i, i + per)) {
        const ts = numOrNull(d.ts);
        const key = txt(d.key, 128);
        if (!key || ts == null) continue;
        // v2.612 DB2612-01: 이미 같거나 더 새 레코드가 있으면 포트 목록을 건드리지 않는다 — 늦게 온 옛 레코드의 upPort INSERT 가
        //   그 사이 지워진 포트를 되살리고 delPortsOld 가 새 포트를 지울 수 있었다(장비 행은 upsert 의 ts 가드가 막는다).
        const prevTs = numOrNull(st.selDevTs.get(agent, cvpId, key)?.ts);
        const olderRecord = prevTs != null && ts <= prevTs;
        const partsAt = d.parts === undefined ? null : (numOrNull(d.partsAt) ?? ts);
        const extra = d.partsMissingKinds || d.cvpVersion ? { partsMissingKinds: Array.isArray(d.partsMissingKinds) ? d.partsMissingKinds.slice(0, 8) : undefined } : null;
        st.upDevice.run(agent, cvpId, key, ts, txt(d.hostname), txt(d.model), txt(d.serial), txt(d.mgmtIp, 64), txt(d.eosVersion, 64),
          boolInt(d.streaming), txt(d.telemetry, 32), d.parts === undefined ? null : jsonOrNull(d.parts), partsAt,
          jsonOrNull(d.bgp), Array.isArray(d.ports) ? 1 : 0, jsonOrNull(extra),
          jsonOrNull(infoOf(d), 64 * 1024), numOrNull(d.sysAt), pctOrNull(d.cpuPct), pctOrNull(d.memPct), numOrNull(d.memTotal));
        nd++;
        // v2.641 ③: CPU·메모리 원시 표본(로컬 수집만 — 엣지 push 는 devSamples 로 따로 온다).
        if (samples && numOrNull(d.sysAt) != null && (pctOrNull(d.cpuPct) != null || pctOrNull(d.memPct) != null)) {
          const r = st.insDevSample.run(agent, cvpId, key, numOrNull(d.sysAt), pctOrNull(d.cpuPct), pctOrNull(d.memPct));
          if (Number(r.changes)) ns++;
        }
        if (Array.isArray(d.ports)) {
          if (olderRecord) stalePorts++;
          for (const p of d.ports) {
            const name = txt(p?.name, 64);
            if (!name) continue;
            if (!olderRecord) {
              st.upPort.run(agent, cvpId, key, name, ts, txt(p.desc, 200), numOrNull(p.speedBps), txt(p.oper, 16), txt(p.admin, 16), txt(p.vlan, 32), txt(p.lag, 64),
                numOrNull(p.inBps), numOrNull(p.outBps), numOrNull(p.inUtil), numOrNull(p.outUtil), numOrNull(p.inErr), numOrNull(p.outErr), ts);
              np++;
            }
            if (samples && sampleWorthy(p)) {
              const r = insertSample(st, [agent, cvpId, key, name, ts, p.inBps, p.outBps, p.inUtil, p.outUtil, p.inErr, p.outErr]);
              if (r) ns++; else dup++;
            }
          }
          // 이번 목록에 없는 포트(장비에서 사라진 것)는 지운다 — 목록을 읽었을 때만, 그리고 이 레코드가 최신일 때만(DB2612-01).
          if (!olderRecord) st.delPortsOld.run(agent, cvpId, key, ts);
        }
      }
      conn.exec('COMMIT');
    } catch (e) { try { conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  }
  if (nd || ns) _counts = null;
  return { devices: nd, ports: np, samples: ns, duplicates: dup, ...(stalePorts ? { stalePorts } : {}) };
}

/** 원시 표본 1행 + 일 롤업(표본이 새로 들어갔을 때만 — 재전송 이중 계수 방지). 반환: 새로 넣었는가. */
function insertSample(st, [agent, cvpId, key, port, ts, inBps, outBps, inUtil, outUtil, inErr, outErr]) {
  const v = [numOrNull(inBps), numOrNull(outBps), numOrNull(inUtil), numOrNull(outUtil), numOrNull(inErr), numOrNull(outErr)];
  const r = st.insSample.run(agent, cvpId, key, port, ts, ...v);
  if (Number(r.changes) === 0) return false;
  const [ib, ob, iu, ou, ie, oe] = v;
  st.upDaily.run(agent, cvpId, key, port, dayIndex(ts),
    ib ?? 0, ib == null ? 0 : 1, ib, ob ?? 0, ob == null ? 0 : 1, ob,
    iu ?? 0, iu == null ? 0 : 1, iu, ou ?? 0, ou == null ? 0 : 1, ou, ie, oe, ie == null ? 0 : 1, oe == null ? 0 : 1);
  return true;
}

/**
 * 중앙: 엣지 push 의 원시 표본 행 적재. rows: [[cvpId, deviceKey, port, ts, inBps, outBps, inUtil, outUtil, inErr, outErr], …]
 * ⚠ 호출자가 소유권(cvpId ∈ serversForAgent(agent))을 먼저 걸러야 한다.
 */
export const IMPORT_TXN_ROWS = 2_000;
export async function importSamples(agent, rows = []) {
  const db = await open();
  if (!db) return { inserted: 0, duplicates: 0, unavailable: true };
  let ins = 0; let dup = 0;
  /*
   * v2.611(DB2611-04): 2,000행 단위 트랜잭션 + **COMMIT 뒤** 양보. 한 번에 수만 행을 동기로 넣으면 그동안 이벤트 루프가 멈춘다
   *   (30만 행 표에서 7,600행 170ms 실측). ⚠ 양보는 반드시 COMMIT 뒤 — BEGIN 을 연 채 양보하면 같은 연결을 쓰는 다른 요청의
   *   BEGIN 이 'cannot start a transaction within a transaction' 으로 실패한다(재현). 한 행의 INSERT·일 롤업·최신 갱신은
   *   같은 하위 트랜잭션 안이라 재전송 이중 계수 방지(INSERT OR IGNORE + changes — v2.550.3)는 그대로다.
   */
  for (let i = 0; i < rows.length; i += IMPORT_TXN_ROWS) {
    if (i > 0) await new Promise((r) => setImmediate(r));
    const part = rows.slice(i, i + IMPORT_TXN_ROWS);
    db.conn.exec('BEGIN');
    try {
      for (const r of part) {
        if (insertSample(db.st, [agent, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]])) {
          ins++;
          const v = [r[4], r[5], r[6], r[7], r[8], r[9]].map(numOrNull);
          db.st.rateFromSample.run(...v, r[3], agent, r[0], r[1], r[2], r[3]);
        } else dup++;
      }
      db.conn.exec('COMMIT');
    } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  }
  if (ins) _counts = null;
  return { inserted: ins, duplicates: dup };
}

/**
 * 중앙: 구성이 바뀌지 않아 레코드 없이 온 장비의 수집 시각만 올린다(엣지 push 의 touch — [cvpId, key, ts]).
 * ⚠ 호출자가 소유권을 먼저 걸러야 한다.
 */
export async function touchDevices(agent, touch = []) {
  if (!touch.length) return { touched: 0 };
  const db = await open();
  if (!db) return { touched: 0, unavailable: true };
  let n = 0;
  db.conn.exec('BEGIN');
  try {
    for (const [cvpId, key, ts] of touch) n += Number(db.st.touchDevice.run(ts, agent, cvpId, key).changes);
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  return { touched: n };
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

/**
 * v2.611(CEN2611-02): 같은 엣지가 대소문자만 다른 이름으로 남긴 행을 저장 키(agentKey) 하나로 모은다(프로세스당 키마다 1회).
 * 변형 이름은 작은 최신 표(device_latest·port_latest)에서 찾고, 표본·일 롤업은 인덱스 선행열(agent)로 옮긴다.
 *
 * v2.612 PERF2612-01: 옮기기는 **행 청크**(ADOPT_CHUNK_ROWS)마다 트랜잭션 · COMMIT 뒤 양보다. 예전에는 표마다 UPDATE 한 문장이라
 *   원시 표본 100만 행에 약 13초 이벤트 루프가 멈췄다(cvp-data 요청 처리 중). 그리고 **요청을 붙잡지 않는다** — 호출부
 *   (routes/central.js 의 cvp-data)는 결과를 기다리지만 이 함수는 옮기기를 백그라운드로 시작하고 곧바로 돌아온다(키마다 한 번만 —
 *   진행 중이면 같은 작업을 공유). 옮기는 동안 새 push 는 저장 키로 적재되고 변형 행과의 충돌은 아래 규칙이 합친다.
 *   { wait:true } 는 끝날 때까지 기다린다(테스트·수동 정리).
 * v2.612 RECENT2612-04: 충돌을 **버리지 않고 합친다** — 예전 UPDATE OR IGNORE 뒤 DELETE 는 같은 날 일 롤업(표본 수·합·최대)을
 *   통째로 잃었다. 일 롤업은 upDaily 와 같은 규칙(합·표본 수는 더하고 최대는 MAX)으로 저장 키 행에 더하고, 최신 표는 ts 가 더 큰
 *   쪽을 남긴다. 원시 표본은 (…, ts) 가 같으면 같은 측정이라 한 벌만 남긴다.
 */
export const ADOPT_CHUNK_ROWS = 5_000;
const _adopted = new Set();
const _adopting = new Map(); // key → Promise
const ADOPT_PK = {
  device_latest: ['cvp_id', 'device_key'],
  port_latest: ['cvp_id', 'device_key', 'port'],
  port_sample: ['cvp_id', 'device_key', 'port', 'ts'],
  port_daily: ['cvp_id', 'device_key', 'port', 'day'],
};
const IN_CHUNK = 'rowid IN (SELECT value FROM json_each(?))';
function dailyMergeSql() {
  const mx = (c) => `${c}=NULLIF(MAX(IFNULL(port_daily.${c},-1e308), IFNULL(v.${c},-1e308)), -1e308)`;
  const errSum = (c) => `${c}=CASE WHEN v.${c} IS NULL THEN port_daily.${c} ELSE IFNULL(port_daily.${c},0)+v.${c} END`;
  const sums = ['in_bps', 'out_bps', 'in_util', 'out_util'].flatMap((m) => [`${m}_sum=port_daily.${m}_sum+v.${m}_sum`, `${m}_n=port_daily.${m}_n+v.${m}_n`, mx(`${m}_max`)]);
  return `UPDATE port_daily SET samples=port_daily.samples+v.samples, ${sums.join(', ')},
      ${errSum('in_err_sum')}, ${errSum('out_err_sum')}, in_err_n=port_daily.in_err_n+v.in_err_n, out_err_n=port_daily.out_err_n+v.out_err_n
    FROM (SELECT * FROM port_daily WHERE ${IN_CHUNK}) AS v
    WHERE port_daily.agent=? AND ${ADOPT_PK.port_daily.map((c) => `port_daily.${c}=v.${c}`).join(' AND ')}`;
}
async function adoptTable(db, t, key, variant, chunkRows) {
  const pk = ADOPT_PK[t];
  const sel = db.conn.prepare(`SELECT rowid AS r FROM ${t} WHERE agent=? LIMIT ?`);
  const newerVariant = t === 'device_latest' || t === 'port_latest'
    ? db.conn.prepare(`DELETE FROM ${t} WHERE agent=? AND EXISTS (SELECT 1 FROM ${t} v WHERE v.${IN_CHUNK} AND v.agent=? AND ${pk.map((c) => `v.${c}=${t}.${c}`).join(' AND ')} AND v.ts > ${t}.ts)`)
    : null;
  const mergeDaily = t === 'port_daily' ? db.conn.prepare(dailyMergeSql()) : null;
  const move = db.conn.prepare(`UPDATE OR IGNORE ${t} SET agent=? WHERE agent=? AND ${IN_CHUNK}`);
  const dropRest = db.conn.prepare(`DELETE FROM ${t} WHERE agent=? AND ${IN_CHUNK}`);
  let moved = 0; let merged = 0;
  for (;;) {
    const ids = sel.all(variant, chunkRows).map((x) => x.r);
    if (!ids.length) break;
    const j = JSON.stringify(ids);
    db.conn.exec('BEGIN');
    try {
      if (newerVariant) newerVariant.run(key, j, variant);          // 변형 쪽이 더 새 최신 행이면 저장 키 행을 비운다
      if (mergeDaily) merged += Number(mergeDaily.run(j, key).changes); // 같은 날 일 롤업은 합친다
      moved += Number(move.run(key, variant, j).changes);
      dropRest.run(variant, j);                                        // 남은 것은 합쳤거나(일 롤업) 저장 키 쪽이 새것·같은 측정이다
      db.conn.exec('COMMIT');
    } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
    await new Promise((r) => setImmediate(r)); // COMMIT 뒤에만 양보(v2.611 DB2611-04)
  }
  return { moved, merged };
}
async function runAdopt(db, key, variants, chunkRows) {
  let moved = 0; let merged = 0;
  for (const v of variants) {
    for (const t of Object.keys(ADOPT_PK)) {
      const r = await adoptTable(db, t, key, v, chunkRows);
      moved += r.moved; merged += r.merged;
    }
  }
  _counts = null;
  console.warn(`[cvp-db] 대소문자만 다른 엣지 이름 ${variants.map((x) => `'${capStr(x, 64)}'`).join(', ')} 의 행을 '${capStr(key, 64)}' 로 모았습니다(${moved}행 이동 · 같은 날 일 롤업 ${merged}행 합침)`);
  return { moved, merged, variants };
}
export async function adoptAgentVariants(agentKey, { wait = false, chunkRows = ADOPT_CHUNK_ROWS } = {}) {
  const key = String(agentKey ?? '');
  if (!key || _adopted.has(key)) return { moved: 0, variants: [] };
  let job = _adopting.get(key);
  if (!job) {
    const db = await open();
    if (!db) return { moved: 0, variants: [], unavailable: true };
    job = _adopting.get(key); // open 을 기다리는 사이 다른 호출이 시작했을 수 있다
    if (!job) {
      const lo = key.toLowerCase();
      const found = new Set();
      for (const t of ['device_latest', 'port_latest']) {
        for (const r of db.conn.prepare(`SELECT DISTINCT agent AS a FROM ${t} WHERE agent <> '' AND LOWER(TRIM(agent)) = ?`).all(lo)) if (r.a !== key) found.add(r.a);
      }
      if (!found.size) { _adopted.add(key); return { moved: 0, variants: [] }; }
      const per = Math.max(1, Math.floor(Number(chunkRows)) || ADOPT_CHUNK_ROWS);
      job = runAdopt(db, key, [...found], per)
        .then((r) => { _adopted.add(key); return r; })
        .catch((e) => { console.warn(`[cvp-db] 엣지 이름 변형 행 모으기 실패('${capStr(key, 64)}') — 다음 push 때 다시 시도합니다: ${e.message}`); throw e; })
        .finally(() => { _adopting.delete(key); });
      job.catch(() => { /* 위에서 콘솔에 남겼다 — 백그라운드 실행의 unhandled rejection 방지 */ });
      _adopting.set(key, job);
    }
  }
  if (wait) return job;
  return { moved: 0, variants: [], background: true };
}

/** 그 agent·cvp 의 장비 행 수(COL2611-05 prune 보류 판정용). DB 불가면 null. */
export async function deviceCount(agent, cvpId) {
  const db = await open();
  if (!db) return null;
  return Number(db.conn.prepare('SELECT COUNT(*) AS n FROM device_latest WHERE agent=? AND cvp_id=?').get(agent, cvpId)?.n || 0);
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
  const ports = db.conn.prepare(`SELECT agent, cvp_id, device_key, COUNT(*) AS total, SUM(oper='up') AS up, SUM(oper='down' AND admin='up') AS down, SUM(oper='nolink') AS nolink FROM port_latest ${pw.length ? `WHERE ${pw.join(' AND ')}` : ''} GROUP BY agent, cvp_id, device_key`).all(...pa);
  const pmap = new Map(ports.map((r) => [`${r.agent}\u0000${r.cvp_id}\u0000${r.device_key}`, { total: Number(r.total), up: Number(r.up || 0), down: Number(r.down || 0), ...(Number(r.nolink) > 0 ? { noLink: Number(r.nolink) } : {}) }]));
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
    // v2.641: 개요·CPU·메모리(열이 없던 구버전 행은 null — 못 읽음)
    info: parseJson(r.info_json) || null,
    sysAt: r.sys_ts == null ? null : Number(r.sys_ts), cpuPct: r.cpu_pct ?? null, memPct: r.mem_pct ?? null, memTotal: r.mem_total ?? null,
  };
}

/**
 * v2.643: 이벤트의 장비 식별자(대개 시리얼) → 장비 키·호스트명 색인. 이벤트 화면이 시리얼 대신 호스트명을 보이고
 *   클릭하면 장비 상세를 열게 한다. 행 수는 장비 수(수백)라 가볍다 — 이벤트 행마다 조회하지 않고 한 번에 읽는다.
 * @returns {Promise<{rows:Array<{agent:string,cvpId:string,key:string,serial:string,hostname:string}>, unavailable?:true}>}
 */
export async function deviceNameIndex({ cvpId = null } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const rows = db.conn.prepare(`SELECT agent, cvp_id, device_key, serial, hostname FROM device_latest ${cvpId != null ? 'WHERE cvp_id=?' : ''} LIMIT 20000`).all(...(cvpId != null ? [cvpId] : []));
  return { rows: rows.map((r) => ({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, serial: r.serial || '', hostname: r.hostname || '' })) };
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
  // v2.630 A2-02: 합계 판정은 parse.portsSummary 하나를 쓴다(미연결 'nolink' 는 down 이 아니다 — 개수는 noLink).
  const pSum = portsSummary(ports);
  return { device: rowToDevice(r, pSum), ports: r.ports_read === 1 ? ports : null };
}

/** 그 장비 행을 가진 agent 목록(최신 순) — 화면이 등록부 담당과 맞는 행을 고르는 데 쓴다. */
export async function agentsForDevice(cvpId, key) {
  const db = await open();
  if (!db) return [];
  return db.conn.prepare('SELECT agent FROM device_latest WHERE cvp_id=? AND device_key=? ORDER BY ts DESC LIMIT 16').all(cvpId, key).map((r) => r.agent);
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
      info: parseJson(r.info_json) || null,
      sysAt: r.sys_ts == null ? null : Number(r.sys_ts), cpuPct: r.cpu_pct ?? null, memPct: r.mem_pct ?? null, memTotal: r.mem_total ?? null,
    };
  });
}

/** 엣지 push 커서 — rowid 뒤의 원시 표본(로컬 행만). */
export async function samplesAfter(rowid = 0, limit = 20_000) {
  const db = await open();
  if (!db) return { rows: [], maxRowid: Number(rowid) || 0, unavailable: true };
  const rows = db.conn.prepare(`SELECT rowid AS rowid, cvp_id, device_key, port, ts, in_bps, out_bps, in_util, out_util, in_err, out_err
      FROM port_sample WHERE rowid > ? AND +agent = '' ORDER BY rowid LIMIT ?`)
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
  const legacyN = (n, sum) => (Number(n) === 0 && sum != null ? null : Number(n) || 0);
  const pts = rows.map((r) => ({
    ts: dayStartMs(r.day), inBps: avg(r.in_bps_sum, r.in_bps_n), outBps: avg(r.out_bps_sum, r.out_bps_n),
    inUtil: avg(r.in_util_sum, r.in_util_n), outUtil: avg(r.out_util_sum, r.out_util_n),
    inBpsMax: r.in_bps_max, outBpsMax: r.out_bps_max, inUtilMax: r.in_util_max, outUtilMax: r.out_util_max,
    inErr: r.in_err_sum, outErr: r.out_err_sum, samples: Number(r.samples),
    // v2.611(DB2611-06): 오류 합은 **델타를 만든 표본만** 더한 부분 합이다(첫 표본·간격 비정상·카운터 리셋은 null).
    //   몇 표본의 합인지(inErrN)를 함께 준다 — samples 와 다르면 하루 전체의 오류가 아니다. 열 추가 전(구버전) 행은 null(모름).
    inErrN: legacyN(r.in_err_n, r.in_err_sum), outErrN: legacyN(r.out_err_n, r.out_err_sum),
  }));
  return { points: pts, source: 'daily', intervalMs: DAY_MS };
}

/* ── 장애 전이(v2.640) — 판정은 cvp/faults.js(순수), 적재는 여기. 규약은 partfault/db.js 와 같다:
 *   state 표(cvp_fault_state)는 **지우지 말 것** — 없으면 매 주기가 전부 새 장애(알림 폭주). 재시작에도 살아야 하므로 DB 다.
 *   held(유지)는 이벤트를 만들지 않는다(사유만 갱신) · 같은 상태의 지속도 이벤트가 아니다(전이 표가 전량 적재가 된다). */

const fArgs = (f) => [String(f.agent ?? ''), String(f.cvpId ?? ''), String(f.deviceKey ?? ''), String(f.faultKey ?? '')];
function rowToFault(r) {
  return {
    agent: r.agent, cvpId: r.cvp_id, deviceKey: r.device_key, deviceName: r.device_name || '',
    faultKey: r.fault_key, kind: r.kind, label: r.label || '', detail: r.detail || '', state: r.state,
    firstSeen: Number(r.first_seen), lastSeen: Number(r.last_seen), holdReason: r.hold_reason || null,
    notifiedAt: r.notified_at == null ? null : Number(r.notified_at),
  };
}
function rowToFaultEvent(r) {
  return {
    id: Number(r.id), at: Number(r.at), agent: r.agent, cvpId: r.cvp_id, deviceKey: r.device_key, deviceName: r.device_name || '',
    faultKey: r.fault_key, kind: r.kind, label: r.label || '', event: r.event, state: r.state ?? null, prevState: r.prev_state ?? null,
    detail: r.detail || '', closeReason: r.close_reason ?? null,
  };
}

/** 포트 상태 전량(port_latest — 한 쿼리). 장애 판정(faults.observeDevice)이 장비별로 묶어 쓴다. */
export async function portStateRows({ agent = null, cvpId = null } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const where = []; const args = [];
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  const rows = db.conn.prepare(`SELECT agent, cvp_id, device_key, port, oper, admin, descr FROM port_latest ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...args);
  return { rows: rows.map((r) => ({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, port: r.port, oper: r.oper || 'unknown', admin: r.admin || 'unknown', desc: r.descr || '' })) };
}

/** 열린 장애(공개 모양). limit 상한을 넘긴 행은 전이 입력에 없다 — v2.548 리뷰가 기록한 같은 한계. */
export async function listOpenFaults({ agent = null, cvpId = null, limit = 20_000 } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const where = []; const args = [];
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  const lim = Math.max(1, Math.min(50_000, Math.trunc(Number(limit)) || 20_000));
  const rows = db.conn.prepare(`SELECT * FROM cvp_fault_state ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY first_seen DESC LIMIT ?`).all(...args, lim);
  return { rows: rows.map(rowToFault), ...(rows.length >= lim ? { truncated: true, limit: lim } : {}) };
}

/**
 * 전이 결과(faults.transition)를 **트랜잭션 1회**로 반영한다. opened → INSERT + 'open' · updated(상태 변화) → UPDATE + 'change' ·
 * updated(같은 상태) → last_seen 만 · held → hold_reason 만 · closed → DELETE + 'close'. 실패하면 ROLLBACK 하고 던진다(부분 반영 금지).
 * @returns {Promise<{opened:number, updated:number, closed:number, held:number, events:number, unavailable?:boolean}>}
 */
export async function applyFaultTransition(tr, { now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { opened: 0, updated: 0, closed: 0, held: 0, events: 0, unavailable: true };
  const { st, conn } = db;
  const T = (v, n = 256) => capStr(v, n);
  // 상태는 문자열 그대로(String(null) 은 'null' 이 되어 NOT NULL 제약을 지나간다 — 잘못된 전이는 제약 위반으로 트랜잭션째 실패해야 한다).
  const stateOf = (v) => (typeof v === 'string' && v ? v : null);
  const ev = (f, event, { state = f.state ?? null, prevState = null, closeReason = null, detail = f.detail } = {}) => {
    st.fEvent.run(now, ...fArgs(f), T(f.deviceName, 128), T(f.kind, 16), T(f.label, 128), event, state, prevState, T(detail, 400), closeReason);
  };
  let opened = 0; let updated = 0; let closed = 0; let held = 0; let events = 0;
  conn.exec('BEGIN');
  try {
    for (const f of tr?.opened || []) {
      st.fOpen.run(...fArgs(f), T(f.kind, 16), T(f.label, 128), T(f.detail, 400), stateOf(f.state), numOrNull(f.firstSeen) ?? now, numOrNull(f.lastSeen) ?? now, T(f.deviceName, 128));
      ev(f, 'open'); opened++; events++;
    }
    for (const f of tr?.updated || []) {
      if (f.sameState) { st.fSustain.run(T(f.detail, 400), numOrNull(f.lastSeen) ?? now, ...fArgs(f)); continue; }
      st.fChange.run(stateOf(f.state), T(f.detail, 400), T(f.label, 128), numOrNull(f.lastSeen) ?? now, T(f.deviceName, 128), ...fArgs(f));
      ev(f, 'change', { prevState: f.prevState ?? null }); updated++; events++;
    }
    for (const f of tr?.held || []) { st.fHold.run(T(f.holdReason, 32) || null, ...fArgs(f)); held++; }
    for (const f of tr?.closed || []) {
      st.fDel.run(...fArgs(f));
      ev(f, 'close', { state: null, prevState: f.state ?? null, closeReason: T(f.closeReason, 64) || 'ok', detail: f.closeDetail ?? f.detail });
      closed++; events++;
    }
    conn.exec('COMMIT');
  } catch (e) { try { conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  return { opened, updated, closed, held, events };
}

/** 알림 발송 시각 — (agent,cvpId,deviceKey,faultKey) 를 받는다. 반환은 **실제로 갱신된 행 수**. */
export async function markFaultNotified(items, { now = Date.now() } = {}) {
  const db = await open();
  if (!db || !Array.isArray(items) || !items.length) return 0;
  let n = 0;
  db.conn.exec('BEGIN');
  try {
    for (const it of items) { if (it && it.faultKey) n += Number(db.st.fNotified.run(now, ...fArgs(it)).changes || 0); }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  return n;
}

/** 최근 전이 이벤트(at DESC). limit 은 정수 [1, 5000](node:sqlite 는 소수를 REAL 로 바인딩한다 — v2.607 DB2607-04). */
export async function recentFaultEvents({ sinceMs = 30 * 86_400_000, limit = 500, cvpId = null, agent = null } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const since = Math.trunc(Date.now() - Math.max(0, numOrNull(sinceMs) ?? 0));
  const lim = Math.max(1, Math.min(5_000, Math.trunc(Number(limit)) || 500));
  const where = ['at >= ?']; const args = [since];
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  const rows = db.conn.prepare(`SELECT * FROM cvp_fault_event WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, lim);
  return { rows: rows.map(rowToFaultEvent), ...(rows.length >= lim ? { truncated: true, limit: lim } : {}) };
}

/**
 * 관리자 수동 닫기(장비 재배정·등록 삭제로 보고가 끊긴 장애 — 보고 부재 ≠ 고침이라 자동으로 닫지 않는다: v2.548 리뷰 C5).
 * 이벤트 close_reason 은 `manual:<user>`, detail 은 사유. 반환 {ok, closed}(없으면 closed 0).
 */
export async function closeFaultManual({ agent = '', cvpId, deviceKey, faultKey, reason = '', user = '', now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { ok: false, closed: 0, unavailable: true };
  const key = { agent, cvpId, deviceKey, faultKey };
  const row = db.st.fGet.get(...fArgs(key));
  if (!row) return { ok: true, closed: 0 };
  const f = rowToFault(row);
  db.conn.exec('BEGIN');
  try {
    db.st.fDel.run(...fArgs(f));
    db.st.fEvent.run(now, ...fArgs(f), capStr(f.deviceName, 128), capStr(f.kind, 16), capStr(f.label, 128), 'close', null, f.state,
      capStr(reason, 400), `manual:${capStr(user, 64)}`);
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  return { ok: true, closed: 1 };
}

/** 등록 삭제 시 — 그 CVP 의 열린 장애를 지운다(이벤트 이력은 남긴다). agent null 이면 모든 agent. */
export async function deleteFaultsFor(agent, cvpId) {
  const db = await open();
  if (!db) return { removed: 0, unavailable: true };
  const id = String(cvpId ?? '');
  const r = agent == null
    ? db.conn.prepare('DELETE FROM cvp_fault_state WHERE cvp_id=?').run(id)
    : db.conn.prepare('DELETE FROM cvp_fault_state WHERE agent=? AND cvp_id=?').run(String(agent), id);
  return { removed: Number(r.changes || 0) };
}

/** 열린 장애 개수(표가 작아 캐시하지 않는다). */
export async function faultCounts() {
  const db = await open();
  if (!db) return { open: 0, byState: { fault: 0, warn: 0 }, held: 0, unavailable: true };
  const rows = db.conn.prepare('SELECT state, SUM(hold_reason IS NOT NULL) AS held, COUNT(*) AS n FROM cvp_fault_state GROUP BY state').all();
  const out = { open: 0, byState: { fault: 0, warn: 0 }, held: 0 };
  for (const r of rows) {
    out.open += Number(r.n); out.held += Number(r.held || 0);
    if (Object.hasOwn(out.byState, r.state)) out.byState[r.state] += Number(r.n);
  }
  return out;
}

let _pruneTick = 0;
export const PRUNE_EVERY = 12;
export const PRUNE_CHUNK = 5_000;
/*
 * v2.611(EDGE2611-05·DB2611-07): 엣지 prune 은 ts 만 보므로 **아직 중앙에 보내지 않은** 표본도 지운다(중앙 장애가 보존일보다
 *   길면 조용한 소실). 커서는 push.js 가 갖고 있어 여기서는 제공자로 받는다 — 지우기 전에 '커서 뒤 + 보존일 전' 행 수를 센다.
 */
let _cursorOf = null;
let _lostUnsent = { total: 0, last: 0, at: null };
export function setUnsentCursorProvider(fn) { _cursorOf = typeof fn === 'function' ? fn : null; }
export function lostUnsentStats() { return { ..._lostUnsent }; }
/** 보존 정리 — 스로틀은 호출자가 `(++tick % N) === 0` 로(기동 첫 틱에 돌지 않게). 여기서는 요청을 공유만 한다. */
/** v2.641: CVP 이벤트 보존일(처음 받은 시각 기준). 0 이하·빈 값은 기본 30일. */
export const EVENT_RETENTION_DAYS = (() => { const n = numOrNull(process.env.CVP_EVENT_RETENTION_DAYS); return n != null && n >= 1 ? Math.min(3650, Math.floor(n)) : 30; })();
export const EVENT_SAVE_MAX = 2000;

/**
 * v2.641 ③: 엣지 push 의 CPU·메모리 최신 표본 적재. rows: [[cvpId, key, ts, cpuPct, memPct, memTotal], …] — 호출자가 소유권을 먼저 거른다.
 * 원시 표본은 (agent,cvp,key,ts) UNIQUE 라 재전송이 두 번 들어가지 않는다. 최신 열은 ts 가 더 클 때만 갱신한다.
 */
export async function importDevSamples(agent, rows = []) {
  const db = await open();
  if (!db) return { samples: 0, unavailable: true };
  let n = 0;
  db.conn.exec('BEGIN');
  try {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!Array.isArray(r)) continue;
      const [cvpId, key, ts0, cpu0, mem0, tot0] = r;
      const ts = numOrNull(ts0); const cpu = pctOrNull(cpu0); const mem = pctOrNull(mem0);
      if (typeof cvpId !== 'string' || typeof key !== 'string' || ts == null || (cpu == null && mem == null)) continue;
      if (Number(db.st.insDevSample.run(agent, cvpId, key, ts, cpu, mem).changes)) n++;
      db.st.sysLatest.run(ts, cpu, mem, numOrNull(tot0), agent, cvpId, key, ts);
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  return { samples: n };
}

/** CPU·메모리 추이(원시만 — 보존은 port_sample 과 같다). */
export async function devSeries({ agent, cvpId, key, hours = 24, now = Date.now() }) {
  const db = await open();
  if (!db) return { points: [], unavailable: true };
  const h = Math.max(1, Math.min(24 * 90, Number(hours) || 24));
  const LIMIT = 5000;
  const rows = db.conn.prepare('SELECT ts, cpu_pct, mem_pct FROM device_sample WHERE agent=? AND cvp_id=? AND device_key=? AND ts>=? ORDER BY ts DESC LIMIT ?')
    .all(agent, cvpId, key, now - h * 3600_000, LIMIT + 1);
  return { points: rows.slice(0, LIMIT).reverse().map((r) => ({ ts: Number(r.ts), cpu: r.cpu_pct, mem: r.mem_pct })), ...(rows.length > LIMIT ? { truncated: true, limit: LIMIT } : {}) };
}

/**
 * v2.641 ④: 이벤트 적재(upsert). events: parse.parseEvents 의 원소. 반환 { saved, capped }.
 * 한 번에 EVENT_SAVE_MAX 건까지(넘치면 최신부터 — 목록은 최신 순이다).
 */
export async function saveEvents(agent, cvpId, events = [], { now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { saved: 0, unavailable: true };
  const list = (Array.isArray(events) ? events : []).slice(0, EVENT_SAVE_MAX);
  let n = 0;
  db.conn.exec('BEGIN');
  try {
    for (const e of list) {
      const key = txt(e?.key, 256); const ts = numOrNull(e?.ts);
      if (!key || ts == null) continue;
      db.st.upEvent.run(agent, cvpId, key, ts, txt(e.severity, 16) || 'unknown', txt(e.title, 256), txt(e.desc, 1000), txt(e.type, 128),
        jsonOrNull(Array.isArray(e.devices) ? e.devices.slice(0, 32) : []), boolInt(e.ack), numOrNull(e.updatedAt), e.deleted ? 1 : 0, now);
      n++;
    }
    db.conn.exec('COMMIT');
  } catch (err) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw err; }
  return { saved: n, ...(Array.isArray(events) && events.length > EVENT_SAVE_MAX ? { capped: events.length - EVENT_SAVE_MAX } : {}) };
}

/** 이벤트 목록(최신 순) + 기간 안 심각도별 개수. deviceKeys 가 있으면 그 장비가 components 에 있는 것만. */
export async function listEvents({ agent = null, cvpId = null, sinceMs = 24 * 3600_000, severity = null, limit = 500, now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { events: [], counts: null, unavailable: true };
  const where = ['ts >= ?']; const args = [now - Math.max(60_000, Number(sinceMs) || 0)];
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  const counts = {};
  for (const r of db.conn.prepare(`SELECT severity, COUNT(*) AS n FROM cvp_event WHERE ${where.join(' AND ')} GROUP BY severity`).all(...args)) counts[r.severity] = Number(r.n);
  if (severity) { where.push('severity=?'); args.push(String(severity)); }
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  const rows = db.conn.prepare(`SELECT * FROM cvp_event WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, lim + 1);
  return {
    events: rows.slice(0, lim).map((r) => ({ agent: r.agent, cvpId: r.cvp_id, key: r.ev_key, ts: Number(r.ts), severity: r.severity, title: r.title || '', desc: r.descr || '',
      type: r.ev_type || '', devices: parseJson(r.devices_json) || [], ack: r.ack == null ? null : r.ack === 1, updatedAt: r.updated_at == null ? null : Number(r.updated_at), deleted: r.deleted === 1 })),
    counts, ...(rows.length > lim ? { truncated: true, limit: lim } : {}),
  };
}

/**
 * v2.641 ⑤: 포트 사용량 — 전 장비 포트의 최신 사용률(방향별 최대)을 높은 순으로. 사용률을 **계산할 수 없는** 포트는 사유별로 센다:
 *   링크 올라옴 + 속도 모름(noSpeed) · 링크 올라옴 + 처리량 없음(noRate — 첫 표본·카운터 못 읽음) · 링크 없음(notUp). 0% 로 세지 않는다.
 * staleMs 보다 오래된 처리량은 '지금 값' 이 아니므로 순위에서 빼고 stale 로 센다.
 */
export async function portUsage({ agent = null, cvpId = null, limit = 200, minUtil = 0, staleMs = 30 * 60_000, now = Date.now(), keep = null } = {}) {
  const db = await open();
  if (!db) return { ports: [], counts: null, unavailable: true };
  const where = []; const args = [];
  if (agent != null) { where.push('p.agent=?'); args.push(agent); }
  if (cvpId != null) { where.push('p.cvp_id=?'); args.push(cvpId); }
  const rows = db.conn.prepare(`SELECT p.*, d.hostname AS hostname FROM port_latest p LEFT JOIN device_latest d
      ON d.agent=p.agent AND d.cvp_id=p.cvp_id AND d.device_key=p.device_key ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT 200000`).all(...args);
  const counts = { total: 0, measured: 0, notUp: 0, noSpeed: 0, noRate: 0, stale: 0, over80: 0, over50: 0 };
  const list = [];
  for (const r of rows) {
    // keep: 등록부 담당과 맞는 행만 센다(옛 담당 엣지 행을 개수에 섞지 않게 — 라우트의 rowBelongs 와 같은 규칙).
    if (typeof keep === 'function' && !keep({ agent: r.agent, cvpId: r.cvp_id })) continue;
    counts.total++;
    if (r.oper !== 'up') { counts.notUp++; continue; }
    const fresh = r.rate_ts != null && now - Number(r.rate_ts) <= staleMs;
    if (r.in_bps == null && r.out_bps == null) { counts.noRate++; continue; }
    if (!fresh) { counts.stale++; continue; }
    if (!(Number(r.speed_bps) > 0) || (r.in_util == null && r.out_util == null)) { counts.noSpeed++; continue; }
    const util = Math.max(r.in_util ?? -1, r.out_util ?? -1);
    counts.measured++;
    if (util >= 80) counts.over80++; else if (util >= 50) counts.over50++;
    if (util < (Number(minUtil) || 0)) continue;
    list.push({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, hostname: r.hostname || '', port: r.port, desc: r.descr || '', speedBps: r.speed_bps,
      inBps: r.in_bps, outBps: r.out_bps, inUtil: r.in_util, outUtil: r.out_util, util, inErr: r.in_err, outErr: r.out_err, rateAt: Number(r.rate_ts) });
  }
  list.sort((a, b) => b.util - a.util);
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
  return { ports: list.slice(0, lim), counts, ...(list.length > lim ? { omitted: list.length - lim, limit: lim } : {}), staleMs };
}

export async function prune({ rawRetentionDays = 7, dailyRetentionDays = 730, now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { deleted: 0, unavailable: true };
  const rawCut = now - Math.max(1, rawRetentionDays) * DAY_MS;
  const dayCut = dayIndex(now) - Math.max(1, dailyRetentionDays);
  const evCut = now - Math.max(1, dailyRetentionDays) * DAY_MS; // 장애 전이 이벤트(v2.640)는 일 롤업과 같은 보존일
  return pruneFlight.run({ raw: rawCut, daily: dayCut, ev: evCut }, async () => {
    let lost = 0;
    const cur = _cursorOf ? numOrNull(_cursorOf()) : null;
    if (cur != null) {
      try { lost = Number(db.conn.prepare("SELECT COUNT(*) AS n FROM port_sample WHERE rowid > ? AND ts < ? AND +agent = ''").get(cur, rawCut)?.n || 0); } catch { lost = 0; }
    }
    // 청크 5,000(기본 2만) — 청크마다 동기 정지가 선형으로 줄어든다(DB2611-04).
    const a = await chunkedDelete(db.conn.prepare('DELETE FROM port_sample WHERE rowid IN (SELECT rowid FROM port_sample WHERE ts < ? LIMIT ?)'), [rawCut], { chunk: PRUNE_CHUNK });
    const b = await chunkedDelete(db.conn.prepare('DELETE FROM port_daily WHERE rowid IN (SELECT rowid FROM port_daily WHERE day < ? LIMIT ?)'), [dayCut], { chunk: PRUNE_CHUNK });
    const c = await chunkedDelete(db.conn.prepare('DELETE FROM cvp_fault_event WHERE rowid IN (SELECT rowid FROM cvp_fault_event WHERE at < ? LIMIT ?)'), [evCut], { chunk: PRUNE_CHUNK });
    // v2.641: CPU·메모리 원시는 포트 원시와 같은 보존 · CVP 이벤트는 처음 받은 시각 기준 EVENT_RETENTION_DAYS.
    const d2 = await chunkedDelete(db.conn.prepare('DELETE FROM device_sample WHERE rowid IN (SELECT rowid FROM device_sample WHERE ts < ? LIMIT ?)'), [rawCut], { chunk: PRUNE_CHUNK });
    const e2 = await chunkedDelete(db.conn.prepare('DELETE FROM cvp_event WHERE rowid IN (SELECT rowid FROM cvp_event WHERE seen_at < ? LIMIT ?)'), [now - EVENT_RETENTION_DAYS * DAY_MS], { chunk: PRUNE_CHUNK });
    if (lost > 0) {
      _lostUnsent = { total: _lostUnsent.total + lost, last: lost, at: Date.now() };
      console.warn(`[cvp-db] 중앙에 보내지 못한 표본 ${lost}행이 보존일(${rawRetentionDays}일)을 넘어 지워졌습니다 — 중앙 수신·push 상태를 확인하세요`);
    }
    if (a.deleted || b.deleted) _counts = null;
    return { deleted: a.deleted + b.deleted + c.deleted + d2.deleted + e2.deleted, raw: a.deleted, daily: b.deleted, faultEvents: c.deleted, devSamples: d2.deleted, cvpEvents: e2.deleted,
      done: a.done && b.done && c.done && d2.done && e2.done, ...(lost ? { lostUnsent: lost } : {}) };
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
  _adopted.clear(); _adopting.clear(); _lostUnsent = { total: 0, last: 0, at: null };
}
