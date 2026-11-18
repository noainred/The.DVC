/**
 * views/insight/insightPrefs.js — 분석 화면의 지도 크기 · 폭 · 묶음 접힘 기억(v3.21.0 · 설계 docs/design/host-insight §10 — 순수 · vitest 고정).
 *
 *  · 브라우저마다 · 화면마다 따로(키는 화면이 준다 — 예 'vmInsight.map'). 읽기 · 쓰기는 try/catch — 못 읽으면 기본값(사생활 창 · 막힌 저장소).
 *  · 저장된 값은 믿지 않는다: 높이는 300 ~ 1,200px · 20px 단위로 다시 자르고 모르는 크기 이름은 기본값으로.
 *  · 미리 정한 크기: 보통 360 · 크게 520(처음) · 아주 크게 760 · 자동 = 가장 긴 묶음의 칸 수 × 64px(360 ~ 1,200).
 */
import { numOrNull } from '../../numOrNull.js';

export const MAP_H_MIN = 300;
export const MAP_H_MAX = 1200;
export const MAP_H_STEP = 20;
export const MAP_AUTO_PER_TILE = 64;
export const MAP_AUTO_MIN = 360;
export const MAP_PRESETS = Object.freeze({ m: 360, l: 520, xl: 760 });
export const MAP_SIZE_KEYS = Object.freeze([['auto', '자동'], ['m', '보통'], ['l', '크게'], ['xl', '아주 크게']]);
export const DEFAULT_MAP_PREFS = Object.freeze({ size: 'l', h: MAP_PRESETS.l, wide: false });

/** 높이 자르기 — 300 ~ 1,200 · 20 단위. 수가 아니면 null(호출부가 기본값). */
export function clampMapH(v) {
  const n = numOrNull(v);
  if (n == null) return null;
  return Math.max(MAP_H_MIN, Math.min(MAP_H_MAX, Math.round(n / MAP_H_STEP) * MAP_H_STEP));
}
/** 자동 높이 — 가장 긴 묶음의 칸 수 × 64 를 360 ~ 1,200 로. 칸이 없으면 360. */
export function autoMapHeight(maxTiles) {
  const n = Math.max(0, numOrNull(maxTiles) ?? 0);
  return Math.max(MAP_AUTO_MIN, Math.min(MAP_H_MAX, n * MAP_AUTO_PER_TILE));
}
/** 저장된 값 정리 — { size: auto|m|l|xl|custom, h, wide }. */
export function normMapPrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const size = ['auto', 'm', 'l', 'xl', 'custom'].includes(r.size) ? r.size : DEFAULT_MAP_PREFS.size;
  const h = clampMapH(r.h) ?? (MAP_PRESETS[size] || DEFAULT_MAP_PREFS.h);
  return { size, h, wide: r.wide === true };
}
/** 지금 그릴 높이(px). */
export function mapHeightOf(prefs, maxTiles) {
  const p = normMapPrefs(prefs);
  if (p.size === 'auto') return autoMapHeight(maxTiles);
  if (p.size === 'custom') return p.h;
  return MAP_PRESETS[p.size];
}
/** 크기 이름을 고른 뒤의 값(h 는 그 크기의 높이 — 이어서 ＋/− 를 누르면 거기서부터). */
export function pickMapSize(prefs, size, maxTiles) {
  const p = normMapPrefs(prefs);
  const s = ['auto', 'm', 'l', 'xl'].includes(size) ? size : p.size;
  return { ...p, size: s, h: s === 'auto' ? autoMapHeight(maxTiles) : MAP_PRESETS[s] };
}
/** 높이를 직접 정한 값(＋ · − · 슬라이더 · ← →). */
export function setMapH(prefs, h) {
  const p = normMapPrefs(prefs);
  const v = clampMapH(h);
  return v == null ? p : { ...p, size: 'custom', h: v };
}

function storageOf(storage) {
  if (storage) return storage;
  try { return typeof globalThis !== 'undefined' ? globalThis.localStorage || null : null; } catch { return null; }
}
/** JSON 읽기 — 없거나 못 읽으면 null. */
export function readPref(key, storage) {
  try {
    const s = storageOf(storage);
    if (!s) return null;
    const v = s.getItem(key);
    return v == null ? null : JSON.parse(v);
  } catch { return null; }
}
/** JSON 쓰기 — 실패해도 던지지 않는다(false). */
export function writePref(key, value, storage) {
  try {
    const s = storageOf(storage);
    if (!s) return false;
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}
export const loadMapPrefs = (key, storage) => normMapPrefs(readPref(key, storage));
export const saveMapPrefs = (key, prefs, storage) => writePref(key, normMapPrefs(prefs), storage);

/** 묶음 접힘 — { 묶음키: true(접힘) }. 모르는 키 · 참이 아닌 값은 버린다(처음은 전부 펼침). */
export function normFolded(raw, keys) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of Array.isArray(keys) ? keys : []) if (r[k] === true) out[k] = true;
  return out;
}
export const loadFolded = (key, keys, storage) => normFolded(readPref(key, storage), keys);
export const saveFolded = (key, folded, keys, storage) => writePref(key, normFolded(folded, keys), storage);
