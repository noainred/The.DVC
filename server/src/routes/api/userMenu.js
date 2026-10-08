/**
 * routes/api/userMenu.js — 계정별 좌측 메뉴(내 메뉴)·슈퍼 관리자 배포 API(v2.726).
 *
 * 권한
 *  · `GET/PUT/DELETE /user-menu` · `POST /user-menu/restore-prev`: **로그인 사용자 전부**(viewer 포함) — 자기 계정의 화면 배치다.
 *    서버 불변조건 '/api 상태변경은 requireRole(admin, operator)' 은 다른 사람·장비에 닿는 상태를 말한다. 이 저장은 `POST /tool-usage`
 *    (사용 횟수)처럼 사용자 자신의 선호값이고 권한을 넓히지 않는다(메뉴에 넣어도 권한 없는 항목은 화면이 숨기고 서버 게이트는 그대로).
 *    데모 계정은 `authMiddleware` 의 demoGuest 판정이 쓰기를 막는다(SAFE_ACTIONS 밖 — 공용 계정의 메뉴를 누구나 바꾸면 안 된다).
 *  · `GET/POST/DELETE /user-menu/distribute`: **super_admin + 전체 범위만**(`requireSuperAdmin` — 저장 역할 super_admin 은 요청 문맥에서
 *    `superAdmin:true` 로 접힌다, auth/roles.js). 전 사용자 화면을 바꾸는 동작이라 감사 로그를 남긴다.
 * 응답의 `categories`·`overrides` 는 특수 기능 분류 설정(toolcats)에서 읽는다 — 사이드바의 '특수 기능' 하위(분류 바로가기)와 도구 이름
 * 덮어쓰기를 한 번의 조회로 받기 위해서다(화면이 `/admin/tool-categories` 를 또 부르지 않게).
 * v2.727(감사 A-09): GET 두 핸들러도 `fail()` 로 감싼다 — 저장소의 400-status 오류(빈 사용자 이름)가 500 으로 나갔다.
 * v2.727(감사 A-10·B-04): `distributed.by`·`prev.by`(배포자 = 슈퍼 관리자 계정명)는 **admin 역할에게만** 싣는다(데모 계정 제외) —
 *   viewer 응답에 관리자 계정명을 실을 이유가 없다(v2.500 L-2 계정 열거 단서). 필드를 생략하고 화면은 '슈퍼 관리자' 로 말한다.
 */
import { requireRole, listUsers } from '../../auth/auth.js';
import { isSuperAdmin } from '../../auth/roles.js';
import { isDemoGuest } from '../../auth/demoGuest.js'; // v2.727(감사 A-10·B-04)
import { logAudit } from '../../audit.js';
import { fullScopeOnlyWith } from '../admin/shared.js';
import { clientIp } from '../../util/rateLimit.js';
import { load as loadToolCats } from '../../toolcats/settings.js';
import {
  userMenuOf, saveUserMenu, clearUserMenu, restorePrevMenu, distributedMenu, distributeStatus, distribute, clearDistributed, LIMITS, MODES,
} from '../../usermenu/store.js';

const adminOnly = requireRole('admin');
const menuFleetOnly = fullScopeOnlyWith('메뉴 배포는 전 사용자 화면을 바꾸므로 전체 범위(vCenter 제한 없는) 슈퍼 관리자만 할 수 있습니다.');
/** super_admin 전용 게이트 — `req.user.superAdmin`(저장 역할 super_admin 을 접은 표지)만 통과. 역할 admin 은 403 `super-admin-only`. */
function requireSuperAdmin(req, res, next) {
  if (isSuperAdmin(req.user)) return next();
  return res.status(403).json({ error: 'forbidden', reason: 'super-admin-only', requiredRole: 'super_admin' });
}

const userOf = (req) => req.user?.username || 'anonymous';
/** 배포자·보관자 계정명을 응답에 실어도 되는 요청인가(v2.727 A-10) — admin 역할 + 데모 계정 아님. */
const seesNames = (req) => req.user?.role === 'admin' && !isDemoGuest(req.user);
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
const localUsernames = () => listUsers().map((u) => u.username);

/** 저장소 오류(status 가 붙은 것)를 응답으로 — 그 밖은 전역 처리기로(bulletin.js 와 같은 모양). */
function fail(res, e, next) {
  if (e && Number.isInteger(e.status)) return res.status(e.status).json({ ok: false, reason: e.message, ...(e.field ? { field: e.field } : {}) });
  return next(e);
}

/** 특수 기능 분류(켜져 있을 때만)·이름 덮어쓰기 — 사이드바가 쓴다. */
function catalogBits() {
  let cats = [];
  let overrides = {};
  try {
    const cfg = loadToolCats();
    if (cfg?.enabled) {
      cats = (cfg.categories || []).filter((c) => c && c.enabled !== false && c.id)
        .map((c) => ({ id: String(c.id), label: String(c.label || c.id), icon: String(c.icon || ''), tools: (Array.isArray(c.tools) ? c.tools : []).map(String) }));
    }
    for (const [k, o] of Object.entries(cfg?.overrides || {})) {
      const label = String(o?.label || '').trim();
      if (label) overrides[k] = { label };
    }
  } catch { /* 분류는 편의 기능 — 못 읽어도 메뉴는 동작한다 */ }
  return { categories: cats, overrides };
}

export function registerUserMenu(api) {
  api.get('/user-menu', (req, res, next) => {
    try {
      const me = userMenuOf(userOf(req));
      const d = distributedMenu();
      const names = seesNames(req);
      res.set('Cache-Control', 'no-store');
      res.json({
        ok: true,
        username: userOf(req),
        mine: me.mine,
        updatedAt: me.updatedAt,
        prev: me.prev ? { at: me.prev.at, mode: me.prev.mode, ...(names ? { by: me.prev.by } : {}) } : null,
        distributed: d ? { menu: d.menu, at: d.at, mode: d.mode, ...(names ? { by: d.by } : {}) } : null,
        canDistribute: isSuperAdmin(req.user),
        limits: LIMITS,
        ...catalogBits(),
      });
    } catch (e) { fail(res, e, next); }
  });

  api.put('/user-menu', (req, res, next) => {
    try {
      const r = saveUserMenu(userOf(req), req.body?.menu ?? req.body);
      audit(req, 'user-menu.save', userOf(req), `groups=${r.menu.groups.length}${r.dedup ? ` dedup=${r.dedup}` : ''}${r.emptyDropped ? ` emptyDropped=${r.emptyDropped}` : ''}${r.prevKept ? ' prev=save' : ''}`);
      res.json({ ok: true, menu: r.menu, dedup: r.dedup, emptyDropped: r.emptyDropped, prevKept: r.prevKept });
    } catch (e) { fail(res, e, next); }
  });

  api.delete('/user-menu', (req, res, next) => {
    try {
      const removed = clearUserMenu(userOf(req));
      if (removed) audit(req, 'user-menu.clear', userOf(req));
      res.json({ ok: true, removed });
    } catch (e) { fail(res, e, next); }
  });

  api.post('/user-menu/restore-prev', (req, res, next) => {
    try {
      const menu = restorePrevMenu(userOf(req));
      if (!menu) return res.status(404).json({ ok: false, reason: '복원할 이전 메뉴가 없습니다' });
      audit(req, 'user-menu.restore', userOf(req), `groups=${menu.groups.length}`);
      res.json({ ok: true, menu });
    } catch (e) { fail(res, e, next); }
  });

  api.get('/user-menu/distribute', adminOnly, menuFleetOnly, requireSuperAdmin, (req, res, next) => {
    try {
      const st = distributeStatus(localUsernames());
      res.json({
        ok: true, users: st.users, custom: st.custom, customKnown: st.customKnown,
        distributed: st.distributed ? { at: st.distributed.at, by: st.distributed.by, mode: st.distributed.mode, counts: st.distributed.counts, groups: st.distributed.menu.groups.length } : null,
        history: st.history, modes: MODES, hasMine: !!userMenuOf(userOf(req)).mine,
      });
    } catch (e) { fail(res, e, next); }
  });

  api.post('/user-menu/distribute', adminOnly, menuFleetOnly, requireSuperAdmin, (req, res, next) => {
    try {
      const mode = String(req.body?.mode || '');
      if (!MODES.includes(mode)) return res.status(400).json({ ok: false, reason: '배포 방식은 force(강제 적용) 또는 keep(유지)이어야 합니다', field: 'mode' });
      const mine = userMenuOf(userOf(req)).mine;
      if (!mine) return res.status(400).json({ ok: false, reason: '먼저 내 메뉴를 저장한 뒤 배포할 수 있습니다' });
      const r = distribute(mine, { by: userOf(req), mode, allUsernames: localUsernames() });
      audit(req, 'user-menu.distribute', mode, `users=${r.counts.users} custom=${r.counts.custom} forced=${r.counts.forced} groups=${mine.groups.length}`);
      res.json({ ok: true, at: r.at, mode: r.mode, counts: r.counts });
    } catch (e) { fail(res, e, next); }
  });

  api.delete('/user-menu/distribute', adminOnly, menuFleetOnly, requireSuperAdmin, (req, res, next) => {
    try {
      const removed = clearDistributed({ by: userOf(req) });
      if (removed) audit(req, 'user-menu.distribute-clear', userOf(req));
      res.json({ ok: true, removed });
    } catch (e) { fail(res, e, next); }
  });
}
