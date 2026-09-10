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
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { normCategory, MAX_CATEGORIES, PRESET } from './catalog.js';

const FILE = path.join(config.configDir, 'tool-categories.json');

export const DEFAULTS = Object.freeze({
  enabled: false,             // 켜기 전에는 기존 단일 그리드 그대로
  categories: [],
  showUncategorized: true,    // 분류 안 된 도구를 '기타' 로 보여준다(사라지지 않게)
  collapseOthers: false,      // 첫 카테고리만 펼치고 나머지는 접어서 시작
});

let cache = null;

export function load() {
  if (cache) return cache;
  const out = structuredClone(DEFAULTS);
  try {
    if (fs.existsSync(FILE)) {
      const p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
      if (typeof p.enabled === 'boolean') out.enabled = p.enabled;
      if (typeof p.showUncategorized === 'boolean') out.showUncategorized = p.showUncategorized;
      if (typeof p.collapseOthers === 'boolean') out.collapseOthers = p.collapseOthers;
      if (Array.isArray(p.categories)) out.categories = p.categories.slice(0, MAX_CATEGORIES).map(normCategory);
    }
  } catch (e) {
    preserveCorrupt(FILE);
    console.warn(`[toolcats] 설정 로드 실패 — 원본을 .corrupt 로 보존하고 기본값으로 시작합니다: ${e.message}`);
  }
  cache = out;
  return cache;
}

export function save(body = {}) {
  const cur = load();
  const next = structuredClone(cur);
  if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
  if (typeof body.showUncategorized === 'boolean') next.showUncategorized = body.showUncategorized;
  if (typeof body.collapseOthers === 'boolean') next.collapseOthers = body.collapseOthers;
  if (Array.isArray(body.categories)) next.categories = body.categories.slice(0, MAX_CATEGORIES).map(normCategory);
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  cache = next;
  return next;
}

export function invalidate() { cache = null; }

/** '추천 분류로 시작' — 프리셋을 그대로 정규화해 돌려준다(저장은 호출부가 한다). */
export function presetCategories() { return PRESET.map(normCategory); }

export const _FILE = FILE;
