/**
 * test/cvpSlotPower2648.test.js — v2.648 슬롯 전원(카드 전원) 확인 루틴.
 *   사용자 신고: 7504N 의 `ecb › Linecard4` 가 PSU 장애 'failed' 인데 서비스는 정상 — 모듈이 없어 전원이 안 들어간 것인지,
 *   모듈은 있는데 전원이 안 들어간 것인지 가른다(장비 로그인 없이 CVP 가 가진 근거로).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const P = await import('../src/cvp/parse.js');

const ecb = (n, state = 'fault') => ({ kind: 'psu', name: `ecb › Linecard${n}`, state, detail: 'failed' });

test('slotOfPart·slotsToCheck — 라인카드 슬롯 전원 중 정상이 아닌 것만', () => {
  assert.deepEqual(P.slotOfPart(ecb(4)), { role: 'linecard', slot: 4 });
  assert.equal(P.slotOfPart({ kind: 'psu', name: 'powerSupply › PowerSupply1' }), null);
  assert.equal(P.slotOfPart({ kind: 'temp', name: 'Linecard4 › TempSensor1' }), null, 'psu 가 아니면 대상 아님');
  assert.deepEqual(P.slotsToCheck([ecb(4), ecb(3, 'ok'), ecb(4), { kind: 'psu', name: 'ecb › Fabric1', state: 'fault' }]), [4]);
});

test('judgeSlotPower — 카드 동작 중이면 장애 → 주의', () => {
  const [p] = P.judgeSlotPower([ecb(4)], { slicesRead: true, sliceKeys: ['3', '4'], slices: { 4: { intfs: 48, sampled: 8, up: 5 } } });
  assert.equal(p.state, 'warn'); assert.equal(p.slotCheck.verdict, 'card-running'); assert.equal(p.slotCheck.rawState, 'fault');
  assert.match(p.detail, /카드 동작 중/); assert.match(p.detail, /failed/, '장비 원문 값은 남긴다');
  assert.equal(p.role, 'slot-power');
});

test('judgeSlotPower — 카드 있음(up 못 봄)은 상태 유지', () => {
  const [p] = P.judgeSlotPower([ecb(4)], { slicesRead: true, sliceKeys: ['3', '4'], slices: { 4: { intfs: 48, sampled: 8, up: 0 } } });
  assert.equal(p.state, 'fault'); assert.equal(p.slotCheck.verdict, 'card-present');
  // 센서만 있어도 카드 있음
  const [q] = P.judgeSlotPower([ecb(4), { kind: 'temp', name: 'Linecard4 › TempSensor1', state: 'ok' }], { slicesRead: true, sliceKeys: ['3'] });
  assert.equal(q.slotCheck.verdict, 'card-present'); assert.equal(q.state, 'fault');
});

test('judgeSlotPower — 빈 슬롯 판단은 근거가 모두 있을 때만', () => {
  const [p] = P.judgeSlotPower([ecb(4)], { slicesRead: true, sliceKeys: ['3', '5'], slices: {} });
  assert.equal(p.state, 'absent'); assert.equal(p.slotCheck.verdict, 'slot-empty'); assert.match(p.detail, /빈 슬롯/);
  // 슬라이스 목록을 못 읽었으면 판단 안 함
  const [u] = P.judgeSlotPower([ecb(4)], { slicesRead: false });
  assert.equal(u.state, 'fault'); assert.equal(u.slotCheck.verdict, 'unknown'); assert.match(u.detail, /확인 불가/);
  // 다른 라인카드 슬라이스가 하나도 없으면(고정형 등) 판단 안 함
  const [v] = P.judgeSlotPower([ecb(4)], { slicesRead: true, sliceKeys: [] });
  assert.equal(v.slotCheck.verdict, 'unknown');
  // 이 슬롯의 트랜시버가 있으면 빈 슬롯이 아니다
  const [w] = P.judgeSlotPower([ecb(4), { kind: 'xcvr', name: 'all › Ethernet4/1/1', state: 'unknown' }], { slicesRead: true, sliceKeys: ['3'] });
  assert.equal(w.slotCheck.verdict, 'card-present');
});

test('정상 슬롯 전원·PSU 는 건드리지 않는다 · faultKey 가 바뀌지 않게 kind 유지', () => {
  const out = P.judgeSlotPower([ecb(3, 'ok'), { kind: 'psu', name: 'powerSupply › PowerSupply1', state: 'fault' }], {});
  assert.equal(out[0].state, 'ok'); assert.equal(out[0].role, 'slot-power'); assert.equal(out[0].kind, 'psu');
  assert.equal(out[1].state, 'fault'); assert.equal(out[1].slotCheck, undefined);
});

test('수집 경로 — 대상 장비에서만 슬롯 근거를 읽는다(소스)', () => {
  const src = fs.readFileSync(new URL('../src/cvp/client.js', import.meta.url), 'utf8');
  assert.match(src, /P\.slotsToCheck\(dev\.parts\)/);
  assert.match(src, /async function slotEvidence/);
  assert.match(src, /\/Sysdb\/interface\/status\/eth\/phy\/slice/);
  const edge = fs.readFileSync(new URL('../src/central/cvpEdge.js', import.meta.url), 'utf8');
  assert.match(edge, /out\.slotCheck =/);
});
