import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { authenticateAD } from './ad.js';
import * as totp from './totp.js';

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
  const pw = config.auth.defaultAdminPassword;
  users = [{ username: 'admin', name: 'Administrator', role: 'admin', passwordHash: hashPassword(pw) }];
  // 비밀번호는 절대 로그에 남기지 않는다(로그버퍼는 /admin/logs로 노출됨).
  console.warn('[auth] users.json이 없어 기본 관리자 "admin"을 시드했습니다. 운영 환경에서는 DEFAULT_ADMIN_PASSWORD를 설정하거나 config/users.json을 생성하세요.');
  if (pw === 'admin123') {
    console.warn('[auth] ⚠ 보안 경고: 기본 비밀번호(admin123)를 그대로 사용 중입니다. 즉시 변경하세요(DEFAULT_ADMIN_PASSWORD 또는 사용자 관리에서 비번 변경).');
  }
  return users;
}

function persistUsers() {
  const file = path.join(CONFIG_DIR, 'users.json');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ users: loadUsers() }, null, 2), { mode: 0o600 });
  // mode 옵션은 '신규 생성' 시에만 적용되므로, 기존 파일 덮어쓰기에도 0600을 보장한다.
  try { fs.chmodSync(file, 0o600); } catch { /* */ }
}

/**
 * Verify a local account. Once a user has TOTP enrolled, the second argument is
 * treated as the 6-digit Google Authenticator code (OTP-only — the password no
 * longer works). Until enrolled, the password is accepted so the account can be
 * bootstrapped/enrolled.
 */
export function authenticateLocal(username, credential) {
  const user = loadUsers().find((u) => u.username === username);
  if (!user) return null;
  if (user.totpEnabled && user.totpSecret) {
    if (!totp.verifyToken(credential, user.totpSecret)) return null;
  } else if (!user.passwordHash || !verifyPassword(credential, user.passwordHash)) {
    return null;
  }
  return { username: user.username, name: user.name || user.username, role: user.role || 'viewer', source: 'local', totpEnabled: !!user.totpEnabled };
}

/* ------------------------------ user management ---------------------------- */

const VALID_ROLES = ['admin', 'operator', 'viewer'];

/** Public-safe user list (no secrets/hashes). */
export function listUsers() {
  return loadUsers().map((u) => ({
    username: u.username, name: u.name || u.username, role: u.role || 'viewer',
    totpEnabled: !!u.totpEnabled, hasPassword: !!u.passwordHash,
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

export function updateUser(username, { name, role } = {}) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (role !== undefined) {
    if (!VALID_ROLES.includes(role)) return { ok: false, reason: '역할이 올바르지 않습니다.' };
    // Don't allow demoting the last admin.
    if (u.role === 'admin' && role !== 'admin' && loadUsers().filter((x) => x.role === 'admin').length <= 1) {
      return { ok: false, reason: '마지막 관리자는 역할을 변경할 수 없습니다.' };
    }
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

/** Start TOTP enrollment: generate a secret (pending until confirmed).
 *  host(접속한 포탈 IP:포트)를 주면 발급 라벨 issuer에 포함해 여러 포탈을 구분한다:
 *  'VMware Portal' → 'VMware(<host>) Portal'. */
export function beginTotpEnroll(username, host = '') {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  const secret = totp.generateSecret();
  u.totpSecret = secret;
  u.totpEnabled = false; // not active until a code is confirmed
  persistUsers();
  const base = config.auth.totpIssuer || 'VMware Portal';
  const issuer = host ? (base.includes('VMware') ? base.replace('VMware', `VMware(${host})`) : `${base}(${host})`) : base;
  return {
    ok: true, secret,
    otpauthURL: totp.otpauthURL({ secret, account: username, issuer }),
  };
}

/** 민감 작업 재인증용 — 사용자의 현재 OTP 코드를 검증. OTP 미등록이면 needEnroll. */
export function verifyUserOtp(username, code) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  if (!u.totpEnabled || !u.totpSecret) return { ok: false, reason: 'OTP가 등록되지 않은 계정입니다. 먼저 OTP를 등록하세요.', needEnroll: true };
  if (!totp.verifyToken(String(code || '').trim(), u.totpSecret)) return { ok: false, reason: 'OTP 코드가 일치하지 않습니다.' };
  return { ok: true };
}

/** Confirm enrollment by verifying a code from the authenticator app. */
export function confirmTotpEnroll(username, code) {
  const u = getUser(username);
  if (!u || !u.totpSecret) return { ok: false, reason: '먼저 OTP 등록을 시작하세요.' };
  if (!totp.verifyToken(code, u.totpSecret)) return { ok: false, reason: 'OTP 코드가 일치하지 않습니다.' };
  u.totpEnabled = true;
  delete u.passwordHash; // OTP-only from now on
  persistUsers();
  return { ok: true };
}

/** Remove TOTP from a user (admin reset). */
export function disableTotp(username, { password } = {}) {
  const u = getUser(username);
  if (!u) return { ok: false, reason: '사용자를 찾을 수 없습니다.' };
  u.totpEnabled = false;
  delete u.totpSecret;
  if (password) u.passwordHash = hashPassword(password); // restore a temp password so they can log in to re-enroll
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

export function authMiddleware(req, res, next) {
  if (!config.auth.enabled) {
    req.user = { username: 'anonymous', role: 'admin', name: 'Anonymous' };
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  req.user = { username: payload.sub, role: payload.role, name: payload.name };
  next();
}

/** Require the authenticated user to hold one of the given roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!config.auth.enabled) return next();
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', requiredRole: roles });
    }
    next();
  };
}
