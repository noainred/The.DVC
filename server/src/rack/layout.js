/**
 * rack/layout.js — 랙 실장도의 **순수 판정**(v1 · 설계 docs/design/rack-elevation/README.md).
 *
 * 저장소(db.js) · 라우트(routes/api/rack.js) · 웹이 같은 판정을 쓴다 — 겹침 · 범위 · 입력 정리를 여기 한 곳에 둔다
 * (CLAUDE.md '판정 코어는 하나'). 웹 화면은 끌어 놓는 동안 이 판정의 결과(서버 응답)를 다시 그리고, 놓을 때 서버가 다시 검사한다.
 *
 * 배치(place)의 면(face)
 *  · 'full'  — 전체 깊이 장비(서버 · 스토리지 대부분). 그 U 의 앞 · 뒤를 모두 차지한다.
 *  · 'front' — 앞쪽 반깊이 장비(패치패널 · 케이블 정리대 등). 같은 U 의 'rear' 와 함께 놓일 수 있다.
 *  · 'rear'  — 뒤쪽에만 달린 장비(후면 관리 스위치 등).
 * U 는 아래가 1 이다(엑셀 실장도와 같다). 시작 U(uStart)는 장비가 차지한 **가장 아래** 줄이다.
 */
import { normKey } from '../insights/serialKey.js';
import { isIPv6 } from 'node:net';
import { numOrNull } from '../util/numOrNull.js';

export const FACES = Object.freeze(['full', 'front', 'rear']);
/** 장비 종류 — 연결 대상(서버만 서비스 태그로 iDRAC 등록 서버와 잇는다, 2026-11-19 사용자 결정 '서버는 서비스 태그로'). */
export const KINDS = Object.freeze(['server', 'storage', 'network', 'san', 'other']);
export const KIND_LABEL = Object.freeze({ server: '서버', storage: '스토리지', network: '네트워크', san: 'SAN 스위치', other: '기타' });

export const LIMITS = Object.freeze({
  name: 64,            // 데이터센터 · 전산실 · 랙 · 줄 이름
  label: 96,           // 장비 표시 이름
  model: 96,
  serial: 64,
  extraSerials: 16,    // 섀시 하나에 노드 시리얼 여러 개(아이실론 H700 4노드 등)
  note: 300,
  role: 64,
  minHeightU: 1,
  maxHeightU: 60,      // 40 · 42 · 45 · 48U 를 넘는 특수 랙 여유
  maxPduPerFeed: 8,
  maxRacksPerRoom: 400,
  maxPlacesPerRack: 120,
});

// 1회차 점검 S3: C0 만 지우면 양방향(U+202A~202E · 2066~2069) · 폭 없는(U+200B~200F · 2060~2064 · FEFF) · C1(U+0080~009F) 문자가 이름에 남아
//   눈으로 같은 이름이 둘 생기고(중복 검사 통과) 이력 · 감사 화면의 글자 순서가 뒤집힌다 — 다른 입력 정리(bmusage/annotations.js 등)와 같은 문자 집합.
//   2회차: 보이지 않는 채움 문자(소프트 하이픈 U+00AD · 아랍 문자 표식 U+061C · 한글 채움 U+115F/1160/3164/FFA0 · 몽골 모음 분리 U+180E · 줄/문단 분리 U+2028/2029)도.
//   4회차 점검 보안 4: 손으로 적은 구간 목록이라 변형 선택자(U+FE00~FE0F · U+E0100~) · 태그 문자(U+E0000~) · U+034F · U+206A~206F 등 4천여 자가 남았다 —
//   눈으로 같은 이름이 중복 검사를 통과하고, 그 글자를 끼운 주소 · 시리얼이 가림을 비켜 갔다. 목록 대신 **유니코드 속성**으로 본다:
//   제어(Cc) · 서식(Cf) · 줄/문단 분리(Zl · Zp) · 기본 무시(Default_Ignorable_Code_Point — 한글 채움 · 변형 선택자 · 태그 문자 포함).
//   짝 잃은 서로게이트(Cs)도 지운다 — 남으면 자르는 자리에 따라 결과가 달라져 다시 저장할 때 '바뀐 것' 으로 판정된다(3회차 반증 B 3).
const CTRL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
/** 보이지 않는 글자를 지운 글(가림 판정 앞에서 쓴다 — 이 정리가 생기기 전에 저장된 이름에도 같은 눈으로). */
export const dropInvisible = (s) => (typeof s === 'string' ? s.replace(CTRL, '') : s);
/**
 * 전각 ASCII(U+FF01~FF5E)와 전각 공백(U+3000)을 반각으로 — 글자 수는 그대로다(1:1 · BMP).
 * 2026-11-27 반증 P4(재현): 전각으로 적은 주소 '１０.２０.３０.４' · 태그 'ＳＶＡ０００１' 는 눈에는 같은 값인데 가림 판정을 비켜 갔다.
 * 새 입력은 `cleanText` 가 저장 전에 접고, 그 전에 저장된 값은 가림 판정이 같은 눈으로 본다(`routes/api/rack.js` — 조회 계정에는 접은 글이 보인다).
 * ⚠ NFKC 전체(‘①’ → ‘1’ · ‘㈜’ → ‘(주)’)는 하지 않는다 — 사람이 적은 이름의 글자를 바꾼다. 통째 판정으로 넘어갈 때(설계 docs/design/rack-mask-redesign) 판정용 눈으로만 쓴다.
 */
const WIDE = /[\uff01-\uff5e\u3000]/;
const WIDE_G = /[\uff01-\uff5e\u3000]/g;
export const foldWidth = (s) => (typeof s === 'string' && WIDE.test(s)
  ? s.replace(WIDE_G, (c) => (c === '\u3000' ? ' ' : String.fromCharCode(c.charCodeAt(0) - 0xfee0))) : s);
/** 한 줄 문자열 정리 — 제어 · 양방향 · 폭 없는 문자 제거 · 전각 → 반각 · 앞뒤 공백 · 길이 상한. 문자열이 아니면 ''(숫자는 문자열로). */
export function cleanText(v, max) {
  const s = typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  let t = foldWidth(s.slice(0, max * 4)).replace(CTRL, ' ').trim().slice(0, max);
  // 3회차 점검 정확성 3: 자른 자리가 공백이면 끝 공백이 남았다(눈으로 같은 이름이 중복 검사를 통과 · 다시 저장하면 '바뀐 것' 으로 판정) — 자른 뒤 한 번 더 다듬는다.
  //   서로게이트 쌍의 앞 반쪽에서 잘렸으면 그 반쪽도 뺀다(깨진 글자 U+FFFD 로 저장되지 않게).
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t.trimEnd();
}

/** 정수(범위 안) — 못 읽으면 null. 소수 · 빈칸 · 범위 밖은 null(0 으로 접지 않는다). */
export function intIn(v, lo, hi) {
  const n = numOrNull(v);
  if (n == null || !Number.isInteger(n) || n < lo || n > hi) return null;
  return n;
}

/** 0 이상 수(무게 · 전력) — 비었으면 null(‘—’). 음수 · 숫자 아님은 undefined(입력 오류). */
export function nonNeg(v) {
  if (v === '' || v == null) return null;
  const n = numOrNull(v);
  if (n == null || n < 0 || n > 1e7) return undefined;
  return Math.round(n * 100) / 100;
}

/**
 * 시리얼 칸에 적힌 값이 주소(IPv4 · IPv6 · URL)인가(순수) — **입력 거절과 응답 비우기가 같은 이 함수 하나**를 쓴다(6회차 보안 4 · 반증 R6:
 * 입력 · 추가 시리얼 문자열 쪼개기 · 출력 세 곳의 판정이 달라 'node.10.20.30.97' 은 저장되고 비워졌으며, 'https://…' 는 쪼개져 그대로 보였다).
 *  · IPv4: 점으로 나뉜 1~3자리 숫자 묶음이 **4개 이상 이어짐**(라우트 가림의 `hasIpv4` 와 같은 규칙 — 앞뒤 글자와 붙어 있어도: 'bmc.10.20.30.4' · '10.20.30.4.')
 *  · IPv6: 16진 · 콜론 낱말이 유효한 IPv6(`net.isIPv6` — '::' 또는 8마디). MAC 꼴은 주소로 보지 않는다(MAC 을 시리얼로 쓰는 장비가 있다).
 *  · URL: '://' 또는 'http:' · 'https:' 로 시작.
 * 글자 수 상한을 먼저 본다(시리얼 칸은 64자 · 화면이 보내는 추가 시리얼 문자열은 그보다 길 수 있어 라우트가 낱말로 나눠 부른다).
 */
const V4_RUN = /[0-9.]{7,}/g;
function hasV4Run(v) {
  for (const m of v.matchAll(V4_RUN)) {
    let n = 0;
    for (const part of m[0].split('.')) { n = part.length >= 1 && part.length <= 3 ? n + 1 : 0; if (n >= 4) return true; }
  }
  return false;
}
export function serialAddressLike(v) {
  if (typeof v !== 'string' || !v) return false;
  const s = foldWidth(v);
  if (s.length > 512) return true;   // 이렇게 긴 시리얼은 없다 — 살피지 않고 주소로 본다(입력은 거절 · 출력은 비움)
  if (s.includes('://') || /^https?:/i.test(s)) return true;
  if (hasV4Run(s)) return true;
  if (s.includes(':')) for (const tok of s.split(/[^0-9a-fA-F:.%]+/)) { const t = tok.replace(/%.*$/, ''); if (t.split(':').length > 2 && isIPv6(t)) return true; }
  return false;
}
const SERIAL_ADDR_ERR = '시리얼 칸에는 주소(IP · URL)를 넣을 수 없습니다 — 주소는 메모에 적으세요(메모는 관리자에게만 보입니다).';

/** 시리얼 비교 키 — 시리얼 색인(insights/serialLookup.js)과 같은 정규화(대소문자 · 공백 · `:` `-` `_` `.` 무시). */
// 2026-11-27(6회차 정확성 D2): 전각으로 적힌 옛 시리얼('ＦＷ０００１２３')도 같은 키 — 새 입력은 저장 전에 접히므로(`cleanText`) 키가 폭에 따라 갈리면
//   같은 시리얼 두 장비가 중복 검사를 통과하고 등록 서버와의 연결이 끊긴다. 키를 바꿨으므로 색인 · 키 칸은 `rack/db.js PLACE_KEYS_VER` 를 올려 다시 만든다.
export const serialKeyOf = (v) => normKey(foldWidth(typeof v === 'string' ? v : String(v ?? '')));

/** 두 면이 같은 U 에서 부딪히는가. full 은 모두와, front 와 rear 는 서로 부딪히지 않는다. */
export function facesClash(a, b) {
  if (a === 'full' || b === 'full') return true;
  return a === b;
}

/** U 구간 [s, s+n-1] 두 개가 겹치는가. */
export function uOverlap(s1, n1, s2, n2) {
  return s1 <= s2 + n2 - 1 && s2 <= s1 + n1 - 1;
}

/**
 * 배치 하나가 그 랙에 놓일 수 있는가(순수).
 * @param {{heightU:number}} rack
 * @param {Array<{id:string,face:string,uStart:number,uSize:number,label?:string}>} places  그 랙의 현재 배치
 * @param {{face:string,uStart:number,uSize:number}} cand
 * @param {string} [ignoreId]  옮기는 장비 자신(자기 자리와는 겹침으로 보지 않는다)
 * @returns {null | {code:'range'|'overlap'|'input', reason:string, withId?:string}}
 */
export function placementIssue(rack, places, cand, ignoreId = '') {
  const h = Number(rack?.heightU);
  if (!FACES.includes(cand?.face)) return { code: 'input', reason: '면(전체 · 앞 · 뒤)을 알 수 없습니다.' };
  if (!Number.isInteger(cand.uStart) || !Number.isInteger(cand.uSize) || cand.uSize < 1) return { code: 'input', reason: '시작 U · 높이(U)는 1 이상의 정수여야 합니다.' };
  if (cand.uStart < 1 || cand.uStart + cand.uSize - 1 > h) {
    return { code: 'range', reason: `랙 높이(${h}U)를 벗어납니다 — U${cand.uStart}${cand.uSize > 1 ? `–${cand.uStart + cand.uSize - 1}` : ''}.` };
  }
  for (const p of places || []) {
    if (!p || p.id === ignoreId) continue;
    if (uOverlap(cand.uStart, cand.uSize, p.uStart, p.uSize) && facesClash(cand.face, p.face)) {
      const where = `U${p.uStart}${p.uSize > 1 ? `–${p.uStart + p.uSize - 1}` : ''}`;
      return { code: 'overlap', reason: `다른 장비와 겹칩니다 — ${p.label || '이름 없음'}(${where}).`, withId: p.id };
    }
  }
  return null;
}

/**
 * 랙 높이를 줄일 때 넘치는 배치(순수) — 넘치면 줄이지 않는다(장비를 조용히 지우지 않는다).
 * @returns {string[]} 넘치는 배치 id
 */
export function overflowOnResize(places, newHeightU) {
  return (places || []).filter((p) => p.uStart + p.uSize - 1 > newHeightU).map((p) => p.id);
}

/**
 * 장비 입력 정리(순수) — 요청 본문에서 아는 필드만 꺼낸다. 오류가 있으면 { error }.
 * partial=true 면 본문에 없는 필드는 결과에 넣지 않는다(수정).
 */
export function cleanPlaceInput(body = {}, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has('face')) {
    // 반증 F3: 부분 수정에서 온 빈 값 · 문자열 아닌 값을 기본값(full)으로 바꾸지 않는다 — 새로 놓을 때만 비우면 full.
    const face = cleanText(b.face, 8) || (partial ? '' : 'full');
    if (!FACES.includes(face)) return { error: '면은 full · front · rear 중 하나입니다.' };
    out.face = face;
  }
  if (!partial || has('uStart')) {
    const u = intIn(b.uStart, 1, LIMITS.maxHeightU);
    if (u == null) return { error: '시작 U 는 1 이상의 정수입니다.' };
    out.uStart = u;
  }
  if (!partial || has('uSize')) {
    const n = intIn(b.uSize, 1, LIMITS.maxHeightU);
    if (n == null) return { error: '높이(U)는 1 이상의 정수입니다 — 모르면 1U 로 가정하지 않고 입력을 받습니다.' };
    out.uSize = n;
  }
  if (!partial || has('kind')) {
    const kind = cleanText(b.kind, 16) || (partial ? '' : 'other');
    if (!KINDS.includes(kind)) return { error: '장비 종류를 알 수 없습니다.' };
    out.kind = kind;
  }
  if (!partial || has('label')) out.label = cleanText(b.label, LIMITS.label);
  if (!partial || has('model')) out.model = cleanText(b.model, LIMITS.model);
  if (!partial || has('serial')) out.serial = cleanText(b.serial, LIMITS.serial);
  if (!partial || has('extraSerials')) {
    // 화면은 추가 시리얼을 문자열 하나로 보낸다('/' · 쉼표 · 공백으로 구분). '/' 로 먼저 쪼개면 'https://bmc/ui' 가 'https:' · 'bmc' · 'ui' 가 되어 주소 판정을 비켜 갔다
    //   (6회차 정확성 D4 · 보안 4 · 화면 D2) — 공백 · 쉼표로 나눈 낱말을 먼저 판정하고 그다음 '/' 로 나눈다.
    if (typeof b.extraSerials === 'string') {
      const words = b.extraSerials.slice(0, LIMITS.serial * LIMITS.extraSerials * 4).split(/[\s,]+/);
      if (words.some(serialAddressLike)) return { error: SERIAL_ADDR_ERR };
    }
    const raw = Array.isArray(b.extraSerials) ? b.extraSerials : (typeof b.extraSerials === 'string' ? b.extraSerials.split(/[\s,/]+/) : []);
    const list = [...new Set(raw.slice(0, LIMITS.extraSerials * 4).map((x) => cleanText(x, LIMITS.serial)).filter(Boolean))];
    if (list.length > LIMITS.extraSerials) return { error: `추가 시리얼은 ${LIMITS.extraSerials}개까지입니다.` };
    out.extraSerials = list;
  }
  if (serialAddressLike(out.serial) || (out.extraSerials || []).some(serialAddressLike)) return { error: SERIAL_ADDR_ERR };
  if (!partial || has('note')) out.note = cleanText(b.note, LIMITS.note);
  for (const [k, label] of [['ratedW', '정격 전력'], ['opW', '운전 전력'], ['weightKg', '무게']]) {
    if (partial && !has(k)) continue;
    const v = nonNeg(b[k]);
    if (v === undefined) return { error: `${label}은 0 이상의 수여야 합니다(비우면 ‘—’).` };
    out[k] = v;
  }
  if ((!partial || has('label') || has('serial')) && out.label === '' && out.serial === '' && !partial) {
    return { error: '장비 이름이나 시리얼 중 하나는 있어야 합니다.' };
  }
  return { value: out };
}

/** 랙 입력 정리(순수). */
export function cleanRackInput(body = {}, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const out = {};
  if (!partial || has('name')) {
    out.name = cleanText(b.name, LIMITS.name);
    if (!out.name) return { error: '랙 이름이 비어 있습니다.' };
  }
  if (!partial || has('row')) out.row = cleanText(b.row, LIMITS.name);
  if (!partial || has('role')) out.role = cleanText(b.role, LIMITS.role);
  // 랙 종류를 고르면 높이는 종류에서 온다(저장소가 채운다) — 그때는 높이 칸이 없어도 된다(화면은 종류를 고르면 높이를 보내지 않는다).
  const typed = typeof b.typeId === 'string' && b.typeId.trim() !== '';
  if ((!partial && !typed) || has('heightU')) {
    const h = intIn(b.heightU, LIMITS.minHeightU, LIMITS.maxHeightU);
    if (h == null) return { error: `랙 높이는 ${LIMITS.minHeightU}~${LIMITS.maxHeightU}U 정수입니다.` };
    out.heightU = h;
  }
  if (!partial || has('typeId')) out.typeId = cleanText(b.typeId, 40);
  for (const k of ['pduA', 'pduB']) {
    if (partial && !has(k)) continue;
    const v = b[k] === '' || b[k] == null ? 0 : intIn(b[k], 0, LIMITS.maxPduPerFeed);
    if (v == null) return { error: `세로 PDU 수는 0~${LIMITS.maxPduPerFeed} 정수입니다.` };
    out[k] = v;
  }
  return { value: out };
}

/**
 * 랙 합계(순수) — 사용 U · 계획 전력 · 무게. 못 읽은(비어 있는) 값은 합에 넣지 않고 **몇 대 중 몇 대**인지 함께 돌려준다
 * (CLAUDE.md '못 읽은 값은 0 이 아니다' — 부분 합을 전체처럼 보이지 않게).
 * 같은 U 를 앞 · 뒤로 나눠 쓴 반깊이 장비는 U 를 한 번만 센다.
 */
export function rackTotals(rack, places) {
  const h = Number(rack?.heightU) || 0;
  const used = new Set();
  const sum = { ratedW: 0, opW: 0, weightKg: 0 };
  const read = { ratedW: 0, opW: 0, weightKg: 0 };
  let n = 0;
  for (const p of places || []) {
    n += 1;
    for (let u = p.uStart; u < p.uStart + p.uSize; u += 1) if (u >= 1 && u <= h) used.add(u);
    for (const k of Object.keys(sum)) if (p[k] != null) { sum[k] += p[k]; read[k] += 1; }
  }
  const pick = (k) => (read[k] ? Math.round(sum[k] * 100) / 100 : null);
  return {
    heightU: h, usedU: used.size, freeU: Math.max(0, h - used.size), usePct: h ? Math.round((used.size / h) * 100) : null,
    devices: n,
    ratedW: pick('ratedW'), ratedRead: read.ratedW,
    opW: pick('opW'), opRead: read.opW,
    weightKg: pick('weightKg'), weightRead: read.weightKg,
  };
}
