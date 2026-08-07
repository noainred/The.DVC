/**
 * 성능점검 대량 등록 생성기 — '이름 규칙(+{n}) + IP 범위' 를 구체적인 대상 행으로 펼치는
 * **순수 확장기**. 저장소에 쓰지 않고 파일·소켓도 만지지 않는다(라우트가 결과 rows 를
 * `store.planBulkTargets` / `store.bulkAddTargets` 에 넘겨 커밋한다).
 *
 * 이 모듈의 본질은 '펼치기' 가 아니라 **매핑이 어긋날 수 있는 모든 경우를 전체 거부로 돌리는
 * 것**이다. 이름 i 번째가 IP i 번째와 1:1 로 붙는 구조이므로 중간에서 한 칸이라도 밀리면
 * 전 대상이 엉뚱한 주소를 감시한다(감시 공백보다 나쁘다 — 화면은 정상으로 보인다).
 * 그래서 아래를 규칙으로 못박는다.
 *   - 개수 불일치·IP 파싱 오류 1건·확장 상한 초과·차단 IP 는 **부분 생성 없이 전체 거부**.
 *     `errors`(또는 `blocked`)가 1건이라도 있으면 `rows` 는 빈 배열이다(타입으로 강제).
 *   - **IP 범위를 자동으로 연장하지 않는다.** 부족분을 임의로 늘리면 그 IP 가 다른 팀 장비일 때
 *     tcp/ping 이 ok 로 떠서 '거짓 정상' 이 된다. 대신 `suggest:{count}` 로 사람이 고르게 한다.
 *   - **.0/.255·차단 IP 를 조용히 건너뛰지 않는다.** 건너뛰면 그 뒤 이름↔IP 가 한 칸 밀린다.
 *     .0/.255 는 경고만, 차단 IP 는 `blocked[]` 로 분리하고 전체 거부한다.
 *   - **비정규 IPv4 표기(옥텟 선행 0)를 거부한다.** `expandIpList` 는 단건 토큰을 정규화하지 않고
 *     입력 문자열 그대로 돌려준다(iprange.js `push(token)`). '0127.0.0.1' 을 그대로 host 로 쓰면
 *     SSRF 가드(URL 파서)는 8진수로 읽어 87.0.0.1 로 판정해 **허용**하는데 OS 리졸버는
 *     127.0.0.1 로 접속한다(실측). '검증한 주소'와 '실제 감시하는 주소'가 갈리는 순간
 *     화면의 ok 는 거짓 정상이다 — 그래서 정규 점표기가 아니면 전체 거부한다.
 *   - **커밋과 같은 상한을 미리보기에서도 본다.** 대상당 점검 수(`LIMITS.maxTestsPerTarget`)를
 *     보지 않으면 '미리보기 통과 → 등록 전량 실패' 가 된다(store.js planBulkTargets 가 명시적으로
 *     금지한 상태). 점검 값 자체도 커밋과 같은 정제 함수(`store.normalizeTest`)로 예산 안에서 본다.
 *   - **blocked/warnings 도 상한·중복 제거를 둔다.** '127.0.0.0/21,169.254.0.0/21' 은 차단 4092건
 *     (응답 340KB), 같은 CIDR 토큰 5000개는 동일 문구 경고 5000건(388KB) 이었다 — errors 에만
 *     상한을 두면 그 이유가 그대로 무력화된다. 총 건수는 요약 문구와 `blockedTotal` 로 알린다.
 *
 * 재사용(새로 만들지 않는다): IP 확장은 `idrac/iprange.js expandIpList`, IP 정수 변환은
 * `provision/spec.js ipToNum/numToIp`, 호스트 SSRF 판정은 `store.validateEndpoint`,
 * 점검 값 정제는 `store.normalizeTest`, 상한/필드 상한은 `store.LIMITS` / `testSchema.TARGET_FIELDS`.
 */

import { expandIpList } from '../idrac/iprange.js';
import { ipToNum, numToIp } from '../provision/spec.js';
import { LIMITS, validateEndpoint, normalizeTest } from './store.js';
import { KINDS, TARGET_FIELDS } from './testSchema.js';

/** 1회 생성 상한 — store.js 의 값을 그대로 쓴다(여기서 새 숫자를 정하면 라우트와 어긋난다). */
export const MAX_GEN_ROWS = LIMITS.maxBulkRows;
const MAX_GEN_TESTS = LIMITS.maxBulkTests;

// 글자수 상한·기본값도 testSchema 의 대상 필드표에서 파생한다(복사 금지).
const field = (key) => TARGET_FIELDS.find((f) => f.key === key) || {};
const NAME_MAX = field('name').max;      // 120
const PATH_MAX = field('path').max;      // 620
const HOST_MAX = field('host').max;      // 253
const ENABLED_DFLT = field('enabled').dflt;

/**
 * 경로 검증은 store.js 의 SAFE_PATH + SAFE_SEG 와 **같은 규칙**이다. 그 두 정규식은 store.js
 * 에서 export 하지 않아 부득이 같은 규칙을 여기 둔다(최종 검증은 커밋 시 store.cleanTarget 이
 * 다시 수행하므로 이 검사는 '미리보기에서 먼저 알려주기' 용도).
 * SAFE_PATH 만으로는 부족하다 — 'OC2/SBP' 는 SAFE_PATH 를 통과하지만 세그먼트 규칙 위반이라
 * UI addFolder 로 형제 폴더를 만들 수 없고 트리 표시가 어긋난다. 그래서 세그먼트별로도 본다.
 */
const SAFE_SEG = /^[^\\/:*?"<>|]{1,60}$/;
const SAFE_PATH = /^[^\\]{1,60}(\\[^\\]{1,60}){0,9}$/;

const HOST_MODES = ['ips', 'name'];
const DUP_MODES = ['skip', 'error'];
/** 도메인 형식 — 라벨 사이 '.' 만 허용(SAFE_HOST 부분집합). */
const SAFE_DOMAIN = /^\.[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*$/;
/** 토큰별 재확장(중복 개수 산출)의 작업량 상한 — 중복 여부 판단에 이 이상은 필요 없다. */
const DEDUP_SCAN_CAP = 8192;
/** 오류 목록 상한 — 토큰 수백 개가 전부 틀리면 응답이 수백 KB 가 된다. */
const ERR_CAP = 5;
/**
 * 차단 목록·경고 목록 상한. errors 에만 상한을 두면 의미가 없다 — /21 두 개면 차단 4092건에
 * 응답 340KB, 같은 CIDR 토큰 5000개면 동일 문구 경고 5000건에 388KB 였다(실측).
 * 20 은 화면(PreviewTable)이 실제로 그리는 개수와 같다. 총 건수는 `blockedTotal` 로 따로 낸다.
 */
const BLOCKED_CAP = 20;
const WARN_CAP = 20;
/** 목록 상한을 테스트·호출부가 같은 값으로 보게 노출한다(숫자를 복사하지 않기 위해). */
export const LIST_CAPS = { blocked: BLOCKED_CAP, warnings: WARN_CAP };
/**
 * 점검 값 검증 예산(개수). 2,000행 × 200점검 = 40만 건을 전수 검증하면 559ms 동안 이벤트 루프가
 * 멈춘다(실측: 400,000건 559ms / 500건 2.2ms). materialize 는 보통 전 행에 같은 템플릿을
 * 적용하므로 앞부분만 봐도 구조 오류(유형·필수값)는 잡힌다 — 전수 검증은 커밋(cleanTest)이 한다.
 */
const TEST_CHECK_CAP = 500;
/**
 * 비정규 IPv4 표기 탐지 — **4 옥텟이 전부 숫자인 호스트**만 대상으로 옥텟 선행 0 을 잡는다.
 * 그 형태는 리졸버·SSRF 가드가 IP 로 취급하므로 선행 0 이 있으면 8진수로 읽혀
 * '검증한 주소'와 '실제 감시 주소'가 갈린다('010.0.0.1' → 가드 8.0.0.1 / 표시 10.0.0.1).
 * 숫자 4옥텟일 때만 보므로 DNS 이름의 '010' 라벨(srv010.corp.local·a.010.corp.local)은
 * 오탐하지 않는다. 범위/CIDR 토큰은 iprange 가 intToIp 로 정규화해 돌려주므로 애초에 걸리지 않는다.
 * 옥텟 자리수를 1~3 으로 제한하면 안 된다 — iprange 는 '0127'(=127) 처럼 4자리 옥텟도 받으므로
 * 그 표기가 검사를 통째로 빠져나간다(실측: '0127.0.0.1' 이 통과해 가드는 87.0.0.1 로 읽었다).
 */
const NUMERIC_QUAD = /^\d+(?:\.\d+){3}$/;
const nonCanonicalIp = (h) => NUMERIC_QUAD.test(h) && /(?:^|\.)0\d/.test(h);

/**
 * `{n}` 치환 + 자리수 패딩. `provision/spec.js` 의 applyPattern 과 **같은 규약**이다
 * (그 파일은 export 하지 않고, 수정 대상도 아니므로 규약만 맞춰 다시 구현한다).
 */
const applyPattern = (pat, n, pad) => {
  const num = pad > 0 ? String(n).padStart(pad, '0') : String(n);
  return String(pat || '').replace(/\{n\}/g, num);
};

/** 불리언 파싱 — `!!'false'` 는 true 다(store.js bool 과 같은 화이트리스트 규칙). */
const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'on', 't', '예', 'o']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'off', 'f', '아니오', 'x']);
function boolOf(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v !== 0 : dflt;
  const s = String(v).trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return dflt;
}

/**
 * `iprange.js expandIpList` 와 **같은 토큰화**(줄 단위 + '#' 주석 + 콤마 분리).
 * expandIpList 는 토큰 목록을 돌려주지 않으므로 분해만 한 번 더 하고, 확장 자체는
 * 전부 expandIpList 에 위임한다(파싱 규칙을 두 곳에 두지 않기 위해).
 */
function ipTokens(text) {
  const out = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    for (const t of line.split(',').map((s) => s.trim()).filter(Boolean)) out.push(t);
  }
  return out;
}

/** CIDR 토큰의 네트워크 정규화 여부 — '10.0.0.5/24' 를 넣은 사람은 .5 부터를 의도했을 수 있다. */
function cidrNormalizeNote(token) {
  const [base, bitsStr] = token.split('/');
  const baseInt = ipToNum(base);
  const bits = Number(bitsStr);
  // 형식 오류는 expandIpList 가 보고한다(여기서 중복 보고하지 않는다).
  if (baseInt == null || !/^\d+$/.test(String(bitsStr)) || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const network = (baseInt & mask) >>> 0;
  const firstHost = bits >= 31 ? network : (network + 1) >>> 0;
  // 경고는 '입력한 주소와 확장 시작 주소가 다르다' 를 알리는 것이므로 두 가지를 모두 뺀다.
  //  - base == firstHost: '10.20.30.1/24' 처럼 host 범위의 첫 주소를 적는 표준 관행. network 와만
  //    비교하면 '10.20.30.1 부터 확장됩니다(입력한 10.20.30.1 부터가 아닙니다)' 라는 자기모순
  //    경고가 뜬다(/26 의 .65, /29 의 .9, /30 의 4k+1 도 같다).
  //  - base == network: '10.0.0.0/24' 처럼 네트워크 주소를 적은 경우. .0 이 빠지는 것은 CIDR 의
  //    정의 그대로여서 알릴 내용이 없다(여기까지 경고하면 가장 흔한 입력마다 경고가 뜬다).
  // 거짓 경고가 반복되면 정작 '10.0.0.5/24 → .1 부터' 같은 진짜 이동 경고까지 함께 무시된다.
  if (firstHost === baseInt || network === baseInt) return null;
  return `${token} 는 네트워크 주소로 정규화되어 ${numToIp(firstHost)} 부터 확장됩니다(입력한 ${base} 부터가 아닙니다).`;
}

/**
 * 이름 규칙 + IP 범위를 대상 행으로 펼친다.
 *
 * @param {object} spec
 *   {kind:'infra'|'service', path:'A.Infra\\OC2\\워커노드',
 *    name:{pattern:'lesasbpdp{n}', start:1, pad:2, count:20},
 *    host:{mode:'ips'|'name', ips:'10.20.30.41-10.20.30.60', domain:'.sbp.local'},
 *    enabled:false, onDuplicate:'skip'|'error'}
 *   `onDuplicate` 는 값만 검증한다 — 실제 중복 처리는 저장소를 아는 라우트가
 *   `store.bulkAddTargets({dedup})` 로 수행한다(이 모듈은 저장소를 보지 않는다).
 * @param {{materialize?:(row:object)=>object[]}} opts
 *   materialize 가 있으면 그 반환값을 각 행의 tests 로 넣는다(없으면 tests:[]).
 *   템플릿 모듈을 import 하지 않는다 — 순환 의존을 피하고 점검 생성 정책을 호출부에 남긴다.
 * @returns {{rows:object[], errors:string[], blocked:{ip:string,reason:string}[],
 *            blockedTotal:number, warnings:string[], stats:object, suggest:{count:number}|null}}
 *   `blocked` 는 상위 BLOCKED_CAP 건만 담는다 — 실제 차단 건수는 `blockedTotal` 이다.
 */
export function expandGenSpec(spec = {}, opts = {}) {
  const errors = [];
  const blocked = [];
  const warnings = [];
  const stats = {
    names: 0, ips: 0, dedupRemoved: 0, firstIp: '', lastIp: '', padTransition: null, nameMaxLen: 0,
  };
  let suggest = null;
  let blockedTotal = 0;      // blocked[] 는 상한을 두므로 '건수' 는 별도로 센다(요약 문구의 근거).
  let warnOmitted = 0;
  const warnSeen = new Set();
  // 차단 사유는 목록으로 보여 주되 응답 크기는 상한으로 묶는다(총 건수는 blockedTotal).
  const pushBlocked = (ip, reason) => {
    blockedTotal += 1;
    if (blocked.length < BLOCKED_CAP) blocked.push({ ip, reason });
  };
  // 같은 문구 경고를 수천 건 싣지 않는다(화면도 그 수만큼 줄을 그린다).
  const pushWarn = (msg) => {
    if (warnSeen.has(msg)) return;
    warnSeen.add(msg);
    if (warnings.length < WARN_CAP) warnings.push(msg);
    else warnOmitted += 1;
  };
  // 부분 생성 금지를 반환 지점 한 곳에서 강제한다(호출부가 errors 를 안 보고 rows 를 써도 안전).
  const out = (rows) => {
    if (warnOmitted > 0) warnings.push(`… 경고 ${warnOmitted}건 생략(중복 제거 후 상위 ${WARN_CAP}건만 표시).`);
    return {
      rows: (errors.length || blockedTotal) ? [] : rows,
      errors, blocked, blockedTotal, warnings, stats, suggest,
    };
  };

  const s = spec && typeof spec === 'object' ? spec : {};
  const nameSpec = s.name && typeof s.name === 'object' ? s.name : {};
  const hostSpec = s.host && typeof s.host === 'object' ? s.host : {};

  /**
   * 정수 읽기 — `Number.isInteger(Number(v))` 만 보면 표기법 우회를 막지 못한다(실측:
   * count '1e3'→1000, '0x64'→100, true→1, [3]→3, pad true→1). count 는 이 모듈의 중심
   * 안전장치이고 mode:'name' 에는 IP 개수 교차검증이 없어 그 값이 곧 생성 대상 수가 된다 —
   * '2.5 는 정수가 아니라고 거부하면서 "1e3" 은 1000개로 통과' 는 검증하지 않는 것과 같다.
   * 그래서 **정수 리터럴만** 인정한다(숫자형 정수 또는 /^[+-]?\d+$/ 문자열).
   */
  const readInt = (v, { dflt = null, min, max, label }) => {
    if (v === null || v === undefined || v === '') return dflt;
    let n = null;
    if (typeof v === 'number') n = Number.isInteger(v) ? v : null;
    else if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) n = Number(v.trim());
    if (n === null || !Number.isSafeInteger(n)) {
      // String() 이 던지는 값(Object.create(null) 등)도 있으므로 라벨 만들기에서 500 을 내지 않는다.
      let shown; try { shown = String(v).slice(0, 20); } catch { shown = typeof v; }
      errors.push(`${label}은 정수여야 합니다: ${shown}`);
      return null;
    }
    if (n < min || n > max) { errors.push(`${label}은 ${min}~${max} 범위여야 합니다: ${n}`); return null; }
    return n;
  };
  const pushCapped = (msgs, tail = '') => {
    for (const m of msgs.slice(0, ERR_CAP)) errors.push(m);
    if (msgs.length > ERR_CAP) errors.push(`… 외 ${msgs.length - ERR_CAP}건${tail}`);
  };

  /* ── 구분 · 경로 · 중복정책 · 사용여부 ── */
  const rawKind = s.kind === null || s.kind === undefined || s.kind === '' ? KINDS[0] : String(s.kind).trim().toLowerCase();
  const kind = KINDS.includes(rawKind) ? rawKind : KINDS[0];
  // 목록 밖 값을 조용히 폴백하면 'service' 로 적은 요청이 전부 infra 트리에 쌓인다.
  if (!KINDS.includes(rawKind)) errors.push(`알 수 없는 구분: ${rawKind.slice(0, 20)} (가능: ${KINDS.join(', ')})`);

  const treePath = typeof s.path === 'string' ? s.path.trim() : '';
  if (!treePath) {
    errors.push('트리 경로를 입력하세요.');
  } else if (treePath.length > PATH_MAX) {
    errors.push(`트리 경로는 ${PATH_MAX}자를 넘을 수 없습니다(현재 ${treePath.length}자).`);
  } else if (!SAFE_PATH.test(treePath)) {
    errors.push("경로 형식이 올바르지 않습니다(구분자 '\\', 단계별 60자, 최대 10단계).");
  } else {
    const badSeg = treePath.split('\\').find((seg) => !SAFE_SEG.test(seg));
    if (badSeg !== undefined) errors.push(`경로에 쓸 수 없는 문자가 있습니다: ${badSeg.slice(0, 40)} (\\ / : * ? " < > | 금지)`);
  }

  const rawDup = s.onDuplicate === null || s.onDuplicate === undefined || s.onDuplicate === '' ? DUP_MODES[0] : String(s.onDuplicate).trim().toLowerCase();
  if (!DUP_MODES.includes(rawDup)) errors.push(`알 수 없는 중복 처리: ${rawDup.slice(0, 20)} (가능: ${DUP_MODES.join(', ')})`);

  const enabled = boolOf(s.enabled, ENABLED_DFLT);

  /* ── 이름 규칙 ── */
  const pattern = typeof nameSpec.pattern === 'string' ? nameSpec.pattern.trim() : '';
  if (!pattern) errors.push("이름 규칙을 입력하세요(예: 'lesasbpdp{n}').");
  const start = readInt(nameSpec.start, { dflt: 1, min: 0, max: 1_000_000_000, label: '시작 번호' });
  const pad = readInt(nameSpec.pad, { dflt: 0, min: 0, max: 12, label: '자리수(pad)' });
  const countGiven = !(nameSpec.count === null || nameSpec.count === undefined || nameSpec.count === '');
  let count = readInt(nameSpec.count, { dflt: null, min: 1, max: 1_000_000, label: '개수' });

  /* ── 호스트 ── */
  const rawMode = hostSpec.mode === null || hostSpec.mode === undefined || hostSpec.mode === '' ? HOST_MODES[0] : String(hostSpec.mode).trim().toLowerCase();
  const mode = HOST_MODES.includes(rawMode) ? rawMode : HOST_MODES[0];
  if (!HOST_MODES.includes(rawMode)) errors.push(`알 수 없는 호스트 방식: ${rawMode.slice(0, 20)} (가능: ${HOST_MODES.join(', ')})`);

  let ips = [];
  let ipFatal = false;
  let domain = '';
  // 중복 개수 스캔이 작업량 상한에서 끊겼는지 — 끊긴 값(stats.dedupRemoved)은 부분 합계라
  // 정확한 건수가 아니다. 그 경우 메시지에 숫자를 적지 않는다(틀린 수를 단정하지 않는다).
  let dedupScanCapped = false;

  if (mode === 'ips') {
    const ipText = Array.isArray(hostSpec.ips) ? hostSpec.ips.join('\n') : (typeof hostSpec.ips === 'string' ? hostSpec.ips : '');
    const tokens = ipTokens(ipText);
    if (!tokens.length) {
      errors.push("IP 범위를 입력하세요(예: '10.20.30.41-10.20.30.60' 또는 '10.20.30.0/24').");
      ipFatal = true;
    } else {
      // IPv6 는 입력 단계에서 명시 거부한다 — 대상 저장소(host 화이트리스트·IPv4 확장기)가
      // 받지 못하므로 '잘못된 IP' 로 흘려보내면 원인을 못 읽는다.
      const v6 = tokens.filter((t) => t.includes(':'));
      if (v6.length) {
        pushCapped(v6.map((t) => `IPv6 · 콜론(:) 표기는 지원하지 않습니다(IPv4 만): ${t.slice(0, 40)}`));
        ipFatal = true;
      } else {
        const r = expandIpList(ipText);
        ips = r.ips;
        if (r.errors.length) {
          // 중간 오류 1건이 그 뒤 전 이름↔IP 매핑을 한 칸 밀기 때문에 부분 성공을 인정하지 않는다.
          pushCapped(r.errors.map((e) => `IP 확장 오류: ${e}`));
          errors.push('잘못된 IP 토큰이 있어 전체를 거부했습니다 — 한 건만 빠져도 그 뒤 이름↔IP 매핑이 밀립니다(부분 생성하지 않습니다).');
          ipFatal = true;
        }
        if (r.truncated) {
          // truncated 시점의 ips.length 가 곧 확장기 상한이다(iprange.js 는 상한을 export 하지 않는다).
          errors.push(`IP 확장 상한(${ips.length}개)을 초과했습니다 — 조용히 잘라 등록하지 않습니다. 범위를 나눠 여러 번 등록하세요.`);
          ipFatal = true;
        }
        if (!ips.length && !ipFatal) {
          errors.push('확장된 IP 가 없습니다 — 범위/CIDR 을 확인하세요.');
          ipFatal = true;
        }
        // 비정규 표기 거부 — expandIpList 는 단건 토큰을 원문 그대로 돌려주므로(iprange.js
        // `push(token)`) '0127.0.0.1' 이 그대로 host 가 된다. 그러면 SSRF 가드가 읽는 주소
        // (URL 파서: 8진수 → 87.0.0.1, 허용), OS 리졸버가 접속하는 주소(127.0.0.1, 실측),
        // 사용자가 입력한 주소 셋이 서로 달라진다 — 감시 대상이 아닌 곳에 ok 가 뜬다.
        if (!ipFatal) {
          const nonCanon = ips.filter(nonCanonicalIp);
          if (nonCanon.length) {
            pushCapped(nonCanon.map((ip) => `IPv4 정규 표기만 허용합니다(옥텟 선행 0 금지 — 8진수로 해석될 수 있습니다): ${ip.slice(0, 40)}`));
            errors.push('선행 0 표기는 SSRF 가드·OS 리졸버·화면 표시가 서로 다른 주소를 가리킬 수 있어 전체를 거부했습니다 — 0 을 떼고 입력하세요(예: 010.20.30.41 → 10.20.30.41).');
            ipFatal = true;
          }
        }

        // 중복 제거 개수 — 토큰별 재확장 합계와 전체 확장 결과의 차이로 구한다(확장 로직 복제 없음).
        let rawCount = 0;
        for (const t of tokens) {
          rawCount += expandIpList(t).ips.length;
          if (rawCount > DEDUP_SCAN_CAP) { dedupScanCapped = true; break; }
        }
        stats.dedupRemoved = Math.max(0, rawCount - ips.length);
        // 중복은 조용히 접지 않는다 — count 를 준 경로만 알리고 '가장 흔한 사용 방식'(count 미입력)이
        // 무통지면, 6대를 붙여넣은 사람이 5대만 감시되는 상태를 오류·경고 0건으로 보게 된다.
        if (!ipFatal && stats.dedupRemoved > 0) {
          pushWarn(dedupScanCapped
            ? `중복 IP 가 제거되어 대상이 줄었습니다(정확한 건수는 계산 상한으로 생략) — 실제 대상은 ${ips.length}개입니다.`
            : `중복 IP ${stats.dedupRemoved}건이 제거되어 대상이 ${ips.length}개가 되었습니다${countGiven ? '' : '(개수를 비워 두면 이 IP 개수를 그대로 씁니다)'}.`);
        }

        for (const t of tokens) {
          if (!t.includes('/')) continue;
          const note = cidrNormalizeNote(t);
          if (note) pushWarn(note);
        }
      }
    }

    stats.ips = ips.length;
    if (ips.length) { stats.firstIp = ips[0]; stats.lastIp = ips[ips.length - 1]; }

    if (!ipFatal) {
      // .0/.255 는 경고만 — 자동으로 건너뛰면 그 뒤 이름↔IP 가 한 칸 밀린다.
      const edge = ips.filter((ip) => {
        const last = Number(ip.split('.')[3]);
        return last === 0 || last === 255;
      });
      if (edge.length) {
        pushWarn(`네트워크/브로드캐스트 주소 ${edge.length}건 포함(${edge.slice(0, 5).join(', ')}${edge.length > 5 ? ' …' : ''}) — 매핑이 밀리지 않게 건너뛰지 않았습니다. 필요하면 범위를 조정하세요.`);
      }
      // SSRF 가드 — 차단 IP 는 오류와 섞지 않고 blocked[] 로 분리한다(원인을 읽을 수 있게).
      for (const ip of ips) {
        const reason = validateEndpoint({ host: ip });
        if (reason) pushBlocked(ip, reason);
      }
      if (blockedTotal) {
        errors.push(`사용할 수 없는 IP ${blockedTotal}건이 범위에 있습니다(자세한 사유는 blocked 목록 — 상위 ${BLOCKED_CAP}건만) — 건너뛰면 매핑이 밀리므로 전체를 거부했습니다.`);
      }
    }

    // count 미입력이면 IP 개수를 그대로 쓴다(가장 흔한 사용 방식).
    if (!countGiven && !ipFatal) count = ips.length;
    // 개수 불일치는 오류·전체 거부. 절단·IP 재사용·빈 host 생성 전부 하지 않는다.
    if (countGiven && count !== null && !ipFatal && count !== ips.length) {
      const dupNote = stats.dedupRemoved > 0
        ? (dedupScanCapped ? ' (중복 IP 가 제거되어 IP 가 줄었습니다)' : ` (중복 ${stats.dedupRemoved}건 제거되어 IP 가 줄었습니다)`)
        : '';
      errors.push(`개수 불일치: 이름 ${count}개 vs IP ${ips.length}개${dupNote}. 개수를 맞추거나 IP 범위를 다시 입력하세요 — 부족분을 자동으로 연장하지 않습니다(늘린 IP 가 다른 팀 장비면 ok 로 떠서 '거짓 정상' 이 됩니다).`);
      // 제안은 **그대로 넣으면 통과하는 값**이어야 한다. 상한(2000)을 넘는 IP 개수를 제안하면
      // 사용자가 그 값을 적용해도 '1회 생성 상한 초과' 로 다시 rows 0 이 되어 막다른 길이 된다.
      if (ips.length >= 1 && ips.length <= MAX_GEN_ROWS) suggest = { count: ips.length };
      else if (ips.length > MAX_GEN_ROWS) {
        errors.push(`IP ${ips.length}개는 1회 생성 상한(${MAX_GEN_ROWS}개)보다 많습니다 — 개수를 맞추는 것으로는 해결되지 않으니 범위를 ${MAX_GEN_ROWS}개 이하로 나눠 여러 번 등록하세요.`);
      }
    }
  } else {
    domain = typeof hostSpec.domain === 'string' ? hostSpec.domain.trim() : '';
    if (!domain) errors.push("도메인을 입력하세요(예: '.sbp.local') — 이름만으로는 호스트가 되지 않습니다.");
    else if (!domain.startsWith('.')) errors.push(`도메인은 '.' 으로 시작해야 합니다(예: '.sbp.local'): ${domain.slice(0, 40)}`);
    else if (!SAFE_DOMAIN.test(domain) || domain.length > HOST_MAX) errors.push(`도메인 형식이 올바르지 않습니다: ${domain.slice(0, 40)}`);
    if (!countGiven) errors.push('개수를 입력하세요(호스트를 이름으로 만들 때는 IP 개수로 추론할 수 없습니다).');
  }

  /* ── 이름 길이 · 자리수 전이 (마지막 번호 기준) ── */
  if (pattern && start !== null && pad !== null && count !== null) {
    stats.names = count;
    if (count > 1 && !pattern.includes('{n}')) {
      errors.push(`이름 규칙에 {n} 을 넣으세요 — ${count}개를 만들려면 번호 자리가 필요합니다(예: 'lesasbpdp{n}').`);
    }
    const lastN = start + count - 1;
    const firstName = applyPattern(pattern, start, pad);
    const lastName = applyPattern(pattern, lastN, pad);
    stats.nameMaxLen = Math.max(firstName.length, lastName.length);
    if (stats.nameMaxLen > NAME_MAX) {
      // 잘라서 등록하면 119자 접두사 + '01'/'02' 가 둘 다 같은 이름으로 잘려 중복이 된다.
      errors.push(`이름 최종 길이 ${stats.nameMaxLen}자 > ${NAME_MAX}자 (마지막 번호 ${lastN} 기준) — 접두사를 줄이세요. 자르면 서로 다른 번호가 같은 이름이 됩니다.`);
    }
    if (pad > 0) {
      const limit = 10 ** pad;
      if (start < limit && lastN >= limit) {
        stats.padTransition = limit;
        pushWarn(`번호 ${limit} 부터 자리수가 ${pad}자를 넘습니다(… ${limit - 1} → ${limit}) — 트리 정렬이 문자열 비교라 자리수가 섞이면 순서가 흐트러집니다. pad 를 ${String(lastN).length} 로 올리는 것을 권합니다.`);
      }
    }
    if (count > MAX_GEN_ROWS) {
      // 상한은 행마다 오류를 넣지 않고 1건으로 보고한다(2,000행이면 응답이 수백 KB 가 된다).
      errors.push(`1회 생성 상한 초과: 대상 ${count}개 > ${MAX_GEN_ROWS}개 — 클램프하지 않으니 여러 번에 나눠 등록하세요.`);
    }
  }

  if (errors.length || blockedTotal) return out([]);

  /* ── 행 생성 ── */
  const rows = [];
  const hostErrs = [];
  for (let i = 0; i < count; i += 1) {
    const n = start + i;
    const name = applyPattern(pattern, n, pad);
    const host = mode === 'ips' ? ips[i] : `${name}${domain}`;
    if (mode === 'name') {
      if (host.length > HOST_MAX) hostErrs.push(`호스트가 ${HOST_MAX}자를 넘습니다: ${host.slice(0, 60)}…`);
      // 이름+도메인이 '숫자 4옥텟' 이 되는 경우도 있다('010.0.0'+'.1'). ips 경로와 같은 규칙으로 막는다.
      else if (nonCanonicalIp(host)) hostErrs.push(`${host}: IPv4 정규 표기만 허용합니다(옥텟 선행 0 금지 — 8진수로 해석될 수 있습니다).`);
      else {
        const reason = validateEndpoint({ host });
        // '차단' 은 blocked[] 로, 형식 오류는 errors 로 나눈다(원인이 다르다).
        if (reason && reason.includes('차단')) pushBlocked(host, reason);
        else if (reason) hostErrs.push(`${host}: ${reason}`);
      }
    }
    rows.push({ kind, path: treePath, name, host, enabled, tests: [] });
  }
  if (hostErrs.length) pushCapped(hostErrs);
  if (blockedTotal) errors.push(`사용할 수 없는 호스트 ${blockedTotal}건(자세한 사유는 blocked 목록 — 상위 ${BLOCKED_CAP}건만) — 전체를 거부했습니다.`);
  if (errors.length || blockedTotal) return out([]);

  /* ── 점검 채우기(선택) ── */
  if (typeof opts.materialize === 'function') {
    let total = 0;
    const overPerTarget = [];
    const testErrs = [];
    let checked = 0;
    for (const row of rows) {
      let tests;
      try { tests = opts.materialize(row); } catch (e) {
        errors.push(`점검 생성 실패(${row.name}): ${e?.message || e}`);
        break;
      }
      row.tests = Array.isArray(tests) ? tests : [];
      total += row.tests.length;
      // 대상당 점검 상한은 커밋(store.planBulkTargets)이 행마다 거부하는 조건이다. 여기서 보지
      // 않으면 '미리보기 통과 → 등록 전량 실패' 가 된다(atomic 이라 부분 등록도 없다).
      if (row.tests.length > LIMITS.maxTestsPerTarget) {
        overPerTarget.push(`${row.name}: 점검 ${row.tests.length}개 > 대상당 상한 ${LIMITS.maxTestsPerTarget}개`);
        continue;
      }
      // 값 자체도 커밋과 같은 정제 함수로 본다(유형·필수값·SSRF). 예산 안에서만 — 전수 검증은
      // 커밋이 하고, 여기서 40만 건을 돌리면 이벤트 루프가 0.5초 멈춘다.
      for (const t of row.tests) {
        if (checked >= TEST_CHECK_CAP) break;
        checked += 1;
        try { normalizeTest(t); } catch (e) {
          testErrs.push(`점검 값 오류(${row.name} · ${String(t?.name || t?.type || '이름없음').slice(0, 40)}): ${e?.message || e}`);
        }
      }
    }
    if (overPerTarget.length) pushCapped(overPerTarget);
    if (testErrs.length) pushCapped(testErrs, ` (앞 ${checked}개 점검만 검사)`);
    if (total > MAX_GEN_TESTS) {
      errors.push(`1회 생성 점검 상한 초과: ${total}개 > ${MAX_GEN_TESTS}개 — 대상 수나 점검 수를 줄이세요.`);
    }
  }

  return out(rows);
}
