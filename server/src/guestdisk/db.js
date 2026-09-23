/**
 * guestdisk/db.js — 게스트 디스크 회수 리포트 시계열 DB(v2.459).
 * CONFIG_DIR(또는 config.dbDir)/guest-disk.db. node:sqlite — 없으면 available:false 로 정직하게 보고.
 *
 * 스키마 — '최신 목록/CSV'는 싸게, '추이 차트'는 변경분만(diff-저장):
 *   vm_latest  : VM 1행 = 최신 할당/사용/비율(수집마다 vCenter 단위로 교체). 목록·CSV·회수 순위의 원천.
 *   vm_series  : VM 총 사용/할당의 **변화분만**(첫 관측 + threshold 이상 변할 때). 목록/드릴다운 추이.
 *   part_series: 파티션별 **변화분만**. 파티션 드릴다운 추이.
 *   vm_last / part_last : diff 기준(직전 값). 매 수집 벌크 로드 → 메모리 비교(5,850 VM 쿼리 폭주 방지).
 *
 * 전량 로스터를 매 수집 적재하면 5,850 VM × 파티션 × N회/일 = 수백만 행이 되므로 변화분만 남긴다.
 * PRAGMA WAL + synchronous=NORMAL + busy_timeout(성능 불변조건). 적재는 단일 트랜잭션.
 * prune 는 ts 단독 인덱스로 풀스캔을 피한다(성능 불변조건).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = process.env.GUESTDISK_DB_PATH
  || path.join(config.dbDir || config.configDir, 'guest-disk.db');

let impl = null;
let ready = null;
let initError = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    // v2.503: DB 파일 권한 0600 — v2.447 감사로 12개 DB 모듈에 일괄 적용된 규약인데
    // 이 파일(v2.459 신규)만 빠져 있었다. 게스트 디스크 사용량은 VM 이름·마운트 경로를 담는다.
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* */ }
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS vm_latest (
        vm_id TEXT PRIMARY KEY,
        vcenter_id TEXT NOT NULL,
        vcenter_name TEXT NOT NULL DEFAULT '',
        vm_name TEXT NOT NULL DEFAULT '',
        alloc_gb REAL NOT NULL DEFAULT 0,
        used_gb REAL NOT NULL DEFAULT 0,
        part_count INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vml_vc ON vm_latest (vcenter_id);
      CREATE TABLE IF NOT EXISTS vm_series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vcenter_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        alloc_gb REAL NOT NULL DEFAULT 0,
        used_gb REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_vms_vm_ts ON vm_series (vm_id, ts);
      CREATE INDEX IF NOT EXISTS idx_vms_ts ON vm_series (ts);
      CREATE TABLE IF NOT EXISTS part_series (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vcenter_id TEXT NOT NULL,
        vm_id TEXT NOT NULL,
        path TEXT NOT NULL,
        ts INTEGER NOT NULL,
        cap_gb REAL NOT NULL DEFAULT 0,
        used_gb REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_ps_vm_path_ts ON part_series (vm_id, path, ts);
      CREATE INDEX IF NOT EXISTS idx_ps_ts ON part_series (ts);
      CREATE TABLE IF NOT EXISTS vm_last (
        vm_id TEXT PRIMARY KEY,
        vcenter_id TEXT NOT NULL,
        alloc_gb REAL NOT NULL DEFAULT 0,
        used_gb REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS part_last (
        vm_id TEXT NOT NULL,
        path TEXT NOT NULL,
        vcenter_id TEXT NOT NULL,
        cap_gb REAL NOT NULL DEFAULT 0,
        used_gb REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (vm_id, path)
      );
    `);
    impl = db;
    return db;
  }).catch((e) => { initError = e; impl = null; return null; });
}

export function getDb() {
  if (impl) return Promise.resolve(impl);
  if (!ready) ready = initSqlite();
  return ready;
}

export function guestDiskDbStatus() {
  return { available: Boolean(impl), path: DB_PATH, error: initError ? String(initError.message || initError) : null };
}

/**
 * 한 vCenter 의 수집 결과를 커밋한다(단일 트랜잭션).
 * vms: [{ vmId, vmName, allocGB, usedGB, partCount, parts:[{path,capGB,usedGB}] }]
 */
export async function commitCollection(vcenterId, vcenterName, vms, { ts = Date.now(), changeThresholdGB = 1 } = {}) {
  const db = await getDb();
  if (!db) return { ok: false, reason: 'DB 사용 불가' };
  // 빈 수집 방어: vms 가 비면 DELETE(=이 vCenter latest 전체 삭제)를 건너뛰고 이전 값을 유지한다.
  // 엣지 콜드스타트(morefs 0)·VMware Tools 일시 미보고 주기엔 정상 수집도 빈 배열이 되는데,
  // 그때마다 vm_latest 를 지우면 며칠치 데이터가 blip 1회로 사라져 리포트가 '데이터 없음'으로
  // 오표시된다(정직 원칙: 관측 못 한 것을 '없음'으로 단정하지 않는다 — 오래된 관측이 더 정직).
  // 실제로 VM 이 줄어든 경우(비지 않은 수집)는 아래 DELETE+INSERT 가 사라진 VM 을 정상 제거한다.
  if (!Array.isArray(vms) || vms.length === 0) return { ok: true, vms: 0, vmSeriesRows: 0, partSeriesRows: 0, skippedEmpty: true };
  const thr = Number(changeThresholdGB) || 0;
  // 이 vCenter 의 diff 기준을 벌크 로드(쿼리 폭주 방지).
  const vmLast = new Map();
  for (const r of db.prepare('SELECT vm_id, alloc_gb, used_gb FROM vm_last WHERE vcenter_id=?').all(vcenterId)) vmLast.set(r.vm_id, r);
  const partLast = new Map();
  for (const r of db.prepare('SELECT vm_id, path, cap_gb, used_gb FROM part_last WHERE vcenter_id=?').all(vcenterId)) partLast.set(`${r.vm_id}\u0000${r.path}`, r);

  const insLatest = db.prepare('INSERT OR REPLACE INTO vm_latest (vm_id,vcenter_id,vcenter_name,vm_name,alloc_gb,used_gb,part_count,ts) VALUES (?,?,?,?,?,?,?,?)');
  const insVmSer = db.prepare('INSERT INTO vm_series (vcenter_id,vm_id,ts,alloc_gb,used_gb) VALUES (?,?,?,?,?)');
  const upVmLast = db.prepare('INSERT OR REPLACE INTO vm_last (vm_id,vcenter_id,alloc_gb,used_gb) VALUES (?,?,?,?)');
  const insPartSer = db.prepare('INSERT INTO part_series (vcenter_id,vm_id,path,ts,cap_gb,used_gb) VALUES (?,?,?,?,?,?)');
  const upPartLast = db.prepare('INSERT OR REPLACE INTO part_last (vm_id,path,vcenter_id,cap_gb,used_gb) VALUES (?,?,?,?,?)');

  let vmSeriesRows = 0; let partSeriesRows = 0;
  db.exec('BEGIN');
  try {
    // vm_latest 는 이 vCenter 분을 통째로 교체(변화 없는 VM 도 최신값 유지 + 사라진 VM 제거).
    db.prepare('DELETE FROM vm_latest WHERE vcenter_id=?').run(vcenterId);
    for (const vm of vms) {
      insLatest.run(vm.vmId, vcenterId, vcenterName || '', vm.vmName || '', vm.allocGB, vm.usedGB, vm.partCount || 0, ts);
      const lv = vmLast.get(vm.vmId);
      if (!lv || Math.abs(vm.usedGB - lv.used_gb) >= thr || vm.allocGB !== lv.alloc_gb) {
        insVmSer.run(vcenterId, vm.vmId, ts, vm.allocGB, vm.usedGB); vmSeriesRows++;
        upVmLast.run(vm.vmId, vcenterId, vm.allocGB, vm.usedGB);
      }
      for (const p of (vm.parts || [])) {
        const key = `${vm.vmId}\u0000${p.path}`;
        const lp = partLast.get(key);
        if (!lp || Math.abs(p.usedGB - lp.used_gb) >= thr || p.capGB !== lp.cap_gb) {
          insPartSer.run(vcenterId, vm.vmId, p.path, ts, p.capGB, p.usedGB); partSeriesRows++;
          upPartLast.run(vm.vmId, p.path, vcenterId, p.capGB, p.usedGB);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, reason: String(e.message || e) };
  }
  return { ok: true, vms: vms.length, vmSeriesRows, partSeriesRows };
}

/** 최신 목록 — 선택 vCenter 로 좁힐 수 있다(scope). vcenterIds=null 이면 전체. */
export async function listLatest(vcenterIds = null) {
  const db = await getDb();
  if (!db) return [];
  if (vcenterIds && vcenterIds.length === 0) return [];
  let rows;
  if (vcenterIds) {
    const q = vcenterIds.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM vm_latest WHERE vcenter_id IN (${q})`).all(...vcenterIds);
  } else {
    rows = db.prepare('SELECT * FROM vm_latest').all();
  }
  return rows.map((r) => ({
    vmId: r.vm_id, vcenterId: r.vcenter_id, vcenterName: r.vcenter_name, vmName: r.vm_name,
    allocGB: r.alloc_gb, usedGB: r.used_gb, partCount: r.part_count, ts: r.ts,
  }));
}

/**
 * 한 VM 의 총 사용/할당 추이(diff-저장 점들).
 * ⚠ v2.590 P3: 창(sinceTs) 앞의 **마지막 행을 창 시작점으로 이월**한다(carry-in, `carried:true`). diff-저장은 1GB 이상
 *   바뀔 때만 행을 남기므로, 40일 전 이후 안 바뀐 VM 은 30일 창에 행이 0개였다 — 목록은 파티션 2개라 말하는데 상세는
 *   빈 표·빈 추이였다(오류 없이 틀린 화면). 이월값은 '그 시점에 유효하던 값' 이라 지어낸 값이 아니다.
 */
export async function vmSeries(vmId, sinceTs = 0) {
  const db = await getDb();
  if (!db) return [];
  const rows = db.prepare('SELECT ts, alloc_gb, used_gb FROM vm_series WHERE vm_id=? AND ts>=? ORDER BY ts')
    .all(vmId, sinceTs).map((r) => ({ ts: r.ts, allocGB: r.alloc_gb, usedGB: r.used_gb }));
  if (sinceTs > 0 && (!rows.length || rows[0].ts > sinceTs)) {
    const c = db.prepare('SELECT ts, alloc_gb, used_gb FROM vm_series WHERE vm_id=? AND ts<? ORDER BY ts DESC LIMIT 1').get(vmId, sinceTs);
    if (c) rows.unshift({ ts: sinceTs, allocGB: c.alloc_gb, usedGB: c.used_gb, carried: true, carriedFromTs: c.ts });
  }
  return rows;
}

/** 한 VM 의 파티션별 추이(diff-저장 점들). 창 앞 마지막 행을 경로별로 이월한다(v2.590 P3 — vmSeries 와 같은 이유). */
export async function partSeries(vmId, sinceTs = 0) {
  const db = await getDb();
  if (!db) return [];
  const rows = db.prepare('SELECT path, ts, cap_gb, used_gb FROM part_series WHERE vm_id=? AND ts>=? ORDER BY path, ts')
    .all(vmId, sinceTs).map((r) => ({ path: r.path, ts: r.ts, capGB: r.cap_gb, usedGB: r.used_gb }));
  if (!(sinceTs > 0)) return rows;
  const carry = db.prepare(`SELECT p.path, p.ts, p.cap_gb, p.used_gb FROM part_series p
    WHERE p.vm_id=? AND p.ts = (SELECT MAX(q.ts) FROM part_series q WHERE q.vm_id=p.vm_id AND q.path=p.path AND q.ts<?)`).all(vmId, sinceTs);
  if (!carry.length) return rows;
  const firstTs = new Map();
  for (const r of rows) if (!firstTs.has(r.path)) firstTs.set(r.path, r.ts);
  const add = [];
  for (const c of carry) {
    const f = firstTs.get(c.path);
    if (f != null && f <= sinceTs) continue;
    add.push({ path: c.path, ts: sinceTs, capGB: c.cap_gb, usedGB: c.used_gb, carried: true, carriedFromTs: c.ts });
  }
  return [...add, ...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.ts - b.ts));
}

/**
 * vCenter 별 커버리지 — vm_latest 에 실제로 데이터가 있는 vCenter 의 VM 수·최신 수집 ts.
 * 리포트가 '왜 이 vCenter 는 데이터가 없나'를 정직하게 보이기 위한 근거(수집 여부·신선도).
 * 반환: Map<vcenterId, { vmCount, lastTs }>. vcenterIds=null 이면 전체.
 */
export async function coverageByVcenter(vcenterIds = null) {
  const db = await getDb();
  const map = new Map();
  if (!db) return map;
  if (vcenterIds && vcenterIds.length === 0) return map;
  let rows;
  if (vcenterIds) {
    const q = vcenterIds.map(() => '?').join(',');
    rows = db.prepare(`SELECT vcenter_id, COUNT(*) n, MAX(ts) mt FROM vm_latest WHERE vcenter_id IN (${q}) GROUP BY vcenter_id`).all(...vcenterIds);
  } else {
    rows = db.prepare('SELECT vcenter_id, COUNT(*) n, MAX(ts) mt FROM vm_latest GROUP BY vcenter_id').all();
  }
  for (const r of rows) map.set(r.vcenter_id, { vmCount: r.n || 0, lastTs: r.mt || null });
  return map;
}

/** 한 VM 의 최신 1행(scope 단건 검사용). */
export async function latestOne(vmId) {
  const db = await getDb();
  if (!db) return null;
  const r = db.prepare('SELECT * FROM vm_latest WHERE vm_id=?').get(vmId);
  if (!r) return null;
  return { vmId: r.vm_id, vcenterId: r.vcenter_id, vcenterName: r.vcenter_name, vmName: r.vm_name, allocGB: r.alloc_gb, usedGB: r.used_gb, partCount: r.part_count, ts: r.ts };
}

/** 보존 기간 밖 추이 행 삭제(ts 단독 인덱스로 풀스캔 회피). */
export async function prune(retentionDays = 180) {
  const db = await getDb();
  if (!db) return { ok: false };
  const cut = Date.now() - Math.max(1, retentionDays) * 86_400_000;
  const a = db.prepare('DELETE FROM vm_series WHERE ts<?').run(cut);
  const b = db.prepare('DELETE FROM part_series WHERE ts<?').run(cut);
  // ⚠ v2.590 P3: 행을 다 지운 키의 diff 기준(vm_last·part_last)도 지운다. 남겨 두면 값이 안 바뀌는 VM 은 기준선이
  //   '이미 기록됨' 이라 다음 수집에서도 행을 쓰지 않아 **영원히 추이·파티션이 비었다**(목록은 파티션 N개라 말한다).
  //   기준을 지우면 다음 수집이 첫 관측으로 다시 기록한다. 기준 행 수 = VM·파티션 수라 EXISTS(인덱스)로 가볍다.
  let vmLastCleared = 0; let partLastCleared = 0;
  if ((a.changes || 0) > 0) vmLastCleared = db.prepare('DELETE FROM vm_last WHERE NOT EXISTS (SELECT 1 FROM vm_series s WHERE s.vm_id = vm_last.vm_id)').run().changes || 0;
  if ((b.changes || 0) > 0) partLastCleared = db.prepare('DELETE FROM part_last WHERE NOT EXISTS (SELECT 1 FROM part_series s WHERE s.vm_id = part_last.vm_id AND s.path = part_last.path)').run().changes || 0;
  return { ok: true, vmSeriesDeleted: a.changes || 0, partSeriesDeleted: b.changes || 0, vmLastCleared, partLastCleared };
}

export const _DB_PATH = DB_PATH;
