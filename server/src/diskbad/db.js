/**
 * diskbad/db.js — 중앙의 디스크 배드 섹터 이력 저장소(SQLite, v3.8.0).
 *
 * 무엇을 쌓나(README §8.3):
 *  · `dbr_server`  서버마다 마지막 점검 결과 · 로그가 남은 구간 · **끊김 없이 본 구간(continuous_since)** · 지금 디스크 목록.
 *  · `dbr_record`  물리 · 가상 디스크 범주(PDR/VDR) 로그 원문 — (agent, 서버, 항목 Id|시각)로 중복을 거른다.
 *                  iDRAC 로그가 덮어써져도 여기 남는다(다음 조회에 그대로 보인다).
 *  · `dbr_serial`  자리마다 본 시리얼과 처음 · 마지막 본 시각 — '아직 사용 중 / 교체됨' 을 **확정**하는 근거.
 *
 * 규칙:
 *  · 대량 쓰기는 **트랜잭션 하나**(루트 CLAUDE.md — 무트랜잭션 6천 행 25초 블로킹 사고).
 *  · 경로는 `config.dbDir` 를 따르고 `insights/dbLocation.js MIGRATABLE` 에 등재한다(둘을 같이 — dbLocation2451 테스트).
 *  · 첫 open 이 잠금이면 래치하지 않는다(`createLockRetry`). 손상 · 상위 판이면 `available:false` 로 밝힌다(포탈은 뜬다).
 *  · '끊김 없이 본 구간' 계산은 **여기 한 곳**이다(엣지는 읽은 사실만 보낸다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { openSqlite, withOpenCleanup, createLockRetry } from '../util/sqliteOpen.js';
import { createYielder } from '../util/timeSlice.js';
import { slotOf, slotKeyOf, codeOf, driveSlotOf } from './classify.js';

export const DB_FILE = 'disk-bad.db';
// 파일 이름은 글자 그대로 둔다 — 설정 파일 문서 생성기(scripts/config-doc.mjs)가 path.join 의 '*.db' 글자를 찾는다(docsGen2452).
const DB_PATH = () => process.env.DISKBAD_DB_PATH || path.join(config.dbDir || config.configDir, 'disk-bad.db');
export const SCHEMA_VERSION = 1;

let x = null;
let ready = null;
let initError = null;
const lockRetry = createLockRetry();
let _gen = 0;
let _cache = null;        // loadAll 결과(세대가 바뀌면 버린다)
let _countCache = null;   // 상태 표의 건수(세대가 바뀌면 다시 센다)

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS dbr_server(
      agent TEXT NOT NULL, server_id TEXT NOT NULL,
      name TEXT, host TEXT, service_tag TEXT,
      first_ok_at INTEGER, last_scan_at INTEGER, last_ok_at INTEGER, last_status TEXT, last_reason TEXT,
      log_order TEXT, log_total INTEGER, log_oldest INTEGER, covered_from INTEGER, continuous_since INTEGER,
      complete INTEGER, read_last INTEGER, synthesized INTEGER, inv_at INTEGER, drives_json TEXT, updated_at INTEGER,
      newest_created INTEGER, read_stop TEXT, read_diag TEXT, probe_json TEXT, probe_at INTEGER,
      PRIMARY KEY(agent, server_id));
    CREATE TABLE IF NOT EXISTS dbr_record(
      agent TEXT NOT NULL, server_id TEXT NOT NULL, entry_key TEXT NOT NULL,
      created INTEGER, code TEXT, message_id TEXT, severity TEXT, message TEXT, slot_key TEXT,
      received_at INTEGER, baseline INTEGER,
      PRIMARY KEY(agent, server_id, entry_key));
    CREATE INDEX IF NOT EXISTS ix_dbr_record_created ON dbr_record(created);
    CREATE TABLE IF NOT EXISTS dbr_serial(
      agent TEXT NOT NULL, server_id TEXT NOT NULL, slot_key TEXT NOT NULL, serial TEXT NOT NULL,
      model TEXT, first_seen INTEGER, last_seen INTEGER,
      PRIMARY KEY(agent, server_id, slot_key, serial));
  `);
  // 개발 중 만든 DB(열이 없던 판)도 연다 — 열만 더한다.
  const cols = new Set(db.prepare('PRAGMA table_info(dbr_server)').all().map((c) => c.name));
  if (!cols.has('newest_created')) db.exec('ALTER TABLE dbr_server ADD COLUMN newest_created INTEGER');
  if (!cols.has('read_stop')) db.exec('ALTER TABLE dbr_server ADD COLUMN read_stop TEXT');
  // v3.8.2: 읽기 진단(무엇을 읽었는가) · 장비 진단(그 장비가 무엇을 주는가). 3.8.0 · 3.8.1 이 만든 DB 에 열만 더한다.
  if (!cols.has('read_diag')) db.exec('ALTER TABLE dbr_server ADD COLUMN read_diag TEXT');
  if (!cols.has('probe_json')) db.exec('ALTER TABLE dbr_server ADD COLUMN probe_json TEXT');
  if (!cols.has('probe_at')) db.exec('ALTER TABLE dbr_server ADD COLUMN probe_at INTEGER');
  const v = db.prepare("SELECT v FROM meta WHERE k='schema'").get()?.v;
  if (v != null && Number(v) > SCHEMA_VERSION) throw new Error(`disk-bad.db 의 판(${v})이 이 포탈(${SCHEMA_VERSION})보다 새것입니다 — 포탈을 올리세요.`);
  db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('schema', ?)").run(String(SCHEMA_VERSION));
}

function prepare(db) {
  return {
    serverGet: db.prepare('SELECT * FROM dbr_server WHERE agent=? AND server_id=?'),
    serverUpsert: db.prepare(`INSERT INTO dbr_server(agent, server_id, name, host, service_tag, first_ok_at, last_scan_at, last_ok_at, last_status, last_reason,
        log_order, log_total, log_oldest, covered_from, continuous_since, complete, read_last, synthesized, inv_at, drives_json, updated_at, newest_created, read_stop, read_diag, probe_json, probe_at)
      VALUES(@agent, @server_id, @name, @host, @service_tag, @first_ok_at, @last_scan_at, @last_ok_at, @last_status, @last_reason,
        @log_order, @log_total, @log_oldest, @covered_from, @continuous_since, @complete, @read_last, @synthesized, @inv_at, @drives_json, @updated_at, @newest_created, @read_stop, @read_diag, @probe_json, @probe_at)
      ON CONFLICT(agent, server_id) DO UPDATE SET name=excluded.name, host=excluded.host, service_tag=excluded.service_tag,
        first_ok_at=excluded.first_ok_at, last_scan_at=excluded.last_scan_at, last_ok_at=excluded.last_ok_at, last_status=excluded.last_status,
        last_reason=excluded.last_reason, log_order=excluded.log_order, log_total=excluded.log_total, log_oldest=excluded.log_oldest,
        covered_from=excluded.covered_from, continuous_since=excluded.continuous_since, complete=excluded.complete, read_last=excluded.read_last,
        synthesized=excluded.synthesized, inv_at=excluded.inv_at, drives_json=excluded.drives_json, updated_at=excluded.updated_at,
        newest_created=excluded.newest_created, read_stop=excluded.read_stop, read_diag=excluded.read_diag,
        probe_json=excluded.probe_json, probe_at=excluded.probe_at`),
    recInsert: db.prepare(`INSERT OR IGNORE INTO dbr_record(agent, server_id, entry_key, created, code, message_id, severity, message, slot_key, received_at, baseline)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    serialUpsert: db.prepare(`INSERT INTO dbr_serial(agent, server_id, slot_key, serial, model, first_seen, last_seen) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent, server_id, slot_key, serial) DO UPDATE SET model=excluded.model,
        first_seen=MIN(dbr_serial.first_seen, excluded.first_seen), last_seen=MAX(dbr_serial.last_seen, excluded.last_seen)`),
    serversAll: db.prepare('SELECT * FROM dbr_server'),
    recordsAll: db.prepare('SELECT agent, server_id, entry_key, created, code, message_id, severity, message, slot_key, received_at, baseline FROM dbr_record'),
    serialsAll: db.prepare('SELECT agent, server_id, slot_key, serial, model, first_seen, last_seen FROM dbr_serial'),
    recordsOf: db.prepare('SELECT * FROM dbr_record WHERE agent=? AND server_id=? ORDER BY created DESC'),
    serialsOf: db.prepare('SELECT * FROM dbr_serial WHERE agent=? AND server_id=?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM dbr_record'),
    countServers: db.prepare('SELECT COUNT(*) AS n FROM dbr_server'),
    countOf: db.prepare('SELECT COUNT(*) AS n FROM dbr_record WHERE agent=? AND server_id=?'),
    pruneOf: db.prepare(`DELETE FROM dbr_record WHERE rowid IN (SELECT rowid FROM dbr_record WHERE agent=? AND server_id=? ORDER BY created DESC LIMIT -1 OFFSET ?)`),
    metaGet: db.prepare('SELECT v FROM meta WHERE k=?'),
    metaSet: db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)'),
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
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const db = openSqlite(new DatabaseSync(p));
      try { migrate(db); } catch (e) { try { db.close(); } catch { /* */ } throw e; }
      try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
      x = { db, st: prepare(db), path: p };
      return x;
    }))().catch((e) => { if (lockRetry.onFail(e)) { ready = null; return null; } initError = e; return null; });
  }
  return ready;
}

/** 저장 세대 — 응답 캐시가 '바뀌었는가' 를 묻는다(적재마다 1 오른다). */
export function diskBadGeneration() { return _gen; }

const finite = (v) => (Number.isFinite(v) ? v : null);
const minOf = (...v) => { const f = v.filter(Number.isFinite); return f.length ? Math.min(...f) : null; };

/**
 * 끊김 없이 본 구간의 시작(순수 — 테스트가 고정). 이 시각 이후의 '디스크 빠짐 기록 없음' 은 믿을 수 있다.
 *  · 이어 읽기에서 지난번 자리를 찾았다 → 그대로(처음 보는 서버면 이번에 읽은 가장 오래된 시각).
 *  · 끝까지 읽었다(처음 · 다시 전량 · 지난번 자리를 못 찾음 = 로그가 지워졌거나 넘어감) → 이번에 읽은 가장 오래된 시각.
 *  · 도중에 멈췄다 → 이번에 읽은 가장 오래된 시각(그 아래는 이번에 못 봤다 — 보수적으로).
 */
export function nextContinuousSince(prev, log) {
  if (!log) return finite(prev);
  const oldest = finite(log.oldestRead);
  if (log.cursorUsed && log.foundCursor) return finite(prev) ?? oldest ?? finite(log.cursorCreated);
  return oldest;
}

/** 서버 한 대가 DB 에 들고 있는 기록 상한 — 넘으면 오래된 것부터 지운다(보관 정리 · 반증 #11). 배드 섹터 계열만 쌓이므로 정상 장비는 닿지 않는다. */
export const RECORDS_PER_SERVER_MAX = 20_000;

/**
 * 엣지 · 중앙 직결 점검 결과를 적재한다(정제된 서버 결과 배열 — ingest.js 가 정제한다).
 *
 * 반증 #11: 서버 **한 대씩** 트랜잭션으로 쓰고 사이에서 양보한다(25대 × 5,000건을 한 동기 구간으로 쓰면 1초 가까이 막는다).
 * 서버 단위로는 원자적이다 — 도중에 실패하면 그 서버는 되돌리고, 앞 서버들은 남는다(`storedIds`). 호출자는 실패한 묶음의
 * 커서를 앞으로 보내지 않으므로(반증 #1) 남은 서버도 다음 점검에서 다시 읽는다(키로 중복을 거른다).
 *
 * 새 기록(메일 대상)은 **그 서버의 첫 정상 점검이 아니고**(기준선), **지난 점검에서 본 가장 새 항목보다 새 것**만이다(반증 #15 —
 * 일부만 읽은 뒤 더 깊이 읽어 과거 항목을 채워 넣는 것은 새 기록이 아니다).
 * @returns {Promise<{ok:boolean, reason?:string, servers:number, storedIds:string[], newRecords:Array, baselineServers:number}>}
 */
export async function ingestServers(agent, servers, { now = Date.now(), yielder = createYielder(15) } = {}) {
  // 진행 보고(서버 0대)는 DB 를 건드리지 않는다 — 세대를 올리면 화면 캐시만 버려진다.
  if (!Array.isArray(servers) || !servers.length) return { ok: true, servers: 0, storedIds: [], newRecords: [], baselineServers: 0 };
  const h = await open();
  if (!h) return { ok: false, reason: dbUnavailableReason(), servers: 0, storedIds: [], newRecords: [], baselineServers: 0 };
  const a = String(agent || '').trim().toLowerCase();
  const newRecords = [];
  const storedIds = [];
  let baselineServers = 0;
  for (const s of servers || []) {
    // eslint-disable-next-line no-await-in-loop
    await yielder();
    const fresh = [];
    let isBaseline = false;
    h.db.exec('BEGIN');
    try {
      const prev = h.st.serverGet.get(a, s.id) || null;
      const baseline = !(prev && Number.isFinite(prev.first_ok_at));
      const drivesJson = Array.isArray(s.drives) ? JSON.stringify(s.drives) : (prev?.drives_json ?? null);
      const row = {
        agent: a, server_id: s.id, name: s.name || prev?.name || '', host: s.host || prev?.host || '', service_tag: s.serviceTag || prev?.service_tag || '',
        first_ok_at: prev?.first_ok_at ?? null, last_scan_at: now, last_ok_at: prev?.last_ok_at ?? null,
        last_status: s.ok ? 'ok' : (s.reason || 'error'), last_reason: s.ok ? '' : (s.reasonText || ''),
        log_order: prev?.log_order ?? null, log_total: prev?.log_total ?? null, log_oldest: prev?.log_oldest ?? null,
        covered_from: prev?.covered_from ?? null, continuous_since: prev?.continuous_since ?? null, complete: prev?.complete ?? null,
        read_last: prev?.read_last ?? null, synthesized: s.synthesized ? 1 : (prev?.synthesized ?? 0),
        inv_at: Number.isFinite(s.invAt) ? s.invAt : (prev?.inv_at ?? null), drives_json: drivesJson, updated_at: now,
        newest_created: prev?.newest_created ?? null, read_stop: prev?.read_stop ?? null,
        read_diag: prev?.read_diag ?? null, probe_json: prev?.probe_json ?? null, probe_at: prev?.probe_at ?? null,
      };
      // 장비 진단은 온 것만 바꾼다(서버 한 대를 직접 점검했을 때만 온다). 로그 읽기가 실패한 점검에도 실릴 수 있다.
      if (s.probe) { row.probe_json = JSON.stringify(s.probe).slice(0, 20_000); row.probe_at = now; }
      if (s.ok && s.log) {
        // 반증 #8: 기록 상한으로 잘렸으면 그 아래 구간은 이번에 '본' 것이 아니다 — 남긴 가장 오래된 기록부터만 본 것으로 적고 complete 를 내린다.
        let capFloor = null;
        if (s.recordsCapped) for (const r of s.records || []) if (Number.isFinite(r.created) && (capFloor == null || r.created < capFloor)) capFloor = r.created;
        const L = s.recordsCapped
          ? { ...s.log, oldestRead: Number.isFinite(capFloor) ? Math.max(capFloor, finite(s.log.oldestRead) ?? capFloor) : finite(s.log.oldestRead), reachedEnd: false, foundCursor: false, cursorUsed: false }
          : s.log;
        if (baseline) { baselineServers += 1; isBaseline = true; }
        const prevNewest = finite(prev?.newest_created);
        row.first_ok_at = prev?.first_ok_at ?? now;
        row.last_ok_at = now;
        row.log_order = L.order || null;
        row.log_total = finite(L.total);
        if (L.reachedEnd) row.log_oldest = finite(L.oldestRead);
        row.covered_from = minOf(prev?.covered_from, L.oldestRead);
        row.continuous_since = nextContinuousSince(prev?.continuous_since, L);
        row.complete = (L.reachedEnd || L.foundCursor) ? 1 : 0;
        row.read_last = finite(L.read);
        // 왜 끝까지 못 읽었나(budget · max · skip — 장비가 쪽 넘김을 지원하지 않음 · capped — 기록 상한). 화면이 '일부만 읽음' 의 이유로 밝힌다.
        row.read_stop = s.recordsCapped ? 'capped' : (s.log.stopped || null);
        // 읽기 진단은 **처음부터 읽은 점검**의 것만 남긴다 — 이어 읽기는 새 항목 몇 건의 구성이라 활성 로그 전체를 말하지 않는다.
        if (!s.log.cursorUsed && Array.isArray(s.log.top)) {
          row.read_diag = JSON.stringify({ at: now, read: finite(s.log.read), total: finite(s.log.total), pages: finite(s.log.pages), ms: finite(s.log.ms),
            distinct: finite(s.log.distinct), firstLen: finite(s.log.firstLen), hasNext: s.log.hasNext ?? null, path: s.log.path || '', top: s.log.top,
            oldest: finite(s.log.oldestRead), newest: finite(s.log.newestCreated), reachedEnd: s.log.reachedEnd === true }).slice(0, 4_000);
        }
        const nc = finite(L.newestCreated);
        row.newest_created = nc != null && (prevNewest == null || nc > prevNewest) ? nc : prevNewest;
        for (const r of s.records || []) {
          if (!Number.isFinite(r.created)) continue;
          const code = codeOf(r.messageId) || String(r.code || '').toUpperCase().slice(0, 12);
          const key = `${r.entryId}|${Number.isFinite(r.createdRaw) ? r.createdRaw : r.created}`.slice(0, 96);
          const slotKey = slotKeyOf(slotOf(r.message));
          const ch = h.st.recInsert.run(a, s.id, key, r.created, code, r.messageId, r.severity, r.message, slotKey, now, baseline ? 1 : 0);
          const isNew = !baseline && (prevNewest == null || r.created > prevNewest);
          if (ch.changes > 0 && isNew) fresh.push({ agent: a, serverId: s.id, serverName: row.name, created: r.created, code, message: r.message, slotKey });
        }
        if ((s.records || []).length && (h.st.countOf.get(a, s.id)?.n ?? 0) > RECORDS_PER_SERVER_MAX) h.st.pruneOf.run(a, s.id, RECORDS_PER_SERVER_MAX);
      }
      if (Array.isArray(s.drives)) {
        const seen = Number.isFinite(s.invAt) ? s.invAt : now;
        for (const d of s.drives) {
          const sl = driveSlotOf(d);
          const serial = String(d.serial || '').trim();
          if (!sl || !serial) continue;
          h.st.serialUpsert.run(a, s.id, slotKeyOf(sl), serial.slice(0, 64), String(d.model || '').slice(0, 80), seen, seen);
        }
      }
      h.st.serverUpsert.run(row);
      h.db.exec('COMMIT');
    } catch (e) {
      try { h.db.exec('ROLLBACK'); } catch { /* */ }
      if (isBaseline) baselineServers -= 1;
      _gen += 1; _cache = null;
      return { ok: false, reason: `DB 저장 실패: ${String(e?.message || e).slice(0, 160)}`, servers: storedIds.length, storedIds, newRecords, baselineServers };
    }
    storedIds.push(s.id);
    for (const f of fresh) newRecords.push(f);
  }
  _gen += 1; _cache = null;
  return { ok: true, servers: storedIds.length, storedIds, newRecords, baselineServers };
}

const parseObj = (v) => { try { const j = JSON.parse(v || 'null'); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
const rowServer = (r) => ({
  agent: r.agent, serverId: r.server_id, name: r.name || '', host: r.host || '', serviceTag: r.service_tag || '',
  firstOkAt: r.first_ok_at, lastScanAt: r.last_scan_at, lastOkAt: r.last_ok_at, lastStatus: r.last_status || '', lastReason: r.last_reason || '',
  logOrder: r.log_order, logTotal: r.log_total, logOldest: r.log_oldest, coveredFrom: r.covered_from, continuousSince: r.continuous_since,
  complete: r.complete == null ? null : r.complete === 1, readLast: r.read_last, synthesized: r.synthesized === 1, invAt: r.inv_at, newestCreated: r.newest_created ?? null, readStop: r.read_stop || '',
  readDiag: parseObj(r.read_diag), probe: parseObj(r.probe_json), probeAt: r.probe_at ?? null,
  drives: (() => { try { const j = JSON.parse(r.drives_json || 'null'); return Array.isArray(j) ? j : null; } catch { return null; } })(),
});
const rowRecord = (r) => ({
  agent: r.agent, serverId: r.server_id, entryKey: r.entry_key, created: r.created, code: r.code || '', messageId: r.message_id || '',
  severity: r.severity || '', message: r.message || '', slotKey: r.slot_key || '', receivedAt: r.received_at, baseline: r.baseline === 1,
});
const rowSerial = (r) => ({ agent: r.agent, serverId: r.server_id, slotKey: r.slot_key, serial: r.serial, model: r.model || '', firstSeen: r.first_seen, lastSeen: r.last_seen });

/**
 * 화면 집계의 입력 전량. 반증 #11: 세대(적재)가 같으면 다시 읽지 않는다 — 화면을 몇 번 열어도 DB 는 적재 뒤 한 번만 읽는다.
 * 읽을 때는 행을 하나씩 넘기며 **시간 기준으로 양보**한다(기록이 많을 때 한 동기 구간으로 막지 않게). 서버당 기록 상한은 ingest 가 지킨다.
 */
async function readAllRows(stmt, map, yielder) {
  const out = [];
  for (const r of stmt.iterate()) {
    out.push(map(r));
    // eslint-disable-next-line no-await-in-loop
    if ((out.length & 1023) === 0) await yielder();
  }
  return out;
}
export async function loadAll() {
  const h = await open();
  if (!h) return null;
  if (_cache && _cache.gen === _gen) return _cache.v;
  const gen = _gen;
  const y = createYielder(15);
  const v = {
    servers: await readAllRows(h.st.serversAll, rowServer, y),
    records: await readAllRows(h.st.recordsAll, rowRecord, y),
    serials: await readAllRows(h.st.serialsAll, rowSerial, y),
  };
  if (gen === _gen) _cache = { gen, v };
  return v;
}

/** 작은 값 보관(자동 점검의 마지막 실행 시각 — 재시작해도 6시간 주기를 지킨다 · 반증 #13). 못 읽으면 null. */
export async function getDiskBadMeta(k) {
  const h = await open();
  if (!h) return null;
  try { return h.st.metaGet.get(String(k))?.v ?? null; } catch { return null; }
}
export async function setDiskBadMeta(k, v) {
  const h = await open();
  if (!h) return false;
  try { h.st.metaSet.run(String(k), String(v)); return true; } catch { return false; }
}

export async function loadServer(agent, serverId) {
  const h = await open();
  if (!h) return null;
  const a = String(agent || '').trim().toLowerCase();
  const s = h.st.serverGet.get(a, String(serverId));
  return {
    server: s ? rowServer(s) : null,
    records: h.st.recordsOf.all(a, String(serverId)).map(rowRecord),
    serials: h.st.serialsOf.all(a, String(serverId)).map(rowSerial),
  };
}

function dbUnavailableReason() {
  return initError ? String(initError.message || initError).slice(0, 200) : (lockRetry.note() || 'DB 를 아직 열지 못했습니다');
}

export async function diskBadDbStatus() {
  const h = await open();
  if (h && !(_countCache && _countCache.gen === _gen)) {
    _countCache = { gen: _gen, records: h.st.count.get()?.n ?? null, servers: h.st.countServers.get()?.n ?? null };
  }
  return {
    available: !!h, path: h ? h.path : DB_PATH(), error: h ? '' : dbUnavailableReason(),
    records: h ? _countCache.records : null, servers: h ? _countCache.servers : null,
  };
}

export function _resetDiskBadDbForTest() {
  try { x?.db?.close(); } catch { /* */ }
  x = null; ready = null; initError = null; _gen = 0; _cache = null; _countCache = null;
}
