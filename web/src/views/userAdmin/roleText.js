/**
 * roleText.js — 역할 위계(super_admin) 화면 판정·문구(v2.643, 순수 — vitest 고정).
 *
 * 사용자 지시(2026-09-29): "super_admin 이라는 role 을 만들고 … csv import/export 기능은 관리자 이상만 …
 * csv 설정을 권한 설정 메뉴에 추가 … super_admin 은 super_admin 사용자만 추가/삭제".
 * ⚠ 이것은 **표시 게이팅**이다 — 집행은 서버(auth/auth.js superAdminGuardDenied · routes/admin/users.js)가 한다.
 * ⚠ 요청 문맥의 내 역할(`/auth/me` role)은 super_admin 이어도 'admin' 이고 `superAdmin:true` 가 붙는다
 *   (서버 auth/roles.js 머리말). 그래서 '나는 super_admin 인가' 는 `me.superAdmin` 으로 본다.
 *   반면 사용자 목록(`/admin/users`)의 `role` 은 **저장 역할**이라 'super_admin' 이 그대로 온다.
 */
export const SUPER_ADMIN = 'super_admin';
const BASE_ROLES = ['viewer', 'operator', 'admin'];

/** 저장 역할이 관리자 계열인가(admin·super_admin). */
export function isAdminTier(role) { return role === 'admin' || role === SUPER_ADMIN; }

/** 역할 선택지 — super_admin 은 내가 super_admin 이거나 그 계정이 이미 super_admin 일 때만 보인다. */
export function roleOptions(meSuper, currentRole) {
  return (meSuper || currentRole === SUPER_ADMIN) ? [...BASE_ROLES, SUPER_ADMIN] : [...BASE_ROLES];
}

/** 이 계정(목록의 u)을 내가 바꿀 수 없는가 — super_admin 계정은 super_admin 만 관리한다. */
export function superTargetLocked(meSuper, u) { return !!u && u.role === SUPER_ADMIN && !meSuper; }

export const SUPER_LOCK_TITLE = 'super_admin 계정은 super_admin 만 추가·삭제·변경할 수 있습니다.';
export const SUPER_ROLE_TITLE = 'super_admin — admin 의 모든 권한 + super_admin 계정 관리 + CSV 가져오기/내보내기(항상 허용).';

/** 역할 배지 색(표시용). */
export function roleBadgeTone(role) {
  return role === SUPER_ADMIN ? 'green' : role === 'admin' ? 'red' : role === 'operator' ? 'amber' : 'blue';
}

/**
 * 권한 매트릭스의 한 칸 상태.
 * @param {{key:string, adminOnly?:boolean, adminToggle?:boolean}} p 카탈로그 항목
 * @param {'super_admin'|'admin'|'operator'|'viewer'} role
 * @param {{matrix:object, canEditAdminRow?:boolean}} perms
 * @returns {{checked:boolean, disabled:boolean, title?:string}}
 */
export function permCell(p, role, perms) {
  const m = (perms && perms.matrix) || {};
  if (role === SUPER_ADMIN) return { checked: true, disabled: true, title: 'super_admin 은 항상 전체 권한입니다(끌 수 없습니다).' };
  if (role === 'admin') {
    if (!p.adminToggle) return { checked: true, disabled: true, title: 'admin은 항상 전체' };
    const off = Array.isArray(m.adminDenied) && m.adminDenied.includes(p.key);
    return perms && perms.canEditAdminRow
      ? { checked: !off, disabled: false, title: 'admin 에게 이 권한을 줄지 정합니다(super_admin 만 바꿀 수 있습니다).' }
      : { checked: !off, disabled: true, title: '이 칸은 super_admin 만 바꿀 수 있습니다.' };
  }
  if (p.adminOnly) return { checked: false, disabled: true, title: '관리자 전용 권한 — operator·viewer 에게는 줄 수 없습니다.' };
  return { checked: ((m[role]) || []).includes(p.key), disabled: false };
}

/** admin 행 토글 — adminDenied(끈 키 목록)를 뒤집은 새 matrix. */
export function toggleAdminDenied(matrix, key) {
  const cur = new Set((matrix && Array.isArray(matrix.adminDenied)) ? matrix.adminDenied : []);
  cur.has(key) ? cur.delete(key) : cur.add(key);
  return { ...matrix, adminDenied: [...cur] };
}

export const MATRIX_NOTE = '역할에 기능 권한을 켜고 끕니다. **super_admin** 은 항상 전체 권한입니다. **admin** 도 전체 권한이지만 '
  + 'CSV 가져오기/내보내기는 super_admin 이 끌 수 있습니다. 관리자 전용 권한(CSV)은 operator·viewer 에게 줄 수 없습니다. '
  + '서버에서 강제되므로(메뉴를 숨겨도 API 직접 호출 차단), 저장 즉시 각 사용자에 반영됩니다.';
