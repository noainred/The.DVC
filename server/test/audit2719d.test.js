// v2.719 감사 그룹 D — vCenter 부가 갱신 예산(S1-01) · 태그 중단 캐시(S1-02) · 호스트 구성 중단 캐시(S1-03) ·
// 태그 연결 일부만 읽음(B1-04) · VM storageGB 결측(B1-09). 전부 실제 모듈을 호출한다. 기준 시각은 고정값(Date.now() 금지).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2719d-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter(127.0.0.1) 접속용 — 이 테스트 전용

const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });
const T0 = Date.UTC(2026, 9, 7, 3, 30, 0);   // 고정 기준 시각(정시에서 떨어뜨림)
const H6 = 6 * 3_600_000;

/* ───────── 가짜 vCenter(audit2598a 와 같은 모양) ───────── */
const env = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>' + inner + '</soapenv:Body></soapenv:Envelope>';
const SC = env('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const ps = (name, val) => `<propSet><name>${name}</name><val>${val}</val></propSet>`;
const obj = (type, ref, props) => `<returnval><obj type="${type}">${ref}</obj>${props}</returnval>`;
const INV = env('<RetrievePropertiesResponse xmlns="urn:vim25">'
  + obj('HostSystem', 'host-1', ps('name', 'esx-a') + ps('runtime.connectionState', 'connected') + ps('summary.hardware.numCpuCores', '8') + ps('summary.hardware.cpuMhz', '2000') + ps('summary.hardware.memorySize', String(64 * 1024 ** 3)))
  // vm-1: committed 를 못 읽음(속성 없음) · vm-2: 10GiB 보고
  + obj('VirtualMachine', 'vm-1', ps('name', 'app') + ps('runtime.host', 'host-1') + ps('runtime.powerState', 'poweredOn') + ps('summary.config.template', 'false'))
  + obj('VirtualMachine', 'vm-2', ps('name', 'db') + ps('runtime.host', 'host-1') + ps('runtime.powerState', 'poweredOn') + ps('summary.config.template', 'false')
    + ps('summary.storage.committed', String(10 * 1024 ** 3)) + ps('summary.storage.uncommitted', '0'))
  + obj('ClusterComputeResource', 'domain-c1', ps('name', 'cl'))
  + '</RetrievePropertiesResponse>');

async function fakeVc() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const ok = (x) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(x); };
      if (b.includes('<RetrieveServiceContent')) return ok(SC);
      if (b.includes('<Login ')) return ok(env('<LoginResponse xmlns="urn:vim25"><returnval><key>s</key></returnval></LoginResponse>'));
      if (b.includes('<Logout')) return ok(env('<LogoutResponse xmlns="urn:vim25"/>'));
      if (b.includes('<CreateContainerView')) return ok(env('<CreateContainerViewResponse xmlns="urn:vim25"><returnval type="ContainerView">session[1]view-1</returnval></CreateContainerViewResponse>'));
      if (b.includes('<RetrieveProperties')) return ok(INV);
      res.writeHead(500, { 'content-type': 'text/xml' }); res.end(env('<soapenv:Fault><faultstring>unexpected</faultstring></soapenv:Fault>'));
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return `http://127.0.0.1:${port}`;
}

/* ───────── S1-01 부가 갱신 예산은 vCenter 수집 데드라인을 넘지 않는다 ───────── */
test('S1-01 auxBudgetMs: 남은 데드라인에 맞추고, 하한 미만·중단이면 null', async () => {
  const { auxBudgetMs, AUX_RESERVE_MS, AUX_MIN_MS, collectDeadlineMs } = await import('../src/vcenter/soapClient.js');
  const deadlineAt = T0 + 90_000;
  assert.equal(auxBudgetMs(deadlineAt, 20_000, T0), 20_000, '여유가 충분하면 자기 예산 그대로');
  assert.equal(auxBudgetMs(deadlineAt, 45_000, T0 + 40_000), 90_000 - 40_000 - AUX_RESERVE_MS, '남은 시간 − 여유로 줄인다');
  assert.equal(auxBudgetMs(deadlineAt, 20_000, deadlineAt - AUX_RESERVE_MS - AUX_MIN_MS + 1), null, '하한 미만이면 건너뜀');
  const ac = new AbortController(); ac.abort();
  assert.equal(auxBudgetMs(deadlineAt, 20_000, T0, ac.signal), null, '중단된 수집은 부가 갱신을 시작하지 않는다');
  // 데드라인 식은 store.vcDeadlineMs 와 같아야 한다(두 벌 — 순환 import 회피).
  const { vcDeadlineMs } = await import('../src/store.js');
  for (const t of [undefined, 5_000, 30_000, 45_000, 120_000, 3e9]) assert.equal(collectDeadlineMs({ timeoutMs: t }), vcDeadlineMs({ timeoutMs: t }), `timeoutMs=${t}`);
});

test('S1-01·B1-09 가짜 vCenter 수집: 데드라인이 모자라면 부가 갱신을 건너뛰고 밝힌다 · storageGB 결측은 null', async () => {
  const { collectFromVCenterSoap } = await import('../src/vcenter/soapClient.js');
  const host = await fakeVc();
  const vc = { id: 'vc-2719d', name: 'fake', host, username: 'u', password: 'p', timeoutMs: 5000 };
  const s1 = await collectFromVCenterSoap(vc);
  assert.equal(s1.vcenter.auxSkipped, undefined, '여유가 있으면 건너뛰지 않는다');
  const vm1 = s1.vms.find((v) => v.name === 'app');
  const vm2 = s1.vms.find((v) => v.name === 'db');
  assert.equal(vm1.storageGB, null, 'summary.storage.committed 를 못 읽으면 0 이 아니라 null(B1-09)');
  assert.equal(vm1.uncommittedGB, null);
  assert.equal(vm2.storageGB, 10);
  assert.equal(vm2.uncommittedGB, 0, '보고된 0 은 값이다');
  // 데드라인이 이미 지난 수집 — 부가 갱신 6종을 시작하지 않고 사유를 남긴다(본 인벤토리는 그대로 성공).
  const s2 = await collectFromVCenterSoap(vc, { deadlineAt: Date.now() + 1_000 });
  const kinds = (s2.vcenter.auxSkipped || []).map((x) => x.kind).sort();
  assert.deepEqual(kinds, ['clustercfg', 'dscfg', 'hostcfg', 'tags', 'vmcfg'], '부가 갱신 5종(perfManager 없는 vCenter 라 경합 제외)');
  assert.ok((s2.vcenter.auxSkipped || []).every((x) => x.reason === 'deadline'));
  assert.equal(s2.vms.length, 2, '부가 갱신을 건너뛰어도 인벤토리는 그대로');
});

/* ───────── S1-02 중단된 태그 갱신을 '갱신 완료(6시간)' 로 캐시하지 않는다 ───────── */
const tagSettings = { tagScan: true, tagRefreshMs: H6 };
test('S1-02 수집 중단(signal abort)이면 태그 캐시를 쓰지 않고 다음 주기에 다시 읽는다', async () => {
  const tags = await import('../src/tags/collect.js');
  tags._resetTagInv();
  const ac = new AbortController();
  let reads = 0;
  const c = {
    sc: { customFieldsManager: 'cfm' },
    retrieveObjectProps: async () => { reads += 1; ac.abort(new Error('vCenter 수집 데드라인')); const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; },
    retrieveManyObjectProps: async () => [],
  };
  const vc = { id: 'vc-tag-abort', host: 'https://127.0.0.1:9', username: 'u', password: 'p' };
  const r1 = await tags.refreshTagInv(c, vc, ['vm-1'], { now: T0, signal: ac.signal, settings: tagSettings });
  assert.equal(r1, null, '직전 값이 없으면 null(모름) 을 그대로 돌려준다');
  assert.equal(tags.getTagInv(vc.id), null, '중단 결과를 캐시에 남기지 않는다');
  // 다음 주기(1분 뒤) — 다시 읽는다.
  await tags.refreshTagInv(c, vc, ['vm-1'], { now: T0 + 60_000, settings: tagSettings, budgetMs: 2_000 });
  assert.equal(reads, 2, '6시간을 기다리지 않고 다음 주기에 다시 읽는다');
});

test('S1-02 시한 같은 일시 실패는 짧은 재시도 시각을 단다(6시간 대기 아님)', async () => {
  const tags = await import('../src/tags/collect.js');
  tags._resetTagInv();
  let reads = 0;
  const c = { sc: { customFieldsManager: 'cfm' }, retrieveObjectProps: async () => { reads += 1; throw new Error('vCenter 요청 시한 초과(timed out)'); }, retrieveManyObjectProps: async () => [] };
  const vc = { id: 'vc-tag-timeout', host: 'https://127.0.0.1:9', username: 'u', password: 'p' };
  const r = await tags.refreshTagInv(c, vc, [], { now: T0, settings: tagSettings, budgetMs: 2_000 });
  assert.equal(r.retryAt, T0 + tags.TAG_RETRY_MS);
  await tags.refreshTagInv(c, vc, [], { now: T0 + 60_000, settings: tagSettings, budgetMs: 2_000 });
  assert.equal(reads, 1, '재시도 시각 전에는 캐시');
  await tags.refreshTagInv(c, vc, [], { now: T0 + tags.TAG_RETRY_MS + 1, settings: tagSettings, budgetMs: 2_000 });
  assert.equal(reads, 2, '재시도 시각이 지나면 다시 읽는다');
});

/* ───────── S1-03 호스트 구성 — 중단·시한 실패한 호스트를 '방금 읽음' 으로 캐시하지 않는다 ───────── */
const hostSettings = { hostCfgScan: true, hostCfgRefreshMs: H6, hostCfgPerCycle: 40 };
const hostClient = (callRaw) => ({
  retrieveManyObjectProps: async (type, refs) => (type === 'HostSystem'
    ? refs.map((ref) => ({ ref, props: { 'configManager.advancedOption': 'opt-1', 'configManager.imageConfigManager': 'img-1' } }))
    : []),
  callRaw,
});
test('S1-03 QueryOptions 가 중단·시한으로 실패하면 put 하지 않고 다음 주기에 다시 고른다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache();
  const abortErr = () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; return e; };
  const r1 = await hc.refreshHostCfg(hostClient(async () => { throw abortErr(); }), 'vc-h', ['host-1'], { now: T0, settings: hostSettings });
  assert.equal(r1.fetched, 0, '못 읽은 호스트를 fetched 로 세지 않는다');
  assert.equal(r1.transient, 1);
  assert.equal(cache.get('vc-h', 'host-1'), null, 'null 값 항목을 캐시에 넣지 않는다');
  assert.deepEqual(cache.pickDue('vc-h', ['host-1'], { now: T0 + 60_000, periodMs: H6, max: 40 }), ['host-1'], '다음 주기에 다시 고른다');
  // 정상 응답이면 캐시한다.
  const r2 = await hc.refreshHostCfg(hostClient(async () => '<returnval>PartnerSupported</returnval>'), 'vc-h', ['host-1'], { now: T0 + 60_000, settings: hostSettings });
  assert.equal(r2.fetched, 1);
  assert.ok(cache.get('vc-h', 'host-1'));
});

test('S1-03 InvalidName(그 버전에 없는 설정)·권한 오류는 예전처럼 그 값만 null 로 캐시한다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache();
  const r = await hc.refreshHostCfg(hostClient(async (body) => { if (body.includes('QueryOptions')) throw new Error('InvalidName'); throw new Error('NoPermission'); }), 'vc-h2', ['host-1'], { now: T0, settings: hostSettings });
  assert.equal(r.fetched, 1);
  assert.equal(r.transient, 0);
  assert.ok(cache.get('vc-h2', 'host-1'));
  assert.equal(hc.isTransientErr(new Error('NoPermission')), false);
  assert.equal(hc.isTransientErr(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
});

/* ───────── B1-04 태그 연결을 일부만 읽은 vCenter 는 '누락' 을 단정하지 않는다 ───────── */
test('B1-04 연결 조회가 예산으로 잘리면 partialTags=true', async () => {
  const tags = await import('../src/tags/collect.js');
  const { VCenterClient } = await import('../src/vcenter/restClient.js');
  tags._resetTagInv();
  const P = VCenterClient.prototype;
  const saved = {};
  const patch = {
    login: async () => {}, logout: async () => {},
    listTagCategories: async () => ['cat-1'],
    getTagCategory: async (id) => ({ id, name: 'Owner', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] }),
    listTags: async () => Array.from({ length: 150 }, (_, i) => `tag-${i}`),
    getTag: async (id) => ({ id, name: id, category_id: 'cat-1' }),
    listAttachedObjectsOnTags: async (ids) => { await new Promise((r) => setTimeout(r, 120)); return ids.map((tag_id) => ({ tag_id, object_ids: [{ id: 'vm-1', type: 'VirtualMachine' }] })); },
  };
  for (const k of Object.keys(patch)) { saved[k] = P[k]; P[k] = patch[k]; }
  try {
    const c = { sc: {}, retrieveObjectProps: async () => [], retrieveManyObjectProps: async () => [] };
    const r = await tags.refreshTagInv(c, { id: 'vc-tag-cut', host: 'https://h', username: 'u', password: 'p' }, ['vm-1'], { now: T0, settings: tagSettings, budgetMs: 60 });
    assert.equal(r.tagsError, null);
    assert.ok(r.truncated.tags > 0);
    assert.equal(r.partialTags, true, '연결을 다 읽지 못했다는 사실을 싣는다');
  } finally { for (const k of Object.keys(saved)) P[k] = saved[k]; }
});

test('B1-04 analyzeTags: 일부만 읽은 vCenter 의 누락은 행·집계가 아니라 확인 안 됨(부분)', async () => {
  const { analyzeTags, tagsPartialOf } = await import('../src/tags/analyze.js');
  const inv = (partialTags) => ({ at: T0, tagsAt: T0, categories: [{ id: 'c1', name: 'Owner' }], tags: [{ id: 't1', name: 'teamA', cat: 0 }],
    vmTags: { 'vm-a': [0] }, truncated: { tags: partialTags ? 100 : 0 }, partialTags });
  const vms = [{ id: 'vc1:vm-a', vcenterId: 'vc1', name: 'a' }, { id: 'vc1:vm-b', vcenterId: 'vc1', name: 'b' }];
  const policy = { requiredCategories: ['Owner'] };
  const part = analyzeTags([{ id: 'vc1', name: 'vc1', tagInv: inv(true) }], vms, policy);
  assert.equal(part.missingByCategory.Owner, 0, '연결을 못 읽은 VM 을 누락으로 세지 않는다');
  assert.equal(part.rows.length, 0);
  assert.equal(part.coverage.partialUncheckedVms, 1);
  assert.equal(part.vcenters[0].partial, true);
  const full = analyzeTags([{ id: 'vc1', name: 'vc1', tagInv: inv(false) }], vms, policy);
  assert.equal(full.missingByCategory.Owner, 1, '다 읽었으면 예전처럼 누락');
  assert.deepEqual(full.rows.map((r) => r.vm), ['b']);
  // partialTags 가 없는 보고(구버전 엣지)는 잘림 개수로 보수적으로 판정한다.
  assert.equal(tagsPartialOf({ truncated: { tags: 3 } }), true);
  assert.equal(tagsPartialOf({ truncated: { tags: 0 } }), false);
});

/* ───────── S1-01 형제: 경합 갱신이 수집 중단으로 실패하면 1시간 쉬지 않는다 ───────── */
test('S1-01 CPU 경합 갱신 — 수집 중단(데드라인) 실패는 backoff 를 걸지 않는다', async () => {
  const ct = await import('../src/contention/collect.js');
  const cache = await import('../src/contention/cache.js');
  const settings = { contentionScan: true, contentionRefreshMs: 900_000, contentionSamples: 15, contentionPerCycle: 400 };
  const ac = new AbortController();
  const c = { sc: { perfManager: 'pm' }, perfCounterMap: async () => { ac.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, callRaw: async () => '' };
  await ct.refreshContention(c, 'vc-ct', { vms: [{ ref: 'vm-1', numCpu: 2 }], now: T0, settings, signal: ac.signal });
  assert.equal(cache.statusOf('vc-ct').backoffUntil, 0, '중단은 이 갱신의 실패가 아니다 — 다음 주기에 다시 시도');
  const c2 = { sc: { perfManager: 'pm' }, perfCounterMap: async () => { throw new Error('NoPermission'); }, callRaw: async () => '' };
  await ct.refreshContention(c2, 'vc-ct2', { vms: [{ ref: 'vm-1', numCpu: 2 }], now: T0, settings });
  assert.ok(cache.statusOf('vc-ct2').backoffUntil > T0, '그 밖의 실패는 예전처럼 쉰다');
});
