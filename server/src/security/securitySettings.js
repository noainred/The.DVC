/**
 * 세션 보안 설정 — 유휴 자동 로그아웃(분) 등. CONFIG_DIR/security-session.json.
 * 변경은 OTP 인증을 거쳐야 하며(라우트에서 강제), 감사 로그에 누가 바꿨는지 남긴다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { listManagedUsers } from '../auth/auth.js';

const FILE = path.join(config.configDir, 'security-session.json');
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

/** 중앙이 배포(managed)한 admin 계정명 — 이 엣지의 설정 소유 계정에 자동 포함할 대상. */
export function managedAdminOwners() {
  try { return listManagedUsers().filter((u) => u.role === 'admin').map((u) => u.username); } catch { return []; }
}

/**
 * 유효 세션 보안 설정(클라이언트 제공용). 설정 소유 계정 = '설정된 계정' + '중앙 배포 admin'.
 * 중앙이 admin 권한을 명시 부여한 계정은 그 엣지의 설정을 관리할 수 있게 자동 소유자에 포함한다
 * (파일에는 남기지 않으므로 중앙에서 제거하면 자동으로 소유자에서도 빠진다).
 */
export function loadSessionSecurity() {
  const raw = loadConfiguredSecurity();
  return { ...raw, settingsOwners: [...new Set([...raw.settingsOwners, ...managedAdminOwners()])] };
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
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE, 0o600); } catch { /* mode는 신규생성 시에만 적용 — 덮어쓰기에도 0600 보장 */ }
  return next;
}
