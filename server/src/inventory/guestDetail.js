// inventory/guestDetail.js — VM 의 '실제 설치 OS' 1차 출처(VMware Tools 보고) · 어플라이언스 제품 정보 — 순수 파서 · 정제(v3.54 · 실제 OS 1단계).
//
// 왜: 화면의 OS 분류는 vCenter `summary.config.guestFullName`(사람이 VM 에 설정한 게스트 OS 유형)을 쓴다 — Rocky 를 깔고 유형을 'CentOS 7' 로
//   두면 CentOS 로 센다(docs/design/real-os/README.md §2). 게스트 계정 없이 '실제 설치 OS' 를 읽는 길은 VMware Tools 가 스스로 보고하는
//   `GuestInfo.guestDetailedData`(vSphere API 8.0.2.0+, Tools 11.2.0+)다. 한 번 기록되면 VM 이 꺼져도 마지막 값이 남는다(Broadcom API 문서).
//
// 모양(vm.gos — 없으면 이 수집기가 아직 읽지 않았다 = '미수집'. 0·빈 글자로 채우지 않는다):
//   { at, asked, detailed:{ prettyName, distroName, distroVersion, … }|null, extra:{키:값}|null, raw:string|null, vapp:{ name, vendor, version, fullVersion }|null }
//   - asked: 이 vCenter 에 guestDetailedData 를 **물었는가**(API 8.0.2 미만이면 묻지 않는다 — 묻지 않은 것을 'Tools 가 보고하지 않음' 으로 말하지 않는다).
//   - detailed: 아는 키만(DETAIL_KEYS). 보고가 없으면 null.
//   - extra: 문서에 없는 키(앞으로 Tools 가 더할 수 있다) — 이름·값 모두 상한. 점검 화면이 '모르는 키' 로 보여 준다.
//   - raw: 글자는 왔는데 아는 키를 하나도 못 읽었을 때만 원문(512자) — 형식이 문서와 다를 때 실측으로 고치기 위해서다. 평소에는 싣지 않는다(스냅샷 크기).
//   - vapp: OVF 로 배포된 어플라이언스의 제품 정보(config.vAppConfig.product 첫 항목 — 이름이나 제조사가 있는 것). appUrl·vendorUrl 은 주소라 싣지 않는다.
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

// 점검 2회차: 자른 자리가 서로게이트 쌍의 앞 반쪽이면 그 반쪽도 뺀다(짝 잃은 글자가 JSON · 화면에 남지 않게 — rack/layout.js · vmDist.js 와 같은 규칙).
const cap = (s, n) => {
  if (typeof s !== 'string') return null;
  let t = s.trim();
  if (t.length > n) {
    t = t.slice(0, n);
    const last = t.charCodeAt(t.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
    t = t.trimEnd();
  }
  return t || null;
};
const isKeyChar = (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

/**
 * "name='value' name='value' …" → { fields, extra, ok }. 값 안의 \' · \\ 는 역슬래시 이스케이프로 읽는다(open-vm-tools 가 그렇게 쓴다고
 * 보고 있으나 **실측 전 추정** — 1단계 점검이 원문을 모은다). 형식이 틀린 조각은 다음 공백까지 건너뛴다. 입력 길이에 선형.
 * @returns {{ fields: object, extra: object, ok: boolean } | null} 글자가 아니거나 비면 null
 */
export function parseGuestDetailedData(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.length > RAW_IN_MAX ? raw.slice(0, RAW_IN_MAX) : raw;
  if (!s.trim()) return null;
  const fields = {};
  const extra = {};
  let nExtra = 0;
  let ok = false;
  let knownKeys = 0;      // 점검 4회차: 아는 키를 형식대로 읽은 수(값이 비어도) — '형식은 맞고 값만 빈 보고' 를 '형식을 못 읽음' 과 가른다
  let extraDropped = 0;   // 점검 4회차: 모르는 키 상한(EXTRA_MAX)으로 버린 수 — 조용히 버리지 않는다
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
      if (i === ks) i += 1;
      while (i < n && !isSpace(s[i])) i += 1;
      continue;
    }
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
    if (!closed) break;   // 닫는 따옴표 없이 끝났다 — 잘린 값은 버린다(지어내지 않는다)
    const val = cap(parts.join(''), VALUE_MAX);
    if (DETAIL_SET.has(key)) {
      knownKeys += 1;
      if (val != null) { fields[key] = val; ok = true; }
    } else if (EXTRA_KEY_RE.test(key) && val != null && !Object.hasOwn(extra, key)) {
      if (nExtra < EXTRA_MAX) { extra[key] = cap(val, 128); nExtra += 1; } else extraDropped += 1;
    }
  }
  return { fields, extra, ok, knownKeys, extraDropped };
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

/** RetrieveProperties 결과(props) → vm.gos. */
export function parseVmGosProps(props = {}, at = Date.now(), { asked = false } = {}) {
  const p = props || {};
  const rawDetail = typeof p[DETAIL_PATH] === 'string' ? p[DETAIL_PATH] : null;
  const parsed = asked ? parseGuestDetailedData(rawDetail) : null;
  const hasExtra = parsed && Object.keys(parsed.extra).length > 0;
  // 점검 4회차: 아는 키를 형식대로 읽었는데 값이 모두 비었으면 '형식을 못 읽음'(파서 결함 · raw)이 아니라 '빈 값 보고' 다.
  const empty = !!parsed && !parsed.ok && parsed.knownKeys > 0;
  return {
    at,
    asked: !!asked,
    detailed: parsed?.ok ? parsed.fields : null,
    extra: hasExtra ? parsed.extra : null,
    raw: parsed && !parsed.ok && !empty ? cap(rawDetail, RAW_KEEP_MAX) : null,
    vapp: parseVappProduct(typeof p[VAPP_PATH] === 'string' ? p[VAPP_PATH] : ''),
    ...(empty ? { emptyValues: true } : {}),
    ...(parsed?.extraDropped ? { extraDropped: parsed.extraDropped } : {}),
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

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * 엣지가 보낸 vm.gos → 같은 모양으로 다시 좁힌다(아는 키만 · 글자만 · 상한). 엣지 시각은 수신 시각(now)보다 뒤일 수 없다.
 * 객체가 아니면 null(모름).
 */
export function sanitizeVmGos(g, now = Date.now()) {
  if (!isObj(g)) return null;
  const at = typeof g.at === 'number' && Number.isFinite(g.at) && g.at > 0 ? Math.min(g.at, now) : null;
  let detailed = null;
  if (isObj(g.detailed)) {
    const d = {};
    for (const k of DETAIL_KEYS) { const v = cap(g.detailed[k], VALUE_MAX); if (v != null) d[k] = v; }
    detailed = Object.keys(d).length ? d : null;
  }
  let extra = null;
  // 점검 4회차: 엣지가 보낸 버린 수(extraDropped — 정수 · 상한)에 여기서 상한으로 더 버린 수를 더한다(조용히 버리지 않는다).
  let extraDropped = Number.isSafeInteger(g.extraDropped) && g.extraDropped > 0 ? Math.min(g.extraDropped, 10_000) : 0;
  if (isObj(g.extra)) {
    const e = {};
    let n = 0;
    for (const k of Object.keys(g.extra).slice(0, 10_000)) {
      if (!EXTRA_KEY_RE.test(k) || DETAIL_SET.has(k)) continue;
      const v = cap(g.extra[k], 128);
      if (v == null) continue;
      if (n >= EXTRA_MAX) { extraDropped += 1; continue; }
      e[k] = v; n += 1;
    }
    extra = n ? e : null;
  }
  // 점검 1회차(반증 재현): 키별로 좁히기만 하면 수집기 파서(parseVmGosProps)가 지키는 묶음 불변조건이 엣지에서 깨진 채 들어온다 —
  //   묻지 않았으면(asked 가 참이 아니면) detailed · extra · raw 는 없고, detailed 가 있으면 raw 는 없다. 어긋나면 점검 집계가
  //   '보고 있음 > 물은 수' · '보고 있음이면서 형식 못 읽음' 으로 셌다.
  const asked = g.asked === true;
  if (!asked) { detailed = null; extra = null; extraDropped = 0; }
  const emptyValues = asked && !detailed && g.emptyValues === true;
  const vapp = isObj(g.vapp) ? {
    name: cap(g.vapp.name, 128), vendor: cap(g.vapp.vendor, 128), version: cap(g.vapp.version, 64), fullVersion: cap(g.vapp.fullVersion, 128),
  } : null;
  return {
    at,
    // 점검 2회차: 엣지 시각을 수신 시각으로 잘랐으면 원본은 따로 남긴다(루트 규약 '엣지 시각은 수신 시각으로 자르고 원본은 따로' — storpath 의 edgeAt 과 같은 이름).
    ...(typeof g.at === 'number' && Number.isFinite(g.at) && g.at > now ? { edgeAt: Math.trunc(g.at) } : {}),
    asked,
    detailed,
    extra,
    raw: asked && !detailed && !emptyValues ? cap(g.raw, RAW_KEEP_MAX) : null,
    vapp: vapp && (vapp.name || vapp.vendor) ? vapp : null,
    ...(emptyValues ? { emptyValues: true } : {}),
    ...(extraDropped ? { extraDropped } : {}),
  };
}
