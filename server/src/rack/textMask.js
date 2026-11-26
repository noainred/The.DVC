/**
 * rack/textMask.js — 시리얼을 가리는 판본(범위 비관리자)에서 글자 속 서비스 태그 · 시리얼을 걷어 내는 순수 판정(의존: util/ruleName.js 뿐).
 *
 * 원장의 표시 이름(label)은 관리자가 적지만, 미배치 서버를 놓을 때 화면이 등록부 이름으로 채우므로 'idrac-<태그>' 같은 이름이 그대로 저장될 수 있다.
 * 그 이름과 그 이름으로 만든 글(변경 이력 · 판 목록 · 판 차이)에도 시리얼 가림이 닿아야 한다(1회차 점검 S1 — link 만 가리고 label 이 그대로 나갔다).
 * 한 글자에 태그가 여럿일 수 있어(법인 전체 태그 집합) 태그마다 훑지 않고, 위치마다 '태그 길이들' 만큼만 잘라 집합에서 찾는다(글자 길이 × 길이 종류 수).
 * 소문자화 · 최소 길이는 화면 가림(`svcInventory.js stripTag`)과 같은 `lowSameLen` · `TAG_MASK_MIN`.
 */
import { lowSameLen, TAG_MASK_MIN } from '../util/ruleName.js';

const TAG_MAX = 64;

/** 태그 · 시리얼 원문 목록 → 찾기 색인. 너무 짧은 것(TAG_MASK_MIN 미만)은 뺀다(흔한 글자 조각까지 가리지 않게). */
export function tagIndexOf(tags) {
  const set = new Set(); const lens = new Set();
  for (const t of tags || []) {
    const s = lowSameLen(String(t ?? '').trim());
    if (s.length >= TAG_MASK_MIN && s.length <= TAG_MAX) { set.add(s); lens.add(s.length); }
  }
  return { set, lens: [...lens].sort((a, b) => b - a) };   // 긴 것 먼저(짧은 태그가 긴 태그의 앞부분만 먹지 않게)
}

/** 글자 속 태그를 '•••' 로(대소문자 무시 · 부분 일치). 색인이 비었거나 글자가 아니면 그대로. */
export function stripTags(text, index) {
  if (typeof text !== 'string' || !text || !index || !index.set.size) return text;
  const low = lowSameLen(text);   // 글자마다 같은 길이 — 색인이 원문과 어긋나지 않는다
  let out = ''; let from = 0; let i = 0;
  while (i < low.length) {
    let hit = 0;
    for (const len of index.lens) {
      if (i + len <= low.length && index.set.has(low.slice(i, i + len))) { hit = len; break; }
    }
    if (hit) { out += `${text.slice(from, i)}•••`; i += hit; from = i; } else i += 1;
  }
  return from ? out + text.slice(from) : text;
}
