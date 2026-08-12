import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync, preserveCorrupt } from '../util/atomicWrite.js';
import { authenticateAD } from './ad.js';
import * as totp from './totp.js';
import { checkOtpAllowed, recordOtpFailure, recordOtpSuccess } from '../security/loginRateLimit.js';
import { rolePermissionSet } from './permissions.js';
import { effectiveLoginPolicy, userLoginPolicy } from '../security/securitySettings.js';

// users.json lives in CONFIG_DIR (default app/server/config; set to e.g.
// /etc/vmware-portal to keep it outside the app dir across upgrades).
const CONFIG_DIR = config.configDir;

/* ----------------------------- password hashing ---------------------------- */
// scrypt-based, no native dependencies. Format: scrypt$<saltHex>$<hashHex>

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* --------------------------------- JWT (HS256) ----------------------------- */

const SECRET = config.auth.secret || crypto.randomBytes(32).toString('hex');
if (!config.auth.secret && config.auth.enabled) {
  console.warn('[auth] AUTH_SECRET not set — using a random secret; tokens reset on restart.');
}

const b64url = (input) => Buffer.from(input).toString('base64url');

function ttlSeconds(ttl) {
  if (typeof ttl === 'number') return ttl;
  const m = String(ttl).match(/^(\d+)\s*([smhd])?$/);
  if (!m) return 8 * 3600;
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2]] || 1);
}

export function signToken(payload) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds(config.auth.tokenTtl) };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  const sigBuf = Buffer.from(s);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

/* --------------------------------- user store ------------------------------ */

let users = null;

// 데모 전용 내장 계정 — 항상 존재하며 viewer 고정. 비밀번호(또는 OTP)가 설정되어 있지 않으면
// 로그인 자체가 불가능하다(authenticateLocal 이 passwordHash 없는 계정을 거부). 관리자가
// 설정 › 사용자 관리에서 비밀번호를 설정하면 그때부터 로그인 가능, '로그인 차단'으로 다시 잠근다.
export const DEMO_USERNAME = 'thedvcdemp';

// 최고 권한(수퍼관리자) 계정 — 항상 admin 역할이 보장되고(로드 시 강제), 강등·삭제·로그인 차단이
// 모두 거부된다. 설정 소유자(settingsOwners)에도 항상 포함된다(securitySettings 참고).
export const SUPER_USERNAME = 'noainred';

// 수퍼관리자 보장: 없으면 생성(비번 없이 = 비번 설정 전 로그인 불가), 있으면 admin 역할 강제.
function ensureSuperUser(list) {
  const u = list.find((x) => x.username === SUPER_USERNAME);
  if (!u) { list.push({ username: SUPER_USERNAME, name: 'noainred', role: 'admin', superuser: true }); return true; }
  let changed = false;
  if (u.role !== 'admin') { u.role = 'admin'; changed = true; } // 강등돼 있었다면 복구
  if (!u.superuser) { u.superuser = true; changed = true; }
  return changed;
}

// 목록에 데모 계정이 없으면 추가(비번 없이 = 로그인 불가 상태로 시작). 같은 이름의 계정을
// 사용자가 이미 만들어 둔 경우에는 건드리지 않는다(하이재킹 방지 — demo 태그도 붙이지 않음).
function ensureDemoUser(list) {
  if (!list.some((u) => u.username === DEMO_USERNAME)) {
    list.push({ username: DEMO_USERNAME, name: 'Demo', role: 'viewer', demo: true });
    return true;
  }
  return false;
}

export function loadUsers() {
  if (users) return users;
  const file = path.join(CONFIG_DIR, 'users.json');
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.users) && parsed.users.length) {
        users = parsed.users;
        const changed = [ensureDemoUser(users), ensureSuperUser(users)].some(Boolean);
        if (changed) { try { persistUsers(); } catch { /* 다음 저장 때 함께 기록 */ } }
        return users;
      }
    } catch (err) {
      // 손상본을 조용히 무시하고 아래에서 기본 admin을 시드하면, 다음 persistUsers가
      // 실사용자 전부를 시드 1건으로 덮어써 계정이 영구 유실된다 → 손상본을 .corrupt로 보존.
      preserveCorrupt(file, err.message);
      console.error(`[auth] Failed to parse users.json: ${err.message}`);
    }
  }
  // Seed a default admin so the portal is usable out of the box.
  // 보안(H4): 알려진 기본 비번(admin123) 대신 — DEFAULT_ADMIN_PASSWORD가 있으면 그것을,
  // 없으면 '임의 비번'을 생성해 CONFIG_DIR/initial-admin-password.txt(0600)에 기록한다.
  // (비밀번호는 절대 로그/로그버퍼에 남기지 않는다 — /admin/logs로 노출되므로.)
  const envPw = process.env.DEFAULT_ADMIN_PASSWORD;
  let pw = envPw; let note;
  if (envPw) {
    note = 'DEFAULT_ADMIN_PASSWORD로 시드';
  } else {
    pw = crypto.randomBytes(12).toString('base64url'); // 알려지지 않은 임의 비번
    try {
      const pwFile = path.join(CONFIG_DIR, 'initial-admin-password.txt');
      atomicWriteFileSync(pwFile, `${pw}\n`, { mode: 0o600 });
      note = `임의 비밀번호 생성 → ${pwFile} (0600)에 저장. 로그인 후 즉시 변경하고 이 파일을 삭제하세요`;
    } catch (e) {
      note = `임의 비밀번호 생성했으나 파일 기록 실패(${e.message}) — DEFAULT_ADMIN_PASSWORD로 재시드하세요`;
    }
  }
  users = [{ username: 'admin', name: 'Administrator', role: 'admin', passwordHash: hashPassword(pw), mustChangePassword: !envPw }];
  ensureDemoUser(users);
  ensureSuperUser(users);
  console.warn(`[auth] users.json이 없어 기본 관리자 "admin"을 시드했습니다 — ${note}.`);
  return users;
}

function persistUsers() {
  const file = path.join(CONFIG_DIR, 'users.json');
  // 원자적 쓰기 — 자격증명 파일이 부분기록으로 손상돼 전 사용자가 유실되는 사고를 방지.
  atomicWriteFileSync(file, JSON.stringify({ users: loadUsers() }, null, 2), { mode: 0o600 });
}

/**
 * Verify a local account. Once a user has TOTP enrolled, the second argument is
 * treated as the 6-digit Google Authenticator code (OTP-only — the password no
 * longer works). Until enrolled, the password is accepted so the account can be
 * bootstrapped/enrolled.
 */
const _dummySalt = crypto.randomBytes(16);

// 고권한 역할(admin/operator — 수퍼관리자 포함)의 최종 상태는 **OTP 전용 로그인**이다.
// v2.206 부터 '부트스트랩 → 강제 등록 → 비번 폐기' 흐름으로 그 상태에 도달한다:
//
//   1) OTP 미등록 고권한 계정은 비밀번호로 로그인할 수 있다(최초 설치·계정 발급 직후).
//   2) 단, 그 세션은 **OTP 등록 외 아무 것도 할 수 없다**(mustEnrollOtp → requireEnrolled 가
//      /api 전 라우터를 차단). 프론트도 등록 화면에 고정된다.
//   3) 등록을 확정하면 `confirmTotpEnroll` 이 비밀번호 해시를 삭제하고 토큰을 폐기한다
//      → 이후 그 계정은 영구히 OTP 6자리로만 로그인한다(비번 로그인 경로 소멸).
//
// viewer(데모 계정 포함)는 이 강제 대상이 아니며 비밀번호 로그인을 계속 쓴다.
// OTP_ROLE_ENFORCE=false 로 강제 등록을 끌 수 있다(긴급용).
// 헤드리스 등록·잠금 복구는 콘솔 도구(server/src/tools/otp-enroll.js, otp-enroll.sh)를 쓴다.
const OTP_ROLE_ENFORCE = process.env.OTP_ROLE_ENFORCE !== 'false';

/**
 * 이 역할이 'OTP 전용 강제'(비밀번호 로그인 금지·미등록이면 강제 등록) 대상인지.
 * 설정 소유자가 지정한 전역 로그인 정책(`security-session.json` loginPolicy)이 이를 결정한다:
 *   null(미설정·기본) : 레거시 — 고권한(admin/operator)만 OTP 전용, 그 외(viewer)는 혼용.
 *   'otp_only'        : 전 로컬 계정 OTP 전용.
 *   'otp_or_password' : 강제 없음(비번 또는 OTP 아무거나 로그인).
 *   'password_only'   : 강제 없음(비번 로그인).
 * 긴급 env `OTP_ROLE_ENFORCE=false` 는 정책과 무관하게 강제를 전면 해제한다(잠금 복구용).
 */
export function isOtpOnlyRole(role) {
  if (!OTP_ROLE_ENFORCE) return false;
  const p = effectiveLoginPolicy();
  if (p === 'otp_or_password' || p === 'password_only') return false;
  if (p === 'otp_only') return true; // 전 계정 강제
  return role === 'admin' || role === 'operator'; // 미설정(레거시): 고권한만
}

/** 이 사용자에게 적용되는 로그인 정책 — 사용자별 재정의(파일/ENV) > 전역 정책 > null(레거시). */
function loginPolicyFor(username) {
  return userLoginPolicy(username) ?? effectiveLoginPolicy();
}

/**
 * 이 '사용자'가 OTP 전용 강제 대상인지 — isOtpOnlyRole 과 같은 규칙이되, 서버 구성 파일의
 * 사용자별 재정의(`CONFIG_DIR/login-policy-users.txt` · env `LOGIN_POLICY_USERS`, UI 미노출)를
 * 먼저 본다. 로그인 판정·토큰 해석(mustEnrollOtp)·OTP 등록 시 비번 폐기는 모두 이 함수를 쓴다
 * (isOtpOnlyRole 은 특정 사용자가 없는 역할 단위 판단 전용 — 예: warnIfNoOtpAdmin).
 */
export function isOtpOnlyUser(username, role) {
  if (!OTP_ROLE_ENFORCE) return false;
  const p = loginPolicyFor(username);
  if (p === 'otp_or_password' || p === 'password_only') return false;
  if (p === 'otp_only') return true;
  return role === 'admin' || role === 'operator'; // 미설정(레거시): 고권한만
}

/**
 * 기동 시 점검 — OTP 를 등록한 admin 이 하나도 없으면 웹으로 로그인할 수 있는 관리자가 없다.
 * 유예가 폐지됐으므로 콘솔 등록 도구를 안내한다(조용히 잠기는 상황 방지).
 */
/**
 * 초기 설치 상태 — 로그인 화면 안내용(공개 /auth/config 에 실린다).
 *  setupPending        : OTP 를 등록한 admin 이 아직 하나도 없음(= 초기 구축 중)
 *  initialPasswordFile : 임의 생성된 최초 관리자 비밀번호 파일 경로(존재할 때만)
 * 경로는 이미 문서에 공개된 고정 위치이고 **비밀번호 값 자체는 절대 싣지 않는다**.
 * 설정이 끝나면(OTP 등록 완료) 더 이상 노출되지 않는다.
 */
export function setupState() {
  try {
    const list = loadUsers();
    const setupPending = !list.some((u) => u.role === 'admin' && u.totpEnabled);
    if (!setupPending) return { setupPending: false, initialPasswordFile: null };
    const file = path.join(CONFIG_DIR, 'initial-admin-password.txt');
    return { setupPending: true, initialPasswordFile: fs.existsSync(file) ? file : null };
  } catch {
    return { setupPending: false, initialPasswordFile: null };
  }
}

export function warnIfNoOtpAdmin() {
  // 정책상 admin 이 OTP 전용일 때만 의미 있는 경고(혼용/비번전용이면 admin 은 비번으로 들어올 수 있다).
  if (!isOtpOnlyRole('admin') || !config.auth.enabled) return false;
  const list = loadUsers();
  if (list.some((u) => u.role === 'admin' && u.totpEnabled)) return false;
  console.warn('[auth] ⚠ OTP 가 등록된 admin 계정이 없습니다 — admin/operator 는 비밀번호로 로그인할 수 없습니다(OTP 전용).');
  console.warn('[auth]   서버에서 다음을 실행해 첫 관리자의 OTP 를 등록하세요:');
  console.warn('[auth]     node server/src/tools/otp-enroll.js --list');
  console.warn('[auth]     node server/src/tools/otp-enroll.js <username>');
  console.warn('[auth]   (긴급 시 OTP_ROLE_ENFORCE=false 로 정책을 임시 해제할 수 있습니다.)');
  return true;
}

export function authenticateLocal(username, credential) {
  const user = loadUsers().find((u) => u.username === username);
  if (!user) {
    // 없는 사용자도 동일 비용의 scrypt를 태워 응답시간 차이로 사용자명을 열거하지 못하게 한다.
    try { crypto.scryptSync(String(credential || ''), _dummySalt, 64); } catch { /* */ }
    return null;
  }
  const role = user.role || 'viewer';
  const enforced = isOtpOnlyUser(user.username, role); // OTP 전용 강제 대상이면 비밀번호 로그인 금지
  // OTP 코드 검증 + 재사용(replay) 방지 — 성공하면 성공 카운터를 기록하고 true.
  const tryOtp = () => {
    if (!user.totpEnabled || !user.totpSecret) return false;
    const ctr = totp.verifyToken(credential, user.totpSecret, { minCounter: Number.isInteger(user.totpLastCounter) ? user.totpLastCounter : -1 });
    if (ctr == null) return false;
    if (ctr !== user.totpLastCounter) { user.totpLastCounter = ctr; try { persistUsers(); } catch { /* */ } }
    return true;
  };
  const tryPassword = () => !!user.passwordHash && verifyPassword(credential, user.passwordHash);

  if (enforced) {
    // OTP 전용 강제 — 등록됐으면 OTP 로만, 미등록이면 비밀번호(부트스트랩)로 로그인하되 이 세션은
    // mustEnrollOtp 가 붙어 등록 외 아무 것도 못 한다(등록을 마치면 비밀번호는 삭제된다).
    if (user.totpEnabled && user.totpSecret) { if (!tryOtp()) return null; }
    else if (!tryPassword()) return null;
  } else {
    // 강제 아님 — 이 사용자에게 적용되는 정책(사용자별 재정의 > 전역)에 따라 허용 자격을 정한다.
    const p = loginPolicyFor(user.username);
    if (p === 'password_only' && user.passwordHash) {
      // 비밀번호 전용 — 비번 보유 계정은 비번만(OTP 거부). 비번 없는 레거시(OTP 전용이었던)
      // 계정은 아래 분기의 OTP 폴백으로 로그인해 잠기지 않는다.
      if (!tryPassword()) return null;
    } else {
      // 혼용(otp_or_password)·레거시 viewer·비번 없는 password_only 계정 — 비번 또는 OTP 아무거나.
      if (!tryPassword() && !tryOtp()) return null;
    }
  }
  return {
    username: user.username,
    name: user.name || user.username,
    role,
    source: 'local',
    totpEnabled: !!user.totpEnabled,
    // OTP 전용 강제 대상이 아직 OTP 미등록 → 이번 세션은 'OTP 등록 전용'.
    mustEnrollOtp: enforced && !user.totpEnabled,
  };
}

/* ------------------------------ user management ---------------------------- */

const VALID_ROLES = ['admin', 'operator', 'viewer'];

// 사용자별 데이터 범위(scope) — 볼 수 있는 vCenter/리전을 제한한다(권한 키와는 직교: 무엇을
// '할' 수 있나 ≠ 무엇을 '볼' 수 있나). 둘 다 비면 제한 없음(전체). 형식/타입만 정규화한다.
function sanitizeScope(scope) {
  if (scope == null) return undefined;
  const arr = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean))];
  const vcenters = arr(scope.vcenters);
  const regions = arr(scope.regions);
  if (!vcenters.length && !regions.length) return null; // 명시적 '전체'
  return { vcenters, regions };
}

/** 사용자 레코드의 scope 를 공개형(항상 배열)으로 반환. null/undefined → 전체. */
export function normalizedScope(u) {
  const s = u && u.scope;
  if (!s || (!Array.isArray(s.vcenters) && !Array.isArray(s.regions))) return { vcenters: [], regions: [] };
  return { vcenters: Array.isArray(s.vcenters) ? s.vcenters : [], regions: Array.isArray(s.regions) ? s.regions : [] };
}

// 서버측 토큰 폐기(감사 M5) — 자격증명/역할이 바뀌면 버전을 올려 그 전에 발급된 토큰을
// authMiddleware에서 즉시 무효화한다(로컬 계정 한정; AD는 다음 로그인에 반영).
function bumpTokenVersion(u) { u.tokenVersion = (u.tokenVersion || 0) + 1; }

/** Public-safe user list (no secrets/hashes). */
export function listUsers() {
  return loadUsers().map((u) => ({
    username: u.username, name: u.name || u.username, role: u.role || 'viewer',
    totpEnabled: !!u.totpEnabled, hasPassword: !!u.passwordHash,
    managedBy: u.managedBy || null, // 'central' = 중앙에서 배포·관리하는 계정
    demo: !!u.demo,                 // 내장 데모 계정(viewer 고정·삭제 불가·비번 없으면 로그인 불가)
    superuser: !!u.superuser,       // 수퍼관리자(admin 고정·강등/삭제/로그인차단 불가)
    scope: normalizedScope(u),      // 볼 수 있는 vCenter/리전 제한(빈 배열 = 전체)
  }));
}

export function getUser(username) {
  return loadUsers().find((u) => u.username === username) || null;
}

export function createUser({ username, name, role = 'viewer', password, scope } = {}) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) return { ok: false, reason: '사용자 ID 형식이 올바르지 않습니다.' };
  if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다.' };
  if (getUser(username)) return { ok: false, reason: '이미 존재하는 사용자입니다.' };
  const u = { username, name: name || username, role };
  if (password) u.passwordHash = hashPassword(password);
  const sc = sanitizeScope(scope);
  if (sc) u.scope = sc; // null(명시적 전체)/undefined 는 저장하지 않음(= 전체)
  loadUsers().push(u);
  persistUsers();
  return { ok: true };
}

/**
 * 로컬 사용자 비밀번호 설정(관리자 리셋/중앙 일괄 변경용). OTP 등록 계정은 로그인에 OTP가
 * 우선되므로 해시 갱신은 무해하며, OTP 해제 시 폴백 비밀번호가 된다.
 */
export function setLocalPassword(username, password) {
  // 문자열만 허용 — 객체가 String()으로 "[object Object]"가 되어 의도치 않은 비번이 설정되는 것 방지.
  // 특수문자·유니코드는 전부 그대로 허용(scrypt는 바이트 안전).
  if (password !== undefined && password !== null && typeof password !== 'string') {
    return { ok: false, reason: '비밀번호 형식이 올바르지 않습니다(문자열이어야 합니다).' };
  }
  const pw = String(password || '');
  if (pw.length < 8) return { ok: false, reason: '비밀번호는 8자 이상이어야 합니다.' };
  if (pw.length > 128) return { ok: false, reason: '비밀번호는 128자 이하여야 합니다.' };
  const u = getUser(String(username || '').trim());
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  u.passwordHash = hashPassword(pw);
  bumpTokenVersion(u); // 비번 변경 → 기존 세션 토큰 즉시 폐기
  persistUsers();
  return { ok: true, totpEnabled: !!u.totpEnabled };
}

/**
 * 로그인 차단 — 비밀번호 해시와 OTP 등록을 모두 제거해 이 계정으로 로그인할 수 없게 한다
 * (데모 계정 잠금용). 기존 세션 토큰도 tokenVersion 인상으로 즉시 폐기된다.
 * 다시 로그인하게 하려면 setLocalPassword 로 비밀번호를 설정하면 된다.
 */
export function clearLoginCredentials(username) {
  const u = getUser(String(username || '').trim());
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (u.superuser) return { ok: false, reason: '수퍼관리자 계정의 로그인은 차단할 수 없습니다.' };
  if (u.role === 'admin' && loadUsers().filter((x) => x.role === 'admin').length <= 1) {
    return { ok: false, reason: '마지막 관리자의 로그인은 차단할 수 없습니다.' };
  }
  delete u.passwordHash;
  u.totpEnabled = false;
  delete u.totpSecret;
  delete u.totpPendingSecret;
  bumpTokenVersion(u); // 라이브 세션도 즉시 종료
  persistUsers();
  return { ok: true };
}

export function updateUser(username, { name, role, scope } = {}) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다.' };
    // 데모 계정은 viewer 고정 — 데모 자격증명이 유출돼도 권한 상승 경로가 없게 서버측에서 잠근다.
    if (u.demo && role !== 'viewer') return { ok: false, reason: '데모 계정의 역할은 viewer로 고정되어 있습니다.' };
    // 수퍼관리자는 admin 고정 — 다른 admin 이 강등시켜 최고 권한을 뺏는 경로를 차단.
    if (u.superuser && role !== 'admin') return { ok: false, reason: '수퍼관리자 계정의 역할은 admin으로 고정되어 있습니다.' };
    // Don't allow demoting the last admin.
    if (u.role === 'admin' && role !== 'admin' && loadUsers().filter((x) => x.role === 'admin').length <= 1) {
      return { ok: false, reason: '마지막 관리자는 역할을 변경할 수 없습니다.' };
    }
    if (u.role !== role) bumpTokenVersion(u); // 역할 변경(강등 포함) → 기존 토큰 폐기
    u.role = role;
  }
  if (name !== undefined) u.name = name || u.username;
  if (scope !== undefined) {
    const sc = sanitizeScope(scope);
    if (sc) u.scope = sc; else delete u.scope; // null/빈 값 → 제한 해제(전체)
    // scope 는 데이터 가시 범위라 인증 유효성과 무관 → 토큰을 폐기하지 않는다(resolveTokenUser 가 매 요청 최신값 반영).
  }
  persistUsers();
  return { ok: true };
}

export function deleteUser(username) {
  const list = loadUsers();
  const u = list.find((x) => x.username === username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (u.demo) return { ok: false, reason: '데모 계정은 삭제할 수 없습니다. 로그인을 막으려면 [로그인 차단]으로 비밀번호를 제거하세요.' };
  if (u.superuser) return { ok: false, reason: '수퍼관리자 계정은 삭제할 수 없습니다.' };
  if (u.role === 'admin' && list.filter((x) => x.role === 'admin').length <= 1) {
    return { ok: false, reason: '마지막 관리자는 삭제할 수 없습니다.' };
  }
  users = list.filter((x) => x.username !== username);
  persistUsers();
  return { ok: true };
}

/**
 * 중앙 배포 사용자 적용(엣지 측) — 중앙이 지정한 사용자 집합을 로컬 users.json에 반영한다.
 * 중앙 소유 계정은 managedBy:'central' 태그로 표시하며, 중앙이 생성/갱신/삭제한다.
 *  - 같은 이름의 '로컬(비managed)' 계정은 건드리지 않는다(로컬 관리자 하이재킹 방지 — skip).
 *  - 배포 목록에서 빠진 managed 계정은 제거(단, 마지막 admin은 보호).
 *  - passwordHash가 오면 갱신, 없으면 기존 유지(역할·이름만 변경 가능).
 * 반환 { created, updated, removed, skipped[] }.
 */
export function applyManagedUsers(managed = []) {
  const list = loadUsers();
  const want = new Map((managed || []).filter((u) => u && u.username).map((u) => [String(u.username).trim(), u]));
  const result = { created: 0, updated: 0, removed: 0, skipped: [] };
  for (const [username, m] of want) {
    if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) { result.skipped.push(`${username}(ID 형식)`); continue; }
    if (!VALID_ROLES.includes(m.role)) { result.skipped.push(`${username}(역할)`); continue; }
    const existing = list.find((x) => x.username === username);
    if (existing && existing.managedBy !== 'central') { result.skipped.push(`${username}(로컬 계정 충돌)`); continue; }
    if (!existing) {
      const u = { username, name: m.name || username, role: m.role, managedBy: 'central' };
      if (m.passwordHash) u.passwordHash = m.passwordHash;
      list.push(u); result.created++;
    } else {
      existing.name = m.name || username; existing.role = m.role; existing.managedBy = 'central';
      // 비번이 '실제로 바뀐' 경우에만 기존 토큰 폐기(M5) — 매 동기화마다 세션이 끊기지 않게
      // 동일 해시 재전송은 무시한다(중앙이 비번을 회전하면 라이브 세션도 함께 만료돼야 함).
      if (m.passwordHash && m.passwordHash !== existing.passwordHash) { existing.passwordHash = m.passwordHash; bumpTokenVersion(existing); }
      result.updated++;
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const u = list[i];
    if (u.managedBy === 'central' && !want.has(u.username)) {
      if (u.role === 'admin' && list.filter((x) => x.role === 'admin').length <= 1) { result.skipped.push(`${u.username}(마지막 admin 삭제 보류)`); continue; }
      list.splice(i, 1); result.removed++;
    }
  }
  if (result.created || result.updated || result.removed) persistUsers();
  return result;
}

/** 중앙이 관리 중인(managed) 로컬 계정 목록(요약) — 엣지 상태 표시용. */
export function listManagedUsers() {
  return loadUsers().filter((u) => u.managedBy === 'central').map((u) => ({ username: u.username, name: u.name || u.username, role: u.role || 'viewer' }));
}

/** Start TOTP enrollment: generate a secret (pending until confirmed).
 *  host(접속한 포탈 IP:포트)를 주면 발급 라벨 issuer에 포함해 여러 포탈을 구분한다:
 *  'VMware Portal' → 'VMware(<host>) Portal'. */
export function beginTotpEnroll(username, host = '') {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  const secret = totp.generateSecret();
  // 확정(confirm) 전에는 기존 등록을 절대 건드리지 않는다 — 이전에는 여기서 totpSecret을
  // 교체하고 totpEnabled=false로 영속화해, OTP 전용 계정(passwordHash 삭제됨)이 '재등록 시작'
  // 버튼만 눌러도 기존 OTP·비밀번호 모두 불가한 벽돌 상태가 됐다(마지막 관리자면 복구 불가).
  u.totpPendingSecret = secret;
  persistUsers();
  const base = config.auth.totpIssuer || 'VMware Portal';
  const issuer = host ? (base.includes('VMware') ? base.replace('VMware', `VMware(${host})`) : `${base}(${host})`) : base;
  return {
    ok: true, secret,
    otpauthURL: totp.otpauthURL({ secret, account: username, issuer }),
  };
}

/** 민감 작업 재인증용 — 사용자의 현재 OTP 코드를 검증. OTP 미등록이면 needEnroll.
 *  로그인 경로와 동일하게 사용 카운터(minCounter)를 대조·기록해 같은 코드의 재사용(replay)을
 *  차단한다 — 긴급중단 2인 승인에서 어깨너머로 본 코드를 재사용하는 우회(감사 M1/M2) 방지.
 *  또한 6자리 코드(100만 조합)의 온라인 무차별을 막기 위해 계정별 실패 카운터/잠금을 적용한다
 *  (감사 M1). 잠금 시 { ok:false, reason, retryAfterSec, locked:true } — 호출부는 reason을
 *  그대로 표시하면 된다. 오조작으로 관리자가 갇히는 걸 피해야 하는 배포는
 *  OTP_MAX_FAILS/OTP_LOCKOUT_MS로 조정하거나 OTP_RATELIMIT_DISABLED=true로 끌 수 있다. */
export function verifyUserOtp(username, code) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (!u.totpEnabled || !u.totpSecret) return { ok: false, reason: 'OTP가 등록되지 않은 계정입니다. 먼저 OTP를 등록하세요.', needEnroll: true };
  const gate = checkOtpAllowed(username);
  if (gate.blocked) {
    return { ok: false, locked: true, retryAfterSec: gate.retryAfterSec, reason: `OTP 인증 시도가 일시적으로 잠겼습니다. ${gate.retryAfterSec}초 후 다시 시도하세요.` };
  }
  const ctr = totp.verifyToken(String(code || '').trim(), u.totpSecret, { minCounter: Number.isInteger(u.totpLastCounter) ? u.totpLastCounter : -1 });
  if (ctr == null) {
    const lk = recordOtpFailure(username);
    if (lk.locked) {
      return { ok: false, locked: true, retryAfterSec: lk.retryAfterSec, reason: `OTP 코드가 일치하지 않습니다. 실패가 많아 ${lk.retryAfterSec}초 후 다시 시도하세요.` };
    }
    return { ok: false, reason: 'OTP 코드가 일치하지 않습니다(또는 이미 사용된 코드).', remaining: lk.remaining };
  }
  if (ctr !== u.totpLastCounter) { u.totpLastCounter = ctr; try { persistUsers(); } catch { /* 기록 실패해도 검증 결과는 유효 */ } }
  recordOtpSuccess(username); // 성공 시 실패 카운터 리셋
  return { ok: true };
}

/** Confirm enrollment by verifying a code from the authenticator app. */
export function confirmTotpEnroll(username, code) {
  const u = getUser(username);
  // 신규 흐름은 pending 시크릿으로 확정, (하위호환) 구버전에서 begin만 하고 미확정이던
  // 계정(totpSecret 있고 enabled=false)은 기존 시크릿으로 확정을 이어간다.
  const pending = u?.totpPendingSecret || (u && !u.totpEnabled ? u.totpSecret : null);
  if (!u || !pending) return { ok: false, reason: '먼저 OTP 등록을 시작하세요.' };
  if (!totp.verifyToken(code, pending)) return { ok: false, reason: 'OTP 코드가 일치하지 않습니다.' };
  u.totpSecret = pending;
  delete u.totpPendingSecret;
  u.totpEnabled = true;
  // OTP 전용 강제 대상만 비밀번호를 폐기(이후 OTP 로만 로그인). 혼용/비번전용 정책·사용자별
  // 재정의에서는 비밀번호를 유지해 둘 다 로그인할 수 있게 한다 — 정책이 결정하는 지점이다.
  if (isOtpOnlyUser(u.username, u.role || 'viewer')) delete u.passwordHash;
  bumpTokenVersion(u); // 인증수단 변경 → 기존 토큰 폐기
  persistUsers();
  // 부트스트랩용 임의 비밀번호 파일(평문)은 관리자가 OTP 를 등록하는 순간 역할이 끝난다 → 자동 삭제
  // (정책과 무관하게 항상 지운다 — 임의 생성 초기 비번 평문이 서버에 남는 사고를 막는다).
  if ((u.role || '') === 'admin') {
    try { fs.rmSync(path.join(CONFIG_DIR, 'initial-admin-password.txt'), { force: true }); } catch { /* 없으면 무시 */ }
  }
  return { ok: true };
}

/**
 * Remove TOTP from a user (admin reset) — v2.277 잠금 방지 가드 추가.
 * 배경(확정 버그): OTP 전용 계정은 등록 시 passwordHash 가 삭제돼 비밀번호가 없다. 그 상태에서
 * 임시 비밀번호 없이 OTP 까지 해제하면 비번도 OTP 도 없는 '웹 로그인 완전 불가' 계정이 되고
 * (authenticateLocal 이 어떤 입력에도 null), bumpTokenVersion 으로 라이브 세션까지 즉시 끊겨
 * 복구는 콘솔 도구(otp-enroll.sh)뿐이었다. 마지막 admin 이 본인 OTP 를 해제하면(폰 교체 시
 * 자연스러운 조작) 웹 관리자 접근이 전면 잠겼다. 아래 가드가 그 경로를 서버에서 차단한다.
 */
export function disableTotp(username, { password } = {}) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  // 수퍼관리자 보호 — clearLoginCredentials 와 같은 경계. OTP 전용(비번 없는) 수퍼관리자의
  // OTP 를 다른 admin 이 해제하면 '로그인차단 거부' 경계가 우회된다. 재등록(폰 교체)은 해제
  // 없이 'OTP 등록'(beginTotpEnroll — pending 교체 후 confirm)으로 가능하므로 이 거부가
  // 정상 재등록을 막지 않는다.
  if (u.superuser) return { ok: false, reason: '수퍼관리자 계정의 OTP는 해제할 수 없습니다(재등록은 해제 없이 OTP 등록으로 가능합니다).' };
  // 임시 비밀번호 검증 — setLocalPassword 와 같은 규칙(문자열·8~128자). 검증 없이 hash 하면
  // "[object Object]" 같은 값이 비밀번호가 되는 사고를 만든다.
  if (password !== undefined && password !== '' && (typeof password !== 'string' || password.length < 8 || password.length > 128)) {
    return { ok: false, reason: '임시 비밀번호는 8~128자 문자열이어야 합니다.' };
  }
  // 잠금 방지 — 비밀번호가 없는(OTP 전용으로 폐기된) 계정은 임시 비밀번호 없이 해제 불가.
  // 해제 후 로그인 수단이 0개가 되는 유일한 조합을 서버에서 거부한다(UI 도 재시도 안내).
  if (!password && !u.passwordHash) {
    return { ok: false, reason: '비밀번호가 없는 OTP 전용 계정입니다 — 해제하려면 임시 비밀번호(8자 이상)를 함께 설정하세요.' };
  }
  u.totpEnabled = false;
  delete u.totpSecret;
  delete u.totpPendingSecret;
  if (password) u.passwordHash = hashPassword(password); // restore a temp password so they can log in to re-enroll
  bumpTokenVersion(u); // 인증수단 변경 → 기존 토큰 폐기
  persistUsers();
  return { ok: true };
}

/**
 * Authenticate a user. If Active Directory is enabled, AD is tried first and,
 * on failure (unknown user / AD down), falls back to local users.json — so the
 * built-in admin keeps working alongside AD logins.
 */
export async function authenticate(username, password) {
  try {
    const adUser = await authenticateAD(username, password);
    if (adUser) return adUser;
  } catch { /* fall back to local */ }
  return authenticateLocal(username, password);
}

/* -------------------------------- middleware ------------------------------- */

// 인증 비활성(AUTH_ENABLED=false) 시 익명 사용자에게 부여할 역할(감사 H13). 과거엔 무조건
// admin이라 env 한 줄 실수로 전체 mutation이 익명 개방됐다. 기본은 하위호환(admin) 유지하되
// AUTH_DISABLED_ROLE=viewer|operator 로 낮출 수 있고, requireRole도 이 역할로 실제 검사한다.
const AUTH_DISABLED_ROLE = VALID_ROLES.includes(process.env.AUTH_DISABLED_ROLE)
  ? process.env.AUTH_DISABLED_ROLE : 'admin';
if (!config.auth.enabled) {
  console.warn(`[auth] ⚠ 인증이 비활성(AUTH_ENABLED=false) — 모든 요청이 익명 '${AUTH_DISABLED_ROLE}' 권한으로 처리됩니다. 운영 환경에서는 인증을 켜거나 AUTH_DISABLED_ROLE=viewer 로 제한하세요.`);
}

/**
 * 토큰 → 유효 사용자 해석(공용) — 서명/만료 검증 + 서버측 토큰 폐기(감사 M5) + 최신 역할 적용.
 * 로컬 계정 토큰(src:'local')은 사용자 레코드의 tokenVersion과 대조(비번/역할 변경·삭제 시
 * 즉시 무효)하고, 역할은 토큰이 아니라 현재 사용자 레코드에서 읽는다(강등 즉시 반영).
 * HTTP authMiddleware뿐 아니라 WS SSH/RDP 게이트웨이도 이 함수를 써야 폐기가 우회되지 않는다.
 * (loadUsers는 메모이즈되어 호출당 파일 IO 없음. 구버전 토큰(src 없음)은 TTL 내 자연 만료.)
 */
export function resolveTokenUser(token) {
  const payload = token && verifyToken(token);
  if (!payload) return null;
  if (payload.src === 'local') {
    const u = getUser(payload.sub);
    if (!u) return null; // 삭제된 계정
    if ((u.tokenVersion || 0) !== (payload.tv || 0)) return null; // 폐기된 토큰
    // role·scope·등록강제 여부는 토큰이 아니라 현재 레코드에서 읽어 변경을 즉시 반영한다.
    const role = u.role || 'viewer';
    return {
      username: payload.sub, role, name: payload.name, scope: normalizedScope(u),
      mustEnrollOtp: isOtpOnlyUser(u.username, role) && !u.totpEnabled,
    };
  }
  // AD 계정 등 로컬 레코드가 없는 토큰은 scope 를 적용하지 않는다(전체 열람).
  return { username: payload.sub, role: payload.role, name: payload.name, scope: { vcenters: [], regions: [] } };
}

export function authMiddleware(req, res, next) {
  if (!config.auth.enabled) {
    req.user = { username: 'anonymous', role: AUTH_DISABLED_ROLE, name: 'Anonymous' };
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = resolveTokenUser(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

/**
 * OTP 등록 강제 게이트 — 고권한 계정이 OTP 미등록 상태로(비밀번호로) 로그인한 세션은
 * **OTP 등록 외 어떤 API 도 쓸 수 없다**. /api/auth/{me,totp/begin,totp/confirm} 만 열려 있고
 * 나머지 보호 라우터에는 이 미들웨어를 붙인다. 프론트는 403 코드를 보고 등록 화면을 띄운다.
 */
export function requireEnrolled(req, res, next) {
  if (req.user && req.user.mustEnrollOtp) {
    return res.status(403).json({
      error: 'otp_enrollment_required',
      reason: 'OTP 등록을 마쳐야 포탈을 사용할 수 있습니다. 화면의 안내에 따라 인증 앱에 등록하세요.',
    });
  }
  next();
}

/** Require the authenticated user to hold one of the given roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    // 인증 비활성 시에도 '무조건 통과'가 아니라 익명 역할(AUTH_DISABLED_ROLE)로 검사한다 —
    // 기본(admin)은 기존과 동일하게 통과하고, viewer로 낮춘 배포에선 mutation이 차단된다.
    if (!config.auth.enabled) {
      return roles.includes(AUTH_DISABLED_ROLE) ? next()
        : res.status(403).json({ error: 'forbidden', requiredRole: roles });
    }
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', requiredRole: roles });
    }
    next();
  };
}

/**
 * 기능 권한(Permission) 기반 게이트 — 역할→권한 매트릭스(permissions.js)로 검사한다.
 * requireRole 과 대칭: 인증 비활성이면 AUTH_DISABLED_ROLE 로 검사하고, admin 은 항상 통과한다.
 * 여러 키를 주면 그 중 하나라도 있으면 통과(OR). 서버측 강제 — 프론트가 메뉴를 숨겨도
 * API 직접 호출은 여기서 막힌다.
 */
export function requirePerm(...keys) {
  return (req, res, next) => {
    const role = !config.auth.enabled ? AUTH_DISABLED_ROLE : (req.user && req.user.role);
    if (role === 'admin') return next();
    const set = rolePermissionSet(role);
    if (keys.some((k) => set.has(k))) return next();
    return res.status(403).json({ error: 'forbidden', requiredPerm: keys });
  };
}
