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
 */
import { lowSameLen, TAG_MASK_MIN } from '../util/ruleName.js';
import { normKey } from '../insights/serialKey.js';

const KEY_MAX = 64;
const isSep = (ch) => ch === ' ' || ch === ':' || ch === '_' || ch === '.' || ch === '-' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ' || ch === '　';
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

/** 글자 속 태그를 '•••' 로(비교 키 기준 — 대소문자 · 구분자 무시 · 부분 일치). 색인이 비었거나 글자가 아니면 그대로. */
export function stripTags(text, index) {
  if (typeof text !== 'string' || !text || !index || !index.set.size) return text;
  let proj = ''; const pos = [];   // 구분자를 뺀 사영과, 사영의 글자마다 원문 위치
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (isSep(ch)) continue;
    const l = ch.toLowerCase();
    proj += l.length === 1 ? l : ch; pos.push(i);
  }
  let out = ''; let from = 0; let a = 0; let any = false;
  while (a < proj.length) {
    let hit = 0;
    for (const len of index.lens) {
      if (a + len <= proj.length && index.set.has(proj.slice(a, a + len))) { hit = len; break; }
    }
    if (hit) { out += `${text.slice(from, pos[a])}•••`; from = pos[a + hit - 1] + 1; a += hit; any = true; } else a += 1;
  }
  return any ? out + text.slice(from) : text;
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

/** 글자 속 목록 항목을 `repl` 로(대소문자 무시 · 부분 일치 · 긴 것 먼저). */
export function replaceNeedles(text, index, repl) {
  if (typeof text !== 'string' || !text || !index || !index.set.size) return text;
  const low = lowSameLen(text);   // 글자마다 같은 길이 — 색인이 원문과 어긋나지 않는다
  let out = ''; let from = 0; let i = 0; let any = false;
  while (i < low.length) {
    let hit = 0;
    for (const len of index.lens) {
      if (i + len <= low.length && index.set.has(low.slice(i, i + len))) { hit = len; break; }
    }
    if (hit) { out += text.slice(from, i) + repl; i += hit; from = i; any = true; } else i += 1;
  }
  return any ? out + text.slice(from) : text;
}
