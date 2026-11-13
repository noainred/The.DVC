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
/*
 * v2.604(감사 SEC2604-02): ① 평문 규칙에 홑따옴표 값 가지를 더한다 — `PASSWORD: 'a b c'` 가 첫 단어만 가려져
 *   `'[가림]' b c'` 로 **나머지 단어가 샜다**(JSON 규칙은 이미 홑따옴표를 받았다 — 두 규칙의 비대칭).
 *   ② env 꼴 이름(`PROXY_SSH_PASS=`·`SECRETS_KEY=`·`X_CREDENTIALS=`)은 **대문자 식별자 + `=`** 일 때만 잡는다
 *   (대소문자 구분). `deviceKey=`·`partKey=`·`pass=`(점검 통과) 같은 소문자·카멜 식별자는 건드리지 않는다 —
 *   v2.549 '`key$` 를 통째로 넣지 말 것' 은 그 식별자들 때문이고, 대문자 env 이름은 그 규약의 대상이 아니다.
 *   PEM 본문(여러 줄)은 여전히 못 잡는다 — 줄 단위 가림의 한계(logRedactNote 가 말한다).
 */
const PLAIN_SECRET_RE = new RegExp(`((?:${LOG_SECRET_KEYS})\\s*[=:]\\s*)("(?:[^"\\\\\\n]|\\\\.){0,4096}"|'[^'\\n]{0,4096}'|\\S+)`, 'gi');
const ENV_SECRET_RE = /(\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|PASS|PWD?|CREDS?|CREDENTIALS?)\s*=\s*)("(?:[^"\\\n]|\\.){0,4096}"|'[^'\n]{0,4096}'|\S+)/g;
const maskValue = (pre, v) => {
  if (v === 'null' || v === '""' || v === "''") return pre + v; // 빈 값은 그대로 — 그 자체가 진단이다
  const q = v[0] === '"' || v[0] === "'" ? v[0] : '';
  return q ? `${pre}${q}${MASK}${q}` : `${pre}${MASK}`;
};
/*
 * 리눅스 성능 7a단계(서버 로그 분석 — bmusage/logs): **서버 시스템 로그 줄**(journald · dmesg · /var/log/secure · audit · GPDB · Airflow)의 표본 가림.
 *   redactLogLine(포탈 자체 로그 규칙)을 먼저 거친 뒤 로그용 규칙을 더한다(설계 §19 ‘로그 샘플’ 행 — password= · Authorization: · 키 블록 · 개인정보 꼴):
 *    · `pass=` · `pwd=` · `pw=` · `passwd=` 값(포탈 로그에서는 ‘점검 통과(pass=)’ 식별자라 안 가렸지만 서버 로그에서는 비밀 쪽이 흔하다)
 *    · `Authorization:` 뒤 줄 끝까지(Basic · Digest · Bearer 외 스킴 — Negotiate · 사용자 지정 스킴 — 넘치게 가리는 쪽을 택했다)
 *    · PEM 머리 줄(`-----BEGIN … PRIVATE KEY-----`)과 **줄 전체가 긴 base64** 인 줄(키 본문 — 줄 단위라 블록을 이어 볼 수 없어 꼴로 가린다)
 *    · 개인정보 꼴: 전자우편 · 주민등록번호 · 휴대전화 · 카드번호(4자리 넷) · sudo COMMAND 의 **인자**(명령 경로만 남긴다 — `mysql -p비밀` 같은 인자에 비밀이 실린다)
 *   ⚠ 줄 길이를 먼저 자른다(MAX_SYSLOG_LINE) — 모든 정규식은 길이 한정 반복(ReDoS 비율 테스트: test/bmLogs7aRedact.test.js).
 *   ⚠ 완전할 수 없다(자유 문자열) — 화면이 ‘가림은 꼴 기반이라 빠질 수 있다’ 를 말한다. 원문 전체를 저장 · 전송하지 않는 것이 1차 방어다(이 함수는 표본 5줄용).
 */
export const MAX_SYSLOG_LINE = 1_000;
const SYS_PASS_RE = /((?:^|[\s,;?&"'(])(?:pass|pwd|pw|passwd|passphrase)\s{0,2}=\s{0,2})("[^"\n]{0,512}"|'[^'\n]{0,512}'|[^\s,;&"')]{1,512})/gi;
const SYS_AUTHZ_RE = /\b((?:Proxy-)?Authorization\s{0,2}[=:]\s{0,2}).{1,1024}$/i;
const PEM_RE = /-----(?:BEGIN|END) [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const B64_LINE_RE = /^\s{0,8}[A-Za-z0-9+/]{40,1024}={0,2}\s{0,8}$/;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}\b/g;
const RRN_RE = /\b\d{6}-?[1-8]\d{6}\b/g;
const PHONE_RE = /\b01[016789]-?\d{3,4}-?\d{4}\b/g;
const CARD_RE = /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/g;
const SUDO_CMD_RE = /(; COMMAND=)(\S{1,256})[ \t].{0,1024}$/;
export function redactSystemLogLine(line) {
  let s = String(line == null ? '' : line);
  if (s.length > MAX_SYSLOG_LINE) s = s.slice(0, MAX_SYSLOG_LINE);
  if (PEM_RE.test(s)) return `${MASK} — 키 블록 머리 줄`;
  if (B64_LINE_RE.test(s)) return `${MASK} — 긴 base64 줄(키 본문일 수 있음)`;
  return redactLogLine(s)
    // ⚠ 대문자 PWD= 는 작업 폴더(sudo 로그 · 환경 변수 PWD)다 — 비밀이 아니다(Chromium 판독: sudo 표본의 PWD=/home/… 가 가려졌다).
    .replace(SYS_PASS_RE, (m, pre, v) => (/(?:^|[^A-Za-z])PWD\s{0,2}=\s{0,2}$/.test(pre) ? m : (v === MASK || v === `"${MASK}"` || v === `'${MASK}'` ? pre + v : `${pre}${MASK}`)))
    .replace(SYS_AUTHZ_RE, (_m, pre) => `${pre}${MASK}`)
    .replace(SUDO_CMD_RE, (_m, pre, cmd) => `${pre}${cmd} ${MASK}(인자)`)
    .replace(EMAIL_RE, `${MASK}(메일)`)
    .replace(RRN_RE, `${MASK}(주민번호)`)
    .replace(PHONE_RE, `${MASK}(전화)`)
    .replace(CARD_RE, `${MASK}(카드)`);
}
export function redactLogLine(line) {
  return String(line == null ? '' : line)
    .replace(JSON_SECRET_RE, (_m, pre, v) => maskValue(pre, v))
    .replace(PLAIN_SECRET_RE, (_m, pre, v) => maskValue(pre, v))
    .replace(ENV_SECRET_RE, (_m, pre, v) => (v === MASK || v.endsWith(`${MASK}"`) || v.endsWith(`${MASK}'`) ? pre + v : maskValue(pre, v)))
    .replace(/\b(Bearer\s+)\S+/gi, `$1${MASK}`)
    .replace(/\b((?:Proxy-)?Authorization\s*[=:]\s*(?:Basic|Digest)\s+)\S+/gi, `$1${MASK}`)
    .replace(/(\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s/@:]{1,256}:)[^\s/@]{1,512}@/gi, `$1${MASK}@`)
    .replace(/(X-[A-Za-z-]*Token\s*[=:]\s*)\S+/gi, `$1${MASK}`);
}
