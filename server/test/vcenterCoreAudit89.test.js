/**
 * test/vcenterCoreAudit89.test.js — 전체 점검 89회차(vCenter 수집 코어 · 인벤토리 · 스토어) 회귀.
 *
 *  F1 store 병합의 정상 · lastGood 분기가 캐시(수집 시각)의 location.region 을 그대로 실었다 — 지역 범위 판정(auth/scope.js)의 입력이라
 *     관리자가 region 을 바꿔도 다음 수집까지(실패 중 lastGood 이면 보존 창 6시간까지) 옛 지역 범위 계정이 그 vCenter 인벤토리를 봤다.
 *     → 점검중 · 위임 분기(v2.611)와 같이 등록부 region 이 이긴다(withRegistryVcenter).
 *  F2 soapClient · soapParse 의 게으른 정규식(`[\s\S]*?`)이 닫히지 않은 태그 반복에 O(n²)(75회차 R6 이 남긴 형제 — 측정 200KB 0.3~2.2초)
 *     → soapParse.js 선형 훑기(returnvalBlocks · exactTagBodies · execAfter · firstTagInner). 옛 정규식과 무작위 대조 + 선형 확인 + 소스 스윕.
 *  F3 증분 수집(updateSession) sweep 이 **다른** vCenter 의 쓰지 않은 세션 정리를 기다려, 느린 vCenter 하나가 이 vCenter 수집 데드라인을 먹었다.
 *
 * ⚠ 기준 시각은 실제 시각을 정시로 떨어뜨린 T0(고정 epoch · Date.now() 직접 금지 — docs/rules/common.md). store 통합은 store 가 내부에서
 *   Date.now() 로 보존 창을 재므로 '지금' 의 상대값(분 단위 — 경계에 걸리지 않게 넉넉히)을 쓴다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('vc89-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

let seed = 89;
const rnd = (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (((t ^ (t >>> 14)) >>> 0) % n); };
const time = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };

// ── F2 — 옛 정규식(기준)과 같은 결과 ─────────────────────────────────────────
test('F2 — 선형 훑기 넷은 옛 게으른 정규식과 결과가 같다(무작위 1만 건)', async () => {
  const { returnvalBlocks, exactTagBodies, execAfter, firstTagInner } = await import('../src/vcenter/soapParse.js');
  const T = ['<returnval>', '<returnval xsi:type="VmEvent">', '<returnval\n>', '<returnvalue>', '<returnval', '</returnval>',
    '<ipRoute>', '</ipRoute>', '<gateway>', '<ipAddress>', '<ipAddress a="1">', '</ipAddress>', '<detail>', 'xsi:type="vim25:NoPermission"', 'xsi:type="x"',
    '<key>', '<key a="1">', '<keyX>', '</key>', '<vm>', '<vmotion>', '</vm>', '<name>', '</name>', '<nameInfo>', '<healthState>',
    '10.0.0.1', 'abc', 'x', '>', '<', ' ', '\n', '"'];
  const oldBlocks = (s, wb) => [...s.matchAll(wb ? /<returnval\b([^>]*)>([\s\S]*?)<\/returnval>/g : /<returnval([^>]*)>([\s\S]*?)<\/returnval>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
  const oldExact = (s, o, c) => [...s.matchAll(new RegExp(`${o}([\\s\\S]*?)${c.replace('/', '\\/')}`, 'g'))].map((m) => m[1]);
  for (let n = 0; n < 10_000; n += 1) {
    let s = ''; const len = 1 + rnd(40);
    for (let i = 0; i < len; i += 1) s += T[rnd(T.length)];
    const j = JSON.stringify(s);
    assert.deepEqual(returnvalBlocks(s), oldBlocks(s, false), j);
    assert.deepEqual(returnvalBlocks(s, { wordBoundary: true }), oldBlocks(s, true), j);
    assert.deepEqual(exactTagBodies(s, '<returnval>', '</returnval>'), oldExact(s, '<returnval>', '</returnval>'), j);
    assert.deepEqual(exactTagBodies(s, '<ipRoute>', '</ipRoute>'), oldExact(s, '<ipRoute>', '</ipRoute>'), j);
    assert.equal(exactTagBodies(s, '<returnval>', '</returnval>', 1)[0], oldExact(s, '<returnval>', '</returnval>')[0], j);
    assert.equal(execAfter(s, '<detail>', /xsi:type="(?:[\w-]+:)?([\w]+)"/)?.[1], /<detail>[\s\S]*?xsi:type="(?:[\w-]+:)?([\w]+)"/.exec(s)?.[1], j);
    assert.equal(execAfter(s, '<gateway>', /<ipAddress[^>]*>([^<]+)<\/ipAddress>/)?.[1], /<gateway>[\s\S]*?<ipAddress[^>]*>([^<]+)<\/ipAddress>/.exec(s)?.[1], j);
    assert.equal(execAfter(s, '<nameInfo>', /<key>(\w+)<\/key>/)?.[1], /<nameInfo>[\s\S]*?<key>(\w+)<\/key>/.exec(s)?.[1], j);
    assert.equal(execAfter(s, '<healthState>', /<key>([^<]*)<\/key>/)?.[1], /<healthState>[\s\S]*?<key>([^<]*)<\/key>/.exec(s)?.[1], j);
    for (const tag of ['key', 'vm', 'name']) {
      assert.equal(firstTagInner(s, tag), new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(s)?.[1], `${tag} ${j}`);
    }
  }
});

// ── F2 — 닫히지 않은 태그 반복에 선형 ────────────────────────────────────────
test('F2 — 인벤토리 · 이벤트 · GPU 성능 파서가 닫히지 않은 태그 반복에 선형이다(정상 응답과 같은 자릿수)', async () => {
  const { parseObjectContent } = await import('../src/vcenter/soapParse.js');
  const { parseEventsXml, parseHostGpuPerf } = await import('../src/vcenter/soapClient.js');
  const n = 40_000;
  const rvOpen = '<returnval>x'.repeat(n);                                                           // 480KB
  const rvAttrOpen = '<returnval xsi:type="VmEvent">x'.repeat(n / 2);
  const keyOpen = `<returnval xsi:type="VmEvent">${'<key>1'.repeat(n)}</returnval>`;               // 240KB · 한 블록 안
  const normalInv = `${'<returnval><obj type="VirtualMachine">vm-1</obj><propSet><name>name</name><val xsi:type="xsd:string">web01</val></propSet></returnval>'.repeat(n / 16)}`;
  const normalEv = `${'<returnval xsi:type="VmPoweredOnEvent"><key>1</key><createdTime>2026-01-01T00:00:00Z</createdTime><userName>u</userName><fullFormattedMessage>m</fullFormattedMessage></returnval>'.repeat(n / 16)}`;
  const baseInv = time(() => parseObjectContent(normalInv));
  const baseEv = time(() => parseEventsXml(normalEv));
  for (const [name, f, x, base] of [
    ['parseObjectContent', parseObjectContent, rvOpen, baseInv],
    ['parseEventsXml(블록)', parseEventsXml, rvAttrOpen, baseEv],
    ['parseEventsXml(<key)', parseEventsXml, keyOpen, baseEv],
    ['parseHostGpuPerf', (s) => parseHostGpuPerf(s, new Map()), rvOpen, baseInv],
  ]) {
    const t = time(() => f(x));
    assert.ok(t < Math.max(150, base * 20), `${name} 닫히지 않은 태그 ${x.length}자 ${t.toFixed(1)}ms (정상 ${base.toFixed(1)}ms)`);
  }
  // 정상 응답은 예전과 같은 값
  const ev = parseEventsXml('<returnval xsi:type="VmPoweredOnEvent"><key>7</key><createdTime>2026-01-01T00:00:00Z</createdTime><userName>dom\\u</userName><vm><name>web &amp; 01</name><vm type="VirtualMachine">vm-1</vm></vm><fullFormattedMessage>Powered  on</fullFormattedMessage></returnval>');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].key, '7');
  assert.equal(ev[0].type, 'VmPoweredOnEvent');
  assert.equal(ev[0].entity, 'web & 01');
  assert.equal(ev[0].message, 'Powered on');
  const gpu = parseHostGpuPerf('<returnval><entity type="HostSystem">host-1</entity><id><counterId>9</counterId><instance>0</instance></id><value>3800</value></returnval>', new Map([['9', 'util']]));
  assert.deepEqual(gpu.get('host-1'), { util: 38 });
  const inv = parseObjectContent('<returnval><obj type="HostSystem">host-1</obj><propSet><name>name</name><val>esx &amp; 1</val></propSet></returnval>');
  assert.deepEqual(inv, [{ type: 'HostSystem', ref: 'host-1', props: { name: 'esx & 1' } }]);
});

test('F2 — soapClient.js 코드에 게으른 [\\s\\S]*? 정규식이 남지 않는다(주석 제외 스윕)', () => {
  const code = stripComments(fs.readFileSync(path.join(SRC, 'vcenter/soapClient.js'), 'utf8'));
  const hits = code.split('\n').filter((l) => l.includes('[\\s\\S]*?') || l.includes('[\\\\s\\\\S]*?'));
  assert.deepEqual(hits, [], '선형 훑기(soapParse.js returnvalBlocks · exactTagBodies · execAfter · firstTagInner)를 쓸 것');
});

// ── F1 — store 병합: 등록부 region 이 이긴다 ──────────────────────────────────
test('F1 — 정상 · lastGood 분기도 등록부 region 이 이긴다(지역 범위 판정 입력)', async () => {
  const vcFile = path.join(DIR, 'vcenters.json');
  fs.writeFileSync(vcFile, JSON.stringify({ vcenters: [
    { id: 'r-ok', name: 'r-ok', host: 'https://127.0.0.1:1', username: 'u', password: 'p', location: { region: 'APAC', city: 'Seoul' } },
    { id: 'r-lg', name: 'r-lg', host: 'https://127.0.0.1:1', username: 'u', password: 'p', location: { region: 'APAC' } },
    { id: 'r-same', name: 'r-same', host: 'https://127.0.0.1:1', username: 'u', password: 'p', location: { region: 'EU' } },
  ] }));
  const { store, withRegistryVcenter } = await import('../src/store.js');
  const { scopedVcenterIds } = await import('../src/auth/scope.js');
  const now = Date.now();
  const inv = (id, region) => ({
    vcenter: { id, name: id, status: 'connected', location: { region, city: 'Warsaw' } },
    hosts: [{ id: `${id}:host-1`, vcenterId: id, name: `${id}-esx`, connectionState: 'CONNECTED' }],
    vms: [{ id: `${id}:vm-1`, vcenterId: id, name: `${id}-vm`, powerState: 'POWERED_ON' }], datastores: [], networks: [], alarms: [],
  });
  for (const id of ['r-ok', 'r-lg', 'r-same']) store.vcLast.set(id, now);   // 이번 주기 수집 안 함(주기 미도래)
  const okData = inv('r-ok', 'EU');
  store.vcCache.set('r-ok', { ok: true, data: okData, at: now });
  store.vcCache.set('r-lg', { ok: false, vc: {}, err: { message: 'timeout' }, at: now, lastGoodAt: now - 10 * 60_000, lastGood: inv('r-lg', 'EU') });
  const sameData = inv('r-same', 'EU');
  store.vcCache.set('r-same', { ok: true, data: sameData, at: now });
  await store.refresh();
  const snap = store.get();
  const byId = new Map(snap.vcenters.map((v) => [v.id, v]));
  assert.equal(byId.get('r-ok').location.region, 'APAC');
  assert.equal(byId.get('r-ok').location.city, 'Warsaw', '표시값(도시)은 받은 값 그대로');
  assert.equal(byId.get('r-lg').location.region, 'APAC');
  assert.equal(byId.get('r-lg').stale, true);
  assert.equal(okData.vcenter.location.region, 'EU', '캐시 객체는 바꾸지 않는다');
  assert.equal(byId.get('r-same'), sameData.vcenter, 'region 이 같으면 캐시 객체 그대로');
  // 지역 범위 계정: EU 계정은 region 을 옮긴 두 vCenter 를 더 이상 보지 않고, APAC 계정이 본다
  const eu = scopedVcenterIds({ username: 'eu', role: 'viewer', scope: { regions: ['EU'] } }, snap);
  const apac = scopedVcenterIds({ username: 'ap', role: 'viewer', scope: { regions: ['APAC'] } }, snap);
  assert.deepEqual([...eu].sort(), ['r-same']);
  assert.deepEqual([...apac].sort(), ['r-lg', 'r-ok']);
  // 순수 판정: 등록부 region 이 비었으면 받은 값 그대로
  const cached = { id: 'x', location: { region: 'EU' } };
  assert.equal(withRegistryVcenter(cached, { location: {} }), cached);
  assert.equal(withRegistryVcenter(null, { location: { region: 'EU' } }), null);
});

// ── F3 — 증분 세션 정리는 기다리지 않는다 ────────────────────────────────────
function fakeClient({ slowCleanupMs = 0, calls }) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    sc: { propertyCollector: 'propertyCollector', viewManager: 'ViewManager', rootFolder: 'group-d1' },
    signal: null,
    async login() { calls.push('login'); },
    async callRaw(body) {
      if (body.includes('<CreatePropertyCollector')) return '<returnval type="PropertyCollector">pc-2</returnval>';
      if (body.includes('<CreateContainerView')) return '<returnval type="ContainerView">view-1</returnval>';
      if (body.includes('<CreateFilter')) return '<returnval type="PropertyFilter">filter-1</returnval>';
      if (body.includes('<WaitForUpdatesEx')) return '<WaitForUpdatesExResponse/>';
      if (body.includes('<DestroyPropertyCollector')) { calls.push('destroy'); await delay(slowCleanupMs); return ''; }
      return '';
    },
    async retrieveManyObjectProps() { return []; },
    async logout() { calls.push('logout'); await delay(slowCleanupMs); },
  };
}

test('F3 — 다른 vCenter 의 쓰지 않은 증분 세션 정리를 이 vCenter 수집이 기다리지 않는다', async () => {
  const { inventoryViaUpdates, closeAllUpdateSessions } = await import('../src/vcenter/updateSession.js');
  const types = ['VirtualMachine'];
  const specs = [{ type: 'VirtualMachine', paths: ['name'] }];
  const callsA = []; const callsB = [];
  const vcA = { id: 'vc-a', host: 'https://a', username: 'u', password: 'p' };
  const vcB = { id: 'vc-b', host: 'https://b', username: 'u', password: 'p' };
  await inventoryViaUpdates(vcA, types, specs, { makeClient: () => fakeClient({ slowCleanupMs: 1_500, calls: callsA }), now: T0 });
  const t0 = performance.now();
  await inventoryViaUpdates(vcB, types, specs, { makeClient: () => fakeClient({ calls: callsB }), now: T0 + 16 * 60_000 });   // A 는 15분 넘게 쓰지 않음
  const ms = performance.now() - t0;
  assert.ok(ms < 700, `vc-b 증분 조회가 vc-a 정리(1.5초 × 2)를 기다렸다: ${ms.toFixed(0)}ms`);
  assert.ok(callsA.includes('destroy'), 'vc-a 의 쓰지 않은 세션 정리는 시작됐다');
  await new Promise((r) => setTimeout(r, 3_300));
  assert.ok(callsA.includes('logout'), 'vc-a 의 세션은 결국 로그아웃된다');
  await closeAllUpdateSessions();
});
