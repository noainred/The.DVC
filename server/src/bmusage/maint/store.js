/**
 * bmusage/maint/store.js — 리눅스 성능 8a단계 **정비 창 저장소**(`maintenance-windows.json` · 엣지 배포본 `maintenance-windows-deployed.json`).
 *
 * 파일 스토어 규약(perf-db.md v2.582 · 6단계 annotations.js 와 같은 꼴):
 *   · 원자 쓰기(0600) · 손상 보존(preserveCorrupt) · **손상이면 읽기 503 · 쓰기 거부**(빈 목록으로 덮어 모두의 창을 지우지 않는다) ·
 *   · 읽기-수정-쓰기는 **직렬 큐 하나**(withStore — 라우트의 비동기 검사 뒤에 들어와도 앞 쓰기를 덮지 않는다) + 창마다 rev(고치기 · 끝내기 · 지우기는 rev 가 다르면 409).
 *   · 상한 2,000 — 넘으면 지운 창 · 90일 전에 끝난 창부터 비우고 그래도 넘치면 409.
 * 정규화는 **한 함수**(normalizeWindow) — API 입력(엄격) · 파일 읽기 · 엣지가 받은 배포본(느슨 — 형식 밖 항목은 버리고 센다)이 같은 함수를 지난다.
 * 판정 입력(windowsForJudge) = 이 노드의 창 + 중앙 배포본(받은 지 DEPLOY_TTL_MS 안일 때만 — 배포가 끊긴 엣지가 지워진 창으로 영원히 억제하지 않게: 억제 시한).
 * ⚠ 손상 · 못 읽음이면 그 쪽 창은 판정에 넣지 않는다(억제하지 않는 쪽 — 알림이 나간다) + 상태(unreadable)를 올려 수집 건강 · 화면이 밝힌다.
 * 권한 · 범위 · 승인 등급은 라우트(routes/api/bmMaint.js)가 본다 — 이 모듈은 형식 · 저장 · 일정 상한만.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeSettingsLoadError } from '../../util/settingsLoadError.js';
import { SCHED_KINDS, ONCE_MAX_MIN, RECUR_MAX_MIN, parseLocal, parseTime, localToUtc, validTz, DEFAULT_TZ, MIN, DAY } from './schedule.js';
import { SCOPES, TARGET_KINDS, TAG_RE, windowStatus, expiresAt } from './judge.js';

const FILE = () => path.join(config.configDir, 'maintenance-windows.json');
const DEPLOYED_FILE = () => path.join(config.configDir, 'maintenance-windows-deployed.json');
export const WINDOWS_MAX = 2_000;
export const KEYS_MAX = 20;
export const NAME_MAX = 80;
export const REASON_MAX = 300;
export const EDITS_MAX = 20;
/** 일회 창의 시작은 지금부터 400일 안 · 끝은 지금 뒤(지난 창을 새로 만들지 않는다). */
export const FUTURE_MAX_DAYS = 400;
/** 끝난 창 보관(목록 ‘지난 창 90일 이력’) — 지나면 쓰기 때 비운다. */
export const KEEP_ENDED_DAYS = 90;
/** 엣지 배포본 신선도 — 받은 지 이보다 오래면 판정에 넣지 않는다(중앙이 지운 창이 끊긴 엣지에서 계속 억제하지 않게). 일회 창 상한(24h)과 같다. */
export const DEPLOY_TTL_MS = 24 * 3_600_000;
/** 소유자 등급이 필요한 길이(분) — 이보다 길면(일회 12~24h) 설정 소유자 등급. 반복은 상한이 12h 라 해당 없음. */
export const OWNER_OVER_MIN = 12 * 60;
const ID_RE = /^mw-[a-z0-9]{6,32}$/;
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const KEY_RE = /^[^\u0000-\u001f\u007f]{1,256}$/;
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 정비 창', confirm: () => writeAll({ v: 1, seq: 0, items: [] }) });
function fail(status, code, reason, field = null) { const e = new Error(reason); e.status = status; e.code = code; if (field) e.field = field; return e; }
export function cleanText(v, max) { return typeof v === 'string' ? v.replace(CTRL, '').replace(/\s+/g, ' ').trim().slice(0, max) : ''; }

/** 일정 길이(분 — 실제 경과 · 일회는 시간대로 계산). 형식 밖이면 null. */
export function durationMinOf(schedule, tz) {
  if (!schedule) return null;
  if (schedule.kind === 'once') {
    const a = parseLocal(schedule.start); const b = parseLocal(schedule.end);
    if (!a || !b || !validTz(tz)) return null;
    return Math.round((localToUtc(tz, b.y, b.mo, b.d, b.h, b.mi) - localToUtc(tz, a.y, a.mo, a.d, a.h, a.mi)) / MIN);
  }
  const d = Number(schedule.durMin);
  return Number.isInteger(d) ? d : null;
}
/** 소유자 등급이 필요한 창인가(순수 — 라우트 · 화면 문구가 같은 판정): 법인 전체 · 태그 · 12시간 초과. */
export function needsOwnerTier(w) {
  if (!w?.target || w.target.kind !== 'server') return true;
  const d = durationMinOf(w.schedule, w.tz);
  return d == null || d > OWNER_OVER_MIN;
}

/**
 * 정규화 하나(엄격 = API 입력 — 형식 밖 400 · 느슨 = 파일 · 배포본 — 형식 밖이면 null).
 * @param {object} raw
 * @param {{strict?:boolean, now?:number, fresh?:boolean}} o  fresh = 새로 만들기(일회 창은 끝이 지금 뒤 · 시작은 400일 안)
 */
export function normalizeWindow(raw, { strict = false, now = Date.now(), fresh = false } = {}) {
  const bad = (field, msg) => { if (strict) throw fail(400, 'bad-window', msg, field); return null; };
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!r) return bad('body', '정비 창 형식이 다릅니다.');
  const name = cleanText(r.name, NAME_MAX);
  if (!name) return bad('name', `이름이 필요합니다(${NAME_MAX}자 이내).`);
  const reason = cleanText(r.reason, REASON_MAX);
  if (!reason) return bad('reason', `사유가 필요합니다(${REASON_MAX}자 이내 — 감사에 남습니다).`);
  const tz = r.tz == null || r.tz === '' ? DEFAULT_TZ : r.tz;
  if (!validTz(tz)) return bad('tz', '알 수 없는 시간대입니다(예: Asia/Seoul · Europe/Warsaw · America/New_York).');
  const vc = String(r.vcenterId ?? '').trim();
  if (!VC_RE.test(vc)) return bad('vcenterId', '법인(vCenter id)이 필요합니다.');
  // 대상 — 서버 · 태그 · 법인 중 하나(섞지 않는다)
  const tg = r.target && typeof r.target === 'object' && !Array.isArray(r.target) ? r.target : null;
  if (!tg || !TARGET_KINDS.includes(tg.kind)) return bad('target.kind', `대상은 ${TARGET_KINDS.join(' · ')} 중 하나입니다.`);
  const target = { kind: tg.kind };
  if (tg.kind === 'server' || tg.kind === 'tag') {
    const keys = Array.isArray(tg.keys) ? [...new Set(tg.keys.map((k) => String(k ?? '').trim()))] : [];
    if (keys.some((k) => !KEY_RE.test(k))) return bad('target.keys', '서버 키 형식이 다릅니다.');
    if (tg.kind === 'server' && (!keys.length || keys.length > KEYS_MAX)) return bad('target.keys', `대상 서버는 1~${KEYS_MAX}대입니다.`);
    target.keys = keys.slice(0, tg.kind === 'tag' ? 5_000 : KEYS_MAX);
    if (tg.kind === 'server') target.names = (Array.isArray(tg.names) ? tg.names : []).map((x) => cleanText(String(x ?? ''), 120)).slice(0, KEYS_MAX);
  }
  if (tg.kind === 'tag') {
    const tag = String(tg.tag ?? '').trim();
    if (!TAG_RE.test(tag)) return bad('target.tag', '태그는 role:<역할> 또는 app:<용도> 꼴입니다.');
    target.tag = tag;
  }
  // 일정
  const s = r.schedule && typeof r.schedule === 'object' && !Array.isArray(r.schedule) ? r.schedule : null;
  if (!s || !SCHED_KINDS.includes(s.kind)) return bad('schedule.kind', '일정은 일회 · 매주 · 매월 중 하나입니다.');
  let schedule;
  if (s.kind === 'once') {
    const a = parseLocal(s.start); const b = parseLocal(s.end);
    if (!a || !b) return bad('schedule', '시작 · 끝은 YYYY-MM-DDTHH:mm 입니다.');
    schedule = { kind: 'once', start: String(s.start), end: String(s.end) };
    const sMs = localToUtc(tz, a.y, a.mo, a.d, a.h, a.mi); const eMs = localToUtc(tz, b.y, b.mo, b.d, b.h, b.mi);
    if (!(eMs > sMs)) return bad('schedule.end', '끝이 시작보다 뒤여야 합니다.');
    if ((eMs - sMs) / MIN > ONCE_MAX_MIN) return bad('schedule.end', `일회 창은 ${ONCE_MAX_MIN / 60}시간까지입니다.`);
    if (fresh && eMs <= now) return bad('schedule.end', '이미 끝난 시각입니다 — 지난 창은 만들지 않습니다.');
    if (fresh && sMs > now + FUTURE_MAX_DAYS * DAY) return bad('schedule.start', `시작은 ${FUTURE_MAX_DAYS}일 안이어야 합니다.`);
  } else {
    const tm = parseTime(s.time);
    if (tm == null) return bad('schedule.time', '시작 시각은 HH:mm 입니다.');
    const dur = typeof s.durMin === 'number' ? s.durMin : (typeof s.durMin === 'string' && /^\d{1,4}$/.test(s.durMin) ? Number(s.durMin) : NaN);
    if (!Number.isInteger(dur) || dur < 1 || dur > RECUR_MAX_MIN) return bad('schedule.durMin', `반복 창 길이는 1~${RECUR_MAX_MIN}분(${RECUR_MAX_MIN / 60}시간)입니다.`);
    if (s.kind === 'weekly') {
      const days = Array.isArray(s.days) ? [...new Set(s.days)] : [];
      if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return bad('schedule.days', '요일은 0(일)~6(토) 정수 배열입니다.');
      schedule = { kind: 'weekly', days: days.sort((x, y) => x - y), time: String(s.time), durMin: dur };
    } else {
      const nth = Number(s.nth); const wd = Number(s.weekday);
      if (!Number.isInteger(nth) || nth < 1 || nth > 5) return bad('schedule.nth', 'n째는 1~4 또는 5(마지막)입니다.');
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) return bad('schedule.weekday', '요일은 0(일)~6(토)입니다.');
      schedule = { kind: 'monthly', nth, weekday: wd, time: String(s.time), durMin: dur };
    }
  }
  // 억제 범위 — 켠 것만(하나 이상)
  const sc = r.scopes && typeof r.scopes === 'object' && !Array.isArray(r.scopes) ? r.scopes : null;
  if (!sc) return bad('scopes', '억제 범위가 필요합니다.');
  for (const k of Object.keys(sc)) if (!SCOPES.includes(k)) return bad(`scopes.${k}`, `억제 범위는 ${SCOPES.join(' · ')} 입니다.`);
  const scopes = Object.fromEntries(SCOPES.filter((k) => sc[k] === true).map((k) => [k, true]));
  if (!Object.keys(scopes).length) return bad('scopes', '억제 범위를 하나 이상 켜세요.');
  const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null));
  const out = {
    id: ID_RE.test(String(r.id || '')) ? String(r.id) : null,
    name, reason, target, vcenterId: vc, tz, schedule, scopes,
    by: cleanText(String(r.by ?? ''), 64), at: num(r.at), rev: Number.isInteger(r.rev) && r.rev > 0 ? r.rev : 1,
    approvedBy: cleanText(String(r.approvedBy ?? ''), 64), confirmedAt: num(r.confirmedAt),
    ...(num(r.endedAt) != null ? { endedAt: num(r.endedAt), endedBy: cleanText(String(r.endedBy ?? ''), 64), ...(num(r.endedOccStart) != null ? { endedOccStart: num(r.endedOccStart) } : {}) } : {}),
    ...(r.deleted && typeof r.deleted === 'object' ? { deleted: { at: num(r.deleted.at), by: cleanText(String(r.deleted.by ?? ''), 64) } } : {}),
    edits: (Array.isArray(r.edits) ? r.edits : []).filter((e) => e && typeof e === 'object').slice(-EDITS_MAX)
      .map((e) => ({ at: num(e.at), by: cleanText(String(e.by ?? ''), 64), fields: (Array.isArray(e.fields) ? e.fields : []).map((f) => cleanText(String(f), 24)).slice(0, 12) })),
  };
  if (!strict && !out.id) return null;
  return out;
}

/* ── 파일(이 노드의 창) ─────────────────────────────────────────────── */
let _cache = null;   // { m, s, data }
function writeAll(obj) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  try { atomicWriteFileSync(FILE(), JSON.stringify(obj), { mode: 0o600 }); } catch (e) { _cache = null; throw e; }
  _err.ok();
  try { const st = fs.statSync(FILE()); _cache = { m: st.mtimeMs, s: st.size, data: obj }; } catch { _cache = null; }
}
function loadAll() {
  let st = null;
  try { st = fs.statSync(FILE()); } catch { st = null; }
  if (st && _cache && _cache.m === st.mtimeMs && _cache.s === st.size) return _cache.data;
  _cache = null;
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') throw fail(503, 'settingsUnreadable', '정비 창 파일을 읽지 못했습니다.');
    _err.missing();
    if (_err.get()) throw fail(503, 'settingsUnreadable', _err.get().reason);
    return { v: 1, seq: 0, items: [] };
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.items)) throw new Error('형식이 다릅니다');
    let dropped = 0;
    const items = [];
    for (const x of o.items) { const w = normalizeWindow(x); if (w) items.push({ ...w, origin: 'local' }); else dropped += 1; }
    if (dropped) console.warn(`[bmusage] maintenance-windows.json 의 형식 밖 창 ${dropped}개를 읽지 않았습니다(억제하지 않습니다)`);
    _err.ok();
    const data = { v: 1, seq: Number(o.seq) || 0, items, ...(dropped ? { dropped } : {}) };
    if (st) _cache = { m: st.mtimeMs, s: st.size, data };
    return data;
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] maintenance-windows.json 을 읽지 못했습니다 — 손상본을 보존했고, 확정 전까지 정비 창 쓰기를 멈추고 이 노드의 창으로는 억제하지 않습니다');
    throw fail(503, 'settingsUnreadable', _err.get()?.reason || '정비 창 파일을 읽지 못했습니다.');
  }
}
const copy = (x) => JSON.parse(JSON.stringify(x));
/** 직렬 큐 — 읽기-수정-쓰기 한 단위(라우트의 비동기 검사 뒤에 와도 앞 쓰기를 덮지 않는다). */
let _chain = Promise.resolve();
function withStore(fn) {
  const run = _chain.then(() => {
    const all = loadAll();
    try { return fn(all); } catch (e) { _cache = null; throw e; }
  });
  _chain = run.catch(() => {});
  return run;
}
/** 끝난 지 오래된 창 · 지운 창 비우기(쓰기 때 — 순수에 가까움). */
function pruneOld(all, now) {
  const keep = now - KEEP_ENDED_DAYS * DAY;
  all.items = all.items.filter((w) => {
    if (w.deleted) return Number(w.deleted.at) > keep;
    const st = windowStatus(w, now);
    if (st.status === 'ended') return (st.last?.end ?? Number(w.endedAt) ?? 0) > keep || (st.last == null && Number(w.at) > keep);
    if (st.status === 'expired') return (expiresAt(w) ?? 0) > keep;
    return true;
  });
}

export function listWindows() { return loadAll().items; }
export function getWindow(id) { const x = loadAll().items.find((w) => w.id === String(id)); return x ? copy(x) : null; }
export function maintLoadError() { try { loadAll(); } catch { /* get 이 말한다 */ } return _err.get(); }

/** 만들기 — 라우트가 대상 · 범위 · 승인 등급을 확인한 입력. */
export function addWindow(input, { by = '', approvedBy = '', now = Date.now() } = {}) {
  const w0 = normalizeWindow({ ...input, id: undefined, rev: 1, by, at: now, approvedBy, confirmedAt: now, edits: [] }, { strict: true, now, fresh: true });
  return withStore((all) => {
    pruneOld(all, now);
    if (all.items.length >= WINDOWS_MAX) throw fail(409, 'cap', `정비 창이 상한(${WINDOWS_MAX})에 찼습니다 — 지난 창을 지우세요.`);
    all.seq += 1;
    const rec = { ...w0, id: `mw-${all.seq.toString(36)}${crypto.randomBytes(4).toString('hex')}`, origin: 'local' };
    all.items.push(rec);
    writeAll(all);
    return copy(rec);
  });
}
/** 고치기 — rev 가 다르면 409(그 사이 누가 바꿨다). 대상 법인은 바꾸지 않는다(범위가 바뀌는 쓰기를 만들지 않는다 — 지우고 새로). */
export function editWindow(id, input, { by = '', approvedBy = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const i = all.items.findIndex((w) => w.id === String(id));
    const cur = i >= 0 ? all.items[i] : null;
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    if (rev != null && Number(rev) !== cur.rev) throw fail(409, 'rev-changed', '그 사이 다른 사람이 이 창을 바꿨습니다 — 다시 불러온 뒤 고치세요.');
    if (String(input?.vcenterId ?? cur.vcenterId) !== cur.vcenterId) throw fail(400, 'bad-window', '법인은 바꿀 수 없습니다 — 지우고 새로 만드세요.', 'vcenterId');
    const next = normalizeWindow({ ...cur, ...input, id: cur.id, by: cur.by, at: cur.at, rev: cur.rev + 1, approvedBy: approvedBy || cur.approvedBy, confirmedAt: now, edits: cur.edits }, { strict: true, now, fresh: input?.schedule != null });
    const fields = ['name', 'reason', 'target', 'tz', 'schedule', 'scopes'].filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
    if (!fields.length) return copy(cur);
    next.edits = [...(cur.edits || []), { at: now, by: String(by).slice(0, 64), fields }].slice(-EDITS_MAX);
    delete next.endedAt; delete next.endedBy; delete next.endedOccStart;   // 일정이 바뀌면 앞의 ‘지금 끝내기’ 는 그 일정의 것이 아니다
    if (!fields.includes('schedule') && cur.endedAt != null) Object.assign(next, { endedAt: cur.endedAt, endedBy: cur.endedBy, ...(cur.endedOccStart != null ? { endedOccStart: cur.endedOccStart } : {}) });
    all.items[i] = { ...next, origin: 'local' };
    writeAll(all);
    return copy(all.items[i]);
  });
}
/** ‘지금 끝내기’ — 진행 중인 발생만 끊는다(반복 창의 다음 발생은 그대로). 진행 중이 아니면 409. */
export function endWindowNow(id, { by = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const cur = all.items.find((w) => w.id === String(id));
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    if (rev != null && Number(rev) !== cur.rev) throw fail(409, 'rev-changed', '그 사이 다른 사람이 이 창을 바꿨습니다 — 다시 불러오세요.');
    const st = windowStatus(cur, now);
    if (st.status !== 'active') throw fail(409, 'not-active', '진행 중인 창이 아닙니다.');
    Object.assign(cur, { endedAt: now, endedBy: String(by).slice(0, 64), endedOccStart: st.current.start, rev: cur.rev + 1 });
    cur.edits = [...(cur.edits || []), { at: now, by: String(by).slice(0, 64), fields: ['end-now'] }].slice(-EDITS_MAX);
    writeAll(all);
    return copy(cur);
  });
}
/** 반복 창 재확인(만료 시한을 다시 잡는다). */
export function confirmWindow(id, { by = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const cur = all.items.find((w) => w.id === String(id));
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    if (cur.schedule.kind === 'once') throw fail(409, 'not-recurring', '일회 창은 재확인이 없습니다.');
    if (rev != null && Number(rev) !== cur.rev) throw fail(409, 'rev-changed', '그 사이 다른 사람이 이 창을 바꿨습니다 — 다시 불러오세요.');
    Object.assign(cur, { confirmedAt: now, rev: cur.rev + 1 });
    cur.edits = [...(cur.edits || []), { at: now, by: String(by).slice(0, 64), fields: ['confirm'] }].slice(-EDITS_MAX);
    writeAll(all);
    return copy(cur);
  });
}
/** 지우기 — 흔적만 남긴다(억제는 즉시 멈춘다). */
export function deleteWindow(id, { by = '', rev = null, now = Date.now() } = {}) {
  return withStore((all) => {
    const cur = all.items.find((w) => w.id === String(id));
    if (!cur || cur.deleted) throw fail(404, 'not-found', '그 정비 창을 찾지 못했습니다.');
    if (rev != null && Number(rev) !== cur.rev) throw fail(409, 'rev-changed', '그 사이 다른 사람이 이 창을 바꿨습니다 — 다시 불러오세요.');
    cur.deleted = { at: now, by: String(by).slice(0, 64) };
    cur.rev += 1;
    writeAll(all);
    return copy(cur);
  });
}

/* ── 엣지 배포본(중앙이 보낸 창 — 엣지에서만 쓴다) ─────────────────────── */
let _dep = null;   // { m, s, data }
/** 배포본 저장(엣지 인출 워커) — 같은 정규화를 다시 거친다(엣지는 중앙 문자열을 그대로 믿지 않는다). 형식 밖은 버리고 센다. */
export function saveDeployed(list, { sig = '', now = Date.now() } = {}) {
  const items = []; let dropped = 0;
  for (const x of (Array.isArray(list) ? list : []).slice(0, WINDOWS_MAX)) {
    const w = normalizeWindow(x);
    if (w) items.push({ ...w, origin: 'central' }); else dropped += 1;
  }
  dropped += Math.max(0, (Array.isArray(list) ? list.length : 0) - WINDOWS_MAX);
  const data = { v: 1, at: now, sig: String(sig).slice(0, 64), items, dropped };
  atomicWriteFileSync(DEPLOYED_FILE(), JSON.stringify(data), { mode: 0o600 });
  _dep = null;
  return { ok: true, n: items.length, dropped };
}
/** 배포본 읽기 — 없으면 null · 손상이면 보존하고 null(억제하지 않는 쪽) + unreadable. */
export function loadDeployed() {
  let st = null;
  try { st = fs.statSync(DEPLOYED_FILE()); } catch { return null; }
  if (_dep && _dep.m === st.mtimeMs && _dep.s === st.size) return _dep.data;
  try {
    const o = JSON.parse(fs.readFileSync(DEPLOYED_FILE(), 'utf8'));
    if (!o || typeof o !== 'object' || !Array.isArray(o.items)) throw new Error('형식이 다릅니다');
    const items = o.items.map((x) => normalizeWindow(x)).filter(Boolean).map((w) => ({ ...w, origin: 'central' }));
    const data = { at: Number(o.at) || 0, sig: String(o.sig || '').slice(0, 64), items, dropped: Number(o.dropped) || 0 };
    _dep = { m: st.mtimeMs, s: st.size, data };
    return data;
  } catch (e) {
    preserveCorrupt(DEPLOYED_FILE(), String(e?.message || e));
    _dep = null;
    return { at: 0, sig: '', items: [], unreadable: true };
  }
}

/**
 * 판정 입력 — 이 노드의 창(지운 것 제외) + 신선한 배포본. 못 읽은 쪽은 넣지 않고 표지로 밝힌다.
 * @returns {{ windows:Array, localUnreadable:boolean, deployed:{at:number,sig:string,n:number,stale:boolean,unreadable?:boolean}|null }}
 */
export function windowsForJudge(now = Date.now()) {
  let local = []; let localUnreadable = false;
  try { local = loadAll().items.filter((w) => !w.deleted); } catch { localUnreadable = true; }
  const dep = loadDeployed();
  const stale = !!dep && (now - Number(dep.at || 0) > DEPLOY_TTL_MS);
  const deployed = dep ? { at: dep.at, sig: dep.sig, n: dep.items.length, stale, ...(dep.unreadable ? { unreadable: true } : {}) } : null;
  return { windows: [...local, ...(dep && !stale ? dep.items : [])], localUnreadable, deployed };
}
export function _resetMaintStoreForTest() { _cache = null; _dep = null; _chain = Promise.resolve(); _err.ok(); }
