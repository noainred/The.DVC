/**
 * svcmon/syncLogic.js — 설정 연동 기술 뷰의 **순수 로직**(v2.915): 패싯 집계 · 필터 · 상태 라벨 · 차트 좌표.
 * React 무의존 — vitest(syncLogic.test.js)가 고정한다. 판정(상태)은 서버(svcmon/settingsSync.js classifyCatalog)가 내려준 값을 그대로 쓴다.
 */

import { numOrNull } from '../../numOrNull.js';

/** 상태 표시 — 서버 SYNC_STATES 와 같은 키. */
export const SYNC_STATE_META = Object.freeze({
  new: { label: '미등록', pill: 'NEW', cls: 'new' },
  linked: { label: '등록됨', pill: 'LINKED', cls: 'ok' },
  changed: { label: '주소 변경', pill: 'CHANGED', cls: 'chg' },
  gone: { label: '설정에서 사라짐', pill: 'GONE', cls: 'gone' },
  held: { label: '판정 보류', pill: 'HELD', cls: 'ex' },
  problem: { label: '설정 문제', pill: 'PROBLEM', cls: 'prob' },
  excluded: { label: '제외', pill: 'EXCLUDED', cls: 'ex' },
});
export const STATE_ORDER = Object.freeze(['new', 'changed', 'gone', 'linked', 'held', 'problem', 'excluded']);
/** 적용(등록·반영·사라짐 처리)할 수 있는 상태. */
export const SELECTABLE = new Set(['new', 'changed', 'gone']);

/** 패싯 축 — 행의 어느 값으로 묶는가. */
export const FACETS = Object.freeze([
  { k: 'state', label: 'STATE', of: (r) => r.state },
  { k: 'kind', label: 'KIND', of: (r) => r.kind },
  { k: 'corp', label: 'CORP', of: (r) => r.corp || '전역' },
  { k: 'edge', label: 'EDGE', of: (r) => r.agent || '중앙(직접)' },
  { k: 'depth', label: 'DEPTH', of: (r) => r.depth || '-' },
]);
const FACET_BY_K = Object.fromEntries(FACETS.map((f) => [f.k, f]));

/** 빈 선택 — 축마다 Set(비면 '전체'). */
export const emptySelection = () => Object.fromEntries(FACETS.map((f) => [f.k, new Set()]));

/** 한 행이 선택(패싯 · 검색어)에 맞는가. exceptK 축은 보지 않는다(그 축의 건수는 자기 선택을 빼고 센다 — Datadog 패싯과 같은 방식). */
export function rowMatches(r, sel, q = '', exceptK = '') {
  for (const f of FACETS) {
    if (f.k === exceptK) continue;
    const s = sel?.[f.k];
    if (s && s.size && !s.has(f.of(r))) return false;
  }
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return true;
  return [r.name, r.host, r.kindLabel, r.corp, r.agent, r.address].some((v) => String(v || '').toLowerCase().includes(needle));
}

export function filterRows(rows = [], sel, q = '') {
  return rows.filter((r) => rowMatches(r, sel, q));
}

/** 축별 값 → 건수(다른 축 선택 · 검색어를 반영). 건수 많은 순, 같으면 이름 순. */
export function facetCounts(rows = [], sel, q = '', labelOf = {}) {
  const out = {};
  for (const f of FACETS) {
    const m = new Map();
    for (const r of rows) {
      if (!rowMatches(r, sel, q, f.k)) continue;
      const v = f.of(r);
      m.set(v, (m.get(v) || 0) + 1);
    }
    // 선택했는데 지금 0건인 값도 남긴다(체크를 풀 수 있어야 한다).
    for (const v of (sel?.[f.k] || [])) if (!m.has(v)) m.set(v, 0);
    const list = [...m.entries()].map(([v, n]) => ({ v, n, label: (labelOf[f.k] && labelOf[f.k](v)) || v }));
    if (f.k === 'state') list.sort((a, b) => STATE_ORDER.indexOf(a.v) - STATE_ORDER.indexOf(b.v));
    else list.sort((a, b) => b.n - a.n || String(a.label).localeCompare(String(b.label)));
    out[f.k] = list;
  }
  return out;
}

/** 템플릿 변수 칩 문구 — 고른 값이 없으면 '*'. */
export function chipValue(sel, k, labelOf = (v) => v) {
  const s = sel?.[k];
  if (!s || !s.size) return '*';
  const vals = [...s].map(labelOf);
  return vals.length > 2 ? `${vals.slice(0, 2).join(',')} +${vals.length - 2}` : vals.join(',');
}

export function toggleFacet(sel, k, v) {
  const next = { ...sel, [k]: new Set(sel?.[k] || []) };
  if (!FACET_BY_K[k]) return sel;
  if (next[k].has(v)) next[k].delete(v); else next[k].add(v);
  return next;
}

/** 스파크라인 점(값 배열 → 'x,y' 문자열). 값이 하나뿐이거나 없으면 ''(그리지 않는다 — 평평한 선을 지어내지 않는다). */
export function sparkPoints(values = [], w = 84, h = 24, pad = 2) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return '';
  const lo = Math.min(...v); const hi = Math.max(...v);
  const span = hi - lo || 1;
  return v.map((x, i) => `${Math.round((i / (v.length - 1)) * w)},${Math.round(h - pad - ((x - lo) / span) * (h - pad * 2))}`).join(' ');
}

/** 누적 막대 — [{at, a, b, c}] → 칸별 사각형(높이 비례). 최댓값 0 이면 빈 배열. */
export function stackedBars(series = [], keys = [], { w = 600, h = 120, left = 34, right = 8, top = 8 } = {}) {
  const n = series.length;
  if (!n) return { bars: [], max: 0 };
  const totals = series.map((s) => keys.reduce((acc, k) => acc + (Number(s[k]) || 0), 0));
  const max = Math.max(...totals);
  if (!(max > 0)) return { bars: [], max: 0 };
  const plotW = w - left - right; const plotH = h - top;
  const bw = Math.max(1, plotW / n - 1);
  const bars = [];
  series.forEach((s, i) => {
    let y = h;
    for (const k of keys) {
      const v = Number(s[k]) || 0;
      if (!v) continue;
      const bh = (v / max) * plotH;
      y -= bh;
      bars.push({ x: left + i * (plotW / n), y, w: bw, h: bh, k, v, at: s.at });
    }
  });
  return { bars, max };
}

/** ms → 짧은 표기. null 이면 '—'(0 으로 쓰지 않는다). */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const n = Number(ms);
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

/**
 * v2.932(점검 D1-08): 서버가 준 주기·창(ms) → '20초' · '5분' · '1분 30초' · '2시간'. 못 읽으면 null(호출부가 숫자 없이 말한다 — 0 이나 기본값을 지어내지 않는다).
 */
export function periodText(ms) {
  const n = numOrNull(ms);
  if (n == null || n <= 0) return null;
  const s = Math.round(n / 1000);
  if (s < 60) return `${Math.max(1, s)}초`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s / 60}분`;
  const m = Math.round(s / 60);
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m / 60}시간`;
}

/** v2.932(점검 D1-08): 설정 연동 감지 주기 문구 — 서버 값(catalog `detect`)만 쓴다. 못 받으면 숫자 없이 말한다. */
export function detectText(detect) {
  const every = periodText(detect?.intervalMs);
  const first = periodText(detect?.firstDelayMs);
  return {
    every,
    empty: every && first ? `포탈 기동 ${first} 뒤부터 ${every}마다 쌓입니다` : '포탈 기동 뒤 주기 감지마다 쌓입니다',
  };
}

/** 경과 시간 표기(서버가 준 ms). */
export function fmtAge(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const s = Math.round(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
