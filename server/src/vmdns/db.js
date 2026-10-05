/**
 * vmdns/db.js — VM DNS 서버 설정 **변경 이력** 전용 DB(`vm-dns.db`, v2.696).
 *
 * 파일: `config.dbDir || CONFIG_DIR` 아래 `vm-dns.db`(`insights/dbLocation.js MIGRATABLE` 등재).
 *
 * ── 행 수를 먼저 계산했다(CLAUDE.md v2.504 규칙) ───────────────────────────────
 *  · `dns_latest` = VM 당 1행(5,850 VM → 5,850행). 매 주기 전량을 다시 쓰지 않는다 — 폴러가 메모리에 든 최신값과 비교해
 *    **바뀐 것만** 쓰고, 마지막 관측 시각(`seen`)은 6시간에 한 번만 갱신한다.
 *  · `dns_change` = **바뀐 것만**(diff 저장). DNS 서버 설정은 드물게 바뀐다 — 5,850 VM 이 1년에 한 번씩 바꿔도 연 5,850행.
 *    VM 이 처음 보고될 때는 변경 행을 만들지 않는다(첫 기동에 수천 행의 '변경' 이 쌓이지 않게) — 첫 관측은 `dns_latest` 의
 *    `first_ts`·`first_servers` 에 남고, VM 상세 이력이 그것을 '첫 관측' 으로 보여 준다.
 *    ⚠ `first` 열은 계약의 모양을 따라 두었지만 폴러는 항상 0 을 쓴다(첫 관측은 위 두 열이 담는다).
 *  · 보존: `VMDNS_HISTORY_RETENTION_DAYS`(기본 365, 0 = 전부 보관) — 변경 행은 ts, 최신 행은 마지막 관측(seen) 기준.
 *  · prune 은 `ts`·`seen` 단독 인덱스 + 청크 DELETE(`util/chunkedPrune.js`).
 * open 은 진행 중인 시도를 공유하고(v2.550 규약) 잠금이면 래치하지 않는다(`util/sqliteOpen.js`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { chunkedDelete, createPruneFlight } from '../util/chunkedPrune.js';

const DB_PATH = () => path.join(config.dbDir || config.configDir, 'vm-dns.db');
const WRITE_CHUNK = 2_000;   // 한 트랜잭션의 행 수 — 커밋한 뒤에만 양보한다(트랜잭션을 연 채 양보하지 않는다)

let x = null;          // { db, st, path }
let ready = null;      // 진행 중인 open 시도(공유)
let initError = null;
const lockRetry = createLockRetry();
let _rev = 0;          // 변경 행을 쓸 때마다 오른다(응답 캐시 키)

function prepare(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dns_latest (
      vm_id TEXT PRIMARY KEY,
      vcenter_id TEXT NOT NULL DEFAULT '',
      vm_name TEXT NOT NULL DEFAULT '',
      sig TEXT NOT NULL,                   -- 서버 주소를 순서대로 쉼표로 이은 것(1차·2차 순서도 설정이다)
      servers TEXT NOT NULL,               -- JSON 배열
      ts INTEGER NOT NULL,                 -- 지금 값을 처음 본 시각
      seen INTEGER NOT NULL,               -- 마지막으로 관측한 시각(6시간 단위로만 갱신)
      first_ts INTEGER NOT NULL,           -- 이 VM 을 처음 관측한 시각
      first_servers TEXT NOT NULL          -- 그때의 서버 주소(JSON)
    );
    CREATE INDEX IF NOT EXISTS idx_dns_latest_seen ON dns_latest (seen);
    CREATE TABLE IF NOT EXISTS dns_change (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      vm_id TEXT NOT NULL,
      vcenter_id TEXT NOT NULL DEFAULT '',
      vm_name TEXT NOT NULL DEFAULT '',
      before TEXT NOT NULL,                -- JSON 배열
      after TEXT NOT NULL,                 -- JSON 배열
      first INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dns_change_ts ON dns_change (ts);
    CREATE INDEX IF NOT EXISTS idx_dns_change_vm ON dns_change (vm_id);
  `);
  return {
    latestAll: db.prepare('SELECT vm_id, vcenter_id, vm_name, sig, seen FROM dns_latest'),
    latestOne: db.prepare('SELECT vm_id, vcenter_id, vm_name, sig, servers, ts, seen, first_ts, first_servers FROM dns_latest WHERE vm_id = ?'),
    insFirst: db.prepare(`INSERT INTO dns_latest (vm_id, vcenter_id, vm_name, sig, servers, ts, seen, first_ts, first_servers)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(vm_id) DO UPDATE SET vcenter_id=excluded.vcenter_id, vm_name=excluded.vm_name, seen=excluded.seen`),
    updChange: db.prepare('UPDATE dns_latest SET vcenter_id=?, vm_name=?, sig=?, servers=?, ts=?, seen=? WHERE vm_id=?'),
    insChange: db.prepare('INSERT INTO dns_change (ts, vm_id, vcenter_id, vm_name, before, after, first) VALUES (?,?,?,?,?,?,0)'),
    touch: db.prepare('UPDATE dns_latest SET seen=?, vm_name=? WHERE vm_id=?'),
    recent: db.prepare('SELECT ts, vm_id, vcenter_id, vm_name, before, after, first FROM dns_change WHERE ts >= ? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?'),
    byVm: db.prepare('SELECT ts, before, after, first FROM dns_change WHERE vm_id = ? ORDER BY ts DESC, id DESC LIMIT ?'),
    pruneChange: db.prepare('DELETE FROM dns_change WHERE rowid IN (SELECT rowid FROM dns_change WHERE ts < ? LIMIT ?)'),
    pruneLatest: db.prepare('DELETE FROM dns_latest WHERE rowid IN (SELECT rowid FROM dns_latest WHERE seen < ? LIMIT ?)'),
    countLatest: db.prepare('SELECT COUNT(*) AS n FROM dns_latest'),
    countChange: db.prepare('SELECT COUNT(*) AS n FROM dns_change'),
  };
}

async function open() {
  if (x) return x;
  if (initError) return null;
  if (!ready && lockRetry.blocked()) return null;
  if (!ready) {
    ready = (async () => withOpenCleanup(async () => {
      // eslint-disable-next-line import/no-unresolved
      const { DatabaseSync } = await import('node:sqlite');
      const p = DB_PATH();
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const db = openSqlite(new DatabaseSync(p));   // chmod 0600 · busy_timeout 먼저 · 잠금이면 닫고 던진다
      const st = prepare(db);
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      lockRetry.ok();
      x = { db, st, path: p };
      return x;
    }))().catch((e) => { if (lockRetry.onFail(e)) { ready = null; return null; } initError = e; return null; });
  }
  return ready;
}

const reason = () => (initError ? String(initError.message || initError).slice(0, 200) : (lockRetry.note() || 'node:sqlite 없음'));
const json = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const parse = (s) => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
const s128 = (v) => String(v ?? '').slice(0, 256);

export function vmDnsChangeRev() { return _rev; }

/** 최신값 전량(폴러가 기동 뒤 한 번 읽어 메모리에 둔다). DB 가 없으면 null. */
export async function loadLatestMap() {
  const h = await open();
  if (!h) return null;
  const m = new Map();
  for (const r of h.st.latestAll.all()) m.set(r.vm_id, { sig: r.sig, seen: Number(r.seen), vcenterId: r.vcenter_id, vmName: r.vm_name });
  return m;
}

/**
 * 관측 반영 — 2,000행마다 커밋하고 **커밋한 뒤에만** 양보한다(첫 기동의 수천 행이 이벤트 루프를 붙잡지 않게).
 * @param {{now:number, firsts:object[], changes:object[], touches:object[]}} o
 *   firsts:[{vmId,vcId,name,servers,sig}] · changes:[{vmId,vcId,name,before,after,sig}] · touches:[{vmId,name}]
 */
export async function applyObservations({ now, firsts = [], changes = [], touches = [] } = {}) {
  const h = await open();
  if (!h) return { ok: false, reason: reason() };
  const ops = [
    ...firsts.map((f) => () => h.st.insFirst.run(s128(f.vmId), s128(f.vcId), s128(f.name), f.sig, json(f.servers), now, now, now, json(f.servers))),
    ...changes.map((c) => () => {
      h.st.insChange.run(now, s128(c.vmId), s128(c.vcId), s128(c.name), json(c.before), json(c.after));
      h.st.updChange.run(s128(c.vcId), s128(c.name), c.sig, json(c.after), now, now, s128(c.vmId));
    }),
    ...touches.map((t) => () => h.st.touch.run(now, s128(t.name), s128(t.vmId))),
  ];
  let done = 0;
  for (let i = 0; i < ops.length; i += WRITE_CHUNK) {
    h.db.exec('BEGIN');
    try {
      for (const op of ops.slice(i, i + WRITE_CHUNK)) op();
      h.db.exec('COMMIT');
    } catch (e) {
      try { h.db.exec('ROLLBACK'); } catch { /* */ }
      if (changes.length) _rev += 1;
      return { ok: false, reason: String(e?.message || e).slice(0, 200), done };
    }
    done += Math.min(WRITE_CHUNK, ops.length - i);
    if (i + WRITE_CHUNK < ops.length) await new Promise((r) => setImmediate(r));
  }
  if (changes.length) _rev += 1;
  return { ok: true, firsts: firsts.length, changes: changes.length, touches: touches.length };
}

/**
 * 변경 목록(최신 먼저). vcenterIds(Set) 를 주면 그 vCenter 만 — SQL 의 LIMIT 앞에서 거르지 않으면 범위 계정이 덜 받는다.
 * 그래서 범위가 있으면 넉넉히 읽어 거른다(변경 행은 드물다 — 상한 20,000행 안에서).
 */
export async function listChanges({ since = 0, limit = 200, offset = 0, vcenterIds = null, vcenterId = '' } = {}) {
  const h = await open();
  if (!h) return { available: false, reason: reason(), changes: [] };
  const filtered = !!(vcenterIds || vcenterId);
  const rows = h.st.recent.all(Math.max(0, Math.floor(since)), filtered ? 20_000 : limit, filtered ? 0 : offset);
  let list = rows.map((r) => ({ ts: Number(r.ts), vmId: r.vm_id, vmName: r.vm_name, vcenterId: r.vcenter_id, before: parse(r.before), after: parse(r.after), first: !!r.first }));
  let capped = false;
  if (filtered) {
    capped = rows.length >= 20_000;
    list = list.filter((c) => (!vcenterIds || vcenterIds.has(c.vcenterId)) && (!vcenterId || c.vcenterId === vcenterId)).slice(offset, offset + limit);
  }
  return { available: true, changes: list, capped };
}

/** VM 한 대의 이력 — 첫 관측(dns_latest.first_*) + 변경 행. 최신 먼저. */
export async function vmHistory(vmId, { limit = 100 } = {}) {
  const h = await open();
  if (!h) return { available: false, reason: reason(), history: [] };
  const id = s128(vmId);
  const out = h.st.byVm.all(id, Math.max(1, Math.min(500, limit))).map((r) => ({ ts: Number(r.ts), before: parse(r.before), after: parse(r.after), first: !!r.first }));
  const lt = h.st.latestOne.get(id);
  if (lt) out.push({ ts: Number(lt.first_ts), before: null, after: parse(lt.first_servers), first: true });
  return { available: true, history: out, latest: lt ? { servers: parse(lt.servers), since: Number(lt.ts), seen: Number(lt.seen) } : null };
}

const _pruneFlight = createPruneFlight();
/** 보존 정리 — days 0 = 전부 보관. 변경 행은 ts, 최신 행은 마지막 관측(seen) 기준. */
export async function pruneVmDns(days) {
  const d = Number(days) || 0;
  if (d <= 0) return { skipped: true, reason: '전부 보관' };
  const h = await open();
  if (!h) return { skipped: true, reason: reason() };
  return _pruneFlight.run(d, async () => {
    const before = Date.now() - d * 86_400_000;
    try {
      const a = await chunkedDelete(h.st.pruneChange, [before], { label: 'vm-dns.change' });
      const b = await chunkedDelete(h.st.pruneLatest, [before], { label: 'vm-dns.latest' });
      return { skipped: false, deleted: a.deleted + b.deleted, changes: a.deleted, latest: b.deleted, before };
    } catch (e) {
      console.warn(`[vm-dns] 이력 정리 실패: ${e?.message || e}`);
      return { skipped: false, deleted: 0, before, error: String(e?.message || e).slice(0, 200) };
    }
  });
}

/** 상태(화면·서비스 점검). 행 수는 부를 때만 센다(폴링 경로 아님 — withCount). */
export async function vmDnsDbStatus({ withCount = false } = {}) {
  const h = await open();
  let rows = null;
  if (h && withCount) {
    try { rows = { latest: Number(h.st.countLatest.get()?.n ?? 0), changes: Number(h.st.countChange.get()?.n ?? 0) }; } catch { rows = null; }
  }
  return { available: !!h, path: h ? h.path : DB_PATH(), error: h ? '' : reason(), rows };
}

export function _resetVmDnsDbForTest() {
  lockRetry.ok();
  try { x?.db?.close?.(); } catch { /* */ }
  x = null; ready = null; initError = null; _rev = 0; _pruneFlight.reset();
}
