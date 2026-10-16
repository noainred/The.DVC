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
import { atomicWriteFileSync } from '../util/atomicWrite.js';

// Windows 패키지는 portal.env.bat(set "KEY=VAL"), 그 외(systemd)는 portal.env(KEY=VAL).
// v2.743(감사 INJPKG-01): Windows 에서 쓰던 CONFIG_DIR\portal.env.bat 은 **아무도 읽지 않는 파일**이었다 — start-portal.bat 은
//   패키지 폴더의 portal.env.bat 하나만 call 해서, 화면에서 저장·생성한 CENTRAL_TOKEN 이 서비스 재시작 뒤 사라졌다.
//   이제 start-portal.bat 이 자기가 call 하는 그 파일을 `PORTAL_ENV_FILE` 로 넘기고 여기에 쓴다(실제로 읽히는 파일).
//   ⚠ 반대 방향(start-portal.bat 이 CONFIG_DIR\portal.env.bat 도 call)은 택하지 않았다 — C:\ProgramData 아래 새 폴더는 기본 ACL 이
//   일반 사용자에게 '파일 만들기' 를 주므로, 그 파일이 없을 때 누구나 만들어 두면 SYSTEM 예약 작업이 그것을 실행한다(새 권한 상승 경로).
//   그 파일은 cmd 가 **실행**하므로 값에 cmd 메타문자가 들어가면 명령 주입이 된다 — Windows 에서는 `tokenValueIssue` 가 거부하고
//   줄은 `set "KEY=VAL"` 꼴이다. PORTAL_ENV_FILE 이 없으면(옛 start-portal.bat · 직접 실행) 예전 경로에 쓰고 `envFileLoaded:false` 로 밝힌다.
const isWin = process.platform === 'win32';
/** 플랫폼별 env 파일 경로(테스트가 win 갈래를 직접 본다). */
export function envFilePath(dir, win = isWin) { return path.join(dir, win ? 'portal.env.bat' : 'portal.env'); }
/**
 * Windows 시작 스크립트가 넘긴 env 파일 경로 — 절대 경로이고 파일 이름이 portal.env.bat 일 때만 받는다(그 밖은 무시 → null).
 * @returns {string|null}
 */
export function startScriptEnvFile(v, win = isWin) {
  if (!win || typeof v !== 'string') return null;
  const f = v.trim().replace(/^"|"$/g, '');
  if (!f || !path.win32.isAbsolute(f)) return null;
  return path.win32.basename(f).toLowerCase() === 'portal.env.bat' ? f : null;
}
const START_ENV_FILE = startScriptEnvFile(process.env.PORTAL_ENV_FILE);
const ENV_FILE = START_ENV_FILE || envFilePath(config.configDir);
/** 기록한 파일을 다음 기동이 실제로 읽는가 — 리눅스는 systemd EnvironmentFile, Windows 는 시작 스크립트가 경로를 넘겼을 때만. */
const ENV_FILE_LOADED = !isWin || !!START_ENV_FILE;

/** cmd 가 해석하는 문자 — `set "K=V"` 안에서도 %·! 는 확장되고, " 는 따옴표를 닫으며, 줄바꿈은 다음 명령이 된다. & | < > ^ 는 따옴표 밖 명령 구분자다. */
const CMD_META = /[&|<>^%!"\r\n]/;

/**
 * 토큰 값을 거부하는 사유(문자열) 또는 null. 공백 거부는 두 플랫폼 공통(예전 그대로)이고,
 * cmd 메타문자 거부는 Windows 갈래에만 둔다(리눅스 portal.env 동작은 바꾸지 않는다 — systemd EnvironmentFile 은 실행되지 않는다).
 */
export function tokenValueIssue(val, win = isWin) {
  const v = String(val ?? '');
  if (!v) return '토큰 값이 비어 있습니다.';
  if (/\s/.test(v)) return '토큰에 공백을 사용할 수 없습니다.';
  if (win && CMD_META.test(v)) return '토큰에 & | < > ^ % ! " 와 줄바꿈은 쓸 수 없습니다(Windows 시작 스크립트가 이 값을 cmd 로 실행합니다).';
  return null;
}

/** env 파일의 한 줄. Windows 는 `set "KEY=VAL"`(값 끝 공백·특수문자가 줄에 섞이지 않게 따옴표로 감싼다). */
export function envLineFor(key, val, win = isWin) { return win ? `set "${key}=${val}"` : `${key}=${val}`; }

/** 기존 env 파일 내용에 KEY 줄을 교체/추가한 새 내용(순수). Windows 는 `set KEY=` · `set "KEY=` 둘 다 같은 키로 본다. */
export function renderEnvFile(text, key, val, win = isWin) {
  const lines = typeof text === 'string' && text ? text.split(/\r?\n/) : [];
  const newLine = envLineFor(key, val, win);
  const keyRe = win ? new RegExp(`^\\s*set\\s+"?${key}=`, 'i') : new RegExp(`^\\s*(export\\s+)?${key}=`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx >= 0) lines[idx] = newLine;
  else { if (lines.length && lines[lines.length - 1].trim() !== '') lines.push(''); lines.push(newLine); }
  return lines.join(win ? '\r\n' : '\n').replace(win ? /(\r\n){3,}/g : /\n{3,}/g, win ? '\r\n\r\n' : '\n\n').replace(win ? /(\r\n)*$/ : /\n*$/, win ? '\r\n' : '\n');
}

export function getCentralToken() { return (config.central && config.central.token) || ''; }

export function setCentralToken(token) {
  const val = String(token || '').trim();
  const issue = tokenValueIssue(val);
  if (issue) throw new Error(issue);
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
  let text = '';
  // Windows 배치 파일은 ANSI 일 수 있다 — latin1 로 읽고 써서 바이트를 그대로 둔다(utf8 로 다시 쓰면 주석의 비-ASCII 가 깨진다).
  const enc = isWin ? 'latin1' : 'utf8';
  try { if (fs.existsSync(ENV_FILE)) text = fs.readFileSync(ENV_FILE, enc); } catch { /* */ }
  // 기존 같은 키 라인(있다면) 교체, 없으면 추가. Windows 는 CRLF(cmd 가 LF 만 있는 배치 파일의 줄을 잘못 읽는 경우가 있다 —
  //   portal.env.example.bat 머리말의 'CRLF 로 저장' 과 같은 이유).
  const out = renderEnvFile(text, key, val);
  // 원자적 쓰기 — portal.env는 CENTRAL_TOKEN(중앙↔에이전트 공유 비밀)을 담는 systemd
  // EnvironmentFile이다. 비원자적 writeFileSync는 크래시/디스크풀 시 파일을 truncate해
  // 토큰이 유실되고, 재부팅 시 systemd가 잘린 파일을 읽어 중앙↔에이전트 인증이 붕괴된다.
  atomicWriteFileSync(ENV_FILE, isWin ? Buffer.from(out, 'latin1') : out, { mode: 0o600 });
}

export function centralTokenInfo() {
  return { hasToken: !!getCentralToken(), token: getCentralToken(), envFile: ENV_FILE, envFileLoaded: ENV_FILE_LOADED };
}
