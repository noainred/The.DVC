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
 *  · v2.891(사용자 요청 '단독 메뉴로 추가하는 기능'): **단독 메뉴**(하위 메뉴 없이 한 줄) = 최상위 `{ id, tab }` 또는 `{ id, tool, seg? }`.
 *    기본 단독(Overview·Summary·특수 기능 …)뿐 아니라 그룹 안 항목 · 특수 기능 도구도 단독으로 둘 수 있다. 라벨 · 아이콘은 저장하지 않고
 *    항목에서 채운다(이름 덮어쓰기를 따라간다 · 아이콘 = 그 항목의 기본 그룹 · 특수 기능에서 더한 도구는 특수 기능 아이콘). 판정은 `isSingle` 하나.
 *  · v2.727(감사 A-01): **`GET /user-menu` 를 못 읽은 상태는 '포탈 기본 메뉴' 가 아니다** — `failed:true` 면 그리기는 기본(또는 마지막으로
 *    읽은 메뉴)으로 하되 `source:'unknown'` 이다. 화면은 그것을 '메뉴를 읽지 못했습니다 · 다시 시도' 로 말하고 편집 창의 저장을 잠근다
 *    (조회 실패 → 기본 메뉴 + 편집 저장 → 저장돼 있던 내 메뉴 소실 경로, v2.618 WEB-2 계열).
 */
import { MENU_GROUPS } from '../topMenu.js';

export const CUSTOM_PREFIX = 'custom-';
export const CUSTOM_GROUP_LABEL = '내 그룹';

/** 항목의 정체 키 — 같은 화면은 같은 키(탭 / 도구+조각). */
export const itemKey = (it) => (it?.tool ? `tool:${it.tool}${it.seg ? `/${it.seg}` : ''}` : (it?.tab ? `tab:${it.tab}` : ''));

/** v2.891: 단독 메뉴인가(하위 메뉴 배열이 없다) — 해석된 그룹 · 편집 모양 둘 다. */
export const isSingle = (g) => !!g && typeof g === 'object' && !Array.isArray(g.children);

/** v2.891: 포탈 기본 메뉴의 단독 항목 키(Overview 등) — 지울 수 없고 자리만 옮긴다(지우면 그 화면으로 갈 길이 없다). */
export function fixedSingleKeys() {
  return new Set(MENU_GROUPS.filter((g) => !g.children).map((g) => itemKey(g)).filter(Boolean));
}

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

/** v2.787: 기본 메뉴에서 빠진 그룹 id — 예전에 저장한 내 메뉴·배포 메뉴가 그 id 를 들고 있으면 '새 그룹' 대신 이 이름으로 보인다. */
export const LEGACY_GROUP_LABELS = Object.freeze({ backup: 'Veeam 백업' });

/**
 * v2.915: 항목 별칭 — 메뉴 항목 하나가 여러 탭을 맡으면(topMenu `tabs`) 저장 메뉴에 남은 옛 항목(`tab:hosts` · `tab:vms` — v2.914 까지 따로 있던
 * 'ESXi 호스트' · '가상화 서버')은 그 항목으로 잇는다. 저장 메뉴는 주소만 담고 서버는 탭 실재를 모르므로, 별칭이 없으면 옛 항목이 unknown('미표시 N')으로
 * 조용히 사라진다(그룹 id 별칭 LEGACY_GROUP_LABELS 와 같은 이유 · 항목 별칭은 이것이 처음). 반환: 별칭 키 → 기본 항목 키.
 * v2.994(설계 docs/design/server-menu-rename): 별칭 방향이 바뀌었다 — 'Virtual Machine(VM)'(virt)의 정체 키가 tab:vms 가 되고 tab:vcenters 가 별칭이다.
 *   v2.942~v2.993 에 저장된 메뉴(tab:vcenters 하나)도, 그 이전 메뉴(tab:vms · tab:hosts · tab:vcenters 셋)도 그대로 풀린다 — 옛 tab:hosts 는 이제
 *   별칭이 아니라 실제 항목 'Hypervisor'(hv)다. 별칭은 topMenu 의 `tabs` 에서만 만든다(여기에 키를 따로 적지 않는다).
 */
export function itemAliases() {
  const out = new Map();
  for (const g of MENU_GROUPS) {
    for (const it of g.children || [g]) {
      if (!Array.isArray(it.tabs)) continue;
      for (const t of it.tabs) out.set(`tab:${t}`, itemKey(it));
    }
  }
  return out;
}

/** 기본 메뉴 색인 — 그룹 라벨 · 항목 키 → 항목(그룹 id 포함). 별칭 키(v2.915)도 같은 항목을 가리킨다. */
export function defaultIndex() {
  const groupLabel = new Map();
  const items = new Map();
  for (const g of MENU_GROUPS) {
    groupLabel.set(g.id, g.label);
    if (!g.children) { items.set(itemKey(g), { id: g.id, label: g.label, tab: g.tab, groupId: g.id, groupLabel: g.label }); continue; }
    for (const c of g.children) items.set(itemKey(c), { ...c, groupId: g.id, groupLabel: g.label });
  }
  for (const [alias, key] of itemAliases()) if (!items.has(alias) && items.has(key)) items.set(alias, items.get(key));
  return { groupLabel, items };
}

/** 저장 항목의 정체 키 — 별칭이면 기본 항목 키로(같은 항목이 두 번 들어가지 않게 seen 도 이 키로 센다). */
function canonKey(key, aliases) {
  return aliases.get(key) || key;
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
  const aliases = itemAliases();   // v2.994 tab:vcenters → Virtual Machine(VM) 항목(tab:vms)
  const toolMap = new Map((catalog || []).filter(toolEligible).map((t) => [t.k, t]));
  const seen = new Set();
  let unknown = 0;
  const groups = [];
  for (const g of base.groups) {
    if (!g || typeof g !== 'object' || !g.id) continue;
    const id = String(g.id);
    const custom = !groupLabel.has(id);
    const label = String(g.label || '').trim() || groupLabel.get(id) || LEGACY_GROUP_LABELS[id] || (custom ? CUSTOM_GROUP_LABEL : id);
    if (g.tab || g.tool) {
      // 단독 메뉴(v2.891 — 예전에는 탭만 · 기본 단독 항목만 알아봤다). 항목을 기본 메뉴(어느 그룹의 항목이든) → 특수 기능 카탈로그 순으로 찾는다
      const key = canonKey(itemKey(g), aliases);
      if (seen.has(key)) continue;
      const d = items.get(key);
      let one = null;
      if (d) {
        const rest = { ...d };
        delete rest.groupId; delete rest.groupLabel; delete rest.id;   // 그룹 자리 표지는 버리고 항목(라벨 · 주소)만
        const meta = rest.tool ? toolMap.get(rest.tool) : null;
        one = { ...rest, iconOf: d.groupId, ...(meta?.adminOnly ? { adminOnly: true } : {}) };
      } else if (g.tool && !g.seg && toolMap.has(g.tool)) {
        const t = toolMap.get(g.tool);
        one = { label: String(overrides?.[g.tool]?.label || '').trim() || t.label, tool: g.tool, fromTools: true, iconOf: 'tools', ...(t.adminOnly ? { adminOnly: true } : {}) };
      }
      if (!one) { unknown += 1; continue; }
      seen.add(key);
      // 기본 단독(Overview …)은 예전 규칙(저장 라벨 > 기본 그룹 라벨) · 새 단독은 저장 라벨 > 항목 라벨
      groups.push({ ...one, id, label: String(g.label || '').trim() || groupLabel.get(id) || one.label, custom });
      continue;
    }
    const children = [];
    for (const it of Array.isArray(g.children) ? g.children : []) {
      const key = canonKey(itemKey(it), aliases);
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
  const aliases = itemAliases();   // v2.915: 별칭 키(v2.994 부터 tab:vcenters)는 '다시 넣기' 후보가 아니다 — 그 항목(Virtual Machine(VM))이 있으면 들어 있는 것
  const present = new Set();
  for (const g of groups || []) {
    if (isSingle(g)) { present.add(canonKey(itemKey(g), aliases)); continue; }   // v2.891: 단독 도구도
    for (const c of g.children || []) present.add(canonKey(itemKey(c), aliases));
  }
  const out = [];
  for (const [key, d] of defaultIndex().items) if (!aliases.has(key) && !present.has(key)) out.push({ key, ...d });
  return out;
}

/**
 * 아코디언 전이(v2.727, 사용자 요청 "한 번에 1개의 메뉴만 펼치게") — 열린 그룹 id 하나만 든다.
 *  · 닫힌 그룹을 누르면 그 그룹만 열린다(다른 그룹은 닫힌다) · 열린 그룹을 누르면 닫힌다(0개 허용) · 잘못된 id 는 변화 없음.
 */
export function nextOpenGroup(current, clicked) {
  if (!clicked) return current ?? null;
  return current === clicked ? null : clicked;
}
