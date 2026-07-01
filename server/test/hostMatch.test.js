import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findHostByServiceTag } from '../src/idrac/hostMatch.js';

const hosts = [
  { name: 'esxi-a', vcenterId: 'OC2', serviceTag: '1M6YK93', cluster: 'MI-DataAPI' },
  { name: 'esxi-b', vcenterId: 'MI', serviceTag: 'ABC1234' },
  { name: 'esxi-noTag', vcenterId: 'MI', serviceTag: '' },
];

test('서비스태그(=일련번호)로 vCenter 호스트 매칭', () => {
  assert.equal(findHostByServiceTag('1M6YK93', hosts).name, 'esxi-a');
  assert.equal(findHostByServiceTag('ABC1234', hosts).name, 'esxi-b');
});

test('대소문자·공백 무시 매칭', () => {
  assert.equal(findHostByServiceTag('  1m6yk93 ', hosts).name, 'esxi-a');
  assert.equal(findHostByServiceTag('abc1234', hosts).name, 'esxi-b');
});

test('매칭 없거나 빈 태그는 null', () => {
  assert.equal(findHostByServiceTag('NOPE999', hosts), null);
  assert.equal(findHostByServiceTag('', hosts), null);
  assert.equal(findHostByServiceTag(null, hosts), null);
  // 태그 없는 호스트가 빈 태그 조회에 잘못 매칭되면 안 됨.
  assert.equal(findHostByServiceTag('', hosts), null);
});
