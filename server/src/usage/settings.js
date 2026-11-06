/**
 * usage/settings.js — 기능 사용 추적 설정(v2.913). 파일 `usage-settings.json`(CONFIG_DIR, 비밀 없음).
 *
 * 값: { enabled, idleMin, keepDays, excluded[], noticeEnabled, notice(null = 기본 문구), toggles[{at,by,on}], updatedAt, updatedBy }
 *  · **기본 꺼짐**(사용자 결정 2026-11-06 · 설계 §5 ⑥) — 설치 직후에는 아무것도 세지 않는다. 설정 소유자가 켠다.
 *  · `toggles` 는 켜고 끈 기록(최근 200건)이다 — 화면의 '꺼져 있던 구간' 띠와 추이의 빗금 막대, '하루 평균' 의 분모(기록이 켜져 있던 날)의 근거.
 *  · 데모 계정(thedvcdemp)은 기본 제외(§5 ⑦).
 *  · 손상 파일은 보존(`.corrupt.<시각>`)하고 **꺼짐으로 읽는다**(fail-closed — 못 읽은 설정으로 기록하지 않는다). 화면은 `loadError` 로 그 사실을 말하고
 *    조회 라우트는 503 `settingsUnreadable` 로 답한다(빈 설정을 내려보내지 않는다 — 루트 CLAUDE.md '설정을 못 읽었으면 503').
 *  · 저장은 라우트가 설정 소유자(소유자 ∧ 전체 범위)로 막는다. 상한은 거부다(제외 계정 200 · 이름 64자 · 고지 문구 600자).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeLoadError } from '../util/registryCore.js';

export const USAGE_LIMITS = Object.freeze({ excluded: 200, name: 64, notice: 600, toggles: 200 });
export const IDLE_MIN_RANGE = Object.freeze([1, 30]);
export const KEEP_DAYS_RANGE = Object.freeze([90, 1825]);
export const DEMO_ACCOUNT = 'thedvcdemp';

const fileOf = () => path.join(config.configDir, 'usage-settings.json');

export function defaultUsageSettings() {
  return { enabled: false, idleMin: 5, keepDays: 180, excluded: [DEMO_ACCOUNT], noticeEnabled: true, notice: null, toggles: [], updatedAt: null, updatedBy: null };
}

/** 기본 고지 문구 — 보관 일수를 지금 값으로 넣는다(문구와 설정이 어긋나지 않게). */
export function defaultNotice(keepDays) {
  return `이 포탈은 어느 화면을 얼마나 쓰는지(열람 횟수 · 머문 시간)를 계정별로 기록해 UI 개선에 씁니다. 입력한 내용 · 검색어 · 조회한 데이터는 기록하지 않습니다. 기록은 설정 소유자만 보며 ${keepDays}일 뒤 지워집니다.`;
}

function fieldError(field, msg) { const e = new Error(`${field}: ${msg}`); e.status = 400; e.field = field; return e; }
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\s\u0000-\u001f\u007f]{1,64}$/;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** 계정 이름 → 비교 키(trim · 소문자). 비교는 이 값으로만 한다(AD 계정의 대소문자 변형 — usermenu/store.js 와 같은 판단). */
export const userKeyOf = (u) => (typeof u === 'string' ? u.trim().toLowerCase() : '');

const intIn = (v, [lo, hi]) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v) : NaN);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
};

/**
 * 저장 본문(또는 파일)을 좁힌다. strict=false 면 형식 밖 항목을 버린다(파일 읽기) · true 면 400(저장).
 * toggles·updatedAt·updatedBy 는 파일에서만 읽는다(본문 값은 무시 — 저장 경로가 직접 붙인다).
 */
export function normalizeUsageSettings(raw, { strict = true, fromFile = false } = {}) {
  const d = defaultUsageSettings();
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...d };
  if (r.enabled !== undefined) out.enabled = r.enabled === true;
  if (r.idleMin !== undefined) {
    const n = intIn(r.idleMin, IDLE_MIN_RANGE);
    if (n == null) { if (strict) throw fieldError('idleMin', `${IDLE_MIN_RANGE[0]}~${IDLE_MIN_RANGE[1]} 분 정수여야 합니다`); } else out.idleMin = n;
  }
  if (r.keepDays !== undefined) {
    const n = intIn(r.keepDays, KEEP_DAYS_RANGE);
    if (n == null) { if (strict) throw fieldError('keepDays', `${KEEP_DAYS_RANGE[0]}~${KEEP_DAYS_RANGE[1]} 일 정수여야 합니다`); } else out.keepDays = n;
  }
  if (r.excluded !== undefined) {
    const list = Array.isArray(r.excluded) ? r.excluded : null;
    if (!list) { if (strict) throw fieldError('excluded', '계정 이름 배열이어야 합니다'); }
    else {
      if (list.length > USAGE_LIMITS.excluded && strict) throw fieldError('excluded', `제외 계정은 ${USAGE_LIMITS.excluded}개까지입니다`);
      const seen = new Set();
      const ex = [];
      for (const v of list.slice(0, USAGE_LIMITS.excluded)) {
        const s = typeof v === 'string' ? v.trim() : '';
        if (!NAME_RE.test(s)) { if (strict) throw fieldError('excluded', '공백 없는 64자 이하의 계정명이어야 합니다'); continue; }
        const k = userKeyOf(s);
        if (seen.has(k)) continue;
        seen.add(k); ex.push(s);
      }
      out.excluded = ex;
    }
  }
  if (r.noticeEnabled !== undefined) out.noticeEnabled = r.noticeEnabled !== false;
  if (r.notice !== undefined) {
    if (r.notice === null || r.notice === '') out.notice = null;
    else if (typeof r.notice !== 'string' || CTRL_RE.test(r.notice)) { if (strict) throw fieldError('notice', '문구는 제어 문자 없는 글이어야 합니다'); }
    else {
      const s = r.notice.trim();
      if (s.length > USAGE_LIMITS.notice) { if (strict) throw fieldError('notice', `문구는 ${USAGE_LIMITS.notice}자까지입니다`); out.notice = s.slice(0, USAGE_LIMITS.notice); }
      else out.notice = s || null;
    }
  }
  if (fromFile) {
    const tg = Array.isArray(r.toggles) ? r.toggles : [];
    out.toggles = tg.filter((t) => t && Number.isFinite(t.at) && typeof t.on === 'boolean')
      .map((t) => ({ at: t.at, on: t.on, by: typeof t.by === 'string' ? t.by.slice(0, 64) : '' }))
      .sort((a, b) => a.at - b.at).slice(-USAGE_LIMITS.toggles);
    out.updatedAt = Number.isFinite(r.updatedAt) ? r.updatedAt : null;
    out.updatedBy = typeof r.updatedBy === 'string' ? r.updatedBy.slice(0, 64) : null;
  }
  return out;
}

let cache = null;
const loadErr = makeLoadError();

/** 설정 읽기(캐시). 손상이면 보존하고 **꺼짐**으로 돌려준다(`loadError` 가 선다). */
export function loadUsageSettings() {
  if (cache) return cache;
  const f = fileOf();
  loadErr.clear();
  try {
    if (fs.existsSync(f)) cache = normalizeUsageSettings(JSON.parse(fs.readFileSync(f, 'utf8')), { strict: false, fromFile: true });
    else cache = defaultUsageSettings();
  } catch (e) {
    preserveCorrupt(f, e?.message);
    loadErr.set(safeLoadText(e?.message));
    cache = { ...defaultUsageSettings(), enabled: false };
  }
  loadErr.checkCorruptOnly(f);
  if (loadErr.get()) cache = { ...cache, enabled: false };
  return cache;
}

/** 못 읽음 표지 — null 이면 정상. */
export function usageSettingsLoadError() { loadUsageSettings(); return loadErr.get(); }

/** 고지 문구(기본 문구면 보관 일수를 넣어서). */
export function noticeText(s = loadUsageSettings()) { return s.notice || defaultNotice(s.keepDays); }

/**
 * 저장. 본문에 있는 키만 바꾸고(없는 키는 유지) 켜기/끄기가 바뀌면 toggles 에 한 줄 더한다.
 * @returns {{ settings: object, changes: string[] }} changes = 감사 로그에 남길 '무엇이 어떻게' 요약
 */
export function saveUsageSettings(body, by, now = Date.now()) {
  const cur = loadUsageSettings();
  const patch = normalizeUsageSettings(body, { strict: true });
  const next = { ...cur };
  const changes = [];
  for (const k of ['enabled', 'idleMin', 'keepDays', 'noticeEnabled', 'notice', 'excluded']) {
    if (body?.[k] === undefined) continue;
    const a = JSON.stringify(cur[k]); const b = JSON.stringify(patch[k]);
    if (a === b) continue;
    next[k] = patch[k];
    changes.push(k === 'notice' ? 'notice 변경' : k === 'excluded' ? `excluded ${cur.excluded.length}→${patch.excluded.length}개` : `${k} ${a}→${b}`);
  }
  const who = typeof by === 'string' ? by.slice(0, 64) : '';
  if (next.enabled !== cur.enabled) next.toggles = [...(cur.toggles || []), { at: now, on: next.enabled, by: who }].slice(-USAGE_LIMITS.toggles);
  next.updatedAt = now; next.updatedBy = who;
  atomicWriteFileSync(fileOf(), JSON.stringify(next, null, 2));
  cache = next;
  loadErr.clear();
  return { settings: next, changes };
}

/**
 * 기록이 켜져 있던 구간(epoch ms) — toggles 로 만든다. 켜진 채 끝나면 to=Infinity.
 * toggles 가 비었는데 켜져 있으면(손으로 고친 파일) 시작을 알 수 없으므로 from=-Infinity 로 본다 — 지어내지 않는다.
 * @returns {{from:number, to:number}[]}
 */
export function onIntervals(s = loadUsageSettings()) {
  const tg = Array.isArray(s.toggles) ? s.toggles : [];
  if (!tg.length) return s.enabled ? [{ from: -Infinity, to: Infinity }] : [];
  const out = [];
  // 첫 기록이 '끔' 이면 그 전에는 켜져 있었다(손으로 켠 파일) — 시작 시각은 모른다.
  if (!tg[0].on) out.push({ from: -Infinity, to: tg[0].at });
  let open = null;
  for (const t of tg) {
    if (t.on && open == null) open = t.at;
    else if (!t.on && open != null) { out.push({ from: open, to: t.at }); open = null; }
  }
  if (open != null) out.push({ from: open, to: Infinity });
  return out;
}

/** 테스트용 — 캐시를 비운다(파일은 그대로). */
export function _resetUsageSettingsCache() { cache = null; loadErr.clear(); }
