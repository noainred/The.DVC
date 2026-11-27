/**
 * tools/portalEnvKey.js — 콘솔 계정 도구(otp-enroll · user-admin)의 시작 준비(보안 잔여 11-27 M3).
 *
 * 왜: users.json 의 OTP 시드가 자격증명 저장 방식 = 암호화이면 봉인된다(security/secretVault.js 레코드 단위 봉인). 포탈은 키를 systemd
 *   EnvironmentFile(CONFIG_DIR/portal.env)의 SECRETS_KEY 로 받는데, 래퍼(otp-enroll.sh · user-admin.sh · vmware-portal-otp/users)는 그 값을 넘기지 않는다 —
 *   도구가 키를 모르면 시드를 못 열고, 키 파일을 새로 만들거나 다른 키로 봉인해 **복구하려던 관리자를 잠글** 수 있었다. 그래서 도구가:
 *   ① root 로 직접 실행되면 거절한다(users.json · secrets-key 가 root 소유가 되어 포탈이 읽거나 저장하지 못한다 — 래퍼가 서비스 계정으로 낮춘다)
 *   ② portal.env 에서 SECRETS_KEY 를 **직접** 읽는다(래퍼가 `env SECRETS_KEY=…` 로 넘기면 sudo 로그 · /proc cmdline 에 남는다). 셸 평가 없음 · 64KB 상한.
 *   ③ 키를 만들지 않는 도구 모드로 들어간다(disallowKeyCreation) — 암호화 정책의 새 봉인 전에 포탈이 남긴 키 확인 값으로 '같은 키' 를 확인한다.
 *      portal.env 를 못 읽어도(권한) 키 확인 값이 맞으면 된다(포탈이 파일 키를 쓰는 설치) — 맞지 않거나 없으면 새로 봉인하지 않는다(fail-closed).
 */
import fs from 'node:fs';
import path from 'node:path';
import { disallowKeyCreation } from '../security/secretVault.js';

const PORTAL_ENV_MAX = 64 * 1024;

/** portal.env 본문에서 SECRETS_KEY 값(마지막 줄 우선) — 주석 · 빈 줄 무시, `export ` 접두 허용, 감싼 따옴표 제거. 없으면 null. */
export function parseSecretsKey(text) {
  let val = null;
  for (const line0 of String(text ?? '').split('\n')) {
    const line = line0.replace(/\r$/, '').trimStart();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trimStart() : line;
    if (!body.startsWith('SECRETS_KEY')) continue;
    const rest = body.slice('SECRETS_KEY'.length).trimStart();
    if (!rest.startsWith('=')) continue;
    let v = rest.slice(1).trim();
    if (v.length >= 2 && ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'"))) v = v.slice(1, -1);
    val = v;
  }
  return val;
}

/**
 * SECRETS_KEY 가 env 에 없을 때만 <configDir>/portal.env 에서 읽어 process.env 에 넣는다.
 * @returns {{ source: 'env'|'portal.env'|'none', error?: string }}  error = 읽지 못한 사유(ENOENT 아님) — 판정은 키 확인 값이 한다
 */
export function loadKeyEnvFromPortalEnv(configDir, env = process.env) {
  if (env.SECRETS_KEY) return { source: 'env' };
  const fp = path.join(String(configDir || ''), 'portal.env');
  let text;
  try {
    const st = fs.statSync(fp);
    if (st.size > PORTAL_ENV_MAX) return { source: 'none', error: `portal.env 가 너무 큼(${st.size}B)` };
    text = fs.readFileSync(fp, 'utf8');
  } catch (e) {
    return e?.code === 'ENOENT' ? { source: 'none' } : { source: 'none', error: String(e?.code || e?.message || '읽기 오류').slice(0, 40) };
  }
  const v = parseSecretsKey(text);
  if (v && v.length >= 16) { env.SECRETS_KEY = v; return { source: 'portal.env' }; }
  return { source: 'none' };
}

/** root 직접 실행 판정(순수) — uid 0 이고 CONFIG_DIR 소유자가 root 가 아니면 사유. uid 를 모르면(Windows) · 소유자를 모르면 null(통과). */
export function rootRunIssue({ uid, configDirUid } = {}) {
  if (uid == null || configDirUid == null) return null;
  if (uid !== 0 || configDirUid === 0) return null;
  return 'root 로 직접 실행하지 마세요 — users.json · secrets-key 가 root 소유가 되어 포탈이 읽거나 저장하지 못합니다. sudo vmware-portal-otp · sudo vmware-portal-users(또는 앱 폴더의 otp-enroll.sh · user-admin.sh)로 실행하세요 — 서비스 계정으로 낮춰 실행합니다.';
}

/**
 * 두 도구의 첫 동작 — 어떤 users.json 읽기보다 먼저 부른다. ① root 판정 ② portal.env 키 ③ 도구 모드(키를 만들지 않음).
 * @returns {{ issue: string|null, note: string|null }}  issue 가 있으면 도구는 아무것도 하지 않고 끝낸다
 */
export function prepareConsoleTool(configDir) {
  let configDirUid = null;
  try { configDirUid = fs.statSync(configDir).uid; } catch { configDirUid = null; }
  const issue = rootRunIssue({ uid: typeof process.getuid === 'function' ? process.getuid() : null, configDirUid });
  if (issue) return { issue, note: null };
  const k = loadKeyEnvFromPortalEnv(configDir);
  disallowKeyCreation();
  const note = k.error ? `portal.env 를 읽지 못했습니다(${k.error}) — 포탈이 거기 둔 SECRETS_KEY 를 이 도구는 모릅니다. 암호화 저장 방식이면 키 확인 값이 맞을 때만 새 OTP 키를 봉인합니다.` : null;
  return { issue: null, note };
}
