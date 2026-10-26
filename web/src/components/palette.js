/**
 * components/palette.js — 헤더 ⌘K 기능 찾기의 후보 목록과 매칭(v2.508, 순수).
 *
 * 팔레트는 두 종류를 한 목록에서 찾는다:
 *   · 기능(tool) → 특수 기능 도구 화면(#/tools/<k>)
 *   · 탭(tab)    → 상단 메뉴 탭(#/<id>)
 *
 * v2.747: V4·V5·V6 셸을 지우면서 version_4/palette.js 에서 옮겼다. 예전에는 V4 메뉴 트리(version_4/tree.js)가
 *   도구 분류명과 탭 목록을 정했다 — 지금은 분류명을 **특수 기능 카테고리 설정**(/admin/tool-categories, 카드 그리드와
 *   같은 출처)에서, 탭은 **호출자가 넘기는 보이는 탭**(App 의 visibleTabs — 권한으로 걸러진 것)에서 받는다.
 *   새 도구를 넣을 때 따로 고칠 목록이 없다.
 *
 * 매칭 규칙은 특수 기능 카드 그리드와 **같은 모듈**(views/toolSearch.js)을 쓴다 — 두 곳이
 * 다르게 동작하면 "카드에선 찾아지는데 팔레트에선 안 찾아진다" 가 된다.
 * 도구는 라벨·설명 외에 **키**(gpu·ipam·rma)·**구 명칭 별칭**(aka)·**분류명**으로도 걸린다.
 *
 * 순수 모듈이다 — 여기서 라우팅하거나 localStorage 를 건드리지 않는다(테스트가 node 환경).
 */
import { searchTools, matchScore } from '../views/toolSearch.js';

export const TAB_GROUP = '상단 메뉴';

/**
 * 카테고리 설정 → 도구 키별 분류명 함수. 분류를 끄거나 설정을 못 읽었으면 빈 배열(분류명 없이 찾는다).
 * 판정은 특수 기능 화면(SpecialTools.jsx catLabelsOf)과 같다 — 꺼진 카테고리는 넣지 않는다.
 */
export function catsOfFrom(cfg) {
  const cats = cfg?.enabled ? (Array.isArray(cfg.categories) ? cfg.categories : []) : [];
  return (k) => cats
    .filter((c) => c && c.enabled !== false && Array.isArray(c.tools) && c.tools.includes(k))
    .map((c) => c.label || '')
    .filter(Boolean);
}

/** 상단 탭의 팔레트 표기. tabs = [{ id, label }] (호출자가 권한으로 거른 목록). */
export function tabEntries(tabs) {
  const out = [];
  for (const t of Array.isArray(tabs) ? tabs : []) {
    if (!t || typeof t.id !== 'string' || !t.id) continue;
    out.push({ kind: 'tab', id: t.id, label: t.label || t.id, group: TAB_GROUP, hash: `#/${t.id}` });
  }
  return out;
}

const norm = (v) => String(v ?? '').toLowerCase();

/**
 * 검색 결과 — 기능 → 탭 순으로 묶어 돌려준다(같은 묶음 안에서는 매칭 점수 순).
 * `limit` 은 묶음별 상한이다. 잘라낸 개수를 함께 돌려준다 — 조용히 자르지 않는다.
 */
export function search(q, { tools, tabs, catsOf = () => [], limit = 6 } = {}) {
  const needle = norm(q).trim();
  const toolHits = needle
    ? searchTools(tools || [], needle, { catsOf: (t) => catsOf(t.k) })
    : [];
  const tabHits = needle
    ? tabEntries(tabs)
      .map((e, i) => ({ e, s: matchScore({ label: e.label, k: e.id, desc: e.group }, needle), i }))
      .filter((x) => x.s != null)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.e)
    : [];
  return {
    tools: toolHits.slice(0, limit),
    toolsOmitted: Math.max(0, toolHits.length - limit),
    tabs: tabHits.slice(0, limit),
    tabsOmitted: Math.max(0, tabHits.length - limit),
    empty: toolHits.length + tabHits.length === 0,
  };
}

/** 결과를 한 줄짜리 배열로 펼친다 — ↑↓ 커서 이동이 묶음을 넘나들 수 있게. */
export function flatten(res, { catsOf = () => [] } = {}) {
  if (!res) return [];
  return [
    ...res.tools.map((t) => ({ kind: 'tool', k: t.k, label: t.label, group: catsOf(t.k)[0] || '특수 기능', hash: `#/tools/${t.k}` })),
    ...res.tabs,
  ];
}
