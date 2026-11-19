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

/**
 * v2.999(사용자 요청 2026-11-13 · 설계 docs/design/upgrade-reload): '이 창의 판(from)보다 새 판' 의 노트 — 업그레이드 뒤 열어 둔 창이
 * '프로그램이 업그레이드되었으니 새로고침 하세요' 상자에 '이번 업그레이드에서 바뀐 것' 을 보인다(웹 upgradeNotice.js · UpgradeNotice.jsx).
 * 전체 노트(1,200판 · 1.9MB)를 내려보내지 않으려고 따로 둔다.
 *  · from < version ≤ to(지금 돌고 있는 판) 만 · 최신 먼저 · 판 수 · 줄 수 · 줄 길이 상한(관리자 기록 노트도 오므로). 넘친 판 수는 truncated.
 *  · 버전 형식이 아닌 항목은 건너뛴다(관리자 기록은 '1.2.3-xyz' 처럼 들어올 수 있다 — saveNote 정규식이 접두만 본다).
 *  · ⚠ 옛 판 창이 새 서버에 부르는 계약이다 — 경로(/api/release-notes/since) · 응답 모양({ current, from, notes[{version,date,title,notes}], truncated })을 바꾸지 않는다.
 */
export const SINCE_LIMITS = Object.freeze({ maxVersions: 20, maxLinesPerVersion: 30, maxLineLen: 600, maxTitleLen: 200 });
const SINCE_VER_RE = /^(\d{1,4})\.(\d{1,5})\.(\d{1,6})$/;
export function parseSinceVersion(v) {
  if (typeof v !== 'string' || v.length > 32) return null;
  const s = v.trim();
  return SINCE_VER_RE.test(s) ? s : null;
}
function cmpVer(a, b) {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function notesSince(list, from, to, limits = SINCE_LIMITS) {
  const f = parseSinceVersion(from); const t = parseSinceVersion(to);
  if (!f || !t) return { notes: [], truncated: 0 };
  const hits = [];
  for (const n of Array.isArray(list) ? list : []) {
    const v = parseSinceVersion(typeof n?.version === 'string' ? n.version : '');
    if (!v || cmpVer(v, f) <= 0 || cmpVer(v, t) > 0) continue;
    hits.push({ n, v });
  }
  hits.sort((a, b) => cmpVer(b.v, a.v));
  const keep = hits.slice(0, limits.maxVersions);
  const notes = keep.map(({ n, v }) => ({
    version: v,
    date: typeof n.date === 'string' ? n.date.slice(0, 32) : '',
    title: clip(typeof n.title === 'string' ? n.title.trim() : '', limits.maxTitleLen),
    notes: (Array.isArray(n.notes) ? n.notes : [])
      .filter((x) => typeof x === 'string' && x.trim())
      .slice(0, limits.maxLinesPerVersion)
      .map((x) => clip(x.trim(), limits.maxLineLen)),
  }));
  return { notes, truncated: hits.length - keep.length };
}
