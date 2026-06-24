/**
 * 세션 보안 설정 — 유휴 자동 로그아웃(분) 등. CONFIG_DIR/security-session.json.
 * 변경은 OTP 인증을 거쳐야 하며(라우트에서 강제), 감사 로그에 누가 바꿨는지 남긴다.
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const FILE = path.join(config.configDir, 'security-session.json');
const DEFAULTS = { idleLogoutEnabled: true, idleLogoutMin: 30 };

function clamp(v, min, max, dflt) { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt; }

export function loadSessionSecurity() {
  let p = {};
  try { if (fs.existsSync(FILE)) p = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { p = {}; }
  return {
    idleLogoutEnabled: p.idleLogoutEnabled !== undefined ? !!p.idleLogoutEnabled : DEFAULTS.idleLogoutEnabled,
    idleLogoutMin: clamp(p.idleLogoutMin, 1, 1440, DEFAULTS.idleLogoutMin), // 1분~24시간
  };
}

export function saveSessionSecurity(partial = {}) {
  const cur = loadSessionSecurity();
  const next = {
    idleLogoutEnabled: partial.idleLogoutEnabled !== undefined ? !!partial.idleLogoutEnabled : cur.idleLogoutEnabled,
    idleLogoutMin: partial.idleLogoutMin !== undefined ? clamp(partial.idleLogoutMin, 1, 1440, cur.idleLogoutMin) : cur.idleLogoutMin,
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
