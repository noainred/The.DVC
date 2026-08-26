/**
 * vmtrack/db.js — VM 수량 추이 전용 시계열 DB(v2.345, 사용자 요구: "별도의 DB 를 만들어서 트래킹").
 * CONFIG_DIR/vm-track.db (업그레이드에 보존). node:sqlite 사용 — 없으면 기능을 비활성으로
 * 정직하게 보고한다(NDJSON 폴백을 두지 않는 이유: 이 기능의 조회는 전부 집계/조인이라
 * 파일 스캔 폴백이 실익 없이 복잡도만 키운다. 상태는 API 가 available:false 로 노출).
 *
 * 스키마 3종 — '수량 차트'와 '증감 클릭 → 어떤 VM 인가'를 모두 싸게 만드는 구조:
 *   snaps   : 스냅샷 1행 = (슬롯, vCenter) 의 총 VM 수 + 증감 요약. 차트/표의 원천.
 *             28 vCenter × 2회/일 = 연 ~20,440행(작음).
 *   changes : 그 스냅샷에서 '생긴/사라진/전원이 바뀐' VM 만 1행씩(kind) — 클러스터·호스트·DS 포함.
 *             전량 로스터를 매번 저장하면 5,850 VM × 2회/일 = 연 427만 행이 되므로 diff 만 남긴다.
 *   roster  : 현재 살아있는 VM 집합(vCenter별). 다음 스냅샷의 diff 기준(steady-state ~5,850행).
 *
 * PRAGMA 는 저장소 규칙대로 WAL + synchronous=NORMAL + busy_timeout(CLAUDE.md 성능 불변조건).
 * 적재는 단일 트랜잭션(수천 행 INSERT 를 fsync 1회로) — 이벤트 루프 블로킹 최소화.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = process.env.VMTRACK_DB_PATH
  || path.join(process.env.CONFIG_DIR || path.resolve(process.cwd(), 'config'), 'vm-track.db');

let impl = null;
let ready = null;
let initError = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    try { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;'); } catch { /* 구버전 폴백 */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS snaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slot TEXT NOT NULL,            -- 'YYYY-MM-DDT00' | 'YYYY-MM-DDT12' (로컬 기준 슬롯 키)
        ts INTEGER NOT NULL,           -- 실제 수집 시각(ms)
        vcenter_id TEXT NOT NULL,      -- '' = 전체 합계 행(차트 상단 라인)
        total INTEGER NOT NULL,
        on_count INTEGER NOT NULL DEFAULT 0,
        added INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        -- 전원 전환(v2.347): 직전 슬롯 대비 off→on / on→off 로 바뀐 VM 수.
        -- 신규 생성·삭제는 전환이 아니라 added/removed 로만 센다(중복 집계 방지).
        powered_on INTEGER NOT NULL DEFAULT 0,
        powered_off INTEGER NOT NULL DEFAULT 0,
        -- 데이터스토어 사용량(v2.348): 그 vCenter 에 연결된 DS 의 개수·총용량·사용량(GB) 합.
        -- 사용률·증감은 이 값들로 계산해 저장을 늘리지 않는다(GB 는 REAL — TB 환산 시 반올림 오차 방지).
        ds_count INTEGER NOT NULL DEFAULT 0,
        ds_cap_gb REAL NOT NULL DEFAULT 0,
        ds_used_gb REAL NOT NULL DEFAULT 0,
        baseline INTEGER NOT NULL DEFAULT 0, -- 1 = 최초 기준선(직전 스냅샷 없음 → 증감 0)
        UNIQUE (slot, vcenter_id)
      );
      CREATE INDEX IF NOT EXISTS idx_snaps_vc_ts ON snaps (vcenter_id, ts);
      CREATE INDEX IF NOT EXISTS idx_snaps_ts ON snaps (ts); -- prune(ts<?) 풀스캔 방지

      CREATE TABLE IF NOT EXISTS changes (
        snap_id INTEGER NOT NULL,      -- snaps.id (해당 vCenter 행)
        ts INTEGER NOT NULL,
        vcenter_id TEXT NOT NULL,
        kind TEXT NOT NULL,            -- 'added' | 'removed' | 'powered_on' | 'powered_off'(v2.347 전원 전환)
        vm_id TEXT NOT NULL,
        name TEXT, cluster TEXT, host TEXT, datastore TEXT,
        power_state TEXT, cpu INTEGER, mem_mb INTEGER, storage_gb REAL, guest_os TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_changes_snap ON changes (snap_id);
      CREATE INDEX IF NOT EXISTS idx_changes_ts ON changes (ts);

      -- 데이터스토어 변경분(v2.348) — 슬롯별로 '의미 있게 바뀐' DS 만 1행씩(임계 미만 변화는 저장 안 함).
      -- 전 DS 를 매 슬롯 저장하면 28 vCenter × 수백 DS × 2회/일 = 연 수백만 행이 되므로 diff 만 남긴다.
      CREATE TABLE IF NOT EXISTS ds_changes (
        snap_id INTEGER NOT NULL, ts INTEGER NOT NULL, vcenter_id TEXT NOT NULL,
        kind TEXT NOT NULL,            -- 'ds_added' | 'ds_removed' | 'ds_changed'
        ds_id TEXT NOT NULL, name TEXT, type TEXT,
        cap_gb REAL, used_gb REAL, free_gb REAL, usage_pct REAL,
        prev_used_gb REAL, delta_gb REAL
      );
      CREATE INDEX IF NOT EXISTS idx_dschanges_snap ON ds_changes (snap_id);
      CREATE INDEX IF NOT EXISTS idx_dschanges_ts ON ds_changes (ts);

      -- 데이터스토어별 시계열(v2.353) — diff-압축: 첫 관측과 사용량/용량이 임계(기본 1GB) 이상
      -- 바뀐 슬롯만 1행. 조회는 '마지막 관측값 유지(step)'로 이어붙인다. UNIQUE(slot, ds_id) 로
      -- 같은 슬롯 재실행(수동 스냅샷)은 중복 없이 갱신된다. name/type 은 ds_roster 가 진실.
      CREATE TABLE IF NOT EXISTS ds_series (
        slot TEXT NOT NULL, ts INTEGER NOT NULL, vcenter_id TEXT NOT NULL,
        ds_id TEXT NOT NULL, cap_gb REAL, used_gb REAL,
        UNIQUE (slot, ds_id)
      );
      CREATE INDEX IF NOT EXISTS idx_dsseries_ds ON ds_series (ds_id, ts);
      CREATE INDEX IF NOT EXISTS idx_dsseries_ts ON ds_series (ts); -- prune(ts<?) 풀스캔 방지

      -- 현재 DS 집합(vCenter별) — 다음 슬롯 diff 기준(steady-state 수백~수천 행).
      CREATE TABLE IF NOT EXISTS ds_roster (
        vcenter_id TEXT NOT NULL, ds_id TEXT NOT NULL,
        name TEXT, type TEXT, cap_gb REAL, used_gb REAL, free_gb REAL,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (vcenter_id, ds_id)
      );

      CREATE TABLE IF NOT EXISTS roster (
        vcenter_id TEXT NOT NULL, vm_id TEXT NOT NULL,
        name TEXT, cluster TEXT, host TEXT, datastore TEXT,
        power_state TEXT, cpu INTEGER, mem_mb INTEGER, storage_gb REAL, guest_os TEXT,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (vcenter_id, vm_id)
      );
    `);
    // v2.346 에서 만들어진 기존 DB 에는 전원 전환 열이 없다 — 있으면 무해하게 실패하는 ALTER 로
    // 1회 마이그레이션(SQLite 는 IF NOT EXISTS 를 컬럼 추가에 지원하지 않아 try/catch 가 정석).
    for (const col of ['powered_on', 'powered_off', 'ds_count']) {
      try { db.exec(`ALTER TABLE snaps ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`); } catch { /* 이미 존재 */ }
    }
    for (const col of ['ds_cap_gb', 'ds_used_gb']) { // v2.348 — 용량은 REAL
      try { db.exec(`ALTER TABLE snaps ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`); } catch { /* 이미 존재 */ }
    }
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }

    const st = {
      insSnap: db.prepare(`INSERT INTO snaps (slot, ts, vcenter_id, total, on_count, added, removed, powered_on, powered_off,
          ds_count, ds_cap_gb, ds_used_gb, baseline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot, vcenter_id) DO UPDATE SET
          ts=excluded.ts, total=excluded.total, on_count=excluded.on_count,
          added=excluded.added, removed=excluded.removed,
          powered_on=excluded.powered_on, powered_off=excluded.powered_off,
          ds_count=excluded.ds_count, ds_cap_gb=excluded.ds_cap_gb, ds_used_gb=excluded.ds_used_gb,
          baseline=excluded.baseline`),
      delDsChangesOfSnap: db.prepare('DELETE FROM ds_changes WHERE snap_id=?'),
      insDsChange: db.prepare(`INSERT INTO ds_changes
        (snap_id, ts, vcenter_id, kind, ds_id, name, type, cap_gb, used_gb, free_gb, usage_pct, prev_used_gb, delta_gb)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      dsRosterOf: db.prepare('SELECT ds_id, name, type, cap_gb, used_gb, free_gb FROM ds_roster WHERE vcenter_id=?'),
      upsertDsRoster: db.prepare(`INSERT INTO ds_roster (vcenter_id, ds_id, name, type, cap_gb, used_gb, free_gb, first_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vcenter_id, ds_id) DO UPDATE SET
          name=excluded.name, type=excluded.type, cap_gb=excluded.cap_gb,
          used_gb=excluded.used_gb, free_gb=excluded.free_gb`),
      delDsRoster: db.prepare('DELETE FROM ds_roster WHERE vcenter_id=? AND ds_id=?'),
      delDsRosterVc: db.prepare('DELETE FROM ds_roster WHERE vcenter_id=?'),
      dsChangesOf: db.prepare(`SELECT kind, ds_id, name, type, cap_gb, used_gb, free_gb, usage_pct, prev_used_gb, delta_gb, vcenter_id
        FROM ds_changes WHERE snap_id=? ORDER BY ABS(COALESCE(delta_gb,0)) DESC, name`),
      dsChangesOfSlot: db.prepare(`SELECT d.kind, d.ds_id, d.name, d.type, d.cap_gb, d.used_gb, d.free_gb,
          d.usage_pct, d.prev_used_gb, d.delta_gb, d.vcenter_id
        FROM ds_changes d JOIN snaps s ON s.id=d.snap_id
        WHERE s.slot=? ORDER BY ABS(COALESCE(d.delta_gb,0)) DESC, d.name`),
      pruneDsChanges: db.prepare('DELETE FROM ds_changes WHERE ts < ?'),
      // 데이터스토어별 시계열(v2.353)
      insDsSeries: db.prepare(`INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot, ds_id) DO UPDATE SET ts=excluded.ts, cap_gb=excluded.cap_gb, used_gb=excluded.used_gb`),
      dsSeriesOf: db.prepare('SELECT slot, ts, vcenter_id, cap_gb, used_gb FROM ds_series WHERE ds_id=? AND ts>=? ORDER BY ts'),
      dsSeriesPrev: db.prepare('SELECT slot, ts, vcenter_id, cap_gb, used_gb FROM ds_series WHERE ds_id=? AND ts<? ORDER BY ts DESC LIMIT 1'),
      dsSeriesWindow: db.prepare('SELECT ds_id, ts, used_gb, cap_gb FROM ds_series WHERE ts>=? ORDER BY ts'),
      dsSeriesCarry: db.prepare(`SELECT s.ds_id, s.used_gb, s.cap_gb FROM ds_series s
        JOIN (SELECT ds_id, MAX(ts) AS mts FROM ds_series WHERE ts<? GROUP BY ds_id) m
          ON m.ds_id=s.ds_id AND m.mts=s.ts`),
      dsRosterAll: db.prepare('SELECT vcenter_id, ds_id, name, type, cap_gb, used_gb, free_gb, first_seen FROM ds_roster'),
      pruneDsSeries: db.prepare('DELETE FROM ds_series WHERE ts < ?'),
      // 스토리지 변경 이력(v2.355) — 윈도우 내 변경분 전부를 슬롯과 함께(그룹핑은 서비스에서 1회).
      dsChangesWindow: db.prepare(`SELECT d.kind, d.ds_id, d.name, d.type, d.cap_gb, d.used_gb,
          d.usage_pct, d.prev_used_gb, d.delta_gb, d.vcenter_id, s.slot, s.ts AS slot_ts
        FROM ds_changes d JOIN snaps s ON s.id=d.snap_id
        WHERE d.ts>=? ORDER BY s.ts DESC, ABS(COALESCE(d.delta_gb,0)) DESC, d.name`),
      snapId: db.prepare('SELECT id FROM snaps WHERE slot=? AND vcenter_id=?'),
      delChangesOfSnap: db.prepare('DELETE FROM changes WHERE snap_id=?'),
      insChange: db.prepare(`INSERT INTO changes
        (snap_id, ts, vcenter_id, kind, vm_id, name, cluster, host, datastore, power_state, cpu, mem_mb, storage_gb, guest_os)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      rosterOf: db.prepare('SELECT vm_id, name, cluster, host, datastore, power_state, cpu, mem_mb, storage_gb, guest_os FROM roster WHERE vcenter_id=?'),
      rosterVcenters: db.prepare('SELECT DISTINCT vcenter_id FROM roster'),
      upsertRoster: db.prepare(`INSERT INTO roster
        (vcenter_id, vm_id, name, cluster, host, datastore, power_state, cpu, mem_mb, storage_gb, guest_os, first_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vcenter_id, vm_id) DO UPDATE SET
          name=excluded.name, cluster=excluded.cluster, host=excluded.host, datastore=excluded.datastore,
          power_state=excluded.power_state, cpu=excluded.cpu, mem_mb=excluded.mem_mb,
          storage_gb=excluded.storage_gb, guest_os=excluded.guest_os`),
      delRoster: db.prepare('DELETE FROM roster WHERE vcenter_id=? AND vm_id=?'),
      delRosterVc: db.prepare('DELETE FROM roster WHERE vcenter_id=?'),
      series: db.prepare(`SELECT id, slot, ts, vcenter_id, total, on_count, added, removed, powered_on, powered_off, ds_count, ds_cap_gb, ds_used_gb, baseline
        FROM snaps WHERE vcenter_id=? AND ts>=? ORDER BY ts`),
      seriesAllVc: db.prepare(`SELECT id, slot, ts, vcenter_id, total, on_count, added, removed, powered_on, powered_off, ds_count, ds_cap_gb, ds_used_gb, baseline
        FROM snaps WHERE vcenter_id<>'' AND ts>=? ORDER BY ts`),
      // vcenter_id 를 반드시 SELECT 한다 — service 의 scope 필터(!r.vcenter_id||scopeIds.has)가
      // 이 값 없이는 undefined 로 흘러 '전부 통과'가 돼 snapId 로 범위 밖 vCenter 열람이 가능했다.
      changesOf: db.prepare(`SELECT kind, vm_id, name, cluster, host, datastore, power_state, cpu, mem_mb, storage_gb, guest_os, vcenter_id
        FROM changes WHERE snap_id=? ORDER BY kind, name`),
      changesOfSlot: db.prepare(`SELECT c.kind, c.vm_id, c.name, c.cluster, c.host, c.datastore, c.power_state,
          c.cpu, c.mem_mb, c.storage_gb, c.guest_os, c.vcenter_id
        FROM changes c JOIN snaps s ON s.id=c.snap_id
        WHERE s.slot=? ORDER BY c.vcenter_id, c.kind, c.name`),
      lastSlot: db.prepare("SELECT slot, MAX(ts) AS ts FROM snaps WHERE vcenter_id='' "),
      pruneSnaps: db.prepare('DELETE FROM snaps WHERE ts < ?'),
      pruneChanges: db.prepare('DELETE FROM changes WHERE ts < ?'),
      meta: db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS mn, MAX(ts) AS mx FROM snaps WHERE vcenter_id=''"),
    };
    return { db, st };
  });
}

/** DB 준비(1회). 실패 시 available:false 로 남기고 예외를 던지지 않는다. */
export async function getDb() {
  if (impl) return impl;
  if (!ready) {
    ready = initSqlite()
      .then((x) => { impl = x; return x; })
      .catch((err) => {
        initError = err.message || String(err);
        console.warn(`[vmtrack] DB 초기화 실패 — 기능 비활성: ${initError}`);
        return null;
      });
  }
  return ready;
}

export function vmtrackStatus() {
  return { available: Boolean(impl), dbPath: DB_PATH, error: impl ? null : initError };
}

/**
 * 스냅샷 커밋 — (슬롯, vCenter별) 총계·증감 + changes + roster 갱신을 **단일 트랜잭션**으로.
 * @param {{slot:string, ts:number, perVc:Array, totalRow:object}} payload
 *   perVc: [{ vcenterId, total, onCount, added:[vm...], removed:[vm...],
 *             poweredOn:[vm...], poweredOff:[vm...], live:[vm...], baseline }]
 */
export async function commitSnapshot({ slot, ts, perVc, totalRow }) {
  const x = await getDb();
  if (!x) return { ok: false, reason: 'vmtrack DB 사용 불가' };
  const { db, st } = x;
  db.exec('BEGIN');
  try {
    // 전체 합계 행(vcenter_id='') — 차트 상단 라인.
    st.insSnap.run(slot, ts, '', totalRow.total, totalRow.onCount, totalRow.added, totalRow.removed,
      totalRow.poweredOn || 0, totalRow.poweredOff || 0,
      totalRow.dsCount || 0, totalRow.dsCapGB || 0, totalRow.dsUsedGB || 0, totalRow.baseline ? 1 : 0);
    for (const vc of perVc) {
      const ds = vc.ds || null; // { count, capGB, usedGB, added:[], removed:[], changed:[] }
      st.insSnap.run(slot, ts, vc.vcenterId, vc.total, vc.onCount, vc.added.length, vc.removed.length,
        (vc.poweredOn || []).length, (vc.poweredOff || []).length,
        ds?.count || 0, ds?.capGB || 0, ds?.usedGB || 0, vc.baseline ? 1 : 0);
      const row = st.snapId.get(slot, vc.vcenterId);
      const snapId = row?.id;
      if (snapId == null) continue;
      st.delChangesOfSnap.run(snapId); // 같은 슬롯 재실행(수동 스냅샷) 시 중복 방지
      st.delDsChangesOfSnap.run(snapId);
      // 데이터스토어 변경분 + 로스터 동기화(v2.348).
      if (ds) {
        for (const [kind, field] of [['ds_added', 'added'], ['ds_removed', 'removed'], ['ds_changed', 'changed']]) {
          for (const d of ds[field] || []) {
            st.insDsChange.run(snapId, ts, vc.vcenterId, kind, d.dsId, d.name || '', d.type || '',
              d.capGB ?? null, d.usedGB ?? null, d.freeGB ?? null, d.usagePct ?? null,
              d.prevUsedGB ?? null, d.deltaGB ?? null);
          }
        }
        for (const d of ds.live || []) {
          st.upsertDsRoster.run(vc.vcenterId, d.dsId, d.name || '', d.type || '',
            d.capGB ?? null, d.usedGB ?? null, d.freeGB ?? null, ts);
        }
        // 데이터스토어별 시계열(v2.353) — diff 가 골라준 '값이 바뀐' DS 만 기록.
        for (const d of ds.series || []) {
          st.insDsSeries.run(slot, ts, vc.vcenterId, d.dsId, d.capGB ?? null, d.usedGB ?? null);
        }
        for (const d of ds.removed || []) st.delDsRoster.run(vc.vcenterId, d.dsId);
      }
      // kind 별 변경 항목 적재 — 'powered_on'/'powered_off'(v2.347)는 생성·삭제와 같은 표에
      // 담아(kind 로 구분) 클릭 상세가 한 조회로 끝나게 한다.
      for (const [kind, field] of [['added', 'added'], ['removed', 'removed'], ['powered_on', 'poweredOn'], ['powered_off', 'poweredOff']]) {
        for (const vm of vc[field] || []) {
          st.insChange.run(snapId, ts, vc.vcenterId, kind, vm.vmId, vm.name || '', vm.cluster || '',
            vm.host || '', vm.datastore || '', vm.powerState || '', vm.cpu ?? null, vm.memMB ?? null,
            vm.storageGB ?? null, vm.guestOS || '');
        }
      }
      // roster 동기화: added/유지분 upsert, removed 삭제.
      for (const vm of vc.live) {
        st.upsertRoster.run(vc.vcenterId, vm.vmId, vm.name || '', vm.cluster || '', vm.host || '',
          vm.datastore || '', vm.powerState || '', vm.cpu ?? null, vm.memMB ?? null, vm.storageGB ?? null,
          vm.guestOS || '', ts);
      }
      for (const vm of vc.removed) st.delRoster.run(vc.vcenterId, vm.vmId);
    }
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, reason: e.message };
  }
}

/** vCenter 별 직전 로스터(diff 기준). Map<vmId, row>. */
export async function loadRoster(vcenterId) {
  const x = await getDb();
  if (!x) return new Map();
  const rows = x.st.rosterOf.all(String(vcenterId));
  return new Map(rows.map((r) => [r.vm_id, r]));
}

/** roster 에 존재하는 vCenter 목록(등록 해제된 vCenter 정리 판단용). */
export async function rosterVcenters() {
  const x = await getDb();
  if (!x) return [];
  return x.st.rosterVcenters.all().map((r) => r.vcenter_id);
}

/** vCenter 등록 해제 시 로스터 정리(다음 재등록 때 전체가 '신규'로 잡히지 않게 명시 삭제). */
export async function dropRoster(vcenterId) {
  const x = await getDb();
  if (!x) return;
  x.st.delRosterVc.run(String(vcenterId));
  x.st.delDsRosterVc.run(String(vcenterId)); // 데이터스토어 로스터도 함께(v2.348)
}

/** vCenter 별 직전 데이터스토어 로스터(diff 기준, v2.348). Map<dsId, row>. */
export async function loadDsRoster(vcenterId) {
  const x = await getDb();
  if (!x) return new Map();
  return new Map(x.st.dsRosterOf.all(String(vcenterId)).map((r) => [r.ds_id, r]));
}

/** 데이터스토어별 시계열(v2.353) — 윈도우 내 관측 행 + 윈도우 직전 마지막 관측(carry-in). */
export async function readDsSeries({ dsId, sinceTs = 0 } = {}) {
  const x = await getDb();
  if (!x) return { carryIn: null, rows: [] };
  return {
    carryIn: x.st.dsSeriesPrev.get(String(dsId), sinceTs) || null,
    rows: x.st.dsSeriesOf.all(String(dsId), sinceTs),
  };
}

/** 전체 DS 로스터(선택 목록·기간 증감 계산용, v2.353). 현재 ~1,100행 — 작다. */
export async function listDsRoster() {
  const x = await getDb();
  if (!x) return [];
  return x.st.dsRosterAll.all();
}

/** 윈도우 내 전 DS 관측 행(기간 증감 상위 계산용, v2.353). ts 오름차순. */
export async function dsSeriesWindow(sinceTs) {
  const x = await getDb();
  if (!x) return [];
  return x.st.dsSeriesWindow.all(sinceTs);
}

/** 윈도우 시작 직전의 DS 별 마지막 관측값(기간 증감의 시작값, v2.353). */
export async function dsSeriesCarry(beforeTs) {
  const x = await getDb();
  if (!x) return [];
  return x.st.dsSeriesCarry.all(beforeTs);
}

/** 윈도우 내 DS 변경분 전체(슬롯 포함, v2.355 스토리지 변경 이력). */
export async function readDsChangesWindow(sinceTs) {
  const x = await getDb();
  if (!x) return [];
  return x.st.dsChangesWindow.all(sinceTs);
}

/** 데이터스토어 사용량 변경 상세(v2.348). snapId 또는 slot 기준. */
export async function readDsChanges({ snapId = null, slot = null } = {}) {
  const x = await getDb();
  if (!x) return [];
  if (snapId != null) return x.st.dsChangesOf.all(Number(snapId));
  if (slot) return x.st.dsChangesOfSlot.all(String(slot));
  return [];
}

/** 차트용 시계열. vcenterId='' → 전체 합계, 'ALL' → vCenter별 전부. */
export async function readSeries({ vcenterId = '', sinceTs = 0 } = {}) {
  const x = await getDb();
  if (!x) return [];
  return vcenterId === 'ALL' ? x.st.seriesAllVc.all(sinceTs) : x.st.series.all(String(vcenterId), sinceTs);
}

/** 증감 클릭 → 그 스냅샷의 생성/삭제 VM 목록. snapId 또는 slot(전 vCenter) 기준. */
export async function readChanges({ snapId = null, slot = null } = {}) {
  const x = await getDb();
  if (!x) return [];
  if (snapId != null) return x.st.changesOf.all(Number(snapId));
  if (slot) return x.st.changesOfSlot.all(String(slot));
  return [];
}

export async function lastSnapshotSlot() {
  const x = await getDb();
  if (!x) return null;
  const r = x.st.lastSlot.get();
  return r?.slot || null;
}

export async function vmtrackMeta() {
  const x = await getDb();
  if (!x) return { n: 0, mn: null, mx: null };
  return x.st.meta.get() || { n: 0, mn: null, mx: null };
}

/** 보존기간 정리(기본 1,095일 = 3년 — 행이 작아 넉넉히). */
export async function pruneVmtrack(retentionDays = Number(process.env.VMTRACK_RETENTION_DAYS) || 1095) {
  const x = await getDb();
  if (!x) return { ok: false };
  const cut = Date.now() - retentionDays * 86_400_000;
  const { db, st } = x;
  db.exec('BEGIN');
  try {
    st.pruneChanges.run(cut);
    st.pruneDsChanges.run(cut); // v2.348
    st.pruneDsSeries.run(cut); // v2.353
    st.pruneSnaps.run(cut);
    db.exec('COMMIT');
    return { ok: true, cut };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    return { ok: false, reason: e.message };
  }
}
