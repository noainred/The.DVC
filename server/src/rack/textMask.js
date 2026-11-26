/**
 * rack/textMask.js — 비관리자 판본에서 글자 속 시리얼 · 주소를 찾아 가리는 **순수 판정**(의존: util/ruleName.js · insights/serialKey.js).
 *
 * 원장의 표시 이름(label)은 관리자가 적지만, 미배치 서버를 놓을 때 화면이 등록부 이름으로 채우므로 'idrac-<태그>' · 관리 주소가 그대로 저장될 수 있다.
 * 그 이름과 그 이름으로 만든 글(변경 이력 · 판 목록 · 판 차이)에도 가림이 닿아야 한다(1회차 점검 S1). 가림 순서 · 재료는 routes/api/rack.js `textMaskOf` 하나가 정한다.
 *
 *  · `stripTags`  — 시리얼 · 서비스 태그. **연결 · 중복 판정과 같은 비교 키**(`normKey` — 대소문자 · 구분자 `공백 : _ . -` 무시)로 찾는다:
 *     글자에서 구분자를 뺀 사영을 만들어 키를 찾고, 맞은 구간의 **원문 범위**(사이에 낀 구분자 포함)를 '•••' 로 바꾼다
 *     (2회차 점검 5: 시리얼 'XY-56-ZW78' 인 장비 이름 'node XY_56_ZW78' 이 걸리지 않았다).
 *  · `replaceNeedles` — 주소 원문 목록. 대소문자만 무시하고 글자 그대로 찾는다(2회차 점검 2: 등록 주소와 대소문자만 다른 이름이 글에서 가려지지 않았다).
 * 둘 다 '위치마다 길이 종류만큼만 잘라 집합에서 찾는다'(글자 길이 × 길이 종류 수) — 목록이 수천 개여도 글 하나에 드는 일은 같다.
 *
 * ── 과잉 가림을 막는 경계 규칙(2회차 반증 C2 · C3 나 — 가림을 넓히다 정상 글자를 지웠다) ──
 *  · 시리얼 키가 `TAG_FREE_MIN`(6)자 미만이면 **낱말 통째**로 맞을 때만 가린다(붙여 쓴 그대로 · 앞뒤가 글자 · 숫자가 아님).
 *    단, 시리얼 **원문에 구분자가 있으면**('A-101' · 'AB-12') 같은 자리에 구분자를 둔 꼴도 맞는다 — 적힌 그대로 쓴 이름이 가려지지 않았다(3회차 반증 C2).
 *    원문에 없던 구분자로 띄운 것('XY56' 을 'XY-56' 으로)은 여전히 맞지 않는다(날짜 '11-26' 이 시리얼 '1126' 에 걸리지 않게).
 *    4~5자 키는 평범한 글자 조각과 구별할 수 없다 — 시리얼 'AB12' 가 'lab 12 switch' 를 'l••• switch' 로, 'TEST' 가 'latest' 를 'la•••' 로 지웠다.
 *  · 6자 이상 키는 지금처럼 글 속 어디든 맞고(붙여 쓴 부분 일치), **구분자를 건넌 일치**는 양 끝이 낱말 경계일 때만 인정한다
 *    ('XY_56_ZW78' · 'TAG 9876' 은 가리고, 우연히 낱말들에 걸친 조각은 가리지 않는다).
 *  · 등록 주소는 점 · 콜론이 든 6자 이상(FQDN · IP)만 글 속 어디든 맞고, 그 밖(점 없는 짧은 이름)은 **호스트 이름 낱말 통째**일 때만 가린다 —
 *    등록 주소 'kr1' 이 랙 이름 'KR1-A02' 를 '(주소 가림)-A02' 로 바꿨다. 낱말 글자 = 글자 · 숫자 · '_' · '-'(점은 경계 — 'kr1.mgmt.example' 의 'kr1' 은 가린다).
 *  · **낱말 경계 = 글자 체계가 바뀌는 자리**(4회차 점검 보안 3): 이웃 글자가 맞은 구간의 끝 글자와 **같은 갈래**(라틴 글자 · 숫자 / 그 밖의 글자 — 한글 · 한자 · 가나 등)일 때만
 *    낱말이 이어진 것으로 본다. 한글 조사 · 접미는 라틴 글자 값에 그대로 붙는다 — 'esx-07에 연결' · 'TAG-9874번 서버' · 'A1B2J번 장비' 가 글자(`\p{L}`) 이웃이라는 이유로 가려지지 않았다.
 * ⚠ 대가(결정 기록 — rack/CLAUDE.md): 4~5자 시리얼을 다른 **라틴 글자 · 숫자**에 붙여 쓴 이름('SNAB12')과, 점 없는 등록 주소를 다른 이름 안에 넣은 이름('x-esx-07')은 가려지지 않는다.
 */
import { lowSameLen, TAG_MASK_MIN } from '../util/ruleName.js';
import { isKeySep } from '../insights/serialKey.js';

const KEY_MAX = 64;
/** 이 길이 미만의 시리얼 키는 낱말 통째로 맞을 때만 가린다(위 '경계 규칙'). */
export const TAG_FREE_MIN = 6;
/** 이 길이 미만이거나 점 · 콜론이 없는 등록 주소는 호스트 이름 낱말 통째로 맞을 때만 가린다. */
export const NEEDLE_FREE_MIN = 6;
const LATIN_CH = /[\p{Script=Latin}\p{Nd}]/u;
const OTHER_CH = /[\p{L}\p{N}]/u;
/** 글자의 갈래 — 1 라틴 글자 · 숫자 / 2 그 밖의 글자(한글 · 한자 · 가나 …) / 0 글자가 아님(없음 포함). */
export const charKind = (ch) => (ch === undefined || ch === '' ? 0 : LATIN_CH.test(ch) ? 1 : OTHER_CH.test(ch) ? 2 : 0);
/**
 * 이웃 글자 `nb` 가 끝 글자 `edge` 와 한 낱말로 이어지는가 — 이웃이 글자 · 숫자이고, 끝 글자와 **갈래가 다르지 않을** 때.
 * 끝 글자가 글자 · 숫자가 아니면(문장 부호로 끝나는 값) 이웃이 글자이기만 하면 이어진 것으로 본다(경계로 인정하는 것은 '라틴 ↔ 그 밖의 글자' 가 맞닿은 자리뿐).
 */
const joins = (edge, nb) => { const k = charKind(nb); if (k === 0) return false; const e = charKind(edge); return e === 0 || e === k; };
/** 호스트 이름 낱말로 이어지는가 — `_` · `-` 는 늘 이어지고, 글자는 같은 갈래일 때만. */
const hostJoins = (edge, nb) => nb === '_' || nb === '-' || joins(edge, nb);

/** 글 → 구분자를 뺀 사영(글자마다 소문자 — 길이가 달라지는 글자는 그대로)과 사영 글자마다의 원문 위치. 태그 색인의 키도 **같은 함수**로 만든다. */
function projOf(text) {
  let proj = ''; const pos = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (isSep(ch)) continue;
    const l = ch.toLowerCase();
    proj += l.length === 1 ? l : ch; pos.push(i);
  }
  return { proj, pos };
}
// 구분자는 normKey 와 같은 정의 하나(3회차 점검 3: 손으로 적은 목록이라 유니코드 공백 14종 — U+2009 등 — 이 빠져, 비교 키는 같은데 가림은 못 찾았다).
const isSep = isKeySep;
const lensOf = (set) => { const l = new Set(); for (const s of set) l.add(s.length); return [...l].sort((a, b) => b - a); };   // 긴 것 먼저(짧은 것이 긴 것의 앞부분만 먹지 않게)

/** 사영 구간 [a, b) 의 '구분자 자리 모양' — 키 글자 사이에 구분자가 끼어 있는 자리(키 안의 위치)를 쉼표로 이은 글자. 붙여 쓴 것은 ''. */
function shapeOf(pos, a, b) {
  let sh = '';
  for (let i = a + 1; i < b; i += 1) if (pos[i] !== pos[i - 1] + 1) sh += `${i - a},`;
  return sh;
}

/**
 * 태그 · 시리얼 원문 목록 → 찾기 색인(비교 키). 키가 TAG_MASK_MIN 자 미만이면 뺀다(흔한 글자 조각까지 가리지 않게).
 * 키는 글의 사영과 **같은 함수**(`projOf`)로 만든다 — ASCII 에서는 `normKey` 와 같고, 문자열 통째 소문자화가 글자마다 소문자화와 다른 글자
 * (낱말 끝 그리스 시그마 · 'İ')에서도 글과 키가 어긋나지 않는다(4회차 점검 보안 관찰 2).
 */
export function tagIndexOf(tags) {
  const set = new Set(); const shapes = new Map();   // shapes: 짧은 키 → 원문에 구분자가 있던 자리 모양들(머리말 '경계 규칙')
  for (const t of tags || []) {
    const { proj: k, pos } = projOf(String(t ?? ''));
    if (k.length < TAG_MASK_MIN || k.length > KEY_MAX) continue;
    set.add(k);
    if (k.length >= TAG_FREE_MIN) continue;
    const sh = shapeOf(pos, 0, k.length);
    if (!sh) continue;
    let g = shapes.get(k); if (!g) { g = new Set(); shapes.set(k, g); }
    g.add(sh);
  }
  return { set, lens: lensOf(set), shapes };
}

/**
 * 사영 `proj` 에서 색인들의 키가 맞는 구간을 **전부** 찾아 합친다([시작, 끝) — 사영 위치 · 겹치거나 맞닿으면 하나로).
 * 위치마다 색인별로 가장 긴 **인정되는** 일치를 표시하고 건너뛰지 않는다 — 앞에서 시작한 짧은 키가 뒤 키의 앞부분을 먹어 꼬리가 남던 것을 막는다
 * (3회차 점검 정확성 1: 시리얼 '1234' 인 장비 이름 'next to SN12345678' → 'next to SN•••5678' 로 다른 장비 시리얼의 일부가 남았다).
 * `accept(a, b)` 가 거짓이면 그 길이는 버리고 더 짧은 키를 본다(경계 규칙 — 긴 키가 경계에 걸려 떨어져도 같은 자리의 짧은 키는 맞을 수 있다).
 */
function matchSpans(proj, indexes, accept) {
  const spans = [];
  for (let a = 0; a < proj.length; a += 1) {
    let end = 0;
    for (const index of indexes) {
      if (!index || !index.set.size) continue;
      // 앞머리 색인이 있으면(주소 목록) 이 자리의 앞 몇 글자로 시작하는 항목의 길이 종류만 본다 — 없으면 그 자리는 건너뛴다.
      const lens = index.heads ? index.heads.get(proj.slice(a, a + index.headLen)) : index.lens;
      if (!lens) continue;
      for (const len of lens) {
        if (a + len <= end) break;   // 이 색인의 남은 길이는 더 짧다 — 이미 표시한 구간 안
        if (a + len <= proj.length && index.set.has(proj.slice(a, a + len)) && (!accept || accept(a, a + len))) { end = a + len; break; }
      }
    }
    if (!end) continue;
    const last = spans[spans.length - 1];
    if (last && a <= last[1]) { if (end > last[1]) last[1] = end; } else spans.push([a, end]);
  }
  return spans;
}

/**
 * 글자 속 태그를 '•••' 로(비교 키 기준 — 대소문자 · 구분자 무시 · 부분 일치). 색인을 여럿 주면 **한 번에** 훑는다(그 장비의 시리얼 + 법인 전체 — 따로 훑으면
 * 먼저 걷어 낸 짧은 키가 긴 키를 깨뜨린다). 색인이 비었거나 글자가 아니면 그대로.
 */
export function stripTags(text, ...indexes) {
  if (typeof text !== 'string' || !text || !indexes.some((x) => x && x.set.size)) return text;
  const { proj, pos } = projOf(text);   // 구분자를 뺀 사영과, 사영의 글자마다 원문 위치
  // 경계 규칙(머리말): 짧은 키는 낱말 통째 · 구분자를 건넌 일치는 양 끝이 낱말 경계일 때만.
  const accept = (a, b) => {
    const first = pos[a]; const last = pos[b - 1];
    const crossed = last - first !== b - a - 1;
    if (b - a >= TAG_FREE_MIN && !crossed) return true;
    if (joins(text[first], text[first - 1]) || joins(text[last], text[last + 1])) return false;
    if (b - a >= TAG_FREE_MIN || !crossed) return true;
    // 짧은 키가 구분자를 건넜다 — 그 시리얼의 원문이 같은 자리에 구분자를 둔 꼴일 때만
    const sh = shapeOf(pos, a, b); const key = proj.slice(a, b);
    return indexes.some((x) => !!x && !!x.shapes && !!x.shapes.get(key)?.has(sh));
  };
  const spans = matchSpans(proj, indexes, accept);
  if (!spans.length) return text;
  let out = ''; let from = 0;
  for (const [a, b] of spans) { out += `${text.slice(from, pos[a])}•••`; from = pos[b - 1] + 1; }
  return out + text.slice(from);
}

const HEAD_LEN = 3;
/**
 * 글자 그대로 찾을 목록(주소 원문) → 색인. 대소문자만 무시한다. `min` 자 미만은 뺀다.
 * `heads` = 앞머리(앞 `headLen` 글자) → 그 앞머리로 시작하는 항목의 길이 종류(긴 것 먼저). 관리 주소는 길이 종류가 많다(IP 7~15자 · FQDN · 'https://' 붙은 꼴 —
 *   7,000대 등록부에서 60종 이상). 위치마다 길이 종류를 전부 잘라 보면 '글 길이 × 길이 종류' 가 된다(3회차 점검 성능 2 — 96자 글 12,100개에 4.9초 · 실측).
 *   앞머리가 맞는 자리에서만 그 묶음의 길이를 본다.
 */
export function needleIndexOf(strings, { min = 1, max = 255 } = {}) {
  const set = new Set();
  for (const v of strings || []) {
    const s = lowSameLen(String(v ?? '').trim());
    if (s.length >= min && s.length <= max) set.add(s);
  }
  let headLen = HEAD_LEN;
  for (const s of set) if (s.length < headLen) headLen = s.length;
  const groups = new Map();
  for (const s of set) { const h = s.slice(0, headLen); let g = groups.get(h); if (!g) { g = new Set(); groups.set(h, g); } g.add(s.length); }
  const heads = new Map();
  for (const [h, g] of groups) heads.set(h, [...g].sort((a, b) => b - a));
  return { set, lens: lensOf(set), heads, headLen };
}

/**
 * 글자 속 목록 항목을 `repl` 로(대소문자 무시). 겹치는 항목은 구간을 합쳐 한 번에 바꾼다(앞 항목이 뒤 항목의 앞부분만 먹어 꼬리가 남지 않게).
 * 점 · 콜론이 든 `NEEDLE_FREE_MIN` 자 이상 항목(FQDN · IP)은 글 속 어디든, 그 밖은 호스트 이름 낱말 통째일 때만(머리말 '경계 규칙').
 */
export function replaceNeedles(text, index, repl) {
  if (typeof text !== 'string' || !text || !index || !index.set.size) return text;
  const low = lowSameLen(text);   // 글자마다 같은 길이 — 색인이 원문과 어긋나지 않는다
  const accept = (a, b) => {
    if (b - a >= NEEDLE_FREE_MIN) { for (let i = a; i < b; i += 1) if (low[i] === '.' || low[i] === ':') return true; }
    return !hostJoins(low[a], low[a - 1]) && !hostJoins(low[b - 1], low[b]);
  };
  const spans = matchSpans(low, [index], accept);
  if (!spans.length) return text;
  let out = ''; let from = 0;
  for (const [a, b] of spans) { out += text.slice(from, a) + repl; from = b; }
  return out + text.slice(from);
}
