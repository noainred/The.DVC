/**
 * 세션 보안 설정 — 유휴 자동 로그아웃(분) 등. CONFIG_DIR/security-session.json.
 * 변경은 OTP 인증을 거쳐야 하며(라우트에서 강제), 감사 로그에 누가 바꿨는지 남긴다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../util/atomicWrite.js';
import { listManagedUsers } from '../auth/auth.js';

const FILE = path.join(config.configDir, 'security-session.json');
// 설정 소유 계정을 '파일/환경변수'로도 지정할 수 있게 하는 경로(운영자가 직접 편집).
// portal.env 와 같은 CONFIG_DIR 에 두며, 한 줄에 계정 하나(# 주석 허용).
const OWNERS_FILE = path.join(config.configDir, 'settings-owners.txt');
const DEFAULTS = { idleLogoutEnabled: true, idleLogoutMin: 30, settingsOwners: ['noainred'] };

// 로그인 자격 정책(전역) — 설정 소유자가 '설정 › 세션 보안'에서 지정. null(미설정)=레거시
// (고권한 OTP 전용, 그 외 혼용). auth.js 가 이 값으로 OTP 강제 여부를 판정한다.
const LOGIN_POLICIES = ['otp_only', 'otp_or_password', 'password_only'];
function normPolicy(v) { return LOGIN_POLICIES.includes(v) ? v : null; }

function clamp(v, min, max, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt; }

/** 사용자명 목록 정규화 — 공백 제거·중복 제거·형식 검증·최대 20개. 비면 null(호출부에서 거부). */
function normOwners(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const x of arr) {
    const s = String(x || '').trim();
    if (s && /^[A-Za-z0-9._@-]{2,64}$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 20);
}

/** 파일에 저장된 '설정된' 값만 로드(자동 포함분 미반영). 저장/편집 경로가 기준으로 삼는다. */
export function loadConfiguredSecurity() {
  let p = {};
  try { if (fs.existsSync(FILE)) p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { p = {}; }
  const owners = normOwners(p.settingsOwners);
  return {
    idleLogoutEnabled: p.idleLogoutEnabled !== undefined ? !!p.idleLogoutEnabled : DEFAULTS.idleLogoutEnabled,
    idleLogoutMin: clamp(p.idleLogoutMin, 1, 1440, DEFAULTS.idleLogoutMin), // 1분~24시간
    settingsOwners: owners && owners.length ? owners : DEFAULTS.settingsOwners.slice(),
    loginPolicy: normPolicy(p.loginPolicy), // null = 미설정(레거시)
  };
}

// 로그인 정책 캐시 — resolveTokenUser(매 /api 요청)가 읽는 핫패스라 파일 read 를 매 요청 하지
// 않도록 3초 캐시한다. 저장(saveSessionSecurity)·외부 편집은 최대 3초 안에 반영된다(save 는 즉시 무효화).
let _polAt = 0, _polCache = null;
export function effectiveLoginPolicy() {
  const now = Date.now();
  if (_polAt && now - _polAt < 3000) return _polCache;
  _polCache = loadConfiguredSecurity().loginPolicy;
  _polAt = now;
  return _polCache;
}

/**
 * 사용자별 로그인 방식 재정의 — **설정 UI 에 노출하지 않는 서버 구성 파일 전용 경로**(요구사항).
 * 운영자가 서버에서 직접 편집한다(settings-owners.txt 와 같은 패턴):
 *   ① CONFIG_DIR/login-policy-users.txt : 한 줄에 하나 — `<사용자명>=<방식>`
 *      (`#` 주석 허용, 구분자는 `=`/`:`/공백). 방식은 별칭 `otp`/`password`/`both`
 *      또는 정식 값 `otp_only`/`password_only`/`otp_or_password`.
 *   ② portal.env 의 LOGIN_POLICY_USERS : 콤마 구분(예: `LOGIN_POLICY_USERS=jdoe=password,svc=otp`)
 * 같은 사용자가 양쪽에 있으면 **파일이 이긴다**. auth.js 가 '사용자별 재정의 > 전역 정책 >
 * 레거시 기본' 순으로 적용한다(긴급 env OTP_ROLE_ENFORCE=false 는 그보다 우선).
 */
const USER_POLICY_FILE = path.join(config.configDir, 'login-policy-users.txt');
const POLICY_ALIASES = {
  otp: 'otp_only', otp_only: 'otp_only',
  password: 'password_only', password_only: 'password_only', pw: 'password_only',
  both: 'otp_or_password', otp_or_password: 'otp_or_password',
  'otp+password': 'otp_or_password', 'password+otp': 'otp_or_password',
};

let _upolAt = 0, _upolCache = new Map(), _upolWarned = '';
export function fileUserLoginPolicies() {
  const now = Date.now();
  if (_upolAt && now - _upolAt < 3000) return _upolCache;
  const map = new Map();
  const bad = [];
  const addEntry = (src, rawUser, rawPol) => {
    const user = String(rawUser || '').trim();
    const pol = POLICY_ALIASES[String(rawPol || '').trim().toLowerCase()];
    if (!/^[A-Za-z0-9._@-]{2,64}$/.test(user) || !pol) { bad.push(`${src}:${rawUser}=${rawPol}`); return; }
    map.set(user, pol);
  };
  const parseLine = (src, s) => {
    const m = s.match(/^([^=:\s]+)\s*[=:\s]\s*(\S+)$/);
    if (m) addEntry(src, m[1], m[2]); else bad.push(`${src}:${s}`);
  };
  // env 를 먼저 넣고 파일이 나중에 덮어쓴다(파일 우선).
  for (const ent of String(process.env.LOGIN_POLICY_USERS || '').split(',')) {
    const s = ent.trim();
    if (s) parseLine('env', s);
  }
  try {
    if (fs.existsSync(USER_POLICY_FILE)) {
      for (const line of fs.readFileSync(USER_POLICY_FILE, 'utf8').split(/\r?\n/)) {
        const s = line.split('#')[0].trim();
        if (s) parseLine('file', s);
      }
    }
  } catch (e) {
    // 읽기 실패(권한/IO)는 빈 재정의로 계속(전역 정책만 적용 — fail-closed). 형식 오류와 달리
    // 완전 무증상이면 운영자가 진단할 단서가 없으므로 같은 1회 경고 경로에 태운다.
    bad.push(`file:읽기 실패(${e?.code || e?.message || 'error'})`);
  }
  // 형식 오류는 무시하되 내용이 바뀔 때 1회만 경고(3초 캐시 주기마다 로그 도배 방지).
  const sig = bad.join('|');
  if (sig && sig !== _upolWarned) console.warn(`[auth] login-policy-users 형식 오류 무시: ${bad.join(' · ')}`);
  _upolWarned = sig;
  _upolCache = map;
  _upolAt = now;
  return map;
}

/** 이 사용자의 로그인 방식 재정의(정식 값) 또는 null(재정의 없음 → 전역 정책 적용). */
export function userLoginPolicy(username) {
  return fileUserLoginPolicies().get(String(username || '')) || null;
}

/** 테스트·핫리로드용 — 전역/사용자별 로그인 정책 캐시를 즉시 무효화. */
export function invalidateLoginPolicyCache() { _polAt = 0; _upolAt = 0; }

/**
 * 파일/환경변수로 지정한 설정 소유 계정 — 운영자가 서버에서 직접 편집하는 경로.
 *   ① CONFIG_DIR/settings-owners.txt : 한 줄에 계정 하나(빈 줄·`#` 주석 무시)
 *   ② portal.env 의 SETTINGS_OWNERS  : 콤마 구분(예: SETTINGS_OWNERS=noainred,junho)
 * UI(설정 › 세션 보안)에서 저장하는 값과 **합쳐서** 적용되며 파일에는 남기지 않는다
 * (= UI 저장이 이 값을 덮어쓰거나 지우지 못한다). 모든 관리자가 설정 화면에 못 들어가는
 * 잠금 상황에서 서버 파일만 고쳐 복구할 수 있는 안전장치다.
 */
export function fileSettingsOwners() {
  const out = [];
  try {
    if (fs.existsSync(OWNERS_FILE)) {
      for (const line of fs.readFileSync(OWNERS_FILE, 'utf8').split(/\r?\n/)) {
        const s = line.split('#')[0].trim();
        if (s) out.push(s);
      }
    }
  } catch { /* 읽기 실패는 무시(다른 소스로 계속) */ }
  for (const s of String(process.env.SETTINGS_OWNERS || '').split(',')) {
    const v = s.trim();
    if (v) out.push(v);
  }
  return normOwners(out) || [];
}

/** 중앙이 배포(managed)한 admin 계정명 — 이 엣지의 설정 소유 계정에 자동 포함할 대상. */
export function managedAdminOwners() {
  try { return listManagedUsers().filter((u) => u.role === 'admin').map((u) => u.username); } catch { return []; }
}

/**
 * 유효 세션 보안 설정(클라이언트 제공용).
 * 설정 소유 계정 = 'UI 저장분' + '서버 파일/환경변수 지정분' + '중앙 배포 admin' + 수퍼관리자.
 * 뒤 세 가지는 파일(security-session.json)에 남기지 않으므로, UI 저장이 이들을 지울 수 없다
 * (중앙에서 admin 을 회수하거나 settings-owners.txt 에서 빼면 자동으로 소유자에서도 빠진다).
 */
export function loadSessionSecurity() {
  const raw = loadConfiguredSecurity();
  // 수퍼관리자(noainred)는 소유자 목록에서 제외돼도 항상 자동 포함 — 최고 권한 계정이 설정
  // 접근을 잃는 잠금 사고 방지(파일에는 남기지 않아 표시상으로도 '자동 포함'으로 동작).
  return {
    ...raw,
    settingsOwners: [...new Set([
      ...raw.settingsOwners,
      ...fileSettingsOwners(),   // CONFIG_DIR/settings-owners.txt · SETTINGS_OWNERS
      ...managedAdminOwners(),
      'noainred',
    ])],
  };
}

export function saveSessionSecurity(partial = {}) {
  const cur = loadConfiguredSecurity(); // 저장 기준은 '설정된' 소유 계정만(자동 포함된 managed admin은 파일에 안 남김)
  let owners = cur.settingsOwners;
  if (partial.settingsOwners !== undefined) {
    const n = normOwners(partial.settingsOwners);
    if (!n || !n.length) throw new Error('설정 소유 계정은 최소 1개 이상이어야 합니다.');
    owners = n;
  }
  // 로그인 정책 — 잘못된 값은 무시하고 기존 값을 유지(무관한 저장이 정책을 바꾸지 않게, UI 는
  // 사용자가 라디오를 실제로 바꿨을 때만 loginPolicy 를 전송한다).
  let loginPolicy = cur.loginPolicy;
  if (partial.loginPolicy !== undefined) { const n = normPolicy(partial.loginPolicy); if (n) loginPolicy = n; }
  const next = {
    idleLogoutEnabled: partial.idleLogoutEnabled !== undefined ? !!partial.idleLogoutEnabled : cur.idleLogoutEnabled,
    idleLogoutMin: partial.idleLogoutMin !== undefined ? clamp(partial.idleLogoutMin, 1, 1440, cur.idleLogoutMin) : cur.idleLogoutMin,
    settingsOwners: owners,
    loginPolicy, // null = 미설정(레거시)
  };
  // 원자적 쓰기 — settingsOwners(설정 편집 권한)를 담는 권한 config. 부분기록으로 손상되면
  // 로드가 DEFAULTS로 조용히 리셋돼 소유자 경계가 무너진다.
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  _polAt = 0; // 로그인 정책 캐시 즉시 무효화
  return next;
}
