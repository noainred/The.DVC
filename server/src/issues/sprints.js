/**
 * issues/sprints.js — 이슈 스프린트(v2.882 · 시안 docs/design/wiki-issues ⑦).
 *
 * 파일 `issue-sprints.json` { v:1, nextNum, sprints:[{ id, num, name, goal, startDay, endDay, state, createdAt, createdBy, updatedAt, updatedBy,
 *   closedAt, closedBy, closeNote }] }. 날짜는 포탈 날짜 'YYYY-MM-DD'(util/dayKey 하나 — 한국 시각 기준).
 *  · 스프린트는 전 법인 공용이다(공용 + 전 법인 이슈를 담는다). 만들기 · 고치기 · 끝내기는 라우트가 **전체 범위** 운영자 · 관리자로 막는다.
 *    이슈를 넣고 빼는 것은 그 이슈의 쓰기 범위(저장소 store.js setSprint).
 *  · 상태: planned(예정) · active(진행 중) · closed(끝남). 끝낸 스프린트는 회고로 남는다(지우지 않는다 — 상한을 넘으면 새로 만들지 못한다).
 *  · 작은 설정 파일이라 동기 원자 쓰기 · 손상 보존(issues/settings.js 와 같은 틀). 비밀 없음.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';
import { dayIndex, dayLabel, DAY_MS } from '../util/dayKey.js';

export const SPRINT_STATES = Object.freeze(['planned', 'active', 'closed']);
export const SPRINT_LIMITS = Object.freeze({ max: 200, name: 40, goal: 300, maxDays: 60, closeNote: 200 });
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const sprintsFile = () => path.join(config.configDir, 'issue-sprints.json');

let cache = null;
let loadError = null;
export function sprintsLoadError() { return loadError; }
export function _resetSprintsCache() { cache = null; loadError = null; }

function load() {
  if (cache) return cache;
  const file = sprintsFile();
  let sprints = []; let nextNum = 1;
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.sprints)) throw new Error('sprints 배열이 없습니다');
      sprints = j.sprints.filter((s) => s && typeof s === 'object' && typeof s.id === 'string' && typeof s.name === 'string');
      const maxNum = sprints.reduce((m, s) => Math.max(m, Number(s.num) || 0), 0);
      nextNum = Math.max(Number.isInteger(j.nextNum) && j.nextNum > 0 ? j.nextNum : 1, maxNum + 1);
    }
    loadError = null;
  } catch (e) {
    preserveCorrupt(file, e.message);
    loadError = { message: safeLoadText(e) || '사유 미상', at: Date.now() };
    console.warn(`[issues] issue-sprints.json 을 읽지 못해 빈 목록으로 시작합니다: ${loadError.message}`);
    sprints = []; nextNum = 1;
  }
  cache = { sprints, nextNum };
  return cache;
}
function save(c) {
  atomicWriteFileSync(sprintsFile(), JSON.stringify({ v: 1, nextNum: c.nextNum, sprints: c.sprints }, null, 1), { mode: 0o600 });
  cache = c;
}

function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
function notFound() { const e = new Error('없는 스프린트입니다'); e.status = 404; return e; }
function conflict(msg) { const e = new Error(msg); e.status = 409; return e; }
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function text(v, max, field, { required = false, multiline = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw fieldError(field, '문자열이어야 합니다');
  let s = v.replace(CTRL, '');
  if (!multiline) s = s.replace(/[\r\n]+/g, ' ');
  s = s.trim();
  if (required && !s) throw fieldError(field, '비어 있습니다');
  if (s.length > max) throw fieldError(field, `${max}자까지입니다`);
  return s;
}
/** 'YYYY-MM-DD' → 포탈 날짜 번호(dayIndex 와 같은 축). 못 읽으면 400. */
export function dayOf(v, field) {
  const m = DAY_RE.exec(String(v ?? '').trim());
  if (!m) throw fieldError(field, 'YYYY-MM-DD 날짜여야 합니다');
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms) || dayLabel(ms / DAY_MS) !== m[0]) throw fieldError(field, '없는 날짜입니다');
  return ms / DAY_MS;
}

/** 화면 · 다른 모듈용 보기 — 날짜 번호(startIdx · endIdx)를 함께 싣는다. */
export function sprintView(s, now = Date.now()) {
  const startIdx = dayOf(s.startDay, 'startDay'); const endIdx = dayOf(s.endDay, 'endDay');
  const today = dayIndex(now);
  return {
    id: s.id, num: s.num, name: s.name, goal: s.goal || '', startDay: s.startDay, endDay: s.endDay, state: s.state,
    days: endIdx - startIdx + 1, daysLeft: s.state === 'closed' ? null : Math.max(0, endIdx - Math.max(today, startIdx) + (today <= endIdx ? 1 : 0)),
    overdue: s.state !== 'closed' && today > endIdx,
    createdAt: s.createdAt, createdBy: s.createdBy || '', updatedAt: s.updatedAt || s.createdAt, updatedBy: s.updatedBy || '',
    closedAt: s.closedAt ?? null, closedBy: s.closedBy || '', closeNote: s.closeNote || '',
  };
}
const ORDER = { active: 0, planned: 1, closed: 2 };
export function listSprints({ now = Date.now() } = {}) {
  return load().sprints.map((s) => sprintView(s, now))
    .sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || (a.state === 'closed' ? b.endDay.localeCompare(a.endDay) : a.startDay.localeCompare(b.startDay)));
}
export function getSprint(id) {
  const s = load().sprints.find((x) => x.id === id);
  return s ? sprintView(s) : null;
}
/** 이름으로 찾기(검색식 sprint = "이름") — 대소문자 무시, 같은 이름이 여럿이면 최근 것. */
export function findSprintByName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const hits = load().sprints.filter((s) => s.name.toLowerCase() === n).sort((a, b) => (b.num || 0) - (a.num || 0));
  return hits[0] ? sprintView(hits[0]) : null;
}
export const activeSprintIds = () => new Set(load().sprints.filter((s) => s.state === 'active').map((s) => s.id));

function datesOf(b, cur = null) {
  const startDay = b.startDay != null ? String(b.startDay).trim() : cur?.startDay;
  const endDay = b.endDay != null ? String(b.endDay).trim() : cur?.endDay;
  const a = dayOf(startDay, 'startDay'); const z = dayOf(endDay, 'endDay');
  if (z < a) throw fieldError('endDay', '끝나는 날이 시작하는 날보다 앞입니다');
  if (z - a + 1 > SPRINT_LIMITS.maxDays) throw fieldError('endDay', `스프린트는 ${SPRINT_LIMITS.maxDays}일까지입니다`);
  return { startDay, endDay };
}

export function createSprint(body, user) {
  const c = load();
  if (c.sprints.length >= SPRINT_LIMITS.max) throw conflict(`스프린트는 ${SPRINT_LIMITS.max}개까지 보관합니다`);
  const b = body || {};
  const name = text(b.name, SPRINT_LIMITS.name, 'name', { required: true });
  if (c.sprints.some((s) => s.state !== 'closed' && s.name.toLowerCase() === name.toLowerCase())) throw fieldError('name', '같은 이름의 열린 스프린트가 있습니다');
  const { startDay, endDay } = datesOf(b);
  const state = b.state === 'active' ? 'active' : 'planned';
  const now = Date.now();
  const s = {
    id: `S${crypto.randomBytes(5).toString('hex')}`, num: c.nextNum, name, goal: text(b.goal, SPRINT_LIMITS.goal, 'goal', { multiline: true }),
    startDay, endDay, state, createdAt: now, createdBy: user, updatedAt: now, updatedBy: user, closedAt: null, closedBy: '', closeNote: '',
  };
  save({ sprints: [...c.sprints, s], nextNum: c.nextNum + 1 });
  return sprintView(s);
}

/** 이름 · 목표 · 기간 · 상태(planned ↔ active) — 끝낸 스프린트는 고치지 않는다(회고 기록). 끝내기는 closeSprint. */
export function updateSprint(id, body, user) {
  const c = load();
  const cur = c.sprints.find((s) => s.id === id);
  if (!cur) throw notFound();
  if (cur.state === 'closed') throw conflict('끝난 스프린트는 고칠 수 없습니다 — 회고 기록입니다');
  const b = body || {};
  const has = (k) => Object.hasOwn(b, k);
  const next = { ...cur };
  if (has('name')) {
    next.name = text(b.name, SPRINT_LIMITS.name, 'name', { required: true });
    if (c.sprints.some((s) => s.id !== id && s.state !== 'closed' && s.name.toLowerCase() === next.name.toLowerCase())) throw fieldError('name', '같은 이름의 열린 스프린트가 있습니다');
  }
  if (has('goal')) next.goal = text(b.goal, SPRINT_LIMITS.goal, 'goal', { multiline: true });
  if (has('startDay') || has('endDay')) Object.assign(next, datesOf(b, cur));
  if (has('state')) {
    if (!['planned', 'active'].includes(b.state)) throw fieldError('state', "planned 또는 active 여야 합니다(끝내기는 '스프린트 끝내기')");
    next.state = b.state;
  }
  next.updatedAt = Date.now(); next.updatedBy = user;
  save({ ...c, sprints: c.sprints.map((s) => (s.id === id ? next : s)) });
  return sprintView(next);
}

/** 끝내기 — 상태만 바꾼다. 미완료 이슈 옮기기는 라우트가 store.moveSprintIssues 로 먼저 한다(순서: 옮기기 → 끝내기). */
export function closeSprint(id, user, { note = '' } = {}) {
  const c = load();
  const cur = c.sprints.find((s) => s.id === id);
  if (!cur) throw notFound();
  if (cur.state === 'closed') throw conflict('이미 끝난 스프린트입니다');
  const now = Date.now();
  const next = { ...cur, state: 'closed', closedAt: now, closedBy: user, closeNote: capStr(text(note, SPRINT_LIMITS.closeNote, 'note'), SPRINT_LIMITS.closeNote), updatedAt: now, updatedBy: user };
  save({ ...c, sprints: c.sprints.map((s) => (s.id === id ? next : s)) });
  return sprintView(next);
}
