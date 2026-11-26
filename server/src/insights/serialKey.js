/**
 * insights/serialKey.js — 시리얼 비교 키(순수 · 의존 없음).
 * 검색용 정규화: 대소문자와 구분자(`:`, `-`, `_`, 공백, `.`)를 지운다. 표시용 원문은 그대로 두고 **비교 키만** 정규화한다.
 * 시리얼 색인(serialLookup.js)과 랙 실장도(rack/)가 같은 함수를 쓴다 — 색인 모듈은 무거운 수집 모듈을 끌어오므로
 * 순수 판정만 이 파일로 뺐다(판정 코어 하나 — 사본을 만들지 말 것).
 */
export const normKey = (v) => String(v ?? '').toLowerCase().replace(/[\s:_.-]/g, '');
/** 글자 하나가 비교 키에서 지워지는 구분자인가 — normKey 와 **같은 문자 집합**(공백류 `\s` 전부 · `:` `_` `.` `-`). 랙 실장도의 시리얼 가림(rack/textMask.js)이 글자 사영에 쓴다. */
export const isKeySep = (ch) => /[\s:_.-]/.test(ch);
