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
import crypto from 'node:crypto';   // v2.924(B-②): L2 내용 해시
import { pushAll } from '../util/pushAll.js';
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
    // v2.924(SAN·CVP 설계 B-②): LLDP 이웃 · MAC 테이블(장비마다 최신 한 벌) + 메타(읽은 시각 · 개수 · 내용 해시 — 엣지 push 가 바뀐 장비만 보낸다).
    //   vlan 은 모르면 -1(기본키 열에 NULL 을 두지 않는다). sys_lc·sys_short 는 호스트 이름 조회용 소문자(전체 · 첫 점 앞).
    conn.exec(`CREATE TABLE IF NOT EXISTS l2_fdb (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, mac TEXT NOT NULL, vlan INTEGER NOT NULL DEFAULT -1, port TEXT NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY (agent, cvp_id, device_key, mac, vlan));
      CREATE INDEX IF NOT EXISTS idx_l2fdb_mac ON l2_fdb (mac);
      CREATE TABLE IF NOT EXISTS l2_lldp (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL, port TEXT NOT NULL, idx TEXT NOT NULL,
        sys_name TEXT, sys_lc TEXT, sys_short TEXT, port_id TEXT, port_desc TEXT, chassis_id TEXT, ts INTEGER NOT NULL,
        PRIMARY KEY (agent, cvp_id, device_key, port, idx));
      CREATE INDEX IF NOT EXISTS idx_l2lldp_lc ON l2_lldp (sys_lc);
      CREATE INDEX IF NOT EXISTS idx_l2lldp_short ON l2_lldp (sys_short);
      CREATE TABLE IF NOT EXISTS l2_meta (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, device_key TEXT NOT NULL,
        fdb_at INTEGER, fdb_n INTEGER, fdb_truncated INTEGER, fdb_over_json TEXT, fdb_hash TEXT, fdb_fail_at INTEGER,
        lldp_at INTEGER, lldp_n INTEGER, lldp_truncated INTEGER, lldp_hash TEXT, lldp_fail_at INTEGER,
        PRIMARY KEY (agent, cvp_id, device_key));`);
    // v2.933(SAN·CVP 설계 C-③): CVP EndpointLocation — MAC 마다 최신 위치 한 벌(교체) + 메타(물어본 시각 · 상태). vlan 은 모르면 -1.
    //   device 는 CVP 가 준 장비 식별자(보통 시리얼) — 화면은 device_latest 와 맞춰 호스트명을 붙인다. at 은 물어본 시각(이 노드 시계).
    conn.exec(`CREATE TABLE IF NOT EXISTS ep_loc (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, mac TEXT NOT NULL, device TEXT NOT NULL, port TEXT NOT NULL, vlan INTEGER NOT NULL DEFAULT -1,
        learned_at TEXT, mac_type TEXT, likelihood TEXT, at INTEGER NOT NULL,
        PRIMARY KEY (agent, cvp_id, mac, device, port, vlan));
      CREATE INDEX IF NOT EXISTS idx_eploc_mac ON ep_loc (mac);
      CREATE INDEX IF NOT EXISTS idx_eploc_at ON ep_loc (at);
      CREATE TABLE IF NOT EXISTS ep_meta (
        agent TEXT NOT NULL, cvp_id TEXT NOT NULL, mac TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL, n INTEGER, reason TEXT, seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent, cvp_id, mac));
      CREATE INDEX IF NOT EXISTS idx_epmeta_at ON ep_meta (at);
      CREATE INDEX IF NOT EXISTS idx_epmeta_mac ON ep_meta (mac);`);
    // v2.933 반증 L-5: 엣지 push 변경분 커서는 '물어본 시각' 이 아니라 쓸 때마다 늘어나는 순번(seq)이다 — 같은 at 이 상한 경계에 여럿이거나,
    //   늦게 커밋된 더 작은 at 이 있으면 시각 커서는 그 행을 건너뛰었다(재현). 이 브랜치의 개발 DB 에는 열이 없을 수 있어 없으면 더한다.
    { const have = new Set(conn.prepare('PRAGMA table_info(ep_meta)').all().map((r) => r.name));
      if (!have.has('seq')) { try { conn.exec('ALTER TABLE ep_meta ADD COLUMN seq INTEGER NOT NULL DEFAULT 0'); } catch (e) { if (!/duplicate column name/i.test(String(e?.message || ''))) throw e; } }
      conn.exec('CREATE INDEX IF NOT EXISTS idx_epmeta_seq ON ep_meta (seq); CREATE INDEX IF NOT EXISTS idx_epmeta_cvpseq ON ep_meta (agent, cvp_id, seq);'); }
    addDailyErrCountCols(conn);
    addDeviceInfoCols(conn);
    addPortDetailCols(conn);
    addPortDropCols(conn);   // v2.922(3a): 포트 드롭(discards — 추정 경로)
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
      // v2.649: 설명·세부 열은 NULL(이번에 못 읽음)이면 직전 값을 유지한다 — '' 는 '설명 없음' 으로 그대로 저장한다.
      upPort: conn.prepare(`INSERT INTO port_latest (agent,cvp_id,device_key,port,ts,descr,speed_bps,oper,admin,vlan,lag,in_bps,out_bps,in_util,out_util,in_err,out_err,rate_ts,duplex,fwd_model,mac,mtu,oper_raw,in_drop,out_drop)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key,port) DO UPDATE SET ts=excluded.ts, descr=COALESCE(excluded.descr, port_latest.descr), speed_bps=excluded.speed_bps, oper=excluded.oper,
          admin=excluded.admin, vlan=excluded.vlan, lag=excluded.lag,
          duplex=COALESCE(excluded.duplex, port_latest.duplex), fwd_model=COALESCE(excluded.fwd_model, port_latest.fwd_model),
          mac=COALESCE(excluded.mac, port_latest.mac), mtu=COALESCE(excluded.mtu, port_latest.mtu), oper_raw=COALESCE(excluded.oper_raw, port_latest.oper_raw),
          in_bps=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_bps ELSE excluded.in_bps END,
          out_bps=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_bps ELSE excluded.out_bps END,
          in_util=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_util ELSE excluded.in_util END,
          out_util=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_util ELSE excluded.out_util END,
          in_err=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_err ELSE excluded.in_err END,
          out_err=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_err ELSE excluded.out_err END,
          in_drop=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.in_drop ELSE excluded.in_drop END,
          out_drop=CASE WHEN IFNULL(port_latest.rate_ts,0) > excluded.rate_ts THEN port_latest.out_drop ELSE excluded.out_drop END,
          rate_ts=MAX(IFNULL(port_latest.rate_ts,0), excluded.rate_ts)
        WHERE excluded.ts > port_latest.ts`),
      // 원시 표본이 오면 그 포트의 마지막 처리량도 갱신한다(엣지는 구성이 바뀌지 않은 장비 레코드를 매번 보내지 않는다 — push.js).
      rateFromSample: conn.prepare(`UPDATE port_latest SET in_bps=?, out_bps=?, in_util=?, out_util=?, in_err=?, out_err=?, in_drop=?, out_drop=?, rate_ts=?
        WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND IFNULL(rate_ts,0) < ?`),
      // v2.922(반증 D3): 구 엣지 10칸 표본(드롭 칸 자체가 없다)은 port_latest 의 드롭을 **덮지 않는다** — 장비 레코드가 준 값이 null 로 지워졌다.
      rateFromSampleNoDrop: conn.prepare(`UPDATE port_latest SET in_bps=?, out_bps=?, in_util=?, out_util=?, in_err=?, out_err=?, rate_ts=?
        WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND IFNULL(rate_ts,0) < ?`),
      // v2.611(EDGE2611-04): 행이 **있으면** 센다(ts 는 더 클 때만 오른다) — changes 가 '중앙에 그 장비 행이 있는가' 를 말해야
      //   엣지가 없는 행을 touch 로만 보내는 것을 알아채고 레코드를 다시 보낸다(예전 `AND ts < ?` 는 같은 ts 재전송을 0 으로 셌다).
      touchDevice: conn.prepare('UPDATE device_latest SET ts=MAX(ts, ?) WHERE agent=? AND cvp_id=? AND device_key=?'),
      delPortsOld: conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=? AND device_key=? AND ts < ?'),
      selDevTs: conn.prepare('SELECT ts FROM device_latest WHERE agent=? AND cvp_id=? AND device_key=?'),
      insSample: conn.prepare('INSERT OR IGNORE INTO port_sample (agent,cvp_id,device_key,port,ts,in_bps,out_bps,in_util,out_util,in_err,out_err,in_drop,out_drop) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'),
      upDaily: conn.prepare(`INSERT INTO port_daily (agent,cvp_id,device_key,port,day,samples,in_bps_sum,in_bps_n,in_bps_max,out_bps_sum,out_bps_n,out_bps_max,
          in_util_sum,in_util_n,in_util_max,out_util_sum,out_util_n,out_util_max,in_err_sum,out_err_sum,in_err_n,out_err_n,in_drop_sum,out_drop_sum,in_drop_n,out_drop_n)
        VALUES (?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(agent,cvp_id,device_key,port,day) DO UPDATE SET samples=port_daily.samples+1,
          in_bps_sum=port_daily.in_bps_sum+excluded.in_bps_sum, in_bps_n=port_daily.in_bps_n+excluded.in_bps_n, in_bps_max=${maxOf('in_bps_max')},
          out_bps_sum=port_daily.out_bps_sum+excluded.out_bps_sum, out_bps_n=port_daily.out_bps_n+excluded.out_bps_n, out_bps_max=${maxOf('out_bps_max')},
          in_util_sum=port_daily.in_util_sum+excluded.in_util_sum, in_util_n=port_daily.in_util_n+excluded.in_util_n, in_util_max=${maxOf('in_util_max')},
          out_util_sum=port_daily.out_util_sum+excluded.out_util_sum, out_util_n=port_daily.out_util_n+excluded.out_util_n, out_util_max=${maxOf('out_util_max')},
          in_err_sum=CASE WHEN excluded.in_err_sum IS NULL THEN port_daily.in_err_sum ELSE IFNULL(port_daily.in_err_sum,0)+excluded.in_err_sum END,
          out_err_sum=CASE WHEN excluded.out_err_sum IS NULL THEN port_daily.out_err_sum ELSE IFNULL(port_daily.out_err_sum,0)+excluded.out_err_sum END,
          in_err_n=port_daily.in_err_n+excluded.in_err_n, out_err_n=port_daily.out_err_n+excluded.out_err_n,
          in_drop_sum=CASE WHEN excluded.in_drop_sum IS NULL THEN port_daily.in_drop_sum ELSE IFNULL(port_daily.in_drop_sum,0)+excluded.in_drop_sum END,
          out_drop_sum=CASE WHEN excluded.out_drop_sum IS NULL THEN port_daily.out_drop_sum ELSE IFNULL(port_daily.out_drop_sum,0)+excluded.out_drop_sum END,
          in_drop_n=port_daily.in_drop_n+excluded.in_drop_n, out_drop_n=port_daily.out_drop_n+excluded.out_drop_n`),
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

/**
 * v2.922(3a · 설계 PROFILES §10): 포트 드롭 열 — port_latest·port_sample 의 in_drop/out_drop, port_daily 의 합·개수.
 *   CREATE 문이 아니라 ALTER 로 더한다(기존 DB 와 새 DB 가 같은 경로 · 'duplicate column name' 만 삼킨다 — DB2603-01).
 *   ⚠ 카운터 필드 이름은 추정(parse.parseCounters inDiscards)이다 — 못 읽으면 null(드롭 0 이 아니다).
 */
export const PORT_DROP_COLS = Object.freeze({
  port_latest: [['in_drop', 'INTEGER'], ['out_drop', 'INTEGER']],
  port_sample: [['in_drop', 'INTEGER'], ['out_drop', 'INTEGER']],
  port_daily: [['in_drop_sum', 'INTEGER'], ['out_drop_sum', 'INTEGER'], ['in_drop_n', 'INTEGER NOT NULL DEFAULT 0'], ['out_drop_n', 'INTEGER NOT NULL DEFAULT 0']],
});
export function addPortDropCols(conn) {
  let added = 0;
  for (const [table, cols] of Object.entries(PORT_DROP_COLS)) {
    const have = new Set(conn.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const [col, type] of cols) {
      if (have.has(col)) continue;
      try { conn.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); added += 1; }
      catch (e) { if (!/duplicate column name/i.test(String(e?.message || ''))) throw e; }
    }
  }
  return added;
}
/** v2.649: port_latest 의 인터페이스 세부 정보 열(duplex·forwarding model·MAC·MTU·원래 상태 문자열) — 없는 열만 더한다. */
function addPortDetailCols(conn) {
  const have = new Set(conn.prepare('PRAGMA table_info(port_latest)').all().map((r) => r.name));
  for (const [col, type] of [['duplex', 'TEXT'], ['fwd_model', 'TEXT'], ['mac', 'TEXT'], ['mtu', 'INTEGER'], ['oper_raw', 'TEXT']]) {
    if (have.has(col)) continue;
    try { conn.exec(`ALTER TABLE port_latest ADD COLUMN ${col} ${type}`); }
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
// v2.649: 설명은 '' 을 값으로 남긴다(설명 없음) — null 만 '못 읽음' 이다.
const descOf = (v) => (v == null || (typeof v !== 'string' && typeof v !== 'number') ? null : capStr(String(v), 200));
const mtuOf = (v) => { const n = numOrNull(v); return n != null && n > 0 && n < 100_000 ? Math.round(n) : null; };
/** port_latest 행 → 화면·push 공용 세부 필드(v2.649). 설명이 NULL 이면 null('못 읽음'). */
const portDetailOf = (p) => ({ desc: p.descr == null ? null : p.descr, duplex: p.duplex ?? null, fwdModel: p.fwd_model ?? null, mac: p.mac ?? null, mtu: p.mtu ?? null, operRaw: p.oper_raw ?? null });
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
              st.upPort.run(agent, cvpId, key, name, ts, descOf(p.desc), numOrNull(p.speedBps), txt(p.oper, 16), txt(p.admin, 16), txt(p.vlan, 32), txt(p.lag, 64),
                numOrNull(p.inBps), numOrNull(p.outBps), numOrNull(p.inUtil), numOrNull(p.outUtil), numOrNull(p.inErr), numOrNull(p.outErr), ts,
                txt(p.duplex, 48), txt(p.fwdModel, 48), txt(p.mac, 32), mtuOf(p.mtu), txt(p.operRaw, 48), numOrNull(p.inDrop), numOrNull(p.outDrop));
              np++;
            }
            if (samples && sampleWorthy(p)) {
              const r = insertSample(st, [agent, cvpId, key, name, ts, p.inBps, p.outBps, p.inUtil, p.outUtil, p.inErr, p.outErr, p.inDrop, p.outDrop]);
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
function insertSample(st, [agent, cvpId, key, port, ts, inBps, outBps, inUtil, outUtil, inErr, outErr, inDrop, outDrop]) {
  // v2.922: 드롭 두 칸을 뒤에 붙였다(구버전 엣지 push 행은 없다 → undefined → null — 드롭 0 이 아니다).
  const v = [numOrNull(inBps), numOrNull(outBps), numOrNull(inUtil), numOrNull(outUtil), numOrNull(inErr), numOrNull(outErr), numOrNull(inDrop), numOrNull(outDrop)];
  const r = st.insSample.run(agent, cvpId, key, port, ts, ...v);
  if (Number(r.changes) === 0) return false;
  const [ib, ob, iu, ou, ie, oe, id, od] = v;
  st.upDaily.run(agent, cvpId, key, port, dayIndex(ts),
    ib ?? 0, ib == null ? 0 : 1, ib, ob ?? 0, ob == null ? 0 : 1, ob,
    iu ?? 0, iu == null ? 0 : 1, iu, ou ?? 0, ou == null ? 0 : 1, ou, ie, oe, ie == null ? 0 : 1, oe == null ? 0 : 1,
    id, od, id == null ? 0 : 1, od == null ? 0 : 1);
  return true;
}

/**
 * 중앙: 엣지 push 의 원시 표본 행 적재. rows: [[cvpId, deviceKey, port, ts, inBps, outBps, inUtil, outUtil, inErr, outErr(, inDrop, outDrop — v2.922 새 엣지 12칸)], …]
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
        if (insertSample(db.st, [agent, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]])) {
          ins++;
          if (r.length >= 12) db.st.rateFromSample.run(...[r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11]].map(numOrNull), r[3], agent, r[0], r[1], r[2], r[3]);
          else db.st.rateFromSampleNoDrop.run(...[r[4], r[5], r[6], r[7], r[8], r[9]].map(numOrNull), r[3], agent, r[0], r[1], r[2], r[3]);
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
  const dropCvps = [];
  db.conn.exec('BEGIN');
  try {
    if (Array.isArray(cvpIds)) {
      const keep = new Set(cvpIds.map(String));
      const have = db.conn.prepare('SELECT DISTINCT cvp_id AS c FROM device_latest WHERE agent=?').all(agent).map((r) => r.c);
      for (const c of have) if (!keep.has(c)) {
        removed += Number(db.conn.prepare('DELETE FROM device_latest WHERE agent=? AND cvp_id=?').run(agent, c).changes);
        db.conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=?').run(agent, c);
        dropCvps.push(c);   // v2.924(B-② · 반증 L-2): L2 는 COMMIT 뒤 조각으로
      }
    }
    for (const [cvpId, keys] of Object.entries(keepByCvp)) {
      if (!Array.isArray(keys)) continue;
      const keep = new Set(keys.map(String));
      const have = db.conn.prepare('SELECT device_key AS k FROM device_latest WHERE agent=? AND cvp_id=?').all(agent, cvpId).map((r) => r.k);
      for (const k of have) if (!keep.has(k)) {
        removed += Number(db.conn.prepare('DELETE FROM device_latest WHERE agent=? AND cvp_id=? AND device_key=?').run(agent, cvpId, k).changes);
        db.conn.prepare('DELETE FROM port_latest WHERE agent=? AND cvp_id=? AND device_key=?').run(agent, cvpId, k);
        dropL2(db.conn, agent, cvpId, k);   // v2.924(B-②)
      }
    }
    db.conn.exec('COMMIT');
  } catch (e) { try { db.conn.exec('ROLLBACK'); } catch { /* */ } throw e; }
  if (removed) _counts = null;
  // v2.924(B-② · 반증 L-2·L-6): 위임에서 빠진 CVP 의 L2 전체 · 목록을 받은 CVP 의 고아 L2(장비 행이 없는 키) — 조각으로 지운다.
  try {
    for (const c of dropCvps) { await dropL2Where(db.conn, 'agent=? AND cvp_id=?', [agent, c]); await dropEpWhere(db.conn, 'agent=? AND cvp_id=?', [agent, c]); }   // v2.933 C-③
    for (const cvpId of Object.keys(keepByCvp || {})) {
      if (!Array.isArray(keepByCvp[cvpId])) continue;
      /*
       * v2.932(점검 E1-06): 예전에는 push 마다 고아가 0건이어도 그 CVP 의 L2 행 전부를 NOT IN 으로 훑었다(40만 행 68ms — cvp-data 청크 0 마다).
       *   고아 장비 키는 장비당 1행인 l2_meta 에서 먼저 고르고 그 키만 지운다(스캔 비용 = 장비 수). l2_meta 없이 남은 행(예외 경로)은
       *   전체 훑기를 (agent, CVP)마다 L2_FULL_SWEEP_MS 에 한 번만 한다 — 정리를 없애지 않고 횟수만 줄인다.
       */
      const orphan = db.conn.prepare('SELECT device_key AS k FROM l2_meta WHERE agent=? AND cvp_id=? AND device_key NOT IN (SELECT device_key FROM device_latest WHERE agent=? AND cvp_id=?)')
        .all(agent, cvpId, agent, cvpId).map((r) => r.k);
      for (const k of orphan) await dropL2Where(db.conn, 'agent=? AND cvp_id=? AND device_key=?', [agent, cvpId, k]);
      const sweepKey = `${agent}\u0000${cvpId}`;
      const last = _l2FullSweepAt.get(sweepKey) || 0;
      if (Date.now() - last >= L2_FULL_SWEEP_MS) {
        _l2FullSweepAt.set(sweepKey, Date.now());
        if (_l2FullSweepAt.size > 4096) _l2FullSweepAt.delete(_l2FullSweepAt.keys().next().value);
        await dropL2Where(db.conn, 'agent=? AND cvp_id=? AND device_key NOT IN (SELECT device_key FROM device_latest WHERE agent=? AND cvp_id=?)', [agent, cvpId, agent, cvpId]);
      }
    }
  } catch (e) { console.warn(`[cvp-db] L2 정리 실패(다음 정리 때 다시): ${e.message}`); }
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
  // v2.680(감사 F-01): v2.640/641 에 같은 agent 축으로 추가된 표도 옮긴다 — 빠지면 담당 엣지 표기가 대소문자만 바뀌었을 때
  //   옛 이름의 열린 장애가 영구 보류되고(관측에 없다) 새 키로 다시 열려 알림이 한 번 더 나가며, 이벤트·CPU 추이가 두 벌이 된다.
  device_sample: ['cvp_id', 'device_key', 'ts'],
  cvp_event: ['cvp_id', 'ev_key', 'ts'],
  cvp_fault_state: ['cvp_id', 'device_key', 'fault_key'],
  cvp_fault_event: [], // PK 가 id 라 충돌이 없다 — agent 만 바꾼다
};
/** 최신 행 비교 열 — 변형 쪽이 더 새면 저장 키 행을 비우고 변형 행을 옮긴다. */
const NEWER_COL = { device_latest: 'ts', port_latest: 'ts', cvp_fault_state: 'last_seen' };
const IN_CHUNK = 'rowid IN (SELECT value FROM json_each(?))';
function dailyMergeSql() {
  const mx = (c) => `${c}=NULLIF(MAX(IFNULL(port_daily.${c},-1e308), IFNULL(v.${c},-1e308)), -1e308)`;
  const errSum = (c) => `${c}=CASE WHEN v.${c} IS NULL THEN port_daily.${c} ELSE IFNULL(port_daily.${c},0)+v.${c} END`;
  const sums = ['in_bps', 'out_bps', 'in_util', 'out_util'].flatMap((m) => [`${m}_sum=port_daily.${m}_sum+v.${m}_sum`, `${m}_n=port_daily.${m}_n+v.${m}_n`, mx(`${m}_max`)]);
  return `UPDATE port_daily SET samples=port_daily.samples+v.samples, ${sums.join(', ')},
      ${errSum('in_err_sum')}, ${errSum('out_err_sum')}, in_err_n=port_daily.in_err_n+v.in_err_n, out_err_n=port_daily.out_err_n+v.out_err_n,
      ${errSum('in_drop_sum')}, ${errSum('out_drop_sum')}, in_drop_n=port_daily.in_drop_n+v.in_drop_n, out_drop_n=port_daily.out_drop_n+v.out_drop_n
    FROM (SELECT * FROM port_daily WHERE ${IN_CHUNK}) AS v
    WHERE port_daily.agent=? AND ${ADOPT_PK.port_daily.map((c) => `port_daily.${c}=v.${c}`).join(' AND ')}`;
}
async function adoptTable(db, t, key, variant, chunkRows) {
  const pk = ADOPT_PK[t];
  const sel = db.conn.prepare(`SELECT rowid AS r FROM ${t} WHERE agent=? LIMIT ?`);
  const nc = NEWER_COL[t];
  // 장애 상태는 어느 쪽이 남든 처음 본 시각은 더 이른 쪽이다(먼저 저장 키 행에 반영해 둔다).
  const keepFirstSeen = t === 'cvp_fault_state'
    ? db.conn.prepare(`UPDATE cvp_fault_state SET first_seen=MIN(cvp_fault_state.first_seen, v.first_seen)
        FROM (SELECT * FROM cvp_fault_state WHERE ${IN_CHUNK}) AS v
        WHERE cvp_fault_state.agent=? AND ${pk.map((c) => `cvp_fault_state.${c}=v.${c}`).join(' AND ')}`)
    : null;
  // v2.681(감사 R2A-04): 변형 행이 더 새로워 그쪽이 남는 경우도 처음 본 시각은 더 이른 쪽이어야 한다.
  const keepFirstSeenVariant = t === 'cvp_fault_state'
    ? db.conn.prepare(`UPDATE cvp_fault_state SET first_seen=MIN(cvp_fault_state.first_seen, k.first_seen)
        FROM (SELECT * FROM cvp_fault_state WHERE agent=?) AS k
        WHERE cvp_fault_state.${IN_CHUNK} AND ${pk.map((c) => `cvp_fault_state.${c}=k.${c}`).join(' AND ')}`)
    : null;
  const newerVariant = nc
    ? db.conn.prepare(`DELETE FROM ${t} WHERE agent=? AND EXISTS (SELECT 1 FROM ${t} v WHERE v.${IN_CHUNK} AND v.agent=? AND ${pk.map((c) => `v.${c}=${t}.${c}`).join(' AND ')} AND v.${nc} > ${t}.${nc})`)
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
      if (keepFirstSeen) { keepFirstSeen.run(j, key); keepFirstSeenVariant.run(key, j); }
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
  // v2.924(B-②): L2(LLDP·MAC 테이블)는 '장비마다 최신 한 벌' 이라 옮겨 합치면 두 시각의 목록이 섞인다 — 변형 이름의 행은 지운다.
  //   엣지가 지금 쓰는 이름(key)으로 다시 보내고(바뀐 장비 · 전량 갱신 주기), 그동안 매칭은 key 의 행만 쓴다.
  for (const v of variants) { await dropL2Where(db.conn, 'agent=?', [v]); await dropEpWhere(db.conn, 'agent=?', [v]); }   // 반증 L-2: 조각으로 · v2.933 EndpointLocation 도
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
      for (const t of ['device_latest', 'port_latest', 'cvp_fault_state', 'cvp_event']) {
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

/**
 * v2.680(감사 E-04): parts_json·bgp_json 파싱 기억 — 장애 판정이 적재마다(디바운스 15초) 전 장비를 읽는데 부품 목록은
 *   30분 주기로만 바뀐다(200대 × 부품 110개 = 호출당 68~101ms). 원문 문자열이 같을 때만 직전 파싱 결과를 재사용한다
 *   (호출부는 목록을 제자리에서 바꾸지 않는다 — grep 확인). 상한을 넘으면 통째로 비운다(장비 수 규모라 드물다).
 */
const _parsedCache = new Map();
const PARSED_CACHE_MAX = 4_000;
function parseJsonCached(slot, raw) {
  if (raw == null) return parseJson(raw);
  const hit = _parsedCache.get(slot);
  if (hit && hit.raw === raw) return hit.val;
  const val = parseJson(raw);
  if (_parsedCache.size >= PARSED_CACHE_MAX) _parsedCache.clear();
  _parsedCache.set(slot, { raw, val });
  return val;
}

function rowToDevice(r, portSum) {
  const slot = `${r.agent}\u0000${r.cvp_id}\u0000${r.device_key}`;
  const parts = parseJsonCached(`p\u0000${slot}`, r.parts_json);
  const bgp = parseJsonCached(`b\u0000${slot}`, r.bgp_json);
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
    .map((p) => ({ name: p.port, speedBps: p.speed_bps, oper: p.oper || 'unknown', admin: p.admin || 'unknown', vlan: p.vlan || '', lag: p.lag || '',
      inBps: p.in_bps, outBps: p.out_bps, inUtil: p.in_util, outUtil: p.out_util, inErr: p.in_err, outErr: p.out_err, inDrop: p.in_drop ?? null, outDrop: p.out_drop ?? null, ts: Number(p.ts), ...portDetailOf(p) }));
  // v2.630 A2-02: 합계 판정은 parse.portsSummary 하나를 쓴다(미연결 'nolink' 는 down 이 아니다 — 개수는 noLink).
  const pSum = portsSummary(ports);
  return { device: rowToDevice(r, pSum), ports: r.ports_read === 1 ? ports : null };
}

/**
 * v2.923(B-①): 포트 몇 개의 최근 창(기본 24시간) 오류·드롭 합 — 원시 표본(port_sample, 고유 인덱스 (agent,cvp,key,port,ts))을 읽어 JS 로 더한다
 *   (집계 함수 두 개를 한 문장에 쓰지 않는다 — perf-db 규약). 값이 없는 표본(첫 주기·간격 비정상·리셋·드롭 수집 전·구버전 엣지)은 더하지 않고
 *   n 에 세지 않는다 — 화면이 '표본 n/전체' 로 부분 합임을 밝힌다.
 * @param {Array<{agent:string,cvpId:string,key:string,port:string}>} ports  상한 16
 * @returns {Promise<Map<string,{inErr:number|null,outErr:number|null,inDrop:number|null,outDrop:number|null,samples:number,dropN:number,errN:number}>>} 키 `${agent}\u0000${cvpId}\u0000${key}\u0000${port}`
 */
export async function portWindowSums(ports = [], { sinceMs = 24 * 3600_000, recentMs = 0, now = Date.now() } = {}) {
  const out = new Map();
  const db = await open();
  if (!db) return out;
  const q = db.conn.prepare('SELECT ts, in_err, out_err, in_drop, out_drop FROM port_sample WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND ts>=? LIMIT 5000');
  const rec = Number(recentMs) > 0 ? now - Number(recentMs) : null;
  for (const p of (Array.isArray(ports) ? ports : []).slice(0, 16)) {
    const fresh = () => ({ inErr: null, outErr: null, inDrop: null, outDrop: null, samples: 0, dropN: 0, errN: 0 });
    const acc = fresh();
    const recent = rec != null ? fresh() : null;   // v2.925(B-③): 같은 행에서 최근 창(예: 1시간)도 함께 — ESXi 실시간 1시간과 나란히 놓는다
    const addTo = (a, r) => {
      a.samples += 1;
      const add = (k, v) => { const n = numOrNull(v); if (n != null) a[k] = (a[k] ?? 0) + n; return n != null; };
      const e1 = add('inErr', r.in_err); const e2 = add('outErr', r.out_err);
      const d1 = add('inDrop', r.in_drop); const d2 = add('outDrop', r.out_drop);
      if (e1 || e2) a.errN += 1;
      if (d1 || d2) a.dropN += 1;
    };
    for (const r of q.all(String(p.agent ?? ''), String(p.cvpId), String(p.key), String(p.port), now - sinceMs)) {
      addTo(acc, r);
      if (recent && Number(r.ts) >= rec) addTo(recent, r);
    }
    if (recent) acc.recent = recent;
    out.set(`${p.agent ?? ''}\u0000${p.cvpId}\u0000${p.key}\u0000${p.port}`, acc);
  }
  return out;
}

/**
 * v2.920(호스트 업링크 매칭): 포트 설명(descr)에 단서가 든 포트 행 — 호스트 짧은 이름·NIC MAC(콜론·하이픈·점·붙임 표기). SQL LIKE 로 거른 뒤
 *   토큰 경계 판정은 cvp/hostMatch.js 가 한다(여기서는 넉넉히 뽑는다). 장비 호스트명을 붙여 준다. 단서 8개·결과 200행 상한.
 * @param {string[]} terms 소문자 단서(LIKE 의 % _ 는 이스케이프)
 */
/*
 * v2.932(점검 A1-07): 예전에는 단서를 앞 8개만 썼다 — 호스트가 MAC 표기 4가지 × NIC 수를 넘겨 vmnic2 부터의 MAC 은 묻지도 않았고 잘림 표시도 없었다.
 *   이름 단서(`terms`)는 그대로 lower(descr) LIKE 로, MAC(`macs` — 12자 16진)은 설명에서 ':' '-' '.' 를 뺀 글자에 **한 표기로** 묻는다
 *   (표기 4가지를 단서 4개로 늘리지 않는다 — 한 번 훑는 OR 길이를 NIC 수에 비례하게). 상한을 넘긴 단서는 `termsTruncated` 로 밝힌다.
 *   경계 판정(다른 16진 문자열 안의 우연 일치)은 지금처럼 cvp/hostMatch matchUplinks 가 한다.
 */
export const DESC_NAME_TERMS_MAX = 8;
export const DESC_MAC_TERMS_MAX = 32;
export async function portsByDesc(terms = [], { limit = 200, macs = [] } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const all = [...new Set((Array.isArray(terms) ? terms : []).map((t) => String(t || '').trim().toLowerCase()).filter((t) => t.length >= 3))];
  const macAll = [...new Set((Array.isArray(macs) ? macs : []).map((m) => String(m || '').toLowerCase().replace(/[^0-9a-f]/g, '')).filter((m) => m.length === 12))];
  const ts = all.slice(0, DESC_NAME_TERMS_MAX);
  const ms = macAll.slice(0, DESC_MAC_TERMS_MAX);
  const termsTruncated = all.length > ts.length || macAll.length > ms.length;
  if (!ts.length && !ms.length) return { rows: [] };
  const esc = (t) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
  const NORM = "replace(replace(replace(lower(p.descr), ':', ''), '-', ''), '.', '')";
  const where = [...ts.map(() => "lower(p.descr) LIKE ? ESCAPE '\\'"), ...ms.map(() => `${NORM} LIKE ?`)].join(' OR ');
  const lim = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 200));
  const rows = db.conn.prepare(`SELECT p.*, d.hostname AS dev_hostname, d.serial AS dev_serial FROM port_latest p
      LEFT JOIN device_latest d ON d.agent = p.agent AND d.cvp_id = p.cvp_id AND d.device_key = p.device_key
      WHERE p.descr IS NOT NULL AND p.descr != '' AND (${where}) ORDER BY p.cvp_id, p.device_key, p.port LIMIT ?`).all(...ts.map((t) => `%${esc(t)}%`), ...ms.map((m) => `%${m}%`), lim + 1);
  const out = rows.slice(0, lim).map((p) => ({ agent: p.agent, cvpId: p.cvp_id, key: p.device_key, hostname: p.dev_hostname || '', serial: p.dev_serial || '',
    port: p.port, desc: p.descr, speedBps: p.speed_bps ?? null, oper: p.oper || 'unknown', admin: p.admin || 'unknown', vlan: p.vlan || '', lag: p.lag || '',
    inBps: p.in_bps ?? null, outBps: p.out_bps ?? null, inUtil: p.in_util ?? null, outUtil: p.out_util ?? null, inErr: p.in_err ?? null, outErr: p.out_err ?? null,
    inDrop: p.in_drop ?? null, outDrop: p.out_drop ?? null,   // v2.922(3a): 포트 드롭(추정 경로 — 못 읽으면 null)
    rateTs: p.rate_ts == null ? null : Number(p.rate_ts), ts: Number(p.ts), mac: p.mac ?? null, mtu: p.mtu ?? null }));
  return { rows: out, ...(rows.length > lim ? { truncated: true, limit: lim } : {}), ...(termsTruncated ? { termsTruncated: true } : {}) };
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
    portsBy.get(k).push({ name: p.port, speedBps: p.speed_bps, oper: p.oper, admin: p.admin, vlan: p.vlan || '', lag: p.lag || '',
      inBps: p.in_bps, outBps: p.out_bps, inUtil: p.in_util, outUtil: p.out_util, inErr: p.in_err, outErr: p.out_err, inDrop: p.in_drop ?? null, outDrop: p.out_drop ?? null, ...portDetailOf(p) });
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
  const rows = db.conn.prepare(`SELECT rowid AS rowid, cvp_id, device_key, port, ts, in_bps, out_bps, in_util, out_util, in_err, out_err, in_drop, out_drop
      FROM port_sample WHERE rowid > ? AND +agent = '' ORDER BY rowid LIMIT ?`)
    .all(Number(rowid) || 0, Math.max(1, Math.min(100_000, Number(limit) || 20_000)));
  return {
    rows: rows.map((r) => [r.cvp_id, r.device_key, r.port, Number(r.ts), r.in_bps, r.out_bps, r.in_util, r.out_util, r.in_err, r.out_err, r.in_drop, r.out_drop]),
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
    const rows = db.conn.prepare(`SELECT ts, in_bps, out_bps, in_util, out_util, in_err, out_err, in_drop, out_drop FROM port_sample
        WHERE agent=? AND cvp_id=? AND device_key=? AND port=? AND ts>=? ORDER BY ts DESC LIMIT ?`).all(agent, cvpId, key, port, from, LIMIT + 1);
    const truncated = rows.length > LIMIT;
    const pts = rows.slice(0, LIMIT).reverse().map((r) => ({ ts: Number(r.ts), inBps: r.in_bps, outBps: r.out_bps, inUtil: r.in_util, outUtil: r.out_util, inErr: r.in_err, outErr: r.out_err, inDrop: r.in_drop ?? null, outDrop: r.out_drop ?? null }));
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
    inDrop: r.in_drop_sum ?? null, outDrop: r.out_drop_sum ?? null, inDropN: legacyN(r.in_drop_n, r.in_drop_sum), outDropN: legacyN(r.out_drop_n, r.out_drop_sum),
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
export async function recentFaultEvents({ sinceMs = 30 * 86_400_000, limit = 500, cvpId = null, agent = null, deviceKey = null } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const since = Math.trunc(Date.now() - Math.max(0, numOrNull(sinceMs) ?? 0));
  const lim = Math.max(1, Math.min(5_000, Math.trunc(Number(limit)) || 500));
  const where = ['at >= ?']; const args = [since];
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  if (deviceKey != null) { where.push('device_key=?'); args.push(deviceKey); }
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
export async function listEvents({ agent = null, cvpId = null, cvpIds = null, sinceMs = 24 * 3600_000, severity = null, limit = 500, now = Date.now(), byCvp = false } = {}) {
  const db = await open();
  if (!db) return { events: [], counts: null, unavailable: true };
  const where = ['ts >= ?']; const args = [now - Math.max(60_000, Number(sinceMs) || 0)];
  if (agent != null) { where.push('agent=?'); args.push(agent); }
  if (cvpId != null) { where.push('cvp_id=?'); args.push(cvpId); }
  // v2.645: (CVP 서버·agent·심각도)별 개수 — 법인 필터 **전** 기준(법인 칩은 고른 법인과 무관하게 전부 보여야 한다 — deviceFacets 규칙 ①).
  //   라우트가 등록부 담당 행만 골라 법인별로 합친다. 심각도 필터 전 기준.
  const countsByCvp = byCvp
    ? db.conn.prepare(`SELECT cvp_id, agent, severity, COUNT(*) AS n FROM cvp_event WHERE ${where.join(' AND ')} GROUP BY cvp_id, agent, severity`).all(...args)
      .map((r) => ({ cvpId: r.cvp_id, agent: r.agent, severity: r.severity, n: Number(r.n) }))
    : null;
  // v2.645: 법인 필터 — 그 법인에 속한 CVP 서버 여러 대(빈 배열이면 결과 0 — '전체' 로 넓히지 않는다).
  if (Array.isArray(cvpIds)) {
    if (!cvpIds.length) return { events: [], counts: {}, ...(countsByCvp ? { countsByCvp } : {}) };
    const ids = cvpIds.slice(0, 500).map(String);
    where.push(`cvp_id IN (${ids.map(() => '?').join(',')})`); pushAll(args, ids);
  }
  const counts = {};
  for (const r of db.conn.prepare(`SELECT severity, COUNT(*) AS n FROM cvp_event WHERE ${where.join(' AND ')} GROUP BY severity`).all(...args)) counts[r.severity] = Number(r.n);
  // v2.646: 심각도 묶음(오류 = critical+error) — 배열이면 IN.
  if (Array.isArray(severity) && severity.length) { const sv = severity.slice(0, 8).map(String); where.push(`severity IN (${sv.map(() => '?').join(',')})`); pushAll(args, sv); }
  else if (severity && !Array.isArray(severity)) { where.push('severity=?'); args.push(String(severity)); }
  const lim = Math.max(1, Math.min(2000, Number(limit) || 500));
  const rows = db.conn.prepare(`SELECT * FROM cvp_event WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`).all(...args, lim + 1);
  return {
    events: rows.slice(0, lim).map((r) => ({ agent: r.agent, cvpId: r.cvp_id, key: r.ev_key, ts: Number(r.ts), severity: r.severity, title: r.title || '', desc: r.descr || '',
      type: r.ev_type || '', devices: parseJson(r.devices_json) || [], ack: r.ack == null ? null : r.ack === 1, updatedAt: r.updated_at == null ? null : Number(r.updated_at), deleted: r.deleted === 1 })),
    counts, ...(countsByCvp ? { countsByCvp } : {}), ...(rows.length > lim ? { truncated: true, limit: lim } : {}),
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
      inBps: r.in_bps, outBps: r.out_bps, inUtil: r.in_util, outUtil: r.out_util, util, inErr: r.in_err, outErr: r.out_err, inDrop: r.in_drop ?? null, outDrop: r.out_drop ?? null, rateAt: Number(r.rate_ts) });
  }
  list.sort((a, b) => b.util - a.util);
  const lim = Math.max(1, Math.min(2000, Number(limit) || 200));
  return { ports: list.slice(0, lim), counts, ...(list.length > lim ? { omitted: list.length - lim, limit: lim } : {}), staleMs };
}

/**
 * v2.645: 장비별 트래픽 합(마지막 수집의 순간값 bps) — Overview·법인별 트래픽이 쓴다.
 *   measured = 링크 올라옴 + 처리량이 staleMs 안(수신·송신 중 하나라도 값 있음) · unmeasured = 링크 올라옴인데 그렇지 않은 포트.
 *   합은 SQL SUM 이라 NULL 방향은 건너뛴다(한 방향만 읽은 포트는 그 방향만 더한다). GROUP BY 는 합계라 '최신 1건' 함정과 무관하다
 *   (port_latest 가 이미 최신 표다).
 */
export async function trafficByDevice({ staleMs = 30 * 60_000, now = Date.now() } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const cut = Math.trunc(now - Math.max(60_000, Number(staleMs) || 0));
  const rows = db.conn.prepare(`SELECT agent, cvp_id, device_key,
      SUM(CASE WHEN fresh THEN in_bps END) AS in_sum, SUM(CASE WHEN fresh THEN out_bps END) AS out_sum,
      SUM(fresh) AS measured, SUM(oper='up' AND NOT fresh) AS unmeasured
    FROM (SELECT agent, cvp_id, device_key, oper, in_bps, out_bps,
            (oper='up' AND rate_ts IS NOT NULL AND rate_ts >= ? AND (in_bps IS NOT NULL OR out_bps IS NOT NULL)) AS fresh
          FROM port_latest)
    GROUP BY agent, cvp_id, device_key`).all(cut);
  // v2.720(감사 B1-06): 신선한 포트가 있어도 그 방향 값을 하나도 못 읽었으면(SUM 이 NULL) 0 bps 가 아니라 null — '수신 없음' 이라는 거짓을 만들지 않는다.
  return { rows: rows.map((r) => ({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, inBps: r.in_sum == null ? null : Number(r.in_sum), outBps: r.out_sum == null ? null : Number(r.out_sum),
    measured: Number(r.measured || 0), unmeasured: Number(r.unmeasured || 0) })) };
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
    // v2.933(C-③): EndpointLocation — 물어본 지 EP_RETENTION_DAYS 가 넘은 MAC(사라진 VM 등)은 지운다.
    await chunkedDelete(db.conn.prepare('DELETE FROM ep_loc WHERE rowid IN (SELECT rowid FROM ep_loc WHERE at < ? LIMIT ?)'), [now - EP_RETENTION_DAYS * DAY_MS], { chunk: PRUNE_CHUNK });
    await chunkedDelete(db.conn.prepare('DELETE FROM ep_meta WHERE rowid IN (SELECT rowid FROM ep_meta WHERE at < ? LIMIT ?)'), [now - EP_RETENTION_DAYS * DAY_MS], { chunk: PRUNE_CHUNK });
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

/**
 * v2.922(3a) — 베어메탈 서버 NIC ↔ 스위치 포트 대조용 포트 최신값(설명·속도·상태·처리량·오류·드롭 + 장비 이름).
 *   CVP 이력은 복제 적재하지 않는다(설계 §10) — 서버 성능 화면이 조회할 때 이 최신 표를 읽는다. cvpIds 가 빈 배열이면 0행(넓히지 않는다).
 */
export async function portLatestRows({ cvpIds = null, limit = 50_000 } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  if (Array.isArray(cvpIds) && !cvpIds.length) return { rows: [] };
  const ids = Array.isArray(cvpIds) ? cvpIds.slice(0, 256).map(String) : null;
  const where = ids ? `WHERE p.cvp_id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = db.conn.prepare(`SELECT p.agent, p.cvp_id, p.device_key, p.port, p.ts, p.descr, p.speed_bps, p.oper, p.admin, p.lag,
      p.in_bps, p.out_bps, p.in_util, p.out_util, p.in_err, p.out_err, p.in_drop, p.out_drop, p.rate_ts, d.hostname
    FROM port_latest p LEFT JOIN device_latest d ON d.agent=p.agent AND d.cvp_id=p.cvp_id AND d.device_key=p.device_key ${where} LIMIT ?`).all(...(ids || []), limit + 1);
  return { rows: rows.slice(0, limit), ...(rows.length > limit ? { truncated: true } : {}) };
}

/* ── v2.924(SAN·CVP 설계 B-②) — LLDP 이웃 · MAC 테이블 ────────────────────────────────────────────────────────────────────
 * 장비마다 최신 한 벌만 둔다(읽을 때마다 그 장비 행을 바꾼다 — 이력은 두지 않는다). 배열을 받았을 때만 바꾸고, null(못 읽음)은 실패 시각만 적는다 —
 *   이전 목록은 남고 화면이 시각으로 오래됨을 말한다. 내용 해시를 메타에 두어 엣지 push 가 바뀐 장비만 보낸다.
 */
const L2_FDB_MAX = 4096; const L2_LLDP_MAX = 512;   // parse.FDB_MAX · LLDP_MAX 와 같은 값(정제·push 가 같은 상한)
const l2Hash = (rows) => crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 20);
const macOk = (m) => typeof m === 'string' && /^[0-9a-f]{12}$/.test(m);
const vlanOf = (v) => { const n = numOrNull(v); return n != null && n >= 0 && n <= 4095 ? Math.trunc(n) : -1; };
/** 정렬된 FDB 행 [[mac, vlan, port]] — 해시·push·저장이 같은 순서를 쓴다. */
export function fdbRowsOf(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const mac = Array.isArray(e) ? e[0] : e?.mac; const port = txt(Array.isArray(e) ? e[2] : e?.port, 64);
    if (!macOk(mac) || !port) continue;
    out.push([mac, vlanOf(Array.isArray(e) ? e[1] : e?.vlan), port]);
    if (out.length >= L2_FDB_MAX) break;
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
}
/** 정렬된 LLDP 행 [[port, idx, sysName, portId, portDesc, chassisId]]. */
export function lldpRowsOf(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const a = Array.isArray(e) ? e : [e?.port, e?.idx, e?.sysName, e?.portId, e?.portDesc, e?.chassisId];
    const port = txt(a[0], 64); if (!port) continue;
    out.push([port, txt(a[1], 64) || '0', txt(a[2], 255) || '', txt(a[3], 128) || '', txt(a[4], 200) || '', txt(a[5], 128) || '']);
    if (out.length >= L2_LLDP_MAX) break;
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

/**
 * 장비별 L2 적재(로컬 수집 · 엣지 push 공용). items: [{ key, ts, fdb?: 배열|null|undefined, lldp?: 배열|null|undefined, fdbMeta?, lldpTruncated? }].
 *   장비마다 트랜잭션 1회 · COMMIT 뒤 양보(v2.611 DB2611-04 — BEGIN 을 연 채 양보하지 않는다). 해시가 같으면 행을 다시 쓰지 않고 시각만 올린다.
 * @returns {Promise<{devices:number, fdb:number, lldp:number, unavailable?:true}>}
 */
export async function saveL2(agent, cvpId, items = [], { requireDevice = false } = {}) {
  const db = await open();
  if (!db) return { devices: 0, fdb: 0, lldp: 0, unavailable: true };
  const c = db.conn;
  const st = db.l2st || (db.l2st = {
    meta: c.prepare('SELECT fdb_hash, lldp_hash FROM l2_meta WHERE agent=? AND cvp_id=? AND device_key=?'),
    upMeta: c.prepare(`INSERT INTO l2_meta (agent,cvp_id,device_key) VALUES (?,?,?) ON CONFLICT(agent,cvp_id,device_key) DO NOTHING`),
    fdbMeta: c.prepare('UPDATE l2_meta SET fdb_at=?, fdb_n=?, fdb_truncated=?, fdb_over_json=?, fdb_hash=? WHERE agent=? AND cvp_id=? AND device_key=?'),
    fdbFail: c.prepare('UPDATE l2_meta SET fdb_fail_at=? WHERE agent=? AND cvp_id=? AND device_key=?'),
    lldpMeta: c.prepare('UPDATE l2_meta SET lldp_at=?, lldp_n=?, lldp_truncated=?, lldp_hash=? WHERE agent=? AND cvp_id=? AND device_key=?'),
    lldpFail: c.prepare('UPDATE l2_meta SET lldp_fail_at=? WHERE agent=? AND cvp_id=? AND device_key=?'),
    delFdb: c.prepare('DELETE FROM l2_fdb WHERE agent=? AND cvp_id=? AND device_key=?'),
    insFdb: c.prepare('INSERT OR IGNORE INTO l2_fdb (agent,cvp_id,device_key,mac,vlan,port,ts) VALUES (?,?,?,?,?,?,?)'),
    delLldp: c.prepare('DELETE FROM l2_lldp WHERE agent=? AND cvp_id=? AND device_key=?'),
    insLldp: c.prepare('INSERT OR IGNORE INTO l2_lldp (agent,cvp_id,device_key,port,idx,sys_name,sys_lc,sys_short,port_id,port_desc,chassis_id,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'),
    delLldpPort: c.prepare('DELETE FROM l2_lldp WHERE agent=? AND cvp_id=? AND device_key=? AND port=?'),
    allLldp: c.prepare('SELECT port, idx, sys_name, port_id, port_desc, chassis_id FROM l2_lldp WHERE agent=? AND cvp_id=? AND device_key=? ORDER BY port, idx'),
    hasDev: c.prepare('SELECT 1 AS x FROM device_latest WHERE agent=? AND cvp_id=? AND device_key=?'),
  });
  let nd = 0; let nf = 0; let nl = 0; let skipped = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const key = txt(it?.key, 128); const ts = numOrNull(it?.ts);
    if (!key || ts == null || (it.fdb === undefined && it.lldp === undefined)) continue;
    // v2.924(반증 L-6): 중앙은 그 엣지가 장비 레코드로 보고한 장비의 L2 만 받는다(장비 목록에 없는 키가 무한히 쌓이지 않게 · 장비 정리가 L2 도 지운다).
    if (requireDevice && !st.hasDev.get(agent, cvpId, key)) { skipped = (skipped || 0) + 1; continue; }
    // v2.924(반증 M-3): 종류마다 읽은 시각을 따로(엣지가 보낸 fdbAt/lldpAt — 없으면 ts). 예전에는 둘 중 늦은 시각 하나로 둘 다 덮어 오래된 LLDP 가 새것처럼 보였다.
    const fdbAt = numOrNull(it.fdbAt) ?? ts; const lldpAt = numOrNull(it.lldpAt) ?? ts;
    if (nd > 0) await new Promise((r) => setImmediate(r));
    c.exec('BEGIN');
    try {
      st.upMeta.run(agent, cvpId, key);
      const m = st.meta.get(agent, cvpId, key) || {};
      if (Array.isArray(it.fdb)) {
        const rows = fdbRowsOf(it.fdb); const h = l2Hash(rows);
        if (h !== m.fdb_hash) { st.delFdb.run(agent, cvpId, key); for (const r of rows) st.insFdb.run(agent, cvpId, key, r[0], r[1], r[2], fdbAt); nf += rows.length; }
        const meta = it.fdbMeta && typeof it.fdbMeta === 'object' ? it.fdbMeta : {};
        const over = Array.isArray(meta.portsOverCap) ? meta.portsOverCap.slice(0, 64).map((x) => ({ port: txt(x?.port, 64) || '', macs: numOrNull(x?.macs) })) : [];
        st.fdbMeta.run(fdbAt, rows.length, numOrNull(meta.truncated) ?? 0, over.length ? JSON.stringify(over) : null, h, agent, cvpId, key);
      } else if (it.fdb === null) st.fdbFail.run(fdbAt, agent, cvpId, key);
      if (Array.isArray(it.lldp)) {
        const rows = lldpRowsOf(it.lldp);
        const ins = (r) => { const lc = r[2].toLowerCase(); st.insLldp.run(agent, cvpId, key, r[0], r[1], r[2] || null, lc || null, lc ? lc.split('.')[0] : null, r[3] || null, r[4] || null, r[5] || null, lldpAt); };
        if (it.lldpPartial === true) {
          // v2.924(반증 M-2): 포인터 추종이 잘린 부분 읽기 — 읽은 포트만 바꾸고 못 읽은 포트의 이전 이웃은 둔다(목록 전체를 바꾸면 잘린 포트의 이웃이 사라진다).
          for (const port of new Set(rows.map((r) => r[0]))) st.delLldpPort.run(agent, cvpId, key, port);
          for (const r of rows) ins(r);
          const merged = st.allLldp.all(agent, cvpId, key).map((r) => [r.port, r.idx, r.sys_name || '', r.port_id || '', r.port_desc || '', r.chassis_id || '']);
          st.lldpMeta.run(lldpAt, merged.length, numOrNull(it.lldpTruncated) ?? 0, l2Hash(merged), agent, cvpId, key);
          nl += rows.length;
        } else {
          const h = l2Hash(rows);
          if (h !== m.lldp_hash) { st.delLldp.run(agent, cvpId, key); for (const r of rows) ins(r); nl += rows.length; }
          st.lldpMeta.run(lldpAt, rows.length, numOrNull(it.lldpTruncated) ?? 0, h, agent, cvpId, key);
        }
      } else if (it.lldp === null) st.lldpFail.run(lldpAt, agent, cvpId, key);
      c.exec('COMMIT');
      nd++;
    } catch (e) { try { c.exec('ROLLBACK'); } catch { /* */ } throw e; }
  }
  return { devices: nd, fdb: nf, lldp: nl, ...(skipped ? { skipped } : {}) };
}

/** 엣지 push 용 메타(장비별 해시·시각) — 행은 읽지 않는다(바뀐 장비만 l2RecordFor 로 읽는다). */
export async function l2MetaFor(agent, cvpId) {
  const db = await open();
  if (!db) return null;
  return db.conn.prepare('SELECT device_key, fdb_at, fdb_hash, lldp_at, lldp_hash FROM l2_meta WHERE agent=? AND cvp_id=?').all(agent, cvpId)
    .map((r) => ({ key: r.device_key, fdbAt: r.fdb_at ?? null, fdbHash: r.fdb_hash || '', lldpAt: r.lldp_at ?? null, lldpHash: r.lldp_hash || '' }));
}
/** 엣지 push 용 장비 한 대의 L2 레코드(배열 모양 — 정제가 같은 모양을 받는다). 읽은 적 없는 쪽은 싣지 않는다. */
export async function l2RecordFor(agent, cvpId, key) {
  const db = await open();
  if (!db) return null;
  const m = db.conn.prepare('SELECT * FROM l2_meta WHERE agent=? AND cvp_id=? AND device_key=?').get(agent, cvpId, key);
  if (!m) return null;
  const out = { key, ts: Math.max(Number(m.fdb_at) || 0, Number(m.lldp_at) || 0), fdbAt: m.fdb_at ?? null, lldpAt: m.lldp_at ?? null };   // v2.924(반증 M-3): 종류마다 시각
  if (m.fdb_at != null) {
    out.fdb = db.conn.prepare('SELECT mac, vlan, port FROM l2_fdb WHERE agent=? AND cvp_id=? AND device_key=? ORDER BY mac, vlan LIMIT ?').all(agent, cvpId, key, L2_FDB_MAX).map((r) => [r.mac, r.vlan, r.port]);
    out.fdbMeta = { truncated: Number(m.fdb_truncated) || 0, portsOverCap: (() => { try { return JSON.parse(m.fdb_over_json || '[]'); } catch { return []; } })() };
  }
  if (m.lldp_at != null) {
    out.lldp = db.conn.prepare('SELECT port, idx, sys_name, port_id, port_desc, chassis_id FROM l2_lldp WHERE agent=? AND cvp_id=? AND device_key=? ORDER BY port, idx LIMIT ?').all(agent, cvpId, key, L2_LLDP_MAX)
      .map((r) => [r.port, r.idx, r.sys_name || '', r.port_id || '', r.port_desc || '', r.chassis_id || '']);
    out.lldpTruncated = Number(m.lldp_truncated) || 0;
  }
  return out;
}

const devNameJoin = 'LEFT JOIN device_latest d ON d.agent = x.agent AND d.cvp_id = x.cvp_id AND d.device_key = x.device_key';
/** MAC 목록(정규화 12자)이 학습된 포트 — 500개씩 나눠 묻는다(IN 목록 상한). 장비 호스트명을 붙인다. */
export async function fdbByMacs(macs = [], { limit = 2000 } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const list = [...new Set((Array.isArray(macs) ? macs : []).filter(macOk))].slice(0, 2048);
  const rows = []; let truncated = false;
  // v2.924(반증 L-3): 조각마다 '남은 자리 + 1' 을 물어 상한에 닿았는지 안다(예전에는 첫 조각에서 상한에 닿아도 truncated 가 서지 않았다).
  //   호출자는 NIC MAC 과 VM MAC 을 따로 묻는다 — 한 번에 물으면 VM MAC 행이 상한을 채워 NIC MAC 행이 빠진다.
  let i = 0;
  for (; i < list.length && rows.length < limit; i += 500) {
    const part = list.slice(i, i + 500);
    const room = limit - rows.length;
    const got = db.conn.prepare(`SELECT x.agent, x.cvp_id, x.device_key, x.mac, x.vlan, x.port, x.ts, d.hostname FROM l2_fdb x ${devNameJoin} WHERE x.mac IN (${part.map(() => '?').join(',')}) LIMIT ?`).all(...part, room + 1);
    if (got.length > room) truncated = true;
    for (const r of got.slice(0, room)) rows.push({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, hostname: r.hostname || '', mac: r.mac, vlan: r.vlan < 0 ? null : r.vlan, port: r.port, ts: Number(r.ts) });
  }
  if (i < list.length) truncated = true;   // 상한에 닿아 묻지 못한 MAC 조각이 남았다
  return { rows, ...(truncated ? { truncated: true } : {}) };
}
/** 장비들의 포트별 학습 MAC 수(장비마다 한 문장 · 집계 함수 하나). key: `${agent}\u0000${cvpId}\u0000${key}` → Map(port → n). */
export async function fdbPortTotals(devices = []) {
  const out = new Map();
  const db = await open();
  if (!db) return out;
  const q = db.conn.prepare('SELECT port, COUNT(*) AS n FROM l2_fdb WHERE agent=? AND cvp_id=? AND device_key=? GROUP BY port');
  for (const d of (Array.isArray(devices) ? devices : []).slice(0, 64)) {
    out.set(`${d.agent ?? ''}\u0000${d.cvpId}\u0000${d.key}`, new Map(q.all(String(d.agent ?? ''), String(d.cvpId), String(d.key)).map((r) => [r.port, Number(r.n)])));
  }
  return out;
}
/** LLDP 이웃 시스템 이름(소문자 전체 또는 첫 점 앞)이 맞는 행. */
export async function lldpByNames(names = [], { limit = 256 } = {}) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const ns = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n || '').trim().toLowerCase()).filter((n) => n.length >= 3))].slice(0, 8);
  if (!ns.length) return { rows: [] };
  const ph = ns.map(() => '?').join(',');
  const rows = db.conn.prepare(`SELECT x.*, d.hostname FROM l2_lldp x ${devNameJoin} WHERE x.sys_lc IN (${ph}) OR x.sys_short IN (${ph}) LIMIT ?`).all(...ns, ...ns, limit);
  return { rows: rows.map((r) => ({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, hostname: r.hostname || '', port: r.port, idx: r.idx, sysName: r.sys_name || '', sysLc: r.sys_lc || '', sysShort: r.sys_short || '', portId: r.port_id || '', portDesc: r.port_desc || '', chassisId: r.chassis_id || '', ts: Number(r.ts) })) };
}
/** v2.924(반증 H-1): 포트들의 LLDP 이웃 — MAC 근거 교차 확인용(그 포트의 이웃이 다른 장비면 그 포트는 이 호스트의 업링크가 아니다). 64개 상한. */
export async function lldpByPorts(list = []) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const q = db.conn.prepare('SELECT * FROM l2_lldp WHERE agent=? AND cvp_id=? AND device_key=? AND port=? LIMIT 8');
  const rows = [];
  for (const k of (Array.isArray(list) ? list : []).slice(0, 64)) {
    for (const r of q.all(String(k.agent ?? ''), String(k.cvpId), String(k.key), String(k.port))) {
      rows.push({ agent: r.agent, cvpId: r.cvp_id, key: r.device_key, port: r.port, sysName: r.sys_name || '', sysLc: r.sys_lc || '', sysShort: r.sys_short || '', portId: r.port_id || '', chassisId: r.chassis_id || '', ts: Number(r.ts) });
    }
  }
  return { rows };
}
/** 포트 행(처리량·오류·드롭) — L2 로만 찾은 포트에 지금 값을 붙인다. 64개 상한. */
export async function portsByKeys(list = []) {
  const db = await open();
  if (!db) return { rows: [], unavailable: true };
  const q = db.conn.prepare('SELECT p.*, d.hostname AS dev_hostname FROM port_latest p LEFT JOIN device_latest d ON d.agent = p.agent AND d.cvp_id = p.cvp_id AND d.device_key = p.device_key WHERE p.agent=? AND p.cvp_id=? AND p.device_key=? AND p.port=?');
  const rows = [];
  for (const k of (Array.isArray(list) ? list : []).slice(0, 64)) {
    const p = q.get(String(k.agent ?? ''), String(k.cvpId), String(k.key), String(k.port));
    if (!p) continue;
    rows.push({ agent: p.agent, cvpId: p.cvp_id, key: p.device_key, hostname: p.dev_hostname || '', port: p.port, desc: p.descr ?? '', speedBps: p.speed_bps ?? null, oper: p.oper || 'unknown', admin: p.admin || 'unknown',
      vlan: p.vlan || '', lag: p.lag || '', inBps: p.in_bps ?? null, outBps: p.out_bps ?? null, inUtil: p.in_util ?? null, outUtil: p.out_util ?? null, inErr: p.in_err ?? null, outErr: p.out_err ?? null,
      inDrop: p.in_drop ?? null, outDrop: p.out_drop ?? null, rateTs: p.rate_ts == null ? null : Number(p.rate_ts), ts: Number(p.ts), mac: p.mac ?? null });
  }
  return { rows };
}
/** CVP 서버들의 L2 수집 현황 — 장비 수(MAC 테이블을 읽은 · LLDP 를 읽은) · 가장 최근 시각. 메타 표는 장비 수만큼이라 작다. */
export async function l2Status(owners = []) {
  const db = await open();
  if (!db) return { unavailable: true, fdbDevices: 0, lldpDevices: 0, lastAt: null };
  let fdbDevices = 0; let lldpDevices = 0; let lastAt = null; let fdbFailing = 0; let lldpFailing = 0;
  const q = db.conn.prepare('SELECT fdb_at, lldp_at, fdb_fail_at, lldp_fail_at FROM l2_meta WHERE agent=? AND cvp_id=?');
  for (const o of (Array.isArray(owners) ? owners : []).slice(0, 256)) {
    for (const r of q.all(String(o.agent ?? ''), String(o.cvpId))) {
      if (r.fdb_at != null) fdbDevices++;
      if (r.lldp_at != null) lldpDevices++;
      // v2.924(반증 M-3): 마지막 시도가 실패한 장비(실패 시각이 읽은 시각보다 늦다) — 그 장비의 근거는 오래된 값이다.
      if (r.fdb_fail_at != null && (r.fdb_at == null || Number(r.fdb_fail_at) > Number(r.fdb_at))) fdbFailing++;
      if (r.lldp_fail_at != null && (r.lldp_at == null || Number(r.lldp_fail_at) > Number(r.lldp_at))) lldpFailing++;
      const t = Math.max(Number(r.fdb_at) || 0, Number(r.lldp_at) || 0);
      if (t && (lastAt == null || t > lastAt)) lastAt = t;
    }
  }
  return { fdbDevices, lldpDevices, lastAt, fdbFailing, lldpFailing };
}
/** v2.932(E1-06): l2_meta 없이 남은 고아 L2 행을 찾는 전체 훑기의 최소 간격((agent, CVP)마다 · 프로세스 메모리 — 재기동 뒤 첫 push 는 한 번 훑는다). */
export const L2_FULL_SWEEP_MS = 6 * 3_600_000;
const _l2FullSweepAt = new Map();
export function _resetL2SweepForTest() { _l2FullSweepAt.clear(); }
/** 장비 한 대가 정리되면 그 장비의 L2 행도 지운다(pruneDevices 트랜잭션 안 — 장비당 최대 4096 + 512 행). */
function dropL2(conn, agent, cvpId, key) {
  for (const t of ['l2_fdb', 'l2_lldp', 'l2_meta']) conn.prepare(`DELETE FROM ${t} WHERE agent=? AND cvp_id=? AND device_key=?`).run(agent, cvpId, key);
}
/**
 * v2.924(반증 L-2·L-6): 큰 L2 정리는 COMMIT 밖에서 조각으로(chunkedDelete — 조각마다 양보). where 는 rowid 를 고르는 조건(파라미터는 args).
 *   ① CVP 위임 해제(그 CVP 전체) ② 이름 변형 정리 ③ 장비 목록에 없는 키(고아) — 장비 레코드 없이 L2 만 남은 행.
 */
async function dropL2Where(conn, where, args) {
  let n = 0;
  for (const t of ['l2_fdb', 'l2_lldp', 'l2_meta']) {
    const stmt = conn.prepare(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${where} LIMIT ?)`);
    n += (await chunkedDelete(stmt, args, { chunk: 2000, maxRows: 0 })).deleted;
  }
  return n;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * v2.933(SAN·CVP 설계 C-③) — CVP EndpointLocation(MAC → 지금 배운 스위치 · 포트). 경로 · 응답 필드는 추정(cvp/endpoint.js).
 * ══════════════════════════════════════════════════════════════════════════════ */
export const EP_RETENTION_DAYS = 8;
export const EP_LOC_MAX = 16;   // MAC 하나의 위치 상한(트렁크 · MLAG 양쪽 · Vxlan)
async function dropEpWhere(conn, where, args) {
  let n = 0;
  for (const t of ['ep_loc', 'ep_meta']) {
    const stmt = conn.prepare(`DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${where} LIMIT ?)`);
    n += (await chunkedDelete(stmt, args, { chunk: 2000, maxRows: 0 })).deleted;
  }
  return n;
}
/**
 * 결과 저장 — MAC 마다 위치 표를 통째로 바꾸고(옛 위치는 지운다 — vMotion 뒤 옛 포트가 남지 않게) 메타를 갱신한다. 한 트랜잭션 · COMMIT 뒤 양보.
 * @param {Array<{mac:string, at:number, status:'ok'|'none'|'error'|'unsupported', reason?:string, locations?:Array}>} results
 */
export async function saveEndpoints(agent, cvpId, results = []) {
  const db = await open();
  if (!db) return { saved: 0, unavailable: true };
  const c = db.conn; const a = String(agent ?? ''); const id = String(cvpId);
  const del = c.prepare('DELETE FROM ep_loc WHERE agent=? AND cvp_id=? AND mac=?');
  const ins = c.prepare('INSERT OR REPLACE INTO ep_loc (agent,cvp_id,mac,device,port,vlan,learned_at,mac_type,likelihood,at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const meta = c.prepare(`INSERT INTO ep_meta (agent,cvp_id,mac,at,status,n,reason,seq) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(agent,cvp_id,mac) DO UPDATE SET at=excluded.at, status=excluded.status, n=excluded.n, reason=excluded.reason, seq=excluded.seq`);
  let saved = 0;
  c.exec('BEGIN');
  try {
    let seq = Number(c.prepare('SELECT MAX(seq) AS s FROM ep_meta').get()?.s) || 0;   // 트랜잭션 안 — 쓰기 순서 = 순번 순서
    for (const r of (Array.isArray(results) ? results : []).slice(0, 2000)) {
      const mac = String(r?.mac || '');
      if (!/^[0-9a-f]{12}$/.test(mac) || !Number.isFinite(Number(r.at))) continue;
      const st = ['ok', 'none', 'error', 'unsupported'].includes(r.status) ? r.status : 'error';
      if (st === 'ok' || st === 'none') {
        del.run(a, id, mac);
        for (const l of (Array.isArray(r.locations) ? r.locations : []).slice(0, EP_LOC_MAX)) {
          if (!l?.device || !l?.port) continue;
          const vl = Number.isInteger(l.vlan) && l.vlan >= 0 && l.vlan <= 4095 ? l.vlan : -1;
          ins.run(a, id, mac, String(l.device).slice(0, 64), String(l.port).slice(0, 64), vl, l.learnedAt == null ? null : String(l.learnedAt).slice(0, 40),
            l.macType == null ? null : String(l.macType).slice(0, 40), l.likelihood == null ? null : String(l.likelihood).slice(0, 40), Math.trunc(Number(r.at)));
        }
      }
      // 오류 · 미지원은 위치를 지우지 않는다(직전 값이 '없음' 이 되지 않게) — 메타만 그 사실을 적는다.
      seq += 1;
      meta.run(a, id, mac, Math.trunc(Number(r.at)), st, st === 'ok' ? Math.min(EP_LOC_MAX, (r.locations || []).length) : st === 'none' ? 0 : null, r.reason ? String(r.reason).slice(0, 200) : null, seq);
      saved += 1;
    }
    c.exec('COMMIT');
  } catch (e) { try { c.exec('ROLLBACK'); } catch { /* */ } throw e; }
  await new Promise((r) => setImmediate(r));
  return { saved };
}
/** 그 CVP 의 MAC → 마지막으로 물어본 시각(주기 선택 · 엣지 push 의 변경분). */
export async function epMetaFor(agent, cvpId) {
  const db = await open();
  if (!db) return new Map();
  return new Map(db.conn.prepare('SELECT mac, at FROM ep_meta WHERE agent=? AND cvp_id=?').all(String(agent ?? ''), String(cvpId)).map((r) => [r.mac, Number(r.at)]));
}
/** 엣지 push — 순번 sinceSeq 뒤에 쓴 MAC 의 결과(메타 + 위치 + seq). 먼저 쓴 것부터 limit 개(v2.933 반증 L-5 — 시각 커서가 아니라 순번). */
export async function endpointsSince(agent, cvpId, sinceSeq = 0, limit = 500) {
  const db = await open();
  if (!db) return null;
  const a = String(agent ?? ''); const id = String(cvpId);
  const metas = db.conn.prepare('SELECT mac, at, status, reason, seq FROM ep_meta WHERE agent=? AND cvp_id=? AND seq > ? ORDER BY seq LIMIT ?').all(a, id, Math.trunc(Number(sinceSeq) || 0), Math.max(1, Math.min(5000, limit)));
  const loc = db.conn.prepare('SELECT device, port, vlan, learned_at, mac_type, likelihood FROM ep_loc WHERE agent=? AND cvp_id=? AND mac=?');
  return metas.map((m) => ({ mac: m.mac, at: Number(m.at), seq: Number(m.seq), status: m.status, ...(m.reason ? { reason: m.reason } : {}),
    locations: m.status === 'ok' ? loc.all(a, id, m.mac).map((l) => ({ device: l.device, port: l.port, vlan: l.vlan >= 0 ? l.vlan : null, learnedAt: l.learned_at, macType: l.mac_type, likelihood: l.likelihood })) : [] }));
}
/**
 * 화면용 — MAC 들의 위치(담당 CVP 행만 · owners = [{agent, cvpId}] 가 주어지면 그것만). 장비 호스트명을 붙인다(device = device_key 또는 시리얼).
 * @returns {{ rows: object[], meta: Map<string, object[]> }} meta: mac → [{agent,cvpId,at,status,reason}]
 */
export async function endpointsByMacs(macs = [], { owners = null } = {}) {
  const db = await open();
  if (!db) return { rows: [], meta: new Map(), unavailable: true };
  const list = [...new Set((Array.isArray(macs) ? macs : []).map((m) => String(m || '').toLowerCase().slice(0, 64).replace(/[^0-9a-f]/g, '')).filter((m) => /^[0-9a-f]{12}$/.test(m)))].slice(0, 256);   // 콜론 · 하이픈 표기도
  if (!list.length) return { rows: [], meta: new Map() };
  // 담당 엣지 이름은 대소문자를 가리지 않는다(v2.933 반증 M-5 — 등록부 'Edge-A' · 저장 키 'edge-a' 행이 빠졌다).
  const own = Array.isArray(owners) ? new Set(owners.map((o) => `${String(o.agent ?? '').toLowerCase()}\u0000${o.cvpId}`)) : null;
  const ok = (r) => !own || own.has(`${String(r.agent ?? '').toLowerCase()}\u0000${r.cvp_id}`);
  const ph = list.map(() => '?').join(',');
  const rows = db.conn.prepare(`SELECT e.*, d.hostname AS dev_hostname, d.device_key AS dev_key FROM ep_loc e
      LEFT JOIN device_latest d ON d.agent = e.agent AND d.cvp_id = e.cvp_id AND (d.device_key = e.device OR d.serial = e.device)
      WHERE e.mac IN (${ph}) LIMIT 2000`).all(...list).filter(ok)
    .map((r) => ({ agent: r.agent, cvpId: r.cvp_id, mac: r.mac, device: r.device, key: r.dev_key || r.device, hostname: r.dev_hostname || '', port: r.port,
      vlan: r.vlan >= 0 ? r.vlan : null, learnedAt: r.learned_at, macType: r.mac_type, likelihood: r.likelihood, at: Number(r.at) }));
  const meta = new Map();
  for (const m of db.conn.prepare(`SELECT * FROM ep_meta WHERE mac IN (${ph})`).all(...list).filter(ok)) {
    if (!meta.has(m.mac)) meta.set(m.mac, []);
    meta.get(m.mac).push({ agent: m.agent, cvpId: m.cvp_id, at: Number(m.at), status: m.status, reason: m.reason || null });
  }
  return { rows, meta };
}
/** 수집 현황 — 물어본 MAC 수 · 가장 최근 시각 · 미지원 CVP 수(owners 기준). */
export async function epStatus(owners = []) {
  const db = await open();
  if (!db) return { unavailable: true, macs: 0, lastAt: null, unsupported: 0 };
  let macs = 0; let lastAt = null; let unsupported = 0;
  const q1 = db.conn.prepare('SELECT COUNT(*) AS n FROM ep_meta WHERE agent=? COLLATE NOCASE AND cvp_id=?');
  const q2 = db.conn.prepare('SELECT MAX(at) AS t FROM ep_meta WHERE agent=? COLLATE NOCASE AND cvp_id=?');
  const q3 = db.conn.prepare("SELECT 1 FROM ep_meta WHERE agent=? COLLATE NOCASE AND cvp_id=? AND status='unsupported' LIMIT 1");
  for (const o of (Array.isArray(owners) ? owners : []).slice(0, 256)) {
    const a = String(o.agent ?? ''); const id = String(o.cvpId);
    macs += Number(q1.get(a, id)?.n || 0);
    const t = numOrNull(q2.get(a, id)?.t);
    if (t != null && (lastAt == null || t > lastAt)) lastAt = t;
    if (q3.get(a, id)) unsupported += 1;
  }
  return { macs, lastAt, unsupported };
}
