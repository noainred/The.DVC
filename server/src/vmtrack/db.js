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
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { numOrNull } from '../util/numOrNull.js';
import { performance } from 'node:perf_hooks';
import { chunkedDelete, createPruneFlight, nextAdaptiveChunk, PRUNE_CHUNK_ROWS, PRUNE_MAX_ROWS } from '../util/chunkedPrune.js';
// v2.599 DB2599-02: 첫 open 잠금은 래치하지 않고 잠시 뒤 다시 연다.
const lockRetry = createLockRetry();

/** 없는 열만 추가한다(v2.603). 'duplicate column name'(동시 추가 경합)만 삼키고 잠금·그 밖의 오류는 던진다. @returns {string[]} 추가한 열 */
export function addMissingColumns(db, table, cols) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
  const added = [];
  for (const [col, decl] of cols) {
    if (have.has(col)) continue;
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`); added.push(col); }
    catch (e) { if (!/duplicate column name/i.test(String(e?.message || ''))) throw e; }
  }
  return added;
}

// DB 저장 경로 설정(v2.379)을 따른다 — config.dbDir 이 있으면 그 아래. env 가 최우선.
const DB_PATH = process.env.VMTRACK_DB_PATH
  || path.join(config.dbDir || config.configDir, 'vm-track.db');

let impl = null;
let ready = null;
let initError = null;

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = openSqlite(new DatabaseSync(DB_PATH));   // busy_timeout 먼저 · 잠금이면 닫고 던진다
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
      -- v2.503: '꺼진 지 N일'(powerChangesOf)은 vCenter 마다 한 번씩 불린다. 이 인덱스가 없으면
      -- 계획이 SCAN changes + temp b-tree GROUP BY 라 28 vCenter = 풀스캔 28회다. 열 순서를 쿼리와
      -- 맞춰 **커버링**으로 만들어 테이블 접근까지 없앤다.
      -- 실측(1.23M행 = 28 vCenter × 3년 보존 가정): 2,329ms → 114ms (20.4배). 기존 대형 DB 는 최초
      -- 기동 시 1회 생성 비용이 든다(1.2M행 1,211ms 실측) — metrics/db.js 의 idx_samples_mt 와 같은 선례다.
      -- 주석에 있던 "changes 는 diff 만 저장돼 작다" 전제는 보존 기본값이 1,095일이라 시간이 지나면 무너진다.
      CREATE INDEX IF NOT EXISTS idx_changes_vc_kind ON changes (vcenter_id, kind, vm_id, ts);

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

      -- v2.484 전원 꺼짐 점검(tools/powerOffPoller.js): 현재 꺼짐 구간의 관측 시작. 켜지거나 사라지면 행 삭제.
      CREATE TABLE IF NOT EXISTS power_off_seen (
        vcenter_id TEXT NOT NULL, vm_id TEXT NOT NULL, name TEXT,
        off_since INTEGER NOT NULL, last_seen INTEGER NOT NULL,
        PRIMARY KEY (vcenter_id, vm_id)
      );

      CREATE TABLE IF NOT EXISTS roster (
        vcenter_id TEXT NOT NULL, vm_id TEXT NOT NULL,
        name TEXT, cluster TEXT, host TEXT, datastore TEXT,
        power_state TEXT, cpu INTEGER, mem_mb INTEGER, storage_gb REAL, guest_os TEXT,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (vcenter_id, vm_id)
      );
    `);
    // 구버전 DB 에 뒤늦게 추가된 snaps 열(v2.346 전원 전환 · v2.348 DS 용량(REAL) · v2.597 skipped · v2.598 ds_used_unknown).
    // v2.603(감사 — ipam DB2603-01 과 같은 패턴): 예전 `try { ALTER } catch { /* 이미 존재 */ }` 는 **모든** 오류를 '이미 있음' 으로
    //   삼켜, 다른 연결이 잠금을 쥔 순간(SQLITE_BUSY)의 실패도 넘어갔다 — 열이 없는 채로 아래 prepare 가 'no such column' 으로
    //   던지고 그 실패가 initError('기능 비활성')로 굳었다(잠금 재시도 경로를 타지 못한다). 이제 table_info 로 **없는 열만**
    //   추가하고 'duplicate column name' 만 삼킨다. 잠금은 그대로 던져 getDb 의 lockRetry 가 잠시 뒤 다시 연다.
    addMissingColumns(db, 'snaps', [
      ['powered_on', 'INTEGER NOT NULL DEFAULT 0'], ['powered_off', 'INTEGER NOT NULL DEFAULT 0'], ['ds_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['ds_cap_gb', 'REAL NOT NULL DEFAULT 0'], ['ds_used_gb', 'REAL NOT NULL DEFAULT 0'],
      ['skipped', 'INTEGER NOT NULL DEFAULT 0'], ['ds_used_unknown', 'INTEGER NOT NULL DEFAULT 0'],
      // v2.744(감사 RECENT-01): 캐시 없는 점검중이라 합계에서 뺀 vCenter 수 — skipped(부분 합)와 나눈다(점검중은 기한 없는 상태라 합계를 막지 않는다).
      ['maint_excluded', 'INTEGER NOT NULL DEFAULT 0'],
    ]);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }

    const st = {
      setSkipped: db.prepare("UPDATE snaps SET skipped = ?, maint_excluded = ? WHERE slot = ? AND vcenter_id = ''"),
      insSnap: db.prepare(`INSERT INTO snaps (slot, ts, vcenter_id, total, on_count, added, removed, powered_on, powered_off,
          ds_count, ds_cap_gb, ds_used_gb, baseline, ds_used_unknown)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot, vcenter_id) DO UPDATE SET
          ts=excluded.ts, total=excluded.total, on_count=excluded.on_count,
          -- 같은 슬롯 재실행(수동 스냅샷)은 이미 갱신된 로스터를 기준으로 diff 하므로 증감이 0 으로
          -- 재계산된다. 그 0 으로 최초 실행이 기록한 증감을 덮어쓰면 이력이 사라진다(확정 버그).
          -- MAX 로 보존해 '재실행이 증감을 지우지 않는다'를 스키마 수준에서 보장한다.
          added=MAX(added, excluded.added), removed=MAX(removed, excluded.removed),
          powered_on=MAX(powered_on, excluded.powered_on), powered_off=MAX(powered_off, excluded.powered_off),
          ds_count=excluded.ds_count, ds_cap_gb=excluded.ds_cap_gb, ds_used_gb=excluded.ds_used_gb,
          baseline=excluded.baseline, ds_used_unknown=excluded.ds_used_unknown`),
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
      // (v2.348 보존 정리 — v2.744 DB-04 에 청크 정리문 chunkDsChanges 로 옮겼다)
      // 데이터스토어별 시계열(v2.353)
      insDsSeries: db.prepare(`INSERT INTO ds_series (slot, ts, vcenter_id, ds_id, cap_gb, used_gb)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(slot, ds_id) DO UPDATE SET ts=excluded.ts, cap_gb=excluded.cap_gb, used_gb=excluded.used_gb`),
      dsSeriesOf: db.prepare('SELECT slot, ts, vcenter_id, cap_gb, used_gb FROM ds_series WHERE ds_id=? AND ts>=? ORDER BY ts'),
      dsSeriesPrev: db.prepare('SELECT slot, ts, vcenter_id, cap_gb, used_gb FROM ds_series WHERE ds_id=? AND ts<? ORDER BY ts DESC LIMIT 1'),
      dsSeriesWindow: db.prepare('SELECT ds_id, ts, used_gb, cap_gb FROM ds_series WHERE ts>=? ORDER BY ts'),
      // v2.630(PERF2630-01): 창 경계(창 안 첫 관측 시각) — idx_dsseries_ts 끝점 탐색 1회. 시작값 메모의 키다.
      dsSeriesBoundary: db.prepare('SELECT MIN(ts) AS b FROM ds_series WHERE ts>=?'),
      dsSeriesCarry: db.prepare(`SELECT s.ds_id, s.used_gb, s.cap_gb FROM ds_series s
        JOIN (SELECT ds_id, MAX(ts) AS mts FROM ds_series WHERE ts<? GROUP BY ds_id) m
          ON m.ds_id=s.ds_id AND m.mts=s.ts`),
      dsRosterAll: db.prepare('SELECT vcenter_id, ds_id, name, type, cap_gb, used_gb, free_gb, first_seen FROM ds_roster'),
      // v2.590 P5: ds 별 **마지막 행은 남긴다** — 보존기간보다 오래 안 변한 DS(ISO·템플릿)의 유일한 행을 지우면 그 DS 가
      // 차트에서 '관측 없음' 이 되고 값이 안 바뀌어 다시 기록되지도 않았다. diff-저장이라 행이 적어 GROUP BY 가 가볍다.
      // ⚠ v2.601(감사 DB2601-02): 남기는 행은 ds 별 '전체 마지막' 이 아니라 **보존 경계 이전의 마지막 행**이다 — 최근에 바뀐 DS 는
      //   전체 마지막이 경계 뒤라 경계 이전 행이 전부 지워졌고, 그것이 곧 창 시작 이월(dsSeriesPrev·dsSeriesCarry) 행이었다.
      //   값이 안 바뀐 DS(v2.590 P5)는 두 기준이 같은 행이다. 슬롯은 시간순으로 들어가고 재실행 upsert 는 rowid 를 유지하므로
      //   경계 이전 행 중 MAX(rowid) 가 곧 경계 이전 마지막 행이다.
      //   (v2.744 DB-04: 이 규칙은 아래 청크 정리문 chunkDsSeries 가 집행한다 — 한 방 문장은 audit2744a 대조에만 남겼다)
      dsSeriesLast: db.prepare('SELECT used_gb, cap_gb FROM ds_series WHERE ds_id=? ORDER BY ts DESC LIMIT 1'),
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
      // v2.483 '꺼진 지 N일': VM 별 최신 전원 전환 슬롯 시각 + 로스터 first_seen(추적 시작 이후 계속 꺼짐 판정용).
      powerChangesOf: db.prepare("SELECT vm_id, kind, MAX(ts) AS ts FROM changes WHERE vcenter_id=? AND kind IN ('powered_off','powered_on') GROUP BY vm_id, kind"),
      rosterFirstSeenOf: db.prepare('SELECT vm_id, first_seen, power_state FROM roster WHERE vcenter_id=?'),
      // v2.484 전원 꺼짐 점검 표
      offSeenOf: db.prepare('SELECT vm_id, name, off_since, last_seen FROM power_off_seen WHERE vcenter_id=?'),
      upsertOffSeen: db.prepare(`INSERT INTO power_off_seen (vcenter_id, vm_id, name, off_since, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(vcenter_id, vm_id) DO UPDATE SET name=excluded.name, last_seen=excluded.last_seen`), // off_since 는 유지
      delOffSeen: db.prepare('DELETE FROM power_off_seen WHERE vcenter_id=? AND vm_id=?'),
      offSeenMaxTs: db.prepare('SELECT MAX(last_seen) AS mx FROM power_off_seen'),
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
      series: db.prepare(`SELECT id, slot, ts, vcenter_id, total, on_count, added, removed, powered_on, powered_off, ds_count, ds_cap_gb, ds_used_gb, baseline, skipped, maint_excluded, ds_used_unknown
        FROM snaps WHERE vcenter_id=? AND ts>=? ORDER BY ts`),
      seriesAllVc: db.prepare(`SELECT id, slot, ts, vcenter_id, total, on_count, added, removed, powered_on, powered_off, ds_count, ds_cap_gb, ds_used_gb, baseline, ds_used_unknown
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
      // v2.744(감사 DB-05): 창 경계(결과 기억의 키) — 단독 MIN 이라 인덱스 끝점 1회다(v2.550.3).
      snapsBoundary: db.prepare('SELECT MIN(ts) AS b FROM snaps WHERE ts>=?'),
      // v2.744(감사 DB-01): ds_changes 창 경계 — 재실행 슬롯에서 d.ts 는 snaps.ts 와 다를 수 있어(변경이 없던 vCenter 행은 옛 실행 시각) 따로 둔다.
      dsChangesBoundary: db.prepare('SELECT MIN(ts) AS b FROM ds_changes WHERE ts>=?'),
      // v2.744(감사 DB-01): 창 안 슬롯 목록(snaps 는 vCenter × 슬롯이라 작다 — idx_snaps_ts 범위). 행의 d.ts 는 그 스냅샷 행의 ts 이하라
      //   (스냅샷 ts 는 재실행 때만 더 늦게 바뀐다) d.ts>=since 인 행의 슬롯은 반드시 이 목록에 있다.
      slotsSince: db.prepare('SELECT slot, MAX(ts) AS mts FROM snaps WHERE ts>=? GROUP BY slot ORDER BY mts DESC, slot'),
      // v2.744(감사 DB-01): 슬롯 하나의 DS 변경분(창 안 행만) — 정렬은 예전 창 전체 조회(dsChangesWindow)와 같다(슬롯 안에서만 정렬한다).
      //   snaps 는 UNIQUE(slot, vcenter_id) 자동 인덱스로, ds_changes 는 idx_dschanges_snap 으로 찾는다. vCenter 조건을 SQL 로 내렸다(결과는 JS 필터와 같다).
      dsChangesOfSlotSince: db.prepare(`SELECT d.kind, d.ds_id, d.name, d.type, d.cap_gb, d.used_gb,
          d.usage_pct, d.prev_used_gb, d.delta_gb, d.vcenter_id, s.slot, s.ts AS slot_ts
        FROM snaps s JOIN ds_changes d ON d.snap_id=s.id
        WHERE s.slot=? AND d.ts>=? AND (?='' OR d.vcenter_id=?)
        ORDER BY s.ts DESC, ABS(COALESCE(d.delta_gb,0)) DESC, d.name`),
      // v2.602(감사 DB2602-03 — 재현): VM 의 **유일한** 전원 전이 행을 지우면 '꺼진 지 N일' 이 roster.first_seen 폴백으로
      // 떨어져 과대 표시됐다(재현 1,200일 → 1,500일, 출처 first_seen). ds_series(v2.601 DB2601-02)와 같은 규칙 — 전원 전이는
      // (vCenter, VM, 종류)별 **보존 경계 이전의 마지막 행**을 남긴다. VM 당 최대 2행이라 유계다. added/removed 는 그대로 지운다.
      // v2.603(감사 RECENT2603-03 — 재현): 위 규칙은 **지금 있는 VM** 을 위한 것인데 로스터 조건이 없어 삭제된 VM 의 전이 행도
      // 영원히 남았다(VM 교체가 잦으면 무한 증가 — 재현: 28 vCenter · VM 11,200대 중 삭제 5,348대 → 남은 행 22,400 → 로스터 기준 11,704).
      // 이제 남기는 것은 **로스터에 있는 VM** 의 마지막 행뿐이다. 로스터가 비어 있는 vCenter(첫 스냅샷 전·등록 해제)는
      // '지금 있는가' 를 판정할 수 없으므로 예전처럼 남긴다(지우는 쪽으로 추측하지 않는다). 성능(재현 60만 행): 정상 상태
      // prune 44ms → 39ms — 서브쿼리는 여전히 idx_changes_vc_kind 커버링 스캔이고 로스터는 PK 탐색이다(DB2603-05 는 개선 불필요).
      //   (v2.744 DB-04: 이 규칙은 아래 청크 정리문 chunkChanges 가 집행한다)
      meta: db.prepare("SELECT COUNT(*) AS n, MIN(ts) AS mn, MAX(ts) AS mx FROM snaps WHERE vcenter_id=''"),
      // v2.744(감사 DB-04): 청크 정리문 — 후보 rowid 를 LIMIT 으로 고르고(ts 단독 인덱스) 청크 사이에 양보한다(util/chunkedPrune.js).
      //   보존 규칙은 위 한 방 문장과 같다: ds_series 는 ds 별 '경계 이전 마지막 행'(MAX(rowid) — idx_dsseries_ds), changes 는 로스터 VM(또는
      //   로스터 없는 vCenter)의 전원 전이 (vCenter, VM, 종류)별 경계 이전 마지막 행(MAX(rowid) — idx_changes_vc_kind). 남기는 행은 삭제 대상이
      //   아니므로 청크마다 다시 계산해도 MAX 가 바뀌지 않는다 — 결과는 한 방 문장과 같다(server/test/audit2744a.test.js 가 대조한다).
      //   옛 한 방 문장(트랜잭션 하나로 DELETE 넷)은 테스트(audit2744a)의 대조 기준으로만 남겼다 — 정리를 한 방 문장으로 되돌리지 말 것.
      //   남기는 행이 있는 두 표(changes·ds_series)는 **(ts, rowid) 커서**로 후보를 고른다 — LIMIT 만 쓰면 청크마다 앞쪽의 남기는 행(VM·DS 수만큼)을
      //   처음부터 다시 훑어 행 수에 대해 제곱으로 늘었다(측정: 합성 45만 행 24초). 커서는 남기는 행을 한 번씩만 지난다.
      chunkChangesSel: db.prepare(`SELECT c.rowid AS rid, c.ts AS ts FROM changes c WHERE c.ts < ? AND (c.ts, c.rowid) > (?, ?) AND NOT (
          c.kind IN ('powered_off','powered_on')
          AND (EXISTS (SELECT 1 FROM roster r WHERE r.vcenter_id = c.vcenter_id AND r.vm_id = c.vm_id)
               OR NOT EXISTS (SELECT 1 FROM roster r2 WHERE r2.vcenter_id = c.vcenter_id))
          AND c.rowid = (SELECT MAX(q.rowid) FROM changes q
            WHERE q.vcenter_id = c.vcenter_id AND q.kind = c.kind AND q.vm_id = c.vm_id AND q.ts < ?))
        ORDER BY c.ts, c.rowid LIMIT ?`),
      delChangesRow: db.prepare('DELETE FROM changes WHERE rowid = ?'),
      chunkDsChanges: db.prepare('DELETE FROM ds_changes WHERE rowid IN (SELECT rowid FROM ds_changes WHERE ts < ? LIMIT ?)'),
      //   (안쪽 서브쿼리의 rowid 는 가장 안쪽 FROM 인 q 의 것이다 — MAX(rowid) = ds 별 경계 이전 마지막 행, audit2590 P5 가 이 표기를 고정한다.)
      chunkDsSeriesSel: db.prepare(`SELECT s.rowid AS rid, s.ts AS ts FROM ds_series s WHERE s.ts < ? AND (s.ts, s.rowid) > (?, ?)
          AND s.rowid <> (SELECT MAX(rowid) FROM ds_series q WHERE q.ds_id = s.ds_id AND q.ts < ?)
        ORDER BY s.ts, s.rowid LIMIT ?`),
      delDsSeriesRow: db.prepare('DELETE FROM ds_series WHERE rowid = ?'),
      chunkSnaps: db.prepare('DELETE FROM snaps WHERE rowid IN (SELECT rowid FROM snaps WHERE ts < ? LIMIT ?)'),
    };
    return { db, st };
  });
}

/** DB 준비(1회). 실패 시 available:false 로 남기고 예외를 던지지 않는다. */
export async function getDb() {
  if (impl) return impl;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = withOpenCleanup(initSqlite)
      .then((x) => { impl = x; lockRetry.ok(); return x; })
      .catch((err) => {
        if (lockRetry.onFail(err)) { console.warn(`[vmtrack] ${lockRetry.note()}`); ready = null; return null; }
        initError = err.message || String(err);
        console.warn(`[vmtrack] DB 초기화 실패 — 기능 비활성: ${initError}`);
        return null;
      });
  }
  return ready;
}

export function vmtrackStatus() {
  return { available: Boolean(impl), dbPath: DB_PATH, error: impl ? null : (initError || lockRetry.note() || null) };
}

/**
 * 스냅샷 커밋 — (슬롯, vCenter별) 총계·증감 + changes + roster 갱신을 **단일 트랜잭션**으로.
 * @param {{slot:string, ts:number, perVc:Array, totalRow:object}} payload
 *   perVc: [{ vcenterId, total, onCount, added:[vm...], removed:[vm...],
 *             poweredOn:[vm...], poweredOff:[vm...], live:[vm...], baseline }]
 */
// v2.630(감사 PERF2630-01): ds_series 세대 — ds_series 를 바꾸는 커밋·prune 이 올린다. 시작값 메모(service.dsStartValues)가
//   '세대 + 창 경계' 를 키로 쓰므로, ds_series 에 쓰는 새 경로를 만들면 반드시 bumpDsSeriesGen() 을 부를 것(안 부르면 옛 값이 나간다).
let _dsGen = 0;
export function dsSeriesGeneration() { return _dsGen; }
// v2.744(감사 DB-05·DB-01): snaps·ds_changes 세대 — 결과 기억(service.vmtrackSeries·변경 이력)의 키다. snaps·ds_changes 에 쓰는 경로는
//   commitSnapshot·pruneVmtrack 둘뿐이고 둘 다 bumpDsSeriesGen 을 부르므로 같은 함수가 함께 올린다(새 쓰기 경로를 만들면 반드시 부를 것).
let _writeGen = 0;
export function vmtrackGeneration() { return _writeGen; }
function bumpDsSeriesGen() { _dsGen += 1; _writeGen += 1; }

/**
 * v2.744(감사 DB-05): snaps 창 경계 = ts>=sinceTs 인 첫 행 시각(없으면 null) — idx_snaps_ts 끝점 탐색 1회.
 *   모든 행에 대해 'ts>=sinceTs' ⇔ 'ts>=경계' 이므로(경계 ≥ sinceTs 이고 그 사이 행이 없다) 창 조회 결과는 이 값과 세대만으로 정해진다.
 */
export async function snapsBoundary(sinceTs) {
  const x = await getDb();
  if (!x) return null;
  const r = x.st.snapsBoundary.get(sinceTs);
  return r?.b ?? null;
}

/** 창 경계 = ts>=sinceTs 인 첫 관측 시각(없으면 null). 창·이월 조회 결과는 이 값과 세대만으로 정해진다. */
export async function dsSeriesBoundary(sinceTs) {
  const x = await getDb();
  if (!x) return null;
  const r = x.st.dsSeriesBoundary.get(sinceTs);
  return r?.b ?? null;
}

export async function commitSnapshot({ slot, ts, perVc, totalRow }) {
  const x = await getDb();
  if (!x) return { ok: false, reason: 'vmtrack DB 사용 불가' };
  const { db, st } = x;
  db.exec('BEGIN');
  try {
    // 전체 합계 행(vcenter_id='') — 차트 상단 라인.
    st.insSnap.run(slot, ts, '', totalRow.total, totalRow.onCount, totalRow.added, totalRow.removed,
      totalRow.poweredOn || 0, totalRow.poweredOff || 0,
      totalRow.dsCount || 0, totalRow.dsCapGB || 0, totalRow.dsUsedGB || 0, totalRow.baseline ? 1 : 0, totalRow.dsUsedUnknown || 0);
    st.setSkipped.run(Math.max(0, Number(totalRow.skipped) || 0), Math.max(0, Number(totalRow.maintExcluded) || 0), slot);
    for (const vc of perVc) {
      const ds = vc.ds || null; // { count, capGB, usedGB, added:[], removed:[], changed:[] }
      st.insSnap.run(slot, ts, vc.vcenterId, vc.total, vc.onCount, vc.added.length, vc.removed.length,
        (vc.poweredOn || []).length, (vc.poweredOff || []).length,
        ds?.count || 0, ds?.capGB || 0, ds?.usedGB || 0, vc.baseline ? 1 : 0, ds?.usedUnknown || 0);
      const row = st.snapId.get(slot, vc.vcenterId);
      const snapId = row?.id;
      if (snapId == null) continue;
      // 같은 슬롯 재실행(수동 스냅샷) 시 중복 방지 — 단 **빈손 재실행은 기존 이력을 지우지 않는다**.
      // 재실행은 이미 갱신된 로스터로 diff 하므로 변경분이 0 건으로 나오는데, 무조건 DELETE 하면
      // 최초 실행이 남긴 증감 상세(어떤 VM/DS 였는지)가 영구 소실된다(확정 버그). 적재할 항목이
      // 1건 이상일 때만 교체하고, 0건이면 보존한다.
      const vmChangeCount = ['added', 'removed', 'poweredOn', 'poweredOff']
        .reduce((n, f) => n + (vc[f] || []).length, 0);
      const dsChangeCount = ds ? ['added', 'removed', 'changed']
        .reduce((n, f) => n + (ds[f] || []).length, 0) : 0;
      if (vmChangeCount > 0) st.delChangesOfSnap.run(snapId);
      if (dsChangeCount > 0) st.delDsChangesOfSnap.run(snapId);
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
    bumpDsSeriesGen();
    return { ok: true };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    bumpDsSeriesGen();   // 방어적: 롤백 전 부분 상태를 누가 읽었든 메모를 버린다
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

/** v2.483: VM 별 최신 전원 전환 시각(Map vm_id → {offTs,onTs}). changes 는 diff 만 저장돼 작다(풀스캔 무해). */
export async function loadPowerChanges(vcenterId) {
  const x = await getDb();
  if (!x) return null;
  const map = new Map();
  for (const r of x.st.powerChangesOf.all(String(vcenterId))) {
    const e = map.get(r.vm_id) || { offTs: 0, onTs: 0 };
    if (r.kind === 'powered_off') e.offTs = Number(r.ts) || 0; else e.onTs = Number(r.ts) || 0;
    map.set(r.vm_id, e);
  }
  return map;
}

/** v2.483: 로스터 first_seen·전원 상태(Map vm_id → {firstSeen, powerState}). first_seen 은 upsert 로 갱신되지 않는다. */
export async function loadRosterFirstSeen(vcenterId) {
  const x = await getDb();
  if (!x) return null;
  return new Map(x.st.rosterFirstSeenOf.all(String(vcenterId)).map((r) => [r.vm_id, { firstSeen: Number(r.first_seen) || 0, powerState: r.power_state || '' }]));
}

/** v2.484: 점검 표 조회(Map vm_id → {offSince, lastSeen}). */
export async function loadOffSeen(vcenterId) {
  const x = await getDb();
  if (!x) return null;
  return new Map(x.st.offSeenOf.all(String(vcenterId)).map((r) => [r.vm_id, { offSince: Number(r.off_since) || 0, lastSeen: Number(r.last_seen) || 0 }]));
}

/** v2.484: 마지막 점검 시각(재시작 직후 즉시 재점검 방지용). */
export async function lastPowerOffObservationTs() {
  const x = await getDb();
  if (!x) return 0;
  return Number(x.st.offSeenMaxTs.get()?.mx || 0);
}

/**
 * v2.484: 전원 꺼짐 점검 1회 적재 — 단일 트랜잭션. perVc: [{ vcenterId, offVms:[{vmId,name}] }]
 * 꺼진 VM: 없으면 insert(off_since=ts), 있으면 last_seen 갱신(off_since 유지). 목록에 없는 기존 행(켜졌거나 삭제)은 delete.
 * @returns {{ok:boolean, offVms:number, inserted:number, deleted:number}}
 */
export async function commitPowerOffObservation({ ts, perVc }) {
  const x = await getDb();
  if (!x) return { ok: false, offVms: 0, inserted: 0, deleted: 0 };
  const { db, st } = x;
  let offVms = 0, inserted = 0, deleted = 0;
  db.exec('BEGIN');
  try {
    for (const vc of perVc || []) {
      const existing = new Set(st.offSeenOf.all(String(vc.vcenterId)).map((r) => r.vm_id));
      const cur = new Set();
      for (const v of vc.offVms || []) {
        cur.add(v.vmId); offVms++;
        if (!existing.has(v.vmId)) inserted++;
        st.upsertOffSeen.run(vc.vcenterId, v.vmId, v.name || '', ts, ts);
      }
      for (const id of existing) if (!cur.has(id)) { st.delOffSeen.run(vc.vcenterId, id); deleted++; }
    }
    db.exec('COMMIT');
    return { ok: true, offVms, inserted, deleted };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
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
  // v2.590 P4: 시계열 기록 판정은 '직전 **슬롯**(로스터 — 매 슬롯 갱신)' 이 아니라 '마지막으로 **기록한** 값' 과 비교해야 한다.
  //   로스터와 비교하면 슬롯당 1GB 미만으로 꾸준히 느는 DS(하루 1.2GB)는 한 달 36GB 가 늘어도 한 번도 기록되지 않아
  //   차트가 첫 관측값 그대로의 수평선이었다(같은 화면의 '기간 증감' 숫자와 모순). 마지막 기록값을 붙여 준다 —
  //   기록이 없으면(첫 관측·prune 뒤) undefined 라 diff 가 첫 관측으로 다시 기록한다.
  return new Map(x.st.dsRosterOf.all(String(vcenterId)).map((r) => {
    const last = x.st.dsSeriesLast.get(r.ds_id);
    return [r.ds_id, { ...r, series_used_gb: last ? last.used_gb : undefined, series_cap_gb: last ? last.cap_gb : undefined, series_known: !!last }];
  }));
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

/**
 * 윈도우 내 DS 변경분 전체(슬롯 포함, v2.355 스토리지 변경 이력).
 * ⚠ v2.744(감사 DB-01): 요청 경로에서 쓰지 말 것 — 기간 전체를 정렬해 한 번에 읽는다(365일 1.5~9.6초 정지 재현). 화면은
 *   readDsChangesOfSlot(슬롯 단위)를 쓴다. 이 함수는 결과 동일성 대조(테스트)용으로 남긴다.
 */
export async function readDsChangesWindow(sinceTs) {
  const x = await getDb();
  if (!x) return [];
  return x.st.dsChangesWindow.all(sinceTs);
}

/** v2.744(감사 DB-01): ds_changes 창 경계(ts>=sinceTs 인 첫 행 시각, 없으면 null) — 변경 이력 결과 기억의 키. */
export async function dsChangesBoundary(sinceTs) {
  const x = await getDb();
  if (!x) return null;
  return x.st.dsChangesBoundary.get(sinceTs)?.b ?? null;
}

/** v2.744(감사 DB-01): 창 안 슬롯 목록(최근 슬롯부터). */
export async function slotsSince(sinceTs) {
  const x = await getDb();
  if (!x) return [];
  return x.st.slotsSince.all(sinceTs).map((r) => r.slot);
}

/** v2.744(감사 DB-01): 슬롯 하나의 창 안 DS 변경분 — 슬롯 수만큼 나눠 읽고 그 사이에 양보할 수 있게 한다. vcenterId '' = 전체. */
export async function readDsChangesOfSlot(slot, sinceTs, vcenterId = '') {
  const x = await getDb();
  if (!x) return [];
  const vc = String(vcenterId || '');
  return x.st.dsChangesOfSlotSince.all(String(slot), sinceTs, vc, vc);
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

/**
 * 보존기간 정리(기본 1,095일 = 3년 — 행이 작아 넉넉히).
 * v2.603(감사 DB2603-03): 음수 보존일은 경계를 **미래**로 옮겨 이력 전체를 지웠다(`Number(-1) || 1095` 는 -1 이다 —
 * '경계 이전 마지막 행 보존' 규칙까지 무력화). 양의 유한수가 아니면 **지우지 않고** 사유를 돌려준다(오설정을 파괴로
 * 해석하지 않는다). 0 은 기존 표현식에서 이미 기본값(1,095일)이다.
 */
export async function pruneVmtrack(retentionDays = Number(process.env.VMTRACK_RETENTION_DAYS) || 1095) {
  const days = numOrNull(retentionDays);
  if (days == null || !(days > 0)) {
    console.warn(`[vmtrack] 보존일이 올바르지 않아 정리를 건너뜁니다(${String(retentionDays).slice(0, 40)}) — VMTRACK_RETENTION_DAYS 는 양수여야 합니다`);
    return { ok: false, skipped: true, reason: 'invalid-retention' };
  }
  retentionDays = days;
  const x = await getDb();
  if (!x) return { ok: false };
  const cut = Date.now() - retentionDays * 86_400_000;
  // v2.744(감사 DB-04 — 재현): 예전에는 DELETE 넷을 **한 트랜잭션으로 동기** 실행해, 보존일을 줄인 뒤 첫 정리에서 그 행 수만큼
  //   이벤트 루프가 멈췄다(감사 보고 약 1.9초 · 측정: 합성 45만 행을 지우는 한 트랜잭션 2,747ms). 이제 표마다 청크로 지우고 청크 사이에 양보한다(트랜잭션 밖 — 청크 하나가 자기 트랜잭션).
  //   ⚠ 대가(정직): 정리 도중 조회는 일부만 지워진 상태를 볼 수 있다 — 지우는 행은 전부 보존 경계보다 오래된 것이라 보존 기간 안의
  //   조회 결과는 바뀌지 않는다. 정리끼리는 겹치지 않는다(키 = 경계 — 더 늦은 경계가 오면 끝난 뒤 새 경계로 한 번 더).
  //   세대(bumpDsSeriesGen)는 **끝난 뒤 한 번** 올린다(오류로 중간에 멈춰도 — 일부가 지워졌을 수 있다).
  //   청크는 **시간 기준 적응**이다(util/chunkedPrune.js targetMs — v2.742 logs 와 같은 규칙): 보존 규칙의 상관 서브쿼리 때문에 행당 비용이
  //   단순 DELETE 보다 커서 2만 행 고정 청크면 한 청크가 0.4초를 넘었다(측정 — 합성 45만 행). 2천 행에서 시작해 목표(40ms)에 맞춰 늘리고 줄인다.
  const { st } = x;
  const opt = (label) => ({ label, chunk: Math.min(2000, PRUNE_CHUNK_ROWS), targetMs: PRUNE_TARGET_MS, minChunk: Math.min(200, PRUNE_CHUNK_ROWS), maxChunk: PRUNE_CHUNK_ROWS });
  return pruneFlight.run(cut, async () => {
    try {
      const a = await cursorPrune(x.db, st.chunkChangesSel, st.delChangesRow, cut, opt('vmtrack.changes'));   // v2.602 DB2602-03 · v2.603 RECENT2603-03
      const b = await chunkedDelete(st.chunkDsChanges, [cut], opt('vmtrack.ds_changes')); // v2.348
      const c = await cursorPrune(x.db, st.chunkDsSeriesSel, st.delDsSeriesRow, cut, opt('vmtrack.ds_series')); // v2.353 · v2.601 DB2601-02
      const d = await chunkedDelete(st.chunkSnaps, [cut], opt('vmtrack.snaps'));
      return {
        ok: true, cut,
        changesDeleted: a.deleted, dsChangesDeleted: b.deleted, dsSeriesDeleted: c.deleted, snapsDeleted: d.deleted,
        chunks: { changes: a.chunks, dsChanges: b.chunks, dsSeries: c.chunks, snaps: d.chunks },
        done: a.done && b.done && c.done && d.done,
      };
    } catch (e) {
      return { ok: false, reason: e.message };
    } finally {
      // 예전과 같이 정리를 한 번 돌면 세대를 올린다(지운 행이 0 이어도 — 메모를 버리는 것은 안전한 쪽이다).
      bumpDsSeriesGen();
    }
  });
}

// v2.744(감사 DB-04): 청크 한 번의 목표 시간(ms) — 이보다 오래 걸리면 다음 청크를 줄인다.
const PRUNE_TARGET_MS = 40;

/**
 * v2.744(감사 DB-04): (ts, rowid) 커서 청크 정리 — 남기는 행(보존 규칙)이 있는 표용. 후보를 커서 뒤에서 chunk 개 고르고(선택 문이 보존 규칙을
 * 판정한다) 그 행만 한 트랜잭션으로 지운 뒤 양보한다. 남기는 행은 MAX(rowid) 판정 대상이 아니라 지워지지 않으므로 청크마다 다시 판정해도
 * 한 방 문장과 결과가 같다(테스트가 대조). 청크 크기·상한·종료 판정은 chunkedDelete 와 같은 규칙(nextAdaptiveChunk · PRUNE_MAX_ROWS).
 * @returns {Promise<{deleted:number, done:boolean, chunks:number}>}
 */
async function cursorPrune(db, selStmt, delStmt, cut, { chunk: chunk0 = 2000, targetMs = PRUNE_TARGET_MS, minChunk = 200, maxChunk = PRUNE_CHUNK_ROWS, maxRows = PRUNE_MAX_ROWS } = {}) {
  let chunk = Math.max(1, chunk0);
  let curTs = Number.MIN_SAFE_INTEGER; let curRid = 0;
  let deleted = 0; let chunks = 0;
  for (;;) {
    const want = maxRows > 0 ? Math.min(chunk, maxRows - deleted) : chunk;
    if (want <= 0) return { deleted, done: false, chunks };
    const t0 = performance.now();
    const rows = selStmt.all(cut, curTs, curRid, cut, want);
    if (rows.length) {
      db.exec('BEGIN');
      try { for (const r of rows) delStmt.run(r.rid); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; }
      const last = rows[rows.length - 1];
      curTs = Number(last.ts); curRid = Number(last.rid);
      deleted += rows.length;
    }
    chunks += 1;
    chunk = nextAdaptiveChunk(chunk, want, performance.now() - t0, { targetMs, minChunk, maxChunk });
    if (rows.length < want) return { deleted, done: true, chunks };
    if (maxRows > 0 && deleted >= maxRows) return { deleted, done: false, chunks };
    await new Promise((res) => setImmediate(res));
  }
}
// v2.744(감사 DB-04): 정리끼리는 겹치지 않는다(키 = 경계 — 진행 중인 정리가 더 늦거나 같은 경계면 그 약속을 공유한다).
const pruneFlight = createPruneFlight({ covers: (running, next) => running >= next });
