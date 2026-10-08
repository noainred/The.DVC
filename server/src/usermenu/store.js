/**
 * usermenu/store.js — 계정별 좌측 메뉴(내 메뉴)와 슈퍼 관리자 배포 메뉴 저장소(v2.726, `user-menus.json`).
 *
 * 사용자 요청(2026-10-08): "사용자가 자신만의 메뉴를 만들 수 있게 … 좌측 세로 메뉴의 순서를 변경 · 특수기능에 있는 기능을
 * 원하는 세로 메뉴에 추가·순서 변경 … 슈퍼 관리자는 자신의 메뉴를 전체 사용자에게 강제 배포 · 배포할 때 자신의 메뉴를 만든
 * 사용자에게 강제 적용할 것인지 아닌지 선택".
 *
 * ── 저장 모양 ─────────────────────────────────────────────────────────────────
 *   { v: 1,
 *     users: { [username]: { menu, updatedAt, prev?: { menu, at, by, mode } } },   // 내 메뉴 · 강제 배포가 밀어낸 직전 메뉴
 *     distributed: { menu, at, by, mode, counts: { users, custom, forced } } | null, // 슈퍼 관리자가 배포한 기본 메뉴
 *     history: [ { at, by, mode, counts } … ] }                                      // 최근 배포 기록(최대 20)
 *   menu = { v: 1, groups: [ { id, label?, tab } | { id, label?, children: [ { tab } | { tool, seg? } ] } ] }
 *
 * ── 규칙 ──────────────────────────────────────────────────────────────────────
 *  · 메뉴는 **주소를 가리킬 뿐**이다 — 탭 id(`#/<tab>`)와 특수 기능 도구 키(`#/tools/<k>`). 라벨은 저장하지 않는 것이 기본이고
 *    (화면이 포탈 기본 메뉴·도구 카탈로그에서 채운다) 그룹 라벨만 사용자가 지은 이름을 둔다. 권한은 여기서 보지 않는다 —
 *    메뉴에 넣어도 권한 없는 항목은 화면이 숨긴다(views/topMenu.js visibleMenu · toolVisibility.lockReasonOf).
 *  · 적용 우선순위는 화면이 정한다: 내 메뉴 > 배포된 메뉴 > 포탈 기본 메뉴.
 *  · **검증은 모양·개수·문자 집합**이다. 탭 id·도구 키가 실재하는지는 서버가 모른다(카탈로그는 웹 번들에 있다) — 모르는 키는 화면이
 *    버리고 개수를 밝힌다. 상한을 넘으면 저장을 **거부**한다(조용히 자르지 않는다 — 상한에 걸린 항목이 사라진 줄 모른다).
 *  · 빈 그룹(children 0개)은 저장 시 제외한다(사용자에게 알린 규칙). 같은 항목이 두 그룹에 있으면 앞의 것만 남기고 개수를 돌려준다.
 *  · 강제 배포(`mode:'force'`)는 직접 만든 메뉴를 **지우지 않고 `prev` 로 옮긴다** — 사용자가 '이전 메뉴 복원' 으로 되찾는다.
 *    유지(`mode:'keep'`)는 내 메뉴를 건드리지 않는다(그 사용자는 편집 화면에서 '배포된 메뉴로 바꾸기' 를 누를 수 있다).
 *  · 사용자가 손으로 만든 값이라 원자적 쓰기 + 손상 보존(v2.580 ping/store.js 와 같은 규칙). 비밀 값은 없다(SECRET_FILES 대상 아님).
 *  · 대상 수는 **로컬 계정(users.json) 기준**이다 — AD 계정은 로그인해야 이름이 생기므로 미리 셀 수 없다(배포 메뉴는 그들에게도
 *    적용된다 · 화면이 그 사실을 적는다).
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { capStr } from '../util/capStr.js';

export const MENU_V = 1;
export const LIMITS = Object.freeze({ groups: 40, items: 400, label: 40, id: 40, history: 20, users: 5000 });
export const MODES = Object.freeze(['force', 'keep']);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;   // 그룹 id · 탭 id · 도구 키 · 주소 조각 — 해시 주소에 그대로 들어간다
const USER_RE = /^[A-Za-z0-9._@-]{1,64}$/;          // auth.js createUser 와 같은 문자 집합(+ 'anonymous')

const fileOf = () => path.join(config.configDir, 'user-menus.json');

let cache = null;

function empty() { return { v: 1, users: {}, distributed: null, history: [] }; }

function load() {
  if (cache) return cache;
  const file = fileOf();
  let data = empty();
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('객체가 아닙니다');
      data = {
        v: 1,
        users: (j.users && typeof j.users === 'object' && !Array.isArray(j.users)) ? j.users : {},
        distributed: (j.distributed && typeof j.distributed === 'object') ? j.distributed : null,
        history: Array.isArray(j.history) ? j.history.slice(0, LIMITS.history) : [],
      };
      // 저장돼 있던 메뉴도 지금 규칙으로 다시 좁힌다(옛 판본·손으로 고친 파일). 못 읽는 항목은 그 사용자 메뉴만 버린다.
      for (const [u, rec] of Object.entries(data.users)) {
        if (!USER_RE.test(u) || !rec || typeof rec !== 'object') { delete data.users[u]; continue; }
        const mine = safeMenu(rec.menu);
        const prev = rec.prev && typeof rec.prev === 'object' ? safeMenu(rec.prev.menu) : null;
        if (!mine && !prev) { delete data.users[u]; continue; }
        data.users[u] = {
          ...(mine ? { menu: mine.menu, updatedAt: numOr(rec.updatedAt) } : {}),
          ...(prev ? { prev: { menu: prev.menu, at: numOr(rec.prev.at), by: capStr(rec.prev.by, 64), mode: MODES.includes(rec.prev.mode) ? rec.prev.mode : 'force' } } : {}),
        };
      }
      if (data.distributed) {
        const d = safeMenu(data.distributed.menu);
        data.distributed = d ? {
          menu: d.menu, at: numOr(data.distributed.at), by: capStr(data.distributed.by, 64),
          mode: MODES.includes(data.distributed.mode) ? data.distributed.mode : 'keep',
          counts: countsOf(data.distributed.counts),
        } : null;
      }
      data.history = data.history.filter((h) => h && typeof h === 'object').map((h) => ({
        at: numOr(h.at), by: capStr(h.by, 64), mode: ['force', 'keep', 'clear'].includes(h.mode) ? h.mode : 'keep', counts: countsOf(h.counts),
      }));
    }
  } catch (e) {
    preserveCorrupt(file, e.message);
    console.warn(`[usermenu] ${path.basename(file)} 를 읽지 못해 빈 저장소로 시작합니다(원본은 .corrupt 로 보존): ${e.message}`);
    data = empty();
  }
  cache = data;
  return cache;
}

function persist() {
  atomicWriteFileSync(fileOf(), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

const numOr = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const countsOf = (c) => ({ users: numOr(c?.users) ?? 0, custom: numOr(c?.custom) ?? 0, forced: numOr(c?.forced) ?? 0 });
const safeMenu = (m) => { try { return normalizeMenu(m); } catch { return null; } };

/** 저장소 오류 — 라우트가 status 로 응답한다(bulletin/store.js 와 같은 모양). */
function fail(status, reason, field) {
  const e = new Error(reason);
  e.status = status;
  if (field) e.field = field;
  return e;
}

/**
 * 메뉴 검증·정규화. 돌려주는 것: { menu, dedup, emptyDropped } — 상한 초과·형식 오류는 400 으로 **던진다**.
 * 입력은 `{ groups: [...] }` 또는 `{ v, groups }`.
 */
export function normalizeMenu(input) {
  const groupsIn = input && typeof input === 'object' && Array.isArray(input.groups) ? input.groups : null;
  if (!groupsIn) throw fail(400, '메뉴 형식이 올바르지 않습니다(groups 배열이 필요합니다)', 'groups');
  if (groupsIn.length > LIMITS.groups) throw fail(400, `그룹은 최대 ${LIMITS.groups}개입니다(받은 ${groupsIn.length}개)`, 'groups');
  const seenGroup = new Set();
  const seenItem = new Set();
  let dedup = 0;
  let emptyDropped = 0;
  let items = 0;
  const groups = [];
  for (const g of groupsIn) {
    if (!g || typeof g !== 'object') throw fail(400, '그룹이 객체가 아닙니다', 'groups');
    const id = String(g.id ?? '').trim();
    if (!ID_RE.test(id)) throw fail(400, `그룹 id 형식이 올바르지 않습니다: ${capStr(id, 40) || '(빈 값)'}`, 'groups');
    if (seenGroup.has(id)) throw fail(400, `그룹 id 가 겹칩니다: ${id}`, 'groups');
    seenGroup.add(id);
    const label = capStr(String(g.label ?? '').trim(), LIMITS.label);
    if (g.tab != null && g.tab !== '') {
      const tab = String(g.tab).trim();
      if (!ID_RE.test(tab)) throw fail(400, `탭 id 형식이 올바르지 않습니다: ${capStr(tab, 40)}`, 'groups');
      const key = `tab:${tab}`;
      if (seenItem.has(key)) { dedup += 1; continue; }
      seenItem.add(key);
      items += 1;
      groups.push({ id, ...(label ? { label } : {}), tab });
      continue;
    }
    const childrenIn = Array.isArray(g.children) ? g.children : [];
    const children = [];
    for (const it of childrenIn) {
      if (!it || typeof it !== 'object') throw fail(400, `그룹 ${id} 의 항목이 객체가 아닙니다`, 'children');
      let child;
      if (it.tool != null && it.tool !== '') {
        const tool = String(it.tool).trim();
        if (!ID_RE.test(tool)) throw fail(400, `도구 키 형식이 올바르지 않습니다: ${capStr(tool, 40)}`, 'children');
        child = { tool };
        if (it.seg != null && it.seg !== '') {
          const seg = String(it.seg).trim();
          if (!ID_RE.test(seg)) throw fail(400, `주소 조각 형식이 올바르지 않습니다: ${capStr(seg, 40)}`, 'children');
          child.seg = seg;
        }
      } else if (it.tab != null && it.tab !== '') {
        const tab = String(it.tab).trim();
        if (!ID_RE.test(tab)) throw fail(400, `탭 id 형식이 올바르지 않습니다: ${capStr(tab, 40)}`, 'children');
        child = { tab };
      } else {
        throw fail(400, `그룹 ${id} 의 항목에 tab 또는 tool 이 없습니다`, 'children');
      }
      const key = child.tool ? `tool:${child.tool}${child.seg ? `/${child.seg}` : ''}` : `tab:${child.tab}`;
      if (seenItem.has(key)) { dedup += 1; continue; }
      seenItem.add(key);
      children.push(child);
    }
    if (!children.length) { emptyDropped += 1; continue; }
    items += children.length;
    groups.push({ id, ...(label ? { label } : {}), children });
  }
  if (items > LIMITS.items) throw fail(400, `메뉴 항목은 최대 ${LIMITS.items}개입니다(받은 ${items}개)`, 'children');
  if (!groups.length) throw fail(400, '메뉴에 항목이 하나도 없습니다', 'groups');
  return { menu: { v: MENU_V, groups }, dedup, emptyDropped };
}

const userKey = (username) => {
  const u = String(username ?? '').trim();
  if (!USER_RE.test(u)) throw fail(400, '사용자 이름을 알 수 없습니다');
  return u;
};

/** 한 사용자의 저장분. prev 는 메뉴 본문을 뺀 메타만(복원은 restorePrevMenu). */
export function userMenuOf(username) {
  const rec = load().users[userKey(username)];
  return {
    mine: rec?.menu ? structuredClone(rec.menu) : null,
    updatedAt: rec?.updatedAt ?? null,
    prev: rec?.prev ? { at: rec.prev.at, by: rec.prev.by, mode: rec.prev.mode } : null,
  };
}

export function saveUserMenu(username, input) {
  const u = userKey(username);
  const data = load();
  if (!data.users[u] && Object.keys(data.users).length >= LIMITS.users) throw fail(400, `저장할 수 있는 사용자 메뉴는 최대 ${LIMITS.users}명분입니다`);
  const r = normalizeMenu(input);
  data.users[u] = { ...(data.users[u] || {}), menu: r.menu, updatedAt: Date.now() };
  persist();
  return { menu: structuredClone(r.menu), dedup: r.dedup, emptyDropped: r.emptyDropped };
}

/** 내 메뉴 삭제(→ 배포 메뉴·포탈 기본으로). prev 는 남긴다. 지울 것이 없으면 false. */
export function clearUserMenu(username) {
  const u = userKey(username);
  const data = load();
  const rec = data.users[u];
  if (!rec?.menu) return false;
  if (rec.prev) data.users[u] = { prev: rec.prev }; else delete data.users[u];
  persist();
  return true;
}

/** 강제 배포가 밀어낸 직전 메뉴를 내 메뉴로 되돌린다. 없으면 null. */
export function restorePrevMenu(username) {
  const u = userKey(username);
  const data = load();
  const rec = data.users[u];
  if (!rec?.prev?.menu) return null;
  data.users[u] = { menu: structuredClone(rec.prev.menu), updatedAt: Date.now() };
  persist();
  return structuredClone(rec.prev.menu);
}

export function distributedMenu() {
  const d = load().distributed;
  return d ? structuredClone(d) : null;
}

/** 배포 전 현황 — 대상 수(로컬 계정)·직접 만든 메뉴가 있는 사용자 수·마지막 배포·기록. */
export function distributeStatus(allUsernames = []) {
  const data = load();
  const names = new Set((allUsernames || []).map((x) => String(x)));
  const custom = Object.entries(data.users).filter(([, r]) => r?.menu).map(([u]) => u);
  return {
    users: names.size,
    custom: custom.length,
    customKnown: custom.filter((u) => names.has(u)).length, // 로컬 계정 중 직접 만든 사용자(AD 등 그 밖은 custom − customKnown)
    distributed: data.distributed ? structuredClone(data.distributed) : null,
    history: structuredClone(data.history),
  };
}

/**
 * 배포. `menu` 는 보통 슈퍼 관리자의 내 메뉴(라우트가 꺼내 넘긴다). mode:
 *   force — 직접 만든 사용자의 메뉴를 prev 로 옮기고 지운다(배포 메뉴가 적용된다. 복원 가능)
 *   keep  — 직접 만든 사용자는 그대로(배포 메뉴는 내 메뉴가 없는 사용자에게만)
 * 배포자 자신의 내 메뉴는 건드리지 않는다(같은 내용이고, 지우면 다음 편집이 배포본을 또 바꾼다).
 */
export function distribute(input, { by, mode, allUsernames = [] } = {}) {
  if (!MODES.includes(mode)) throw fail(400, '배포 방식은 force(강제 적용) 또는 keep(유지)이어야 합니다', 'mode');
  const who = capStr(String(by ?? '').trim(), 64);
  if (!who) throw fail(400, '배포자를 알 수 없습니다');
  const r = normalizeMenu(input);
  const data = load();
  const at = Date.now();
  let forced = 0;
  const custom = Object.entries(data.users).filter(([, rec]) => rec?.menu).length;
  if (mode === 'force') {
    for (const [u, rec] of Object.entries(data.users)) {
      if (!rec?.menu || u === who) continue;
      data.users[u] = { prev: { menu: rec.menu, at, by: who, mode: 'force' } };
      forced += 1;
    }
  }
  const counts = { users: new Set((allUsernames || []).map(String)).size, custom, forced };
  data.distributed = { menu: r.menu, at, by: who, mode, counts };
  data.history.unshift({ at, by: who, mode, counts });
  data.history = data.history.slice(0, LIMITS.history);
  persist();
  return { at, mode, counts, dedup: r.dedup, emptyDropped: r.emptyDropped };
}

/** 배포 메뉴 철회 — 내 메뉴가 없는 사용자는 포탈 기본 메뉴로 돌아간다. 사용자 메뉴(prev 포함)는 건드리지 않는다. */
export function clearDistributed({ by } = {}) {
  const data = load();
  if (!data.distributed) return false;
  const at = Date.now();
  data.distributed = null;
  data.history.unshift({ at, by: capStr(String(by ?? ''), 64), mode: 'clear', counts: { users: 0, custom: 0, forced: 0 } });
  data.history = data.history.slice(0, LIMITS.history);
  persist();
  return true;
}

/** 테스트·재로드용 — 캐시를 버린다(다음 호출이 파일을 다시 읽는다). */
export function invalidateUserMenus() { cache = null; }
