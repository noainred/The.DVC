/**
 * vCenter 이벤트 로그 장기 보관 DB. vCenter는 이벤트를 단기간만 보관하므로, 포탈이 주기적으로
 * 수집해 여기 누적한다. Node 내장 SQLite(--experimental-sqlite) 우선, 없으면 NDJSON 폴백.
 * 중복은 (vcenterId, key)로 제거. 보관기간 초과분은 poller가 prune한다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { loadLogSettings } from './settings.js';

// 저장 위치: 설정의 storagePath(빈값=CONFIG_DIR). 각 포탈이 자기 데이터만 로컬 보관.
function dbPath() {
  const s = loadLogSettings();
  const dir = s.storagePath && s.storagePath.trim() ? s.storagePath.trim() : config.configDir;
  return path.join(dir, 'vcenter-logs.db');
}

let impl = null;
let ready = null;

function initSqlite() {
  const DB_PATH = dbPath();
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        vcenterId TEXT NOT NULL, k TEXT, ts INTEGER NOT NULL,
        severity TEXT, type TEXT, user TEXT, entity TEXT, message TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uniq ON events (vcenterId, k);
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events (vcenterId, ts);
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* */ }
    const ins = db.prepare('INSERT OR IGNORE INTO events (vcenterId,k,ts,severity,type,user,entity,message) VALUES (?,?,?,?,?,?,?,?)');
    const lastTsStmt = db.prepare('SELECT MAX(ts) mx FROM events WHERE vcenterId=?');
    const prune = db.prepare('DELETE FROM events WHERE ts < ?');
    const metaStmt = db.prepare('SELECT COUNT(*) n, MIN(ts) mn, MAX(ts) mx FROM events');
    const vcStmt = db.prepare('SELECT vcenterId, COUNT(*) n, MAX(ts) mx FROM events GROUP BY vcenterId');
    const build = (where, params) => ({ where, params });
    function filterSql(f) {
      const w = []; const p = [];
      if (f.vcenterId) { w.push('vcenterId=?'); p.push(f.vcenterId); }
      if (f.severity) { w.push('severity=?'); p.push(f.severity); }
      if (f.since) { w.push('ts>=?'); p.push(f.since); }
      if (f.until) { w.push('ts<=?'); p.push(f.until); }
      if (f.q) { w.push('(message LIKE ? OR entity LIKE ? OR user LIKE ? OR type LIKE ?)'); const like = `%${f.q}%`; p.push(like, like, like, like); }
      return build(w.length ? `WHERE ${w.join(' AND ')}` : '', p);
    }
    return {
      kind: 'sqlite',
      insertMany: (rows) => { db.exec('BEGIN'); try { for (const r of rows) ins.run(r.vcenterId, r.key || `${r.ts}:${(r.message || '').slice(0, 40)}`, r.ts, r.severity, r.type, r.user, r.entity, r.message); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* */ } throw e; } },
      lastTs: (vc) => Number(lastTsStmt.get(vc)?.mx || 0),
      query: (f = {}, limit = 200, offset = 0) => { const { where, params } = filterSql(f); return db.prepare(`SELECT vcenterId,ts,severity,type,user,entity,message FROM events ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(...params, limit, offset); },
      count: (f = {}) => { const { where, params } = filterSql(f); return Number(db.prepare(`SELECT COUNT(*) n FROM events ${where}`).get(...params)?.n || 0); },
      meta: () => { const r = metaStmt.get(); const vcs = vcStmt.all().map((x) => ({ vcenterId: x.vcenterId, count: Number(x.n), lastTs: Number(x.mx) })); return { count: Number(r?.n || 0), firstTs: r?.mn || null, lastTs: r?.mx || null, vcenters: vcs }; },
      prune: (beforeTs) => { const r = prune.run(beforeTs); return Number(r?.changes || 0); },
      sizeBytes: () => { try { return fs.statSync(DB_PATH).size; } catch { return 0; } },
      pruneOldest: (n) => { const r = db.prepare('DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY ts ASC LIMIT ?)').run(Math.max(1, n)); return Number(r?.changes || 0); },
      vacuum: () => { try { db.exec('VACUUM'); } catch { /* */ } },
      path: DB_PATH,
      close: () => { try { db.close(); } catch { /* */ } },
    };
  });
}

function initJson() {
  const file = dbPath().replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let rows = [];
  const seen = new Set();
  try { for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (l.trim()) { const r = JSON.parse(l); rows.push(r); seen.add(`${r.vcenterId}|${r.k}`); } } } catch { /* */ }
  const match = (r, f) => (!f.vcenterId || r.vcenterId === f.vcenterId) && (!f.severity || r.severity === f.severity)
    && (!f.since || r.ts >= f.since) && (!f.until || r.ts <= f.until)
    && (!f.q || `${r.message} ${r.entity} ${r.user} ${r.type}`.toLowerCase().includes(String(f.q).toLowerCase()));
  return {
    kind: 'json',
    insertMany: (recs) => {
      const fresh = [];
      for (const r of recs) { const k = r.key || `${r.ts}:${(r.message || '').slice(0, 40)}`; const id = `${r.vcenterId}|${k}`; if (seen.has(id)) continue; seen.add(id); const row = { vcenterId: r.vcenterId, k, ts: r.ts, severity: r.severity, type: r.type, user: r.user, entity: r.entity, message: r.message }; rows.push(row); fresh.push(row); }
      if (fresh.length) try { fs.appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ }
    },
    lastTs: (vc) => rows.reduce((mx, r) => (r.vcenterId === vc && r.ts > mx ? r.ts : mx), 0),
    query: (f = {}, limit = 200, offset = 0) => rows.filter((r) => match(r, f)).sort((a, b) => b.ts - a.ts).slice(offset, offset + limit),
    count: (f = {}) => rows.filter((r) => match(r, f)).length,
    meta: () => { const vc = new Map(); let mn = null, mx = null; for (const r of rows) { if (mn == null || r.ts < mn) mn = r.ts; if (mx == null || r.ts > mx) mx = r.ts; const g = vc.get(r.vcenterId) || { vcenterId: r.vcenterId, count: 0, lastTs: 0 }; g.count++; g.lastTs = Math.max(g.lastTs, r.ts); vc.set(r.vcenterId, g); } return { count: rows.length, firstTs: mn, lastTs: mx, vcenters: [...vc.values()] }; },
    prune: (beforeTs) => { const before = rows.length; rows = rows.filter((r) => r.ts >= beforeTs); const removed = before - rows.length; if (removed) rewrite(); return removed; },
    sizeBytes: () => { try { return fs.statSync(file).size; } catch { return 0; } },
    pruneOldest: (n) => { const sorted = [...rows].sort((a, b) => a.ts - b.ts); const cut = new Set(sorted.slice(0, Math.max(1, n))); const before = rows.length; rows = rows.filter((r) => !cut.has(r)); const removed = before - rows.length; if (removed) rewrite(); return removed; },
    vacuum: () => {},
    path: file,
    close: () => {},
  };
  function rewrite() { try { fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 }); } catch { /* */ } }
}

export async function getLogsDb() {
  if (impl) return impl;
  if (!ready) ready = initSqlite().catch((err) => { console.warn(`[vclogs] node:sqlite 불가(${err.code || err.message}); NDJSON 폴백.`); return initJson(); });
  impl = await ready;
  return impl;
}

/** 저장 경로 변경 시 DB 핸들을 닫고 다음 getLogsDb()에서 새 경로로 재오픈. */
export function resetLogsDb() {
  try { impl?.close?.(); } catch { /* */ }
  impl = null; ready = null;
}
