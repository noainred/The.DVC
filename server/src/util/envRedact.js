/**
 * util/envRedact.js — `.env` 텍스트에서 **키·토큰·비밀번호 값만** 가리는 순수 모듈(v2.538).
 *
 * 왜: 포탈 백업 번들과 엣지→중앙 설정 push 는 CONFIG_DIR 의 `*.json` 과 `*.env` 를 통째로 실었다.
 * 운영 CONFIG_DIR(/etc/vmware-portal)에는 `portal.env` 가 있고 그 안에 `AUTH_SECRET`(세션 서명 키 —
 * 있으면 관리자 토큰을 위조할 수 있다)·`SECRETS_KEY`(at-rest 봉인 키 — 있으면 번들 안의 암호문을 전부
 * 연다)·`CENTRAL_TOKEN`/`EDGE_TOKEN` 이 들어간다. 즉 **번들 하나가 곧 전체 탈취**였고, 엣지 30곳의
 * portal.env 가 중앙 한 파일(central-agent-config.json)에 모였다. JSON 안의 장비 비밀번호는 번들의
 * 존재 이유(복원)라 그대로 두되(다운로드는 소유자 게이트 + '자격증명 포함' 감사 기록), **키·토큰은
 * 설치기가 재생성하는 값**이므로 번들에서 뺀다.
 *
 * 규칙:
 *  - 키 이름이 SECRET/TOKEN/PASSWORD/PASSWD/PASSPHRASE/PRIVATE_KEY/API_KEY/_KEY 로 끝나면 값을 가린다.
 *  - v2.604(감사 SEC2604-01): `_PASS`·`_PW`·`_PWD`·`_CRED(S)`·`_CREDENTIAL(S)` 로 끝나는 이름도 가린다.
 *    `PROXY_SSH_PASS`·`HAPROXY_DATAPLANE_PASS`(proxy/registry.js 가 읽는 실제 portal.env 키 — docs/ENV.md)가
 *    백업 번들과 엣지→중앙 설정 사본에 **평문**으로 남았다. ⚠ 접미는 **밑줄로 시작**해야 한다 — 이 판정은
 *    edgelog/redact.js 의 객체 키 가림(isSecretKey)에도 쓰이므로 `pass`(점검 통과 불리언)·`bypass`·`compass`
 *    같은 식별자를 가리면 진단 값이 `[가림]` 이 된다(v2.549 식별자 오탐 규약).
 *  - 가린 값은 `REDACTED` 표식으로 남긴다(줄을 지우지 않는다 — 복원 시 '어떤 키가 있었는지' 를 알아야
 *    현재 값을 이어 붙일 수 있다). 주석·빈 줄·비밀 아닌 키는 그대로.
 *  - 복원(`mergeRedactedEnv`)은 표식 줄을 **현재 파일의 같은 키 값**으로 되살리고, 현재 파일에 없으면
 *    그 줄을 버린다(빈 값으로 덮어써 서명 키를 지우는 사고 방지).
 */
export const REDACTED = '<redacted-by-portal-backup>';
const SECRET_KEY_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|API_KEY|_KEY|_PASS|_PWD?|_CREDS?|_CREDENTIALS?)$/i;
const LINE_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

/** 키 이름이 비밀인가(순수). */
export const isSecretEnvKey = (k) => SECRET_KEY_RE.test(String(k || '').trim());

/**
 * @param {string} text .env 원문
 * @returns {{ text:string, redacted:number, keys:string[] }}
 */
export function redactEnvSecrets(text) {
  const keys = [];
  const out = String(text ?? '').split('\n').map((line) => {
    const m = LINE_RE.exec(line);
    if (!m) return line;
    const [, pre, key, eq, val] = m;
    if (!isSecretEnvKey(key)) return line;
    if (val.trim() === '' || val.trim() === REDACTED) return line; // 빈 값·이미 가린 값은 셈하지 않는다
    keys.push(key);
    return `${pre}${key}${eq}${REDACTED}`;
  }).join('\n');
  return { text: out, redacted: keys.length, keys };
}

/**
 * 복원 병합: incoming(번들) 의 표식 줄을 current(현재 파일) 의 같은 키 값으로 되살린다.
 * @returns {{ text:string, restored:number, dropped:string[] }}
 */
export function mergeRedactedEnv(incoming, current) {
  const cur = new Map();
  for (const line of String(current ?? '').split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) cur.set(m[2], m[4]);
  }
  const dropped = [];
  let restored = 0;
  const lines = [];
  for (const line of String(incoming ?? '').split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m || m[4].trim() !== REDACTED) { lines.push(line); continue; }
    const [, pre, key, eq] = m;
    if (cur.has(key) && cur.get(key).trim() !== '') { lines.push(`${pre}${key}${eq}${cur.get(key)}`); restored++; }
    else dropped.push(key);
  }
  return { text: lines.join('\n'), restored, dropped };
}

/**
 * 2026-10-09 검토 S-10(리드 통합): 보안 스위치는 **호스트 값을 유지**한다 — 백업 복원(웹 화면 경로)이 portal.env 를
 * 번들 값으로 되돌려 서명 정책·TLS 예외·인증 같은 보호를 약하게 만들지 못하게. 이 키들은 호스트 관리자가 파일을
 * 직접 고쳐서만 바꾼다. 현재 파일에 그 키가 있으면 현재 값을 쓰고, 없으면 번들의 그 줄을 버린다(보호 기본값으로 둔다).
 */
export const HOST_PINNED_ENV = Object.freeze([
  'UPGRADE_SIGNATURE_POLICY', 'UPGRADE_ALLOW_UNVERIFIED', 'UPGRADE_TLS_INSECURE',
  'WAN_TLS_INSECURE', 'VC_TLS_REJECT_UNAUTHORIZED', 'HORIZON_TLS_VERIFY', 'NSX_TLS_REJECT_UNAUTHORIZED',
  'STORAGE_TLS_VERIFY', 'SANSWITCH_TLS_VERIFY', 'SSH_HOSTKEY_POLICY', 'TLS_PEER_POLICY',
  'AUTH_ENABLED', 'OTP_ROLE_ENFORCE', 'RMA_ALLOW_CUSTOM', 'RMA_ALLOW_SSH', 'RMA_ALLOW_REBOOT', 'UAGMON_ALLOW_PUBLIC',
]);
const PINNED_SET = new Set(HOST_PINNED_ENV);

/** @returns {{ text:string, pinned:string[] }} — pinned: 번들 값 대신 현재 값(또는 생략)으로 둔 키 */
export function pinHostSecurityEnv(incoming, current) {
  const cur = new Map();
  for (const line of String(current ?? '').split('\n')) {
    const m = LINE_RE.exec(line);
    if (m) cur.set(m[2], line);
  }
  const pinned = [];
  const seen = new Set();
  const lines = [];
  for (const line of String(incoming ?? '').split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m || !PINNED_SET.has(m[2])) { lines.push(line); continue; }
    const key = m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    if (cur.has(key)) { if (cur.get(key) !== line) pinned.push(key); lines.push(cur.get(key)); }
    else pinned.push(key);
  }
  // 현재 파일에만 있는 보안 키는 그대로 이어 붙인다(복원이 호스트가 켠 보호를 지우지 않게).
  for (const [key, line] of cur) {
    if (PINNED_SET.has(key) && !seen.has(key)) { lines.push(line); }
  }
  return { text: lines.join('\n'), pinned };
}
