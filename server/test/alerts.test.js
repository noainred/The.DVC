import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMassPowerOff } from '../src/alerts.js';

const prev = new Map();
for (let i = 1; i <= 20; i++) prev.set(`vm-${i}`, 'POWERED_ON');

const snapWith = (offCount, vc = 'vc1') => ({
  vms: Array.from({ length: 20 }, (_, i) => ({
    id: `vm-${i + 1}`, name: `app-${i + 1}`, vcenterId: vc, host: `esxi-0${(i % 2) + 1}`,
    powerState: i < offCount ? 'POWERED_OFF' : 'POWERED_ON',
  })),
});

test('detectMassPowerOff: 임계 미만이면 알림 없음', () => {
  assert.equal(detectMassPowerOff(prev, snapWith(9), 10).length, 0);
});

test('detectMassPowerOff: 동시 10대 OFF → 위험 알림 1건', () => {
  const out = detectMassPowerOff(prev, snapWith(10), 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
  assert.match(out[0].title, /동시 다운 10대/);
  assert.equal(out[0].key, 'massoff:vc1');
});

test('detectMassPowerOff: 첫 실행(직전상태 없음)은 오탐 없음', () => {
  assert.equal(detectMassPowerOff(new Map(), snapWith(20), 10).length, 0);
});

test('detectMassPowerOff: 이미 OFF였던 VM은 전이 아님(센값 제외)', () => {
  const alreadyOff = new Map();
  for (let i = 1; i <= 20; i++) alreadyOff.set(`vm-${i}`, 'POWERED_OFF');
  assert.equal(detectMassPowerOff(alreadyOff, snapWith(20), 10).length, 0);
});

test('detectMassPowerOff: vCenter별로 분리 집계', () => {
  // 두 vCenter 각각 6대씩 OFF → 합 12지만 vCenter별 6 < 10 → 알림 없음
  const p = new Map();
  for (let i = 1; i <= 12; i++) p.set(`vm-${i}`, 'POWERED_ON');
  const snap = { vms: Array.from({ length: 12 }, (_, i) => ({
    id: `vm-${i + 1}`, name: `a${i}`, vcenterId: i < 6 ? 'vcA' : 'vcB', host: 'h1',
    powerState: 'POWERED_OFF',
  })) };
  assert.equal(detectMassPowerOff(p, snap, 10).length, 0);
});

test('detectMassPowerOff: 템플릿은 제외', () => {
  const p = new Map(); for (let i = 1; i <= 12; i++) p.set(`t-${i}`, 'POWERED_ON');
  const snap = { vms: Array.from({ length: 12 }, (_, i) => ({
    id: `t-${i + 1}`, name: `tpl${i}`, vcenterId: 'vc1', host: 'h1', template: true, powerState: 'POWERED_OFF',
  })) };
  assert.equal(detectMassPowerOff(p, snap, 10).length, 0);
});
