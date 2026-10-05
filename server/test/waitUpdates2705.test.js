// v2.705(B1) — WaitForUpdatesEx 증분 수집(기본 꺼짐). ① 파서·적용(순수) ② 가짜 vCenter 로 enter/modify/leave·부분 변경 재조회·
// 잘림·세션 만료·로그인 거부 쉬기·접속처 변경 ③ 수집기 연결(소스) — 실패하면 그 주기는 전체 조회로 받는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { parseUpdateSet, applyChanges, inventoryViaUpdates, closeAllUpdateSessions, updateSessionStatus } from '../src/vcenter/updateSession.js';
import { VimSoapClient } from '../src/vcenter/soapClient.js';
import { config } from '../src/config.js';

const ENV = (b) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${b}</soapenv:Body></soapenv:Envelope>`;
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring><detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const cs = (name, op, val) => `<changeSet><name>${name}</name><op>${op}</op>${val == null ? '' : `<val xsi:type="xsd:string">${val}</val>`}</changeSet>`;
const os = (kind, ref, sets) => `<objectSet><kind>${kind}</kind><obj type="VirtualMachine">${ref}</obj>${sets.join('')}</objectSet>`;
const US = (version, objs, truncated = false) => ENV(`<WaitForUpdatesExResponse xmlns="urn:vim25"><returnval><version>${version}</version><filterSet><filter type="PropertyFilter">f1</filter>${objs.join('')}</filterSet>${truncated ? '<truncated>true</truncated>' : ''}</returnval></WaitForUpdatesExResponse>`);
const NONE = ENV('<WaitForUpdatesExResponse xmlns="urn:vim25"></WaitForUpdatesExResponse>');
const TYPES = ['VirtualMachine'];
const SPECS = [{ type: 'VirtualMachine', paths: ['name', 'runtime.powerState', 'config.hardware.device'] }];

test('① parseUpdateSet — enter/modify/leave · 값 없는 assign · 잘림 · 결과 없음', () => {
  const u = parseUpdateSet(US('3', [os('enter', 'vm-1', [cs('name', 'assign', 'a &amp; b')]), os('modify', 'vm-2', [cs('runtime.powerState', 'assign')]), os('leave', 'vm-3', [])], true));
  assert.equal(u.version, '3'); assert.equal(u.truncated, true);
  assert.deepEqual(u.objects.map((o) => [o.kind, o.ref]), [['enter', 'vm-1'], ['modify', 'vm-2'], ['leave', 'vm-3']]);
  assert.equal(u.objects[0].changes[0].val, 'a & b');
  assert.equal(u.objects[1].changes[0].hasVal, false);
  assert.equal(parseUpdateSet(NONE), null);
  assert.equal(parseUpdateSet(US('4', [])).truncated, false);
});

test('① applyChanges — 요청 경로와 같을 때만 적용, 더 깊은 경로·add 는 다시 읽음', () => {
  const paths = new Set(SPECS[0].paths);
  const o = { props: { name: 'x', 'runtime.powerState': 'poweredOn' } };
  assert.equal(applyChanges(o, [{ name: 'name', op: 'assign', hasVal: true, val: 'y' }, { name: 'runtime.powerState', op: 'assign', hasVal: false }], paths), false);
  assert.deepEqual(o.props, { name: 'y' });
  assert.equal(applyChanges(o, [{ name: 'config.hardware.device[4000].backing', op: 'assign', hasVal: true, val: '<x/>' }], paths), true);
  assert.equal(applyChanges(o, [{ name: 'config.hardware.device', op: 'add', hasVal: true, val: '<x/>' }], paths), true);
  assert.equal(applyChanges(o, [{ name: 'name', op: 'remove', hasVal: false }], paths), false);
  assert.equal(o.props.name, undefined);
});

async function fakeVc(script) {
  const st = { calls: [], logins: 0, step: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const op = /<(\w+) xmlns="urn:vim25">/.exec(b)?.[1] || '?';
      st.calls.push({ op, body: b });
      const send = (code, x) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(x); };
      if (op === 'RetrieveServiceContent') return send(200, ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval><rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager></returnval></RetrieveServiceContentResponse>'));
      if (op === 'Login') { st.logins += 1; if (script.loginFail) return send(500, FAULT('InvalidLogin', 'Cannot complete login')); return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s</key></returnval></LoginResponse>')); }
      if (op === 'Logout') return send(200, ENV('<LogoutResponse xmlns="urn:vim25"/>'));
      if (op === 'CreatePropertyCollector') return send(200, ENV('<CreatePropertyCollectorResponse xmlns="urn:vim25"><returnval type="PropertyCollector">session[1]pc</returnval></CreatePropertyCollectorResponse>'));
      if (op === 'CreateContainerView') return send(200, ENV('<CreateContainerViewResponse xmlns="urn:vim25"><returnval type="ContainerView">session[1]view</returnval></CreateContainerViewResponse>'));
      if (op === 'CreateFilter') return send(200, ENV('<CreateFilterResponse xmlns="urn:vim25"><returnval type="PropertyFilter">session[1]f1</returnval></CreateFilterResponse>'));
      if (op === 'DestroyPropertyCollector') return send(200, ENV('<DestroyPropertyCollectorResponse xmlns="urn:vim25"/>'));
      if (op === 'WaitForUpdatesEx') { const r = script.wait(/<version>([^<]*)<\/version>/.exec(b)[1], st); return send(r[0], r[1]); }
      if (op === 'RetrievePropertiesEx' || op === 'RetrieveProperties') return send(200, script.retrieve(b, st));
      return send(500, FAULT('MethodFault', op));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const vc = { id: `vc-${srv.address().port}`, host: `http://127.0.0.1:${srv.address().port}`, username: 'u', password: 'p' };
  return { vc, st, close: () => new Promise((r) => srv.close(r)) };
}
const mk = (v) => new VimSoapClient(v);
const run = (vc) => inventoryViaUpdates(vc, TYPES, SPECS, { makeClient: mk });
const byRef = (objs) => Object.fromEntries(objs.map((o) => [o.ref, o.props]));

test('② 첫 호출 전체 → 바뀐 것만 적용 · 깊은 변경은 그 객체만 다시 읽음 · leave 삭제 · 변화 없음은 그대로', async () => {
  const { vc, st, close } = await fakeVc({
    wait: (ver) => {
      if (ver === '') return [200, US('1', ['vm-1', 'vm-2', 'vm-3'].map((r) => os('enter', r, [cs('name', 'assign', r), cs('runtime.powerState', 'assign', 'poweredOn')])))];
      if (ver === '1') return [200, US('2', [os('modify', 'vm-1', [cs('name', 'assign', 'renamed')]), os('modify', 'vm-2', [cs('config.hardware.device[4000].backing', 'assign', 'x')]), os('leave', 'vm-3', [])])];
      return [200, NONE];
    },
    retrieve: (b) => {
      assert.match(b, /<obj type="VirtualMachine">vm-2<\/obj>/); assert.doesNotMatch(b, /vm-1|vm-3/);
      return ENV('<RetrievePropertiesResponse xmlns="urn:vim25"><returnval><obj type="VirtualMachine">vm-2</obj><propSet><name>name</name><val xsi:type="xsd:string">vm-2</val></propSet><propSet><name>config.hardware.device</name><val xsi:type="xsd:string">NEW</val></propSet></returnval></RetrievePropertiesResponse>');
    },
  });
  try {
    const a = byRef(await run(vc));
    assert.deepEqual(Object.keys(a).sort(), ['vm-1', 'vm-2', 'vm-3']);
    assert.equal(updateSessionStatus().sessions[vc.id].stats.mode, 'initial');
    const b = byRef(await run(vc));
    assert.deepEqual(Object.keys(b).sort(), ['vm-1', 'vm-2']);
    assert.equal(b['vm-1'].name, 'renamed'); assert.equal(b['vm-1']['runtime.powerState'], 'poweredOn');
    assert.deepEqual(b['vm-2'], { name: 'vm-2', 'config.hardware.device': 'NEW' });
    const s = updateSessionStatus().sessions[vc.id].stats;
    assert.equal(s.mode, 'incremental'); assert.equal(s.refetched, 1);
    const c = byRef(await run(vc));
    assert.deepEqual(c, b);
    assert.equal(st.logins, 1, '세션은 한 번만 로그인한다');
    assert.equal(st.calls.filter((x) => x.op === 'CreateFilter').length, 1);
  } finally { await closeAllUpdateSessions(); await close(); }
});

test('② 잘림 — truncated 면 같은 호출 안에서 이어 받는다', async () => {
  const { vc, close } = await fakeVc({
    wait: (ver) => (ver === '' ? [200, US('a', [os('enter', 'vm-1', [cs('name', 'assign', 'one')])], true)]
      : ver === 'a' ? [200, US('b', [os('enter', 'vm-2', [cs('name', 'assign', 'two')])])] : [200, NONE]),
    retrieve: () => { throw new Error('재조회 없음'); },
  });
  try {
    assert.deepEqual(Object.keys(byRef(await run(vc))).sort(), ['vm-1', 'vm-2']);
  } finally { await closeAllUpdateSessions(); await close(); }
});

test('② 세션 만료(NotAuthenticated) — 던지고 상태를 버린 뒤 다음 호출은 처음부터', async () => {
  let expire = false;
  const { vc, st, close } = await fakeVc({
    wait: (ver) => (expire ? [500, FAULT('NotAuthenticated', 'The session is not authenticated.')]
      : ver === '' ? [200, US('1', [os('enter', 'vm-1', [cs('name', 'assign', 'one')])])] : [200, NONE]),
    retrieve: () => { throw new Error('x'); },
  });
  try {
    await run(vc);
    expire = true;
    await assert.rejects(run(vc), /not authenticated/);
    assert.ok(st.calls.some((c) => c.op === 'DestroyPropertyCollector'), '버릴 때 수집기를 지운다');
    expire = false;
    assert.equal(Object.keys(byRef(await run(vc))).length, 1);
    assert.equal(st.logins, 2);
    assert.equal(st.calls.filter((c) => c.op === 'WaitForUpdatesEx').at(-1).body.includes('<version></version>'), true);
  } finally { await closeAllUpdateSessions(); await close(); }
});

test('② 로그인 거부 — 쉬는 동안 다시 로그인하지 않는다(계정 잠금 방지) · 접속처가 바뀌면 다시 시도', async () => {
  const { vc, st, close } = await fakeVc({ loginFail: true, wait: () => [200, NONE], retrieve: () => '' });
  try {
    await assert.rejects(run(vc), /인증 실패|InvalidLogin/);
    await assert.rejects(run(vc));
    await assert.rejects(run(vc));
    assert.equal(st.logins, 1, '쉬는 동안 로그인 0회');
    await assert.rejects(run({ ...vc, password: 'changed-password' }));
    assert.equal(st.logins, 2, '자격증명이 바뀌면 다시 시도한다');
  } finally { await closeAllUpdateSessions(); await close(); }
});

test('② 접속처 변경 — 옛 세션을 정리하고 새로 연다', async () => {
  const { vc, st, close } = await fakeVc({ wait: (ver) => (ver === '' ? [200, US('1', [os('enter', 'vm-1', [cs('name', 'assign', 'one')])])] : [200, NONE]), retrieve: () => '' });
  try {
    await run(vc);
    await run({ ...vc, username: 'other' });
    assert.ok(st.calls.some((c) => c.op === 'DestroyPropertyCollector'));
    assert.equal(st.logins, 2);
  } finally { await closeAllUpdateSessions(); await close(); }
});

test('③ 수집기 연결 — 기본 꺼짐 · 실패하면 그 주기는 전체 조회 · abort 는 그대로 던진다', () => {
  assert.equal(config.vcWaitUpdates, process.env.VC_WAIT_UPDATES === 'true');
  const src = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(src, /if \(config\.vcWaitUpdates\) \{/);
  assert.match(src, /if \(signal\?\.aborted\) throw err;/);
  assert.match(src, /if \(!objs\) objs = await c\.retrieveProperties\(await c\.createContainerView\(INV_TYPES\), INV_SPECS\);/);
  // 순환 import 를 만들지 않는다(클라이언트는 호출자가 만든다)
  assert.doesNotMatch(fs.readFileSync(new URL('../src/vcenter/updateSession.js', import.meta.url), 'utf8'), /from '\.\/soapClient\.js'/);
});

test('② 다시 enter 된 객체는 이전 속성을 남기지 않는다(enter 는 전체 값이다)', async () => {
  const { vc, close } = await fakeVc({
    wait: (ver) => (ver === '' ? [200, US('1', [os('enter', 'vm-1', [cs('name', 'assign', 'one'), cs('runtime.powerState', 'assign', 'poweredOn')])])]
      : ver === '1' ? [200, US('2', [os('enter', 'vm-1', [cs('name', 'assign', 'one')])])] : [200, NONE]),
    retrieve: () => '',
  });
  try {
    await run(vc);
    assert.deepEqual(byRef(await run(vc))['vm-1'], { name: 'one' });
  } finally { await closeAllUpdateSessions(); await close(); }
});
