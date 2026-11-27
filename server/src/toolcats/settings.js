/**
 * toolcats/settings.js — 특수 기능 카테고리 설정 (`tool-categories.json`, v2.455).
 *
 * 비밀 값이 없는 표시 설정이라 봉인 대상이 아니다. 다만 손상 시 조용히 빈 값으로 넘기면
 * 다음 저장이 관리자가 공들여 만든 분류를 통째로 지우므로, 다른 스토어와 같이
 * 원자적 쓰기 + `preserveCorrupt` 를 지킨다.
 *
 * 기본은 **꺼짐**이다 — 업그레이드만으로 특수 기능 화면 배치가 바뀌면 안 된다.
 * 관리자가 설정에서 켜고 '추천 분류로 시작' 을 누르거나 직접 카테고리를 만든다.
 */
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt, safeLoadText } from '../util/atomicWrite.js';
import { makeJsonFileReader } from '../util/jsonFileRead.js';   // 107회차: 읽기 오류 ≠ 손상(공용 읽기 — 30초 간격 재읽기)
import { normCategory, MAX_CATEGORIES, PRESET, normStages, normOverrides, pruneStageRefs, STAGE_DISPLAYS, DEFAULT_STAGES } from './catalog.js';
import { parseJsonObject } from '../util/jsonObject.js'; // v3.17.2: 객체가 아닌 JSON(수 · 글자 · 배열)은 깨진 JSON 과 같이 — 손상 보존 경로로

const FILE = path.join(config.configDir, 'tool-categories.json');

export const DEFAULTS = Object.freeze({
  enabled: false,             // 켜기 전에는 기존 단일 그리드 그대로
  categories: [],
  showUncategorized: true,    // 분류 안 된 도구를 '기타' 로 보여준다(사라지지 않게)
  collapseOthers: false,      // 첫 카테고리만 펼치고 나머지는 접어서 시작
  // v2.679: 개발 단계 축 — null 이면 단계 UI 를 숨긴다(업그레이드로 자동으로 켜지지 않는다).
  stages: null,
  overrides: {},              // 기능 키 → { label?, desc?, stage? } — 화면 표시만 바꾼다
  stageDisplay: 'badge',      // 'badge'(색 배지) | 'suffix'(이름 뒤에 '(개발중)')
});

let cache = null;
/*
 * 107회차(재현 — EISDIR): 읽기 오류(EACCES · EIO · EISDIR)는 손상이 아니다 — 예전 catch 하나는 온전한 원본을 .corrupt 로 옮기고 빈 값 · 기본값을 캐시해
 *   다음 저장이 원본 자리를 덮었다. 읽기 단계는 공용 읽기: 원본을 두고 · 캐시하지 않고(30초 간격 재읽기) · 저장을 거절한다(503 settingsUnreadable). parse 실패는 예전과 같다.
 */
const _reader = makeJsonFileReader(() => FILE, { parse: (t) => t, preserve: false, tag: 'tool-categories' });
let _readErr = '';
/** 107회차: 읽기 오류 중의 저장 거절 본문(503) 또는 null. */
export function toolCatsWriteRefusal() {
  load();
  return _readErr ? { ok: false, status: 503, code: 'settingsUnreadable', readError: true, reason: `특수 기능 분류 설정 파일(${path.basename(FILE)})을 읽지 못해 저장하지 않았습니다 — 읽기 오류(${_readErr})이고 원본은 그대로 있습니다. 파일 권한 · 소유자 · 디스크를 확인하세요(30초마다 다시 읽고, 읽히면 저장이 다시 열립니다).` } : null;
}

export function load() {
  if (cache) return cache;
  const rr = _reader.read();
  if (rr.kind === 'read-error') { _readErr = String(rr.error?.code || 'read-error').slice(0, 32); return structuredClone(DEFAULTS); }   // 107회차: 캐시하지 않는다 — 쓰기는 거절한다
  _readErr = '';
  const out = structuredClone(DEFAULTS);
  try {
    if (rr.kind === 'ok') {
      const p = parseJsonObject(rr.value);
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (typeof p.showUncategorized === 'boolean') out.showUncategorized = p.showUncategorized;
      if (typeof p.collapseOthers === 'boolean') out.collapseOthers = p.collapseOthers;
      if (Array.isArray(p.categories)) out.categories = p.categories.slice(0, MAX_CATEGORIES).map(normCategory);
      out.stages = normStages(p.stages);
      out.overrides = pruneStageRefs(normOverrides(p.overrides), out.stages).overrides;
      if (STAGE_DISPLAYS.includes(p.stageDisplay)) out.stageDisplay = p.stageDisplay;
    }
  } catch (e) {
    preserveCorrupt(FILE);
    console.warn(`[toolcats] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${safeLoadText(e) || '사유 미상'}`);
  }
  cache = out;
  return cache;
}

/** info(선택) — 호출부가 받는 부가 정보: stageRefsCleared(지운 단계를 가리켜 기본 단계로 옮긴 기능 수). */
export function save(body = {}, info = {}) {
  const cur = load();
  { const no = toolCatsWriteRefusal(); if (no) throw Object.assign(new Error(no.reason), no, { extra: { code: no.code, readError: true } }); }   // 107회차: 읽기 오류 중에는 빈 값 · 기본값 위에 쓰지 않는다

  const next = structuredClone(cur);
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (typeof body.showUncategorized === 'boolean') next.showUncategorized = body.showUncategorized;
  if (typeof body.collapseOthers === 'boolean') next.collapseOthers = body.collapseOthers;
  if (Array.isArray(body.categories)) next.categories = body.categories.slice(0, MAX_CATEGORIES).map(normCategory);
  // v2.679: stages 는 null(끄기)도 명시값이다 — 키가 있을 때만 바꾼다.
  if (Object.hasOwn(body, 'stages')) next.stages = normStages(body.stages);
  if (Object.hasOwn(body, 'overrides')) next.overrides = normOverrides(body.overrides);
  if (STAGE_DISPLAYS.includes(body.stageDisplay)) next.stageDisplay = body.stageDisplay;
  // 지운 단계를 가리키던 기능은 기본 단계로 간다(stage 만 지운다 — 이름·설명은 그대로).
  const pr = pruneStageRefs(next.overrides, next.stages);
  next.overrides = pr.overrides;
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  info.stageRefsCleared = pr.cleared;
  return next;
}

export function invalidate() { cache = null; _reader.reset(); _readErr = ''; }

/** '추천 분류로 시작' — 프리셋을 그대로 정규화해 돌려준다(저장은 호출부가 한다). */
export function presetCategories() { return PRESET.map(normCategory); }

/** '개발 단계 사용 시작' 이 쓰는 기본 단계(저장은 호출부가 한다). */
export function defaultStages() { return DEFAULT_STAGES.map((s) => ({ ...s })); }

export const _FILE = FILE;
