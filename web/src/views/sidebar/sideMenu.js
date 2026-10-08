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
 *  · 특수 기능은 단독 항목(`#/tools`)이다 — 분류 바로가기(하위 메뉴)는 사용자 결정으로 두지 않았다(2026-10-08 "분류 바로가기 제외").
 *  · v2.727(감사 A-01): **`GET /user-menu` 를 못 읽은 상태는 '포탈 기본 메뉴' 가 아니다** — `failed:true` 면 그리기는 기본(또는 마지막으로
 *    읽은 메뉴)으로 하되 `source:'unknown'` 이다. 화면은 그것을 '메뉴를 읽지 못했습니다 · 다시 시도' 로 말하고 편집 창의 저장을 잠근다
 *    (조회 실패 → 기본 메뉴 + 편집 저장 → 저장돼 있던 내 메뉴 소실 경로, v2.618 WEB-2 계열).
 */
import { MENU_GROUPS } from '../topMenu.js';

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

/** `GET /user-menu` 실패 뒤 재시도 간격(ms) — 5초 → 15초 → 60초 상한(v2.727 A-01). `attempt` 는 0 부터(실패 횟수 − 1). */
export const MENU_RETRY_MS = Object.freeze([5000, 15000, 60000]);
export function retryDelayMs(attempt) {
  const n = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return MENU_RETRY_MS[Math.min(n, MENU_RETRY_MS.length - 1)];
}

/**
 * 저장된 메뉴(내 메뉴 > 배포 메뉴) → 화면이 그릴 그룹 배열(topMenu.MENU_GROUPS 와 같은 모양).
 * @param {object} [opt.failed] 서버에서 메뉴를 읽지 못했다(v2.727 A-01) — 그룹은 그대로 만들되 source 는 'unknown'
 * @returns {{ groups: object[], source: 'mine'|'distributed'|'default'|'unknown', unknown: number }}
 */
export function resolveMenu({ mine = null, distributed = null, catalog = null, overrides = null, failed = false } = {}) {
  const base = (mine && Array.isArray(mine.groups)) ? mine : (distributed && Array.isArray(distributed.groups)) ? distributed : null;
  if (!base) return { groups: MENU_GROUPS, source: failed ? 'unknown' : 'default', unknown: 0 };
  const source = failed ? 'unknown' : (base === mine ? 'mine' : 'distributed');
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
