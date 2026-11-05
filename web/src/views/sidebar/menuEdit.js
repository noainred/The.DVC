/**
 * views/sidebar/menuEdit.js — 내 메뉴 편집 연산(순수, v2.726). 화면(MenuEditor.jsx)은 이 함수들을 부를 뿐이다.
 *
 * 편집 모양(`EditableGroup`): { id, label, custom, tab? , children?: [{ key, id, label, tab?, tool?, seg?, fromTools?, adminOnly? }] }
 *  · 모든 연산은 **새 배열**을 돌려준다(React 상태). 실패는 조용히 무시하지 않고 `{ ok:false, reason }` 또는 입력 그대로를 돌려준다.
 *  · 같은 항목(같은 키)은 한 그룹에만 있다 — 다른 그룹에 넣으려면 먼저 빼야 한다(한 화면이 두 자리에 있지 않게, v2.725 규약).
 *  · 하위 메뉴 없는 단독 항목(Overview·Summary·특수 기능·게시판)은 **자리만 옮길 수 있고 지울 수 없다**(지우면 그 화면으로 갈 길이 없다).
 *  · v2.891(사용자 요청 '단독 메뉴로 추가하는 기능'): 아무 항목(그룹 안 항목 · 특수 기능 도구)이나 **단독 메뉴**로 둘 수 있다 —
 *    `addSingle`(오른쪽 목록에서) · `detachToSingle`(그룹 항목을 빼서 그 그룹 바로 아래로). 이렇게 만든 단독은 ✕ 로 지운다(기본 단독만 못 지움 —
 *    `fixedSingleKeys`). 단독 판정은 `sideMenu.isSingle` 하나(편집 모양의 단독 = children 배열이 없다). 라벨은 저장하지 않는다(항목에서 채운다).
 *  · 새 그룹 id 는 `custom-<n>`(겹치지 않는 n). 저장 모양에는 그룹 라벨을 **기본과 다를 때만** 싣는다(기본 라벨이 바뀌어도 따라가게).
 */
import { itemKey, defaultIndex, defaultMenu, resolveMenu, isSingle, fixedSingleKeys, CUSTOM_PREFIX, CUSTOM_GROUP_LABEL } from './sideMenu.js';

export { isSingle };

export const LIMITS = Object.freeze({ groups: 40, items: 400, label: 40 });

/** 해석된 그룹(resolveMenu().groups 또는 MENU_GROUPS) → 편집 모양. */
export function toEditable(groups) {
  const { groupLabel } = defaultIndex();
  const fixed = fixedSingleKeys();
  return (groups || []).map((g) => (isSingle(g)
    ? { ...singleFields(g), id: g.id, label: g.label, custom: !groupLabel.has(g.id), key: itemKey(g), fixed: fixed.has(itemKey(g)) }
    : { id: g.id, label: g.label, custom: !groupLabel.has(g.id), children: (g.children || []).map((c) => ({ key: itemKey(c), ...c })) }));
}

/** 단독 메뉴가 들고 가는 칸(주소 + 표시용 표지) — 라벨 · id 는 부르는 쪽이 정한다. */
function singleFields(g) {
  return g.tool
    ? { tool: g.tool, ...(g.seg ? { seg: g.seg } : {}), ...(g.fromTools ? { fromTools: true } : {}), ...(g.adminOnly ? { adminOnly: true } : {}), ...(g.iconOf ? { iconOf: g.iconOf } : {}) }
    : { tab: g.tab, ...(g.adminOnly ? { adminOnly: true } : {}), ...(g.iconOf ? { iconOf: g.iconOf } : {}) };
}

/** 편집 모양 → 저장 모양. 빈 그룹은 뺀다. */
export function toStored(groups) {
  const { groupLabel } = defaultIndex();
  const out = [];
  for (const g of groups || []) {
    const label = String(g.label || '').trim();
    const withLabel = label && label !== (groupLabel.get(g.id) || '') ? { label } : {};
    if (isSingle(g)) {
      // v2.891: 새로 만든 단독(custom id)은 라벨을 싣지 않는다 — 항목 라벨(이름 덮어쓰기)을 따라간다. 기본 단독은 예전 규칙 그대로
      const lab = g.custom ? {} : withLabel;
      out.push(g.tool ? { id: g.id, ...lab, tool: g.tool, ...(g.seg ? { seg: g.seg } : {}) } : { id: g.id, ...lab, tab: g.tab });
      continue;
    }
    const children = (g.children || []).map((c) => (c.tool ? { tool: c.tool, ...(c.seg ? { seg: c.seg } : {}) } : { tab: c.tab }));
    if (!children.length) continue;
    out.push({ id: g.id, ...withLabel, children });
  }
  return { v: 1, groups: out };
}

/** 기본 메뉴의 편집 모양(되돌리기). 카탈로그는 adminOnly 표지용. */
export function defaultEditable(catalog = null) {
  return toEditable(resolveMenu({ mine: defaultMenu(), catalog }).groups);
}

const swap = (arr, i, j) => { const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; };

export function moveGroup(groups, i, dir) {
  const j = i + dir;
  if (i < 0 || i >= groups.length || j < 0 || j >= groups.length) return groups;
  return swap(groups, i, j);
}

export function moveItem(groups, gi, ii, dir) {
  const g = groups[gi];
  if (!g || isSingle(g)) return groups;
  const j = ii + dir;
  if (ii < 0 || ii >= g.children.length || j < 0 || j >= g.children.length) return groups;
  const next = groups.slice();
  next[gi] = { ...g, children: swap(g.children, ii, j) };
  return next;
}

export function removeItem(groups, gi, ii) {
  const g = groups[gi];
  if (!g || isSingle(g) || ii < 0 || ii >= g.children.length) return groups;
  const next = groups.slice();
  next[gi] = { ...g, children: g.children.filter((_, k) => k !== ii) };
  return next;
}

/** 어느 그룹에 있는가 — 없으면 null. 단독 그룹도 본다. */
export function placedIn(groups, key) {
  for (const g of groups || []) {
    if (isSingle(g)) { if (itemKey(g) === key) return { gi: groups.indexOf(g), group: g, single: true }; continue; }
    const ii = (g.children || []).findIndex((c) => c.key === key);
    if (ii >= 0) return { gi: groups.indexOf(g), ii, group: g, single: false };
  }
  return null;
}

/** 항목을 그룹에 더한다(끝에). 이미 어딘가 있으면 넣지 않고 사유를 돌려준다. */
export function addItem(groups, gi, item) {
  const g = groups[gi];
  if (!g || isSingle(g)) return { ok: false, reason: '하위 메뉴가 있는 그룹을 고르세요', groups };
  const key = item.key || itemKey(item);
  if (!key) return { ok: false, reason: '항목을 알 수 없습니다', groups };
  const where = placedIn(groups, key);
  if (where) return { ok: false, reason: placedReason(where), groups };
  const total = countItems(groups);
  if (total >= LIMITS.items) return { ok: false, reason: `메뉴 항목은 최대 ${LIMITS.items}개입니다`, groups };
  const next = groups.slice();
  next[gi] = { ...g, children: [...(g.children || []), { ...item, key }] };
  return { ok: true, groups: next };
}

const placedReason = (where) => (where.single ? `이미 단독 메뉴 '${where.group.label}' 로 있습니다` : `이미 '${where.group.label}' 에 있습니다`);
function nextCustomId(groups) {
  const ids = new Set(groups.map((g) => g.id));
  let n = 1;
  while (ids.has(`${CUSTOM_PREFIX}${n}`)) n += 1;
  return `${CUSTOM_PREFIX}${n}`;
}

/**
 * v2.891 단독 메뉴로 더하기 — 그룹 없이 한 줄. at 이 없으면 '특수 기능' 앞(없으면 끝 — 새 그룹과 같은 자리).
 * 아이콘은 그 항목의 기본 그룹(특수 기능에서 더한 도구는 특수 기능) — 저장하지 않고 해석 때 다시 정한다(sideMenu.resolveMenu 와 같은 규칙).
 */
export function addSingle(groups, item, at = null) {
  if (!item) return { ok: false, reason: '항목을 알 수 없습니다', groups };
  const key = item.key || itemKey(item);
  if (!key || !(item.tab || item.tool)) return { ok: false, reason: '항목을 알 수 없습니다', groups };
  const where = placedIn(groups, key);
  if (where) return { ok: false, reason: placedReason(where), groups };
  if (groups.length >= LIMITS.groups) return { ok: false, reason: `그룹 · 단독 메뉴는 합쳐 최대 ${LIMITS.groups}개입니다`, groups };
  if (countItems(groups) >= LIMITS.items) return { ok: false, reason: `메뉴 항목은 최대 ${LIMITS.items}개입니다`, groups };
  const iconOf = item.iconOf || defaultIndex().items.get(key)?.groupId || (item.tool ? 'tools' : '');
  const g = { ...singleFields({ ...item, iconOf }), id: nextCustomId(groups), label: String(item.label || '').trim() || key, custom: true, key, fixed: false };
  const tools = groups.findIndex((x) => isSingle(x) && x.tab === 'tools');
  const pos = Number.isInteger(at) && at >= 0 && at <= groups.length ? at : (tools >= 0 ? tools : groups.length);
  const next = groups.slice();
  next.splice(pos, 0, g);
  return { ok: true, groups: next, gi: pos };
}

/** v2.891 그룹 항목을 빼서 그 그룹 바로 아래 단독 메뉴로. 그룹이 비면 저장할 때 빠진다(예전 규칙 그대로). */
export function detachToSingle(groups, gi, ii) {
  const g = groups[gi];
  if (!g || isSingle(g) || !Number.isInteger(ii) || ii < 0 || ii >= g.children.length) return { ok: false, reason: '항목을 알 수 없습니다', groups };
  if (groups.length >= LIMITS.groups) return { ok: false, reason: `그룹 · 단독 메뉴는 합쳐 최대 ${LIMITS.groups}개입니다`, groups };
  const c = g.children[ii];
  const without = groups.slice();
  without[gi] = { ...g, children: g.children.filter((_, k) => k !== ii) };
  return addSingle(without, c, gi + 1);
}

/** 새 그룹 — '특수 기능' 앞에(없으면 끝에). 이름이 비면 '내 그룹'. */
export function newGroup(groups, label = '') {
  if (groups.length >= LIMITS.groups) return { ok: false, reason: `그룹은 최대 ${LIMITS.groups}개입니다`, groups };
  const g = { id: nextCustomId(groups), label: String(label || '').trim().slice(0, LIMITS.label) || CUSTOM_GROUP_LABEL, custom: true, children: [] };
  const at = groups.findIndex((x) => isSingle(x) && x.tab === 'tools');
  const next = groups.slice();
  next.splice(at >= 0 ? at : groups.length, 0, g);
  return { ok: true, groups: next, gi: at >= 0 ? at : groups.length };
}

export function renameGroup(groups, gi, label) {
  const g = groups[gi];
  if (!g) return groups;
  const v = String(label || '').trim().slice(0, LIMITS.label);
  if (!v) return groups;
  const next = groups.slice();
  next[gi] = { ...g, label: v };
  return next;
}

/**
 * 그룹 삭제 — 포탈 기본 단독 항목(Overview 등)은 지울 수 없다(그 화면으로 갈 길이 사라진다). 하위 항목은 '다시 넣기' 목록으로 간다.
 * v2.891: 사용자가 만든 단독 메뉴는 지운다 — 그 항목은 오른쪽 목록(기본 메뉴 항목 · 특수 기능)으로 돌아간다.
 */
export function removeGroup(groups, gi) {
  const g = groups[gi];
  if (!g || (isSingle(g) && fixedSingleKeys().has(itemKey(g)))) return { ok: false, reason: '이 항목은 지울 수 없습니다 — 자리만 옮길 수 있습니다', groups };
  return { ok: true, groups: groups.filter((_, k) => k !== gi) };
}

export function countItems(groups) {
  return (groups || []).reduce((n, g) => n + (isSingle(g) ? 1 : (g.children || []).length), 0);
}

/** 두 편집 상태가 같은 저장 결과를 내는가. */
export function sameMenu(a, b) {
  return JSON.stringify(toStored(a)) === JSON.stringify(toStored(b));
}

/**
 * 화면의 '바뀐 항목 N' · 저장 버튼 활성의 기준(v2.727 감사 A-05) — **저장 결과(toStored)가 기준과 같으면 0**.
 * `changeCount` 는 빈 새 그룹도 세는데 그 그룹은 저장에서 빠지므로 '바뀐 항목 1 · 저장 가능' 이 거짓이었다(헛저장·헛감사).
 */
export function changesToSave(base, cur) {
  if (sameMenu(base, cur)) return 0;
  const saved = (groups) => (groups || []).filter((g) => isSingle(g) || (g.children || []).length); // 저장에서 빠지는 빈 그룹은 세지 않는다
  return changeCount(saved(base), saved(cur));
}

/** '추가 대상' 기본값 — 하위 메뉴가 있는 첫 그룹의 **id**(v2.727 A-04: 인덱스로 들면 ▲▼·삭제 뒤 다른 그룹을 가리킨다). 없으면 null. */
export function firstGroupId(groups) {
  return (groups || []).find((g) => !isSingle(g))?.id ?? null;
}

/** 편집 창 '이전 메뉴 복원' 버튼의 설명(v2.727 A-01·A-10) — 보관한 동작(저장/강제 배포)을 가르고, 배포자 이름이 없으면 '슈퍼 관리자'. */
export function prevNoteText(prev, agoText = null) {
  if (!prev) return '';
  const when = agoText || '—';
  if (prev.mode === 'save') return `내가 ${when} 저장하면서 덮은 직전 메뉴로 되돌립니다`;
  return `${prev.by || '슈퍼 관리자'} 가 ${when} 강제 배포하면서 보관한 직전 메뉴로 되돌립니다`;
}

/** 편집 창 머리의 '배포된 메뉴가 있습니다' 문구(v2.727 A-10 — 배포자 이름이 없으면 '슈퍼 관리자'). */
export function distNoteText(dist, agoText = null) {
  if (!dist) return '';
  return `배포된 메뉴가 있습니다(${dist.by || '슈퍼 관리자'} · ${agoText || '—'} · ${dist.mode === 'force' ? '강제 적용' : '유지'}). 내 메뉴가 있으면 내 메뉴가 먼저입니다.`;
}

/**
 * 조회 실패 상태의 편집 창 안내(v2.727 A-01). 저장·삭제·복원·배포를 잠그는 이유를 한 문장으로.
 * @param {'loading'|'ok'|'error'} state
 */
export function lockedNoteText(state) {
  if (state === 'ok') return '';
  if (state === 'loading') return '서버에서 메뉴를 불러오는 중입니다 — 끝나면 편집할 수 있습니다.';
  return '서버에서 메뉴를 읽지 못했습니다. 지금 보이는 것은 포탈 기본 메뉴(또는 마지막으로 읽은 메뉴)라 이대로 저장하면 저장돼 있던 내 메뉴를 덮어씁니다 — 저장·삭제·복원·배포를 잠갔습니다. 다시 시도한 뒤 편집하세요.';
}

/** 최장 공통 부분열 길이 — '자리가 바뀐 항목' 을 최소로 센다(하나를 지우면 아래 항목이 전부 밀리지만 그것은 바뀐 것이 아니다). */
function lcsLen(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

/**
 * 바뀐 항목 수 — 더한 항목 + 뺀 항목 + 다른 그룹으로 옮긴 항목 + 같은 그룹 안에서 자리가 바뀐 항목(최소 개수) +
 * 더하거나 뺀 그룹 + 자리가 바뀐 그룹 + 이름이 바뀐 그룹. 화면의 '바뀐 항목 N' 이 이 값이다.
 */
export function changeCount(base, cur) {
  const pos = (groups) => {
    const m = new Map();
    for (const g of groups || []) {
      if (isSingle(g)) { m.set(itemKey(g), g.id); continue; }
      for (const c of g.children || []) m.set(c.key, g.id);
    }
    return m;
  };
  const a = pos(base);
  const b = pos(cur);
  let n = 0;
  // 그룹 — 더함·뺌·자리
  const ga = (base || []).map((g) => g.id);
  const gb = (cur || []).map((g) => g.id);
  const inBoth = (x, other) => x.filter((id) => other.includes(id));
  n += gb.filter((id) => !ga.includes(id)).length + ga.filter((id) => !gb.includes(id)).length;
  n += inBoth(gb, ga).length - lcsLen(inBoth(ga, gb), inBoth(gb, ga));
  // 항목 — 더함·뺌·그룹 이동
  for (const [k, gid] of b) if (!a.has(k)) n += 1; else if (a.get(k) !== gid) n += 1;
  for (const k of a.keys()) if (!b.has(k)) n += 1;
  // 같은 그룹 안 순서
  const seqOf = (g) => (g.children || []).map((c) => c.key);
  for (const g of cur || []) {
    if (isSingle(g)) continue;
    const bg = (base || []).find((x) => x.id === g.id);
    if (!bg || isSingle(bg)) continue;
    const stay = new Set(seqOf(g).filter((k) => a.get(k) === g.id));
    const sb = seqOf(g).filter((k) => stay.has(k));
    const sa = seqOf(bg).filter((k) => stay.has(k));
    n += sb.length - lcsLen(sa, sb);
  }
  // 이름
  const la = new Map((base || []).map((g) => [g.id, g.label]));
  for (const g of cur || []) if (la.has(g.id) && la.get(g.id) !== g.label) n += 1;
  return n;
}

/**
 * 편집 화면 오른쪽 '특수 기능' 목록 — 카탈로그에서 넣을 수 있는 도구만, 이름 덮어쓰기 적용, 이미 들어간 그룹 표시.
 * @param {object[]} catalog specialToolsList.TOOLS
 * @param {object[]} groups 편집 중인 그룹
 * @param {object} [opt]  overrides(k → {label}) · lockOf(t → 잠금 사유|null)
 */
export function availableTools(catalog, groups, { overrides = null, lockOf = null } = {}) {
  return (catalog || []).filter((t) => t && t.k && !t.external && !t.topTab && !t.comingSoon).map((t) => {
    const key = `tool:${t.k}`;
    const where = placedIn(groups, key);
    return {
      k: t.k, key, label: String(overrides?.[t.k]?.label || '').trim() || t.label, origLabel: t.label, desc: t.desc || '', icon: t.icon || '',
      adminOnly: !!t.adminOnly, aka: t.aka || [], lock: typeof lockOf === 'function' ? lockOf(t) : null,
      placedLabel: where ? (where.single ? '단독 메뉴' : where.group.label) : '',
      item: { key, id: `t-${t.k}`, label: String(overrides?.[t.k]?.label || '').trim() || t.label, tool: t.k, fromTools: true, ...(t.adminOnly ? { adminOnly: true } : {}) },
    };
  });
}

/** 검색 — 이름·키·설명·별칭(대소문자 무시). 빈 검색어면 전부. */
export function filterTools(list, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return list;
  return list.filter((t) => [t.label, t.origLabel, t.k, t.desc, ...(t.aka || [])].some((x) => String(x || '').toLowerCase().includes(s)));
}
