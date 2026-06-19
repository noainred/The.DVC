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
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ assignments: list }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* best effort */ }
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

// ---- results --------------------------------------------------------------

let results = {};
try { if (fs.existsSync(RESULT_FILE)) results = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8')) || {}; } catch { results = {}; }

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
