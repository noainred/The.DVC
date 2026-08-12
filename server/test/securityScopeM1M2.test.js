/**
 * 보안 감사 M1·M2 회귀 방지 (security_check_20260808.MD).
 *
 * M1: 사용자 scope(가시 범위)가 검색·도구 조회 라우트에서 강제되는지.
 *   - 기능: nlSearch(query, allowed) / chatOps(question, allowed) 가 allowed 로 vCenter 를 거른다.
 *   - 정적: 나머지 도구 라우트가 scopedVcenterIds/scopeSlice 로 교집합을 강제한다.
 * M2: central 적재 라우트가 저장 키를 body.agent 가 아니라 req.centralAuth.agent 로 쓰는지
 *   (agent 모드 body.agent 위조 봉인) + /inventory 소유권(TOFU) 검사.
 *
 * 라우트 통합 테스트 대신 정적 소스 검증을 쓰는 이유는 기존 securityScope.test.js(S1/S3)와 동일 —
 * central 미들웨어 체인·인증 세팅을 세우는 비용이 크고, 핵심은 '가드가 코드에 존재하는가'다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readApiSource } from './lib/apiSource.js';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-m1m2-'));

const { store } = await import('../src/store.js');
const { nlSearch } = await import('../src/llm/nlSearch.js');
const { chatOps } = await import('../src/llm/chatops.js');

const SNAP = {
  generatedAt: new Date(0).toISOString(),
  vcenters: [{ id: 'vc-seoul' }, { id: 'vc-warsaw' }, { id: 'vc-nyc' }],
  hosts: [
    { id: 'h1', name: 'h1', vcenterId: 'vc-seoul', cpuUsagePct: 10, memUsagePct: 10 },
    { id: 'h2', name: 'h2', vcenterId: 'vc-warsaw', cpuUsagePct: 20, memUsagePct: 20 },
  ],
  vms: [
    { id: 'v1', name: 'seoul-vm', vcenterId: 'vc-seoul', powerState: 'POWERED_ON' },
    { id: 'v2', name: 'warsaw-vm', vcenterId: 'vc-warsaw', powerState: 'POWERED_ON' },
    { id: 'v3', name: 'nyc-vm', vcenterId: 'vc-nyc', powerState: 'POWERED_ON' },
  ],
  datastores: [], networks: [], alarms: [],
};

// store 싱글턴의 get 을 테스트 스냅샷으로 고정(nlSearch/chatOps 가 같은 참조를 읽는다).
const origGet = store.get;
store.get = () => SNAP;

test('M1: nlSearch(allowed=Set) 는 허용 vCenter 항목만 반환하고 total 도 스코프 반영', async () => {
  const r = await nlSearch('vm 목록', new Set(['vc-seoul']));
  assert.equal(r.total, 1, '허용 vCenter(1개)의 VM 만');
  assert.ok(r.results.every((x) => x.vcenterId === 'vc-seoul'));
});

test('M1: nlSearch(allowed=null) 은 무제한(기존 동작 보존)', async () => {
  const r = await nlSearch('vm 목록', null);
  assert.equal(r.total, 3);
});

test('M1: nlSearch(allowed=빈Set) 은 아무것도 반환하지 않는다(범위 밖 전면 차단)', async () => {
  const r = await nlSearch('vm 목록', new Set());
  assert.equal(r.total, 0);
});

test('M1: chatOps(allowed) 컨텍스트 카운트가 스코프 반영', async () => {
  const r = await chatOps('vm 몇 개', new Set(['vc-seoul']));
  assert.equal(r.context.vms, 1, 'scoped VM 카운트');
  assert.equal(r.context.vcenters, 1);
  if (r.search) assert.ok((r.search.sample || []).every((x) => x.vcenterId === 'vc-seoul'));
});

test('cleanup: store.get 원복', () => { store.get = origGet; assert.ok(true); });

/* ── 정적 검증: 도구 라우트 scope 강제 ── */
const apiSrc = readApiSource(); // v2.283.0 분할 — api.js + routes/api/* 를 등록 순서대로 결합(마커 순서 보존)
const routeBody = (marker, next) => {
  const i = apiSrc.indexOf(marker);
  const j = next ? apiSrc.indexOf(next, i + marker.length) : apiSrc.length;
  assert.ok(i >= 0, `라우트 마커 없음: ${marker}`);
  return apiSrc.slice(i, j > i ? j : i + 2000);
};

test('M1 정적: /tools/duplicate-ips·vmtools·snapshots 가 scopedVcenterIds 로 선필터', () => {
  assert.match(routeBody("api.get('/tools/duplicate-ips'", "api.get('/tools/solutions'"), /scopedVcenterIds\(req\.user/);
  assert.match(routeBody("api.get('/tools/vmtools'", "api.get('/tools/snapshots'"), /scopedVcenterIds\(req\.user/);
  // v2.283.0 분할: '// ── 특수기능' 주석이 헬퍼와 함께 이동해 다음 라우트 마커로 교체(의도 동일)
  assert.match(routeBody("api.get('/tools/snapshots'", "api.get('/tools/report/health'"), /scopedVcenterIds\(req\.user/);
});

test('M1 정적: /search/nl 이 nlSearch 에 scopedVcenterIds 를 전달', () => {
  assert.match(routeBody("api.post('/search/nl'", "api.get('/release-notes'"), /nlSearch\(query, scopedVcenterIds\(req\.user/);
});

test('M1 정적: /tools/deep-search 가 요청 vcenterIds 를 allowed 와 교집합', () => {
  const b = routeBody("api.post('/tools/deep-search'", "api.get('/tools/service-check'");
  assert.match(b, /scopedVcenterIds\(req\.user/);
  assert.match(b, /effIds/);
  assert.match(b, /allowed && effIds\.length === 0/);   // 공집합 즉시 빈 결과
});

test('M1 정적: /tools/vm-finder facets.vcenters 가 scopeVms 에서 파생(전 vCenter 누출 차단)', () => {
  const b = routeBody("api.post('/tools/vm-finder'", "api.get('/tools/esxi-temp'");
  assert.match(b, /scopedVcenterIds\(req\.user/);
  assert.match(b, /vcenters: \[\.\.\.new Set\(scopeVms\.map/);
});

test('M1 정적: /tools/insights 가 scopeSlice + extraKey(scopeKey) 캐시 분리', () => {
  // v2.283.0 분할: RISKY_PORTS 헬퍼(주석 포함)가 모듈 상단으로 이동 — 다음 라우트 마커로 교체(의도 동일)
  const b = routeBody("api.get('/tools/insights'", "api.get('/tools/threats'");
  assert.match(b, /scopeSlice\(snap, req\.user/);
  assert.match(b, /extraKey: scopeKey\(req\.user/);
});

test('M1 정적: /tools/esxi-temp 와 history 가 scope 로 호스트·key 귀속 검사', () => {
  const b = routeBody("api.get('/tools/esxi-temp'", "api.get('/tools/esxi-temp/history'");
  assert.match(b, /scopedVcenterIds\(req\.user/);
  // v2.283.0 분할: hash 헬퍼가 shared.js 로 이동 — 다음 라우트 마커로 교체(의도 동일)
  const h = routeBody("api.get('/tools/esxi-temp/history'", "api.get('/tools/capacity-forecast'");
  assert.match(h, /allowedH/);
  assert.match(h, /owns/);
});

// 적대적 검증(wf_efc27ccf)이 찾은 부분-롤아웃 갭 회귀 방지 — 형제 /tools 라우트 전수 scope.
test('M1 정적(2차): /summary·/overview memoJson 에 extraKey(scopeKey) — 캐시 교차 유출 차단', () => {
  const si = apiSrc.indexOf("api.get('/summary'");
  const s = apiSrc.slice(si, apiSrc.indexOf('api.get', si + 20) > si ? apiSrc.indexOf('api.get', si + 20) : apiSrc.length);
  assert.match(s, /extraKey: scopeKey\(req\.user/);
  const o = routeBody("api.get('/overview'", "api.get('/nsx'");
  assert.match(o, /scopedVcenterIds\(req\.user/);
  assert.match(o, /extraKey: scopeKey\(req\.user/);
});

test('M1 정적(2차): 형제 /tools 집계 라우트가 모두 scope 강제', () => {
  const cases = [
    ["api.get('/tools/hardware'", "api.get('/tools/esxi'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/esxi'", "api.get('/tools/gpu'", /scopedVcenterIds\(req\.user/], // 분할로 buildGpuInventory 가 모듈 상단으로 이동
    ["api.get('/tools/gpu/vms'", 'ip-ping', /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/capacity'", "api.get('/tools/waste'", /scopeSlice\(snap, req\.user/],
    ["api.get('/tools/waste'", "api.get('/tools/thin-vms'", /scopeSlice\(snap, req\.user/],
    ["api.get('/tools/thin-vms'", 'Advanced VM finder', /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/threats'", "api.get('/tools/gpu/history'", /scopeSlice\(snap, req\.user/],
    ["api.get('/tools/capacity-forecast'", "api.get('/tools/guest-os'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/guest-os'", "api.get('/tools/guest-os/vms'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/guest-os/vms'", "api.get('/tools/hba'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/hba'", "api.get('/tools/licenses'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/licenses'", "api.get('/tools/license-expiry'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/license-expiry'", "api.get('/tools/solutions'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/solutions'", "api.get('/tools/report/health'", /scopedVcenterIds\(req\.user/],
    ["api.get('/tools/gpu/history'", "api.get('/tools/capacity'", /allowedG/],
    ["api.get('/tools/ipam/vc-ranges'", "api.get('/tools/ipam/netmap'", /scopedVcenterIds\(req\.user/],
    ["api.post('/vms/upgrade-tools'", null, /scopedVcenterIds\(req\.user/],
  ];
  for (const [marker, next, re] of cases) {
    assert.match(routeBody(marker, next), re, `scope 누락: ${marker}`);
  }
});

test('M1 정적(2차): buildGpuInventory 가 allowed 로 hosts·vms 선필터(GPU 할당VM 이름 누출 차단)', () => {
  const g = apiSrc.slice(apiSrc.indexOf('function buildGpuInventory'), apiSrc.indexOf("api.get('/tools/gpu'"));
  assert.match(g, /allowed = null/);
  assert.match(g, /hosts\.filter\(\(h\) => allowed\.has/);
  assert.match(g, /scopedVms/);
});

test('M2 정적(2차): /agent-config 저장 키가 req.centralAuth.agent', () => {
  const a = centralRoute("centralRouter.post('/agent-config'", 'function require_basename');
  assert.match(a, /req\.centralAuth\.agent \|\| String\(b\.agent/);
  assert.ok(!/setAgentConfig\(String\(b\.agent\)/.test(a), 'setAgentConfig(String(b.agent)) 직접 사용 금지');
});

/* ── 정적 검증: M2 central 저장 키 바인딩 ── */
const centralSrc = fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8');
const centralRoute = (marker, next) => {
  const i = centralSrc.indexOf(marker);
  assert.ok(i >= 0, `central 라우트 없음: ${marker}`);
  const j = centralSrc.indexOf(next, i + marker.length);
  return centralSrc.slice(i, j > i ? j : i + 1500);
};

test('M2 정적: /result·/fleet·/ip-scan-result 저장 키가 req.centralAuth.agent(body.agent 위조 봉인)', () => {
  const r = centralRoute("centralRouter.post('/result'", "centralRouter.post('/inventory'");
  assert.match(r, /req\.centralAuth\.agent \|\| String\(b\.agent/);
  assert.ok(!/setResult\(b\.agent/.test(r), 'setResult(b.agent) 직접 사용 금지');

  const f = centralRoute("centralRouter.post('/fleet'", 'centralRouter.get');
  assert.match(f, /req\.centralAuth\.agent \|\| String\(b\.agent/);
  assert.ok(!/setEdgeFleet\(String\(b\.agent\)/.test(f));

  const s = centralRoute("centralRouter.post('/ip-scan-result'", 'centralRouter.get');
  assert.match(s, /req\.centralAuth\.agent \|\| String\(b\.agent/);
  assert.ok(!/mergeScanResults\(b\.alive[^,]*, Date\.now\(\), String\(b\.agent\)/.test(s));
});

test('M2 정적: /inventory 소유권(TOFU) 검사 + 출처를 centralAuth.agent 로 기록', () => {
  const inv = centralRoute("centralRouter.post('/inventory'", "centralRouter.post('/fleet'");
  assert.match(inv, /getInventory\(String\(b\.vcenterId\)\)\?\.agent/);
  assert.match(inv, /소유입니다/);
  assert.match(inv, /setInventory\(String\(b\.vcenterId\), slice, agent/);
});

test('M2 정적: /gpu-guest-data 출처 agent 태깅(provenance)', () => {
  const g = centralRoute("centralRouter.post('/gpu-guest-data'", 'centralRouter.get');
  assert.match(g, /req\.centralAuth\.agent \|\| String\(b\.agent/);
  assert.match(g, /setGuestGpu\(\{ hosts, vms, agent \}\)/);
});
