// v3.54 — 실제 설치 OS 1단계(VMware Tools 보고 guestDetailedData · 어플라이언스 제품 정보 · 수집 점검).
// ① 파서(키=값 스캐너 · 이스케이프 · 형식 밖 · 상한 · 선형) ② 제품 정보 XML ③ API 판 · Tools 판 ④ vm.gos 모양 ⑤ 엣지 수신 정제(실제 진입 함수)
// ⑥ 수집기(이 요청만 SOAP 판 8.0.2.0 · 판 미달이면 묻지 않음 · 실패 격리) ⑦ 가짜 vCenter 로 SOAPAction 헤더 ⑧ 점검 집계 · 범위 ⑨ 배선 · 웹 문구 키.
import './_isolateConfig.js';   // 기본 설정 폴더 격리 — 직접 실행(--import 없이)에도 실제 server/config 에 쓰지 않는다(첫 import 여야 한다)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {
  parseGuestDetailedData, parseVappProduct, detailedApiOk, gosPaths, parseVmGosProps, toolsVersionParts, toolsAtLeast,
  sanitizeVmGos, DETAIL_KEYS, GOS_SOAP_VERSION, normalizeGos, PARSE_OUTCOMES, cleanText,
} from '../src/inventory/guestDetail.js';
import { buildOsProbe, noDetailReason, NO_DETAIL_REASONS } from '../src/inventory/osProbe.js';
import { refreshVmCfg, _resetVmCfgRetry, isPathFault } from '../src/vmcfg/collect.js';
import { _resetVmCfgCache, get as cacheGet, statusOf, vmCfgStatus, setStatus } from '../src/vmcfg/cache.js';
import { sanitizeInventoryList } from '../src/routes/central.js';
import { scopedOsProbe } from '../src/routes/admin/opsSettings.js';
import { VimSoapClient } from '../src/vcenter/soapClient.js';
import { REASON_TEXT, pct, n as numText, statusText, periodText, topText, managedText, archText, notAskedText } from '../../web/src/views/tools/realOsProbeText.js';

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
  assert.deepEqual(d, { at: 1000, asked: true, parse: null, detailed: null, extra: null, raw: null, vapp: null });
});

test('⑤ 엣지 수신 정제 — 아는 키만 · 글자만 · 상한 · 엣지 시각은 수신 시각 이하 · 실제 진입 함수(sanitizeInventoryList)', () => {
  const NOW = 2_000_000_000_000;
  const g = sanitizeVmGos({
    at: NOW + 999_999, asked: 'true', detailed: { distroName: 'Rocky', prettyName: { x: 1 }, evil: 'x', kernelVersion: 'k'.repeat(999) },
    extra: { newKey: 'v', distroName: 'dup', 'bad key': 'x', obj: { a: 1 } }, raw: 5, vapp: { name: ['x'], vendor: 'V' }, more: 'x',
  }, NOW);
  assert.equal(g.at, NOW, '미래 시각은 수신 시각으로 자른다');
  assert.equal(g.asked, false, "'true' 글자는 참이 아니다");
  assert.equal(g.detailed, null, '묻지 않았으면 detailed 는 없다(파서 불변조건 — 점검 1회차)');
  assert.equal(g.extra, null);
  assert.equal(g.raw, null);
  const g2 = sanitizeVmGos({ asked: true, detailed: { distroName: 'Rocky', prettyName: { x: 1 }, evil: 'x', kernelVersion: 'k'.repeat(999) },
    extra: { newKey: 'v', distroName: 'dup', 'bad key': 'x', obj: { a: 1 } } }, NOW);
  assert.deepEqual(Object.keys(g2.detailed).sort(), ['distroName', 'kernelVersion']);
  assert.equal(g2.detailed.kernelVersion.length, 256);
  assert.deepEqual(g2.extra, { newKey: 'v' }, '아는 키 · 형식 밖 이름 · 객체 값은 extra 로 받지 않는다');
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
    vm('vm-12', 'vc2', { gos: { ...rocky, parse: 'malformed', detailed: null, raw: '이상한 형식', extra: { newKey: 'v' } } }),
  ];
  const p = buildOsProbe(vms, [{ id: 'vc1', name: 'OC1', version: '8.0.3' }, { id: 'vc2', name: 'OC2' }], [{ vcenterId: 'vc1', osAt: 5, osAsked: true, osApiVersion: '8.0.3.0' }], { now: 10 });
  assert.equal(p.total.vms, 11); assert.equal(p.total.templates, 1);
  assert.equal(p.total.detailed, 3); assert.equal(p.total.detailedOff, 1);
  assert.deepEqual(p.noDetail, { notRead: 1, notAsked: 1, emptyValues: 0, unparsed: 1, template: 1, toolsOld: 1, toolsNotRunning: 1, poweredOff: 1, toolsUnknown: 1, other: 1 },
    '형식을 못 읽은 보고(raw · extra)는 Tools 미보고(other)와 섞지 않는다');
  const oc1 = p.vcenters.find((r) => r.id === 'vc1');
  assert.equal(oc1.name, 'OC1'); assert.equal(oc1.detailed, 2); assert.equal(oc1.status.apiVersion, '8.0.3.0');
  assert.equal(p.vcenters.find((r) => r.id === 'vc2').status, null, '엣지 수집 vCenter 는 이 포탈에 상태가 없다');
  const rk = p.samples.find((s) => s.distroName === 'Rocky Linux');
  assert.equal(rk.count, 2); assert.equal(rk.poweredOn, 1);
  assert.deepEqual(rk.configOs, [{ value: 'CentOS 7 (64-bit)', count: 2 }], '설정값과 실제 값을 나란히 본다');
  const ph = p.samples.find((s) => s.distroName === 'VMware Photon OS');
  assert.equal(ph.appliance, 1);
  assert.equal(ph.managed, 1);
  assert.equal(rk.appliance, 0); assert.equal(rk.managed, 0);
  assert.equal(p.appliances[0].name, 'VMware vCenter Server');
  assert.deepEqual(p.appliances[0].os, [{ value: 'VMware Photon OS/Linux', count: 1 }]);
  assert.deepEqual(p.managedBy, [{ extensionKey: 'com.vmware.vim.eam', type: 'cluster-agent', count: 1 }]);
  assert.deepEqual(p.unparsed, [{ raw: '이상한 형식', parse: 'malformed', count: 1 }]);
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
  assert.match(statusText({ osError: 'x' }).text, /^오류/);
});

test('⑧ 묶음 키 — 값에 구분자가 있어도 다른 OS 가 합쳐지지 않는다 · 확장 관리 VM 은 어플라이언스가 아니다', () => {
  const d1 = { ...rocky, detailed: { familyName: 'L|X', distroName: 'Y' } };
  const d2 = { ...rocky, detailed: { familyName: 'L', distroName: 'X|Y' } };
  const p = buildOsProbe([
    vm('vm-1', 'vc1', { gos: d1 }), vm('vm-2', 'vc1', { gos: d2 }),
    vm('vm-3', 'vc1', { gos: rocky, cfg: { managedBy: { extensionKey: 'com.vmware.vcHms', type: 'replica' } } }),
  ], [{ id: 'vc1' }], [], { now: 1 });
  assert.equal(p.samples.length, 3);
  const rk = p.samples.find((x) => x.distroName === 'Rocky Linux');
  assert.equal(rk.appliance, 0, '복제본(managedBy)을 어플라이언스로 세지 않는다');
  assert.equal(rk.managed, 1);
  assert.equal(p.total.vapp, 0); assert.equal(p.total.managed, 1);
});

test('⑥ 수집기 — 앞 종류가 예산을 다 쓰면 os 를 시작하지 않는다', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  const c = fakeClient();
  const r = await refreshVmCfg(c, 'vcA', ['vm-1'], { now: NOW, budgetMs: 0, settings: SET });
  assert.equal(r.os, null);
  assert.equal(c.calls.length, 0);
  assert.equal(statusOf('vcA')?.osAt ?? null, null, '시작하지 않은 종류는 상태(osAt)를 갱신하지 않는다');
});

test('⑦ 가짜 vCenter — 예전 방식(RetrieveProperties) · 중간 실패 뒤 취소도 같은 판', async () => {
  const { config } = await import('../src/config.js');
  const ENV = (b) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${b}</soapenv:Body></soapenv:Envelope>`;
  const FAULT = ENV('<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>boom</faultstring></soapenv:Fault>');
  const seen = [];
  let mode = 'legacy';
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (x) => { b += x; });
    req.on('end', () => {
      const m = /<(\w+) xmlns="urn:vim25">/.exec(b)?.[1] || '?';
      seen.push({ m, action: req.headers.soapaction });
      let code = 200; let body;
      if (m === 'RetrieveProperties') body = ENV('<RetrievePropertiesResponse xmlns="urn:vim25"><returnval><obj type="VirtualMachine">vm-1</obj><propSet><name>name</name><val xsi:type="xsd:string">a</val></propSet></returnval></RetrievePropertiesResponse>');
      else if (m === 'RetrievePropertiesEx') body = ENV('<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval><token>T1</token><objects><obj type="VirtualMachine">vm-1</obj></objects></returnval></RetrievePropertiesExResponse>');
      else if (m === 'ContinueRetrievePropertiesEx') { code = 500; body = FAULT; }
      else body = ENV('<CancelRetrievePropertiesExResponse xmlns="urn:vim25"></CancelRetrievePropertiesExResponse>');
      res.writeHead(code, { 'content-type': 'text/xml' }); res.end(body);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const saved = config.vcPropsPaging;
  try {
    const c = new VimSoapClient({ host: `http://127.0.0.1:${srv.address().port}` });
    c.sc = { propertyCollector: 'propertyCollector' };
    config.vcPropsPaging = false;
    await c.retrieveManyObjectProps('VirtualMachine', ['vm-1'], ['name'], 250, { soapVersion: '8.0.2.0' });
    assert.deepEqual(seen.map((x) => [x.m, x.action]), [['RetrieveProperties', '"urn:vim25/8.0.2.0"']], '예전 방식도 같은 판');
    seen.length = 0; mode = 'paged';
    config.vcPropsPaging = true;
    await assert.rejects(c.retrieveManyObjectProps('VirtualMachine', ['vm-1'], ['name'], 250, { soapVersion: '8.0.2.0' }));
    assert.deepEqual(seen.map((x) => x.m), ['RetrievePropertiesEx', 'ContinueRetrievePropertiesEx', 'CancelRetrievePropertiesEx']);
    assert.ok(seen.every((x) => x.action === '"urn:vim25/8.0.2.0"'), '취소 요청도 같은 판');
    assert.equal(mode, 'paged');
  } finally { config.vcPropsPaging = saved; await new Promise((r) => srv.close(r)); }
});

/* ---------------------------- 점검 1회차(반증 재현) 회귀 ---------------------------- */

test('R1 정제 불변조건 — 엣지의 모순된 조합을 파서 모양으로 되돌린다', () => {
  const NOW2 = 2_000_000_000_000;
  const a = sanitizeVmGos({ asked: false, detailed: { prettyName: 'X' }, raw: 'zz', extra: { a: 'b' } }, NOW2);
  assert.deepEqual([a.detailed, a.extra, a.raw], [null, null, null], '묻지 않았으면 detailed · extra · raw 없음');
  const b = sanitizeVmGos({ asked: true, detailed: { prettyName: 'X' }, raw: 'zz' }, NOW2);
  assert.equal(b.raw, null, 'detailed 가 있으면 raw 없음');
  const c = sanitizeVmGos({ detailed: { prettyName: 'X' } }, NOW2);
  assert.equal(c.asked, false); assert.equal(c.detailed, null, 'asked 생략 = 묻지 않음');
  const d = sanitizeVmGos({ asked: true, raw: 'zz' }, NOW2);
  assert.equal(d.raw, 'zz', '물었고 못 읽은 원문은 남긴다');
  const p = buildOsProbe([vm('vm-1', 'vc1', { gos: a }), vm('vm-2', 'vc1', { gos: b })], [{ id: 'vc1' }], [], { now: 1 });
  assert.ok(p.total.detailed <= p.total.asked, '보고 있음은 물은 수를 넘지 않는다');
  assert.deepEqual(p.unparsed, []);
});

test('R1 샘플 — 아키텍처는 다른 줄 · addl · cpe · build 는 첫 값으로 덮지 않고 값별 개수', () => {
  const mk = (arch, addl, cpe) => ({ ...rocky, detailed: { familyName: 'Linux', distroName: 'Ubuntu', distroVersion: '22.04', prettyName: 'Ubuntu 22.04.3 LTS', bitness: '64', architecture: arch, distroAddlVersion: addl, cpeString: cpe } });
  const p = buildOsProbe([
    vm('vm-1', 'vc1', { gos: mk('X86', 'jammy', 'cpe:1') }), vm('vm-2', 'vc1', { gos: mk('Arm', 'jammy-arm', 'cpe:2') }),
    vm('vm-3', 'vc1', { gos: mk('Arm', 'jammy-arm', 'cpe:3') }), vm('vm-4', 'vc1', { gos: mk('X86', 'jammy', 'cpe:1') }),
  ], [{ id: 'vc1' }], [], { now: 1 });
  assert.equal(p.schema, 5);
  const x86 = p.samples.find((s) => s.architecture === 'X86');
  const arm = p.samples.find((s) => s.architecture === 'Arm');
  assert.equal(x86.count, 2); assert.equal(arm.count, 2);
  assert.deepEqual(arm.cpeString, [{ value: 'cpe:2', count: 1 }, { value: 'cpe:3', count: 1 }]);
  assert.deepEqual(arm.distroAddlVersion, [{ value: 'jammy-arm', count: 2 }]);
  assert.deepEqual(x86.buildNumber, []);
});

test('R1 수집 스위치 — VM_CFG_SCAN 을 꺼도 os 는 돌고, os 만 끄면 cfg · dev 는 돈다', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  const c = fakeClient();
  const r = await refreshVmCfg(c, 'vcA', ['vm-1'], { now: NOW, settings: { ...SET, vmCfgScan: false } });
  assert.equal(r.os.fetched, 1);
  assert.equal(r.cfg, null); assert.equal(r.dev, null);
  assert.ok(c.calls.every((x) => x.paths.includes('config.vAppConfig.product')), 'cfg · dev 요청은 없다');
  _resetVmCfgCache(); _resetVmCfgRetry();
  const c2 = fakeClient();
  const r2 = await refreshVmCfg(c2, 'vcA', ['vm-1'], { now: NOW, settings: { ...SET, vmOsScan: false } });
  assert.equal(r2.os, null); assert.equal(r2.cfg.fetched, 1); assert.equal(r2.dev.fetched, 1);
  assert.deepEqual(await refreshVmCfg(c2, 'vcB', ['vm-1'], { now: NOW, settings: { ...SET, vmCfgScan: false, vmOsScan: false } }), { skipped: 'off' });
});

test('R1 경로 오류 판정 — fault 타입 · 타입 이름만 · \'version\' 단어 같은 일시 장애는 쉬지 않는다', async () => {
  assert.equal(isPathFault(Object.assign(new Error('SOAP 500: boom'), { fault: 'InvalidProperty' })), true);
  assert.equal(isPathFault(new Error('SOAP 500: ServerFaultCode InvalidPropertyFault guest.x')), true);
  assert.equal(isPathFault(new Error('SOAP 500: InvalidRequest')), true);
  for (const m of ['SOAP 503: Service version mismatch — retry later', 'request timed out', 'fetch failed', 'vCenter 수집 데드라인']) assert.equal(isPathFault(new Error(m)), false, m);
  _resetVmCfgCache(); _resetVmCfgRetry();
  const bad = fakeClient({ failOs: 'SOAP 503: Service version mismatch — retry later' });
  await refreshVmCfg(bad, 'vcA', ['vm-1'], { now: NOW, settings: SET });
  assert.equal(statusOf('vcA').osBackoffUntil, 0, '일시 장애로 6시간 쉬지 않는다');
});

test('R1 점검 라우트 본문 — 상태는 vCenter 마다(64개 상한 없음) · 수집 설정 · 데모 · 행의 수집 경로', () => {
  _resetVmCfgCache();
  const vcs = Array.from({ length: 70 }, (_, i) => ({ id: `vc${i}`, name: `VC${i}`, ...(i % 2 ? { collectSource: 'site' } : {}) }));
  for (const vc of vcs) setStatus(vc.id, { osAt: 5, osAsked: true });
  const p = scopedOsProbe({ username: 'a', role: 'admin' }, { vcenters: vcs, vms: [] }, { now: 10, settings: { vmCfgScan: true, vmOsScan: true, vmOsRefreshMs: 3_600_000, vmOsPerCycle: 500 }, demo: false });
  assert.equal(p.vcenters.length, 70);
  assert.ok(p.vcenters.filter((r) => r.collectSource === 'direct').every((r) => r.status && r.status.osAt === 5), '65번째 이후도 상태가 있다(직접 수집)');
  assert.ok(p.vcenters.filter((r) => r.collectSource === 'site').every((r) => r.status === null), '엣지 수집 행에는 이 포탈 상태를 붙이지 않는다(2회차)');
  assert.ok(p.vcenters.some((r) => r.id === 'vc68' && r.status), '65번째 이후 직접 수집 vCenter');
  assert.deepEqual(p.collect, { cfgEnabled: true, osEnabled: true, refreshMs: 3_600_000, perCycle: 500 });
  assert.equal(p.demo, undefined);
  assert.equal(p.vcenters.find((r) => r.id === 'vc1').collectSource, 'site');
  assert.equal(p.vcenters.find((r) => r.id === 'vc0').collectSource, 'direct');
  assert.equal(scopedOsProbe({ role: 'admin' }, { vcenters: [], vms: [] }, { now: 1, demo: true }).demo, true);
  assert.deepEqual(scopedOsProbe({ role: 'admin' }, { vcenters: [], vms: [] }, { now: 1, demo: false, settings: { vmCfgScan: false, vmOsScan: false } }).collect,
    { cfgEnabled: false, osEnabled: false, refreshMs: null, perCycle: null }, '꺼짐 · 주기 미상은 그대로 말한다(숫자를 지어내지 않는다)');
  _resetVmCfgCache();
});

test('R1 화면 문구 — 상태가 없는 이유를 단정하지 않는다 · 주기는 응답 값', () => {
  const ok = { collect: { osEnabled: true } };
  assert.equal(statusText(null, { collectSource: 'site' }, ok).text, '엣지 수집(상태는 엣지에)');
  assert.equal(statusText(null, { collectSource: 'direct' }, ok).text, '이 포탈 수집 기록 없음(수집 전 · 접속 실패 등)');
  assert.equal(statusText(null, { collectSource: 'direct' }, { collect: { osEnabled: false } }).text, '이 포탈의 실제 OS 수집 꺼짐');
  assert.equal(statusText(null, { collectSource: 'site' }, { demo: true }).text, '데모 데이터(수집 상태 없음)');
  assert.match(statusText({ osAt: 1, osAsked: true }, { collectSource: 'direct' }, ok).text, /Tools 보고 요청/);
  assert.equal(periodText(21_600_000), '6시간'); assert.equal(periodText(300_000), '5분'); assert.equal(periodText(5_400_000), '90분');
  for (const x of [null, undefined, 0, -1, NaN, '6h']) assert.equal(periodText(x), null);
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.equal(/\d+\s*시간 주기/.test(jsx), false, '주기 숫자를 화면에 박지 않는다');
  assert.match(jsx, /useEffect\(\(\) => \{ setData\(null\); setErr\(null\); load\(\); \}, \[scope\]\)/, '범위가 바뀌면 이전 오류를 지운다');
});

/* ---------------------------- 점검 2회차(반증 재현) 회귀 ---------------------------- */

test('R2 값별 개수 목록 — 잘라낸 종류 수를 싣는다 · fullVersion 은 값별 개수', () => {
  const vms = Array.from({ length: 9 }, (_, i) => vm(`vm-${i}`, 'vc1', {
    guestOS: `cfg-${i}`,
    gos: { ...rocky, detailed: { ...rocky.detailed, kernelVersion: i < 8 ? `k${i}` : undefined }, vapp: { name: 'VMware vCenter Server', vendor: 'VMware Inc.', version: '8.0.3', fullVersion: `8.0.3 Build 2400000${i % 8}` } },
  }));
  const p = buildOsProbe(vms, [{ id: 'vc1' }], [], { now: 1 });
  const rk = p.samples[0];
  assert.equal(rk.kernels.length, 5); assert.equal(rk.kernelsOmitted, 3, '커널 8종 중 5종만 싣고 3종 생략을 밝힌다');
  assert.equal(rk.configOs.length, 5); assert.equal(rk.configOsOmitted, 4);
  for (const k of ['distroAddlVersion', 'cpeString', 'buildNumber', 'toolsGuestId']) assert.equal(rk[`${k}Omitted`], 0, k);
  const ap = p.appliances[0];
  assert.equal(ap.count, 9); assert.equal(Object.hasOwn(ap, 'fullVersion'), false);
  assert.equal(ap.fullVersions.length, 5); assert.equal(ap.fullVersionsOmitted, 3);
  assert.equal(ap.fullVersions.reduce((a, x) => a + x.count, 0), 6, '상위 5종(8.0.3 Build 24000000 은 2대)');
  assert.equal(ap.osOmitted, 0);
  assert.equal(topText(rk.kernels, 2, rk.kernelsOmitted), 'k0 1 · k1 1 외 6가지');
  assert.equal(topText([], 3, 4), '—');
});

test('R2 형식 못 읽은 보고 수 — 가짓수 상한과 무관한 전체 VM 수', () => {
  const vms = Array.from({ length: 60 }, (_, i) => vm(`vm-${i}`, 'vc1', { gos: { ...rocky, parse: 'malformed', detailed: null, raw: `weird-${i}` } }));
  const p = buildOsProbe(vms, [{ id: 'vc1' }], [], { now: 1 });
  assert.equal(p.unparsed.length, 50); assert.equal(p.unparsedOmitted, 10);
  assert.equal(p.total.unparsedVms, 60);
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /t\.unparsedVms/, '화면은 목록 합이 아니라 전체 수를 쓴다');
  assert.match(jsx, /data\.unparsedOmitted/); assert.match(jsx, /data\.appliancesOmitted/); assert.match(jsx, /data\.extraKeysOmitted/);
  assert.match(jsx, /<th>아키텍처<\/th>/);
});

test('R2 서로게이트 — 상한 경계에서 짝 잃은 글자를 남기지 않는다', () => {
  const r = parseGuestDetailedData(`prettyName='a${'😀'.repeat(200)}'`);
  assert.equal(r.fields.prettyName.isWellFormed(), true);
  assert.ok(r.fields.prettyName.length <= 256);
  const g = sanitizeVmGos({ asked: true, detailed: { prettyName: `a${'😀'.repeat(200)}` } }, 1);
  assert.equal(g.detailed.prettyName.isWellFormed(), true);
  assert.equal(parseVappProduct(`<VAppProductInfo><name>a${'😀'.repeat(100)}</name></VAppProductInfo>`).name.isWellFormed(), true);
});

test('R2 엣지 수집 행에는 이 포탈의 상태를 붙이지 않는다 · 시스템 VM 은 구성을 읽은 VM 이 분모', () => {
  const p = buildOsProbe([
    vm('vm-1', 'vcS', { cfg: { managedBy: { extensionKey: 'x', type: 'y' } } }), vm('vm-2', 'vcS', {}),
    vm('vm-3', 'vcD', {}),
  ], [{ id: 'vcS', collectSource: 'site' }, { id: 'vcD' }], [{ vcenterId: 'vcS', osAt: 5, osError: '낡은 오류' }, { vcenterId: 'vcD', osAt: 7 }], { now: 10 });
  const s = p.vcenters.find((r) => r.id === 'vcS'); const d = p.vcenters.find((r) => r.id === 'vcD');
  assert.equal(s.status, null, '직접 수집 시절의 낡은 상태가 엣지 수집 행에 남지 않는다');
  assert.equal(d.status.osAt, 7);
  assert.equal(s.cfgRead, 1); assert.equal(s.managed, 1); assert.equal(d.cfgRead, 0); assert.equal(p.total.cfgRead, 1);
  assert.equal(managedText(0, 0, 5), '—', '구성을 하나도 못 읽었으면 0 이 아니라 —');
  assert.equal(managedText(1, 1, 2), '읽은 1대 중 1');
  assert.equal(managedText(2, 5, 5), '2');
  assert.equal(archText({ architecture: 'X86', bitness: '64' }), 'X86 · 64bit'); assert.equal(archText({}), '—');
});

test('R2 엣지 시각 원본 — 수신 시각으로 잘랐을 때만 edgeAt', () => {
  const NOW2 = 2_000_000_000_000;
  const f = sanitizeVmGos({ at: NOW2 + 5000.7, asked: true }, NOW2);
  assert.equal(f.at, NOW2); assert.equal(f.edgeAt, NOW2 + 5000);
  const past = sanitizeVmGos({ at: NOW2 - 5000, asked: true }, NOW2);
  assert.equal(past.at, NOW2 - 5000); assert.equal(Object.hasOwn(past, 'edgeAt'), false);
});

/* ---------------------------- 점검 3회차(반증 재현) 회귀 ---------------------------- */

test('R3 판이 바뀌면 주기를 기다리지 않고 다시 묻는다 · 판은 대상이 0 이어도 상태에', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  const refs = Array.from({ length: 3 }, (_, i) => `vm-${i}`);
  const old = fakeClient({ apiVersion: '8.0.1.0' });
  await refreshVmCfg(old, 'vcU', refs, { now: NOW, settings: SET });
  assert.equal(cacheGet('vcU', 'vm-0').os.asked, false);
  const nu = fakeClient({ apiVersion: '8.0.3.0' });
  const r = await refreshVmCfg(nu, 'vcU', refs, { now: NOW + 60_000, settings: SET });
  assert.equal(r.os.due, 3, '6시간을 기다리지 않는다');
  assert.equal(r.os.asked, true);
  assert.equal(cacheGet('vcU', 'vm-2').os.detailed.distroName, 'Rocky Linux');
  const r2 = await refreshVmCfg(fakeClient({ apiVersion: '8.0.3.0' }), 'vcU', refs, { now: NOW + 120_000, settings: SET });
  assert.equal(r2.os, null, '다 바뀐 뒤에는 다시 주기를 따른다');
  assert.equal(statusOf('vcU').osApiVersion, '8.0.3.0');
  // 판 바뀐 VM 이 상한보다 많으면 상한만큼씩
  _resetVmCfgCache(); _resetVmCfgRetry();
  const many = Array.from({ length: 25 }, (_, i) => `vm-${i}`);
  await refreshVmCfg(fakeClient({ apiVersion: '8.0.1.0' }), 'vcM', many, { now: NOW, settings: { ...SET, vmOsPerCycle: 30 } });
  const r3 = await refreshVmCfg(fakeClient({ apiVersion: '8.0.3.0' }), 'vcM', many, { now: NOW + 1000, settings: { ...SET, vmOsPerCycle: 10 } });
  assert.equal(r3.os.due, 10);
});

test('R3 예산 건너뜀 · 일부만 읽음을 정상 톤으로 덮지 않는다', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  await refreshVmCfg(fakeClient(), 'vcB', ['vm-1'], { now: NOW, budgetMs: 0, settings: SET });
  const st = statusOf('vcB');
  assert.equal(st.osSkipReason, 'budget'); assert.equal(st.osSkippedAt, NOW); assert.equal(st.osAt ?? null, null);
  const p = buildOsProbe([], [{ id: 'vcB' }], [{ vcenterId: 'vcB', ...st }], { now: NOW });
  const t = statusText(p.vcenters[0].status, p.vcenters[0], { collect: { osEnabled: true } });
  assert.equal(t.tone, 'amber'); assert.match(t.text, /이번 주기 건너뜀/);
  await refreshVmCfg(fakeClient(), 'vcB', ['vm-1'], { now: NOW + 1000, settings: SET });
  assert.equal(statusOf('vcB').osSkipReason, null, '다음에 돌면 건너뜀 사유를 지운다');
  const cut = statusText({ osAt: 5, osAsked: true, osCut: 750 }, { collectSource: 'direct' }, { collect: { osEnabled: true } });
  assert.equal(cut.tone, 'amber'); assert.match(cut.text, /일부만 읽음\(750대 남음/);
  // 건너뛴 뒤 다시 수집했으면(osAt > osSkippedAt) 정상
  assert.equal(statusText({ osAt: 10, osSkippedAt: 5, osSkipReason: 'budget', osAsked: true }, { collectSource: 'direct' }, {}).tone, 'ok');
});

test('R3 화면 — vCenter 를 법인이라 부르지 않는다 · 50행 절단을 밝힌다 · 파일 설명이 사실과 맞다 · 보고율 경계', () => {
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.equal(/법인별 수집 현황|<th className="right">법인<\/th>/.test(jsx), false);
  assert.match(jsx, /vCenter별 수집 현황/);
  assert.match(jsx, /limit=\{allSamples \? 0 : SAMPLE_VIEW\}/); assert.match(jsx, /모두 보기/);
  assert.equal(/종류 · 버전 · 개수만 있습니다/.test(jsx), false, '파일에 vCenter 이름 · 오류 문구도 있다');
  assert.match(jsx, /수집 상태와 오류 문구/);
  assert.equal(pct(5849, 5850), '>99%'); assert.equal(pct(1, 5850), '<1%'); assert.equal(pct(0, 5850), '0%'); assert.equal(pct(5850, 5850), '100%'); assert.equal(pct(1, 2), '50%');
});

/* ---------------------------- 점검 4회차(반증 재현) 회귀 ---------------------------- */

test('R4 빈 값 보고는 형식 못 읽음과 다른 사유 · 엣지에서도 같은 모양', () => {
  const g = parseVmGosProps({ 'guest.guestDetailedData': "prettyName='' distroName='' familyName=''" }, 1, { asked: true });
  assert.equal(g.parse, 'empty'); assert.equal(g.raw, null); assert.equal(g.detailed, null);
  const bad = parseVmGosProps({ 'guest.guestDetailedData': '완전히 다른 형식' }, 1, { asked: true });
  assert.equal(bad.parse, 'malformed'); assert.equal(bad.raw, '완전히 다른 형식');
  const p = buildOsProbe([vm('vm-1', 'vc1', { gos: g }), vm('vm-2', 'vc1', { gos: bad })], [{ id: 'vc1' }], [], { now: 1 });
  assert.equal(p.noDetail.emptyValues, 1); assert.equal(p.noDetail.unparsed, 1);
  assert.deepEqual(p.unparsed, [{ raw: '완전히 다른 형식', parse: 'malformed', count: 1 }]);
  const e = sanitizeVmGos({ asked: true, parse: 'empty', raw: 'x' }, 2);
  assert.equal(e.parse, 'empty'); assert.equal(e.raw, null, '빈 값 보고에는 원문을 싣지 않는다');
  assert.equal(sanitizeVmGos({ asked: false, parse: 'empty' }, 2).parse, null, '묻지 않았으면 판정도 없다');
  assert.equal(sanitizeVmGos({ asked: true, parse: 'weird' }, 2).parse, null, '모르는 판정 값은 받지 않는다');
  assert.ok(REASON_TEXT.emptyValues);
});

test('R4 모르는 키 상한으로 버린 수를 센다(파서 · 정제 · 집계)', () => {
  const g = parseVmGosProps({ 'guest.guestDetailedData': "prettyName='Rocky' " + Array.from({ length: 10 }, (_, i) => `k${i}='v'`).join(' ') }, 1, { asked: true });
  assert.equal(Object.keys(g.extra).length, 8); assert.equal(g.extraDropped, 2);
  const s2 = sanitizeVmGos({ asked: true, detailed: { prettyName: 'R' }, extra: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v'])), extraDropped: 3 }, 2);
  assert.equal(Object.keys(s2.extra).length, 8); assert.equal(s2.extraDropped, 5, '엣지가 버린 3 + 여기서 버린 2');
  assert.equal(Object.hasOwn(sanitizeVmGos({ asked: true, extraDropped: '9' }, 2), 'extraDropped'), false, '글자 수치는 받지 않는다');
  assert.equal(sanitizeVmGos({ asked: true, extraDropped: 1e12 }, 2).extraDropped, 10_000);
  const p = buildOsProbe([vm('vm-1', 'vc1', { gos: g })], [{ id: 'vc1' }], [], { now: 1 });
  assert.equal(p.total.extraDropped, 2);
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /t\.extraDropped/);
  assert.equal(/n\(8\)/.test(jsx), false, '상한 숫자를 화면에 박지 않는다');
});

test('R4 예산 건너뜀은 읽을 VM 이 있을 때만', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  await refreshVmCfg(fakeClient(), 'vcN', ['vm-1'], { now: NOW, settings: SET });
  await refreshVmCfg(fakeClient(), 'vcN', ['vm-1'], { now: NOW + 60_000, budgetMs: 0, settings: SET });
  assert.equal(statusOf('vcN').osSkipReason, null, '다시 읽을 VM 이 0대면 건너뜀이 아니다');
  assert.equal(statusOf('vcN').osSkippedAt ?? null, null);
  await refreshVmCfg(fakeClient(), 'vcN', ['vm-1', 'vm-2'], { now: NOW + 120_000, budgetMs: 0, settings: SET });
  assert.equal(statusOf('vcN').osSkipReason, 'budget', '새 VM 이 있는데 예산이 없으면 건너뜀');
});

test('R4 상태 글 — 오류 시각 · 마지막 성공 · 판 미상', () => {
  const p = buildOsProbe([], [{ id: 'vc1' }], [{ vcenterId: 'vc1', osAt: 1_000, osErrorAt: 2_000, osError: 'boom' }], { now: 3_000 });
  assert.equal(p.vcenters[0].status.osErrorAt, 2_000);
  const t = statusText(p.vcenters[0].status, p.vcenters[0], {});
  assert.match(t.text, /^오류 \d\d-\d\d \d\d:\d\d — boom · 마지막 성공 /);
  assert.match(statusText({ osError: 'x' }, null, {}).text, /성공 기록 없음/);
  assert.equal(notAskedText('8.0.1.0'), '제품 정보만(판 미달 · 8.0.1.0)');
  for (const v of ['', null, 'abc']) assert.equal(notAskedText(v), '제품 정보만(판 미상)');
  assert.match(statusText({ osAt: 5, osAsked: false, apiVersion: '' }, { collectSource: 'direct' }, {}).text, /판 미상/);
});

test('R4 화면 — 빌드 값도 그린다 · 스캔 상태 조회 실패가 점검 카드를 가리지 않는다', () => {
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /topText\(r\.buildNumber, 2, r\.buildNumberOmitted\)/);
  const g = fs.readFileSync(new URL('../../web/src/views/tools/GuestOsTools.jsx', import.meta.url), 'utf8');
  assert.match(g, /if \(err\) return <><RealOsProbe scope=\{scope\} \/><ErrorBox/);
  assert.match(g, /if \(!st\) return <><RealOsProbe scope=\{scope\} \/><Loading/);
});

/* ---------------------------- 점검 5회차 — 구조 재설계(판정 한 값 · 정규화 하나 · 글자 위생 하나 · 경로 세 값) ---------------------------- */

test('R5 판정 한 값 — ok · partial · empty · malformed (4회차 회귀: 빈 값 하나 + 형식 밖 값이 empty 로 삼켜지던 것)', () => {
  const P = (x) => parseVmGosProps({ 'guest.guestDetailedData': x }, 1, { asked: true });
  const cases = [
    ["prettyName='Rocky' distroName='R'", 'ok', true, false],
    ["prettyName='Rocky' junk", 'partial', true, true],
    ["prettyName='Rocky' distroName='R", 'partial', true, true],
    ["prettyName='' distroName=''", 'empty', false, false],
    ["prettyName='' distroName=\"Rocky Linux\"", 'malformed', false, true],
    ['zz', 'malformed', false, true],
    ["onlyUnknown='x'", 'malformed', false, true],
  ];
  for (const [x, want, hasD, hasRaw] of cases) {
    const g = P(x);
    assert.equal(g.parse, want, x); assert.equal(!!g.detailed, hasD, x); assert.equal(!!g.raw, hasRaw, x);
  }
  assert.equal(P(null).parse, null); assert.equal(parseVmGosProps({ 'guest.guestDetailedData': 'x' }, 1, { asked: false }).parse, null);
  const p = buildOsProbe([vm('a', 'vc1', { gos: P("prettyName='Rocky' junk") }), vm('b', 'vc1', { gos: P("prettyName='' distroName=\"R\"") })], [{ id: 'vc1' }], [], { now: 2 });
  assert.equal(p.total.partialVms, 1); assert.equal(p.total.unparsedVms, 1); assert.equal(p.total.detailed, 1);
  assert.equal(p.noDetail.unparsed, 1); assert.equal(p.noDetail.emptyValues, 0);
  assert.deepEqual(p.unparsed.map((x) => x.parse).sort(), ['malformed', 'partial']);
});

test('R5 정규화 하나 — 어떤 조합이 와도 묶음 규칙이 선다(수집기 · 엣지 같은 함수)', () => {
  let seed = 12345;
  const rnd = (k) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % k; };
  const pick = (arr) => arr[rnd(arr.length)];
  for (let i = 0; i < 2000; i++) {
    const input = {
      asked: pick([true, false, 'true', undefined]), parse: pick([...PARSE_OUTCOMES, null, 'weird', 5]),
      detailed: pick([null, { prettyName: 'R' }, {}, { evil: 1 }]), raw: pick([null, 'zz', '', '   ']),
      extra: pick([null, { a: 'b' }]), extraDropped: pick([0, 3, -1, '2']),
    };
    for (const g of [normalizeGos(input), sanitizeVmGos(input, 10)]) {
      const msg = JSON.stringify(input);
      if (!g.asked) { assert.equal(g.parse, null, msg); assert.equal(g.detailed, null, msg); assert.equal(g.raw, null, msg); assert.equal(g.extra, null, msg); assert.equal(Object.hasOwn(g, 'extraDropped'), false, msg); }
      if (g.detailed) assert.ok(g.parse === 'ok' || g.parse === 'partial', msg);
      else assert.ok(g.parse === null || g.parse === 'empty' || g.parse === 'malformed', msg);
      if (g.raw) assert.ok(g.parse === 'partial' || g.parse === 'malformed', msg);
      if (g.parse === 'ok' || g.parse === 'empty') assert.equal(g.raw, null, msg);
      assert.ok(g.parse === null || PARSE_OUTCOMES.includes(g.parse), msg);
    }
  }
});

test('R5 글자 위생 하나 — 입력에 원래 있던 짝 잃은 서로게이트도 정리', () => {
  assert.equal(cleanText('\ud800abc', 10).isWellFormed(), true);
  assert.equal(sanitizeVmGos({ asked: true, detailed: { prettyName: '\ud800abc' } }, 1).detailed.prettyName.isWellFormed(), true);
  assert.equal(parseVappProduct('<VAppProductInfo><name>&#xD800;x</name></VAppProductInfo>').name.isWellFormed(), true);
  assert.equal(parseGuestDetailedData("prettyName='\udc00x'").fields.prettyName.isWellFormed(), true);
});

test('R5 수집 경로 세 값 — REST 폴백 · 엣지 REST 에는 이 포탈의 낡은 상태를 붙이지 않는다', () => {
  const p = buildOsProbe([], [{ id: 'r', collectSource: 'rest' }, { id: 's', collectSource: 'site', collectMethod: 'rest' }, { id: 'd' }],
    [{ vcenterId: 'r', osAt: 5, osAsked: true }, { vcenterId: 's', osAt: 5 }, { vcenterId: 'd', osAt: 5, osAsked: true }], { now: 10 });
  const by = Object.fromEntries(p.vcenters.map((r) => [r.id, r]));
  assert.equal(by.r.collectSource, 'rest'); assert.equal(by.r.status, null);
  assert.equal(by.s.collectMethod, 'rest'); assert.equal(by.s.status, null);
  assert.equal(by.d.collectSource, 'direct'); assert.equal(by.d.status.osAt, 5);
  assert.deepEqual(statusText(by.r.status, by.r, {}), { text: 'REST 폴백 수집 — Tools 보고를 읽지 않음', tone: 'amber' });
  assert.equal(statusText(by.s.status, by.s, {}).text, '엣지 수집(REST 폴백 — Tools 보고를 읽지 않음)');
});

test('R5 오래됨은 따로 센다 · 수집을 끄면 캐시의 os 값을 버린다', async () => {
  const D = 86_400_000;
  const now = 100 * D;
  const mk = (at) => ({ ...rocky, at });
  const p = buildOsProbe([vm('a', 'v', { gos: mk(now - 1000) }), vm('b', 'v', { gos: mk(now - 3 * D) }), vm('c', 'v', { gos: mk(now - 30 * D) }), vm('d', 'v', { gos: mk(null) })], [{ id: 'v' }], [], { now });
  assert.deepEqual(p.detailedAge, { d1: 1, d7: 1, older: 1, unknown: 1 });
  _resetVmCfgCache(); _resetVmCfgRetry();
  await refreshVmCfg(fakeClient(), 'vcO', ['vm-1'], { now: NOW, settings: SET });
  assert.ok(cacheGet('vcO', 'vm-1').os);
  await refreshVmCfg(fakeClient(), 'vcO', ['vm-1'], { now: NOW + 1000, settings: { ...SET, vmOsScan: false } });
  assert.equal(cacheGet('vcO', 'vm-1').os, undefined, '끈 뒤 옛 값이 VM 에 실리지 않는다');
  assert.ok(cacheGet('vcO', 'vm-1').cfg, 'cfg 는 그대로');
  await refreshVmCfg(fakeClient(), 'vcO', ['vm-1'], { now: NOW + 2000, settings: { ...SET, vmCfgScan: false, vmOsScan: false } });
  assert.equal(cacheGet('vcO', 'vm-1').os, undefined, '둘 다 꺼도 os 는 버린다');
});

test('R5 문구 — 3.54.0 릴리스 노트 · 배너가 vCenter 를 법인이라 부르지 않는다', () => {
  const notes = JSON.parse(fs.readFileSync(new URL('../src/release-notes.json', import.meta.url), 'utf8')).notes;
  const n354 = notes.find((x) => x.version === '3.54.0').notes.join(' ');
  assert.equal(/법인별로 Tools/.test(n354), false); assert.equal(/종류 · 버전 · 개수만 들어갑니다/.test(n354), false);
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.equal(/직접 수집하는 법인/.test(jsx), false);
  assert.match(jsx, /data\.detailedAge/); assert.match(jsx, /t\.partialVms/);
});

/* ---------------------------- 점검 6회차(재설계 뒤 반증 재현) 회귀 ---------------------------- */

test('R6 같은 아는 키 중복 — 처음 값 + partial(원문 남김)', () => {
  const P = (x) => parseVmGosProps({ 'guest.guestDetailedData': x }, 1, { asked: true });
  const a = P("prettyName='A' prettyName='B'");
  assert.equal(a.detailed.prettyName, 'A'); assert.equal(a.parse, 'partial'); assert.ok(a.raw);
  const b = P("prettyName='A' prettyName=''");
  assert.equal(b.detailed.prettyName, 'A'); assert.equal(b.parse, 'partial');
  const c = P("prettyName='' prettyName='B'");
  assert.equal(c.detailed, null); assert.equal(c.parse, 'malformed', '처음 값(빈 값)으로 고정 — 중복 흔적이 있어 empty 가 아니다');
});

test('R6 partial 은 원문이 있을 때만 — 엣지가 원문 없이 보내면 ok', () => {
  for (const raw of [undefined, null, '', '   ']) {
    const g = sanitizeVmGos({ asked: true, parse: 'partial', detailed: { prettyName: 'R' }, raw }, 1);
    assert.equal(g.parse, 'ok', String(raw)); assert.equal(g.raw, null);
  }
  const g2 = sanitizeVmGos({ asked: true, parse: 'partial', detailed: { prettyName: 'R' }, raw: 'x junk' }, 1);
  assert.equal(g2.parse, 'partial'); assert.equal(g2.raw, 'x junk');
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /t\.unparsedVms > 0 \|\| t\.partialVms > 0\) && \(/, '원문 목록이 비어도 수는 보인다');
});

test('R6 옛 엣지(3.54 ~ 3.58 모양 — parse 칸 없음) 호환: 빈 값 보고는 empty, 형식 밖은 malformed', () => {
  // 3.54.0 엣지는 아는 키를 못 읽으면 원문을 raw 로, 읽었으면 detailed 만 보냈다(emptyValues · parse 칸 없음).
  const empty = sanitizeVmGos({ at: 1, asked: true, detailed: null, extra: null, raw: "prettyName='' distroName=''", vapp: null }, 5);
  assert.equal(empty.parse, 'empty'); assert.equal(empty.raw, null);
  const bad = sanitizeVmGos({ at: 1, asked: true, detailed: null, extra: null, raw: 'zz', vapp: null }, 5);
  assert.equal(bad.parse, 'malformed'); assert.equal(bad.raw, 'zz');
  const ok = sanitizeVmGos({ at: 1, asked: true, detailed: { prettyName: 'R' }, extra: null, raw: null, vapp: null }, 5);
  assert.equal(ok.parse, 'ok');
  const notAsked = sanitizeVmGos({ at: 1, asked: false, detailed: null, raw: "prettyName=''" }, 5);
  assert.equal(notAsked.parse, null);
  const p = buildOsProbe([vm('a', 'v', { gos: empty }), vm('b', 'v', { gos: bad })], [{ id: 'v' }], [], { now: 9 });
  assert.equal(p.noDetail.emptyValues, 1); assert.equal(p.noDetail.unparsed, 1);
});

test('R6 예산 공정성 — dev 에 읽을 VM 이 있으면 os 는 남은 예산의 절반까지만 · dev 건너뜀 사유', async () => {
  _resetVmCfgCache(); _resetVmCfgRetry();
  const slow = (ms) => {
    const calls = [];
    return {
      calls, sc: { apiVersion: '8.0.3.0' },
      async retrieveManyObjectProps(type, refs, paths, chunk, opts) {
        calls.push({ paths: [...paths], t: Date.now() });
        await new Promise((r) => setTimeout(r, ms));
        const isOs = paths.includes('config.vAppConfig.product');
        return refs.map((ref) => ({ type, ref, props: isOs ? { 'guest.guestDetailedData': ROCKY } : paths.includes('config.hardware.device') ? { 'config.hardware.device': '' } : {} }));
      },
    };
  };
  const refs = Array.from({ length: 1000 }, (_, i) => `vm-${i}`);
  const c = slow(60);
  const r = await refreshVmCfg(c, 'vcF', refs, { now: NOW, budgetMs: 400, settings: { ...SET, vmCfgPerCycle: 250, vmOsPerCycle: 1000, vmDevPerCycle: 75 } });
  assert.ok(r.dev && r.dev.fetched > 0, `os 가 예산을 다 쓰지 않아 dev 도 읽는다: ${JSON.stringify(r)}`);
  assert.ok(r.os.cut > 0, 'os 는 남은 몫까지만 읽고 다음 주기로');
  _resetVmCfgCache(); _resetVmCfgRetry();
  await refreshVmCfg(fakeClient(), 'vcG', ['vm-1'], { now: NOW, budgetMs: 0, settings: SET });
  assert.equal(statusOf('vcG').devSkipReason, 'budget', '읽을 VM 이 있는데 예산이 없으면 사유를 남긴다');
});

test('R6 화면 문구 — 나이 구간 · 버린 키 · 파일 내용', () => {
  const jsx = fs.readFileSync(new URL('../../web/src/views/tools/RealOsProbe.jsx', import.meta.url), 'utf8');
  assert.match(jsx, /1~7일 \{n\(data\.detailedAge\.d7\)\}/); assert.equal(/7일 안 \{/.test(jsx), false);
  assert.match(jsx, /\{t\.extraDropped > 0 && <div>상한 · 이름 형식으로 버린 모르는 키/);
  assert.match(jsx, /문서에 없는 키의 이름 · 개수와 예시 값/);
});
