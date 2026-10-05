// v2.704(B2) — 속성 조회 페이징(RetrievePropertiesEx + ContinueRetrievePropertiesEx).
// ① 응답 변환(순수) ② 예전 RetrieveProperties 결과와 **같은 결과**(동일성) ③ 가짜 vCenter 로 토큰 루프·취소·폴백·끄기·페이지 상한.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { retrieveResultToObjectXml, parseObjectContent } from '../src/vcenter/soapParse.js';
import { VimSoapClient } from '../src/vcenter/soapClient.js';
import { config } from '../src/config.js';

const ENV = (b) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${b}</soapenv:Body></soapenv:Envelope>`;
const objXml = (i) => `<obj type="VirtualMachine">vm-${i}</obj>`
  + `<propSet><name>name</name><val xsi:type="xsd:string">web${i} &amp; co</val></propSet>`
  + `<propSet><name>config.annotation</name><val xsi:type="xsd:string">&lt;token&gt;fake&lt;/token&gt;</val></propSet>`
  + `<propSet><name>config.hardware.device</name><val xsi:type="ArrayOfVirtualDevice"/></propSet>`;
const N = 23;
const legacyXml = () => ENV(`<RetrievePropertiesResponse xmlns="urn:vim25">${Array.from({ length: N }, (_, i) => `<returnval>${objXml(i)}</returnval>`).join('')}</RetrievePropertiesResponse>`);
const page = (from, size, token, cont = false) => {
  const objs = Array.from({ length: Math.max(0, Math.min(size, N - from)) }, (_, k) => `<objects>${objXml(from + k)}</objects>`).join('');
  const tag = cont ? 'ContinueRetrievePropertiesExResponse' : 'RetrievePropertiesExResponse';
  return ENV(`<${tag} xmlns="urn:vim25"><returnval>${token ? `<token>${token}</token>` : ''}${objs}</returnval></${tag}>`);
};
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring><detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);

test('① 변환 — token 은 첫 objects 앞만, objects 는 returnval 로, 빈 결과·옛 모양', () => {
  const r = retrieveResultToObjectXml(page(0, 3, 'T-1'));
  assert.equal(r.token, 'T-1');
  assert.equal(parseObjectContent(r.xml).length, 3);
  // 값 안의 이스케이프된 <token> 은 토큰이 아니다(마지막 페이지)
  const last = retrieveResultToObjectXml(page(20, 3, null, true));
  assert.equal(last.token, null);
  assert.equal(parseObjectContent(last.xml).length, 3);
  // 속성 값 안의 진짜 <token> 원소(구조형 값)도 토큰이 아니다 — 첫 objects 앞만 본다
  const nested = ENV('<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval><objects><obj type="VirtualMachine">vm-9</obj>'
    + '<propSet><name>x</name><val xsi:type="Foo"><token>NOT-A-TOKEN</token></val></propSet></objects></returnval></RetrievePropertiesExResponse>');
  assert.equal(retrieveResultToObjectXml(nested).token, null);
  // 결과 없음
  assert.deepEqual(retrieveResultToObjectXml(ENV('<RetrievePropertiesExResponse xmlns="urn:vim25"></RetrievePropertiesExResponse>')), { xml: '', token: null });
  assert.deepEqual(retrieveResultToObjectXml(null), { xml: '', token: null });
  // 옛 RetrieveProperties 모양으로 답하는 서버도 읽는다
  assert.equal(parseObjectContent(retrieveResultToObjectXml(legacyXml()).xml).length, N);
});

test('② 동일성 — 페이지로 받은 결과 == RetrieveProperties 한 번의 결과(페이지 크기 1·4·23·100)', () => {
  const want = parseObjectContent(legacyXml());
  assert.equal(want.length, N);
  for (const size of [1, 4, 23, 100]) {
    const got = [];
    for (let from = 0, n = 0; from < N || n === 0; from += size, n++) {
      const more = from + size < N;
      const { xml } = retrieveResultToObjectXml(page(from, size, more ? `T${n}` : null, n > 0));
      got.push(...parseObjectContent(xml));
      if (!more) break;
    }
    assert.deepEqual(got, want, `페이지 크기 ${size}`);
  }
});

async function fakeVc(handler) {
  const st = { calls: [] };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const m = /<(\w+) xmlns="urn:vim25">/.exec(b)?.[1] || '?';
      st.calls.push(m);
      const [code, xml] = handler(m, b, st);
      res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const c = new VimSoapClient({ host: `http://127.0.0.1:${srv.address().port}` });
  c.sc = { propertyCollector: 'propertyCollector' };
  return { c, st, close: () => new Promise((r) => srv.close(r)) };
}
const pagedHandler = (size) => (m, b) => {
  if (m === 'RetrievePropertiesEx') {
    assert.match(b, new RegExp(`<maxObjects>${config.vcPropsPageSize}</maxObjects>`));
    return [200, page(0, size, size < N ? 'T1' : null)];
  }
  if (m === 'ContinueRetrievePropertiesEx') {
    const n = Number(/<token>T(\d+)<\/token>/.exec(b)[1]);
    const from = n * size;
    return [200, page(from, size, from + size < N ? `T${n + 1}` : null, true)];
  }
  if (m === 'RetrieveProperties') return [200, legacyXml()];
  return [500, FAULT('MethodFault', m)];
};

test('③ 가짜 vCenter — 토큰을 따라 전부 받고 결과가 예전과 같다(Cancel 없음)', async () => {
  const { c, st, close } = await fakeVc(pagedHandler(5));
  try {
    const got = await c.retrieveProperties('session[x]view', [{ type: 'VirtualMachine', paths: ['name'] }]);
    assert.deepEqual(got, parseObjectContent(legacyXml()));
    assert.deepEqual(st.calls, ['RetrievePropertiesEx', 'ContinueRetrievePropertiesEx', 'ContinueRetrievePropertiesEx', 'ContinueRetrievePropertiesEx', 'ContinueRetrievePropertiesEx']);
    assert.equal(c.lastRetrievePages, 5);
    const many = await c.retrieveManyObjectProps('VirtualMachine', ['vm-0', 'vm-1'], ['name']);
    assert.equal(many.length, N);
  } finally { await close(); }
});

test('④ 도중 실패 — CancelRetrievePropertiesEx 로 서버 결과 세트를 버리고 오류를 올린다', async () => {
  const { c, st, close } = await fakeVc((m, b, s) => {
    if (m === 'ContinueRetrievePropertiesEx') return [500, FAULT('InvalidArgument', 'boom')];
    if (m === 'CancelRetrievePropertiesEx') { s.cancelToken = /<token>([^<]+)<\/token>/.exec(b)[1]; return [200, ENV('<CancelRetrievePropertiesExResponse xmlns="urn:vim25"/>')]; }
    return pagedHandler(5)(m, b);
  });
  try {
    await assert.rejects(c.retrieveProperties('v', [{ type: 'VirtualMachine', paths: ['name'] }]), /boom/);
    assert.equal(st.cancelToken, 'T1');
  } finally { await close(); }
});

test('⑤ Ex 가 없는 서버(MethodNotFound) — 예전 방식으로 받고 그 뒤로는 Ex 를 시도하지 않는다', async () => {
  const { c, st, close } = await fakeVc((m) => (m === 'RetrievePropertiesEx' ? [500, FAULT('MethodNotFound', 'Method not found')] : pagedHandler(5)(m)));
  try {
    assert.equal((await c.retrieveProperties('v', [{ type: 'VirtualMachine', paths: ['name'] }])).length, N);
    assert.equal((await c.retrieveProperties('v', [{ type: 'VirtualMachine', paths: ['name'] }])).length, N);
    assert.deepEqual(st.calls, ['RetrievePropertiesEx', 'RetrieveProperties', 'RetrieveProperties']);
  } finally { await close(); }
});

test('⑤-b 다른 오류는 폴백하지 않는다(예: 권한 없음)', async () => {
  const { c, st, close } = await fakeVc((m) => (m === 'RetrievePropertiesEx' ? [500, FAULT('NoPermission', 'Permission denied')] : pagedHandler(5)(m)));
  try {
    await assert.rejects(c.retrieveProperties('v', [{ type: 'VirtualMachine', paths: ['name'] }]), /Permission/);
    assert.deepEqual(st.calls, ['RetrievePropertiesEx']);
  } finally { await close(); }
});

test('⑥ VC_PROPS_PAGING=false — 예전 RetrieveProperties 한 번만', async () => {
  const prev = config.vcPropsPaging;
  config.vcPropsPaging = false;
  const { c, st, close } = await fakeVc(pagedHandler(5));
  try {
    assert.equal((await c.retrieveProperties('v', [{ type: 'VirtualMachine', paths: ['name'] }])).length, N);
    assert.deepEqual(st.calls, ['RetrieveProperties']);
  } finally { config.vcPropsPaging = prev; await close(); }
});

test('⑦ 페이지 상한 — 토큰이 끝나지 않으면 멈추고 취소한다', { timeout: 15_000 }, async () => {
  const prev = config.vcPropsMaxPages;
  config.vcPropsMaxPages = 3;
  const { c, st, close } = await fakeVc((m) => {
    if (m === 'RetrievePropertiesEx') return [200, page(0, 1, 'LOOP')];
    if (m === 'ContinueRetrievePropertiesEx') return [200, page(0, 1, 'LOOP', true)];
    if (m === 'CancelRetrievePropertiesEx') return [200, ENV('<CancelRetrievePropertiesExResponse xmlns="urn:vim25"/>')];
    return [500, FAULT('MethodFault', m)];
  });
  try {
    await assert.rejects(c.retrieveProperties('v', [{ type: 'VirtualMachine', paths: ['name'] }]), /VC_PROPS_MAX_PAGES/);
    assert.equal(st.calls.filter((x) => x === 'ContinueRetrievePropertiesEx').length, 2);
    assert.equal(st.calls.at(-1), 'CancelRetrievePropertiesEx');
  } finally { config.vcPropsMaxPages = prev; await close(); }
});
