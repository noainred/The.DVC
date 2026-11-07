/**
 * bmusage/annotations.js — 리눅스 성능 6단계 **운영 주석**(설계 PROFILES §16 A · 아트보드 Annot) 저장소.
 *
 * ‘사람이 쓰는 데이터는 중앙’ — 이 파일은 화면을 내주는 노드(중앙)의 `bm-perf-annotations.json` 이고 엣지에 두지 않는다.
 *   주석 = 시각(또는 범위) · 종류(작업 · 변경 · 외부 요인 · 사고/복구 · 메모) · 내용(500자 · 제어 · 양방향 · 폭 없는 문자 제거) · 대상(서버 1대 · 여러 대 · 법인 전체) ·
 *   연결(이슈 키 · 위키 문서 · 집중 세션 · 백업 작업 이름) · 작성자 · 시각 자동 · 수정 이력(최근 20) · 삭제는 흔적(삭제됨 · 누가 · 언제 — 내용 · 이력은 지운다).
 * 파일 스토어 규약(perf-db.md v2.582): 원자 쓰기 · 손상 보존 · 손상이면 **읽기 503 · 쓰기 거부**(빈 목록으로 덮어 모두의 주석을 지우지 않는다) ·
 *   읽기-수정-쓰기는 **한 동기 구간**(await 없음 — 동시 요청이 서로의 저장을 덮지 않는다) · 상한(5,000 — 넘으면 가장 오래된 ‘삭제됨’ 흔적부터 비우고 그래도 넘치면 409).
 * 권한 · 범위는 라우트(routes/api/bmAnnotations.js)가 본다 — 이 모듈은 형식과 저장만.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { makeSettingsLoadError } from '../util/settingsLoadError.js';

const FILE = () => path.join(config.configDir, 'bm-perf-annotations.json');
export const ANNOT_KINDS = Object.freeze(['work', 'change', 'external', 'incident', 'memo']);
export const ANNOT_MAX = 5_000;
export const TEXT_MAX = 500;
export const EDITS_MAX = 20;
export const TARGET_KEYS_MAX = 8;
export const SPAN_MAX_MS = 31 * 86_400_000;
export const PAST_MAX_MS = 400 * 86_400_000;
export const FUTURE_MAX_MS = 7 * 86_400_000;
const CTRL = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');
const ISSUE_RE = /^ISS-\d{1,9}$/;
const WIKI_ID_RE = /^W\d{1,9}$/;
const SPACE_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const FOCUS_ID_RE = /^[A-Za-z0-9-]{4,40}$/;
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

const _err = makeSettingsLoadError(FILE, { label: '베어메탈 성능 운영 주석', confirm: () => writeAll({ v: 1, seq: 0, items: [] }) });
function fail(status, code, reason, field = null) { const e = new Error(reason); e.status = status; e.code = code; if (field) e.field = field; return e; }
/** 내용 정제(순수) — 제어 · 양방향 · 폭 없는 문자 제거(줄바꿈 · 탭은 남긴다) · 앞뒤 공백 · 상한. */
export function cleanText(v, max = TEXT_MAX) {
  if (typeof v !== 'string') return '';
  return v.replace(CTRL, '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}
/** 연결 정제(순수) — 형식 밖은 400(조용히 버리지 않는다). 연결은 권한을 주지 않는다(여는 사람의 권한으로 본다). */
export function cleanLinks(v) {
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw fail(400, 'bad-links', '연결 형식이 다릅니다.', 'links');
  const out = {};
  if (v.issue != null && v.issue !== '') { const s = String(v.issue).trim(); if (!ISSUE_RE.test(s)) throw fail(400, 'bad-links', '이슈 키는 ISS-번호 형식입니다.', 'links.issue'); out.issue = s; }
  if (v.wiki != null && v.wiki !== '') {
    const w = typeof v.wiki === 'object' ? v.wiki : null;
    if (!w || !WIKI_ID_RE.test(String(w.id || '')) || !SPACE_RE.test(String(w.space || ''))) throw fail(400, 'bad-links', '위키 문서는 스페이스와 W번호입니다.', 'links.wiki');
    out.wiki = { space: String(w.space), id: String(w.id) };
  }
  if (v.focus != null && v.focus !== '') { const s = String(v.focus).trim(); if (!FOCUS_ID_RE.test(s)) throw fail(400, 'bad-links', '집중 세션 id 형식이 다릅니다.', 'links.focus'); out.focus = s; }
  if (v.backup != null && v.backup !== '') { const s = cleanText(String(v.backup), 120); if (!s) throw fail(400, 'bad-links', '백업 작업 이름이 비었습니다.', 'links.backup'); out.backup = s; }
  return out;
}
/** 시각 · 범위 검사(순수). */
export function cleanSpan({ at, end = null, now = Date.now() } = {}) {
  const a = Number(at);
  if (!Number.isFinite(a) || a < now - PAST_MAX_MS || a > now + FUTURE_MAX_MS) throw fail(400, 'bad-time', '시각이 범위 밖입니다(지난 400일 ~ 앞 7일).', 'at');
  if (end == null || end === '') return { at: Math.round(a), end: null };
  const e = Number(end);
  if (!Number.isFinite(e) || e < a || e - a > SPAN_MAX_MS || e > now + FUTURE_MAX_MS) throw fail(400, 'bad-time', '끝 시각은 시작 뒤 · 31일 안이어야 합니다.', 'end');
  return { at: Math.round(a), end: Math.round(e) };
}
function writeAll(obj) { atomicWriteFileSync(FILE(), JSON.stringify(obj), { mode: 0o600 }); _err.ok(); }
function loadAll() {
  let raw;
  try { raw = fs.readFileSync(FILE(), 'utf8'); }
  catch (e) {
    if (e?.code !== 'ENOENT') throw fail(503, 'settingsUnreadable', '운영 주석 파일을 읽지 못했습니다.');
    _err.missing();
    if (_err.get()) throw fail(503, 'settingsUnreadable', _err.get().reason);
    return { v: 1, seq: 0, items: [] };
  }
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o) || !Array.isArray(o.items)) throw new Error('형식이 다릅니다');
    _err.ok();
    return { v: 1, seq: Number(o.seq) || 0, items: o.items.filter((x) => x && typeof x === 'object' && typeof x.id === 'string') };
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    console.warn('[bmusage] bm-perf-annotations.json 을 읽지 못했습니다 — 손상본을 보존했고, 확정 전까지 운영 주석 읽기 · 쓰기를 멈춥니다');
    throw fail(503, 'settingsUnreadable', _err.get()?.reason || '운영 주석 파일을 읽지 못했습니다.');
  }
}
const copy = (x) => JSON.parse(JSON.stringify(x));

/** 전부(사본 — 라우트가 범위 · 창 · 대상으로 거른다). */
export function listAnnotations() { return loadAll().items.map(copy); }
export function getAnnotation(id) { const x = loadAll().items.find((a) => a.id === String(id)); return x ? copy(x) : null; }

/**
 * 만들기 — 대상은 라우트가 범위 검사를 마친 것({ type, keys, names, vcenterIds }). 형식 밖은 400 · 상한 409.
 */
export function addAnnotation({ by, at, end = null, kind, text, target, links = null, auto = '', now = Date.now() } = {}) {
  if (!ANNOT_KINDS.includes(kind)) throw fail(400, 'bad-kind', `종류는 ${ANNOT_KINDS.join(' · ')} 중 하나입니다.`, 'kind');
  const body = cleanText(text);
  if (!body) throw fail(400, 'bad-text', '내용이 필요합니다.', 'text');
  const span = cleanSpan({ at, end, now });
  const lk = cleanLinks(links);
  const tg = target && typeof target === 'object' ? target : null;
  if (!tg || !['server', 'servers', 'corp'].includes(tg.type)) throw fail(400, 'bad-target', '대상이 필요합니다.', 'target');
  const keys = (Array.isArray(tg.keys) ? tg.keys : []).map(String).slice(0, TARGET_KEYS_MAX);
  const vcs = [...new Set((Array.isArray(tg.vcenterIds) ? tg.vcenterIds : []).map(String))].filter((v) => v === '' || VC_RE.test(v)).slice(0, TARGET_KEYS_MAX);
  if (tg.type !== 'corp' && !keys.length) throw fail(400, 'bad-target', '대상 서버가 필요합니다.', 'target');
  if (tg.type === 'corp' && (vcs.length !== 1 || !vcs[0])) throw fail(400, 'bad-target', '법인 전체 주석은 법인 하나입니다.', 'target');
  // ── 동기 구간(load → 수정 → 쓰기 · await 없음) ──
  const all = loadAll();
  if (all.items.length >= ANNOT_MAX) {
    const i = all.items.findIndex((x) => x.deleted);
    if (i < 0) throw fail(409, 'cap', `운영 주석이 상한(${ANNOT_MAX})에 찼습니다 — 오래된 주석을 지우세요.`);
    all.items.splice(i, 1);
  }
  all.seq += 1;
  const rec = {
    id: `A${all.seq}-${crypto.randomBytes(3).toString('hex')}`, created: now, by: String(by || '').slice(0, 64), ...span, kind, text: body,
    target: { type: tg.type, keys, names: (Array.isArray(tg.names) ? tg.names : []).map((x) => cleanText(String(x ?? ''), 120)).slice(0, TARGET_KEYS_MAX), vcenterIds: vcs },
    links: lk, edits: [], ...(auto ? { auto: String(auto).slice(0, 16) } : {}),
  };
  all.items.push(rec);
  writeAll(all);
  return copy(rec);
}
/** 고치기 — 시각 · 종류 · 내용 · 연결만(대상은 바꾸지 않는다 — 범위가 바뀌는 쓰기를 만들지 않는다). 이전 값은 이력에. */
export function editAnnotation(id, patch = {}, { by = '', now = Date.now() } = {}) {
  const all = loadAll();
  const rec = all.items.find((x) => x.id === String(id));
  if (!rec || rec.deleted) throw fail(404, 'not-found', '그 주석을 찾지 못했습니다.');
  const fields = []; const prev = {};
  if (patch.kind !== undefined) { if (!ANNOT_KINDS.includes(patch.kind)) throw fail(400, 'bad-kind', '종류 형식이 다릅니다.', 'kind'); if (patch.kind !== rec.kind) { prev.kind = rec.kind; rec.kind = patch.kind; fields.push('kind'); } }
  if (patch.text !== undefined) { const b = cleanText(patch.text); if (!b) throw fail(400, 'bad-text', '내용이 필요합니다.', 'text'); if (b !== rec.text) { prev.text = rec.text; rec.text = b; fields.push('text'); } }
  if (patch.at !== undefined || patch.end !== undefined) {
    const sp = cleanSpan({ at: patch.at !== undefined ? patch.at : rec.at, end: patch.end !== undefined ? patch.end : rec.end, now });
    if (sp.at !== rec.at || sp.end !== rec.end) { prev.at = rec.at; prev.end = rec.end; Object.assign(rec, sp); fields.push('time'); }
  }
  if (patch.links !== undefined) { const lk = cleanLinks(patch.links); if (JSON.stringify(lk) !== JSON.stringify(rec.links || {})) { prev.links = rec.links || {}; rec.links = lk; fields.push('links'); } }
  if (!fields.length) return copy(rec);
  rec.edits = [...(rec.edits || []), { at: now, by: String(by).slice(0, 64), fields, prev }].slice(-EDITS_MAX);
  writeAll(all);
  return copy(rec);
}
/** 지우기 — 흔적(삭제됨 · 누가 · 언제 · 종류 · 시각 · 대상)은 남기고 내용 · 연결 · 이력 내용은 지운다. */
export function deleteAnnotation(id, { by = '', now = Date.now() } = {}) {
  const all = loadAll();
  const rec = all.items.find((x) => x.id === String(id));
  if (!rec || rec.deleted) throw fail(404, 'not-found', '그 주석을 찾지 못했습니다.');
  rec.deleted = { at: now, by: String(by).slice(0, 64) };
  rec.text = ''; rec.links = {}; rec.edits = (rec.edits || []).map((e) => ({ at: e.at, by: e.by, fields: e.fields }));
  writeAll(all);
  return copy(rec);
}
export function annotationsLoadError() { try { loadAll(); } catch { /* get 이 말한다 */ } return _err.get(); }
