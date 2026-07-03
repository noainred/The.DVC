/**
 * Central store for per-agent scan assignments and the results agents report
 * back. Assignments map an agent NAME to an IP range + iDRAC credentials; each
 * agent pulls its own assignment, scans locally, and posts results here.
 *
 * Stored in CONFIG_DIR/agent-assignments.json (0600; holds credentials) and
 * CONFIG_DIR/agent-results.json (0600; scan summaries).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { parseCsvRows } from '../util/csv.js';

const FILE = path.join(config.configDir, 'agent-assignments.json');
const RESULT_FILE = path.join(config.configDir, 'agent-results.json');

// ---- assignments ----------------------------------------------------------

export function loadAssignments() {
  if (!fs.existsSync(FILE)) return [];
  try {
    const p = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(p?.assignments) ? p.assignments : [];
  } catch { return []; }
}

function save(list) {
  atomicWriteFileSync(FILE, JSON.stringify({ assignments: list }, null, 2), { mode: 0o600 });
}

export function redact(a) {
  const { password, ...rest } = a;
  return { ...rest, hasPassword: Boolean(password) };
}

export function listAssignments() {
  return loadAssignments().map(redact);
}

/** Full assignment (incl. password) for one agent name — used by the agent API. */
export function getAssignment(agentName) {
  const key = String(agentName || '').trim().toLowerCase();
  return loadAssignments().find((a) => String(a.agent).trim().toLowerCase() === key) || null;
}

function normalize(body, existing = null) {
  const e = existing ? { ...existing } : {};
  const agent = String(body.agent ?? e.agent ?? '').trim();
  const ips = String(body.ips ?? e.ips ?? '').trim();
  const username = String(body.username ?? e.username ?? '').trim();
  if (!agent) return [null, '에이전트 이름(agent)은 필수입니다.'];
  if (!ips) return [null, 'IP 대역(ips)은 필수입니다.'];
  if (!username) return [null, 'iDRAC 계정(username)은 필수입니다.'];
  return [{
    agent, ips, username,
    password: body.password ? String(body.password) : e.password || '',
    enabled: body.enabled != null ? Boolean(body.enabled) : (e.enabled != null ? e.enabled : true),
  }, null];
}

export function addAssignment(body) {
  const list = loadAssignments();
  const [entry, err] = normalize(body);
  if (err) return { ok: false, reason: err };
  if (list.some((a) => a.agent.toLowerCase() === entry.agent.toLowerCase())) return { ok: false, reason: `이미 존재하는 에이전트: ${entry.agent}` };
  list.push(entry); save(list);
  return { ok: true, assignment: redact(entry) };
}

export function updateAssignment(agent, body) {
  const list = loadAssignments();
  const idx = list.findIndex((a) => a.agent.toLowerCase() === String(agent).toLowerCase());
  if (idx === -1) return { ok: false, reason: `없는 에이전트: ${agent}` };
  const [entry, err] = normalize({ ...body, agent: list[idx].agent }, list[idx]);
  if (err) return { ok: false, reason: err };
  list[idx] = entry; save(list);
  return { ok: true, assignment: redact(entry) };
}

export function removeAssignment(agent) {
  const list = loadAssignments();
  const next = list.filter((a) => a.agent.toLowerCase() !== String(agent).toLowerCase());
  if (next.length === list.length) return { ok: false, reason: `없는 에이전트: ${agent}` };
  save(next);
  return { ok: true };
}

/**
 * Parse an assignments CSV. Columns: agent, ips, username, password, enabled.
 * The ips cell may hold several ranges separated by ';' or '|' (commas are the
 * CSV delimiter). A header row is optional. Lines starting with '#' are skipped.
 */
export function parseCsv(text) {
  // RFC4180 파서로 통일 — 위임 스캔용 iDRAC 비밀번호에 쉼표/따옴표/줄바꿈이 있어도 온전히 보존한다
  // (idrac/registry.js와 동일). 이전 line.split(',')는 p@ss,w0rd 같은 비번을 잘라 위임 스캔이 전부
  // 인증 실패(401)했다. 주석(#)으로 시작하는 레코드는 건너뛴다.
  const rows = parseCsvRows(text).filter((r) => !String(r[0] ?? '').trim().startsWith('#'));
  if (!rows.length) return [];
  const headerCells = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = headerCells.includes('agent') && headerCells.includes('ips');
  const cols = hasHeader ? headerCells : ['agent', 'ips', 'username', 'password', 'enabled'];
  const out = [];
  for (const cells of rows.slice(hasHeader ? 1 : 0)) {
    const row = {};
    // 비밀번호는 앞뒤 공백이 유의미할 수 있어 trim하지 않는다(다른 필드만 trim).
    cols.forEach((c, i) => { const v = cells[i] ?? ''; row[c] = c === 'password' ? v : v.trim(); });
    if (!row.agent) continue;
    out.push({
      agent: row.agent,
      ips: (row.ips || '').split(/[;|]/).map((s) => s.trim()).filter(Boolean).join('\n'),
      username: row.username || 'root',
      password: row.password || '',
      enabled: !/^(0|false|no|off|중지|disabled)$/i.test((row.enabled || 'true').trim()),
    });
  }
  return out;
}

/**
 * Import assignments. mode 'merge' (default) upserts by agent name; 'replace'
 * swaps the whole list. Returns { ok, mode, added, updated, skipped[], total }.
 */
export function importAssignments(incoming, mode = 'merge') {
  if (!Array.isArray(incoming)) return { ok: false, reason: 'assignments 배열을 찾을 수 없습니다.' };
  const existing = loadAssignments();
  const result = mode === 'replace' ? [] : [...existing];
  let added = 0, updated = 0;
  const skipped = [];
  for (const raw of incoming) {
    const base = mode === 'replace' ? null : existing.find((a) => a.agent.toLowerCase() === String(raw?.agent || '').toLowerCase());
    const [entry, err] = normalize(raw || {}, base);
    if (err) { skipped.push({ agent: raw?.agent || '(이름없음)', reason: err }); continue; }
    const idx = result.findIndex((a) => a.agent.toLowerCase() === entry.agent.toLowerCase());
    if (idx >= 0) { result[idx] = entry; updated++; } else { result.push(entry); added++; }
  }
  // 안전장치: 'replace'인데 유효 항목이 0건이면 전체 삭제 금지(빈/무효 CSV로 스캔 할당 소실 방지).
  if (mode === 'replace' && result.length === 0) {
    return { ok: false, mode, added: 0, updated: 0, skipped, total: existing.length, reason: '가져올 유효한 할당이 없어 전체 교체를 취소했습니다(기존 유지).' };
  }
  save(result);
  return { ok: true, mode, added, updated, skipped, total: result.length };
}

// ---- results --------------------------------------------------------------

// Object.create(null): 에이전트가 보낸 이름이 '__proto__' 등 프로토타입 키여도 오염되지 않게
// (inventory.js/fleet.js와 동일한 방어 — 일반 {}는 results['__proto__'] 대입이 조용히 유실된다).
let results = Object.create(null);
try { if (fs.existsSync(RESULT_FILE)) results = Object.assign(Object.create(null), JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')) || {}); } catch { results = Object.create(null); }

let persistTimer = null;
function persistResults() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
      fs.writeFileSync(RESULT_FILE, JSON.stringify(results), { mode: 0o600 });
    } catch { /* best effort */ }
  }, 3_000);
  persistTimer.unref?.();
}

export function setResult(agent, data) {
  results[String(agent)] = { at: Date.now(), ...data };
  persistResults();
}

export function getResults() {
  return results;
}
