/**
 * v2.583 — PDU 임계 알림의 '거짓 정상 복귀' 두 경로(감사 bug-collectors 발견, 코드로 확인):
 *  ① 수집 실패로 스냅샷이 비면 위반이 사라진 것으로 읽혀 '정상으로 돌아왔습니다' 가 나가고, 다음 정상
 *     수집에서 같은 위반이 새 알림으로 다시 나갔다 → 못 읽은 장비의 위반은 **보류**한다.
 *  ② 삭제·재배정된 장비의 경보는 해소 알림 없이 지운다(고쳐진 게 아니라 보지 않는 것).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffAlerts, forgetDeviceAlerts } from '../src/pdu/thresholds.js';

const v = (id, sev = 'warning') => ({ key: `pdu.temp.${id}.1`, severity: sev, title: 't', detail: 'd' });

test('① 못 읽은 장비의 위반은 해소되지 않는다(보류) — 읽힌 장비는 정상 해소', () => {
  const state = new Map();
  let r = diffAlerts([v('pdu-a'), v('pdu-b')], { state, now: 1000 });
  assert.equal(r.fire.length, 2);
  r = diffAlerts([], { state, now: 2000, heldDeviceIds: ['pdu-a'] });
  assert.deepEqual(r.resolve.map((x) => x.key), ['pdu.temp.pdu-b.1'], 'pdu-a 는 못 읽었으므로 해소가 아니다');
  assert.ok(state.has('pdu.temp.pdu-a.1'));
  r = diffAlerts([v('pdu-a')], { state, now: 3000, cooldownMs: 60_000 });
  assert.equal(r.fire.length, 0, '다시 읽혔을 때 같은 위반을 새 알림으로 내지 않는다');
});

test('② 대상에서 빠진 장비의 경보는 알림 없이 지운다', () => {
  const state = new Map();
  diffAlerts([v('pdu-x'), v('pdu-y')], { state, now: 1 });
  assert.equal(forgetDeviceAlerts(['pdu-x'], state), 1);
  const r = diffAlerts([v('pdu-y')], { state, now: 2, cooldownMs: 60_000 });
  assert.equal(r.resolve.length, 0, '지운 장비의 해소 알림이 없다');
});

test('보류 판정은 장비 id 구획으로만 — 접두가 같은 다른 장비를 보류하지 않는다', () => {
  const state = new Map();
  diffAlerts([v('pdu-1'), v('pdu-10')], { state, now: 1 });
  const r = diffAlerts([], { state, now: 2, heldDeviceIds: ['pdu-1'] });
  assert.deepEqual(r.resolve.map((x) => x.key), ['pdu.temp.pdu-10.1']);
});

test('경보 키 → 장비 id 정확 매칭(숫자 id 가 다른 장비의 뱅크 키에 걸리지 않는다)', async () => {
  const t = await import('../src/pdu/thresholds.js');
  assert.equal(t.deviceOfAlertKey('pdu.bank.X.1.2'), 'X');
  assert.equal(t.deviceOfAlertKey('pdu.temp.1.0'), '1');
  assert.equal(t.deviceOfAlertKey('pdu.hum.high.pdu.a.b.3'), 'pdu.a.b', '점이 든 id');
  assert.equal(t.deviceOfAlertKey('pdu.power.dev-9.1'), 'dev-9');
  assert.equal(t.deviceOfAlertKey('other.key'), '');
  const st = new Map([['pdu.bank.X.1.2', { severity: 'warning' }], ['pdu.temp.1.0', { severity: 'warning' }]]);
  t.forgetDeviceAlerts(['1'], st);
  assert.deepEqual([...st.keys()], ['pdu.bank.X.1.2'], "id '1' 을 지워도 장비 X 의 뱅크 1 경보는 남는다");
});
