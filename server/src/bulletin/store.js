/**
 * bulletin/store.js — 접속 공지(팝업)와 게시판 글 저장소(v2.722).
 *
 * 두 파일로 나눈다 — `notices.json`(관리자가 쓰는 공지 · 로그인 뒤 팝업으로 보인다) ·
 * `board.json`(로그인 사용자가 쓰는 게시판 글 · 댓글). 둘 다 사용자가 손으로 쓴 값이라
 * 원자적 쓰기 + 손상 보존(손상본을 빈 목록으로 덮어쓰지 않는다 — v2.580 ping/store.js 와 같은 규칙).
 *
 * 상한(조용히 버리지 않는다 — 넘으면 저장을 거부하고 사유를 돌려준다):
 *   공지 200개 · 제목 200자 · 본문 5,000자
 *   글 2,000개 · 제목 200자 · 본문 10,000자 · 글당 댓글 300개 · 댓글 2,000자
 * 시각은 epoch ms 숫자 하나다. 문자열 값은 `capStr` 로 평탄화해 원문(SlicedString)을 붙잡지 않는다.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';

export const LIMITS = Object.freeze({
  noticeMax: 200, noticeTitle: 200, noticeBody: 5000,
  postMax: 2000, postTitle: 200, postBody: 10000, commentMax: 300, commentBody: 2000,
});
export const NOTICE_LEVELS = Object.freeze(['info', 'warn', 'crit']);

const noticesFile = () => path.join(config.configDir, 'notices.json');
const boardFile = () => path.join(config.configDir, 'board.json');

const caches = new Map(); // file → { list }

function load(file, key) {
  const hit = caches.get(file);
  if (hit) return hit.list;
  let list = [];
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j[key])) throw new Error(`${key} 배열이 없습니다`);
      list = j[key].filter((x) => x && typeof x === 'object' && typeof x.id === 'string');
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[bulletin] ${path.basename(file)} 를 읽지 못해 빈 목록으로 시작합니다: ${e.message}`);
    list = [];
  }
  caches.set(file, { list });
  return list;
}

function save(file, key, list) {
  atomicWriteFileSync(file, JSON.stringify({ [key]: list }, null, 1), { mode: 0o600 });
  caches.set(file, { list });
}

/** 테스트 전용 — 캐시를 비운다(CONFIG_DIR 를 바꾼 뒤 다시 읽게). */
export function _resetBulletinCache() { caches.clear(); }

const newId = () => crypto.randomBytes(8).toString('hex');
/** 문자열 칸: 앞뒤 공백 제거 · 제어 문자(줄바꿈·탭 제외) 제거 · 상한 초과는 오류. */
function text(v, max, field, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !s) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max}자를 넘습니다(${s.length}자)`);
  return capStr(s, max);
}
function fieldError(field, msg) {
  const e = new Error(`${field}: ${msg}`);
  e.status = 400; e.field = field;
  return e;
}
function limitError(msg) { const e = new Error(msg); e.status = 409; return e; }
function notFound() { const e = new Error('없는 항목입니다'); e.status = 404; return e; }
function forbidden(msg) { const e = new Error(msg); e.status = 403; return e; }

/* ───────────────────────── 공지 ───────────────────────── */

/** 노출 시각: 빈 값 = 제한 없음(null). 숫자 또는 날짜 문자열을 받는다. 못 읽으면 오류. */
function timeField(v, field) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v)));
  if (!Number.isFinite(n) || n <= 0) throw fieldError(field, '시각을 읽지 못했습니다');
  return n;
}

function cleanNotice(body, prev = {}) {
  const level = body.level == null ? (prev.level || 'info') : String(body.level);
  if (!NOTICE_LEVELS.includes(level)) throw fieldError('level', `${NOTICE_LEVELS.join('·')} 중 하나여야 합니다`);
  const startAt = Object.hasOwn(body, 'startAt') ? timeField(body.startAt, 'startAt') : (prev.startAt ?? null);
  const endAt = Object.hasOwn(body, 'endAt') ? timeField(body.endAt, 'endAt') : (prev.endAt ?? null);
  if (startAt != null && endAt != null && endAt <= startAt) throw fieldError('endAt', '종료 시각이 시작 시각보다 앞입니다');
  return {
    title: text(Object.hasOwn(body, 'title') ? body.title : prev.title, LIMITS.noticeTitle, 'title', { required: true }),
    body: text(Object.hasOwn(body, 'body') ? body.body : prev.body, LIMITS.noticeBody, 'body'),
    level,
    enabled: Object.hasOwn(body, 'enabled') ? body.enabled !== false : (prev.enabled ?? true),
    startAt, endAt,
  };
}

const sortNotices = (a) => [...a].sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));

export function listNotices() { return sortNotices(load(noticesFile(), 'notices')); }

/**
 * 지금 보여 줄 공지 — 켜져 있고 노출 기간 안. 심각도(crit → warn → info) 다음 최신순.
 * `rev` 는 화면의 '다시 보지 않기' 키에 쓴다 — 내용을 고치면 다시 보인다.
 */
export function activeNotices(now = Date.now()) {
  const rank = { crit: 0, warn: 1, info: 2 };
  return load(noticesFile(), 'notices')
    .filter((n) => n.enabled !== false && (n.startAt == null || n.startAt <= now) && (n.endAt == null || n.endAt > now))
    .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3) || (b.updatedAt || 0) - (a.updatedAt || 0))
    .map((n) => ({ id: n.id, rev: `${n.id}:${n.updatedAt || 0}`, title: n.title, body: n.body, level: n.level, startAt: n.startAt ?? null, endAt: n.endAt ?? null, updatedAt: n.updatedAt || null, by: n.updatedBy || n.createdBy || '' }));
}

export function createNotice(body, user) {
  const list = load(noticesFile(), 'notices');
  if (list.length >= LIMITS.noticeMax) throw limitError(`공지는 ${LIMITS.noticeMax}개까지입니다 — 지난 공지를 지운 뒤 다시 하세요`);
  const now = Date.now();
  const n = { id: newId(), ...cleanNotice(body || {}), createdAt: now, createdBy: user, updatedAt: now, updatedBy: user };
  save(noticesFile(), 'notices', [...list, n]);
  return n;
}

export function updateNotice(id, body, user) {
  const list = load(noticesFile(), 'notices');
  const i = list.findIndex((n) => n.id === id);
  if (i < 0) throw notFound();
  const n = { ...list[i], ...cleanNotice(body || {}, list[i]), updatedAt: Math.max(Date.now(), (list[i].updatedAt || 0) + 1), updatedBy: user };
  const next = [...list]; next[i] = n;
  save(noticesFile(), 'notices', next);
  return n;
}

export function deleteNotice(id) {
  const list = load(noticesFile(), 'notices');
  const n = list.find((x) => x.id === id);
  if (!n) throw notFound();
  save(noticesFile(), 'notices', list.filter((x) => x.id !== id));
  return n;
}

/* ───────────────────────── 게시판 ───────────────────────── */

const summary = (p) => ({
  id: p.id, title: p.title, author: p.author, pinned: !!p.pinned,
  createdAt: p.createdAt, updatedAt: p.updatedAt || p.createdAt,
  comments: Array.isArray(p.comments) ? p.comments.length : 0,
  lastActivityAt: Math.max(p.updatedAt || 0, p.createdAt || 0, ...(Array.isArray(p.comments) ? p.comments.map((c) => c.createdAt || 0) : [])),
});

/**
 * 글 목록 — 고정 글 먼저, 다음 최근 활동(글·댓글) 순. 검색어는 제목·본문·작성자(대소문자 무시).
 * 페이지 인자는 호출부가 pageArgs 로 좁혀 넘긴다.
 */
export function listPosts({ q = '', offset = 0, limit = 50 } = {}) {
  const needle = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '';
  const all = load(boardFile(), 'posts');
  const hit = needle
    ? all.filter((p) => `${p.title}\n${p.body}\n${p.author}`.toLowerCase().includes(needle))
    : all;
  const rows = hit.map(summary).sort((a, b) => (b.pinned - a.pinned) || (b.lastActivityAt - a.lastActivityAt));
  return { total: rows.length, all: all.length, offset, limit, rows: rows.slice(offset, offset + limit) };
}

export function getPost(id) {
  const p = load(boardFile(), 'posts').find((x) => x.id === id);
  if (!p) throw notFound();
  return { ...p, comments: Array.isArray(p.comments) ? p.comments : [] };
}

/** 수정·삭제 권한: 작성자 본인 또는 관리자. */
const canModify = (item, user, isAdmin) => isAdmin || (!!user && item.author === user);

export function createPost(body, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  if (list.length >= LIMITS.postMax) throw limitError(`게시글은 ${LIMITS.postMax}개까지입니다 — 관리자에게 정리를 요청하세요`);
  const now = Date.now();
  const p = {
    id: newId(),
    title: text(body?.title, LIMITS.postTitle, 'title', { required: true }),
    body: text(body?.body, LIMITS.postBody, 'body', { required: true }),
    pinned: isAdmin && body?.pinned === true,
    author: user, createdAt: now, updatedAt: now, comments: [],
  };
  save(boardFile(), 'posts', [...list, p]);
  return p;
}

export function updatePost(id, body, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw notFound();
  const cur = list[i];
  const editsContent = Object.hasOwn(body || {}, 'title') || Object.hasOwn(body || {}, 'body');
  if (editsContent && !canModify(cur, user, isAdmin)) throw forbidden('작성자 본인이나 관리자만 고칠 수 있습니다');
  if (Object.hasOwn(body || {}, 'pinned') && !isAdmin) throw forbidden('상단 고정은 관리자만 바꿀 수 있습니다');
  const p = {
    ...cur,
    title: Object.hasOwn(body, 'title') ? text(body.title, LIMITS.postTitle, 'title', { required: true }) : cur.title,
    body: Object.hasOwn(body, 'body') ? text(body.body, LIMITS.postBody, 'body', { required: true }) : cur.body,
    pinned: Object.hasOwn(body, 'pinned') ? body.pinned === true : !!cur.pinned,
    updatedAt: editsContent ? Math.max(Date.now(), (cur.updatedAt || 0) + 1) : cur.updatedAt,
    ...(editsContent ? { editedBy: user } : {}),
  };
  const next = [...list]; next[i] = p;
  save(boardFile(), 'posts', next);
  return p;
}

export function deletePost(id, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  const p = list.find((x) => x.id === id);
  if (!p) throw notFound();
  if (!canModify(p, user, isAdmin)) throw forbidden('작성자 본인이나 관리자만 지울 수 있습니다');
  save(boardFile(), 'posts', list.filter((x) => x.id !== id));
  return p;
}

export function addComment(postId, body, user) {
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === postId);
  if (i < 0) throw notFound();
  const cur = list[i];
  const comments = Array.isArray(cur.comments) ? cur.comments : [];
  if (comments.length >= LIMITS.commentMax) throw limitError(`댓글은 글마다 ${LIMITS.commentMax}개까지입니다`);
  const c = { id: newId(), author: user, body: text(body?.body, LIMITS.commentBody, 'body', { required: true }), createdAt: Date.now() };
  const next = [...list]; next[i] = { ...cur, comments: [...comments, c] };
  save(boardFile(), 'posts', next);
  return c;
}

export function deleteComment(postId, commentId, user, { isAdmin = false } = {}) {
  const list = load(boardFile(), 'posts');
  const i = list.findIndex((p) => p.id === postId);
  if (i < 0) throw notFound();
  const comments = Array.isArray(list[i].comments) ? list[i].comments : [];
  const c = comments.find((x) => x.id === commentId);
  if (!c) throw notFound();
  if (!canModify(c, user, isAdmin)) throw forbidden('작성자 본인이나 관리자만 지울 수 있습니다');
  const next = [...list]; next[i] = { ...list[i], comments: comments.filter((x) => x.id !== commentId) };
  save(boardFile(), 'posts', next);
  return c;
}

