/**
 * test/cvpNoLink2656.test.js — 링크가 내려간 GBIC 포트는 Tx·바이어스를 판정하지 않는다(v2.656, 사용자 승인 제안).
 *
 * 규칙: ① 링크가 내려간 것을 **확인한** 포트는 Rx·Tx·바이어스 판정 안 함, 온도·전압은 장비 임계로 계속 판정
 *       ② 포트 상태를 모르면(목록 없음·그 포트 없음) 예전 판정 그대로(Tx·바이어스 판정)
 *       ③ 이미 열린 장애는 다음 판정에서 닫힌다 — 온도·전압이 정상이면 'ok', 판정할 지표가 없으면 'no-link'(고쳐짐과 구분)
 *       ④ 링크가 올라온 포트는 예전과 같다(Tx 임계 초과면 장애)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xcvrDom, judgeOptics } from '../src/cvp/parse.js';
import { observeDevice, transition, devIdOf, NO_LINK } from '../src/cvp/faults.js';
import { alertOf as cvpFaultAlert } from '../src/cvp/faultNotify.js';

const NOW = 1_800_000_000_000;
const IV = 300_000;

/** 트랜시버 부품 하나(parseParts 가 만드는 모양 — dom·domJudge 는 xcvrDom 결과). */
function xcvr(name, flat, state = 'unknown') {
  const x = xcvrDom(flat);
  return { kind: 'xcvr', name, state, detail: x.text, dom: x.values, domJudge: { otherState: x.otherState, envState: x.envState, rxDevice: x.rxDevice } };
}
// Tx 가 장비 임계(LowAlarm) 아래 — 링크가 없어 레이저가 꺼진 포트의 전형. 온도·전압은 정상 범위.
const LASER_OFF = {
  rxPower: -40, txPower: -40, txPowerLowAlarm: -8, txPowerLowWarn: -6, txBias: 0, txBiasLowAlarm: 2,
  temperature: 35, temperatureHighAlarm: 75, voltage: 3.3, voltageLowAlarm: 3.0, voltageHighAlarm: 3.6,
};
const NO_ENV_TH = { rxPower: -40, txPower: -40, txPowerLowAlarm: -8, txBias: 0, txBiasLowAlarm: 2, temperature: 35, voltage: 3.3 };

test('xcvrDom — envState 는 온도·전압만 본다(Tx·바이어스 제외)', () => {
  const x = xcvrDom(LASER_OFF);
  assert.equal(x.otherState, 'fault', 'Tx·바이어스 포함 판정은 여전히 fault');
  assert.equal(x.envState, 'ok');
  const hot = xcvrDom({ ...LASER_OFF, temperature: 80 });
  assert.equal(hot.envState, 'fault');
  assert.equal(xcvrDom(NO_ENV_TH).envState, null, '온도·전압 임계가 없으면 판정하지 않는다(null)');
});

test('① 링크 다운 확인 포트 — Tx·바이어스 판정 안 함, 온도·전압 정상이면 ok', () => {
  const [p] = judgeOptics([xcvr('Ethernet51', LASER_OFF)], [{ name: 'Ethernet51', oper: 'down' }]);
  assert.equal(p.state, 'ok');
  assert.match(p.detail, /링크 없음 — 광량·Tx·바이어스 판정 안 함/);
  assert.equal(p.optic.linked, false);
  assert.equal(p.optic.portKnown, true);
  const [hot] = judgeOptics([xcvr('Ethernet51', { ...LASER_OFF, temperature: 80 })], [{ name: 'Ethernet51', oper: 'down' }]);
  assert.equal(hot.state, 'fault', '링크가 없어도 온도 이상은 장애다');
});

test('② 포트 상태를 모르면 예전 판정(Tx 임계 초과 = 장애)', () => {
  assert.equal(judgeOptics([xcvr('Ethernet51', LASER_OFF)], null)[0].state, 'fault');
  assert.equal(judgeOptics([xcvr('Ethernet51', LASER_OFF)], [{ name: 'Ethernet1', oper: 'up' }])[0].state, 'fault', '목록에 그 포트가 없으면 모른다');
});

test('④ 링크가 올라온 포트는 예전과 같다', () => {
  const [p] = judgeOptics([xcvr('Ethernet49', { ...LASER_OFF, rxPower: -3 })], [{ name: 'Ethernet49', oper: 'up' }]);
  assert.equal(p.state, 'fault');
});

const dev = (partsList) => ({ agent: '', cvpId: 'cvp-1', key: 'SN1', hostname: 'leaf1', collectedAt: NOW - 1000, telemetry: 'ok', streaming: true, partsList, bgpPeers: [], portsRead: true, ports: [] });
const openRow = (name) => ({ agent: '', cvpId: 'cvp-1', deviceKey: 'SN1', faultKey: `xcvr:${name}`, kind: 'xcvr', label: name, state: 'fault', detail: 'Tx 낮음', firstSeen: NOW - 86_400_000 });
function runTr(open, parts) {
  const d = dev(parts);
  const ob = { ...observeDevice(d, { intervalMs: IV, now: NOW }), agent: '', cvpId: 'cvp-1', deviceKey: 'SN1', deviceName: 'leaf1' };
  return transition({ open, observedByDevice: new Map([[devIdOf(ob), ob]]), now: NOW });
}

test('③ 열린 장애 닫기 — 온도·전압 정상이면 ok, 판정할 지표가 없으면 no-link', () => {
  const ports = [{ name: 'Ethernet51', oper: 'down' }, { name: 'Ethernet52', oper: 'down' }];
  const parts = judgeOptics([xcvr('Ethernet51', LASER_OFF), xcvr('Ethernet52', NO_ENV_TH)], ports);
  const tr = runTr([openRow('Ethernet51'), openRow('Ethernet52')], parts);
  const by = Object.fromEntries(tr.closed.map((c) => [c.label, c.closeReason]));
  assert.equal(by.Ethernet51, 'ok');
  assert.equal(by.Ethernet52, NO_LINK);
  assert.equal(tr.opened.length, 0, '링크 없는 포트는 새로 열리지 않는다');
});

test('③ 포트 상태를 모르는 unknown 트랜시버는 여전히 보류(닫지 않는다)', () => {
  const parts = judgeOptics([xcvr('Ethernet52', { rxPower: -40, temperature: 35 })], null);
  const tr = runTr([openRow('Ethernet52')], parts);
  assert.equal(tr.closed.length, 0);
  assert.equal(tr.held[0].holdReason, 'unknown');
});

test('no-link 닫힘 알림은 "해소" 라 말하지 않는다', () => {
  const a = cvpFaultAlert({ ...openRow('Ethernet52'), deviceName: 'leaf1', closeReason: NO_LINK }, { closed: true });
  assert.match(a.title, /판정 제외/);
  assert.doesNotMatch(a.detail, /해소됨/);
});
