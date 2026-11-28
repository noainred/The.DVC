// inventory/guestDetail.js — VM 의 '실제 설치 OS' 1차 출처(VMware Tools 보고) · 어플라이언스 제품 정보 — 순수 파서 · 정제(v3.54 · 실제 OS 1단계).
//
// 왜: 화면의 OS 분류는 vCenter `summary.config.guestFullName`(사람이 VM 에 설정한 게스트 OS 유형)을 쓴다 — Rocky 를 깔고 유형을 'CentOS 7' 로
//   두면 CentOS 로 센다(docs/design/real-os/README.md §2). 게스트 계정 없이 '실제 설치 OS' 를 읽는 길은 VMware Tools 가 스스로 보고하는
//   `GuestInfo.guestDetailedData`(vSphere API 8.0.2.0+, Tools 11.2.0+)다. 한 번 기록되면 VM 이 꺼져도 마지막 값이 남는다(Broadcom API 문서).
//
// 모양(vm.gos — 없으면 이 수집기가 아직 읽지 않았다 = '미수집'. 0·빈 글자로 채우지 않는다):
//   { at, asked, parse, detailed, extra, extraDropped?, raw, vapp, edgeAt? }
//   - asked: 이 vCenter 에 guestDetailedData 를 **물었는가**(API 8.0.2 미만 · 판 미상이면 묻지 않는다).
//   - parse: 보고를 읽은 결과 **한 값**(점검 5회차 구조 재설계 — 그 전에는 raw · emptyValues · extra 를 따로 맞추다 서로 어긋났다):
//       null       보고 없음(묻지 않았거나 Tools 가 글자를 보내지 않음)
//       'ok'       아는 키를 읽었고 형식 밖 조각이 없다
//       'partial'  아는 키를 읽었지만 형식 밖 조각 · 잘린 값이 있다(detailed 와 raw 둘 다)
//       'empty'    형식대로 읽었는데 아는 키의 값이 모두 비었다
//       'malformed' 아는 키를 하나도 읽지 못했다(raw)
//   - detailed: 아는 키만(DETAIL_KEYS) — parse 가 'ok' · 'partial' 일 때만.
//   - extra: 문서에 없는 키(이름 · 값 상한) · extraDropped: 상한 · 이름 형식으로 버린 모르는 키 수(조용히 버리지 않는다).
//   - raw: parse 가 'partial' · 'malformed' 일 때만 원문(512자) — 형식이 문서와 다를 때 실측으로 고치기 위해서다(정상 보고는 싣지 않는다 — 스냅샷 크기).
//   - vapp: OVF 로 배포된 어플라이언스의 제품 정보(config.vAppConfig.product 첫 항목 — 이름이나 제조사가 있는 것). appUrl·vendorUrl 은 주소라 싣지 않는다.
//   이 묶음 규칙은 **normalizeGos 하나**가 세운다 — 수집기(parseVmGosProps)와 엣지 수신 정제(sanitizeVmGos)가 둘 다 이 함수를 지난다.
//
// 외부 입력(장비 출력)이라 정규식에 넣기 전에 길이를 자르고, 키=값 목록은 정규식이 아니라 한 번 훑는 스캐너로 읽는다(루트 CLAUDE.md '정규식' 규약).
import { xmlUnescape } from '../vcenter/soapParse.js';

/** guestDetailedData 가 생긴 vSphere API 판 — 이 요청만 SOAPAction 을 이 판으로 보낸다(포탈 기본은 8.0.0.1 — vcenter/soapClient.js). */
export const GOS_SOAP_VERSION = '8.0.2.0';
const DETAIL_PATH = 'guest.guestDetailedData';
const VAPP_PATH = 'config.vAppConfig.product';

/** Broadcom API 문서(GuestInfo.guestDetailedData)가 밝힌 키. 그 밖의 키는 extra 로. */
export const DETAIL_KEYS = Object.freeze([
  'architecture', 'bitness', 'buildNumber', 'cpeString', 'distroAddlVersion', 'distroName', 'distroVersion',
  'familyName', 'kernelVersion', 'prettyName',
]);
const DETAIL_SET = new Set(DETAIL_KEYS);
const RAW_IN_MAX = 4096;      // 스캔 전에 자르는 입력 상한(실제 값은 수백 자)
const VALUE_MAX = 256;
const RAW_KEEP_MAX = 512;
const EXTRA_MAX = 8;
const EXTRA_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const VAPP_IN_MAX = 16_384;
const VAPP_ITEMS_MAX = 8;

/**
 * 글자 위생 한 벌(점검 5회차 — 2회차 수정은 자른 자리만 봐서 입력에 원래 있던 짝 잃은 서로게이트가 엣지 정제 · XML 문자 참조로 그대로 지나갔다).
 * ① 짝 잃은 서로게이트는 U+FFFD 로(toWellFormed — inventory/vmDist.js 와 같은 방식) ② 앞뒤 공백 ③ 상한으로 자른 자리가 쌍의 앞 반쪽이면 그것도 뺀다.
 * 비면 null. 이 모듈의 모든 글자 칸이 이 함수를 지난다.
 */
export function cleanText(s, n) {
  if (typeof s !== 'string') return null;
  let t = (s.isWellFormed() ? s : s.toWellFormed()).trim();
  if (t.length > n) {
    t = t.slice(0, n);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
    t = t.trimEnd();
  }
  return t || null;
}
const cap = cleanText;
const isKeyChar = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * "name='value' name='value' …" → { fields, extra, ok, knownKeys, extraDropped, skipped, truncated }. 값 안의 \' · \\ 는 역슬래시 이스케이프로 읽는다
 * (open-vm-tools 가 그렇게 쓴다고 보고 있으나 **실측 전 추정** — 1단계 점검이 원문을 모은다). 형식이 틀린 조각은 다음 공백까지 건너뛰고 **센다**(skipped).
 * 닫는 따옴표 없이 끝났거나 입력이 상한보다 길었으면 truncated. 입력 길이에 선형. 판정(ok/partial/empty/malformed)은 outcomeOf.
 * @returns 글자가 아니거나 비면 null
 */
export function parseGuestDetailedData(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.length > RAW_IN_MAX ? raw.slice(0, RAW_IN_MAX) : raw;
  if (!s.trim()) return null;
  const fields = {};
  const extra = {};
  let nExtra = 0;
  let ok = false;
  let knownKeys = 0;      // 아는 키를 형식대로 읽은 수(값이 비어도)
  let extraDropped = 0;   // 모르는 키 상한 · 이름 형식으로 버린 수
  let skipped = 0;        // 형식 밖 조각 수
  let dups = 0;           // 같은 아는 키가 다시 나온 수(점검 6 · 7회차 — 값이 있는 첫 값으로 정하고 흔적은 partial · raw 로 남긴다)
  const seenKnown = new Set();
  let truncated = raw.length > RAW_IN_MAX;
  let tailFragment = null;   // 입력 끝까지 이어진 형식 밖 조각(있으면)
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(s[i])) i += 1;
    if (i >= n) break;
    const ks = i;
    while (i < n && isKeyChar(s.charCodeAt(i))) i += 1;
    const key = s.slice(ks, i);
    if (!key || s[i] !== '=' || s[i + 1] !== "'") {
      // 형식 밖 조각 — 다음 공백까지 건너뛴다(최소 한 글자는 전진).
      skipped += 1;
      if (i === ks) i += 1;
      while (i < n && !isSpace(s[i])) i += 1;
      // 9회차: 입력 끝까지 이어진 조각은 따로 알린다 — 잘린 원문에서는 이 조각이 잘림 흔적일 수 있다(oldEdgeOutcome 이 판정).
      tailFragment = i >= n ? s.slice(ks, n) : null;
      continue;
    }
    tailFragment = null;
    i += 2;
    const parts = [];
    let segStart = i;
    let closed = false;
    while (i < n) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < n) { parts.push(s.slice(segStart, i), s[i + 1]); i += 2; segStart = i; continue; }
      if (ch === "'") { parts.push(s.slice(segStart, i)); i += 1; closed = true; break; }
      i += 1;
    }
    if (!closed) { truncated = true; break; }   // 닫는 따옴표 없이 끝났다 — 잘린 값은 버린다(지어내지 않는다)
    const val = cap(parts.join(''), VALUE_MAX);
    if (DETAIL_SET.has(key)) {
      if (seenKnown.has(key)) {
        dups += 1;
        // 7회차: 처음 값이 비었으면 뒤의 값이 있는 것으로 채운다(예전에는 빈 첫 값으로 고정해 실제 OS 이름을 버리고 malformed 로 셌다).
        if (val != null && fields[key] == null) { fields[key] = val; ok = true; }
        continue;
      }
      seenKnown.add(key);
      knownKeys += 1;
      if (val != null) { fields[key] = val; ok = true; }
    } else if (val != null && !Object.hasOwn(extra, key)) {
      if (EXTRA_KEY_RE.test(key) && nExtra < EXTRA_MAX) { extra[key] = cap(val, 128); nExtra += 1; } else extraDropped += 1;
    }
  }
  return { fields, extra, ok, knownKeys, extraDropped, skipped, dups, truncated, tailFragment };
}

/** 보고를 읽은 결과의 종류(모듈 머리말 parse 참고). */
export const PARSE_OUTCOMES = Object.freeze(['ok', 'partial', 'empty', 'malformed']);
const PARSE_SET = new Set(PARSE_OUTCOMES);
/** parseGuestDetailedData 결과 → parse 값. null 이면 보고 없음. */
export function outcomeOf(p) {
  if (!p) return null;
  // 형식이 깨끗한가(형식 밖 조각 · 잘림 없음). 같은 키 중복은 형식 문제가 아니라 이상 징후 — 값이 있으면 partial(원문을 남긴다), 값이 모두 비면 empty.
  const clean = p.skipped === 0 && !p.truncated;
  if (p.ok) return clean && !p.dups ? 'ok' : 'partial';
  if (p.knownKeys > 0 && clean) return 'empty';
  return 'malformed';
}

/** 'config.vAppConfig.product' 원문 XML(ArrayOfVAppProductInfo) → 첫 제품(이름이나 제조사가 있는 것). 없으면 null. */
export function parseVappProduct(xml) {
  if (typeof xml !== 'string' || !xml) return null;
  const s = xml.length > VAPP_IN_MAX ? xml.slice(0, VAPP_IN_MAX) : xml;
  const tag = (blk, name) => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(blk);
    return m ? xmlUnescape(m[1]) : null;
  };
  const blocks = s.split(/<VAppProductInfo(?=[\s>])/).slice(1, 1 + VAPP_ITEMS_MAX);
  for (const blk of blocks) {
    const name = cap(tag(blk, 'name'), 128);
    const vendor = cap(tag(blk, 'vendor'), 128);
    if (!name && !vendor) continue;
    return { name, vendor, version: cap(tag(blk, 'version'), 64), fullVersion: cap(tag(blk, 'fullVersion'), 128) };
  }
  return null;
}

/** vCenter about.apiVersion('8.0.3.0') 이 guestDetailedData 를 아는 판(8.0.2 이상)인가. 못 읽으면 false(묻지 않는다). */
export function detailedApiOk(apiVersion) {
  if (typeof apiVersion !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})(?:\.(\d{1,3}))?/.exec(apiVersion.trim());
  if (!m) return false;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (a !== 8) return a > 8;
  return b > 0 || c >= 2;
}

/** 이 vCenter 에 요청할 경로 — 어플라이언스 제품 정보는 어느 판이든, Tools 보고는 8.0.2 이상만(없는 속성은 요청 전체를 InvalidProperty 로 만든다). */
export function gosPaths(asked) { return asked ? [DETAIL_PATH, VAPP_PATH] : [VAPP_PATH]; }

/** RetrieveProperties 결과(props) → vm.gos(normalizeGos 를 지난다). */
export function parseVmGosProps(props = {}, at = Date.now(), { asked = false } = {}) {
  const p = props || {};
  const rawDetail = typeof p[DETAIL_PATH] === 'string' ? p[DETAIL_PATH] : null;
  const parsed = asked ? parseGuestDetailedData(rawDetail) : null;
  return normalizeGos({
    at, asked: !!asked, parse: outcomeOf(parsed),
    detailed: parsed?.ok ? parsed.fields : null,
    extra: parsed && Object.keys(parsed.extra).length ? parsed.extra : null,
    extraDropped: parsed?.extraDropped || 0,
    raw: rawDetail,
    vapp: parseVappProduct(typeof p[VAPP_PATH] === 'string' ? p[VAPP_PATH] : ''),
  });
}

/**
 * vm.gos 묶음 규칙을 세우는 **하나뿐인** 함수 — 수집기 출력과 엣지가 보낸 값(이미 칸별로 좁힌 것)이 모두 이 모양으로 나간다.
 *   묻지 않았으면 parse · detailed · extra · raw · extraDropped 없음 · detailed 가 있으면 parse 는 ok 또는 partial ·
 *   detailed 가 없으면 ok · partial 일 수 없다(raw 가 있으면 malformed, 없으면 보고 없음) · raw 는 partial · malformed 일 때만.
 */
export function normalizeGos({ at = null, edgeAt = null, asked = false, parse = null, detailed = null, extra = null, extraDropped = 0, raw = null, vapp = null } = {}) {
  const a = asked === true;
  const d = a && detailed && typeof detailed === 'object' && Object.keys(detailed).length ? detailed : null;
  const r0 = a ? cap(raw, RAW_KEEP_MAX) : null;
  let p = a && PARSE_SET.has(parse) ? parse : null;
  // partial 은 근거 원문(raw)이 있을 때만 — 엣지가 원문 없이 partial 이라 하면 ok 로 낮춘다(점검 6회차: 화면에 '일부만 읽음' 이 세어지는데 원문 목록은 비었다).
  // 7회차: malformed 도 원문이 있을 때만(엣지가 원문 없이 malformed 라 하면 보고 없음) — partial 과 같은 규칙. 화면 '형식 못 읽음 N건' 과 원문 목록이 어긋나지 않게.
  if (d) { p = p === 'partial' && r0 ? 'partial' : 'ok'; } else if (p === 'ok' || p === 'partial' || p === 'malformed') p = r0 ? 'malformed' : null;
  if (a && !d && p == null && r0) p = 'malformed';
  const e = a && extra && typeof extra === 'object' && Object.keys(extra).length ? extra : null;
  const drop = a && Number.isSafeInteger(extraDropped) && extraDropped > 0 ? extraDropped : 0;
  return {
    at,
    ...(edgeAt != null ? { edgeAt } : {}),
    asked: a,
    parse: p,
    detailed: d,
    extra: e,
    ...(drop ? { extraDropped: drop } : {}),
    raw: p === 'partial' || p === 'malformed' ? r0 : null,
    vapp: vapp && (vapp.name || vapp.vendor) ? vapp : null,
  };
}

/**
 * VMware Tools 판 숫자(guest.toolsVersion — major<<10 | minor<<5 | patch) → { major, minor, patch }. 못 읽으면 null.
 * 2147483647(MAX_INT)은 '게스트가 관리하는 Tools — 판을 알리지 않음' 이라 null(모름)이다.
 */
export function toolsVersionParts(v) {
  const s = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,10}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  if (!Number.isSafeInteger(s) || s <= 0 || s >= 2147483647) return null;
  return { major: s >> 10, minor: (s >> 5) & 31, patch: s & 31 };
}

/** Tools 판이 major.minor 이상인가 — 판을 모르면 null(참·거짓으로 단정하지 않는다). */
export function toolsAtLeast(v, major, minor = 0) {
  const t = toolsVersionParts(v);
  if (!t) return null;
  return t.major > major || (t.major === major && t.minor >= minor);
}

/* ------------------------- 엣지 수신 정제(routes/central.js sanitizeInventoryList) ------------------------- */

/**
 * 옛 엣지(3.54 ~ 3.58 — parse 칸 없음)의 raw 를 다시 판정한다(점검 6 · 7회차 호환). 옛 엣지는 **아는 키의 값을 하나도 못 읽었을 때만** raw 를 보냈고
 * 512자로 잘랐다 — 그래서 형식 밖 조각 없이 아는 키만 있었다면 원래 보고는 '값이 모두 빈' 보고다(끝이 잘려 닫는 따옴표가 없어도 — 7회차 재현).
 */
function oldEdgeOutcome(raw) {
  // 9회차(8회차 꼬리 떼기가 온전한 마지막 토큰까지 버림 — 재현): 추측으로 꼬리를 떼지 않고 **파서가 알린 끝 조각**만 본다.
  //   원문이 512자에 닿았을 때만 잘림이 있을 수 있다 — 그때 ① 따옴표 안에서 끝났으면(truncated) 잘림 흔적이고
  //   ② 입력 끝까지 이어진 형식 밖 조각은 **올바른 토큰의 앞부분일 수 있을 때만**(key · key= · key=' …) 잘림 흔적이다.
  //   'kernelVersion==bad' 처럼 어떤 토큰의 앞부분도 될 수 없는 조각은 원래 형식 밖이다(malformed 그대로).
  //   한계: 원래 보고가 정확히 512자에서 그런 앞부분 모양으로 끝났다면 잘림과 가를 수 없다(드묾 — 추정).
  //   10회차(재현): 옛 **중앙**(3.54)은 저장할 때 원문 끝 공백을 다듬어(trim) 512자 잘림이 511자 이하로 남을 수 있다 — 그래서 '따옴표 안에서 끝남'(truncated)은
  //   길이와 무관하게 잘림 흔적으로 본다. 가정(추정): Tools 는 값의 따옴표를 닫는다 — 끝의 열린 따옴표는 잘림이 만든다.
  const body = raw.slice(0, RAW_KEEP_MAX);
  const p = parseGuestDetailedData(body);
  if (!p) return null;
  const atLimit = raw.length >= RAW_KEEP_MAX;
  const tailIsCut = atLimit && p.tailFragment != null && isTokenPrefix(p.tailFragment);
  const skipped = p.skipped - (tailIsCut ? 1 : 0);
  const truncated = false;
  // 옛 엣지 raw 에 값이 있는 아는 키가 있을 수 없다 — 있으면 모양이 어긋난 것(malformed).
  return !p.ok && p.knownKeys > 0 && skipped === 0 && !truncated ? 'empty' : 'malformed';
}
/** 'key' · 'key=' · "key='…" 처럼 올바른 토큰의 앞부분일 수 있는 조각인가(키 글자 뒤 '=' 뒤에는 따옴표만). */
function isTokenPrefix(frag) {
  let i = 0;
  while (i < frag.length && isKeyChar(frag.charCodeAt(i))) i += 1;
  if (i === frag.length) return i > 0;
  if (frag[i] !== '=' || i === 0) return false;
  return i + 1 === frag.length || frag[i + 1] === "'";
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
/** 이어받을 edgeAt — 양의 정수 · 결과 at 보다 뒤 · now + 10년 이하. 아니면 null. */
function carriedEdgeAt(v, at, now) {
  const e = numOf(v);
  if (e == null || !(e > 0)) return null;
  const t = Math.trunc(e);
  return at != null && t > at && t <= now + 10 * 365 * 86_400_000 ? t : null;
}
/** 수 · 숫자 글자 → 유한한 수, 그 밖은 null(못 읽음 — 0 이 아니다). */
const numOf = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*\d{1,16}(?:\.\d{1,6})?\s*$/.test(v)) return Number(v);
  return null;
};

/**
 * 엣지가 보낸 vm.gos → 같은 모양으로 다시 좁힌다(아는 키만 · 글자만 · 상한). 엣지 시각은 수신 시각(now)보다 뒤일 수 없다.
 * 객체가 아니면 null(모름).
 */
export function sanitizeVmGos(g, now = Date.now()) {
  if (!isObj(g)) return null;
  // 9회차: 수집기 출력은 늘 asked(불리언)를 싣는다 — 그것이 없는 객체({junk:1} · {})는 모양이 틀린 값이라 '묻지 않음' 으로 지어내지 않고 null(모름 · 중앙 coerced).
  if (typeof g.asked !== 'boolean') return null;
  // 9회차(루트 규칙 '문자열 수치는 수로'): 숫자 글자도 받는다.
  const atN = numOf(g.at);
  const at = atN != null && atN > 0 ? Math.min(atN, now) : null;
  let detailed = null;
  if (isObj(g.detailed)) {
    const d = {};
    for (const k of DETAIL_KEYS) { const v = cap(g.detailed[k], VALUE_MAX); if (v != null) d[k] = v; }
    detailed = Object.keys(d).length ? d : null;
  }
  // 엣지가 보낸 버린 수(정수 · 상한)에 여기서 상한 · 이름 형식으로 더 버린 수를 더한다(조용히 버리지 않는다).
  const dropN = numOf(g.extraDropped);
  let extraDropped = Number.isSafeInteger(dropN) && dropN > 0 ? Math.min(dropN, 10_000) : 0;
  let extra = null;
  if (isObj(g.extra)) {
    const e = {};
    let n = 0;
    for (const k of Object.keys(g.extra).slice(0, 10_000)) {
      if (DETAIL_SET.has(k)) continue;
      const v = cap(g.extra[k], 128);
      if (v == null) continue;
      if (!EXTRA_KEY_RE.test(k) || n >= EXTRA_MAX) { extraDropped += 1; continue; }
      e[k] = v; n += 1;
    }
    extra = n ? e : null;
  }
  const vapp = isObj(g.vapp) ? {
    name: cap(g.vapp.name, 128), vendor: cap(g.vapp.vendor, 128), version: cap(g.vapp.version, 64), fullVersion: cap(g.vapp.fullVersion, 128),
  } : null;
  // 묶음 규칙(asked · parse · detailed · raw)은 수집기와 같은 normalizeGos 가 세운다. 엣지 시각을 수신 시각으로 잘랐으면 원본은 edgeAt 으로 따로.
  return normalizeGos({
    at,
    // 10회차(재현): 이미 정제한 값을 다시 정제할 때(중앙 기동 · 재읽기 — central/inventory.js parseInventoryFile) 저장돼 있던 원본 시각을 이어받는다 —
    //   예전에는 잘린 at 만 보고 다시 계산해 edgeAt 이 지워졌다(고정점이 아니었다). 이어받는 값은 결과 at 보다 뒤 · 수신 시각 + 10년 이하만.
    edgeAt: atN != null && atN > now ? Math.trunc(atN) : carriedEdgeAt(g.edgeAt, atN != null && atN > 0 ? Math.min(atN, now) : null, now),
    asked: g.asked === true,
    // 점검 6회차(호환): 이미 릴리스된 엣지(3.54 ~ 3.58)는 parse 칸 없이 '아는 키를 못 읽은 원문' 을 raw 로 보낸다(값만 빈 보고 포함).
    //   parse 가 없고 detailed 도 없으면 원문을 같은 파서로 다시 판정한다(원문은 512자 상한 — 비용이 작다). 옛 엣지의 partial 은 원문이 오지 않아 되살릴 수 없다(ok 로 남는다).
    parse: typeof g.parse === 'string' ? g.parse : (!detailed && typeof g.raw === 'string' && g.asked === true ? oldEdgeOutcome(g.raw) : null),
    detailed, extra, extraDropped,
    raw: typeof g.raw === 'string' ? g.raw : null,
    vapp,
  });
}
