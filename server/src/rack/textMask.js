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
 *    4~5자 키는 평범한 글자 조각과 구별할 수 없다 — 시리얼 'AB12' 가 'lab 12 switch' 를 'l••• switch' 로, 'TEST' 가 'latest' 를 'la•••' 로 지웠다.
 *  · 6자 이상 키는 지금처럼 글 속 어디든 맞고(붙여 쓴 부분 일치), **구분자를 건넌 일치**는 양 끝이 낱말 경계일 때만 인정한다
 *    ('XY_56_ZW78' · 'TAG 9876' 은 가리고, 우연히 낱말들에 걸친 조각은 가리지 않는다).
 *  · 등록 주소는 점 · 콜론이 든 6자 이상(FQDN · IP)만 글 속 어디든 맞고, 그 밖(점 없는 짧은 이름)은 **호스트 이름 낱말 통째**일 때만 가린다 —
 *    등록 주소 'kr1' 이 랙 이름 'KR1-A02' 를 '(주소 가림)-A02' 로 바꿨다. 낱말 글자 = 글자 · 숫자 · '_' · '-'(점은 경계 — 'kr1.mgmt.example' 의 'kr1' 은 가린다).
 * ⚠ 대가(결정 기록 — rack/CLAUDE.md): 4~5자 시리얼을 다른 글자에 붙여 쓴 이름('SNAB12')과, 점 없는 등록 주소를 다른 이름 안에 넣은 이름('x-esx-07')은 가려지지 않는다.
 */
import { lowSameLen, TAG_MASK_MIN } from '../util/ruleName.js';
import { normKey, isKeySep } from '../insights/serialKey.js';

const KEY_MAX = 64;
/** 이 길이 미만의 시리얼 키는 낱말 통째로 맞을 때만 가린다(위 '경계 규칙'). */
export const TAG_FREE_MIN = 6;
/** 이 길이 미만이거나 점 · 콜론이 없는 등록 주소는 호스트 이름 낱말 통째로 맞을 때만 가린다. */
export const NEEDLE_FREE_MIN = 6;
const WORD_CH = /[\p{L}\p{N}]/u;
const HOST_CH = /[\p{L}\p{N}_-]/u;
const isWordCh = (ch) => ch !== undefined && WORD_CH.test(ch);
const isHostCh = (ch) => ch !== undefined && HOST_CH.test(ch);
// 구분자는 normKey 와 같은 정의 하나(3회차 점검 3: 손으로 적은 목록이라 유니코드 공백 14종 — U+2009 등 — 이 빠져, 비교 키는 같은데 가림은 못 찾았다).
const isSep = isKeySep;
const lensOf = (set) => { const l = new Set(); for (const s of set) l.add(s.length); return [...l].sort((a, b) => b - a); };   // 긴 것 먼저(짧은 것이 긴 것의 앞부분만 먹지 않게)

/** 태그 · 시리얼 원문 목록 → 찾기 색인(비교 키). 키가 TAG_MASK_MIN 자 미만이면 뺀다(흔한 글자 조각까지 가리지 않게). */
export function tagIndexOf(tags) {
  const set = new Set();
  for (const t of tags || []) {
    const k = normKey(t);
    if (k.length >= TAG_MASK_MIN && k.length <= KEY_MAX) set.add(k);
  }
  return { set, lens: lensOf(set) };
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
      for (const len of index.lens) {
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
  let proj = ''; const pos = [];   // 구분자를 뺀 사영과, 사영의 글자마다 원문 위치
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (isSep(ch)) continue;
    const l = ch.toLowerCase();
    proj += l.length === 1 ? l : ch; pos.push(i);
  }
  // 경계 규칙(머리말): 짧은 키는 낱말 통째 · 구분자를 건넌 일치는 양 끝이 낱말 경계일 때만.
  const accept = (a, b) => {
    const first = pos[a]; const last = pos[b - 1];
    const crossed = last - first !== b - a - 1;
    if (b - a >= TAG_FREE_MIN && !crossed) return true;
    const bounded = !isWordCh(text[first - 1]) && !isWordCh(text[last + 1]);
    return b - a >= TAG_FREE_MIN ? bounded : (!crossed && bounded);
  };
  const spans = matchSpans(proj, indexes, accept);
  if (!spans.length) return text;
  let out = ''; let from = 0;
  for (const [a, b] of spans) { out += `${text.slice(from, pos[a])}•••`; from = pos[b - 1] + 1; }
  return out + text.slice(from);
}

/** 글자 그대로 찾을 목록(주소 원문) → 색인. 대소문자만 무시한다. `min` 자 미만은 뺀다. */
export function needleIndexOf(strings, { min = 1, max = 255 } = {}) {
  const set = new Set();
  for (const v of strings || []) {
    const s = lowSameLen(String(v ?? '').trim());
    if (s.length >= min && s.length <= max) set.add(s);
  }
  return { set, lens: lensOf(set) };
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
    return !isHostCh(low[a - 1]) && !isHostCh(low[b]);
  };
  const spans = matchSpans(low, [index], accept);
  if (!spans.length) return text;
  let out = ''; let from = 0;
  for (const [a, b] of spans) { out += text.slice(from, a) + repl; from = b; }
  return out + text.slice(from);
}
