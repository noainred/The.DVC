import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventsXml, parseObjectContent, vmIps } from '../src/vcenter/soapClient.js';

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

test('vmIps: guest.net의 속성 붙은 <ipAddress xsi:type> 태그에서도 공인/다중 IP 전부 수집', () => {
  // 일부 vCenter는 배열 원소를 <ipAddress xsi:type="xsd:string"> 로 직렬화 → 속성 미허용이면
  // guest.net IP가 전부 누락되고 primary(사설)만 남던 버그. 이제 전부 수집돼야 한다.
  const netXml = '<GuestNicInfo><network>Internal</network>'
    + '<ipAddress xsi:type="xsd:string">10.0.0.5</ipAddress></GuestNicInfo>'
    + '<GuestNicInfo><network>Public</network>'
    + '<ipAddress xsi:type="xsd:string">203.0.113.42</ipAddress>'
    + '<ipConfig><ipAddress><ipAddress>203.0.113.42</ipAddress><prefixLength>28</prefixLength></ipAddress>'
    + '<ipAddress><ipAddress>fe80::1</ipAddress></ipAddress></ipConfig></GuestNicInfo>';
  const r = vmIps(netXml, '10.0.0.5');
  assert.deepEqual(r.ipAddresses, ['10.0.0.5', '203.0.113.42']); // 공인 포함, IPv6·중복 제외
  assert.equal(r.ipAddress, '10.0.0.5');
});

test('vmIps: 속성 없는 태그(기존 포맷)도 그대로 동작', () => {
  const netXml = '<GuestNicInfo><ipAddress>10.1.1.2</ipAddress><ipAddress>198.51.100.7</ipAddress></GuestNicInfo>';
  const r = vmIps(netXml, '10.1.1.2');
  assert.deepEqual(r.ipAddresses, ['10.1.1.2', '198.51.100.7']);
});

test('vmIps: 루프백·링크로컬·0.0.0.0은 제외', () => {
  const netXml = '<GuestNicInfo><ipAddress xsi:type="xsd:string">127.0.0.1</ipAddress>'
    + '<ipAddress xsi:type="xsd:string">169.254.1.1</ipAddress>'
    + '<ipAddress xsi:type="xsd:string">0.0.0.0</ipAddress>'
    + '<ipAddress xsi:type="xsd:string">203.0.113.9</ipAddress></GuestNicInfo>';
  const r = vmIps(netXml, null);
  assert.deepEqual(r.ipAddresses, ['203.0.113.9']);
});
