/**
 * snaphist/db.js — VM 별 스냅샷 이력 DB(v3.26.0 — 사용자 ‘VM 별 스냅샷 이력 DB 추가’ · 설계 docs/design/snapshots §5).
 * CONFIG_DIR(또는 dbDir)/snap-history.db — 업그레이드에 보존. node:sqlite 가 없으면 기능 비활성(상태 API 가 사유를 말한다).
 *
 * 표(틀은 vmtrack/db.js 와 같다 — 슬롯 기록 · 바뀐 것만 · 현재 집합):
 *   snap_vcday(day, vcenter_id, status, vms, snaps, gb, gb_unknown, age_unknown, over, ts) — vCenter 하나의 그날 합계.
 *       status 'ok' 가 아니면(점검중 · 수집 실패 · 낡음 · 첫 수집 중 · REST 폴백 'no-snap') 합계는 NULL — **‘0’ 이 아니라 ‘빠진 날’** 이다.
 *       'partial' = 개수를 못 읽은 VM 이 있었다(count_unknown) — 합계 · 행은 넣지만 추이에는 넣지 않는다(부분 합 금지). 같은 날 다시 시도한다.
 *   snap_day(day, vcenter_id, vm_id, name, count, gb, oldest_ts, power, judged, over, ts) — 그날 스냅샷이 있던 VM 한 대.
 *   snap_item(vcenter_id, vm_id, skey, name, vm_name, create_ts, mem, quiesced, first_seen, last_seen, gone_at, gone_reason) — 스냅샷 하나의 생애.
 *       gone_at = ‘없어진 것을 처음 본 시각’ — 실제로 지운 시각은 last_seen 과 gone_at 사이다(하루 한 번 기록이라). gone_reason 'snap' | 'vm'(VM 이 없어짐).
 *   snap_meta(k, v) — 'started' = 첫 기록 날.
 * 규약(루트 CLAUDE.md · docs/rules/perf-db.md): WAL · busy_timeout(openSqlite) · 하루치 쓰기는 **한 트랜잭션** · prune 은 스로틀 + 청크 · ts 단독 인덱스 ·
 *   집계 함수 2개 이상 한 문장 금지(합은 기록 때 snap_vcday 에 미리 넣는다) · ‘키별 최신값’ 을 GROUP BY + MAX 로 만들지 않는다(최신은 지금 인벤토리).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete } from '../util/chunkedPrune.js';
import { addMissingColumns } from '../vmtrack/db.js';
import { envPositive } from '../util/envNumber.js';
import { isBareKey } from './record.js';

const lockRetry = createLockRetry();
const DB_PATH = process.env.SNAPHIST_DB_PATH || path.join(config.dbDir || config.configDir, 'snap-history.db');
const DAY = 86_400_000;
export const RETENTION_DAYS_DEFAULT = 400;
export function retentionDays() {
  const n = envPositive(process.env.SNAPHIST_RETENTION_DAYS, RETENTION_DAYS_DEFAULT, { max: 3650 });
  return Math.max(30, n);   // 30일 아래는 7일 변화 · 30일 추이가 비므로 30일로 올린다
}

let impl = null;
let ready = null;
let initError = null;
let _gen = 0;   // 쓰기 세대 — 읽기 메모의 열쇠(쓰면 바뀐다)
export function snapHistGeneration() { return _gen; }

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = openSqlite(new DatabaseSync(DB_PATH));
    db.exec(`
      CREATE TABLE IF NOT EXISTS snap_vcday (
        day TEXT NOT NULL, vcenter_id TEXT NOT NULL, status TEXT NOT NULL,
        vms INTEGER, snaps INTEGER, gb REAL, gb_unknown INTEGER, age_unknown INTEGER, over INTEGER, count_unknown INTEGER,
        ts INTEGER NOT NULL,
        PRIMARY KEY (day, vcenter_id)
      );
      CREATE INDEX IF NOT EXISTS idx_snapvcday_ts ON snap_vcday (ts);
      CREATE TABLE IF NOT EXISTS snap_day (
        day TEXT NOT NULL, vcenter_id TEXT NOT NULL, vm_id TEXT NOT NULL,
        name TEXT, count INTEGER NOT NULL, gb REAL, oldest_ts INTEGER, power TEXT, judged INTEGER NOT NULL DEFAULT 0, over INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL,
        PRIMARY KEY (day, vcenter_id, vm_id)
      );
      CREATE INDEX IF NOT EXISTS idx_snapday_vm ON snap_day (vcenter_id, vm_id, day);
      CREATE INDEX IF NOT EXISTS idx_snapday_ts ON snap_day (ts);
      CREATE TABLE IF NOT EXISTS snap_item (
        vcenter_id TEXT NOT NULL, vm_id TEXT NOT NULL, skey TEXT NOT NULL,
        name TEXT, vm_name TEXT, create_ts INTEGER, mem INTEGER, quiesced INTEGER,
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, gone_at INTEGER, gone_reason TEXT,
        PRIMARY KEY (vcenter_id, vm_id, skey)
      );
      CREATE INDEX IF NOT EXISTS idx_snapitem_open ON snap_item (vcenter_id, gone_at);
      CREATE INDEX IF NOT EXISTS idx_snapitem_gone ON snap_item (gone_at);
      CREATE TABLE IF NOT EXISTS snap_meta (k TEXT PRIMARY KEY, v TEXT);
    `);
    // 나중에 더한 열 — 없는 열만 더한다(잠금 · 그 밖의 오류는 던진다 — vmtrack/db.js addMissingColumns 와 같은 함수)
    addMissingColumns(db, 'snap_vcday', [['count_unknown', 'INTEGER']]);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const st = {
      vcdayStatus: db.prepare('SELECT status FROM snap_vcday WHERE day = ? AND vcenter_id = ?'),
      dayStatuses: db.prepare('SELECT vcenter_id, status FROM snap_vcday WHERE day = ?'),
      insVcday: db.prepare(`INSERT INTO snap_vcday (day, vcenter_id, status, vms, snaps, gb, gb_unknown, age_unknown, over, count_unknown, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, vcenter_id) DO UPDATE SET status=excluded.status, vms=excluded.vms, snaps=excluded.snaps, gb=excluded.gb,
          gb_unknown=excluded.gb_unknown, age_unknown=excluded.age_unknown, over=excluded.over, count_unknown=excluded.count_unknown, ts=excluded.ts
        WHERE snap_vcday.status <> 'ok'`),   // 같은 날 'ok' 로 한 번 기록했으면 덮지 않는다(하루 한 번)
      delDayVc: db.prepare('DELETE FROM snap_day WHERE day = ? AND vcenter_id = ?'),
      insDay: db.prepare(`INSERT OR REPLACE INTO snap_day (day, vcenter_id, vm_id, name, count, gb, oldest_ts, power, judged, over, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      openItems: db.prepare('SELECT vm_id, skey, name FROM snap_item WHERE vcenter_id = ? AND gone_at IS NULL'),
      upItem: db.prepare(`INSERT INTO snap_item (vcenter_id, vm_id, skey, name, vm_name, create_ts, mem, quiesced, first_seen, last_seen, gone_at, gone_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(vcenter_id, vm_id, skey) DO UPDATE SET name=excluded.name, vm_name=excluded.vm_name, mem=excluded.mem, quiesced=excluded.quiesced,
          last_seen=excluded.last_seen, gone_at=NULL, gone_reason=NULL`),
      seenItem: db.prepare('UPDATE snap_item SET last_seen = ?, vm_name = ? WHERE vcenter_id = ? AND vm_id = ? AND skey = ?'),
      goneItem: db.prepare('UPDATE snap_item SET gone_at = ?, gone_reason = ? WHERE vcenter_id = ? AND vm_id = ? AND skey = ? AND gone_at IS NULL'),
      metaGet: db.prepare('SELECT v FROM snap_meta WHERE k = ?'),
      metaSet: db.prepare('INSERT INTO snap_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      // 읽기
      vcdaySince: db.prepare('SELECT day, vcenter_id, status, vms, snaps, gb, gb_unknown, age_unknown, over, count_unknown FROM snap_vcday WHERE day >= ? ORDER BY day'),
      // 반증 2: ‘기록 시작’ = 그 vCenter 의 첫 행(상태 무관) — 첫 ok 로 잡으면 그 전의 못 읽은 날이 빠진 것으로 세지지 않아 부분 합이 추이에 들어갔다
      firstDay: db.prepare('SELECT MIN(day) AS d FROM snap_vcday WHERE vcenter_id = ?'),
      lastDay: db.prepare('SELECT MAX(day) AS d FROM snap_vcday'),
      vmDays: db.prepare('SELECT day, count, gb, oldest_ts, over FROM snap_day WHERE vcenter_id = ? AND vm_id = ? AND day >= ? ORDER BY day'),
      dayRows: db.prepare('SELECT vcenter_id, vm_id, count, gb FROM snap_day WHERE day = ?'),
      okDaysOf: db.prepare("SELECT day FROM snap_vcday WHERE vcenter_id = ? AND status = 'ok' AND day >= ? ORDER BY day"),
      goneSince: db.prepare(`SELECT vcenter_id, vm_id, skey, name, vm_name, create_ts, first_seen, last_seen, gone_at, gone_reason FROM snap_item
        WHERE gone_at >= ? ORDER BY gone_at DESC LIMIT ?`),
      itemsOfVm: db.prepare(`SELECT skey, name, create_ts, mem, quiesced, first_seen, last_seen, gone_at, gone_reason FROM snap_item
        WHERE vcenter_id = ? AND vm_id = ? ORDER BY first_seen, skey LIMIT 200`),
      // 정리(청크)
      pruneVcday: db.prepare('DELETE FROM snap_vcday WHERE rowid IN (SELECT rowid FROM snap_vcday WHERE ts < ? LIMIT ?)'),
      pruneDay: db.prepare('DELETE FROM snap_day WHERE rowid IN (SELECT rowid FROM snap_day WHERE ts < ? LIMIT ?)'),
      pruneItem: db.prepare('DELETE FROM snap_item WHERE rowid IN (SELECT rowid FROM snap_item WHERE gone_at IS NOT NULL AND gone_at < ? LIMIT ?)'),
    };
    return { db, st };
  });
}

/** DB 준비(1회). 실패하면 null — 예외를 던지지 않는다. */
export async function getSnapHistDb() {
  if (impl) return impl;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = withOpenCleanup(initSqlite)
      .then((x) => { impl = x; lockRetry.ok(); return x; })
      .catch((err) => {
        if (lockRetry.onFail(err)) { console.warn(`[snaphist] ${lockRetry.note()}`); ready = null; return null; }
        initError = err.message || String(err);
        console.warn(`[snaphist] DB 초기화 실패 — 기능 비활성: ${initError}`);
        return null;
      });
  }
  return ready;
}

export function snapHistDbStatus() {
  return { available: Boolean(impl), error: impl ? null : (initError || lockRetry.note() || null) };
}

/** 그날 이미 'ok' 로 기록한 vCenter 집합. */
export async function okVcentersOfDay(day) {
  const x = await getSnapHistDb();
  if (!x) return null;
  return new Set(x.st.dayStatuses.all(day).filter((r) => r.status === 'ok').map((r) => r.vcenter_id));
}

/**
 * VM 하나의 지금 항목을 열린 항목과 맞춘다(순수 — 시험용). 열쇠가 같으면 같은 스냅샷. 한쪽이 이름만 열쇠('|이름')이면 **이름이 같은 열린 항목 하나와**
 * 양방향으로 맞춘다(반증 5 — 줄기 → 이름만 → 줄기에서 둘로 갈라지지 않게 · 반증 6 — 같은 이름 여럿은 하나씩만 짝짓는다).
 * @returns {{matched:Set<string>, upsert:object[], touch:{skey:string, vmName:string}[]}}
 */
export function matchItems(opens, list) {
  const byKey = new Map(opens.map((o) => [o.skey, o]));
  const matched = new Set(); const upsert = []; const touch = [];
  const free = (pred) => opens.find((o) => !matched.has(o.skey) && pred(o));
  for (const it of list) {
    if (byKey.has(it.key) && !matched.has(it.key)) { matched.add(it.key); upsert.push(it); continue; }
    const other = isBareKey(it.key) ? free((o) => !isBareKey(o.skey) && o.name === it.name) : free((o) => isBareKey(o.skey) && o.name === it.name);
    if (other) { matched.add(other.skey); touch.push({ skey: other.skey, vmName: it.vmName }); continue; }
    upsert.push(it);
  }
  return { matched, upsert, touch };
}

/**
 * 하루치 기록(한 트랜잭션). rec = record.dayRecord() 결과. 이미 'ok' 인 vCenter 는 건너뛴다(하루 한 번).
 * @returns {{ok:boolean, recorded:number, missing:number, gone:number, reason?:string}}
 */
export async function commitDay(rec) {
  const x = await getSnapHistDb();
  if (!x) return { ok: false, recorded: 0, missing: 0, gone: 0, reason: 'snap-history DB 사용 불가' };
  const { db, st } = x;
  const { day, ts } = rec;
  let recorded = 0; let missing = 0; let gone = 0;
  db.exec('BEGIN');
  try {
    for (const vc of rec.perVc) {
      const cur = st.vcdayStatus.get(day, vc.vcenterId);
      if (cur?.status === 'ok') continue;
      if (vc.status !== 'ok') {
        st.insVcday.run(day, vc.vcenterId, vc.status, null, null, null, null, null, null, null, ts);
        missing += 1;
        continue;
      }
      const s = vc.sum;
      st.insVcday.run(day, vc.vcenterId, vc.status === 'partial' ? 'partial' : 'ok', s.vms, s.snaps, s.gb, s.gbUnknown, s.ageUnknown, s.over, s.countUnknown || 0, ts);
      st.delDayVc.run(day, vc.vcenterId);
      for (const r of vc.rows) st.insDay.run(day, vc.vcenterId, r.vmId, r.name, r.count, r.gb, r.oldestTs, r.power, r.judged ? 1 : 0, r.over ? 1 : 0, ts);
      // 항목 — 지금 있는 것은 넣거나 last_seen 을 올리고, 열린 것 중 안 보이는 것은 닫는다(집합을 아는 VM · 없어진 VM 만)
      const byVm = new Map();
      for (const it of vc.items) { if (!byVm.has(it.vmId)) byVm.set(it.vmId, []); byVm.get(it.vmId).push(it); }
      const open = st.openItems.all(vc.vcenterId);
      const openByVm = new Map();
      for (const o of open) { if (!openByVm.has(o.vm_id)) openByVm.set(o.vm_id, []); openByVm.get(o.vm_id).push(o); }
      const matchedByVm = new Map();
      for (const [vmId, list] of byVm) {
        const m = matchItems(openByVm.get(vmId) || [], list);
        matchedByVm.set(vmId, m.matched);
        for (const t of m.touch) st.seenItem.run(ts, t.vmName, vc.vcenterId, vmId, t.skey);
        for (const it of m.upsert) {
          st.upItem.run(vc.vcenterId, vmId, it.key, it.name, it.vmName, it.createTs, it.mem == null ? null : it.mem ? 1 : 0, it.quiesced == null ? null : it.quiesced ? 1 : 0, ts, ts);
        }
      }
      for (const [vmId, opens] of openByVm) {
        const inInv = vc.vmIds.has(vmId);
        if (inInv && !vc.knownVms.has(vmId)) continue;   // 집합을 모른다 — 닫지 않는다
        const matched = matchedByVm.get(vmId) || new Set();
        for (const o of opens) {
          if (inInv && matched.has(o.skey)) continue;
          st.goneItem.run(ts, inInv ? 'snap' : 'vm', vc.vcenterId, vmId, o.skey);
          gone += 1;
        }
      }
      recorded += 1;
    }
    if (recorded && !st.metaGet.get('started')) st.metaSet.run('started', day);
    db.exec('COMMIT');
    _gen += 1;
    return { ok: true, recorded, missing, gone };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    _gen += 1;
    return { ok: false, recorded: 0, missing: 0, gone: 0, reason: e.message };
  }
}

/** 보관 기간 정리(청크). 기동 첫 틱에 부르지 않는다(poller 가 지킨다). */
export async function pruneSnapHist(days = retentionDays()) {
  const x = await getSnapHistDb();
  if (!x) return { ok: false };
  const cut = Date.now() - days * DAY;
  const opt = { targetMs: 50 };
  const a = await chunkedDelete(x.st.pruneVcday, [cut], opt);
  const b = await chunkedDelete(x.st.pruneDay, [cut], opt);
  const c = await chunkedDelete(x.st.pruneItem, [cut], opt);
  _gen += 1;
  return { ok: true, deleted: (a?.deleted || 0) + (b?.deleted || 0) + (c?.deleted || 0) };
}

export async function snapHistMeta() {
  const x = await getSnapHistDb();
  if (!x) return null;
  return { started: x.st.metaGet.get('started')?.v || null, lastDay: x.st.lastDay.get()?.d || null };
}

/** 읽기 문 묶음(history.js 가 쓴다). DB 가 없으면 null. */
export async function snapHistStmts() {
  const x = await getSnapHistDb();
  return x ? x.st : null;
}
