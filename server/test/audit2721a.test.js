// v2.721 감사 그룹 A — R1-01(시작한 호스트의 상한·abort 를 시한 실패로) · S1-03(부가 갱신 대상별 재시도 백오프).
// 실제 수집 모듈(refreshHostCfg·refreshClusterCfg·refreshDsCfg·refreshVmCfg·refreshContention)을 가짜 SOAP 클라이언트로 부른다.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { refreshHostCfg } from '../src/hostcfg/collect.js';
import * as hcache from '../src/hostcfg/cache.js';
import { refreshClusterCfg, clusterCfgRetryOf, clusterCfgStatus, _resetClusterCfg } from '../src/clustercfg/collect.js';
import { refreshDsCfg, dsCfgRetryOf, dsCfgStatus, _resetDsCfg, AUX_RETRY_BASE_MS } from '../src/dscfg/collect.js';
import { refreshVmCfg, vmCfgRetryOf, _resetVmCfgRetry } from '../src/vmcfg/collect.js';
import { _resetVmCfgCache, statusOf as vmStatusOf } from '../src/vmcfg/cache.js';
import { refreshContention, contentionRetryOf, _resetContentionRetry } from '../src/contention/collect.js';
import { _resetContentionCache, statusOf as ctStatusOf } from '../src/contention/cache.js';

// 기준 시각 — Date.now() 가 아니라 고정값(정시에서 떨어뜨린다).
const NOW = 1_800_000_000_000 + 30 * 60_000;
const HOUR = 3_600_000;
const timeoutErr = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; return e; };
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});

beforeEach(() => {
  hcache._resetHostCfgCache(); _resetClusterCfg(); _resetDsCfg(); _resetVmCfgCache(); _resetVmCfgRetry();
  _resetContentionCache(); _resetContentionRetry();
});

const hostSettings = { hostCfgScan: true, hostCfgRefreshMs: 6 * HOUR, hostCfgPerCycle: 40 };
function hostClient({ delayMs, signal = null, failFirst = null }) {
  const calls = { n: 0 };
  return {
    calls,
    signal,
    async retrieveManyObjectProps(type, refs) {
      if (failFirst && type === 'HostSystem') throw failFirst();
      if (type === 'HostSystem') return refs.map((r) => ({ ref: r, props: { 'configManager.advancedOption': 'opt-' + r, 'configManager.imageConfigManager': 'img-' + r } }));
      return [];
    },
    async callRaw() { calls.n += 1; await sleep(delayMs, signal); return '<returnval>x</returnval>'; },
  };
}

test('R1-01 ① 예산을 넘긴 채 수집 데드라인 abort 로 끊긴 호스트는 시한 실패로 기록되고 다음 주기에 다시 고르지 않는다', async () => {
  const ac = new AbortController();
  const c = hostClient({ delayMs: 120, signal: ac.signal });
  const t = setTimeout(() => ac.abort(new Error('vCenter 수집 데드라인')), 400); // 예산(150ms) 뒤 abort
  const r = await refreshHostCfg(c, 'vcA', ['host-1'], { now: NOW, budgetMs: 150, settings: hostSettings, signal: ac.signal });
  clearTimeout(t);
  assert.equal(r.backoff, 1, '예산을 넘겨 끊긴 호스트는 시한 실패(쉼)로 센다');
  const rec = hcache.failOf('vcA', 'host-1');
  assert.ok(rec && rec.retryAt > NOW, '재시도 기록이 있어야 한다');
  assert.equal(hcache.get('vcA', 'host-1'), null, '다 읽지 못한 호스트는 캐시하지 않는다');
  // 다음 주기 — 쉬는 중이라 고르지 않는다(예전: 매 주기 같은 호스트로 다시 데드라인까지)
  const c2 = hostClient({ delayMs: 1 });
  const r2 = await refreshHostCfg(c2, 'vcA', ['host-1'], { now: NOW + 1000, budgetMs: 150, settings: hostSettings });
  assert.deepEqual(r2, { due: 0 });
  assert.equal(c2.calls.n, 0);
});

test('R1-01 ② 예산 안에서 abort 된 호스트는 그 호스트 탓이 아니다(기록하지 않는다)', async () => {
  const ac = new AbortController();
  const c = hostClient({ delayMs: 80, signal: ac.signal });
  const t = setTimeout(() => ac.abort(new Error('vCenter 수집 데드라인')), 100); // 예산(5초) 안
  const r = await refreshHostCfg(c, 'vcA', ['host-1'], { now: NOW, budgetMs: 5000, settings: hostSettings, signal: ac.signal });
  clearTimeout(t);
  assert.equal(r.backoff, 0);
  assert.equal(r.transient, 1);
  assert.equal(hcache.failOf('vcA', 'host-1'), null);
});

test('R1-01 ③ 예산 + 유예를 넘기면 abort 를 기다리지 않고 멈추고 시한 실패로 센다', async () => {
  const c = hostClient({ delayMs: 60 });
  const t0 = Date.now();
  const r = await refreshHostCfg(c, 'vcA', ['host-1'], { now: NOW, budgetMs: 50, overrunGraceMs: 100, settings: hostSettings });
  const ms = Date.now() - t0;
  assert.equal(r.capped, 1);
  assert.equal(r.backoff, 1);
  assert.ok(c.calls.n < 8, `8회(전부)를 끝까지 하지 않는다 — 실제 ${c.calls.n}회`);
  assert.ok(ms < 600, `유예 뒤 곧 멈춘다 — ${ms}ms`);
  assert.equal(hcache.get('vcA', 'host-1'), null);
});

test('R1-01 ④ 예산을 넘겨도 유예 안에 다 읽은 호스트는 그대로 캐시한다(v2.720 규칙 유지)', async () => {
  const c = hostClient({ delayMs: 10 });
  const r = await refreshHostCfg(c, 'vcA', ['host-1'], { now: NOW, budgetMs: 20, overrunGraceMs: 5000, settings: hostSettings });
  assert.equal(r.fetched, 1);
  assert.equal(r.capped, 0);
  assert.ok(hcache.get('vcA', 'host-1'));
  assert.equal(c.calls.n, 8, 'ADV 7 + 허용 수준 1');
});

test('S1-03 hostcfg — 첫 일괄 조회가 요청 시한이면 고른 호스트를 쉬게 한다(abort 는 제외)', async () => {
  const c = hostClient({ delayMs: 1, failFirst: timeoutErr });
  const r = await refreshHostCfg(c, 'vcA', ['host-1', 'host-2'], { now: NOW, settings: hostSettings });
  assert.equal(r.rested, 2);
  assert.ok(hcache.failOf('vcA', 'host-1') && hcache.failOf('vcA', 'host-2'));
  // abort 는 세지 않는다
  hcache._resetHostCfgCache();
  const ac = new AbortController(); ac.abort(new Error('vCenter 수집 데드라인'));
  const c2 = { ...hostClient({ delayMs: 1 }), signal: ac.signal, async retrieveManyObjectProps() { throw ac.signal.reason; } };
  const r2 = await refreshHostCfg(c2, 'vcA', ['host-1'], { now: NOW, settings: hostSettings, signal: ac.signal });
  assert.equal(r2.rested, 0);
  assert.equal(hcache.failOf('vcA', 'host-1'), null);
});

function batchClient({ fail = () => null, signal = null } = {}) {
  const asked = [];
  return {
    asked,
    signal,
    async retrieveManyObjectProps(type, refs) {
      asked.push(...refs);
      const e = fail(type, refs); if (e) throw e;
      return refs.map((r) => ({ ref: r, props: {} }));
    },
  };
}

test('S1-03 clustercfg — 시한에 걸린 조각만 쉬고 다음 주기에 다시 묻지 않는다 · 성공하면 기록을 지운다', async () => {
  const settings = { clusterCfgScan: true, clusterCfgRefreshMs: 6 * HOUR, clusterCfgPerCycle: 50 };
  const refs = ['domain-c1', 'domain-c2'];
  const c = batchClient({ fail: () => timeoutErr() });
  await refreshClusterCfg(c, 'vcA', refs, { now: NOW, settings });
  assert.ok(clusterCfgRetryOf('vcA', 'domain-c1')?.retryAt >= NOW + AUX_RETRY_BASE_MS);
  const st = clusterCfgStatus().vcenters.find((v) => v.vcenterId === 'vcA');
  assert.equal(st.backoffTargets, 2, '상태가 쉬는 대상 수를 말한다');
  const c2 = batchClient();
  const r2 = await refreshClusterCfg(c2, 'vcA', refs, { now: NOW + 60_000, settings });
  assert.deepEqual(r2, { due: 0 });
  assert.equal(c2.asked.length, 0, '쉬는 동안 같은 클러스터를 다시 묻지 않는다');
  // 쉬는 시간이 지나면 다시 묻고, 읽으면 기록을 지운다
  const c3 = batchClient();
  const r3 = await refreshClusterCfg(c3, 'vcA', refs, { now: NOW + AUX_RETRY_BASE_MS + 1, settings });
  assert.equal(r3.fetched, 2);
  assert.equal(clusterCfgRetryOf('vcA', 'domain-c1'), null);
  // 두 번 연속이면 쉬는 시간이 두 배(상한 = 갱신 주기)
  _resetClusterCfg();
  await refreshClusterCfg(batchClient({ fail: () => timeoutErr() }), 'vcB', ['c'], { now: NOW, settings });
  await refreshClusterCfg(batchClient({ fail: () => timeoutErr() }), 'vcB', ['c'], { now: NOW + AUX_RETRY_BASE_MS + 1, settings });
  assert.equal(clusterCfgRetryOf('vcB', 'c').retryAt, NOW + AUX_RETRY_BASE_MS + 1 + 2 * AUX_RETRY_BASE_MS);
});

test('S1-03 clustercfg — 수집 중단(abort)은 쉬게 하지 않는다', async () => {
  const settings = { clusterCfgScan: true, clusterCfgRefreshMs: 6 * HOUR, clusterCfgPerCycle: 50 };
  const ac = new AbortController(); ac.abort(new Error('vCenter 수집 데드라인'));
  await refreshClusterCfg(batchClient({ fail: () => ac.signal.reason, signal: ac.signal }), 'vcA', ['c1'], { now: NOW, settings });
  assert.equal(clusterCfgRetryOf('vcA', 'c1'), null);
});

test('S1-03 dscfg — 시한에 걸린 DS 는 쉬고, abort 는 쉬지 않는다', async () => {
  const settings = { dsCfgScan: true, dsCfgRefreshMs: 6 * HOUR, dsCfgPerCycle: 400 };
  await refreshDsCfg(batchClient({ fail: () => timeoutErr() }), 'vcA', ['ds-1', 'ds-2'], { now: NOW, settings });
  assert.ok(dsCfgRetryOf('vcA', 'ds-1'));
  assert.equal(dsCfgStatus().vcenters.find((v) => v.vcenterId === 'vcA').backoffTargets, 2);
  const c2 = batchClient();
  assert.deepEqual(await refreshDsCfg(c2, 'vcA', ['ds-1', 'ds-2'], { now: NOW + 1000, settings }), { due: 0 });
  assert.equal(c2.asked.length, 0);
  const ac = new AbortController(); ac.abort(new Error('vCenter 수집 데드라인'));
  await refreshDsCfg(batchClient({ fail: () => ac.signal.reason, signal: ac.signal }), 'vcB', ['ds-9'], { now: NOW, settings });
  assert.equal(dsCfgRetryOf('vcB', 'ds-9'), null);
});

test('S1-03 vmcfg — 시한에 걸린 cfg 조각의 VM 은 쉬고 다음 주기에 다시 묻지 않는다', async () => {
  const settings = { vmCfgScan: true, vmCfgRefreshMs: 30 * 60_000, vmCfgPerCycle: 1000, vmDevRefreshMs: 6 * HOUR, vmDevPerCycle: 150 };
  const refs = ['vm-1', 'vm-2'];
  // cfg 는 시한, dev 는 성공
  const c = batchClient();
  const orig = c.retrieveManyObjectProps;
  let n = 0;
  c.retrieveManyObjectProps = async (type, r, paths) => { n += 1; if (n === 1) { c.asked.push(...r); throw timeoutErr(); } return orig.call(c, type, r, paths); };
  await refreshVmCfg(c, 'vcA', refs, { now: NOW, settings });
  assert.ok(vmCfgRetryOf('vcA', 'vm-1', 'cfg'));
  assert.equal(vmCfgRetryOf('vcA', 'vm-1', 'dev'), null, 'dev 는 읽었다');
  assert.equal(vmStatusOf('vcA').cfgBackoffVms, 2);
  const c2 = batchClient();
  const r2 = await refreshVmCfg(c2, 'vcA', refs, { now: NOW + 1000, settings });
  assert.equal(r2.cfg, null, '쉬는 VM 만 남아 cfg 를 묻지 않는다');
  assert.equal(c2.asked.length, 0);
});

test('S1-03 contention — 시한에 걸린 묶음은 쉬고, abort 는 쉬지 않는다', async () => {
  const settings = { contentionScan: true, contentionRefreshMs: 15 * 60_000, contentionSamples: 15, contentionPerCycle: 400 };
  const map = new Map([['cpu.ready.summation', 1], ['disk.maxTotalLatency.latest', 2]]);
  const mk = (err, signal = null) => {
    const asked = [];
    return {
      asked, signal, sc: { perfManager: 'PerfMgr' },
      async perfCounterMap() { return map; },
      async callRaw(body) { asked.push(body); if (err) throw err(); return '<returnval></returnval>'; },
    };
  };
  const opts = { vms: [{ ref: 'vm-1', numCpu: 2 }], hostRefs: ['host-1'], settings };
  const r = await refreshContention(mk(timeoutErr), 'vcA', { ...opts, now: NOW });
  assert.equal(r.errors, 2);
  assert.ok(contentionRetryOf('vcA', 'vm', 'vm-1') && contentionRetryOf('vcA', 'host', 'host-1'));
  assert.equal(ctStatusOf('vcA').backoffVms, 1);
  const c2 = mk(null);
  const r2 = await refreshContention(c2, 'vcA', { ...opts, now: NOW + 1000 });
  assert.deepEqual(r2, { due: 0 });
  assert.equal(c2.asked.length, 0);
  // abort 는 세지 않는다
  const ac = new AbortController(); ac.abort(new Error('vCenter 수집 데드라인'));
  await refreshContention(mk(() => ac.signal.reason), 'vcB', { ...opts, now: NOW, signal: null });
  // 신호를 넘기지 않아도 클라이언트 신호(c.signal)가 abort 면 세지 않는다
  await refreshContention(mk(() => ac.signal.reason, ac.signal), 'vcC', { ...opts, now: NOW });
  assert.equal(contentionRetryOf('vcC', 'vm', 'vm-1'), null);
});
