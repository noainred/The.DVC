/**
 * Release notes: a built-in changelog (server/src/release-notes.json, shipped
 * with each build) merged with admin-recorded entries (CONFIG_DIR/release-notes.json),
 * so operators can log their own changes that survive upgrades.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-notes.json');
const USER_FILE = path.join(config.configDir, 'release-notes.json');

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))?.notes || []; } catch { /* ignore */ }
  return [];
}

// Compare semver-ish "a.b.c" descending.
function cmpVersionDesc(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
  return 0;
}

/** Merged, de-duplicated (user entry wins per version), newest first. */
export function listNotes() {
  const byVersion = new Map();
  for (const n of readJson(BUILTIN)) byVersion.set(n.version, { ...n, source: 'builtin' });
  for (const n of readJson(USER_FILE)) byVersion.set(n.version, { ...n, source: 'user' });
  return [...byVersion.values()].sort((a, b) => cmpVersionDesc(a.version, b.version));
}

/** Add or update a user-recorded note (admin). */
export function saveNote({ version, date, title, notes } = {}) {
  version = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) return { ok: false, reason: '버전 형식이 올바르지 않습니다. (예: 1.17.1)' };
  const list = readJson(USER_FILE).filter((n) => n.version !== version);
  list.push({
    version,
    date: date || new Date().toISOString().slice(0, 10),
    title: title || '',
    notes: Array.isArray(notes) ? notes.filter(Boolean) : String(notes || '').split('\n').map((s) => s.trim()).filter(Boolean),
  });
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  fs.writeFileSync(USER_FILE, JSON.stringify({ notes: list }, null, 2), { mode: 0o600 });
  return { ok: true };
}

/** Delete a user-recorded note (built-in notes can't be deleted). */
export function deleteNote(version) {
  const list = readJson(USER_FILE);
  const next = list.filter((n) => n.version !== version);
  if (next.length === list.length) return { ok: false, reason: '사용자 기록 노트가 아니거나 없습니다.' };
  fs.writeFileSync(USER_FILE, JSON.stringify({ notes: next }, null, 2), { mode: 0o600 });
  return { ok: true };
}
