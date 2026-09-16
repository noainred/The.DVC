/**
 * views/tools/deviceFacets.js — 법인·장비 종류 **필터 판정**(순수 · v2.532).
 *
 * 사용자 요청(2026-09-16, 스토리지 증가량 화면): "법인별로 구분해서 볼 수 있도록 해줘" ·
 * "장비 종류별로 볼 수 있도록 해줘, 이건 **다른 화면에서 사용했던 메뉴와 동일하게** 만들어줘".
 *
 * '동일하게' 를 지키는 방법은 **같은 코드를 쓰는 것**이다(CLAUDE.md '코어는 하나다').
 * v2.407 에 스토리지 모니터링(`StorageMonTool`)이 갖고 있던 판정을 여기로 옮겼고 두 화면이
 * 이 모듈과 `DeviceFacetBar` 를 공유한다 — 복사해 두면 '같은 메뉴' 가 조용히 갈라진다.
 *
 * ── 지켜야 하는 규칙(전부 v2.407~2.522 에서 실제 결함으로 배운 것) ─────────────
 *  ① **칩 목록은 '검색만 적용한' 집합에서 만든다.** 다른 축의 선택까지 반영해 칩을 거르면
 *     방금 고른 칩이 사라져 **해제할 수 없게** 된다.
 *  ② **칩의 개수는 '다른 축의 선택을 반영한' 수**다 — 고르면 몇 대가 남는지 미리 보인다.
 *  ③ **거른 뒤에 그룹핑한다.** 먼저 그룹핑하고 그룹명만 비교하면 장비명으로 찾을 수 없고,
 *     매칭된 법인 안에 매칭되지 않은 장비까지 같이 나온다.
 *  ④ 두 축은 **AND** 다 — 'AZ,WA + PowerScale' 이면 AZ·WA 의 PowerScale 만 보인다(사용자 예시).
 *  ⑤ 검색은 공백 구분 **다중 키워드 AND**.
 */

/** 문자열 Set 토글(불변) — 화면이 `setState(toggle(prev, v))` 로 쓴다. */
export function toggleIn(prev, v) {
  const next = new Set(prev);
  if (next.has(v)) next.delete(v); else next.add(v);
  return next;
}

/**
 * 필터 상태 계산.
 *
 * @param {object}   o
 * @param {object[]} o.rows       장비 행(각 행은 `type`·`datacenterId` 를 갖는다)
 * @param {Set}      o.dcSel      선택된 법인 **표시명** 집합(빈 Set = 전체)
 * @param {Set}      o.typeSel    선택된 타입 키 집합(빈 Set = 전체)
 * @param {string}   o.query      빠른 찾기 입력
 * @param {Function} o.dcName     datacenterId → 법인 표시명
 * @param {Function} o.typeLabel  type → 타입 표시명
 * @param {Function} [o.hay]      행 → 검색 건초더미 배열(화면마다 다른 필드를 더할 수 있게)
 * @returns {{searched:object[], shown:object[], dcChips:object[], typeChips:object[], facetOn:boolean}}
 */
export function facetState({ rows = [], dcSel, typeSel, query = '', dcName, typeLabel, hay = null }) {
  const dSel = dcSel instanceof Set ? dcSel : new Set();
  const tSel = typeSel instanceof Set ? typeSel : new Set();
  const name = dcName || ((id) => String(id || '미지정'));
  const tLabel = typeLabel || ((t) => String(t || ''));

  const kws = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = hay || ((r) => [name(r.datacenterId), r.name, r.host, tLabel(r.type), r.agent]);
  const matches = (r) => {
    if (!kws.length) return true;
    const s = haystack(r).filter(Boolean).join(' ').toLowerCase();
    return kws.every((kw) => s.includes(kw));
  };

  const searched = rows.filter(matches);                       // 규칙 ①
  const inDc = (r) => dSel.size === 0 || dSel.has(name(r.datacenterId));
  const inType = (r) => tSel.size === 0 || tSel.has(r.type);
  const shown = searched.filter((r) => inDc(r) && inType(r));  // 규칙 ③④

  // 법인 칩 — 개수는 '장비 종류 선택' 을 반영(규칙 ②)
  const byDc = new Map();
  for (const r of searched) {
    const k = name(r.datacenterId);
    if (!byDc.has(k)) byDc.set(k, []);
    byDc.get(k).push(r);
  }
  const dcChips = [...byDc.entries()]
    .map(([dc, list]) => ({ dc, list, count: list.filter(inType).length }))
    .sort((a, b) => a.dc.localeCompare(b.dc, 'ko'));

  // 종류 칩 — 개수는 '법인 선택' 을 반영(규칙 ②)
  const byType = new Map();
  for (const r of searched) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }
  const typeChips = [...byType.entries()]
    .map(([type, list]) => ({ type, list, count: list.filter(inDc).length }))
    .sort((a, b) => tLabel(a.type).localeCompare(tLabel(b.type), 'ko'));

  return { searched, shown, dcChips, typeChips, facetOn: dSel.size > 0 || tSel.size > 0 };
}

/**
 * 한 축으로 묶은 그룹(법인별·종류별 집계 탭용).
 * **빈 그룹을 만들지 않는다** — 필터로 0대가 된 축은 아예 나오지 않는다(빈 행은 '0대' 라는
 * 거짓이 아니라 그냥 없는 것이다).
 */
export function groupBy(rows, keyOf, labelOf = (k) => k) {
  const m = new Map();
  for (const r of rows || []) {
    const k = keyOf(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()]
    .map(([key, list]) => ({ key, label: labelOf(key), list }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label), 'ko'));
}
