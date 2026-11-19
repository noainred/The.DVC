/**
 * views/insight/treemap.js — 묶음 지도(treemap) 배치 · 색 단계(v3.21.0 · 설계 docs/design/vm-insight §4 · host-insight §9 S6 — 순수 · vitest 고정).
 *
 * 배치: 열 하나 = 묶음(지역 · 클러스터 등) · 열 폭 = 묶음 몫 · 열 안 칸 높이 = 그 묶음 안의 몫(넓이가 값에 정확히 비례한다).
 *  · 열 폭의 합 = 100% · 열마다 칸 높이의 합 = 100%(떠도는 소수는 마지막 열 · 칸이 받는다).
 *  · 크기가 0 · 모름인 칸은 그릴 수 없다 — hidden 으로 돌려준다(화면이 ‘칸 없음 N곳’ 으로 밝힌다 — 조용히 빼지 않는다).
 * 색: 눈금은 **절대값**(steps) — 칸끼리 작은 차이를 부풀리지 않는다. 경계(crit)가 있는 기준만 그 값 이상을 경고색으로(S6).
 */
import { numOrNull } from '../../numOrNull.js';

const cmpItem = (a, b) => (b.size - a.size) || String(a.label ?? a.id).localeCompare(String(b.label ?? b.id)) || String(a.id).localeCompare(String(b.id));

/**
 * @param {Array<{key:string,label?:string,items:Array<{id:string,size:number|null}>}>} groups
 * @returns {{ cols: Array<{key,label,total,left,width,tiles:Array<object>}>, hidden: object[], total: number }}
 *   left · width · top · height 는 % 수(0~100). 열은 합이 큰 순(같으면 이름), 칸은 크기가 큰 순.
 */
export function treemapLayout(groups) {
  const hidden = [];
  const cols = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || typeof g !== 'object') continue;
    const items = [];
    for (const it of Array.isArray(g.items) ? g.items : []) {
      if (!it || typeof it !== 'object') continue;
      const s = numOrNull(it.size);
      if (s == null || s <= 0) hidden.push(it); else items.push({ ...it, size: s });
    }
    if (!items.length) continue;
    items.sort(cmpItem);
    cols.push({ key: g.key, label: g.label ?? g.key, items, total: items.reduce((a, x) => a + x.size, 0) });
  }
  cols.sort((a, b) => (b.total - a.total) || String(a.label).localeCompare(String(b.label)));
  const total = cols.reduce((a, c) => a + c.total, 0);
  let left = 0;
  const out = cols.map((c, ci) => {
    const width = ci === cols.length - 1 ? 100 - left : (c.total / total) * 100;
    const col = { key: c.key, label: c.label, total: c.total, left, width, tiles: [] };
    let top = 0;
    c.items.forEach((it, i) => {
      const height = i === c.items.length - 1 ? 100 - top : (it.size / c.total) * 100;
      col.tiles.push({ ...it, left, width, top, height });
      top += height;
    });
    left += width;
    return col;
  });
  return { cols: out, hidden, total };
}

/** 가장 칸이 많은 열의 칸 수(자동 지도 높이의 기준) — 그릴 칸만 센다. */
export const maxTilesInCol = (layout) => (layout?.cols || []).reduce((m, c) => Math.max(m, c.tiles.length), 0);

/**
 * 색 단계 — steps(오름차순 경계) 중 값 이상인 경계 수(0 ~ steps.length). 모르면 null(회색 — 0 단계가 아니다).
 * crit 가 있으면 그 값 이상은 경고(over:true) — 경계가 정해진 기준(평균 CPU · 메모리)만 넘긴다(S6).
 */
export function fillStep(value, { steps = [], crit = null } = {}) {
  const v = numOrNull(value);
  if (v == null) return { step: null, over: false };
  const c = numOrNull(crit);
  return { step: steps.filter((s) => v >= s).length, over: c != null && v >= c };
}

/** 칸 안 글 — 칸의 실제 높이(px)가 낮으면 한 줄(이름 · 값을 옆으로), 아니면 두 줄. */
export const TILE_TWO_LINE_MIN_PX = 46;
export function tileLineMode(heightPct, mapPx) {
  const h = numOrNull(heightPct); const m = numOrNull(mapPx);
  if (h == null || m == null) return 'two';
  return (h / 100) * m < TILE_TWO_LINE_MIN_PX ? 'one' : 'two';
}

/** 파랑 5단(절대값 눈금) + 경고 빨강. 글자색은 밝은 칸만 검정. */
export const RAMP = Object.freeze(['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec']);
export const CRIT_BG = '#ef4444';
export const NONE_BG = '#3a465e';
export function tileColors({ step, over }) {
  if (over) return { bg: CRIT_BG, ink: '#ffffff' };
  if (step == null) return { bg: NONE_BG, ink: '#e6edf6' };
  const i = Math.max(0, Math.min(RAMP.length - 1, step));
  return { bg: RAMP[i], ink: i >= RAMP.length - 1 ? '#0b0b0b' : '#ffffff' };
}

/** 눈금 범례 글자 — steps [10,20,30,40] → ['10% 미만','10–20%','20–30%','30–40%','40% 이상'] · crit 가 있으면 마지막 칸은 'a–crit%'. */
export function scaleLegend(steps, { unit = '%', crit = null } = {}) {
  const s = Array.isArray(steps) ? steps : [];
  if (!s.length) return [];
  const c = numOrNull(crit);
  const out = [`${s[0]}${unit} 미만`];
  for (let i = 1; i < s.length; i++) out.push(`${s[i - 1]}–${s[i]}${unit}`);
  out.push(c != null ? `${s[s.length - 1]}–${c}${unit}` : `${s[s.length - 1]}${unit} 이상`);
  return out;
}
