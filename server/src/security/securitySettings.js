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
  };
}

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
  const next = {
    idleLogoutEnabled: partial.idleLogoutEnabled !== undefined ? !!partial.idleLogoutEnabled : cur.idleLogoutEnabled,
    idleLogoutMin: partial.idleLogoutMin !== undefined ? clamp(partial.idleLogoutMin, 1, 1440, cur.idleLogoutMin) : cur.idleLogoutMin,
    settingsOwners: owners,
  };
  // 원자적 쓰기 — settingsOwners(설정 편집 권한)를 담는 권한 config. 부분기록으로 손상되면
  // 로드가 DEFAULTS로 조용히 리셋돼 소유자 경계가 무너진다.
  atomicWriteFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
