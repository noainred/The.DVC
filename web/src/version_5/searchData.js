/**
 * version_5/searchData.js — V5 상단 통합 검색의 결과 목록(순수, v2.616).
 *
 * 두 부분이다(시안 ③):
 *   ① 데이터에서 찾기 — 검색어를 들고 그 화면으로 간다(가상머신·호스트·알람 = 개발 포탈 필터바의 검색어,
 *      IP관리·시리얼 조회 = hooks/searchHandoff.js 로 인계). **보이는 메뉴에 있는 대상만** 제시한다 —
 *      권한이 없는 화면으로 보내면 403 화면만 보게 된다.
 *   ② 기능·메뉴 — views/toolSearch.js searchTools 를 그대로 쓴다(특수 기능 그리드·V4 팔레트와 같은 규칙).
 *      분류명은 V5 그룹 이름이다('네트워크' 로 치면 네트워크 그룹 도구가 나온다).
 * 숨김·잠금은 resolveTree 결과를 받으므로 여기서 다시 판정하지 않는다.
 */
import { searchTools } from '../views/toolSearch.js';

/** 데이터 검색 대상 — key 는 resolveTree 항목 키. */
export const DATA_TARGETS = Object.freeze([
  { key: 'tab:vms', target: { kind: 'tab', id: 'vms' }, noun: '가상머신', where: '자산 › 가상머신', icon: 'vm' },
  { key: 'tab:hosts', target: { kind: 'tab', id: 'hosts' }, noun: '호스트', where: '자산 › VM호스트', icon: 'vm' },
  { key: 'tab:alarms', target: { kind: 'tab', id: 'alarms' }, noun: '알람', where: '운영 관제 › 알람', icon: 'alarm' },
  { key: 'tab:ipam', target: { kind: 'handoff', id: 'ipam', hash: '#/ipam' }, noun: 'IP 관리', where: '네트워크 › IP관리', icon: 'net' },
  { key: 'tool:serial-lookup', target: { kind: 'handoff', id: 'serial-lookup', hash: '#/tools/serial-lookup' }, noun: '시리얼 조회', where: '자산 › 시리얼 조회', icon: 'list' },
]);

/** 결과 상한 — 드롭다운이 화면을 덮지 않게. 잘린 개수는 돌려준다(조용한 상한 금지). */
export const TOOL_RESULT_MAX = 8;

/**
 * @param {string} q
 * @param {{home:object[], groups:object[]}} tree  resolveTree 결과
 * @param {object[]} tools  specialToolsList.js TOOLS(검색 필드 k·label·desc·aka 원천)
 * @returns {{data:object[], tools:object[], toolsOmitted:number}}
 */
export function searchResults(q, tree, tools) {
  const needle = String(q || '').trim();
  if (!needle) return { data: [], tools: [], toolsOmitted: 0 };
  const items = new Map();
  const groupOf = new Map();
  for (const g of tree?.groups || []) {
    for (const it of g.items) {
      if (it.kind === 'sub') continue;
      items.set(it.key, it);
      groupOf.set(it.key, g.label);
    }
  }
  for (const it of tree?.home || []) { items.set(it.key, it); groupOf.set(it.key, 'HOME'); }

  const data = DATA_TARGETS.filter((d) => {
    const it = items.get(d.key);
    return it && !it.locked;
  }).map((d) => ({ ...d, label: `${d.noun}에서 ‘${needle}’ 찾기`, q: needle }));

  const byK = new Map((tools || []).map((t) => [t.k, t]));
  // 검색 대상: 보이는 도구 항목 + 탭(탭은 이름만 가진 가짜 도구로 만든다).
  const pool = [];
  for (const [key, it] of items) {
    const src = it.kind === 'tool' ? byK.get(it.k) : null;
    pool.push({ ...(src || {}), k: it.kind === 'tool' ? it.k : it.id, label: it.name, _key: key, _group: groupOf.get(key), _item: it });
  }
  const found = searchTools(pool, needle, { catsOf: (t) => [t._group || ''] });
  const out = found.slice(0, TOOL_RESULT_MAX).map((t) => ({
    key: t._key, name: t._item.name, icon: t._item.icon, group: t._group,
    hash: t._item.hash || null, href: t._item.href || null, locked: !!t._item.locked, lockReason: t._item.lockReason || null,
  }));
  return { data, tools: out, toolsOmitted: Math.max(0, found.length - out.length) };
}
