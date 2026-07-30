import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { authenticateAD } from './ad.js';
import * as totp from './totp.js';
import { checkOtpAllowed, recordOtpFailure, recordOtpSuccess } from '../security/loginRateLimit.js';

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

export function loadUsers() {
  if (users) return users;
  const file = path.join(CONFIG_DIR, 'users.json');
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed?.users) && parsed.users.length) {
        users = parsed.users;
        return users;
      }
    } catch (err) {
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
export function authenticateLocal(username, credential) {
  const user = loadUsers().find((u) => u.username === username);
  if (!user) {
    // 없는 사용자도 동일 비용의 scrypt를 태워 응답시간 차이로 사용자명을 열거하지 못하게 한다.
    try { crypto.scryptSync(String(credential || ''), _dummySalt, 64); } catch { /* */ }
    return null;
  }
  if (user.totpEnabled && user.totpSecret) {
    const ctr = totp.verifyToken(credential, user.totpSecret, { minCounter: Number.isInteger(user.totpLastCounter) ? user.totpLastCounter : -1 });
    if (ctr == null) return null;
    // TOTP 재사용(replay) 방지 — 이미 쓴 카운터 이하 코드는 거부하고, 성공 카운터를 기록.
    if (ctr !== user.totpLastCounter) { user.totpLastCounter = ctr; try { persistUsers(); } catch { /* */ } }
  } else if (!user.passwordHash || !verifyPassword(credential, user.passwordHash)) {
    return null;
  }
  return { username: user.username, name: user.name || user.username, role: user.role || 'viewer', source: 'local', totpEnabled: !!user.totpEnabled };
}

/* ------------------------------ user management ---------------------------- */

const VALID_ROLES = ['admin', 'operator', 'viewer'];

// 서버측 토큰 폐기(감사 M5) — 자격증명/역할이 바뀌면 버전을 올려 그 전에 발급된 토큰을
// authMiddleware에서 즉시 무효화한다(로컬 계정 한정; AD는 다음 로그인에 반영).
function bumpTokenVersion(u) { u.tokenVersion = (u.tokenVersion || 0) + 1; }

/** Public-safe user list (no secrets/hashes). */
export function listUsers() {
  return loadUsers().map((u) => ({
    username: u.username, name: u.name || u.username, role: u.role || 'viewer',
    totpEnabled: !!u.totpEnabled, hasPassword: !!u.passwordHash,
    managedBy: u.managedBy || null, // 'central' = 중앙에서 배포·관리하는 계정
  }));
}

export function getUser(username) {
  return loadUsers().find((u) => u.username === username) || null;
}

export function createUser({ username, name, role = 'viewer', password } = {}) {
  username = String(username || '').trim();
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(username)) return { ok: false, reason: '사용자 ID 형식이 올바르지 않습니다.' };
  if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다.' };
  if (getUser(username)) return { ok: false, reason: '이미 존재하는 사용자입니다.' };
  const u = { username, name: name || username, role };
  if (password) u.passwordHash = hashPassword(password);
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

export function updateUser(username, { name, role } = {}) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다.' };
    // Don't allow demoting the last admin.
    if (u.role === 'admin' && role !== 'admin' && loadUsers().filter((x) => x.role === 'admin').length <= 1) {
      return { ok: false, reason: '마지막 관리자는 역할을 변경할 수 없습니다.' };
    }
    if (u.role !== role) bumpTokenVersion(u); // 역할 변경(강등 포함) → 기존 토큰 폐기
    u.role = role;
  }
  if (name !== undefined) u.name = name || u.username;
  persistUsers();
  return { ok: true };
}

export function deleteUser(username) {
  const list = loadUsers();
  const u = list.find((x) => x.username === username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
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
  delete u.passwordHash; // OTP-only from now on
  bumpTokenVersion(u); // 인증수단 변경 → 기존 토큰 폐기
  persistUsers();
  return { ok: true };
}

/** Remove TOTP from a user (admin reset). */
export function disableTotp(username, { password } = {}) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
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
    return { username: payload.sub, role: u.role || 'viewer', name: payload.name };
  }
  return { username: payload.sub, role: payload.role, name: payload.name };
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
