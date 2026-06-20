/**
 * Shareable IP ledger store — a standalone SQLite DB so OTHER programs can read
 * the current IP inventory (table `ip_records`). Mirrors the iDRAC store: uses
 * Node's built-in node:sqlite (no external deps; needs --experimental-sqlite),
 * with an NDJSON fallback when the module is unavailable.
 *
 * The whole ledger is replaced on every snapshot refresh (it is a current-state
 * inventory, not time-series), so external consumers always see a consistent set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const DB_PATH = config.ipam.dbPath;

let impl = null;
let ready = null;

const COLUMNS = ['ip', 'ip_num', 'vcenter_id', 'vcenter_name', 'owner_type', 'owner_name',
  'power_state', 'guest_os', 'host_name', 'cluster', 'multi_homed', 'duplicate', 'updated_at'];

function toRecord(r, updatedAt) {
  return [r.ip, r.ipNum ?? null, r.vcenterId, r.vcenterName, r.ownerType, r.ownerName,
    r.powerState || '', r.guestOS || '', r.hostName || '', r.cluster || '',
    r.multiHomed ? 1 : 0, r.duplicate ? 1 : 0, updatedAt];
}

function initSqlite() {
  // eslint-disable-next-line import/no-unresolved
  return import('node:sqlite').then(({ DatabaseSync }) => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const db = new DatabaseSync(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ip_records (
        ip TEXT NOT NULL,
        ip_num INTEGER,
        vcenter_id TEXT NOT NULL,
        vcenter_name TEXT,
        owner_type TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        power_state TEXT,
        guest_os TEXT,
        host_name TEXT,
        cluster TEXT,
        multi_homed INTEGER DEFAULT 0,
        duplicate INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ip_records_ip ON ip_records (ip);
      CREATE INDEX IF NOT EXISTS idx_ip_records_vc ON ip_records (vcenter_id);
    `);
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const del = db.prepare('DELETE FROM ip_records');
    const ins = db.prepare(`INSERT INTO ip_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    const countStmt = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ip_records');
    return {
      kind: 'sqlite',
      sync: (rows, updatedAt) => {
        del.run();
        for (const r of rows) ins.run(...toRecord(r, updatedAt));
      },
      info: () => { const r = countStmt.get(); return { count: r?.n || 0, updatedAt: r?.at || null }; },
    };
  });
}

function initJsonFallback() {
  const file = DB_PATH.replace(/\.db$/, '') + '.ndjson';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    kind: 'ndjson',
    sync: (rows, updatedAt) => {
      const lines = rows.map((r) => JSON.stringify(Object.fromEntries(COLUMNS.map((c, i) => [c, toRecord(r, updatedAt)[i]]))));
      fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    },
    info: () => {
      try {
        const txt = fs.readFileSync(file, 'utf8').trim();
        const n = txt ? txt.split('\n').length : 0;
        let at = null;
        if (n) { try { at = JSON.parse(txt.split('\n')[0]).updated_at; } catch { /* ignore */ } }
        return { count: n, updatedAt: at };
      } catch { return { count: 0, updatedAt: null }; }
    },
  };
}

async function getImpl() {
  if (impl) return impl;
  if (!ready) {
    ready = initSqlite().catch((err) => {
      console.warn(`[ipam] node:sqlite 사용 불가(${err.code || err.message}); NDJSON 폴백 사용.`);
      return initJsonFallback();
    });
  }
  impl = await ready;
  return impl;
}

/** Replace the entire shared ledger with the given rows. Best-effort. */
export async function syncLedger(rows) {
  try {
    const i = await getImpl();
    i.sync(rows, new Date().toISOString());
  } catch (err) {
    console.warn(`[ipam] 레저 저장 실패: ${err.message}`);
  }
}

/** DB location + record count, for the admin UI. */
export async function ledgerInfo() {
  const i = await getImpl();
  return { path: i.kind === 'sqlite' ? DB_PATH : DB_PATH.replace(/\.db$/, '') + '.ndjson', kind: i.kind, ...i.info() };
}
