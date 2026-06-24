import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventsXml, parseObjectContent } from '../src/vcenter/soapClient.js';

test('parseEventsXml: 사용자/타입/시각 추출 (심각도는 타입명 기준 추정)', () => {
  const xml = `
    <returnval xsi:type="BadUsernameSessionEvent">
      <key>101</key>
      <createdTime>2026-06-24T00:00:00Z</createdTime>
      <userName>attacker</userName>
      <fullFormattedMessage>Cannot login user attacker@1.2.3.4</fullFormattedMessage>
    </returnval>`;
  const ev = parseEventsXml(xml);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].user, 'attacker');
  assert.equal(ev[0].type, 'BadUsernameSessionEvent');
  assert.equal(ev[0].severity, 'info');            // 타입명에 error/fail 키워드 없음 → info (분류는 loginFails 분석기 담당)
  assert.equal(ev[0].ts, Date.parse('2026-06-24T00:00:00Z'));
});

test('parseEventsXml: 타입명에 fail/error 키워드 → error, 명시 severity 우선', () => {
  const xml = `
    <returnval xsi:type="HostConnectionLostEvent"><key>1</key>
      <fullFormattedMessage>host down</fullFormattedMessage></returnval>
    <returnval xsi:type="SomeEvent"><key>2</key>
      <severity>warning</severity>
      <fullFormattedMessage>watch out</fullFormattedMessage></returnval>`;
  const ev = parseEventsXml(xml);
  assert.equal(ev[0].severity, 'error');           // 'lost'/'down' 키워드
  assert.equal(ev[1].severity, 'warning');         // 명시 <severity> 우선
});

test('parseEventsXml: 엔티티명(vm) 추출 + 다중 이벤트', () => {
  const xml = `
    <returnval xsi:type="VmPoweredOnEvent"><key>1</key>
      <fullFormattedMessage>VM started</fullFormattedMessage>
      <vm><name>web-01</name></vm></returnval>
    <returnval xsi:type="VmPoweredOffEvent"><key>2</key>
      <fullFormattedMessage>VM stopped</fullFormattedMessage>
      <vm><name>web-02</name></vm></returnval>`;
  const ev = parseEventsXml(xml);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].entity, 'web-01');
  assert.equal(ev[1].entity, 'web-02');
});

test('parseObjectContent: obj 타입/ref + 다중 propSet 파싱', () => {
  const xml = `
    <returnval>
      <obj type="VirtualMachine">vm-42</obj>
      <propSet><name>name</name><val xsi:type="xsd:string">web-01</val></propSet>
      <propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOn</val></propSet>
    </returnval>`;
  const objs = parseObjectContent(xml);
  assert.equal(objs.length, 1);
  assert.equal(objs[0].type, 'VirtualMachine');
  assert.equal(objs[0].ref, 'vm-42');
  assert.equal(objs[0].props.name, 'web-01');
  assert.equal(objs[0].props['runtime.powerState'], 'poweredOn');
});
