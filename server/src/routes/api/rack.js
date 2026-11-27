/**
 * routes/api/rack.js — 특수 기능 '랙 실장도'(도구 키 `rack` · 설계 docs/design/rack-elevation/README.md · 1차 = 원장 + 조회 + 편집 + 엑셀 내보내기).
 *
 * ── 권한 ───────────────────────────────────────────────────────────────────
 *  · 조회: `tools` + 도구 접근(`rack` — toolGate) + **법인 범위**. 법인(DataCenter)은 그 법인에 할당된 vCenter 중 하나라도 조회 범위에 있으면 보인다
 *    (`collectorsDc.js scopedDatacenterView` 와 같은 판정). 할당 vCenter 가 없는 법인은 범위 계정에 보이지 않는다('귀속 없는 데이터 미노출').
 *    범위 밖 전산실 · 법인은 **404**(존재 은닉).
 *  · 편집: **관리자만**(2026-11-20 사용자 결정 '관리자만 편집') — `requireRole('admin')` + 데모 계정 아님(`isAdminDetailUser`) +
 *    그 법인의 할당 vCenter 가 **모두** 쓰기 범위 안(조회 밖 404 → 쓰기 밖 403). 할당 vCenter 가 없는 법인은 전체 범위(조회 ∧ 쓰기) 관리자만.
 *  · 랙 종류(전 법인 공용 목록): 조회 ∧ 쓰기 전체 범위 관리자만(`isFullReadWriteScope`).
 *  · 연결 정보(iDRAC): 서버만 서비스 태그로 잇는다(2026-11-19 사용자 결정). 서버 목록은 범위로 먼저 자른다(`scopeIdracServers`).
 *    관리 주소는 관리자 판본에만(IP 로 등록한 서버의 id · 이름도 비관리자에게는 가린다 — 다른 iDRAC 화면과 같은 addressMatcher).
 *    시리얼(서비스 태그)은 관리자 또는 전체(조회) 범위 계정에게만(2026-11-20 사용자 결정 — rack/CLAUDE.md) — 범위 비관리자에게는 싣지 않고
 *    이름 · 호스트 이름에 든 태그도 걷어 낸다(stripTag). ⚠ 물리서버 폴더는 범위 관리자에게도 태그를 숨긴다 — 랙은 관리자가 원장을 편집하므로
 *    관리자에게는 보인다(점검 C26: 예전 주석의 '폴더와 같은 기준' 은 틀린 말이었다).
 *  · 엑셀 내보내기: `data.csv` 권한 + 조회와 같은 범위.
 * ── 동시 편집 ──────────────────────────────────────────────────────────────
 *  · 전산실 단위 쓰기(랙 · 장비)는 본문 `rev` 가 지금 판과 같을 때만 반영한다 — 아니면 409 `revConflict` + 지금 rev(조용히 덮어쓰지 않는다).
 * ⚠ 폴링하지 않는다 — 화면은 열 때 1회 + 새로 고침 + 쓰기 뒤 재조회. 응답 캐시는 두지 않는다(원장이 쓰기마다 바뀌고 조회가 가볍다).
 */
import ExcelJS from 'exceljs';
import { requirePerm, requireRole } from '../../auth/auth.js';
import { isAdminDetailUser } from '../../auth/demoGuest.js';
import { scopedVcenterIds, writeScopedVcenterIds, isFullReadWriteScope } from '../../auth/scope.js';
import { listDatacenters, getDatacenterAssign } from '../../datacenter/store.js';
import { store } from '../../store.js';
import { logAudit } from '../../audit.js';
import { clientIp } from '../../util/rateLimit.js';
import { analysisServersWithRemote, invForServer } from '../../insights/analysisServers.js';
import { scopeIdracServers } from '../admin/idracCore.js';
import { hwSummaryOf, mgmtHostOf } from '../../idrac/hwSummary.js';
import { partHealthRollup } from '../../idrac/invView.js';
import { cleanText, cleanPlaceInput, cleanRackInput, intIn, rackTotals, serialKeyOf, dropInvisible, LIMITS, KIND_LABEL } from '../../rack/layout.js';
import * as R from '../../rack/db.js';
import { VERSION_KEEP } from '../../rack/versions.js';
import { acquireExport } from '../../util/exportBusy.js';
import { addressMatcher, hostVariants, maskedIdToken, MASK_TOKEN_PREFIX } from '../../auth/addressMask.js';
import { tagIndexOf, stripTags, needleIndexOf, replaceNeedles, charKind } from '../../rack/textMask.js';
import { todayStamp } from '../../util/dayKey.js';
import { isIPv6 } from 'node:net';
import { isPlaceholderTag } from '../../bmusage/commonTag.js';

const toolsPerm = requirePerm('tools');
const csvPerm = requirePerm('data.csv');
const adminRole = requireRole('admin');
const userOf = (req) => req.user?.username || 'anonymous';
const audit = (req, action, target, detail = '') => logAudit({ user: userOf(req), action, target, detail, ip: clientIp(req) });
const ID_RE = /^[a-f0-9]{16}$/;
const isId = (v) => typeof v === 'string' && ID_RE.test(v);

// ───────────────────────── 범위(법인) ─────────────────────────

/** 법인 → 할당 vCenter 목록. */
function corpVcenters() {
  const out = new Map();
  for (const [vc, dc] of Object.entries(getDatacenterAssign() || {})) {
    const d = String(dc || ''); if (!d) continue;
    if (!out.has(d)) out.set(d, []);
    out.get(d).push(String(vc));
  }
  return out;
}

/**
 * 이 사용자가 보는 · 고칠 수 있는 법인(순수에 가깝게 — 입력은 스냅샷 · 할당표).
 * @returns {{ read: Set<string>|null, write: Set<string>|null, isAdmin: boolean }}  null = 전부
 */
export function corpAccessOf(user, snap, vcOfCorp = corpVcenters()) {
  const rset = scopedVcenterIds(user, snap);
  const wset = writeScopedVcenterIds(user, snap);
  const isAdmin = isAdminDetailUser(user);
  let read = null;
  if (rset) {
    read = new Set();
    for (const [corp, vcs] of vcOfCorp) if (vcs.some((v) => rset.has(v))) read.add(corp);
  }
  let write = null;
  if (!isAdmin) write = new Set();
  else if (wset) {
    write = new Set();
    for (const [corp, vcs] of vcOfCorp) if (vcs.length && vcs.every((v) => wset.has(v)) && (!read || read.has(corp))) write.add(corp);
  }
  return { read, write, isAdmin };
}
const canRead = (acc, corp) => !acc.read || acc.read.has(corp);
const canWrite = (acc, corp) => acc.isAdmin && (!acc.write || acc.write.has(corp));
const accessOf = (req) => corpAccessOf(req.user, store.get());
/** 시리얼을 보여 줄 수 있는가 — 전체(조회) 범위 계정 또는 관리자. */
const serialsVisible = (req) => isAdminDetailUser(req.user) || !scopedVcenterIds(req.user, store.get());

function sendErr(res, e) {
  if (e instanceof R.RackError) return res.status(e.status).json({ ok: false, reason: e.reason, ...e.extra });
  console.error('[rack] 처리 실패:', e?.message);
  return res.status(500).json({ ok: false, reason: '처리하지 못했습니다(서버 오류).' });
}

// ───────────────────────── 연결(서버 — 서비스 태그) ─────────────────────────

/**
 * 식별자로 쓸 수 있는 서비스 태그 · 시리얼인가 — 자리표시 값('To Be Filled By O.E.M.' · 'None' · '0000000' · 영숫자 4자 미만 — `bmusage/commonTag.js isPlaceholderTag` ·
 * 다른 기능이 '서비스 태그를 열쇠로 써도 되는가' 에 쓰는 그 판정)이 아니어야 한다. **가림 재료**(2회차 반증 C2 — 'phone-01 none' 이 지워졌다)와 **연결 키**(corpServers)가 같이 쓴다.
 * 그 판정은 ASCII 영숫자만 남겨서 보므로 **비 ASCII 글자 · 숫자가 든 값은 자리표시로 보지 않는다**(4회차 점검 보안 1 · 정확성 2: 시리얼 '자산1234' · '본사-0000' 이
 * '1234' · '0000' 으로 읽혀 가림 재료에서 빠졌다). 예외는 **호환 정규화(NFKC) 뒤에도 남는 글자 · 숫자**에만 준다 — 전각('Ｎｏｎｅ' · '０００００００') · NBSP 가 낀
 * 'Default string' · 기호가 낀 값은 그 판정이 이미 자리표시로 잡는 변형이다(4회차 반증 B-2 · C-2: 그런 값이 진짜 태그가 되어 'spare default string unit' 이 지워졌다).
 */
const NON_ASCII_WORD = /(?![\u0000-\u007f])[\p{L}\p{N}]/u;
const NON_ASCII = { test: (t) => NON_ASCII_WORD.test(t.normalize('NFKC')) };
// 판정은 글자만으로 정해진다 — 같은 태그를 요청마다 다시 판정하지 않는다(범위 계정 요청 하나에 태그 2만여 개 · 약 10ms 실측 — 4회차 점검 성능). 상한을 넘으면 통째로 비운다.
const TAG_OK = new Map(); const TAG_OK_MAX = 200_000; const TAG_OK_KEY_MAX = 64;
export const usableTag = (t) => {
  if (typeof t !== 'string' || !t) return false;
  // 긴 값은 기억하지 않는다 — 엣지가 올린 과대 serviceTag 는 잘린 문자열이 원문(수십 KB)을 붙든 채 키가 되어 Map 이 그 원문을 놓지 않았다
  //   (5회차 점검 성능 2 재현: 서버 1,000대 × 50KB 태그가 수집마다 다르면 5회에 239MB). 진짜 태그는 이보다 훨씬 짧다(가림 색인의 키 상한도 64).
  if (t.length > TAG_OK_KEY_MAX) return NON_ASCII.test(t) || !isPlaceholderTag(t);
  let ok = TAG_OK.get(t);
  if (ok === undefined) { ok = NON_ASCII.test(t) || !isPlaceholderTag(t); if (TAG_OK.size >= TAG_OK_MAX) TAG_OK.clear(); TAG_OK.set(t, ok); }
  return ok;
};

// 가림 재료도 판정 대상 글과 **같은 눈으로** 본다 — 글에서만 보이지 않는 글자를 지우면, 그런 글자가 시리얼과 이름 양쪽에 든 옛 값이 서로 어긋나 가려지지 않았다(5회차 점검 정확성 1 · 재현).
const cleanTag = (t) => (typeof t === 'string' ? dropInvisible(t).trim() : t);

export const UNPLACED_MAX = 2000;   // 미배치 서버 목록에 싣는 최대 대수(법인 하나) — 넘으면 unplacedTotal 이 더 크고 화면이 밝힌다
const HEALTH = { ok: 'ok', warning: 'warn', critical: 'crit' };
const healthOf = (v) => HEALTH[String(v || '').toLowerCase()] || (v ? 'unknown' : '');

/**
 * 그 법인의 서버(범위로 먼저 자름) — 서비스 태그 키 → 서버.
 * `invTags` = 가림 재료에 **범위 밖 서버의 인벤토리 태그**도 넣는다(시리얼을 가리는 판본만 켠다 — 2회차 반증 B-1: 등록부 태그 칸이 비고 인벤토리에서만 읽힌
 *   범위 밖 서버의 태그가 다른 장비 이름에 적혀 있으면 원문으로 나갔다). 인벤토리 조회는 메모리 캐시 한 번이다(`invCache.getInventory`).
 */
function corpServers(req, corpId, { invTags = false } = {}) {
  const assign = getDatacenterAssign() || {};
  const all = analysisServersWithRemote({ user: req.user, query: {} });
  // 가림 재료(주소 · 태그)는 **범위로 자르기 전** 등록부 전체에서 모은다(2회차 점검 1 — 원장은 법인 단위로 보이는데 재료를 조회자 범위 안 서버로만 만들면,
  //   같은 법인의 다른 vCenter 서버 · 귀속 없는 베어메탈의 관리 주소가 든 표시 이름이 범위 계정에게만 원문으로 나갔다). 연결 · 미배치 목록은 지금처럼 범위로 자른다.
  const hosts = []; const allTags = [];
  for (const s of all) {
    if (typeof s.host === 'string' && s.host) hosts.push(s.host);
    // host 없이 올라온 원격 서버는 id 가 관리 주소일 수 있다(2회차 점검 6) — 주소처럼 보이는 id(점 · 콜론이 든 것)만 넣는다.
    //   서비스 태그 같은 id 까지 '주소' 로 넣으면 시리얼을 볼 수 있는 계정에게도 그 태그가 가려진다(3회차 점검 5).
    else if (s.id != null && /[.:]/.test(String(s.id))) hosts.push(String(s.id));
    if (typeof s.serviceTag === 'string' && s.serviceTag) allTags.push(s.serviceTag);
    if (invTags) {   // 등록부 칸이 있어도 인벤토리 값이 다를 수 있다(손으로 적은 태그 ≠ 장비가 답한 태그) — 둘 다 재료로
      let t = ''; try { t = invForServer(s)?.system?.serviceTag; } catch { t = ''; }
      if (typeof t === 'string' && t && t !== s.serviceTag) allTags.push(t);
    }
  }
  const { servers } = scopeIdracServers(req, all);
  const byKey = new Map();
  const list = [];
  for (const s of servers) {
    const dc = String(s.datacenterId || assign[String(s.vcenterId || s.mappedVcenterId || '')] || '');
    if (dc !== corpId) continue;
    let inv = null; try { inv = invForServer(s); } catch { inv = null; }
    // 등록부 칸이 자리표시 값('None' 등)이면 인벤토리의 진짜 태그로 넘어간다(5회차 점검 정확성 관찰 4 — 진짜 태그가 있는데도 잇지 못하는 서버가 됐다).
    //   태그는 보이지 않는 글자를 지우고 다듬은 값으로 본다(연결 키 · 화면에 싣는 태그 · 가림 재료가 같은 값 — 등록부는 trim 만 한다 · 5회차 점검 보안 1 의 남은 쪽).
    const regTag = cleanTag(String(s.serviceTag || '')); const invTag = cleanTag(String(inv?.system?.serviceTag || ''));
    const tag = usableTag(regTag) ? regTag : usableTag(invTag) ? invTag : (regTag || invTag);
    // 자리표시 태그('To Be Filled By O.E.M.' 같은 화이트박스 기본값 · 'None' · '0000000')는 **연결 키가 아니다**(4회차 점검 정확성 4 — 재현): 서로 다른 서버 여러 대가 같은 값이라,
    //   키로 쓰면 원장의 장비가 그중 먼저 온 서버에 이어져 남의 상태를 보이고, 한 대를 놓는 순간 나머지가 미배치 목록에서 사라졌다. 태그를 못 읽은 서버와 함께 센다(serversNoTag).
    //   ⚠ 진짜 태그가 둘인 것(중앙 등록 + 엣지가 올린 같은 서버)은 그대로 먼저 온 서버에 잇는다 — 같은 장비다.
    const key = usableTag(tag) ? serialKeyOf(tag) : '';
    const row = { s, inv, tag, key };
    list.push(row);
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  for (const x of list) if (x.tag) allTags.push(x.tag);   // 인벤토리에서만 읽힌 태그(등록부 칸이 빈 서버)
  return { byKey, list, hosts, allTags };
}

/**
 * 비관리자 판본의 글자 가림(요청당 하나 — 1회차 점검 S1 · S2 · 2회차 점검 1~6). **가림은 이 함수 하나가 정한다**(순서 · 재료 · 판정):
 *  ① 주소 먼저: 낱말 단위로 IP 리터럴(IPv4 가 든 낱말 · **엄격한** IPv6 리터럴 · 대괄호 + 포트)과 등록 주소와 같은 낱말 → 토큰,
 *     그다음 등록부 **전체**의 관리 주소(대소문자 무시) → '(주소 가림)' — FQDN · IP 는 글 속 어디든, 점 없는 짧은 이름은 호스트 이름 낱말 통째일 때만
 *     (`rack/textMask.js` 경계 규칙). ⚠ IPv6 는 다른 iDRAC 화면의 `addressMatcher`(콜론 2개 + 16진이면 주소 — 식별자 칸용)보다 **엄격하다**:
 *     글에는 시각 '12:30:45' · 포트 '1:2:3' · 이력의 '이름: 랙' 이 흔하다(2회차 반증 C3 가) — 16진 · 콜론 구간의 마디 묶음이 유효한 IPv6('::' 또는 8마디) · MAC 일 때만(`hasIpv6`).
 *  · 판정 앞에서 글과 **재료 양쪽**의 보이지 않는 글자를 지운다(`layout.js dropInvisible` — 한쪽만 지우면 어긋난다).
 *  · 태그 재료에서 자리표시 값(`bmusage/commonTag.js isPlaceholderTag` — 'None' · 'Default string' · '0000000')은 뺀다(2회차 반증 C2 — 'phone-01 none' 이 지워졌다).
 *  ② 태그 나중: 시리얼을 가리는 판본(범위 비관리자)만 — 등록부 서비스 태그 + 그 법인 원장의 시리얼 + (그 행 · 그 장비의 시리얼)을 비교 키로 걷어 낸다.
 *     순서가 반대면 'idrac-<태그>.<도메인>' 에서 태그가 먼저 '•••' 가 되어 주소가 등록 주소와 맞지 않는다(2회차 점검 3).
 *  · `name(s, tags?)` = 이름 하나(표시 이름 · 등록부 이름 · 판 차이의 항목 이름) — 통째로 주소면 '이름 가림', 아니면 ① ②.
 *  · `text(s, tags?)` = 글 한 줄 — ① ②.
 *  · `row(detail, tags, action)` = 이력 · 판 행(db 층이 그 행의 tags 를 넘겨준다) — tags 를 모르는(null) 옛 장비 글은 시리얼을 가리는 판본에 통째로 가린다.
 * ⚠ 원장 표시 이름(label)은 관리자가 공개한 이름으로 본다 — 주소와 (가림 판본의) 태그만 가리고, 호스트 이름처럼 보이는 이름은 그대로 둔다(랙 그림의 장비 이름이 비면 조회 계정에게 쓸모가 없다).
 */
const HIDDEN_ADDR = '(주소 가림)';
const PLAIN_MASK = Object.freeze({ admin: true, name: (s) => s, text: (s) => s, row: (s) => s, match: () => false });
const OPEN_P = new Set(['(', '[', '{', '<', '"', "'", '‘', '“']);
const CLOSE_P = new Set([')', ']', '}', '>', '"', "'", '’', '”', ',', ';', '.', ':']);   // ':' = 이력 글의 '이름: 랙'
/**
 * 낱말의 앞뒤 문장 부호를 뗀 알맹이의 구간 [a, b)(정규식의 `+$` 를 쓰지 않는다 — 긴 입력에서 O(n²)). 대괄호 IPv6(+ 포트)는 대괄호 안.
 * `plain` = 뗀 것이 문장 부호뿐인가(대괄호 지름길이 아니다 — 그때는 앞뒤 조각을 그대로 붙여도 된다).
 */
function coreSpan(w) {
  let a = 0; let b = w.length;
  if (w[a] === '[') { const k = w.indexOf(']'); if (k > 1) return { a: 1, b: k, plain: false }; }
  while (a < b && OPEN_P.has(w[a])) a += 1;
  while (b > a && CLOSE_P.has(w[b - 1])) b -= 1;
  return { a, b, plain: true };
}
const wordCore = (w) => { const { a, b } = coreSpan(w); return w.slice(a, b); };
// 낱말 안에서 16진 구간의 이웃이 '이어지는 글자' 인가 — 라틴 글자 · 숫자만(한글 조사 'fe80::1에' · 문장 부호는 경계 — textMask.js 의 글자 갈래와 같은 기준).
const isLatinLD = (ch) => charKind(ch) === 1;
const realTags = (arr) => (arr || []).map(cleanTag).filter(usableTag);
/** 가린 낱말의 토큰 — 공용 함수는 'masked-' 로 시작하는 값을 이미 토큰으로 보고 그대로 돌려준다. 글에서는 그런 낱말도 원문이므로 한 번 감싼다(4회차 점검 보안 5). */
const textToken = (v) => maskedIdToken(v.startsWith(MASK_TOKEN_PREFIX) ? `text:${v}` : v);
/** 낱말 안에 IPv4 꼴(점으로 나뉜 1~3자리 숫자 묶음이 4개 이상 이어짐)이 있는가 — 'node.10.20.30.97' · '[BMC]10.20.31.11' · '10.20.30.99.' · 'Unity 5.3.0.0' 의 낱말. */
function hasIpv4(w) {
  for (const m of w.matchAll(/[0-9.]+/g)) {
    if (m[0].length < 7) continue;
    let n = 0;
    for (const part of m[0].split('.')) { n = part.length >= 1 && part.length <= 3 ? n + 1 : 0; if (n >= 4) return true; }
  }
  return false;
}
const MAC_RE = /^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$/;
const IPV6_RUN_MAX = 80;      // 이보다 긴 16진 · 콜론 구간은 주소가 아니다(IPv6 는 39자 · 뒤에 포트 · 이름표가 붙어도 이 안)
/**
 * 낱말 안에 IPv6 리터럴 · MAC 이 있는가(엄격). 16진 · 콜론이 이어진 구간을 콜론으로 나눈 **마디의 연속 묶음** 가운데 하나라도
 *   ① 통째로 유효한 IPv6 이고(`net.isIPv6`) '::' 가 있거나 8마디이거나 ② MAC(두 자리 × 6)이면 주소다.
 * 묶음이 구간의 처음(끝)에서 시작하면(끝나면) 그 앞(뒤) 글자가 라틴 글자 · 숫자가 아니어야 한다('std::string' 의 'd::' · 'xfe80::1' 제외) —
 *   구간 안쪽의 묶음은 콜론이 경계다. 그래서 이름표나 포트가 콜론으로 붙은 꼴도 잡는다: 'ip:2001:db8::a1' · 'MAC:0a:1b:2c:3d:4e:5f' · 'fe80::77:end' ·
 *   '1:2:3:4:5:6:7:8:8443' · 이력의 '이름: 랙'(4회차 점검 보안 2 · 정확성 1 — 예전엔 앞뒤 글자 검사가 콜론을 떼는 것보다 먼저라 주석과 달랐다).
 * 'https://[2001:db8::a]/ui' · 'net 2001:db8::a/64' · 'ip=fe80::1%eth0' 는 주소, '12:30:45' · '1:2:3' · 'AB:CD:' 는 아니다.
 */
function hasIpv6(w) {
  for (const m of w.matchAll(/[0-9a-fA-F:]+/g)) {
    const run = m[0];
    if (run.length < 3 || run.length > IPV6_RUN_MAX || !run.includes(':')) continue;
    if (!/[0-9a-fA-F]/.test(run)) continue;   // 콜론뿐인 구간은 묶음을 만들어 보지 않는다(':' × 80 에 89µs 였다 — 5회차 점검 성능 관찰)
    const parts = run.split(':');
    const n = parts.length;
    const leftOpen = !isLatinLD(w[m.index - 1]); const rightOpen = !isLatinLD(w[m.index + run.length]);
    for (let i = 0; i < n; i += 1) {
      if (i === 0 && !leftOpen) continue;
      // IPv6 는 많아야 8마디 + '::' 의 빈 마디 — 묶음 길이는 9 까지만 본다(구간이 길어도 일은 '마디 수 × 9').
      for (let j = Math.min(n - 1, i + 8); j > i; j -= 1) {
        if (j === n - 1 && !rightOpen) continue;
        const cand = parts.slice(i, j + 1).join(':');
        if (cand.length === 17 && MAC_RE.test(cand)) return true;
        if ((j - i === 7 || cand.includes('::')) && /[0-9a-fA-F]/.test(cand) && isIPv6(cand)) return true;
      }
    }
  }
  return false;
}
function textMaskOf({ admin, showSerial, hosts = [], tags = [] }) {
  if (admin) return PLAIN_MASK;
  hosts = hosts.map(cleanTag).filter((h) => typeof h === 'string' && h);   // 등록 주소도 같은 눈으로(위 cleanTag)
  const match = addressMatcher(hosts);
  const hostEq = (v) => !!v && match.addressSet.has(v.trim().toLowerCase());
  const hostIdx = needleIndexOf(hosts.flatMap(hostVariants), { min: 3 });
  const corpIdx = showSerial ? null : tagIndexOf(realTags(tags));
  /**
   * 낱말 하나가 IP 리터럴(또는 등록 주소 그대로)을 품었는가.
   *  · 문장 부호를 뗀 알맹이 · 낱말 통째가 등록 주소와 같은가(대소문자 무시).
   *  · 낱말 안의 IPv4 꼴 · 엄격한 IPv6 리터럴 — 문장 부호 · 다른 글자와 붙은 주소('[BMC]10.20.31.11' · 'https://[2001:db8::a]/ui' ·
   *    'net 2001:db8::a/64' · 'ip=fe80::1%eth0' · 'node.10.20.30.97')도 잡는다(3회차 점검 1 · 4).
   */
  const ipWord = (w) => {
    const core = wordCore(w);
    if (hostEq(core) || hostEq(w)) return true;
    return hasIpv4(w) || hasIpv6(w);
  };
  /**
   * IP 낱말 하나를 토큰으로. 알맹이가 주소이고 뗀 것이 문장 부호뿐이면 부호는 남긴다('(10.9.8.201):' → '(masked-…):' — 같은 주소는 어느 글에서나 같은 토큰).
   * 그 밖에는(주소가 알맹이 밖에 걸친 '[BMC]10.20.31.11' · 대괄호 + 포트) 낱말 통째를 토큰 하나로 — 주소 조각을 남기지 않는다.
   */
  const maskWord = (w) => {
    const { a, b, plain } = coreSpan(w);
    const core = w.slice(a, b);
    if (plain && core && (hostEq(core) || hasIpv4(core) || hasIpv6(core))) return w.slice(0, a) + textToken(core) + w.slice(b);
    return textToken(w);
  };
  // 순서: ① IP 리터럴 낱말을 **원문 낱말에서 먼저** 토큰으로 ② 그다음 등록 주소를 글 속에서 치환.
  //   반대면 등록 IP '10.20.30.4' 가 다른 IP '10.20.30.45' 의 앞부분만 가려 '(주소 가림)5' 가 남는다(3회차 점검 2).
  const addr = (s) => {
    if (!/[\d:]/.test(s)) return replaceNeedles(s, hostIdx, HIDDEN_ADDR);   // 숫자 · 콜론이 없으면 IP 리터럴도 없다
    // 낱말마다: IP 리터럴이면 토큰, 아니면 그 낱말 안의 등록 주소를 치환(토큰으로 바꾼 낱말은 다시 훑지 않는다 — 토큰의 16진 글자를 짧은 등록 주소가 건드리지 않게).
    return s.split(/(\s+)/).map((w) => {
      if (!w || /^\s/.test(w)) return w;
      if (!/[\d:]/.test(w)) return replaceNeedles(w, hostIdx, HIDDEN_ADDR);
      if (w.length > 300) return textToken(w.slice(0, 300));   // 이렇게 긴 낱말은 살피지 않고 통째로(숫자 · 콜론이 든 것만)
      return ipWord(w) ? maskWord(w) : replaceNeedles(w, hostIdx, HIDDEN_ADDR);
    }).join('');
  };
  // 그 행 · 그 장비의 시리얼(own)과 법인 색인을 **한 번에** 훑는다(따로 훑으면 짧은 own 이 다른 장비의 긴 시리얼을 깨뜨려 꼬리가 남는다 — 3회차 점검 정확성 1).
  const tagsOut = (t, own) => (showSerial ? t : stripTags(t, own && own.length ? tagIndexOf(realTags(own)) : null, corpIdx));
  // 판정 앞에서 보이지 않는 글자를 지운다(4회차 점검 보안 4 — '10.20<U+FE0F>.31.5' 는 화면에 주소로 보이는데 판정은 비켜 갔다. 새 입력은 cleanText 가 이미 지운다).
  const text = (s0, own) => { const s = dropInvisible(s0); return typeof s !== 'string' || !s ? s : tagsOut(addr(s), own); };
  return {
    admin: false, match, text,
    // 이름이 **낱말 하나**이고 그것이 주소면 통째로 '이름 가림'. 여러 낱말이면 주소인 낱말만 가린다('Unity 5.3.0.0 array' 를 통째로 지우지 않는다 — 1회차 반증 판단 2).
    name: (s0, own) => {
      const s = dropInvisible(s0);
      if (typeof s !== 'string' || !s) return s;
      const one = s.trim();
      return !/\s/.test(one) && one.length <= 300 && ipWord(one) ? `${textToken(one)} (이름 가림)` : text(s, own);
    },
    row: (detail, own, action) => (!showSerial && own == null && /^place\./.test(String(action || '')) ? R.LEGACY_DETAIL_HIDDEN : text(detail, own || [])),
  };
}
/** 판 목록 · 판 차이 라우트용 — 그 법인의 가림 재료(비관리자일 때만 등록부 · 원장을 읽는다). */
async function corpTextMask(req, corpId) {
  const admin = isAdminDetailUser(req.user);
  if (admin) return PLAIN_MASK;
  const showSerial = serialsVisible(req);
  const { hosts, allTags } = corpServers(req, corpId, { invTags: !showSerial });
  const tags = showSerial ? [] : [...allTags, ...(await R.corpSerials(corpId))];
  return textMaskOf({ admin, showSerial, hosts, tags });
}

/**
 * 비관리자 판본의 서버 식별 필드 가림(점검 C5 · C6 — 재현):
 *  · IP 로 등록한 iDRAC 는 등록부 id · 이름이 곧 관리 주소다 — 이름은 요청당 판정기(`textMaskOf` — 범위 안 등록부 전체 주소)로 '이름 가림',
 *    id 는 비관리자면 **항상 토큰**(id 가 주소 · 서비스 태그인 등록부가 있다 — 화면은 id 를 키로만 쓴다).
 *  · 시리얼을 가리는 판본(범위 비관리자)은 이름 · 호스트 이름에 든 서비스 태그도 걷어 낸다(물리서버 폴더 · 서비스 인벤토리 `stripTag` 와 같은 함수 · 같은 임계).
 */
function maskServerIdentity(obj, row, { admin, showSerial, mask }) {
  if (admin) return obj;
  const out = { ...obj, serverId: maskedIdToken(String(obj.serverId ?? '')) };
  // OS 호스트 이름은 관리자 판본만(반증 추가 1 — 물리서버 폴더 hwView 와 같은 기준). 등록 이름이 없어 호스트 이름으로 떨어진 이름도 비운다(가림보다 먼저 본다).
  const osHost = String(row.inv?.system?.hostName || '');
  if (osHost && !row.s?.name && out.name === osHost) out.name = '';
  if ('hostname' in out) out.hostname = '';
  if (out.hw?.host) out.hw = { ...out.hw, host: '' };
  if (out.hw?.os?.host) out.hw = { ...out.hw, os: { ...out.hw.os, host: '' } };
  // 이름은 표시 이름과 같은 가림(2회차 점검 4 — 통째 일치만 보면 'host:443' · URL 꼴 · 글 속 주소 · 다른 서버의 태그가 든 이름이 그대로 나갔다)
  const m = mask || textMaskOf({ admin, showSerial, hosts: [row.s?.host].filter(Boolean), tags: [row.tag].filter(Boolean) });
  if (out.name) out.name = m.name(out.name, [row.tag].filter(Boolean));
  return out;
}

function linkView(row, { admin, showSerial = true, mask = null }) {
  const { s, inv } = row;
  const sys = inv?.system || {};
  const rollup = (k) => { const r = partHealthRollup(inv?.[k]); return r.state ? { state: r.state, ...r.counts } : null; };
  return maskServerIdentity({
    serverId: String(s.id),
    name: s.name || sys.hostName || '',
    hostname: sys.hostName || '',
    model: sys.model || s.model || '',
    powerState: sys.powerState || inv?.powerState || '',
    health: healthOf(sys.health),
    remote: !!s.remote,
    collectedAt: Number(inv?.collectedAt) || null,
    hw: hwSummaryOf(inv),
    parts: inv ? { psu: rollup('psus'), disk: rollup('disks'), mem: rollup('memoryDimms'), fan: rollup('fans') } : null,
    ...(admin ? { mgmtHost: mgmtHostOf(s.host) } : {}),
  }, row, { admin, showSerial, mask });
}

// ───────────────────────── 조회 ─────────────────────────

async function treeView(req) {
  const acc = accessOf(req);
  const corps = listDatacenters().filter((d) => canRead(acc, String(d.id)))
    .map((d) => ({ id: String(d.id), name: d.name || String(d.id), writable: canWrite(acc, String(d.id)) }));
  const ids = new Set(corps.map((c) => c.id));
  const tree = await R.listTree(ids);
  // 범위 밖 법인의 원장(법인 목록에서 지워진 법인 포함)은 범위 계정에 주지 않는다 — 전체 범위면 '법인 목록에 없음' 으로 밝힌다.
  if (!acc.read) {
    const known = new Set(listDatacenters().map((d) => String(d.id)));
    const all = await R.listTree(null);
    for (const s of all.sites) if (!known.has(s.corpId) && !corps.some((c) => c.id === s.corpId)) corps.push({ id: s.corpId, name: `${s.corpId}(법인 목록에 없음)`, writable: canWrite(acc, s.corpId), orphan: true });
    return { corps, sites: all.sites, rooms: all.rooms };
  }
  return { corps, ...tree };
}

async function roomView(req, roomId) {
  const acc = accessOf(req);
  const admin = isAdminDetailUser(req.user);
  const showSerial = serialsVisible(req);
  const corpId = await R.corpOf('room', roomId).then((x) => x?.corpId || '');
  if (!corpId || !canRead(acc, corpId)) return null;
  const { byKey, list, hosts, allTags } = corpServers(req, corpId, { invTags: !admin && !showSerial });
  // 1회차 점검 S1: 표시 이름(label)과 그 이름으로 만든 이력 글에도 주소 · 태그 가림(예전엔 link 만 가렸다 — 화면이 등록부 이름으로 채운 label 이 그대로 나갔다)
  const mask = textMaskOf({ admin, showSerial, hosts, tags: admin || showSerial ? [] : [...allTags, ...(await R.corpSerials(corpId))] });
  const data = await R.getRoom(roomId, { maskRow: admin ? null : mask.row });   // 이력 글은 db 층이 그 행의 tags 와 함께 가림 함수에 넘긴다(tags 는 돌려주지 않는다)
  if (!data || data.site.corpId !== corpId) return null;
  const placedKeys = await R.placedSerialKeys(corpId);
  const places = data.places.map((p) => {
    const row = p.kind === 'server' && p.serialKey ? byKey.get(p.serialKey) : null;
    const out = { ...p, label: mask.name(p.label, [p.serial, ...(p.extraSerials || [])].filter(Boolean)), link: row ? linkView(row, { admin, showSerial, mask }) : null, linkState: p.kind !== 'server' ? 'n/a' : !p.serialKey ? 'no-serial' : row ? 'linked' : 'not-found' };
    delete out.serialKey;
    if (!showSerial) { out.serial = ''; out.extraSerials = []; out.serialHidden = true; }
    return out;
  });
  const placesByRack = new Map();
  for (const p of places) { if (!placesByRack.has(p.rackId)) placesByRack.set(p.rackId, []); placesByRack.get(p.rackId).push(p); }
  // 점검 C3(재현): 예전엔 후면 전용 장비를 걸러 전력 · 무게 · 대수 합에서 통째로 빠졌다(부분 합이 '몇 대 중 몇 대' 없이 전체처럼 보였다).
  //   rackTotals 가 앞 · 뒤가 같은 U 면 한 번만 세므로 그대로 넘긴다.
  const racks = data.racks.map((r) => ({ ...r, totals: rackTotals(r, placesByRack.get(r.id) || []) }));
  // 미배치 = 이 법인 서버 중 원장 어디에도(이 법인 전 데이터센터) 서비스 태그가 없는 것.
  const unplacedAll = list.filter((x) => x.key && !placedKeys.has(x.key));
  // 개선 3(2026-11-26): 화면이 검색어로 걸러 끌어 놓으므로 앞 300대로 자르지 않는다(법인 하나의 서버 수 — 상한은 응답 크기 보호용).
  const unplaced = unplacedAll.slice(0, UNPLACED_MAX).map((x) => maskServerIdentity({
    serverId: String(x.s.id), name: x.s.name || x.inv?.system?.hostName || '', model: x.inv?.system?.model || x.s.model || '',
    hostname: x.inv?.system?.hostName || '', ...(showSerial ? { serviceTag: x.tag } : {}),
  }, x, { admin, showSerial, mask }));
  const noTag = list.filter((x) => !x.key).length;   // 태그를 못 읽었거나 자리표시 값인 서버
  const corp = listDatacenters().find((d) => String(d.id) === corpId);
  return {
    ok: true,
    corp: { id: corpId, name: corp?.name || corpId },
    site: data.site, room: data.room, rev: data.room.rev,
    racks, places,
    unplaced, unplacedTotal: unplacedAll.length, serversNoTag: noTag,
    logs: data.logs.map((l) => ({ ...l, user: admin ? l.user : '' })),   // detail 은 getRoom 이 이미 가렸다(maskRow)
    canEdit: canWrite(acc, corpId),
    serialsHidden: !showSerial,
    limits: LIMITS,
  };
}

// ───────────────────────── 엑셀 내보내기(사용자 엑셀 실장도와 같은 꼴) ─────────────────────────

/**
 * 엑셀 시트 이름 — 금지 글자(\\ / ? * [ ] :) · 앞뒤 작은따옴표 · 예약어 'History' 를 피하고 31자로 자른다(반증 F2 — 그런 전산실 이름이면 내보내기가 500 이었다).
 */
export function sheetNameOf(name) {
  let s = String(name || '').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  while (s.startsWith("'")) s = s.slice(1);
  while (s.endsWith("'")) s = s.slice(0, -1);
  s = s.trim();
  if (!s) s = '전산실';
  if (s.toLowerCase() === 'history') s = `전산실 ${s}`;
  return s.slice(0, 31);
}

const fmtU = (p) => `U${p.uStart}${p.uSize > 1 ? `–${p.uStart + p.uSize - 1}` : ''}`;
/** 엑셀 장비 칸의 식별 줄(모델 / 시리얼 / 추가 시리얼 / 호스트 이름) — 전면 칸과 후면 줄이 같은 함수를 쓴다(1회차 점검 정확성 3: 후면 줄에 추가 시리얼이 빠졌다). */
const placeIdLine = (p) => [p.model, p.serial, ...(p.extraSerials || []), p.link?.hostname || ''].filter(Boolean).join(' / ');

/**
 * 시트 하나에 그리는 랙 수(점검 C4 — 측정): ExcelJS 의 mergeCells 는 병합마다 그 시트의 기존 병합 전부와 겹침을 검사해 비용이 병합 수의 제곱이다.
 * 랙 300개를 한 시트에 그리면 중앙 이벤트 루프가 약 21초 멈췄다(랙당 병합 약 55회). 시트를 RACKS_PER_SHEET 대씩 나누고 랙마다 양보한다.
 */
export const RACKS_PER_SHEET = 12;
/** 나눈 시트 이름 — 전산실 이름 뒤에 랙 번호 범위(31자 · 금지 글자 규칙은 sheetNameOf). 시트가 하나면 예전처럼 전산실 이름만. */
export function sheetNamesOf(roomName, rackCount, per = RACKS_PER_SHEET) {
  const n = Math.max(1, Math.ceil(rackCount / per));
  if (n === 1) return [sheetNameOf(roomName)];
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const tail = ` ${k * per + 1}-${Math.min(rackCount, (k + 1) * per)}`;
    out.push(sheetNameOf(`${sheetNameOf(roomName).slice(0, 31 - tail.length).trim()}${tail}`));
  }
  return out;
}
const yieldTurn = () => new Promise((r) => setImmediate(r));

export async function buildRoomXlsx(view) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'THE DAVINCI';
  const names = sheetNamesOf(view.room.name, view.racks.length);
  const thin = { style: 'thin', color: { argb: 'FF808080' } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  const COLS = 5; const GAP = 1;
  let ws = null;
  for (const [idx, rack] of view.racks.entries()) {
    const i = idx % RACKS_PER_SHEET;
    if (i === 0 || !ws) {
      ws = wb.addWorksheet(names[Math.floor(idx / RACKS_PER_SHEET)]);
      ws.getCell(1, 1).value = `${view.corp.name} › ${view.site.name} › ${view.room.name} — 랙 실장도(포탈 원장 · ${todayStamp()})`;
      ws.getCell(1, 1).font = { bold: true, size: 12 };
    }
    if (idx) await yieldTurn();   // 랙마다 양보 — 큰 전산실 내보내기가 다른 요청을 붙잡지 않게
    const c0 = 1 + i * (COLS + GAP);
    const H = rack.heightU;
    ws.getColumn(c0).width = 5; ws.getColumn(c0 + 1).width = 40; ws.getColumn(c0 + 2).width = 8; ws.getColumn(c0 + 3).width = 10; ws.getColumn(c0 + 4).width = 10;
    ws.getColumn(c0 + COLS).width = 3;
    ws.mergeCells(3, c0, 3, c0 + COLS - 1);
    const title = ws.getCell(3, c0);
    title.value = `${rack.name}${rack.role ? ` ${rack.role}` : ''}${rack.row ? ` · ${rack.row} 줄` : ''}`;
    title.font = { bold: true, size: 12 }; title.alignment = { horizontal: 'center' }; title.border = box;
    ['U', '장비', '무게(kg)', '운전전력(W)', '정격전력(W)'].forEach((h, k) => {
      const c = ws.getCell(4, c0 + k); c.value = h; c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF000000' } }; c.alignment = { horizontal: 'center' }; c.border = box;
    });
    const rowOfU = (u) => 5 + (H - u);
    for (let u = H; u >= 1; u -= 1) {
      const r = rowOfU(u);
      ws.getCell(r, c0).value = u; ws.getCell(r, c0).alignment = { horizontal: 'center' };
      for (let k = 0; k < COLS; k += 1) ws.getCell(r, c0 + k).border = box;
    }
    const mine = view.places.filter((p) => p.rackId === rack.id);
    const front = mine.filter((p) => p.face !== 'rear');
    for (const p of front) {
      const top = rowOfU(p.uStart + p.uSize - 1); const bot = rowOfU(p.uStart);
      const cells = [c0 + 1, c0 + 2, c0 + 3, c0 + 4];
      if (bot > top) for (const c of cells) ws.mergeCells(top, c, bot, c);
      const lines = [p.label || '', placeIdLine(p)].filter(Boolean);
      const cell = ws.getCell(top, c0 + 1);
      cell.value = `${lines.join('\n')}${p.face === 'front' ? ' (앞 반깊이)' : ''}`;
      cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
      cell.font = { bold: true };
      [p.weightKg, p.opW, p.ratedW].forEach((v, k) => { const x = ws.getCell(top, c0 + 2 + k); x.value = v ?? null; x.alignment = { vertical: 'middle', horizontal: 'right' }; });
    }
    let r = rowOfU(1) + 1;
    const t = rack.totals;
    const part = (n, read) => (read < n ? ` (${n}대 중 ${read}대)` : '');
    const sumRow = (label, value) => {
      ws.mergeCells(r, c0, r, c0 + 2);
      const a = ws.getCell(r, c0); a.value = label; a.alignment = { horizontal: 'center' }; a.border = box;
      ws.mergeCells(r, c0 + 3, r, c0 + 4);
      const b = ws.getCell(r, c0 + 3); b.value = value; b.alignment = { horizontal: 'right' }; b.border = box;
      r += 1;
    };
    sumRow(`실장율(N/${H})`, t.usePct == null ? '—' : `${t.usePct}% (${t.usedU}U)`);
    sumRow('전력량 합계(운전)', t.opW == null ? '—' : `${t.opW} W${part(t.devices, t.opRead)}`);
    sumRow('전력량 합계(정격)', t.ratedW == null ? '—' : `${t.ratedW} W${part(t.devices, t.ratedRead)}`);
    sumRow('장비 무게 합계', t.weightKg == null ? '—' : `${t.weightKg} kg${part(t.devices, t.weightRead)}`);
    sumRow('세로 PDU(A · B 계통)', `A ${rack.pduA} · B ${rack.pduB}`);
    const rear = mine.filter((p) => p.face === 'rear');
    for (const p of rear) {
      const vals = [p.weightKg != null ? `${p.weightKg} kg` : '', p.opW != null ? `운전 ${p.opW} W` : '', p.ratedW != null ? `정격 ${p.ratedW} W` : ''].filter(Boolean).join(' · ');
      sumRow(`후면 ${fmtU(p)}`, [[p.label, placeIdLine(p)].filter(Boolean).join(' / '), vals].filter(Boolean).join(' — '));
    }
  }
  if (!ws) {   // 랙이 없는 전산실도 제목 시트 하나는 남긴다(예전 동작)
    ws = wb.addWorksheet(names[0]);
    ws.getCell(1, 1).value = `${view.corp.name} › ${view.site.name} › ${view.room.name} — 랙 실장도(포탈 원장 · ${todayStamp()})`;
    ws.getCell(1, 1).font = { bold: true, size: 12 };
  }
  return wb.xlsx.writeBuffer();
}

// ───────────────────────── 쓰기 ─────────────────────────

const intRev = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null));

/** 쓰기 대상의 법인을 찾아 '조회 밖 404 → 쓰기 밖 403'. 통과하면 { corpId, roomId }. */
async function gate(req, res, kind, id) {
  if (!isId(id)) { res.status(400).json({ ok: false, reason: '대상 id 가 올바르지 않습니다.' }); return null; }
  const found = await R.corpOf(kind, id);
  const acc = accessOf(req);
  if (!found || !canRead(acc, found.corpId)) { res.status(404).json({ ok: false, reason: '대상을 찾지 못했습니다.' }); return null; }
  if (!canWrite(acc, found.corpId)) { res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인의 랙 실장도를 고칠 권한이 없습니다(관리자 · 그 법인 쓰기 범위만).' }); return null; }
  return found;
}

/** 본문 { op, ... } 하나로 받는 쓰기 연산. */
async function runOp(req, res) {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const op = cleanText(b.op, 32);
  const user = userOf(req);
  const rev = intRev(b.rev);
  const name = cleanText(b.name, LIMITS.name);
  try {
    switch (op) {
      case 'site.add': {
        const corpId = cleanText(b.corpId, 64);
        const acc = accessOf(req);
        // 점검 C16: 법인 목록에서 지워진 법인(원장은 남음 — 전체 범위 계정에만 보인다)은 다른 쓰기(전산실 · 랙)와 같게 다룬다(예전엔 site.add 만 404).
        const known = listDatacenters().some((d) => String(d.id) === corpId) || (!acc.read && corpId && (await R.listTree(new Set([corpId]))).sites.length > 0);
        if (!corpId || !canRead(acc, corpId) || !known) return res.status(404).json({ ok: false, reason: '법인을 찾지 못했습니다.' });
        if (!canWrite(acc, corpId)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인의 랙 실장도를 고칠 권한이 없습니다(관리자 · 그 법인 쓰기 범위만).' });
        if (!name) return res.status(400).json({ ok: false, reason: '데이터센터 이름이 비어 있습니다.' });
        const r = await R.addSite({ corpId, name, user });
        audit(req, 'rack.site.add', corpId, name);
        return res.json({ ok: true, ...r });
      }
      case 'site.rename': case 'site.remove': {
        const g = await gate(req, res, 'site', b.id); if (!g) return undefined;
        if (op === 'site.rename' && !name) return res.status(400).json({ ok: false, reason: '이름이 비어 있습니다.' });
        const r = op === 'site.rename' ? await R.renameSite({ id: b.id, name, user }) : await R.removeSite({ id: b.id, user });
        if (!r?.unchanged) audit(req, `rack.${op}`, g.corpId, name || b.id);   // 바뀐 것이 없는 저장은 감사에도 남기지 않는다
        return res.json({ ok: true, ...r });
      }
      case 'room.add': {
        const g = await gate(req, res, 'site', b.siteId); if (!g) return undefined;
        if (!name) return res.status(400).json({ ok: false, reason: '전산실 이름이 비어 있습니다.' });
        const r = await R.addRoom({ siteId: b.siteId, name, user });
        audit(req, 'rack.room.add', g.corpId, name);
        return res.json({ ok: true, ...r });
      }
      case 'room.rename': case 'room.remove': {
        const g = await gate(req, res, 'room', b.id); if (!g) return undefined;
        if (op === 'room.rename' && !name) return res.status(400).json({ ok: false, reason: '이름이 비어 있습니다.' });
        const r = op === 'room.rename' ? await R.renameRoom({ id: b.id, name, user }) : await R.removeRoom({ id: b.id, user });
        if (!r?.unchanged) audit(req, `rack.${op}`, g.corpId, name || b.id);   // 바뀐 것이 없는 저장은 감사에도 남기지 않는다
        return res.json({ ok: true, ...r });
      }
      case 'version.restore': {
        const corpId = cleanText(b.corpId, 64);
        const acc = accessOf(req);
        if (!corpId || !canRead(acc, corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾지 못했습니다.' });
        if (!canWrite(acc, corpId)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '이 법인의 랙 실장도를 고칠 권한이 없습니다(관리자 · 그 법인 쓰기 범위만).' });
        const versionId = intRev(b.versionId); const expectLatestId = intRev(b.expectLatestId);
        if (versionId == null) return res.status(400).json({ ok: false, reason: '판 번호가 올바르지 않습니다.' });
        const r = await R.restoreVersion({ corpId, versionId, expectLatestId, user });
        audit(req, 'rack.version.restore', corpId, `판 #${versionId} → 새 판 #${r.latestId}`);
        return res.json({ ok: true, ...r });
      }
      case 'type.add': case 'type.remove': {
        if (!isAdminDetailUser(req.user) || !isFullReadWriteScope(req.user, store.get())) {
          return res.status(403).json({ ok: false, error: 'forbidden', reason: '랙 종류는 전 법인 공용 목록이라 조회 · 쓰기 모두 전체 범위인 관리자만 바꿀 수 있습니다.' });
        }
        if (op === 'type.remove') {
          if (!isId(b.id)) return res.status(400).json({ ok: false, reason: '대상 id 가 올바르지 않습니다.' });
          const r = await R.removeType({ id: b.id });
          audit(req, 'rack.type.remove', b.id);
          return res.json({ ok: true, ...r });
        }
        const heightU = intIn(b.heightU, LIMITS.minHeightU, LIMITS.maxHeightU);
        if (!name || heightU == null) return res.status(400).json({ ok: false, reason: `이름과 높이(${LIMITS.minHeightU}~${LIMITS.maxHeightU}U)를 넣으세요.` });
        const mm = (v) => (v === '' || v == null ? null : intIn(v, 100, 3000));
        // 점검 C18: 넣었는데 범위 밖이면 조용히 null 로 저장하지 않는다
        for (const k of ['widthMm', 'depthMm']) if (b[k] !== '' && b[k] != null && mm(b[k]) == null) return res.status(400).json({ ok: false, reason: '너비 · 깊이는 100~3000mm 정수로 넣으세요(모르면 비워 두세요).' });
        const r = await R.addType({ name, heightU, widthMm: mm(b.widthMm), depthMm: mm(b.depthMm) });
        audit(req, 'rack.type.add', name, `${heightU}U`);
        return res.json({ ok: true, ...r });
      }
      case 'rack.add': case 'rack.update': case 'rack.remove': {
        const g = await gate(req, res, op === 'rack.add' ? 'room' : 'rack', op === 'rack.add' ? b.roomId : b.id); if (!g) return undefined;
        let r;
        if (op === 'rack.remove') r = await R.removeRack({ roomId: g.roomId, rev, user, id: b.id });
        else {
          const c = cleanRackInput(b.rack, { partial: op === 'rack.update' });
          if (c.error) return res.status(400).json({ ok: false, reason: c.error });
          if (c.value.typeId && !isId(c.value.typeId)) return res.status(400).json({ ok: false, reason: '랙 종류 id 가 올바르지 않습니다.' });
          r = op === 'rack.add' ? await R.addRack({ roomId: g.roomId, rev, user, input: c.value }) : await R.updateRack({ roomId: g.roomId, rev, user, id: b.id, input: c.value });
        }
        if (!r?.unchanged) audit(req, `rack.${op}`, g.corpId, String(op === 'rack.add' ? (r?.id || '') : b.id));
        return res.json({ ok: true, ...r });
      }
      case 'place.add': case 'place.update': case 'place.remove': {
        const g = await gate(req, res, op === 'place.add' ? 'rack' : 'place', op === 'place.add' ? b.rackId : b.id); if (!g) return undefined;
        let r;
        if (op === 'place.remove') r = await R.removePlace({ roomId: g.roomId, rev, user, id: b.id });
        else {
          const c = cleanPlaceInput(b.place, { partial: op === 'place.update' });
          if (c.error) return res.status(400).json({ ok: false, reason: c.error });
          if (op === 'place.add') r = await R.addPlace({ roomId: g.roomId, rev, user, rackId: b.rackId, input: c.value });
          else {
            if (b.rackId != null && b.rackId !== '' && !isId(b.rackId)) return res.status(400).json({ ok: false, reason: '옮길 랙 id 가 올바르지 않습니다.' });
            r = await R.updatePlace({ roomId: g.roomId, rev, user, id: b.id, rackId: b.rackId || '', input: c.value });
          }
        }
        if (!r?.unchanged) audit(req, `rack.${op}`, g.corpId, String(op === 'place.add' ? (r?.id || '') : b.id));
        return res.json({ ok: true, ...r });
      }
      default:
        return res.status(400).json({ ok: false, reason: '알 수 없는 연산입니다.' });
    }
  } catch (e) { return sendErr(res, e); }
}

export function registerRack(api) {
  api.get('/tools/rack', toolsPerm, async (req, res) => {
    try {
      const acc = accessOf(req);
      const t = await treeView(req);
      const types = await R.listTypes();
      res.json({
        ok: true, ...t, types,
        canEditTypes: isAdminDetailUser(req.user) && isFullReadWriteScope(req.user, store.get()),
        isAdmin: acc.isAdmin, kinds: KIND_LABEL, limits: LIMITS,
      });
    } catch (e) { sendErr(res, e); }
  });
  // 법인별 판(최근 30개) — 조회는 그 법인 조회 범위 · 작업자 계정명은 관리자 판본만(변경 이력과 같은 기준).
  api.get('/tools/rack/versions', toolsPerm, async (req, res) => {
    try {
      const corpId = cleanText(req.query?.corp, 64);
      const acc = accessOf(req);
      if (!corpId || !canRead(acc, corpId)) return res.status(404).json({ ok: false, reason: '법인을 찾지 못했습니다.' });
      const admin = isAdminDetailUser(req.user);
      const mask = await corpTextMask(req, corpId);
      const versions = (await R.listVersions(corpId, { maskRow: admin ? null : mask.row })).map((v) => ({ ...v, user: admin ? v.user : '' }));
      return res.json({ ok: true, corpId, versions, latestId: versions[0]?.id ?? null, keep: VERSION_KEEP, canRestore: canWrite(acc, corpId) });
    } catch (e) { return sendErr(res, e); }
  });
  api.get('/tools/rack/versions/:vid', toolsPerm, async (req, res) => {
    try {
      const corpId = cleanText(req.query?.corp, 64);
      const acc = accessOf(req);
      if (!corpId || !canRead(acc, corpId) || !/^\d{1,12}$/.test(String(req.params.vid))) return res.status(404).json({ ok: false, reason: '판을 찾지 못했습니다.' });
      const mask = await corpTextMask(req, corpId);
      const d = await R.versionDetail(corpId, Number(req.params.vid), mask.admin ? {} : { maskRow: mask.row, maskItem: mask.name });
      if (!d) return res.status(404).json({ ok: false, reason: '판을 찾지 못했습니다.' });
      if (!isAdminDetailUser(req.user)) d.version.user = '';
      return res.json({ ok: true, ...d });
    } catch (e) { return sendErr(res, e); }
  });
  api.get('/tools/rack/room/:id', toolsPerm, async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
    try {
      const v = await roomView(req, req.params.id);
      if (!v) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
      return res.json(v);
    } catch (e) { return sendErr(res, e); }
  });
  api.get('/tools/rack/room/:id/xlsx', toolsPerm, csvPerm, async (req, res) => {
    if (!isId(req.params.id)) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
    try {
      const v = await roomView(req, req.params.id);
      if (!v) return res.status(404).json({ ok: false, reason: '전산실을 찾지 못했습니다.' });
      // 반증 F6: 무거운 내보내기는 동시 1건(util/exportBusy.js — 루트 CLAUDE.md 성능 규약).
      const lock = acquireExport('rack-xlsx', req);
      if (!lock.ok) return res.status(lock.status).json(lock.body);
      let buf;
      try { buf = await buildRoomXlsx(v); } finally { lock.release(); }
      const fname = `rack-${v.site.name}-${v.room.name}.xlsx`.replace(/[^\w.\-가-힣]/g, '_');
      audit(req, 'rack.export', v.corp.id, `${v.site.name} › ${v.room.name}`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="rack.xlsx"; filename*=UTF-8''${encodeURIComponent(fname)}`);
      return res.end(Buffer.from(buf));
    } catch (e) { return sendErr(res, e); }
  });
  api.post('/tools/rack/op', adminRole, toolsPerm, (req, res) => {
    if (!isAdminDetailUser(req.user)) return res.status(403).json({ ok: false, error: 'forbidden', reason: '랙 실장도는 관리자만 고칠 수 있습니다.' });
    return runOp(req, res);
  });
}
