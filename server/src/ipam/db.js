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

const COLUMNS = ['ip', 'ip_num', 'vcenter_id', 'vcenter_name', 'owner_type', 'server_type', 'owner_name',
  'power_state', 'guest_os', 'os_name', 'os_version', 'host_name', 'cluster', 'scope', 'multi_homed', 'duplicate', 'updated_at',
  // 출처 대조 + 수동 관리(override) + 대역정책 노출 — 외부 프로그램이 vCenter/스캔/수동/정책을 구분하고 관리상태를 읽을 수 있게.
  'discovery', 'reconcile', 'mgmt_status', 'mgmt_owner', 'label', 'device_type', 'first_seen', 'last_seen', 'usage_status',
  'applied_by', 'range_policy_spec'];

function toRecord(r, updatedAt) {
  return [r.ip, r.ipNum ?? null, r.vcenterId, r.vcenterName, r.ownerType, r.serverType || (r.ownerType === 'host' ? 'BareMetal' : 'VM'), r.ownerName,
    r.powerState || '', r.guestOS || '', r.osName || '', r.osVersion || '', r.hostName || '', r.cluster || '', r.scope || '',
    r.multiHomed ? 1 : 0, r.duplicate ? 1 : 0, updatedAt,
    r.discovery || '', r.reconcile || '', r.mgmtStatus || '', r.owner_ || '', r.label || '', r.deviceType || '',
    r.firstSeen ? new Date(r.firstSeen).toISOString() : '', r.lastSeen ? new Date(r.lastSeen).toISOString() : '', r.usageStatus || '',
    r.appliedBy || '', r.rangePolicySpec || ''];
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
        server_type TEXT,
        owner_name TEXT NOT NULL,
        power_state TEXT,
        guest_os TEXT,
        os_name TEXT,
        os_version TEXT,
        host_name TEXT,
        cluster TEXT,
        scope TEXT,
        multi_homed INTEGER DEFAULT 0,
        duplicate INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ip_records_ip ON ip_records (ip);
      CREATE INDEX IF NOT EXISTS idx_ip_records_vc ON ip_records (vcenter_id);
    `);
    // Migrate older DBs that predate newer columns (best-effort; ignore if present).
    try { db.exec('ALTER TABLE ip_records ADD COLUMN scope TEXT'); } catch { /* already present */ }
    try { db.exec('ALTER TABLE ip_records ADD COLUMN server_type TEXT'); } catch { /* already present */ }
    try { db.exec('ALTER TABLE ip_records ADD COLUMN os_name TEXT'); } catch { /* already present */ }
    try { db.exec('ALTER TABLE ip_records ADD COLUMN os_version TEXT'); } catch { /* already present */ }
    for (const col of ['discovery', 'reconcile', 'mgmt_status', 'mgmt_owner', 'label', 'device_type', 'first_seen', 'last_seen', 'usage_status', 'applied_by', 'range_policy_spec']) {
      try { db.exec(`ALTER TABLE ip_records ADD COLUMN ${col} TEXT`); } catch { /* already present */ }
    }
    try { fs.chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }
    const del = db.prepare('DELETE FROM ip_records');
    const ins = db.prepare(`INSERT INTO ip_records (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
    const countStmt = db.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ip_records');
    return {
      kind: 'sqlite',
      // One transaction → a single commit/fsync for the whole snapshot, instead
      // of thousands of auto-committed inserts that would block the event loop.
      sync: (rows, updatedAt) => {
        db.exec('BEGIN IMMEDIATE');
        try {
          del.run();
          for (const r of rows) ins.run(...toRecord(r, updatedAt));
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch { /* ignore */ }
          throw err;
        }
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

/** Replace the entire shared ledger with the given rows. Best-effort. 성공 여부를 반환한다. */
export async function syncLedger(rows) {
  try {
    const i = await getImpl();
    i.sync(rows, new Date().toISOString());
    return true;
  } catch (err) {
    console.warn(`[ipam] 레저 저장 실패: ${err.message}`);
    return false;
  }
}

/** DB location + record count, for the admin UI. */
export async function ledgerInfo() {
  const i = await getImpl();
  return { path: i.kind === 'sqlite' ? DB_PATH : DB_PATH.replace(/\.db$/, '') + '.ndjson', kind: i.kind, ...i.info() };
}
