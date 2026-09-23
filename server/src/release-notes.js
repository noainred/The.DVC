/**
 * Release notes: a built-in changelog (server/src/release-notes.json, shipped
 * with each build) merged with admin-recorded entries (CONFIG_DIR/release-notes.json),
 * so operators can log their own changes that survive upgrades.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { atomicWriteFileSync, preserveCorrupt } from './util/atomicWrite.js';
import { todayStamp } from './util/dayKey.js';

const BUILTIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-notes.json');
const USER_FILE = path.join(config.configDir, 'release-notes.json');

function readJson(file) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))?.notes || []; } catch (e) { if (file === USER_FILE) preserveCorrupt(file, e.message); } // v2.479(감사 B-18): 사용자 노트 손상 시 보존
  return [];
}

// Compare semver-ish "a.b.c" descending.
function cmpVersionDesc(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
  return 0;
}

/**
 * Merged, de-duplicated (user entry wins per version), newest first.
 * v2.593(감사 PERF-2): 내장 파일이 1.9MB 라 호출마다 동기 읽기·파싱에 29~48ms 였다. 두 파일의 mtime·크기가 그대로면
 * 직전 결과를 돌려준다(파일이 바뀌면 — 업그레이드·관리자 노트 저장 — 다음 호출에서 다시 읽는다).
 */
let _notesCache = null; // { key, list }
const statKey = (f) => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch { return '-'; } };
export function listNotes() {
  const key = `${statKey(BUILTIN)}|${statKey(USER_FILE)}`;
  if (_notesCache && _notesCache.key === key) return _notesCache.list.slice();
  const list = buildNotes();
  _notesCache = { key, list };
  return list.slice();
}
function buildNotes() {
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
    date: date || todayStamp(),
    title: title || '',
    notes: Array.isArray(notes) ? notes.filter(Boolean) : String(notes || '').split('\n').map((s) => s.trim()).filter(Boolean),
  });
  fs.mkdirSync(path.dirname(USER_FILE), { recursive: true });
  atomicWriteFileSync(USER_FILE, JSON.stringify({ notes: list }, null, 2), { mode: 0o600 });
  _notesCache = null; // 같은 ms·같은 크기 저장도 놓치지 않게
  return { ok: true };
}

/** Delete a user-recorded note (built-in notes can't be deleted). */
export function deleteNote(version) {
  const list = readJson(USER_FILE);
  const next = list.filter((n) => n.version !== version);
  if (next.length === list.length) return { ok: false, reason: '사용자 기록 노트가 아니거나 없습니다.' };
  atomicWriteFileSync(USER_FILE, JSON.stringify({ notes: next }, null, 2), { mode: 0o600 });
  _notesCache = null;
  return { ok: true };
}
