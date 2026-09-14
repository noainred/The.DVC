/**
 * version_4/palette.js — ⌘K 커맨드 팔레트의 후보 목록과 매칭(v2.508, 순수).
 *
 * 팔레트는 세 종류를 한 목록에서 찾는다:
 *   · 기능(tool)  → 개발 포탈의 도구 화면(#/tools/<k>)
 *   · 화면(page)  → V4 내부 화면(#/v4/<id>)
 *   · 탭(tab)     → 개발 포탈 탭
 *
 * 매칭 규칙은 특수 기능 카드 그리드와 **같은 모듈**(views/toolSearch.js)을 쓴다 — 두 곳이
 * 다르게 동작하면 "카드에선 찾아지는데 팔레트에선 안 찾아진다" 가 된다.
 * 도구는 라벨·설명 외에 **키**(gpu·ipam·rma)·**구 명칭 별칭**(aka)·**분류명**으로도 걸린다.
 *
 * 순수 모듈이다 — 여기서 라우팅하거나 localStorage 를 건드리지 않는다(테스트가 node 환경).
 */
import { searchTools, matchScore } from '../views/toolSearch.js';
import { TREE, groupLabelsOfTool } from './tree.js';

/** V4 화면의 팔레트 표기. 라벨은 nav 의 PAGE_META 가 소유하므로 인자로 받는다. */
export function pageEntries(pageMeta) {
  const seen = new Set();
  const out = [];
  for (const g of TREE) {
    for (const it of g.items) {
      if (it.kind !== 'page' || seen.has(it.id)) continue;
      seen.add(it.id);
      const meta = pageMeta?.[it.id];
      out.push({ kind: 'page', id: it.id, label: meta?.title || it.id, group: g.label, hash: `#/v4/${it.id}` });
    }
  }
  return out;
}

/** 개발 포탈 탭의 팔레트 표기. */
export function tabEntries() {
  const out = [];
  for (const g of TREE) {
    for (const it of g.items) {
      if (it.kind !== 'tab') continue;
      out.push({ kind: 'tab', id: it.id, label: it.name, group: g.label, hash: it.hash });
    }
  }
  return out;
}

const norm = (v) => String(v ?? '').toLowerCase();

/**
 * 검색 결과 — 기능 → 화면 → 탭 순으로 묶어 돌려준다(같은 묶음 안에서는 매칭 점수 순).
 * `limit` 은 묶음별 상한이다. 잘라낸 개수를 함께 돌려준다 — 조용히 자르지 않는다.
 */
export function search(q, { tools, pageMeta, limit = 6 } = {}) {
  const needle = norm(q).trim();
  const toolHits = needle
    ? searchTools(tools || [], needle, { catsOf: (t) => groupLabelsOfTool(t.k) })
    : [];
  const pages = pageEntries(pageMeta);
  const tabs = tabEntries();
  const pick = (list) => (needle
    ? list.map((e, i) => ({ e, s: matchScore({ label: e.label, k: e.id, desc: e.group }, needle), i }))
      .filter((x) => x.s != null)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.e)
    : []);
  const pageHits = pick(pages);
  const tabHits = pick(tabs);
  return {
    tools: toolHits.slice(0, limit),
    toolsOmitted: Math.max(0, toolHits.length - limit),
    pages: pageHits.slice(0, limit),
    pagesOmitted: Math.max(0, pageHits.length - limit),
    tabs: tabHits.slice(0, limit),
    tabsOmitted: Math.max(0, tabHits.length - limit),
    empty: toolHits.length + pageHits.length + tabHits.length === 0,
  };
}

/** 결과를 한 줄짜리 배열로 펼친다 — ↑↓ 커서 이동이 묶음을 넘나들 수 있게. */
export function flatten(res) {
  if (!res) return [];
  return [
    ...res.tools.map((t) => ({ kind: 'tool', k: t.k, label: t.label, group: groupLabelsOfTool(t.k)[0] || '', hash: `#/tools/${t.k}` })),
    ...res.pages,
    ...res.tabs,
  ];
}
