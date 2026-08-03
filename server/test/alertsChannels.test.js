/**
 * 알림 확장(v2.217) — Teams 페이로드 빌더 + 전역 중복 억제 판정 테스트.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamsPayload, shouldSuppress } from '../src/alerts.js';

test('buildTeamsPayload: MessageCard 형식 + 심각도 색 + 개행 변환', () => {
  const p = buildTeamsPayload({ severity: 'critical', title: 'vCenter 다운', detail: '줄1\n줄2' }, '');
  assert.equal(p['@type'], 'MessageCard');
  assert.equal(p.themeColor, 'D73A3A');
  assert.equal(p.title, 'vCenter 다운');
  assert.match(p.text, /줄1\n\n줄2/); // Teams는 단일 \n을 무시하므로 \n\n으로
  assert.equal(buildTeamsPayload({ severity: 'warning', title: 'x' }, '').themeColor, 'E8A33D');
});

test('shouldSuppress: 창 안 재발송은 억제, 창 밖·다른 키는 통과', () => {
  const m = new Map();
  const W = 5 * 60_000;
  assert.equal(shouldSuppress(m, 'k1', 1_000_000, W), false); // 첫 발송
  assert.equal(shouldSuppress(m, 'k1', 1_000_000 + 60_000, W), true);  // 1분 뒤 → 억제
  assert.equal(shouldSuppress(m, 'k2', 1_000_000 + 60_000, W), false); // 다른 키 통과
  assert.equal(shouldSuppress(m, 'k1', 1_000_000 + W + 1, W), false);  // 창 경과 → 통과
  assert.equal(shouldSuppress(m, 'k1', 999, 0), false);   // 창 0 = 억제 끔
  assert.equal(shouldSuppress(m, '', 999, W), false);     // 키 없음 = 억제 안 함
});
