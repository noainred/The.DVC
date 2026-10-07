// v2.720 감사 G1 회귀 — 호스트 구성 갱신 진전(R1-01)·시한 호스트 쉬기(R1-02)·태그 예산 절단(R1-04)·
// 구성 캐시 vCenter 정리(S1-01)·증분 수집 세션 실패 쉬기(S1-02). 실제 모듈을 호출한다.
import test from 'node:test';
import assert from 'node:assert/strict';

const T0 = Date.UTC(2026, 9, 7, 3, 30, 0);   // 고정 기준 시각(정시에서 떨어뜨림)
const H6 = 6 * 3_600_000;
const MIN = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostSettings = { hostCfgScan: true, hostCfgRefreshMs: H6, hostCfgPerCycle: 40 };

// 가짜 SOAP — 호스트 속성은 즉시, 그 밖의 묶음 조회·QueryOptions 는 rtt 만큼 걸린다(고RTT 를 축소한 모양).
function rttClient(rtt, { hang = null, calls = { hung: 0 } } = {}) {
  return {
    async retrieveManyObjectProps(type, refs) {
      if (type === 'HostSystem') {
        return refs.map((r) => ({ ref: r, props: { 'configManager.advancedOption': `opt-${r}`, 'configManager.imageConfigManager': `img-${r}`,
          'configManager.certificateManager': `cert-${r}`, 'configManager.diagnosticSystem': `diag-${r}` } }));
      }
      await sleep(rtt);
      return refs.map((r) => ({ ref: r, props: {} }));
    },
    async callRaw(xml) {
      if (hang && xml.includes(`opt-${hang}<`)) { calls.hung += 1; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
      await sleep(rtt);
      return '<returnval>PartnerSupported</returnval>';
    },
  };
}

test('R1-01 예산이 사전 조회로 다 쓰여도 시작한 호스트는 끝까지 읽어 캐시가 매 주기 전진한다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache();
  const hosts = Array.from({ length: 12 }, (_, i) => `host-${i}`);
  const cachedN = (vc) => hosts.filter((h) => cache.get(vc, h)).length;
  // ① 사전 조회(묶음 4 + 인증서 + 진단 ≈ 5×20ms)가 예산(70ms)을 거의 다 쓴다 — 호스트 하나(8호출×20ms)는 예산 안에 못 끝난다.
  const c = rttClient(20);
  const r1 = await hc.refreshHostCfg(c, 'vc-rtt', hosts, { now: T0, settings: hostSettings, budgetMs: 70 });
  assert.ok(r1.fetched >= 1, `시작한 호스트는 끝까지 읽는다(예전: 전부 중간에 잘려 0) ${JSON.stringify(r1)}`);
  assert.equal(r1.transient, 0, '예산 소진은 일시 실패가 아니다');
  const n1 = cachedN('vc-rtt');
  await hc.refreshHostCfg(c, 'vc-rtt', hosts, { now: T0 + 30_000, settings: hostSettings, budgetMs: 70 });
  assert.ok(cachedN('vc-rtt') > n1, '다음 주기에 다른 호스트로 전진한다');
  // ② 사전 조회만으로 예산을 넘긴 주기라도 한 대는 시작한다.
  cache._resetHostCfgCache();
  const r2 = await hc.refreshHostCfg(c, 'vc-rtt2', hosts, { now: T0, settings: hostSettings, budgetMs: 10 });
  assert.equal(r2.fetched, 1, '최소 한 대'); assert.equal(r2.cut, hosts.length - 1);
  // ③ 예산을 0 이하로 받으면 시작하지 않는다(호출자가 시간이 없다).
  const r3 = await hc.refreshHostCfg(c, 'vc-rtt3', ['host-1'], { now: T0, settings: hostSettings, budgetMs: -1 });
  assert.equal(r3.cut, 1); assert.equal(r3.fetched, 0);
});

test('R1-02 요청 시한에 계속 걸리는 호스트는 쉬었다가(10분→20분) 다시 묻고, 3회 연속이면 null 로 캐시한다', async () => {
  const hc = await import('../src/hostcfg/collect.js');
  const cache = await import('../src/hostcfg/cache.js');
  cache._resetHostCfgCache();
  const calls = { hung: 0 };
  const c = rttClient(0, { hang: 'host-0', calls });
  const hosts = ['host-0', 'host-1', 'host-2'];
  const run = (now) => hc.refreshHostCfg(c, 'vc-hang', hosts, { now, settings: hostSettings, budgetMs: 15_000 });
  const r1 = await run(T0);
  assert.equal(r1.fetched, 2); assert.equal(r1.transient, 1); assert.equal(r1.backoff, 1);
  assert.equal(cache.get('vc-hang', 'host-0'), null, '시한 호스트를 바로 캐시하지 않는다');
  // 30초 뒤 다음 주기 — 쉬는 중이라 다시 묻지 않는다(예전: 매 주기 1회씩 시한을 기다렸다).
  const r2 = await run(T0 + 30_000);
  assert.equal(r2.due, 0); assert.equal(calls.hung, 1);
  const st = cache.hostCfgStatus().vcenters.find((v) => v.vcenterId === 'vc-hang');
  assert.equal(st.backoffHosts, 1); assert.equal(st.nextRetryAt, T0 + 10 * MIN, '상태에 다음 시도 시각');
  // 10분 뒤 다시 묻고 실패 → 20분 쉰다.
  await run(T0 + 10 * MIN);
  assert.equal(calls.hung, 2);
  assert.equal(cache.failOf('vc-hang', 'host-0').retryAt, T0 + 10 * MIN + 20 * MIN);
  await run(T0 + 15 * MIN); assert.equal(calls.hung, 2, '쉬는 동안 다시 묻지 않는다');
  // 3회째 실패 → 예전처럼 읽은 만큼(못 읽은 값은 null)으로 캐시하고 갱신 주기 동안 다시 붙잡지 않는다.
  const r3 = await run(T0 + 31 * MIN);
  assert.equal(r3.gaveUp, 1); assert.equal(calls.hung, 3);
  assert.ok(cache.get('vc-hang', 'host-0'), '3회 연속이면 캐시한다');
  assert.equal(cache.failOf('vc-hang', 'host-0'), null);
  assert.equal((await run(T0 + 40 * MIN)).due, 0);
  // 수집 중단(AbortError — 이 호스트 탓이 아님)은 쉬지 않는다.
  cache._resetHostCfgCache();
  const ab = { retrieveManyObjectProps: c.retrieveManyObjectProps, callRaw: async () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; } };
  const ra = await hc.refreshHostCfg(ab, 'vc-ab', ['host-1'], { now: T0, settings: hostSettings });
  assert.equal(ra.transient, 1); assert.equal(ra.backoff, 0);
  assert.deepEqual(cache.pickDue('vc-ab', ['host-1'], { now: T0 + 30_000, periodMs: H6, max: 40 }), ['host-1']);
});

test('R1-04 예산으로 잘린 태그 결과가 직전의 온전한 연결을 덮지 않고 retryAt 이 붙는다', async () => {
  const tags = await import('../src/tags/collect.js');
  const { VCenterClient } = await import('../src/vcenter/restClient.js');
  tags._resetTagInv();
  const P = VCenterClient.prototype;
  const saved = {};
  let slow = false;
  const patch = {
    login: async () => {}, logout: async () => {},
    listTagCategories: async () => ['cat-1'],
    getTagCategory: async (id) => ({ id, name: 'Owner', cardinality: 'SINGLE', associable_types: ['VirtualMachine'] }),
    listTags: async () => Array.from({ length: 150 }, (_, i) => `tag-${i}`),
    getTag: async (id) => ({ id, name: id, category_id: 'cat-1' }),
    listAttachedObjectsOnTags: async (ids) => { if (slow) await sleep(80); return ids.map((tag_id) => ({ tag_id, object_ids: [{ id: 'vm-1', type: 'VirtualMachine' }] })); },
  };
  for (const k of Object.keys(patch)) { saved[k] = P[k]; P[k] = patch[k]; }
  try {
    const c = { sc: {}, retrieveObjectProps: async () => [], retrieveManyObjectProps: async () => [] };
    const vc = { id: 'vc-tagcut', host: 'https://h', username: 'u', password: 'p' };
    const settings = { tagScan: true, tagRefreshMs: H6 };
    const full = await tags.refreshTagInv(c, vc, ['vm-1'], { now: T0, settings, budgetMs: 45_000 });
    assert.equal(full.partialTags, false); assert.equal(full.retryAt, null);
    const fullVmTags = JSON.stringify(full.vmTags);
    slow = true;
    const cut = await tags.refreshTagInv(c, vc, ['vm-1'], { now: T0 + H6 + MIN, settings, budgetMs: 40 });
    assert.equal(cut.partialTags, false, '직전 온전한 연결을 유지한다');
    assert.equal(JSON.stringify(cut.vmTags), fullVmTags);
    assert.equal(cut.tagsAt, T0, '태그 갱신 시각은 직전 그대로');
    assert.equal(cut.tagsKeptPrev, true);
    assert.equal(cut.retryAt, T0 + H6 + MIN + tags.TAG_RETRY_MS, '곧 다시 읽는다(6시간을 기다리지 않는다)');
    // 직전 값이 없으면 부분 결과를 싣되 역시 retryAt 을 단다.
    tags._resetTagInv();
    const first = await tags.refreshTagInv(c, vc, ['vm-1'], { now: T0, settings, budgetMs: 40 });
    assert.equal(first.partialTags, true); assert.ok(first.retryAt != null);
  } finally { for (const k of Object.keys(saved)) P[k] = saved[k]; }
});

test('S1-01 삭제된 vCenter·접속처가 바뀐 vCenter 의 구성 캐시를 버린다', async () => {
  const hcache = await import('../src/hostcfg/cache.js');
  const vmcache = await import('../src/vmcfg/cache.js');
  const ccache = await import('../src/contention/cache.js');
  hcache._resetHostCfgCache(); vmcache._resetVmCfgCache(); ccache._resetContentionCache();
  const fill = () => {
    hcache.put('vc-1', 'host-10', { at: T0, ntpServers: ['old-ntp'] });
    vmcache.put('vc-1', 'vm-101', 'dev', { at: T0, cdroms: [] });
    ccache.put('vc-1', 'vm', 'vm-101', { at: T0 });
  };
  fill();
  assert.deepEqual(hcache.syncVcConfigCaches([{ id: 'vc-1', host: 'old.example' }]).dropped, []);
  assert.ok(hcache.get('vc-1', 'host-10'), '처음 본 접속처는 기록만 한다');
  hcache.syncVcConfigCaches([{ id: 'vc-1', host: 'OLD.example ' }]);
  assert.ok(hcache.get('vc-1', 'host-10'), '대소문자·공백만 다른 주소는 같은 접속처');
  // 같은 id 로 다른 vCenter 를 가리키게 바꿨다 — 같은 moref 에 옛 값이 남으면 안 된다.
  assert.deepEqual(hcache.syncVcConfigCaches([{ id: 'vc-1', host: 'new.example' }]).dropped, ['vc-1']);
  assert.equal(hcache.get('vc-1', 'host-10'), null);
  assert.equal(vmcache.get('vc-1', 'vm-101'), null);
  assert.equal(ccache.get('vc-1', 'vm', 'vm-101'), null);
  assert.deepEqual(hcache.pickDue('vc-1', ['host-10'], { now: T0 + MIN, periodMs: H6, max: 40 }), ['host-10'], '바로 다시 읽는다');
  // 등록부에서 삭제 — 상태 표에서도 사라진다.
  fill(); hcache.setStatus('vc-1', { at: T0 });
  hcache.syncVcConfigCaches([]);
  assert.equal(hcache.hostCfgStatus().vcenters.length, 0);
  assert.equal(vmcache.vmCfgStatus().vcenters.length, 0);
  assert.equal(ccache.contentionStatus().vcenters.length, 0);
  // store.refresh 가 매 주기 등록부를 넘긴다(배선 — 소스에서 주석을 지운 뒤 확인).
  const { stripComments } = await import('./_stripComments.js');
  const fs = await import('node:fs');
  const src = stripComments(fs.readFileSync(new URL('../src/store.js', import.meta.url), 'utf8'));
  // v2.721(감사 S1-01): 정리는 수집 '전'(loadVcenterConfig 직후) 한 번이다.
  assert.match(src, /const \{ vcenters \} = loadVcenterConfig\(\);\s*syncVcConfigCaches\(vcenters\);/);
  assert.equal((src.match(/syncVcConfigCaches\(vcenters\)/g) || []).length, 1, '호출은 한 곳뿐');
});

test('S1-02 증분 수집 세션이 인증 외 실패로 2회 연속 끝나면 쉬고, 상태에 다음 시도 시각을 싣는다', async () => {
  const us = await import('../src/vcenter/updateSession.js');
  await us.closeAllUpdateSessions();
  let logins = 0; let waits = 0;
  const makeClient = () => ({
    sc: { propertyCollector: 'pc', viewManager: 'vm', rootFolder: 'root' },
    async login() { logins += 1; }, async logout() {},
    async callRaw(x) {
      if (x.includes('CreatePropertyCollector')) return '<returnval type="PropertyCollector">pc2</returnval>';
      if (x.includes('CreateContainerView')) return '<returnval type="ContainerView">cv</returnval>';
      if (x.includes('CreateFilter')) return '<returnval type="PropertyFilter">f</returnval>';
      if (x.includes('WaitForUpdatesEx')) { waits += 1; throw new Error('ServerFaultCode: request timed out'); }
      return '';
    },
  });
  const vc = { id: 'vc-upd', host: 'h', username: 'u', password: 'p' };
  const call = (now, signal = null) => us.inventoryViaUpdates(vc, ['VirtualMachine'], [{ type: 'VirtualMachine', paths: ['name'] }], { makeClient, now, signal }).catch((e) => e);
  await call(T0); await call(T0 + 30_000);
  assert.equal(logins, 2);
  const s = us.updateSessionStatus().sessions['vc-upd'];
  assert.equal(s.failCount, 2); assert.equal(s.nextTryAt, T0 + 30_000 + 5 * MIN);
  await call(T0 + 60_000);
  assert.equal(logins, 2, '쉬는 동안 새 세션을 열지 않는다(예전: 매 주기 로그인·전체 enter)');
  assert.equal(waits, 2);
  // 쉬는 시간이 지나면 다시 시도하고, 또 실패하면 더 길게 쉰다.
  await call(T0 + 30_000 + 5 * MIN + 1);
  assert.equal(logins, 3);
  assert.equal(us.updateSessionStatus().sessions['vc-upd'].nextTryAt, T0 + 30_000 + 5 * MIN + 1 + 10 * MIN);
  assert.equal(us.softBackoffMs(1), 0); assert.equal(us.softBackoffMs(20), 30 * MIN, '상한 30분');
  // 수집 중단(abort)은 세지 않는다.
  await us.closeAllUpdateSessions();
  const ac = new AbortController(); ac.abort();
  await call(T0, ac.signal); await call(T0 + 30_000, ac.signal);
  const s2 = us.updateSessionStatus().sessions['vc-upd'];
  assert.equal(s2.failCount, 0); assert.equal(s2.nextTryAt, null);
  await us.closeAllUpdateSessions();
});
