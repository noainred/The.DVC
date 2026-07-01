import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDatacenterId } from '../src/collector/datacenterMatch.js';

const DCS = [{ id: 'oc2', name: 'OC2' }, { id: 'seoul-dc1', name: '서울DC1' }];

test('collector.datacenter 라벨이 DataCenter id/name과 대소문자 무시로 매칭', () => {
  assert.equal(matchDatacenterId(['OC2'], DCS), 'oc2'); // 라벨 'OC2' → id 'oc2'
  assert.equal(matchDatacenterId(['oc2'], DCS), 'oc2');
  assert.equal(matchDatacenterId(['서울DC1'], DCS), 'seoul-dc1'); // name 매칭
});

test('id/name 후보 순서대로 첫 매칭 사용', () => {
  // datacenter 라벨은 안 맞지만 collector id가 DataCenter id와 일치 → 매칭.
  assert.equal(matchDatacenterId(['알수없음', 'OC2', 'OC2 수집기'], DCS), 'oc2');
});

test('아무 후보도 안 맞으면 빈 문자열(미지정)', () => {
  assert.equal(matchDatacenterId(['tokyo', ''], DCS), '');
  assert.equal(matchDatacenterId([], DCS), '');
  assert.equal(matchDatacenterId(['oc2'], []), '');
});

test('빈/공백 후보는 건너뛴다', () => {
  assert.equal(matchDatacenterId(['', '  ', 'OC2'], DCS), 'oc2');
});
