// v2.609 — CVP 등록의 담당 엣지·DataCenter 를 기존 목록 값으로 맞춘다(오타·대소문자 방지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAgent, pickDatacenter } from '../src/cvp/formChoices.js';

const AGENTS = ['edge-Seoul', 'EDGE-PL'];
const DCS = [{ id: 'dc-kr', name: '한국 법인' }, { id: 'dc-pl', name: 'Poland' }];

test('담당 엣지: 빈 값은 중앙 직접', () => {
  assert.deepEqual(pickAgent('', AGENTS), { value: '' });
  assert.deepEqual(pickAgent('   ', AGENTS), { value: '' });
});

test('담당 엣지: 대소문자·공백만 다르면 목록 표기로 바꾼다', () => {
  assert.deepEqual(pickAgent(' EDGE-seoul ', AGENTS), { value: 'edge-Seoul' });
  assert.deepEqual(pickAgent('edge-pl', AGENTS), { value: 'EDGE-PL' });
});

test('담당 엣지: 목록에 없는 새 값은 거부한다', () => {
  assert.ok(pickAgent('edge-seol', AGENTS).error);
});

test('담당 엣지: 저장돼 있던 값을 그대로 다시 보내면 통과(다른 칸만 고치는 저장이 막히지 않게)', () => {
  assert.deepEqual(pickAgent('edge-new', AGENTS, 'Edge-New'), { value: 'Edge-New' });
  assert.ok(pickAgent('edge-other', AGENTS, 'Edge-New').error);
});

test('DataCenter: id 또는 표시명으로 받고 id 로 저장한다', () => {
  assert.deepEqual(pickDatacenter('DC-KR', DCS), { value: 'dc-kr' });
  assert.deepEqual(pickDatacenter('poland', DCS), { value: 'dc-pl' });
  assert.deepEqual(pickDatacenter('', DCS), { value: '' });
});

test('DataCenter: 목록에 없는 값은 거부, 저장값 재전송은 통과', () => {
  assert.ok(pickDatacenter('dc-kor', DCS).error);
  assert.deepEqual(pickDatacenter('dc-old', DCS, 'dc-old'), { value: 'dc-old' });
});

test('목록 인자가 배열이 아니어도 던지지 않는다', () => {
  assert.ok(pickAgent('x', null).error);
  assert.ok(pickDatacenter('x', undefined).error);
});
