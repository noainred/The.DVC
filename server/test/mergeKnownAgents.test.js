import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeKnownAgents } from '../src/central/assignments.js';

test('mergeKnownAgents: 수집 서버/보고/할당을 대소문자 무시로 병합', () => {
  const merged = mergeKnownAgents({
    assignments: [{ agent: 'Seoul-DC1' }, { agent: 'OC2Sandbox' }],
    results: { 'busan-dc2': { at: 1 }, 'seoul-dc1': { at: 2 } },
    collectors: [{ id: 'oc2sandbox', name: 'OC2Sandbox' }, { id: 'tokyo', name: 'Tokyo' }],
  });
  const byLower = new Map(merged.map((m) => [m.name.toLowerCase(), m]));

  // 대소문자만 다른 중복은 하나로 합쳐진다.
  assert.equal(merged.filter((m) => m.name.toLowerCase() === 'seoul-dc1').length, 1);
  assert.equal(merged.filter((m) => m.name.toLowerCase() === 'oc2sandbox').length, 1);

  // 수집 서버 출처가 우선(권위 있는 실제 AGENT_NAME 표기).
  assert.equal(byLower.get('oc2sandbox').source, 'collector');
  assert.equal(byLower.get('oc2sandbox').name, 'OC2Sandbox');
  assert.equal(byLower.get('tokyo').source, 'collector');

  // 수집 서버로 없고 보고만 된 에이전트는 reported.
  assert.equal(byLower.get('busan-dc2').source, 'reported');

  // 이름 오름차순 정렬.
  const names = merged.map((m) => m.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

test('mergeKnownAgents: 빈 입력/공백 이름은 무시', () => {
  assert.deepEqual(mergeKnownAgents(), []);
  const merged = mergeKnownAgents({ assignments: [{ agent: '  ' }, { agent: '' }], collectors: [{ id: '', name: '' }] });
  assert.deepEqual(merged, []);
});
