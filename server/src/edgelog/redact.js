/**
 * edgelog/redact.js — 엣지 상태·로그를 중앙으로 보내기 전에 **비밀을 지운다**(v2.549).
 *
 * server/CLAUDE.md 불변조건: "비밀 값은 어떤 API 응답에도 싣지 않는다".
 * 이 경로는 각 모듈의 `*Status()` 반환을 **그대로** 실어 나르므로, 어느 모듈이 상태에 토큰·비밀번호를
 * 담기 시작하면 그 순간 중앙 화면으로 새어 나간다. 모듈을 하나씩 감사하는 대신 **출구에서** 훑는다.
 *
 * 규칙:
 *  · 키 이름이 `secretVault.SECRET_FIELDS` 와 정확히 같거나(`password`·`token`·…),
 *    `SECRET_KEY_RE`(`…_TOKEN`·`…_PASSWORD`·`…_KEY` 꼴)에 걸리면 값을 `'[가림]'` 으로 바꾼다.
 *  · ⚠ **키를 지우지 않고 표식을 남긴다** — 지우면 화면이 '그 필드가 없다' 고 오해한다(v2.538 규약).
 *  · 값이 없거나 빈 문자열이면 그대로 둔다 — `''` 자체가 진단이다(배포가 비밀을 안 실어 왔다).
 *  · 깊이·노드 수 상한이 있다(순환 참조·거대 객체가 이 함수에서 멈추지 않게).
 *
 * ⚠ **이것은 최후 방어선이지 면죄부가 아니다.** 새 `*Status()` 를 만들 때 비밀을 넣지 않는 것이 먼저다.
 */
import { SECRET_FIELDS } from '../security/secretVault.js';
import { isSecretEnvKey } from '../util/envRedact.js';

export const MASK = '[가림]';
const MAX_DEPTH = 8;
const MAX_NODES = 5_000;

/** 이 키의 값을 가려야 하는가. 정확 일치(SECRET_FIELDS) + env 스타일 접미(SECRET_KEY_RE). */
export function isSecretKey(k) {
  const s = String(k || '');
  if (SECRET_FIELDS.has(s)) return true;
  if (isSecretEnvKey(s)) return true;
  /*
   * `…Password`·`…Token`·`…Secret`·`…PrivateKey`·`…ApiKey` 같은 카멜케이스 접미(모듈마다 이름이 다르다).
   * ⚠ **`key$` 를 통째로 넣지 말 것** — 이 저장소에는 비밀이 아닌 `deviceKey`·`partKey`·`dbKey` 가 많고
   *   그것들이 가려지면 파트 장애·수집 화면의 식별자가 통째로 `[가림]` 이 된다(진단 불가).
   */
  return /(password|passwd|passphrase|secret|privatekey|apikey)$/i.test(s) || /(?:^|[a-z0-9])token$/i.test(s);
}

/**
 * 객체를 깊이 훑어 비밀 값을 가린다. 원본은 건드리지 않는다(새 객체를 만든다).
 * @returns {{ value:any, masked:number, truncated:boolean }} `masked` = 가린 개수(화면이 밝힌다)
 */
export function redactDeep(input) {
  let masked = 0;
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet();

  const walk = (v, depth) => {
    if (++nodes > MAX_NODES) { truncated = true; return '[상한]'; }
    if (v === null || typeof v !== 'object') return v;
    if (depth >= MAX_DEPTH) { truncated = true; return '[깊이 상한]'; }
    if (seen.has(v)) return '[순환]';
    seen.add(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      // 빈 값은 그대로 — `''`·null 자체가 진단이다(비밀이 실려 오지 않았다는 사실).
      if (isSecretKey(k) && val !== '' && val != null) { out[k] = MASK; masked += 1; continue; }
      out[k] = walk(val, depth + 1);
    }
    return out;
  };

  return { value: walk(input, 0), masked, truncated };
}

/**
 * 로그 한 줄에서 비밀처럼 보이는 것을 가린다.
 * ⚠ 로그는 자유 문자열이라 **완전할 수 없다** — 표본 감사(v2.549)에서 이 저장소의 로그 문구는
 *   토큰 값을 찍지 않았지만(`[partfault-push] 비활성 — CENTRAL_URL/CENTRAL_TOKEN 없음` 처럼
 *   **이름만** 적는다), 앞으로 누가 값을 찍을 수 있다. `KEY=value`·`token: value` 꼴만 잡는다.
 *   잡지 못하는 형태가 있다는 사실을 화면이 말해야 한다(`logRedactNote`).
 */
/*
 * v2.599(감사 SEC2599-04): `Authorization: Basic|Digest …` 와 URL 사용자정보(`https://user:pw@host`)를 더 잡는다.
 *   도달 경로가 실재한다 — 엣지 워커 20여 곳이 기동 줄에 `config.agent.centralUrl` 을 **그대로** 찍는다
 *   (`[ping-agent] started (central=…)` 등). 중앙 앞에 기본 인증 프록시를 두려고 CENTRAL_URL 에 `user:pw@` 를
 *   넣은 현장이면 그 비밀번호가 콘솔 링버퍼 → 엣지 로그 화면으로 나간다. 사용자정보는 **비밀번호 쪽만** 가린다
 *   (계정 이름은 진단 정보다). 줄 규칙만 넓힌다 — `isSecretKey`(객체 키)는 그대로 둔다(식별자 오탐 규약).
 */
/*
 * v2.601(감사 SEC2601-03): JSON 로 찍힌 줄(`{"password":"…"}`)은 키 뒤에 따옴표가 와서 `KEY\s*[=:]` 규칙을 빠져나갔고,
 *   SECRET_FIELDS 의 카멜케이스 이름(`vcenterPass`·`guestPass`·`privateKey`)도 목록에 없었다. 둘을 더한다.
 *   · JSON 꼴은 **키 끝이 비밀 이름**일 때만(`"centralToken"` 은 가리고 `"tokenFp"`·`"deviceKey"`·`"partKey"` 는 두지 않는다 —
 *     v2.549 식별자 오탐 규약). 따옴표 값은 따옴표를 남기고 안만 가린다(`"[가림]"`) — 줄의 JSON 모양을 깨지 않는다.
 *   · 따옴표 값 길이는 4,096자로 묶는다(긴 줄에서 정규식이 선형이도록 — v2.598 INJ 규약).
 *   · 여전히 완전하지 않다(자유 문자열) — 화면의 logRedactNote 는 그대로 둔다.
 */
const LOG_SECRET_KEYS = 'token|password|passwd|passphrase|secret|apikey|api_key|private_?key|vcenterPass|guestPass';
const JSON_SECRET_RE = new RegExp(`(["'][A-Za-z0-9_.-]{0,40}?(?:${LOG_SECRET_KEYS})["']\\s*:\\s*)("(?:[^"\\\\\\n]|\\\\.){0,4096}"|'[^'\\n]{0,4096}'|[^\\s,}\\]]+)`, 'gi');
const PLAIN_SECRET_RE = new RegExp(`((?:${LOG_SECRET_KEYS})\\s*[=:]\\s*)("(?:[^"\\\\\\n]|\\\\.){0,4096}"|\\S+)`, 'gi');
const maskValue = (pre, v) => {
  if (v === 'null' || v === '""' || v === "''") return pre + v; // 빈 값은 그대로 — 그 자체가 진단이다
  const q = v[0] === '"' || v[0] === "'" ? v[0] : '';
  return q ? `${pre}${q}${MASK}${q}` : `${pre}${MASK}`;
};
export function redactLogLine(line) {
  return String(line == null ? '' : line)
    .replace(JSON_SECRET_RE, (_m, pre, v) => maskValue(pre, v))
    .replace(PLAIN_SECRET_RE, (_m, pre, v) => maskValue(pre, v))
    .replace(/\b(Bearer\s+)\S+/gi, `$1${MASK}`)
    .replace(/\b((?:Proxy-)?Authorization\s*[=:]\s*(?:Basic|Digest)\s+)\S+/gi, `$1${MASK}`)
    .replace(/(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/@:]{1,256}:)[^\s/@]{1,512}@/gi, `$1${MASK}@`)
    .replace(/(X-[A-Za-z-]*Token\s*[=:]\s*)\S+/gi, `$1${MASK}`);
}
