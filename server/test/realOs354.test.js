// v3.54 — 실제 설치 OS 1단계(VMware Tools 보고 guestDetailedData · 어플라이언스 제품 정보 · 수집 점검).
// ① 파서(키=값 스캐너 · 이스케이프 · 형식 밖 · 상한 · 선형) ② 제품 정보 XML ③ API 판 · Tools 판 ④ vm.gos 모양 ⑤ 엣지 수신 정제(실제 진입 함수)
// ⑥ 수집기(이 요청만 SOAP 판 8.0.2.0 · 판 미달이면 묻지 않음 · 실패 격리) ⑦ 가짜 vCenter 로 SOAPAction 헤더 ⑧ 점검 집계 · 범위 ⑨ 배선 · 웹 문구 키.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {
  parseGuestDetailedData, parseVappProduct, detailedApiOk, gosPaths, parseVmGosProps, toolsVersionParts, toolsAtLeast,
  sanitizeVmGos, DETAIL_KEYS, GOS_SOAP_VERSION,
} from '../src/inventory/guestDetail.js';
import { buildOsProbe, noDetailReason, NO_DETAIL_REASONS } from '../src/inventory/osProbe.js';
import { refreshVmCfg, _resetVmCfgRetry } from '../src/vmcfg/collect.js';
import { _resetVmCfgCache, get as cacheGet, statusOf, vmCfgStatus } from '../src/vmcfg/cache.js';
import { sanitizeInventoryList } from '../src/routes/central.js';
import { scopedOsProbe } from '../src/routes/admin/opsSettings.js';
import { VimSoapClient } from '../src/vcenter/soapClient.js';
import { REASON_TEXT, pct, n as numText, statusText } from '../../web/src/views/tools/realOsProbeText.js';

const ROCKY = "architecture='X86' bitness='64' distroName='Rocky Linux' distroVersion='9.4' familyName='Linux' kernelVersion='5.14.0-427.13.1.el9_4.x86_64' prettyName='Rocky Linux 9.4 (Blue Onyx)'";

test('① 키=값 스캐너 — 아는 키 · 모르는 키 · 역슬래시 이스케이프 · 형식 밖 · 잘린 값', () => {
  const r = parseGuestDetailedData(ROCKY);
  assert.equal(r.ok, true);
  assert.equal(r.fields.distroName, 'Rocky Linux');
  assert.equal(r.fields.prettyName, 'Rocky Linux 9.4 (Blue Onyx)');
  assert.equal(r.fields.kernelVersion, '5.14.0-427.13.1.el9_4.x86_64');
  assert.deepEqual(r.extra, {});
  // 모르는 키는 extra(8개 상한) · 아는 키를 덮지 않는다
  const e = parseGuestDetailedData("prettyName='A' newKey='x' " + Array.from({ length: 12 }, (_, i) => `k${i}='v${i}'`).join(' '));
  assert.equal(e.fields.prettyName, 'A');
  assert.equal(Object.keys(e.extra).length, 8);
  assert.equal(e.extra.newKey, 'x');
  // 값 안의 \' · \\
  assert.equal(parseGuestDetailedData("prettyName='it\\'s \\\\ ok'").fields.prettyName, "it's \\ ok");
  // 형식 밖 조각은 건너뛰고 뒤의 정상 조각은 읽는다
  const g = parseGuestDetailedData("garbage ===  distroName='Ubuntu' bad=x distroVersion='22.04'");
  assert.deepEqual(g.fields, { distroName: 'Ubuntu', distroVersion: '22.04' });
  // 닫는 따옴표 없이 끝난 값은 버린다(지어내지 않는다)
  const u = parseGuestDetailedData("distroName='Rocky' prettyName='Rocky Linux 9");
  assert.deepEqual(u.fields, { distroName: 'Rocky' });
  // 빈 값은 키를 만들지 않는다 · 아무것도 못 읽으면 ok=false
  assert.equal(parseGuestDetailedData("distroName=''").ok, false);
  assert.equal(parseGuestDetailedData('완전히 다른 형식').ok, false);
  for (const x of [null, undefined, 3, {}, '', '   ']) assert.equal(parseGuestDetailedData(x), null);
  // 값 상한 256
  assert.equal(parseGuestDetailedData(`prettyName='${'a'.repeat(1000)}'`).fields.prettyName.length, 256);
});

test('① 선형 — 1MB 입력도 앞 4KB 만 한 번 훑는다(정규식 반복 없음)', () => {
  const big = "a='" + "\\'".repeat(500_000);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 50; i++) parseGuestDetailedData(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 500, `50회 ${ms.toFixed(1)}ms`);
  const big2 = 'x'.repeat(2_000_000);
  const t1 = process.hrtime.bigint();
  parseGuestDetailedData(big2);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 50);
});

test('② 어플라이언스 제품 정보 — 이름 · 제조사가 있는 첫 항목 · 엔티티 · 주소 칸은 싣지 않음', () => {
  const xml = '<VAppProductInfo><key>0</key><name></name><vendor></vendor></VAppProductInfo>'
    + '<VAppProductInfo><key>1</key><classId></classId><name>VMware vCenter Server</name><vendor>VMware Inc.</vendor><version>8.0.3.00300</version>'
    + '<fullVersion>8.0.3.00300 Build 24322831</fullVersion><vendorUrl>http://www.vmware.com</vendorUrl><appUrl>https://10.1.2.3:5480/</appUrl></VAppProductInfo>';
  const p = parseVappProduct(xml);
  assert.deepEqual(p, { name: 'VMware vCenter Server', vendor: 'VMware Inc.', version: '8.0.3.00300', fullVersion: '8.0.3.00300 Build 24322831' });
  assert.equal(parseVappProduct('<VAppProductInfo><name>A &amp; B</name></VAppProductInfo>').name, 'A & B');
  for (const x of [null, '', '<x/>', '<VAppProductInfo><key>0</key></VAppProductInfo>']) assert.equal(parseVappProduct(x), null);
});

test('③ API 판 · Tools 판', () => {
  assert.equal(GOS_SOAP_VERSION, '8.0.2.0');
  for (const [v, want] of [['8.0.3.0', true], ['8.0.2.0', true], ['8.0.2', true], ['8.0.1.0', false], ['8.0.0.1', false], ['7.0.3.0', false], ['9.0.0.0', true], ['8.1.0.0', true], ['', false], [null, false], ['abc', false]]) {
    assert.equal(detailedApiOk(v), want, String(v));
  }
  assert.deepEqual(gosPaths(true), ['guest.guestDetailedData', 'config.vAppConfig.product']);
  assert.deepEqual(gosPaths(false), ['config.vAppConfig.product']);
  assert.deepEqual(toolsVersionParts('11328'), { major: 11, minor: 2, patch: 0 });
  assert.deepEqual(toolsVersionParts(12352), { major: 12, minor: 2, patch: 0 });
  for (const x of ['2147483647', '', 'abc', '0', '-5', null, '1e3']) assert.equal(toolsVersionParts(x), null, String(x));
  assert.equal(toolsAtLeast('11328', 11, 2), true);
  assert.equal(toolsAtLeast('11296', 11, 2), false, '11.1.0');
  assert.equal(toolsAtLeast('10346', 11, 2), false);
  assert.equal(toolsAtLeast('2147483647', 11, 2), null, '판을 모르면 참·거짓으로 단정하지 않는다');
});

test('④ vm.gos 모양 — 묻지 않았으면 detailed 를 읽지 않는다 · 못 읽은 원문만 raw', () => {
  const props = { 'guest.guestDetailedData': ROCKY, 'config.vAppConfig.product': '<VAppProductInfo><name>NSX</name><vendor>VMware</vendor></VAppProductInfo>' };
  const a = parseVmGosProps(props, 1000, { asked: true });
  assert.equal(a.asked, true);
  assert.equal(a.detailed.distroName, 'Rocky Linux');
  assert.equal(a.raw, null, '정상 보고는 원문을 싣지 않는다(스냅샷 크기)');
  assert.equal(a.extra, null);
  assert.equal(a.vapp.name, 'NSX');
  const b = parseVmGosProps(props, 1000, { asked: false });
  assert.equal(b.asked, false);
  assert.equal(b.detailed, null);
  assert.equal(b.vapp.name, 'NSX', '제품 정보는 판과 무관하게 읽는다');
  const c = parseVmGosProps({ 'guest.guestDetailedData': '전혀 다른 형식' }, 1000, { asked: true });
  assert.equal(c.detailed, null);
  assert.equal(c.raw, '전혀 다른 형식', '형식을 못 읽은 원문은 실측용으로 남긴다');
  const d = parseVmGosProps({}, 1000, { asked: true });
  assert.deepEqual(d, { at: 1000, asked: true, detailed: null, extra: null, raw: null, vapp: null });
});

test('⑤ 엣지 수신 정제 — 아는 키만 · 글자만 · 상한 · 엣지 시각은 수신 시각 이하 · 실제 진입 함수(sanitizeInventoryList)', () => {
  const NOW = 2_000_000_000_000;
  const g = sanitizeVmGos({
    at: NOW + 999_999, asked: 'true', detailed: { distroName: 'Rocky', prettyName: { x: 1 }, evil: 'x', kernelVersion: 'k'.repeat(999) },
    extra: { newKey: 'v', distroName: 'dup', 'bad key': 'x', obj: { a: 1 } }, raw: 5, vapp: { name: ['x'], vendor: 'V' }, more: 'x',
  }, NOW);
  assert.equal(g.at, NOW, '미래 시각은 수신 시각으로 자른다');
  assert.equal(g.asked, false, "'true' 글자는 참이 아니다");
  assert.deepEqual(Object.keys(g.detailed).sort(), ['distroName', 'kernelVersion']);
  assert.equal(g.detailed.kernelVersion.length, 256);
  assert.deepEqual(g.extra, { newKey: 'v' }, '아는 키 · 형식 밖 이름 · 객체 값은 extra 로 받지 않는다');
  assert.equal(g.raw, null);
  assert.deepEqual(g.vapp, { name: null, vendor: 'V', version: null, fullVersion: null });
  assert.equal(Object.hasOwn(g, 'more'), false);
  for (const x of [null, 'x', [], 3]) assert.equal(sanitizeVmGos(x), null);
  assert.equal(sanitizeVmGos({ detailed: { evil: 1 } }).detailed, null, '아는 키가 하나도 없으면 null');
  // 실제 진입 함수
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const out = sanitizeInventoryList([
    { id: 'vc1:vm-1', vcenterId: 'vc1', name: 'a', gos: { at: 1, asked: true, detailed: { distroName: 'Rocky' }, junk: 1 } },
    { id: 'vc1:vm-2', vcenterId: 'vc1', name: 'b', gos: 'not-an-object' },
    { id: 'vc1:vm-3', vcenterId: 'vc1', name: 'c' },
  ], 'vc1', 10, dropped);
  assert.deepEqual(out[0].gos.detailed, { distroName: 'Rocky' });
  assert.equal(Object.hasOwn(out[0].gos, 'junk'), false);
  assert.equal(out[1].gos, null);
  assert.equal(dropped.coerced, 1);
  assert.equal(Object.hasOwn(out[2], 'gos'), false, '보내지 않은 키는 만들지 않는다(= 미수집)');
});

function fakeClient({ apiVersion = '8.0.3.0', failOs = null } = {}) {
  const calls = [];
  return {
    calls,
    sc: { apiVersion },
    async retrieveManyObjectProps(type, refs, paths, chunk, opts) {
      calls.push({ type, refs: [...refs], paths: [...paths], opts: opts || null });
      const isOs = paths.includes('config.vAppConfig.product');
      if (isOs && failOs) throw new Error(failOs);
      return refs.map((ref) => ({
        type, ref,
        props: isOs ? { 'guest.guestDetailedData': ROCKY } : paths.includes('config.hardware.device') ? { 'config.hardware.device': '' } : { 'config.changeTrackingEnabled': 'true' },
      }));
    },
  };
}
const SET = { vmCfgScan: true, vmCfgRefreshMs: 1_800_000, vmCfgPerCycle: 10, vmDevRefreshMs: 21_600_000, vmDevPerCycle: 10, vmOsScan: true, vmOsRefreshMs: 21_600_000, vmOsPerCycle: 10 };
const NOW = 1_800_000_000_000;

test('⑥ 수집기 — 판 8.0.2 이상이면 이 요청만 SOAP 8.0.2.0 · 미만이면 제품 정보만 · 다른 종류는 예전 인자 그대로', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  const c = fakeClient();
  const r = await refreshVmCfg(c, 'vcA', ['vm-1', 'vm-2'], { now: NOW, settings: SET });
  assert.equal(r.os.fetched, 2);
  assert.equal(r.os.asked, true);
  const os = c.calls.find((x) => x.paths.includes('config.vAppConfig.product'));
  assert.deepEqual(os.paths, ['guest.guestDetailedData', 'config.vAppConfig.product']);
  assert.deepEqual(os.opts, { soapVersion: '8.0.2.0' });
  for (const x of c.calls.filter((y) => y !== os)) assert.equal(x.opts, null, 'cfg · dev 요청은 판을 바꾸지 않는다(인자 4개)');
  assert.equal(c.calls.indexOf(os), 1, 'cfg 다음 · dev 앞');
  assert.equal(cacheGet('vcA', 'vm-1').os.detailed.distroName, 'Rocky Linux');
  assert.equal(statusOf('vcA').osAsked, true);
  assert.equal(statusOf('vcA').osApiVersion, '8.0.3.0');
  assert.equal(vmCfgStatus().vcenters.find((v) => v.vcenterId === 'vcA').os, 2);
  // 다음 주기 — 6시간 안에는 다시 묻지 않는다
  const c2 = fakeClient();
  const r2 = await refreshVmCfg(c2, 'vcA', ['vm-1', 'vm-2'], { now: NOW + 60_000, settings: SET });
  assert.equal(r2.os, null);
  // 판 미달 — 제품 정보만 묻고 SOAP 판은 그대로
  _resetVmCfgCache(); _resetVmCfgRetry();
  const old = fakeClient({ apiVersion: '8.0.1.0' });
  const r3 = await refreshVmCfg(old, 'vcB', ['vm-1'], { now: NOW, settings: SET });
  assert.equal(r3.os.asked, false);
  const os3 = old.calls.find((x) => x.paths.includes('config.vAppConfig.product'));
  assert.deepEqual(os3.paths, ['config.vAppConfig.product']);
  assert.equal(os3.opts, null);
  assert.equal(cacheGet('vcB', 'vm-1').os.asked, false);
  // 판을 못 읽은 클라이언트(sc 없음)도 묻지 않는다
  _resetVmCfgCache();
  const none = fakeClient(); delete none.sc;
  assert.equal((await refreshVmCfg(none, 'vcC', ['vm-1'], { now: NOW, settings: SET })).os.asked, false);
});

test('⑥ 수집기 — vmOsScan 이 없는 설정(옛 호출)은 묻지 않는다 · 경로 오류는 os 만 쉬고 cfg 는 성공', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  const c = fakeClient();
  const { vmOsScan, ...legacy } = SET;
  const r = await refreshVmCfg(c, 'vcA', ['vm-1'], { now: NOW, settings: legacy });
  assert.equal(r.os, null);
  assert.equal(c.calls.some((x) => x.paths.includes('config.vAppConfig.product')), false);
  assert.ok(vmOsScan);
  _resetVmCfgCache(); _resetVmCfgRetry();
  const bad = fakeClient({ failOs: 'SOAP 500: ServerFaultCode InvalidProperty guest.guestDetailedData' });
  const r2 = await refreshVmCfg(bad, 'vcA', ['vm-1'], { now: NOW, settings: SET });
  assert.match(r2.os.error, /InvalidProperty/);
  assert.equal(r2.cfg.fetched, 1, 'os 실패가 cfg 를 막지 않는다');
  assert.equal(r2.dev.fetched, 1, 'os 실패가 dev 를 막지 않는다');
  assert.ok(statusOf('vcA').osBackoffUntil > NOW);
  const n0 = bad.calls.length;
  const r3 = await refreshVmCfg(bad, 'vcA', ['vm-1'], { now: NOW + 60_000, settings: { ...SET, vmCfgRefreshMs: 1, vmDevRefreshMs: 1 } });
  assert.equal(r3.os, null, '경로 오류는 갱신 주기만큼 다시 묻지 않는다');
  assert.ok(bad.calls.slice(n0).every((x) => !x.paths.includes('config.vAppConfig.product')));
});

test('⑦ 가짜 vCenter — 이 요청만 SOAPAction 8.0.2.0 · 이어 받기도 같은 판 · 형식 밖 판은 기본 판', async () => {
  const seen = [];
  const ENV = (b) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${b}</soapenv:Body></soapenv:Envelope>`;
  const obj = (i) => `<objects><obj type="VirtualMachine">vm-${i}</obj><propSet><name>guest.guestDetailedData</name><val xsi:type="xsd:string">${ROCKY.replace(/'/g, '&apos;')}</val></propSet></objects>`;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (x) => { b += x; });
    req.on('end', () => {
      const m = /<(\w+) xmlns="urn:vim25">/.exec(b)?.[1] || '?';
      seen.push({ m, action: req.headers.soapaction });
      const body = m === 'RetrievePropertiesEx'
        ? `<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval><token>T1</token>${obj(1)}</returnval></RetrievePropertiesExResponse>`
        : `<ContinueRetrievePropertiesExResponse xmlns="urn:vim25"><returnval>${obj(2)}</returnval></ContinueRetrievePropertiesExResponse>`;
      res.writeHead(200, { 'content-type': 'text/xml' }); res.end(ENV(body));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const c = new VimSoapClient({ host: `http://127.0.0.1:${srv.address().port}` });
    c.sc = { propertyCollector: 'propertyCollector' };
    const out = await c.retrieveManyObjectProps('VirtualMachine', ['vm-1', 'vm-2'], ['guest.guestDetailedData'], 250, { soapVersion: '8.0.2.0' });
    assert.equal(out.length, 2);
    assert.equal(parseGuestDetailedData(out[0].props['guest.guestDetailedData']).fields.distroName, 'Rocky Linux', '엔티티 복원 뒤 그대로 읽힌다');
    assert.deepEqual(seen.map((x) => x.action), ['"urn:vim25/8.0.2.0"', '"urn:vim25/8.0.2.0"']);
    seen.length = 0;
    await c.retrieveManyObjectProps('VirtualMachine', ['vm-1'], ['name']);
    assert.equal(seen[0].action, '"urn:vim25/8.0.0.1"', '판을 주지 않은 요청은 예전 판');
    seen.length = 0;
    await c.retrieveManyObjectProps('VirtualMachine', ['vm-1'], ['name'], 250, { soapVersion: '8.0.2.0"\r\nX-Evil: 1' });
    assert.equal(seen[0].action, '"urn:vim25/8.0.0.1"', '형식 밖 판은 헤더에 싣지 않는다');
  } finally { await new Promise((r) => srv.close(r)); }
});

const vm = (id, vc, o = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, powerState: 'POWERED_ON', toolsStatus: 'RUNNING', toolsVersion: '12352', guestOS: 'CentOS 7 (64-bit)', ...o });
const rocky = { at: 1, asked: true, detailed: { familyName: 'Linux', distroName: 'Rocky Linux', distroVersion: '9.4', prettyName: 'Rocky Linux 9.4 (Blue Onyx)', kernelVersion: 'k1' }, extra: null, raw: null, vapp: null };

test('⑧ 점검 집계 — 법인별 개수 · 종류 · 사유 · 어플라이언스 · VM 이름 없음', () => {
  const vms = [
    vm('vm-1', 'vc1', { name: 'secret-name-1', gos: rocky }),
    vm('vm-2', 'vc1', { name: 'secret-name-2', powerState: 'POWERED_OFF', gos: rocky }),
    vm('vm-3', 'vc1', { gos: { ...rocky, detailed: null }, toolsVersion: '10346' }),
    vm('vm-4', 'vc1', { gos: { ...rocky, detailed: null }, toolsStatus: 'NOT_RUNNING' }),
    vm('vm-5', 'vc2', {}),
    vm('vm-6', 'vc2', { gos: { ...rocky, asked: false, detailed: null } }),
    vm('vm-7', 'vc2', { template: true, gos: { ...rocky, detailed: null } }),
    vm('vm-8', 'vc2', { powerState: 'POWERED_OFF', gos: { ...rocky, detailed: null } }),
    vm('vm-9', 'vc2', { gos: { ...rocky, detailed: null }, toolsVersion: '2147483647' }),
    vm('vm-10', 'vc2', { gos: { ...rocky, detailed: null } }),
    vm('vm-11', 'vc2', { cfg: { managedBy: { extensionKey: 'com.vmware.vim.eam', type: 'cluster-agent' } },
      gos: { ...rocky, detailed: { familyName: 'Linux', distroName: 'VMware Photon OS', distroVersion: '4.0', prettyName: 'VMware Photon OS/Linux' }, vapp: { name: 'VMware vCenter Server', vendor: 'VMware Inc.', version: '8.0.3' } } }),
    vm('vm-12', 'vc2', { gos: { ...rocky, detailed: null, raw: '이상한 형식', extra: { newKey: 'v' } } }),
  ];
  const p = buildOsProbe(vms, [{ id: 'vc1', name: 'OC1', version: '8.0.3' }, { id: 'vc2', name: 'OC2' }], [{ vcenterId: 'vc1', osAt: 5, osAsked: true, osApiVersion: '8.0.3.0' }], { now: 10 });
  assert.equal(p.total.vms, 11); assert.equal(p.total.templates, 1);
  assert.equal(p.total.detailed, 3); assert.equal(p.total.detailedOff, 1);
  assert.deepEqual(p.noDetail, { notRead: 1, notAsked: 1, template: 1, toolsOld: 1, toolsNotRunning: 1, poweredOff: 1, toolsUnknown: 1, other: 2 });
  const oc1 = p.vcenters.find((r) => r.id === 'vc1');
  assert.equal(oc1.name, 'OC1'); assert.equal(oc1.detailed, 2); assert.equal(oc1.status.apiVersion, '8.0.3.0');
  assert.equal(p.vcenters.find((r) => r.id === 'vc2').status, null, '엣지 수집 vCenter 는 이 포탈에 상태가 없다');
  const rk = p.samples.find((s) => s.distroName === 'Rocky Linux');
  assert.equal(rk.count, 2); assert.equal(rk.poweredOn, 1);
  assert.deepEqual(rk.configOs, [{ value: 'CentOS 7 (64-bit)', count: 2 }], '설정값과 실제 값을 나란히 본다');
  const ph = p.samples.find((s) => s.distroName === 'VMware Photon OS');
  assert.equal(ph.appliance, 1);
  assert.equal(p.appliances[0].name, 'VMware vCenter Server');
  assert.deepEqual(p.appliances[0].os, [{ value: 'VMware Photon OS/Linux', count: 1 }]);
  assert.deepEqual(p.managedBy, [{ extensionKey: 'com.vmware.vim.eam', type: 'cluster-agent', count: 1 }]);
  assert.deepEqual(p.unparsed, [{ raw: '이상한 형식', count: 1 }]);
  assert.deepEqual(p.extraKeys, [{ key: 'newKey', count: 1, example: 'v' }]);
  assert.equal(JSON.stringify(p).includes('secret-name'), false, '내려받는 파일에 VM 이름을 싣지 않는다');
  for (const k of NO_DETAIL_REASONS) assert.equal(typeof noDetailReason(vms[0]) === 'string', true, k);
});

test('⑧ 점검 범위 — 요청 필터보다 먼저 조회 범위 · 수집 상태도 같은 범위', () => {
  const snap = {
    vcenters: [{ id: 'vc1', name: 'OC1' }, { id: 'vc2', name: 'OC2' }],
    vms: [vm('vm-1', 'vc1', { gos: rocky }), vm('vm-2', 'vc2', { gos: rocky })],
  };
  const statuses = [{ vcenterId: 'vc1', osAt: 1 }, { vcenterId: 'vc2', osAt: 1, osError: 'vc2 비밀 오류' }];
  const scoped = { username: 'a', role: 'admin', scope: { vcenters: ['vc1'] } };
  const p = scopedOsProbe(scoped, snap, { statuses, now: 1 });
  assert.equal(p.scoped, true);
  assert.deepEqual(p.vcenters.map((r) => r.id), ['vc1']);
  assert.equal(p.total.vms, 1);
  assert.equal(JSON.stringify(p).includes('vc2 비밀 오류'), false);
  // 범위 밖 vCenter 를 요청 필터로 지정해도 비어 있다
  const q = scopedOsProbe(scoped, snap, { vcenterId: 'vc2', statuses, now: 1 });
  assert.equal(q.total.vms, 0); assert.deepEqual(q.vcenters, []);
  // 전체 범위 계정 + 요청 필터
  const full = scopedOsProbe({ username: 'b', role: 'admin' }, snap, { vcenterId: 'vc2', statuses, now: 1 });
  assert.equal(full.scoped, undefined);
  assert.deepEqual(full.vcenters.map((r) => r.id), ['vc2']);
});

test('⑨ 배선 — 수집기가 vm.gos 를 싣고 · 라우트가 관리자 전용 · 웹 문구 키가 서버 사유 키와 같다', () => {
  const soap = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(soap, /\.\.\.\(cfgEntry\?\.os \? \{ gos: cfgEntry\.os \} : \{\}\)/);
  assert.match(soap, /SOAPAction: `"urn:vim25\/\$\{typeof soapVersion === 'string' && SOAP_VERSION_RE\.test\(soapVersion\) \? soapVersion : '8\.0\.0\.1'\}"`/);
  const ops = fs.readFileSync(new URL('../src/routes/admin/opsSettings.js', import.meta.url), 'utf8');
  assert.match(ops, /adminRouter\.get\('\/os-scan\/probe', adminOnly,/);
  const central = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
  assert.match(central, /o\.gos = v;/);
  assert.deepEqual(Object.keys(REASON_TEXT).sort(), [...NO_DETAIL_REASONS].sort());
  assert.ok(DETAIL_KEYS.includes('prettyName'));
  // 웹 숫자 표기 — 못 읽은 값은 '—', 분모 0 은 0% 가 아니라 '—'
  assert.equal(numText(null), '—'); assert.equal(pct(0, 0), '—'); assert.equal(pct(1, 4), '25%');
  assert.equal(statusText(null).text, '엣지 수집(상태는 엣지에)');
  assert.match(statusText({ osError: 'x' }).text, /^오류/);
});
