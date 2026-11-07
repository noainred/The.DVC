/**
 * 로그인 성공 기록(v2.912) — 설정 › 로그 › 최근 로그인 · 로그인 횟수.
 *
 * 사용자 요청: "설정에 로그에서 전체 사용자가 최근에 로그인 한 정보 보여주는 메뉴 만들고 최근 1일/7일/1달/사용자 정의 기간에
 *   몇번 로그인 했는지 확인할 수 있는 메뉴 만들어줘".
 *
 * ⚠ 왜 감사 로그(audit.ndjson)의 '로그인' 줄을 그대로 세지 않는가 — 감사 로그는 모든 쓰기 작업과 함께 **줄 수 상한**
 *   (AUDIT_MAX, 기본 2만 줄)으로 잘린다. 작업이 많은 포탈에서는 며칠 전 로그인 줄이 밀려나 '최근 1달 0회' 가 사실처럼 보인다.
 *   그래서 로그인만 따로, **기간 기준**(RETAIN_DAYS)으로 보관한다.
 * ⚠ 첫 기동(이 파일이 없을 때)에는 감사 로그에 아직 남아 있는 '로그인' 줄을 **한 번** 옮겨 온다(인증 출처는 모름 — src '').
 *   그보다 앞은 기록이 없다 — 0 회로 단정하지 않도록 가장 오래된 기록 시각(coverageFrom)과 '기간 시작이 그보다 앞' 표지(partial)를 함께 준다.
 *
 * 레코드(한 줄 JSON): { ts, user, ip, role, src }   src = 'local' | 'ad' | ''(감사 로그에서 옮겨 와 모름)
 * 저장: 로그인마다 한 줄 append(0600). 보관 기간·줄 수를 넘으면 원자적으로 다시 쓴다(하루 1회 · 상한 초과 1,000건마다 — 핫패스 보호).
 * 읽기: 프로세스당 한 번 읽어 메모리에 둔다. 조회는 메모리 배열 한 번 훑기(O(N), N ≤ MAX).
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { auditEntriesWithAction } from '../audit.js';

const FILE = path.join(config.configDir, 'login-history.ndjson');
const DAY = 86_400_000;
export const LOGIN_HISTORY_RETAIN_DAYS = 366;
export const LOGIN_HISTORY_MAX = 100_000;
/** 고정 구간(최근 1일 · 7일 · 1달). '1달' 은 30일로 센다(달마다 길이가 달라 화면에 30일이라고 밝힌다). */
export const LOGIN_WINDOWS = Object.freeze([
  { key: 'd1', days: 1 }, { key: 'd7', days: 7 }, { key: 'd30', days: 30 },
]);
const FIELD_MAX = 128;
const RECENT_MAX = 200;
const KNOWN_ROLES = new Set(['super_admin', 'admin', 'operator', 'viewer']);

let rows = null;          // 로드된 레코드(대체로 오래된 것이 앞 — 시계가 되돌아가도 집계는 순서에 의존하지 않는다)
let meta = { skipped: 0, backfilled: 0, loadError: null };
let lastTrimAt = 0;

const clip = (v, max = FIELD_MAX) => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : '';
  return s.length > max ? s.slice(0, max) : s;
};
function cleanRow(r) {
  if (!r || typeof r !== 'object' || !Number.isFinite(r.ts)) return null;
  const user = clip(r.user);
  if (!user) return null;
  const src = r.src === 'local' || r.src === 'ad' ? r.src : '';
  return { ts: r.ts, user, ip: clip(r.ip, 70), role: clip(r.role, 32), src };
}

/*
 * v2.931(점검 C1-03): 첫 기동(파일 없음)의 첫 로그인이 2회로 세졌다 — routes/auth.js 가 같은 로그인의 감사 줄을 **먼저 동기로** 쓰고
 *   (logAudit) 이어서 recordLoginSuccessEvent 를 부르므로, 그 안의 첫 load() 가 방금 쓴 줄까지 옮겨 온 뒤 같은 로그인을 다시 push 했다.
 *   지금 기록하려는 로그인과 같은 계정 · 같은 IP(둘 다 있을 때) · 기록 시각 앞 BACKFILL_SKIP_MS 안의 감사 줄 **가장 늦은 한 줄만** 뺀다.
 *   라우트 순서(logAudit 앞에 load)에 기대지 않는다 — 다른 로그인 경로가 생겨도 같은 순서면 같은 결과다. 한 줄만 빼므로 그 창 안의
 *   다른 로그인(같은 계정이 몇 초 사이 두 번)은 남는다.
 */
const BACKFILL_SKIP_MS = 10_000;
function isSameLogin(a, b) {
  return a.user === b.user && a.ts <= b.ts + 1_000 && a.ts >= b.ts - BACKFILL_SKIP_MS && (!a.ip || !b.ip || a.ip === b.ip);
}

/** 감사 로그의 '로그인' 줄 → 레코드(첫 기동 1회). 역할은 detail 첫 조각이 알려진 역할일 때만 쓴다(지어내지 않는다). */
function backfillFromAudit(current = null) {
  let list = [];
  try { list = auditEntriesWithAction('로그인'); } catch { list = []; }
  const out = [];
  for (const e of list) {
    const ts = Date.parse(e.at);
    if (!Number.isFinite(ts)) continue;
    const head = String(e.detail || '').split(' · ')[0].trim();
    const r = cleanRow({ ts, user: e.user, ip: e.ip, role: KNOWN_ROLES.has(head) ? head : '', src: '' });
    if (r) out.push(r);
  }
  out.sort((a, b) => a.ts - b.ts);
  if (current) {
    for (let i = out.length - 1; i >= 0; i--) if (isSameLogin(out[i], current)) { out.splice(i, 1); break; }
  }
  return out;
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  atomicWriteFileSync(FILE, list.length ? list.map((r) => JSON.stringify(r)).join('\n') + '\n' : '', { mode: 0o600 });
}

/** @param {object|null} current 지금 기록하려는 로그인(recordLoginSuccessEvent — 첫 기동 backfill 에서 같은 줄을 뺀다, C1-03) */
function load(current = null) {
  if (rows) return rows;
  rows = [];
  let text = null;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') {
      // 처음 — 감사 로그에 남아 있는 로그인 줄을 옮겨 온다. 실패해도 빈 기록으로 시작한다(다음 로그인부터 쌓인다).
      rows = backfillFromAudit(current);
      meta.backfilled = rows.length;
      try { writeAll(rows); } catch (we) { console.warn(`[login-history] 첫 기록 파일을 쓰지 못했습니다(${safeLoadText(we) || '사유 미상'})`); }
      if (rows.length) console.log(`[login-history] 감사 로그에 남아 있던 로그인 ${rows.length}건을 옮겨 왔습니다(그 이전 기록은 없습니다)`);
      return rows;
    }
    // 읽지 못함(권한 등) — 덮어쓰기 전에 원본을 보존하고 빈 기록으로 시작한다. 화면은 loadError 로 '기록을 읽지 못함' 을 밝힌다(0 으로 단정 금지).
    meta.loadError = safeLoadText(e) || '사유 미상';
    console.warn(`[login-history] 기록 파일을 읽지 못했습니다(${meta.loadError}) — 원본을 보존하고 새로 시작합니다`);
    preserveCorrupt(FILE, e?.message || '');
    return rows;
  }
  let bad = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    let r = null;
    try { r = cleanRow(JSON.parse(l)); } catch { r = null; }
    if (r) rows.push(r); else bad++;
  }
  if (bad) { meta.skipped = bad; console.warn(`[login-history] 읽지 못한 줄 ${bad}개를 건너뛰었습니다(나머지 ${rows.length}건은 유지)`); }
  return rows;
}

function maybeTrim(now) {
  const cut = now - LOGIN_HISTORY_RETAIN_DAYS * DAY;
  const overCount = rows.length > LOGIN_HISTORY_MAX + 1000;
  // 보관 기간 정리는 하루 한 번이면 충분하다(가장 오래된 줄이 하루 이상 넘었을 때만 — 매 로그인마다 전체를 다시 쓰지 않는다).
  const overAge = rows.length > 0 && rows[0].ts < cut - DAY && now - lastTrimAt > DAY;
  if (!overCount && !overAge) return;
  lastTrimAt = now;
  rows = rows.filter((r) => r.ts >= cut).slice(-LOGIN_HISTORY_MAX);
  try { writeAll(rows); } catch (e) { console.warn(`[login-history] 정리 저장 실패(${safeLoadText(e) || '사유 미상'})`); }
}

/**
 * 로그인 성공 1건을 남긴다(routes/auth.js — 토큰 발급 직후). 실패해도 로그인을 막지 않는다(호출부가 try 로 감싼다).
 * @param {{user:string, ip?:string, role?:string, src?:string, at?:number}} e
 */
export function recordLoginSuccessEvent(e = {}) {
  const now = Number.isFinite(e.at) ? e.at : Date.now();
  const r = cleanRow({ ts: now, user: e.user, ip: e.ip, role: e.role, src: e.src });
  if (!r) return false;
  load(r);
  rows.push(r);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, JSON.stringify(r) + '\n', { mode: 0o600 });
  } catch (err) { console.warn(`[login-history] 기록 실패(${safeLoadText(err) || '사유 미상'})`); }
  maybeTrim(now);
  return true;
}

/**
 * 조회 기간 입력(질의 문자열) → { from, to } | { error }. 값은 epoch ms. 둘 다 없으면 null(사용자 정의 기간 없음).
 * `req.query` 는 배열·객체가 올 수 있다 — 문자열(또는 수)만 받는다.
 */
export function parseLoginRange(fromRaw, toRaw, now = Date.now()) {
  const bad = (v) => v != null && typeof v !== 'string' && typeof v !== 'number';
  if (bad(fromRaw) || bad(toRaw)) return { error: '기간 값 형식이 올바르지 않습니다(같은 이름을 두 번 보냈는지 확인).' };
  const f = fromRaw == null ? '' : String(fromRaw).trim();
  const t = toRaw == null ? '' : String(toRaw).trim();
  if (!f && !t) return null;
  if (!f || !t) return { error: '사용자 정의 기간은 시작과 끝을 함께 지정해야 합니다.' };
  if (!/^\d{1,15}$/.test(f) || !/^\d{1,15}$/.test(t)) return { error: '기간은 epoch 밀리초 숫자여야 합니다.' };
  const from = Number(f); const to = Number(t);
  if (!(from < to)) return { error: '기간의 끝이 시작보다 뒤여야 합니다.' };
  if (from > now) return { error: '기간의 시작이 미래입니다.' };
  return { from, to };
}

/**
 * 사용자별 로그인 집계.
 * @param {{now?:number, range?:{from:number,to:number}|null, accounts?:Array<{username:string, role?:string, name?:string}>}} o
 *   accounts: 지금 등록된 로컬 계정(한 번도 로그인하지 않은 계정도 목록에 넣으려고 — 값은 0 이 아니라 '기록 없음' 이다).
 */
export function loginHistorySummary({ now = Date.now(), range = null, accounts = [] } = {}) {
  load();
  const starts = Object.fromEntries(LOGIN_WINDOWS.map((w) => [w.key, now - w.days * DAY]));
  const byUser = new Map();
  const ensure = (name) => {
    let u = byUser.get(name);
    if (!u) {
      u = { user: name, last: null, lastIp: '', lastRole: '', lastSrc: '', total: 0, d1: 0, d7: 0, d30: 0, range: range ? 0 : null, rangeLast: null };
      byUser.set(name, u);
    }
    return u;
  };
  const totals = { d1: 0, d7: 0, d30: 0, range: range ? 0 : null };
  let oldest = null;
  for (const r of rows) {
    if (oldest == null || r.ts < oldest) oldest = r.ts;
    const u = ensure(r.user);
    u.total += 1;
    if (u.last == null || r.ts >= u.last) { u.last = r.ts; u.lastIp = r.ip; u.lastRole = r.role; u.lastSrc = r.src; }
    for (const w of LOGIN_WINDOWS) if (r.ts >= starts[w.key] && r.ts <= now) { u[w.key] += 1; totals[w.key] += 1; }
    if (range && r.ts >= range.from && r.ts < range.to) {
      u.range += 1; totals.range += 1;
      if (u.rangeLast == null || r.ts > u.rangeLast) u.rangeLast = r.ts;
    }
  }
  const local = new Map();
  for (const a of Array.isArray(accounts) ? accounts : []) {
    const name = clip(a?.username);
    if (!name) continue;
    local.set(name, a);
    ensure(name);
  }
  const users = [...byUser.values()].map((u) => {
    const acc = local.get(u.user);
    // 계정 종류: 지금 로컬 계정이 있으면 로컬, 없으면 마지막 로그인의 출처(AD) · 로컬이었는데 지금 없으면 '삭제됨' · 감사 로그에서 옮겨 온 줄만 있으면 모름.
    const account = acc ? 'local' : u.lastSrc === 'ad' ? 'ad' : u.lastSrc === 'local' ? 'deleted' : 'unknown';
    return {
      user: u.user, name: acc?.name && acc.name !== u.user ? clip(acc.name) : '',
      role: acc ? clip(acc.role) : u.lastRole, account,
      last: u.last, lastIp: u.lastIp, total: u.total,
      d1: u.d1, d7: u.d7, d30: u.d30, range: u.range, rangeLast: u.rangeLast,
    };
  });
  // 최근 로그인 순(기록 없는 계정은 뒤 · 이름순).
  users.sort((a, b) => (b.last ?? -1) - (a.last ?? -1) || a.user.localeCompare(b.user));
  // 구간 시작이 가장 오래된 기록보다 앞이면, 그 앞부분은 세지 못한 것이다(0 회라는 뜻이 아니다).
  const partialOf = (start) => oldest == null || start < oldest;
  const partial = Object.fromEntries(LOGIN_WINDOWS.map((w) => [w.key, partialOf(starts[w.key])]));
  if (range) partial.range = partialOf(range.from);
  const recent = [];
  for (let i = rows.length - 1; i >= 0 && recent.length < RECENT_MAX; i--) recent.push(rows[i]);
  recent.sort((a, b) => b.ts - a.ts);
  return {
    now, coverageFrom: oldest, retainDays: LOGIN_HISTORY_RETAIN_DAYS,
    records: rows.length, backfilled: meta.backfilled, skippedLines: meta.skipped, loadError: meta.loadError,
    windows: LOGIN_WINDOWS.map((w) => ({ key: w.key, days: w.days, from: starts[w.key] })),
    range: range ? { from: range.from, to: range.to } : null,
    partial, totals, users, recent, recentMax: RECENT_MAX,
  };
}

/** 테스트 전용 — 메모리 상태를 비운다(다음 호출이 파일을 다시 읽는다). */
export function _resetLoginHistoryForTest() { rows = null; meta = { skipped: 0, backfilled: 0, loadError: null }; lastTrimAt = 0; }
