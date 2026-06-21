/**
 * 중앙 토큰(CENTRAL_TOKEN) 관리 — 실행 중 서버에 적용 + portal.env 영속화.
 * 중앙↔에이전트 공유 비밀. 생성/설정하면 즉시 메모리(process.env/config)에 반영되어
 * 재시작 없이 동작하고, CONFIG_DIR/portal.env(systemd EnvironmentFile)에 기록되어
 * 리붓 후에도 유지된다.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

// Windows 패키지는 portal.env.bat(set KEY=VAL), 그 외(systemd)는 portal.env(KEY=VAL).
const isWin = process.platform === 'win32';
const ENV_FILE = path.join(config.configDir, isWin ? 'portal.env.bat' : 'portal.env');

export function getCentralToken() { return (config.central && config.central.token) || ''; }

export function setCentralToken(token) {
  const val = String(token || '').trim();
  if (!val) throw new Error('토큰 값이 비어 있습니다.');
  if (/\s/.test(val)) throw new Error('토큰에 공백을 사용할 수 없습니다.');
  process.env.CENTRAL_TOKEN = val;
  if (!config.central) config.central = {};
  config.central.token = val;            // 즉시 적용(재시작 불필요)
  persistEnv('CENTRAL_TOKEN', val);      // 리붓 후에도 유지
  return val;
}

/** 토큰이 없으면(또는 force) 안전한 랜덤(32바이트 hex) 생성·저장. */
export function generateCentralToken({ force = false } = {}) {
  const cur = getCentralToken();
  if (cur && !force) return { token: cur, created: false };
  const val = crypto.randomBytes(32).toString('hex');
  setCentralToken(val);
  return { token: val, created: true };
}

function persistEnv(key, val) {
  let lines = [];
  try { if (fs.existsSync(ENV_FILE)) lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch { /* */ }
  const newLine = isWin ? `set ${key}=${val}` : `${key}=${val}`;
  // 기존 같은 키 라인(있다면) 교체, 없으면 추가.
  const keyRe = isWin ? new RegExp(`^\\s*set\\s+${key}=`, 'i') : new RegExp(`^\\s*(export\\s+)?${key}=`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx >= 0) lines[idx] = newLine;
  else { if (lines.length && lines[lines.length - 1].trim() !== '') lines.push(''); lines.push(newLine); }
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  fs.writeFileSync(ENV_FILE, out, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* best effort */ }
}

export function centralTokenInfo() {
  return { hasToken: !!getCentralToken(), token: getCentralToken(), envFile: ENV_FILE };
}
