/**
 * v2.515 — PowerStore 활성 알람 조회 회귀(#477 로 고쳐진 결함을 테스트로 고정).
 *
 * 사용자 신고(2026-09-15, 운영 화면 캡처): `alerts: 오류: HTTP 400 — Unable to parse passed url.`
 * 원인: v2.404~2.513 이 `?filter=state.eq.ACTIVE` 를 보냈다 — 그건 **Unity 문법**
 * (`unity.js` `/api/types/alert/instances?filter=state ne 2`)이고, PowerStore 는 PostgREST
 * 계열이라 **필드명이 곧 쿼리 파라미터**(`?state=eq.ACTIVE`)다.
 *
 * 수정은 #477 이 했고 여기서는 **되돌아가지 않도록 고정**한다 — 이 수정에는 테스트가 없었다.
 *  · 소스에 `filter=` 가 다시 등장하지 않는다(문자열 회귀 가드 — 이게 결함의 전부였다).
 *  · `isActiveAlert` 의 판정: 필드가 없다고 미해결이라 단정하지 않는다(조용한 축소 금지).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isActiveAlert } from '../src/storage/collectors/powerstore.js';

const SRC = readFileSync(fileURLToPath(new URL('../src/storage/collectors/powerstore.js', import.meta.url)), 'utf8');

test('alert 쿼리에 Unity 문법(`filter=`)이 없다 — 이 한 줄이 HTTP 400 의 전부였다', () => {
  const queries = [...SRC.matchAll(/\/api\/rest\/alert\?[^'`"]+/g)].map((m) => m[0]);
  assert.ok(queries.length >= 1, 'alert 쿼리를 찾지 못했다 — 경로가 바뀌었으면 이 테스트를 갱신할 것');
  for (const q of queries) {
    assert.ok(!/[?&]filter=/.test(q), `PostgREST 가 아닌 filter= 문법이 되살아났다: ${q}`);
  }
  assert.ok(queries.some((q) => q.includes('state=eq.ACTIVE')), '서버측 활성 필터가 사라졌다');
});

test('폴백 쿼리가 함께 있다 — 필터 미지원 버전에서 알람 수집을 통째로 잃지 않게', () => {
  const queries = [...SRC.matchAll(/\/api\/rest\/alert\?[^'`"]+/g)].map((m) => m[0]);
  assert.ok(queries.some((q) => !q.includes('state=eq.')), '필터 없는 폴백 쿼리가 없다');
});

test('isActiveAlert — state 가 있으면 ACTIVE 만 활성(대소문자·공백 무시)', () => {
  assert.equal(isActiveAlert({ state: 'ACTIVE' }), true);
  assert.equal(isActiveAlert({ state: ' active ' }), true);
  assert.equal(isActiveAlert({ state: 'CLEARED' }), false);
});

test('isActiveAlert — state 가 없으면 **미해결이라 단정하지 않는다**(확인된 것만 제외)', () => {
  // 조용한 축소 금지: 필드가 없다고 전부 버리면 건수가 0 이 되어 '알람 없음' 으로 오독된다.
  assert.equal(isActiveAlert({ is_acknowledged: false }), true);
  assert.equal(isActiveAlert({}), true);
  assert.equal(isActiveAlert({ is_acknowledged: true }), false);
});
