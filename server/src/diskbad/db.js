/**
 * diskbad/db.js — 중앙의 디스크 배드 섹터 이력 저장소(SQLite, v2.915).
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
import { slotOf, slotKeyOf, codeOf, driveSlotOf } from './classify.js';

export const DB_FILE = 'disk-bad.db';
const DB_PATH = () => process.env.DISKBAD_DB_PATH || path.join(config.dbDir || config.configDir, DB_FILE);
export const SCHEMA_VERSION = 1;

let x = null;
let ready = null;
let initError = null;
const lockRetry = createLockRetry();
let _gen = 0;

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS dbr_server(
      agent TEXT NOT NULL, server_id TEXT NOT NULL,
      name TEXT, host TEXT, service_tag TEXT,
      first_ok_at INTEGER, last_scan_at INTEGER, last_ok_at INTEGER, last_status TEXT, last_reason TEXT,
      log_order TEXT, log_total INTEGER, log_oldest INTEGER, covered_from INTEGER, continuous_since INTEGER,
      complete INTEGER, read_last INTEGER, synthesized INTEGER, inv_at INTEGER, drives_json TEXT, updated_at INTEGER,
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
  const v = db.prepare("SELECT v FROM meta WHERE k='schema'").get()?.v;
  if (v != null && Number(v) > SCHEMA_VERSION) throw new Error(`disk-bad.db 의 판(${v})이 이 포탈(${SCHEMA_VERSION})보다 새것입니다 — 포탈을 올리세요.`);
  db.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('schema', ?)").run(String(SCHEMA_VERSION));
}

function prepare(db) {
  return {
    serverGet: db.prepare('SELECT * FROM dbr_server WHERE agent=? AND server_id=?'),
    serverUpsert: db.prepare(`INSERT INTO dbr_server(agent, server_id, name, host, service_tag, first_ok_at, last_scan_at, last_ok_at, last_status, last_reason,
        log_order, log_total, log_oldest, covered_from, continuous_since, complete, read_last, synthesized, inv_at, drives_json, updated_at)
      VALUES(@agent, @server_id, @name, @host, @service_tag, @first_ok_at, @last_scan_at, @last_ok_at, @last_status, @last_reason,
        @log_order, @log_total, @log_oldest, @covered_from, @continuous_since, @complete, @read_last, @synthesized, @inv_at, @drives_json, @updated_at)
      ON CONFLICT(agent, server_id) DO UPDATE SET name=excluded.name, host=excluded.host, service_tag=excluded.service_tag,
        first_ok_at=excluded.first_ok_at, last_scan_at=excluded.last_scan_at, last_ok_at=excluded.last_ok_at, last_status=excluded.last_status,
        last_reason=excluded.last_reason, log_order=excluded.log_order, log_total=excluded.log_total, log_oldest=excluded.log_oldest,
        covered_from=excluded.covered_from, continuous_since=excluded.continuous_since, complete=excluded.complete, read_last=excluded.read_last,
        synthesized=excluded.synthesized, inv_at=excluded.inv_at, drives_json=excluded.drives_json, updated_at=excluded.updated_at`),
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

/**
 * 엣지 · 중앙 직결 점검 결과를 적재한다(정제된 서버 결과 배열 — ingest.js 가 정제한다).
 * @returns {{servers:number, newRecords:Array<{agent:string, serverId:string, created:number, code:string, message:string, slotKey:string}>, baselineServers:number}}
 */
export async function ingestServers(agent, servers, { now = Date.now() } = {}) {
  const h = await open();
  if (!h) return { ok: false, reason: dbUnavailableReason(), servers: 0, newRecords: [], baselineServers: 0 };
  const a = String(agent || '').trim().toLowerCase();
  const newRecords = [];
  let baselineServers = 0;
  h.db.exec('BEGIN');
  try {
    for (const s of servers || []) {
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
      };
      if (s.ok && s.log) {
        const L = s.log;
        if (baseline) baselineServers += 1;
        row.first_ok_at = prev?.first_ok_at ?? now;
        row.last_ok_at = now;
        row.log_order = L.order || null;
        row.log_total = finite(L.total);
        if (L.reachedEnd) row.log_oldest = finite(L.oldestRead);
        row.covered_from = minOf(prev?.covered_from, L.oldestRead);
        row.continuous_since = nextContinuousSince(prev?.continuous_since, L);
        row.complete = (L.reachedEnd || L.foundCursor) ? 1 : 0;
        row.read_last = finite(L.read);
        for (const r of s.records || []) {
          if (!Number.isFinite(r.created)) continue;
          const code = codeOf(r.messageId) || String(r.code || '').toUpperCase().slice(0, 12);
          const key = `${r.entryId}|${r.created}`.slice(0, 96);
          const slotKey = slotKeyOf(slotOf(r.message));
          const ch = h.st.recInsert.run(a, s.id, key, r.created, code, r.messageId, r.severity, r.message, slotKey, now, baseline ? 1 : 0);
          if (ch.changes > 0 && !baseline) newRecords.push({ agent: a, serverId: s.id, serverName: row.name, created: r.created, code, message: r.message, slotKey });
        }
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
    }
    h.db.exec('COMMIT');
  } catch (e) {
    try { h.db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  _gen += 1;
  return { ok: true, servers: (servers || []).length, newRecords, baselineServers };
}

const rowServer = (r) => ({
  agent: r.agent, serverId: r.server_id, name: r.name || '', host: r.host || '', serviceTag: r.service_tag || '',
  firstOkAt: r.first_ok_at, lastScanAt: r.last_scan_at, lastOkAt: r.last_ok_at, lastStatus: r.last_status || '', lastReason: r.last_reason || '',
  logOrder: r.log_order, logTotal: r.log_total, logOldest: r.log_oldest, coveredFrom: r.covered_from, continuousSince: r.continuous_since,
  complete: r.complete == null ? null : r.complete === 1, readLast: r.read_last, synthesized: r.synthesized === 1, invAt: r.inv_at,
  drives: (() => { try { const j = JSON.parse(r.drives_json || 'null'); return Array.isArray(j) ? j : null; } catch { return null; } })(),
});
const rowRecord = (r) => ({
  agent: r.agent, serverId: r.server_id, entryKey: r.entry_key, created: r.created, code: r.code || '', messageId: r.message_id || '',
  severity: r.severity || '', message: r.message || '', slotKey: r.slot_key || '', receivedAt: r.received_at, baseline: r.baseline === 1,
});
const rowSerial = (r) => ({ agent: r.agent, serverId: r.server_id, slotKey: r.slot_key, serial: r.serial, model: r.model || '', firstSeen: r.first_seen, lastSeen: r.last_seen });

/** 화면 집계의 입력 전량(배드 섹터 계열만 쌓이므로 작다 — 그래도 상한을 둔다). */
export async function loadAll() {
  const h = await open();
  if (!h) return null;
  return {
    servers: h.st.serversAll.all().map(rowServer),
    records: h.st.recordsAll.all().map(rowRecord),
    serials: h.st.serialsAll.all().map(rowSerial),
  };
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
  return {
    available: !!h, path: h ? h.path : DB_PATH(), error: h ? '' : dbUnavailableReason(),
    records: h ? (h.st.count.get()?.n ?? null) : null, servers: h ? (h.st.countServers.get()?.n ?? null) : null,
  };
}

export function _resetDiskBadDbForTest() {
  try { x?.db?.close(); } catch { /* */ }
  x = null; ready = null; initError = null; _gen = 0;
}
