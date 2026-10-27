/**
 * v2.803 — ESXi 호스트 화면 '점검' 열 집계(/hosts/checks) + 호스트 단건(/hosts/:id). 승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1.
 *  ① 순수 — iDRAC 한 줄(등록 안 됨 · 읽는 중 · 묶음 상태 · 등록부 못 읽음) · 재부팅 행 그대로 · Veeam 수(템플릿 제외 · 수집 안 됨 null)
 *  ② 권한으로 뺀 묶음은 키 자체가 없다(조용히 0 을 넣지 않는다)
 *  ③ 실제 라우트 — inv.hosts 게이트 · 범위(applyFilters) · 관리자 판본(iDRAC) · 구성 점검 도구 권한(재부팅) · /hosts/checks 가 id 로 잡히지 않는다 · 범위 밖 호스트 404
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hostchecks2803-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VC = 'vc-a'; const OUT = 'vc-out';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: OUT, name: 'vc-out', host: 'vco.corp.local', username: 'u', password: 'p', collectMode: 'site' },
] }));
// operator 는 '구성 점검' 도구만 막는다 · viewer 는 tools 권한 없음(재부팅 묶음 없음) · inv.hosts 는 둘 다.
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
  operator: ['dashboard', 'tools', 'inv.hosts'], viewer: ['dashboard', 'inv.hosts'], toolsDenied: { operator: ['host-hygiene'], viewer: [] } } }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const C = await import('../src/vcenter/hostChecks.js');
const R = await import('../src/routes/api/hostChecks.js');
const { store } = await import('../src/store.js');
const express = (await import('express')).default;

const H = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const host = (id, name, over = {}) => ({ id: `${VC}:${id}`, vcenterId: VC, name, cluster: 'CL1', connectionState: 'CONNECTED', powerState: 'POWERED_ON', cpuCores: 32, cpuUsagePct: 40, memUsagePct: 50, bootTime: NOW - 10 * DAY, serviceTag: `TAG-${id}`, ...over });
const view = (fan, psu) => ({ system: { biosVersion: '1.0', health: fan === 'fault' ? 'Critical' : 'OK' }, fans: [{ name: 'FAN1', partState: fan }], psus: [{ name: 'PSU1', partState: psu }] });

test('① 순수 — iDRAC 한 줄 · 재부팅 행 · Veeam 수(템플릿 제외 · 수집 안 됨 null)', () => {
  assert.deepEqual(C.hwStateOf(undefined), { state: 'pending', bad: null }, '등록됐지만 인벤토리 없음');
  assert.deepEqual(C.hwStateOf(null), { state: 'none', bad: null }, '등록 안 됨');
  assert.equal(C.hwStateOf(view('ok', 'ok')).state, 'ok');
  assert.deepEqual(C.hwStateOf(view('warn', 'ok')), { state: 'warn', bad: 1, health: 'OK' });
  assert.equal(C.hwStateOf(view('fault', 'warn')).state, 'fault', '장애가 경고보다 먼저');
  assert.equal(C.hwStateOf(view('unknown', 'ok')).state, 'unknown');

  const hosts = [host('h1', 'esx01'), host('h2', 'esx02'), host('h3', 'esx03', { serviceTag: '' })];
  const idracFor = (h) => (h.id.endsWith('h1') ? view('warn', 'ok') : h.id.endsWith('h2') ? undefined : null);
  const reboots = new Map([[`${VC}:h1`, { id: `${VC}:h1`, kind: 'unexpected', bootTime: NOW - 2 * DAY }], [`${VC}:h2`, { id: `${VC}:h2`, kind: 'planned', bootTime: NOW - 5 * DAY }]]);
  const vms = [
    { id: 'v1', vcenterId: VC, host: 'esx01', name: 'a', powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192 }, { id: 'v2', vcenterId: VC, host: 'esx01', name: 'b', powerState: 'POWERED_OFF', cpuCount: null, memMB: 4096 },
    { id: 'v3', vcenterId: VC, host: 'esx01', name: 't', template: true, cpuCount: 2, memMB: 2048 },
    { id: 'v4', vcenterId: VC, host: 'esx02', name: 'c', powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384 }, { id: 'v5', vcenterId: OUT, host: 'esx01', name: 'other', cpuCount: 1, memMB: 1024 },
  ];
  const byId = new Map([['v1', { v: { lb: NOW - 2 * H } }], ['v2', { v: { lb: NOW - 3 * DAY } }], ['v3', { v: { lb: NOW - H } }], ['v4', {}]]);
  const veeamOf = (id) => (id === VC ? { linked: true, byId } : null);
  const r = C.hostChecksOf(hosts, { access: { hygiene: true, hw: true }, idracFor, reboots, veeamOf, vmsByHost: C.vmsByHostOf(vms), now: NOW });
  assert.deepEqual(r.byId[`${VC}:h1`], { hw: { state: 'warn', bad: 1, health: 'OK' }, boot: { kind: 'unexpected', bootTime: NOW - 2 * DAY }, vm: { n: 2, on: 1, templates: 1, vcpu: 4, memMB: 12288, vcpuUnknown: 1, memUnknown: 0 }, veeam: { y: 1, n: 1, unknown: 0, total: 2 } }, '템플릿 v3 은 세지 않는다(templates 로 따로) · 못 읽은 vCPU 는 unknown · 타 vCenter 동명 호스트의 VM 은 섞이지 않는다');
  assert.deepEqual(r.byId[`${VC}:h2`], { hw: { state: 'pending', bad: null }, boot: { kind: 'planned', bootTime: NOW - 5 * DAY }, vm: { n: 1, on: 1, templates: 0, vcpu: 8, memMB: 16384, vcpuUnknown: 0, memUnknown: 0 }, veeam: { y: 0, n: 0, unknown: 1, total: 1 } }, "'v' 키가 없는 판정은 모름");
  assert.deepEqual(r.byId[`${VC}:h3`], { hw: { state: 'none', bad: null }, boot: null, vm: { n: 0, on: 0, templates: 0, vcpu: 0, memMB: 0, vcpuUnknown: 0, memUnknown: 0 }, veeam: { y: 0, n: 0, unknown: 0, total: 0 } }, '최근 30일 재부팅 행이 없으면 null(없음) — 수집 안 됨과 다르다');
  assert.deepEqual(r.counts, { hw: 1, hwPending: 1, unexpected: 1, veeamN: 1, veeamUnknown: 1 });
  // Veeam 을 못 읽은 vCenter 는 null(0 이 아니다)
  const r2 = C.hostChecksOf(hosts, { access: { hygiene: false, hw: false }, veeamOf: () => null, vmsByHost: C.vmsByHostOf(vms), now: NOW });
  assert.equal(r2.byId[`${VC}:h1`].veeam, null);
  assert.equal(C.veeamCountsOf({ linked: false, byId: new Map() }, vms, NOW).unknown, 4, '연결 안 된 Veeam 은 전부 모름(템플릿 1 제외)');
});

test('② 권한으로 뺀 묶음은 키 자체가 없다 · 등록부를 못 읽으면 error', () => {
  const hosts = [host('h1', 'esx01')];
  const r = C.hostChecksOf(hosts, { access: { hygiene: false, hw: false }, idracFor: () => view('warn', 'ok'), reboots: new Map([[`${VC}:h1`, { kind: 'unexpected', bootTime: NOW }]]), now: NOW });
  assert.deepEqual(Object.keys(r.byId[`${VC}:h1`]), ['vm', 'veeam'], 'VM 합은 권한과 무관(인벤토리)');
  assert.deepEqual(r.counts, { hw: 0, hwPending: 0, unexpected: 0, veeamN: 0, veeamUnknown: 0 });
  const r3 = C.hostChecksOf(hosts, { access: { hygiene: true, hw: true }, now: NOW });
  assert.deepEqual(r3.byId[`${VC}:h1`].hw, { state: 'error', bad: null }, 'idracFor 가 없으면(등록부 못 읽음) error — 등록 안 됨이 아니다');
  assert.equal(r3.byId[`${VC}:h1`].boot, null);
});

test('③ 실제 라우트 — inv.hosts · 범위 · 관리자 판본 · 구성 점검 도구 권한 · checks 는 id 가 아니다 · 범위 밖 404', async () => {
  const prev = store.snapshot;
  const hosts = [host('h1', 'esx01.corp.local'), host('h2', 'esx02.corp.local', { connectionState: 'MAINTENANCE' }), { ...host('x1', 'other.corp.local'), id: `${OUT}:x1`, vcenterId: OUT }];
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: VC, name: 'vc-a', version: '8.0.3' }, { id: OUT, name: 'vc-out' }], hosts, vms: [], datastores: [] };
  let user = { username: 'adm', role: 'admin' };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostChecks(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const base = `http://127.0.0.1:${srv.address().port}/api/hosts`;
  const get = (p) => fetch(`${base}${p}`);

  // 관리자 — iDRAC(등록부 비어 있으면 등록 안 됨) · 재부팅 · Veeam(제공자 없음 → null) 전부 키가 있다
  let r = await get('/checks');
  assert.equal(r.status, 200);
  let j = await r.json();
  assert.deepEqual(j.access, { hygiene: true, cluster: true, hw: true });
  assert.equal(j.hosts, 3);
  const VM0 = { n: 0, on: 0, templates: 0, vcpu: 0, memMB: 0, vcpuUnknown: 0, memUnknown: 0 };
  assert.deepEqual(j.byId[`${VC}:h1`], { hw: { state: 'none', bad: null }, boot: { kind: 'no-events', bootTime: NOW - 10 * DAY }, vm: VM0, veeam: null }, '부팅 10일 전 · 이벤트 DB 비어 있음 → 판정 불가(no-events) — 조용히 null 로 바꾸지 않는다');
  assert.equal(j.bootDays, 30);
  // 필터는 /hosts 와 같다(vcenterId · state)
  j = await (await get(`/checks?vcenterId=${VC}&state=MAINTENANCE`)).json();
  assert.deepEqual(Object.keys(j.byId), [`${VC}:h2`]);
  // operator — 구성 점검 도구가 막혀 재부팅 묶음 없음 · 관리자 판본이 아니라 iDRAC 없음
  user = { username: 'op', role: 'operator' };
  j = await (await get('/checks?vcenterId=' + OUT)).json();
  assert.deepEqual(j.access, { hygiene: false, cluster: true, hw: false });
  assert.deepEqual(j.byId[`${OUT}:x1`], { vm: VM0, veeam: null });
  // 범위 계정 — 범위 밖 호스트는 집계에 없고 단건은 404
  user = { username: 'v', role: 'viewer', scope: { vcenters: [VC] } };
  j = await (await get('/checks')).json();
  assert.deepEqual(Object.keys(j.byId).sort(), [`${VC}:h1`, `${VC}:h2`]);
  assert.equal(j.hosts, 2);
  assert.equal((await get(`/${encodeURIComponent(`${OUT}:x1`)}`)).status, 404, '범위 밖 호스트는 404(존재 여부 미노출)');
  assert.equal((await get('/nope')).status, 404);
  r = await get(`/${encodeURIComponent(`${VC}:h1`)}`);
  assert.equal(r.status, 200);
  j = await r.json();
  assert.equal(j.item.name, 'esx01.corp.local');
  assert.deepEqual(j.vcenter, { id: VC, name: 'vc-a', version: '8.0.3', location: null });
  assert.equal(j.admin, false);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // inv.hosts 없는 역할은 403
  user = { username: 'none', role: 'guest' };
  assert.equal((await get('/checks')).status, 403);
});
