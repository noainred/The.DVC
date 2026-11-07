/**
 * bmusage/tuning/overrides.js — 역할별 권장값의 **관리자 덮어쓰기**(v2.923 예정 · 리눅스 성능 4단계 · 설계 §4.3 ‘권장 프로파일을 관리자가 설정에서 정한다’).
 * 파일: `<configDir>/bmusage-tuning.json` — `{ v:1, all:{ <역할>:{ <항목 id>: 값|null } }, corps:{ <vCenter id>:{ <역할>:{…} } }, by, at }`.
 *
 *  · 우선순위: **법인 > 전체 > 역할 기본(catalog.js)**. 기능 프로파일(gpdb 등)은 그 위다(judge.js — PROFILES §1 ‘기능 > 역할 > OS’).
 *  · 덮어쓸 수 있는 항목은 카탈로그 `overridable` 뿐(같다/다르다로 판정하는 항목) · 값은 짧은 글자(1~64 · 영숫자와 ._:,+- 공백) · null 은 ‘권장 없음’ · 빈 문자열은 덮어쓰기 해제.
 *  · 파일 스토어 규약(perf-db.md v2.582): 원자 쓰기 · 손상 보존(preserveCorrupt — 조용히 빈 값으로 덮지 않는다) · 손상 상태에서는 **저장 거부**와 **판정 거부**(503 settingsUnreadable —
 *    덮어쓰기를 못 읽은 채 기본값으로 판정하면 관리자가 정한 값을 무시한 결과를 정상처럼 보인다).
 *  · ⚠⚠ 이것은 **판정 기준**이다 — 서버에 적용하는 경로가 아니다(쓰기 경로 없음). 쓰기는 라우트가 정한다(설정 소유자 · 감사 로그).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../../util/atomicWrite.js';
import { makeSettingsLoadError } from '../../util/settingsLoadError.js';
import { ROLES, itemOf } from './catalog.js';

const FILE = () => path.join(config.configDir, 'bmusage-tuning.json');
const VALUE_RE = /^[A-Za-z0-9 ._:,+-]{1,64}$/;
const VC_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const OVERRIDE_MAX = 2_000;

let _cache = null; let _mtime = '';
/*
 * 로드 오류는 공용 코어(util/settingsLoadError.js — v2.631·v2.633)로: 손상이면 보존본으로 옮기고 오류를 세운다 · 파일이 없는데 보존본만 남았으면
 *   (재시작 뒤에도) 여전히 못 읽은 것이다 · 관리자가 저장하거나 서비스 점검에서 ‘기본값으로 확정’ 하면 풀린다. 사유 문구는 원문 조각을 싣지 않는다(safeLoadText).
 */
const _err = makeSettingsLoadError(FILE, { label: '베어메탈 튜닝 권장값 덮어쓰기', confirm: () => writeFile({ v: 1, all: {}, corps: {}, by: 'confirm-default', at: Date.now() }) });
const mtimeOf = () => { try { const st = fs.statSync(FILE()); return `${st.mtimeMs}:${st.size}`; } catch { return ''; } };
export function tuningOverridesLoadError() { load(); return _err.get(); }

/** 역할 → 항목 → 값 맵 정제(모르는 역할 · 항목 · 형식은 버린다). */
function cleanRoleMap(m) {
  const out = {};
  if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
  for (const r of ROLES) {
    const rm = m[r];
    if (!rm || typeof rm !== 'object' || Array.isArray(rm)) continue;
    for (const [id, v] of Object.entries(rm)) {
      if (BAD_KEYS.has(id) || !itemOf(id)?.overridable) continue;
      if (v !== null && !(typeof v === 'string' && VALUE_RE.test(v)) && !(typeof v === 'number' && Number.isFinite(v))) continue;
      (out[r] ||= {})[id] = v === null ? null : String(v);
    }
  }
  return out;
}

function load() {
  const mt = mtimeOf();
  if (_cache && mt === _mtime) return _cache;
  _mtime = mt;
  if (!mt) { _err.missing(); _cache = { v: 1, all: {}, corps: {}, by: '', at: 0 }; return _cache; }
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('객체가 아닙니다');
    const corps = {};
    for (const [vc, m] of Object.entries(raw.corps && typeof raw.corps === 'object' ? raw.corps : {})) {
      if (BAD_KEYS.has(vc) || !VC_RE.test(vc)) continue;
      const c = cleanRoleMap(m);
      if (Object.keys(c).length) corps[vc] = c;
    }
    _cache = { v: 1, all: cleanRoleMap(raw.all), corps, by: String(raw.by || '').slice(0, 64), at: Number(raw.at) || 0 };
    _err.ok();
  } catch (e) {
    preserveCorrupt(FILE(), String(e?.message || e));
    _err.corrupt(e);
    _cache = { v: 1, all: {}, corps: {}, by: '', at: 0 };
    _mtime = mtimeOf();
  }
  return _cache;
}
function writeFile(obj) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  atomicWriteFileSync(FILE(), JSON.stringify(obj, null, 2), { mode: 0o600 });
  _cache = null; _mtime = '';
  _err.ok();
}

/** 전체 사본(관리자 화면 — 범위 계정에는 라우트가 자기 법인만 남긴다). */
export function loadTuningOverrides() { return JSON.parse(JSON.stringify(load())); }

/**
 * 한 서버(역할 · 법인)에 걸리는 덮어쓰기: { 항목 id: { value, by } } — 법인 > 전체.
 * @returns {{ map: object, error: object|null }}
 */
export function overridesFor({ role = 'general', vcenterId = '' } = {}) {
  const cur = load();
  if (_err.get()) return { map: {}, error: _err.get() };
  const map = {};
  for (const [id, v] of Object.entries(cur.all?.[role] || {})) map[id] = { value: v, by: 'override:all' };
  const corp = vcenterId && Object.hasOwn(cur.corps, vcenterId) ? cur.corps[vcenterId] : null;
  for (const [id, v] of Object.entries(corp?.[role] || {})) map[id] = { value: v, by: 'override:corp' };
  return { map, error: null };
}

/**
 * 덮어쓰기 저장(하나). scope: 'all' | vCenter id · role · itemId · value(문자열 · 수 · null=권장 없음 · ''=해제).
 * @returns {{ok:boolean, reason?:string, prev?:*, next?:*}}
 */
export function saveTuningOverride({ scope = 'all', role, itemId, value } = {}, { by = '' } = {}) {
  load();
  if (_err.get()) return { ok: false, unreadable: true, reason: _err.get().reason };
  if (!ROLES.includes(role)) return { ok: false, reason: `역할은 ${ROLES.join(' · ')} 중 하나입니다.` };
  const item = itemOf(itemId);
  if (!item) return { ok: false, reason: '모르는 항목입니다.' };
  if (!item.overridable) return { ok: false, reason: '이 항목은 권장값을 덮어쓸 수 없습니다(같다/다르다로 판정하지 않는 항목).' };
  const sc = String(scope || 'all');
  if (sc !== 'all' && (BAD_KEYS.has(sc) || !VC_RE.test(sc))) return { ok: false, reason: 'scope 는 all 또는 vCenter id 입니다.' };
  const clear = value === '' || value === undefined;
  if (!clear && value !== null && !(typeof value === 'string' && VALUE_RE.test(value)) && !(typeof value === 'number' && Number.isFinite(value))) {
    return { ok: false, reason: '값은 1~64자(영숫자와 ._:,+- 공백) 또는 null(권장 없음)입니다.' };
  }
  if (!clear && value !== null && item.valueKind === 'num' && !Number.isFinite(Number(value))) return { ok: false, reason: '이 항목은 숫자 값입니다.' };
  const cur = JSON.parse(JSON.stringify(_cache));
  const holder = sc === 'all' ? (cur.all ||= {}) : ((cur.corps ||= {})[sc] ||= {});
  const prev = holder[role] && Object.hasOwn(holder[role], itemId) ? holder[role][itemId] : undefined;
  if (clear) { if (holder[role]) delete holder[role][itemId]; }
  else (holder[role] ||= {})[itemId] = value === null ? null : String(value);
  let n = 0;
  for (const m of [cur.all, ...Object.values(cur.corps)]) for (const r of Object.values(m || {})) n += Object.keys(r || {}).length;
  if (n > OVERRIDE_MAX) return { ok: false, reason: `덮어쓰기 상한(${OVERRIDE_MAX})을 넘습니다.` };
  cur.by = String(by || '').slice(0, 64); cur.at = Date.now();
  writeFile(cur);
  return { ok: true, prev: prev === undefined ? null : prev, next: clear ? undefined : (value === null ? null : String(value)), cleared: clear };
}

export function _resetTuningOverridesForTest() { _cache = null; _mtime = ''; _err.ok(); }
