/**
 * 역할 위계(v2.643) — 순수 모듈(의존 0).
 *
 * 사용자 요청(2026-09-29): "super_admin 이라는 role 을 만들고 … noainred 계정은 super_admin …
 * super_admin 은 super_admin 사용자만 추가/삭제 가능".
 *
 * ── 설계 ────────────────────────────────────────────────────────────────────
 * super_admin 은 **admin 의 상위 집합**이다(admin 이 할 수 있는 것 전부 + super_admin 계정 관리 +
 * admin 이 끌 수 있는 권한(CSV)의 항상 허용). 저장 역할(users.json)은 `super_admin` 이지만,
 * **요청 문맥(req.user)의 `role` 은 `admin` 으로 두고 `superAdmin:true` 를 더한다**(`authzRole`).
 *
 * ⚠ 왜 이렇게 하는가: 서버에 `role === 'admin'` 판정이 63곳, 웹에 24곳, `requireRole('admin')` 이 수백 곳
 *   있다. 저장 역할을 그대로 흘리면 **한 곳만 빠뜨려도 super_admin(= noainred)이 관리자 기능에서 잠긴다**.
 *   권한 판정의 입구 하나(resolveTokenUser·authenticateLocal)에서 접어 두면 기존 판정이 전부 그대로 맞다.
 *   super_admin 만의 판정은 `isSuperAdmin(req.user)` 하나로 한다(`req.user.role === 'super_admin'` 은
 *   **언제나 거짓**이다 — 쓰지 말 것).
 * ⚠ 저장 레코드(`users.json`)를 보는 판정(마지막 관리자 보호·초기 설치 상태·OTP 강제 대상)은
 *   `isAdminTier(role)` 로 super_admin 을 admin 과 같이 센다.
 */
export const SUPER_ADMIN = 'super_admin';
/** 저장 가능한 역할(위에서 아래로 권한이 줄어든다). */
export const VALID_ROLES = Object.freeze([SUPER_ADMIN, 'admin', 'operator', 'viewer']);

/** 저장 역할이 관리자 계열(admin·super_admin)인가. */
export function isAdminTier(role) { return role === 'admin' || role === SUPER_ADMIN; }

/** 저장 역할 → 요청 문맥 역할(권한 판정용). super_admin 은 admin 으로 접는다. */
export function authzRole(role) { return role === SUPER_ADMIN ? 'admin' : role; }

/** 사용자(요청 문맥 req.user 또는 저장 레코드)가 super_admin 인가. */
export function isSuperAdmin(u) { return !!u && (u.superAdmin === true || u.role === SUPER_ADMIN); }
