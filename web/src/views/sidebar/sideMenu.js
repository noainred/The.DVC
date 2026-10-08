/**
 * views/sidebar/sideMenu.js — 좌측 사이드바 메뉴의 해석(순수, v2.726).
 *
 * 사용자 요청(2026-10-08): 상단 메뉴 → 좌측 사이드바 · 사용자가 자기 메뉴를 만든다(그룹·항목 순서, 특수 기능 추가) ·
 * 슈퍼 관리자가 전체 사용자에게 배포(강제/유지).
 *
 * 규칙(회귀 방지):
 *  · **포탈 기본 메뉴는 views/topMenu.js MENU_GROUPS 하나**다. 여기서는 저장된 메뉴(내 메뉴 > 배포 메뉴)를 그 모양으로
 *    되돌릴 뿐이다 — 라벨·id 는 기본 메뉴의 같은 항목(같은 탭·같은 도구+조각)에서 가져오고, 특수 기능에서 더한 도구는
 *    카탈로그(specialToolsList.js, 이름 덮어쓰기 적용)에서 가져온다. 서버는 라벨을 모른다(주소만 저장한다).
 *  · **모르는 항목은 버리고 개수를 밝힌다**(`unknown`) — 삭제된 탭·도구 키·카탈로그에 없는 키. 지어내지 않는다.
 *  · 권한 판정은 여기 없다 — 호출부가 topMenu.visibleMenu(tabOk·toolOk) 로 거른다(메뉴에 넣어도 권한이 넓어지지 않는다).
 *  · 특수 기능 하위(전체 카드 + 분류 바로가기)는 저장하지 않고 **그릴 때 합성**한다 — 분류는 설정 › 특수 기능 분류를 따른다.
 *    분류 주소는 `#/tools/_cat/<분류 id>` 다(둘째 조각이 도구 키 자리라 `_cat` 은 도구 키로 쓰지 않는 예약어 — 도구 키는
 *    영문 소문자·숫자·하이픈이고 `_` 로 시작하지 않는다).
 */
import { MENU_GROUPS } from '../topMenu.js';

export const CAT_SEG = '_cat';
export const CUSTOM_PREFIX = 'custom-';
export const CUSTOM_GROUP_LABEL = '내 그룹';

/** 항목의 정체 키 — 같은 화면은 같은 키(탭 / 도구+조각). */
export const itemKey = (it) => (it?.tool ? `tool:${it.tool}${it.seg ? `/${it.seg}` : ''}` : (it?.tab ? `tab:${it.tab}` : ''));

/** 카탈로그 항목이 메뉴에 넣을 수 있는 도구인가 — 이 앱에 화면이 있는 것만(외부 포탈·승격 탭·준비 중은 제외). */
export const toolEligible = (t) => !!(t && t.k && !t.external && !t.topTab && !t.comingSoon);

/** 포탈 기본 메뉴를 저장 모양(`{v, groups}`)으로. */
export function defaultMenu() {
  return {
    v: 1,
    groups: MENU_GROUPS.map((g) => (g.children
      ? { id: g.id, children: g.children.map((c) => (c.tool ? { tool: c.tool, ...(c.seg ? { seg: c.seg } : {}) } : { tab: c.tab })) }
      : { id: g.id, tab: g.tab })),
  };
}

/** 기본 메뉴 색인 — 그룹 라벨 · 항목 키 → 항목(그룹 id 포함). */
export function defaultIndex() {
  const groupLabel = new Map();
  const items = new Map();
  for (const g of MENU_GROUPS) {
    groupLabel.set(g.id, g.label);
    if (!g.children) { items.set(itemKey(g), { id: g.id, label: g.label, tab: g.tab, groupId: g.id, groupLabel: g.label }); continue; }
    for (const c of g.children) items.set(itemKey(c), { ...c, groupId: g.id, groupLabel: g.label });
  }
  return { groupLabel, items };
}

/**
 * 저장된 메뉴(내 메뉴 > 배포 메뉴) → 화면이 그릴 그룹 배열(topMenu.MENU_GROUPS 와 같은 모양).
 * @returns {{ groups: object[], source: 'mine'|'distributed'|'default', unknown: number }}
 */
export function resolveMenu({ mine = null, distributed = null, catalog = null, overrides = null } = {}) {
  const base = (mine && Array.isArray(mine.groups)) ? mine : (distributed && Array.isArray(distributed.groups)) ? distributed : null;
  if (!base) return { groups: MENU_GROUPS, source: 'default', unknown: 0 };
  const source = base === mine ? 'mine' : 'distributed';
  const { groupLabel, items } = defaultIndex();
  const toolMap = new Map((catalog || []).filter(toolEligible).map((t) => [t.k, t]));
  const seen = new Set();
  let unknown = 0;
  const groups = [];
  for (const g of base.groups) {
    if (!g || typeof g !== 'object' || !g.id) continue;
    const id = String(g.id);
    const custom = !groupLabel.has(id);
    const label = String(g.label || '').trim() || groupLabel.get(id) || (custom ? CUSTOM_GROUP_LABEL : id);
    if (g.tab) {
      const key = `tab:${g.tab}`;
      const d = items.get(key);
      if (!d) { unknown += 1; continue; }
      if (seen.has(key)) continue;
      seen.add(key);
      groups.push({ id, label, tab: d.tab, custom });
      continue;
    }
    const children = [];
    for (const it of Array.isArray(g.children) ? g.children : []) {
      const key = itemKey(it);
      if (!key) { unknown += 1; continue; }
      if (seen.has(key)) continue;
      const d = items.get(key);
      if (d) {
        seen.add(key);
        const { groupId, groupLabel: gl, ...rest } = d;
        const meta = rest.tool ? toolMap.get(rest.tool) : null;
        children.push({ ...rest, ...(meta?.adminOnly ? { adminOnly: true } : {}) });
        continue;
      }
      if (it.tool && !it.seg && toolMap.has(it.tool)) {
        const t = toolMap.get(it.tool);
        seen.add(key);
        children.push({ id: `t-${it.tool}`, label: String(overrides?.[it.tool]?.label || '').trim() || t.label, tool: it.tool, fromTools: true, ...(t.adminOnly ? { adminOnly: true } : {}) });
        continue;
      }
      unknown += 1;
    }
    if (children.length) groups.push({ id, label, children, custom });
  }
  return { groups, source, unknown };
}

/** 기본 메뉴 항목 중 지금 메뉴에 없는 것(지운 것 · 업그레이드로 새로 생긴 것) — 편집 화면의 '다시 넣기' 목록. */
export function missingDefaults(groups) {
  const present = new Set();
  for (const g of groups || []) {
    if (g.tab) present.add(`tab:${g.tab}`);
    for (const c of g.children || []) present.add(itemKey(c));
  }
  const out = [];
  for (const [key, d] of defaultIndex().items) if (!present.has(key)) out.push({ key, ...d });
  return out;
}

/** 특수 기능 하위 — 전체 카드 + 켜진 분류(설정 › 특수 기능 분류). 분류가 없으면 '전체 카드' 하나다. */
export function toolsChildren(categories = []) {
  const out = [{ id: 'all', label: '전체 카드', hash: '#/tools' }];
  for (const c of categories || []) {
    if (!c || !c.id) continue;
    out.push({ id: `cat:${c.id}`, label: String(c.label || c.id), icon: String(c.icon || ''), hash: catHash(c.id) });
  }
  return out;
}

const segsOf = (hash) => String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);

/** 분류 주소. `all`·빈 값은 목록(#/tools). */
export function catHash(id) {
  const v = String(id || '').trim();
  return v && v !== 'all' ? `#/tools/${CAT_SEG}/${encodeURIComponent(v)}` : '#/tools';
}

/** 주소에서 분류 id — 분류 주소가 아니면 ''. */
export function catFromHash(hash) {
  const s = segsOf(hash);
  if (s[0] !== 'tools' || s[1] !== CAT_SEG) return '';
  try { return decodeURIComponent(s[2] || ''); } catch { return ''; }
}

/** 특수 기능 하위 중 지금 켜진 것 — 'all' | 'cat:<id>' · 도구가 열려 있거나 특수 기능 탭이 아니면 null. */
export function activeToolsChild(tab, hash) {
  if (tab !== 'tools') return null;
  const s = segsOf(hash);
  if (s[0] !== 'tools') return null;
  if (!s[1]) return 'all';
  if (s[1] === CAT_SEG) { const c = catFromHash(hash); return c ? `cat:${c}` : 'all'; }
  return null;
}
