/**
 * views/toolSections.js — 특수 기능 카드를 카테고리 섹션으로 나눈다 (순수, v2.455).
 *
 * 요구: "특수기능에 기능이 너무 많아서 카테고리로 묶어 보여줄 수 있게. **1개 기능을 중복해서
 * 여러 카테고리에 넣을 수 있게.**" — 도구 목록은 specialToolsList.js 의 전부다(개수를 여기 적지 않는다 — v2.613 CATALOG2613-11:
 * 주석의 숫자는 매 릴리스 낡는다. '몇 개' 는 산문이 아니라 TOOLS.length 다).
 *
 * 화면 배치 계산이라 웹에 둔다(서버 `toolcats/` 는 저장·검증·프리셋만 소유한다 — 같은 로직을
 * 양쪽에 두면 어긋나는 날이 온다). 순수 함수라 `toolSections.test.js` 로 회귀를 고정한다.
 */

/**
 * @param {{enabled?:boolean, categories?:{id,label,icon,enabled,tools:string[]}[], showUncategorized?:boolean}} cfg
 * @param {string[]} visibleKeys 이 사용자에게 실제로 보이는 도구 키(권한·검색 필터를 이미 통과한 것)
 * @returns {{id:string,label:string,icon:string,tools:string[]}[]} 빈 배열이면 기존 단일 그리드를 그린다
 *
 * 규칙:
 *  - 카테고리 미사용(enabled=false)이거나 정의가 없으면 **빈 배열** → 화면은 켜기 전과 똑같이 동작.
 *  - **중복 소속을 유지한다** — 같은 도구가 여러 섹션에 나오는 것이 요구사항이다.
 *  - 안 보이는 도구는 섹션에서 빠지고, 그래서 빈 카테고리는 통째로 숨긴다(제목만 남으면 오해를 만든다).
 *  - 어느 카테고리에도 없는 도구는 마지막 '기타' 로 모은다 — 새 도구가 분류되기 전까지
 *    화면에서 사라지면 기능이 죽은 것처럼 보인다(가용성 우선).
 *  - 입력 순서를 보존한다(호출부가 이미 '많이 쓴 순' 으로 정렬해 넘긴다).
 */
export function buildSections(cfg, visibleKeys) {
  const keys = (visibleKeys || []).map(String);
  if (!cfg?.enabled) return [];
  const cats = (Array.isArray(cfg.categories) ? cfg.categories : []).filter((c) => c && c.enabled !== false);
  if (!cats.length) return [];

  const visible = new Set(keys);
  const out = [];
  const placed = new Set();
  for (const c of cats) {
    const want = new Set((c.tools || []).map(String));
    // 카테고리 안의 순서는 호출부가 준 순서를 따른다(사용 빈도 정렬을 섹션 안에서도 유지).
    const tools = keys.filter((k) => want.has(k) && visible.has(k));
    for (const k of tools) placed.add(k);
    if (!tools.length) continue;
    out.push({ id: String(c.id || ''), label: c.label || c.id || '', icon: c.icon || '', tools });
  }
  if (cfg.showUncategorized !== false) {
    const rest = keys.filter((k) => !placed.has(k));
    if (rest.length) out.push({ id: '_uncategorized', label: '기타', icon: '📦', tools: rest });
  }
  return out;
}

/** 이 도구가 속한 카테고리 이름들 — 카드에 소속 배지를 달거나 설정 화면에서 중복을 보여줄 때. */
export function categoriesOf(cfg, toolKey) {
  const k = String(toolKey);
  return (cfg?.categories || [])
    .filter((c) => (c?.tools || []).some((t) => String(t) === k))
    .map((c) => c.label || c.id);
}

/** 어느 카테고리에도 없는 도구 키 — 설정 화면의 "분류 안 됨 N개". */
export function uncategorizedKeys(cfg, allKeys) {
  const placed = new Set();
  for (const c of cfg?.categories || []) for (const t of c?.tools || []) placed.add(String(t));
  return (allKeys || []).map(String).filter((k) => !placed.has(k));
}
