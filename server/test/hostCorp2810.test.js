/**
 * v2.810 — ESXi 호스트 화면 '법인별' 보기 집계(/hosts/corp). 승인 시안 B https://claude.ai/artifact/JGykMmoG7kAyNsa5y4uG1x.
 *  ① CPU 구간 경계가 웹 hostTriage.cpuBucket 과 같다(번들 경계라 두 벌 — 같은 입력으로 대조)
 *  ② 순수 집계 — 법인 판정(위험·주의·없음) · 못 읽은 값은 null · 클러스터 구성 권한이 없으면 키가 없다 · 분모를 못 읽으면 비율 null
 *  ③ N+1 은 '인사이트' 와 같은 함수(n1Groups) — 같은 입력에 같은 결과
 *  ④ 실제 라우트 — inv.hosts · 범위(다른 법인 이름도 없다) · 권한 판본 · 'corp' 가 호스트 id 로 잡히지 않는다 · 지역·검색 필터
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hostcorp2810-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
const VC = 'vc-a'; const VB = 'vc-b'; const OUT = 'vc-out';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc-a', host: 'vca.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: VB, name: 'vc-b-IRS', host: 'vcb.corp.local', username: 'u', password: 'p', collectMode: 'site' },
  { id: OUT, name: 'vc-out', host: 'vco.corp.local', username: 'u', password: 'p', collectMode: 'site' },
] }));
// operator 는 '클러스터 HA·DRS 점검' 도구만 막는다 · viewer 는 tools 권한 없음 · inv.hosts 는 둘 다.
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: {
  operator: ['dashboard', 'tools', 'inv.hosts'], viewer: ['dashboard', 'inv.hosts'], toolsDenied: { operator: ['cluster-check'], viewer: [] } } }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const C = await import('../src/vcenter/hostCorp.js');
const N1 = await import('../src/clustercfg/n1.js');
const R = await import('../src/routes/api/hostCorp.js');
const RC = await import('../src/routes/api/hostChecks.js');
const W = await import('../../web/src/views/hostTriage.js');
const { store, usageReadable, hostCapacityKnown } = await import('../src/store.js');
const express = (await import('express')).default;

const GB = 1024;
const host = (vc, id, cluster, over = {}) => ({
  id: `${vc}:${id}`, vcenterId: vc, name: `${id}.corp.local`, cluster, connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  cpuCores: 32, cpuTotalMhz: 32 * 2000, cpuUsageMhz: 0, cpuUsagePct: 40, memTotalMB: 512 * GB, memUsageMB: 0, memUsagePct: 50, powerWatts: 400, ...over,
});
const withMhz = (h) => ({ ...h, cpuUsageMhz: h.cpuUsagePct == null ? 0 : Math.round(h.cpuTotalMhz * h.cpuUsagePct / 100), memUsageMB: h.memUsagePct == null ? 0 : Math.round(h.memTotalMB * h.memUsagePct / 100) });
const vm = (vc, hostName, cpu, memGB, over = {}) => ({ id: `${vc}:vm-${hostName}-${cpu}`, vcenterId: vc, host: hostName, cpuCount: cpu, memMB: memGB * GB, powerState: 'POWERED_ON', ...over });
const base = { readable: usageReadable, capKnown: hostCapacityKnown };

test('① CPU 구간 경계 — 웹 hostTriage.cpuBucket 과 같은 결과(> 90 확인 · > 100 별도 · 못 읽음 na)', () => {
  const cases = [0, 49, 50, 74, 75, 90, 90.5, 91, 100, 101, 113, null, '', undefined];
  const states = ['CONNECTED', 'MAINTENANCE', 'DISCONNECTED', 'NOT_RESPONDING'];
  for (const v of cases) for (const s of states) {
    const h = { cpuUsagePct: v, connectionState: s };
    assert.equal(C.cpuBucketOf(h, usageReadable), W.cpuBucket(h), `cpu=${v} state=${s}`);
  }
  assert.deepEqual([...C.BUCKET_KEYS], W.CPU_BUCKETS.map((b) => b.key), '구간 순서도 같다');
  assert.equal(C.CPU_ATTENTION_PCT, W.CPU_ATTENTION_PCT);
});

test('② 순수 집계 — 판정 · 못 읽은 값 null · 권한 없으면 구성 키 없음 · 분모를 못 읽으면 비율 null', () => {
  const hosts = [
    host(VC, 'a1', 'GPDB', { cpuUsagePct: 97 }), host(VC, 'a2', 'GPDB', { cpuUsagePct: 105 }), host(VC, 'a3', 'GPDB', { cpuUsagePct: 30 }),
    host(VC, 'a4', 'APP', { connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0 }), host(VC, 'a5', 'APP', { connectionState: 'MAINTENANCE', cpuUsagePct: 1 }),
    host(VC, 'a6', 'standalone'),
    host(VB, 'b1', 'IRS', { cpuCores: null, memUsagePct: 30 }), host(VB, 'b2', 'IRS', { memUsagePct: 30 }),
  ].map(withMhz);
  const vms = [vm(VC, 'a1.corp.local', 64, 256), vm(VC, 'a1.corp.local', 8, 16, { template: true }), vm(VB, 'b2.corp.local', 16, 64)];
  const vcenters = [
    { id: VC, name: 'vc-a', status: 'connected', location: { region: '유럽', city: 'Wroclaw', country: 'PL' }, clusterCfg: [
      { name: 'GPDB', ha: { enabled: true, admission: true }, drs: { enabled: true, behavior: 'fullyAutomated' }, evc: 'intel-icelake', numHosts: 3, numEffectiveHosts: 3 },
      { name: 'APP', ha: { enabled: false }, drs: { enabled: true, behavior: 'manual' }, evc: '', numHosts: 2, numEffectiveHosts: 1 },
    ] },
    { id: VB, name: 'vc-b-IRS', status: 'connected', stale: true, receivedAt: 1, collectSource: 'site', location: { region: '아시아' } },
    { id: 'vc-p', name: 'vc-p', status: 'pending', location: { region: '북미' } },
  ];
  const rtt = { [VC]: { rttMs: 842, ok: true, at: 5, fresh: true } };
  const r = C.hostCorpOf({ vcenters, hosts, vms, ...base, rttOf: (id) => rtt[id] || null, now: 10 });
  assert.deepEqual(r.corps.map((c) => c.id), [VB, VC, 'vc-p'], '리전(아시아 → 유럽 → 북미) › 이름순');
  const a = r.corps.find((c) => c.id === VC);
  assert.equal(a.hosts, 6); assert.equal(a.down, 1); assert.equal(a.maint, 1); assert.equal(a.hot, 2);
  assert.deepEqual(a.buckets, { lt50: 3, b50: 0, b75: 0, b90: 1, over: 1, na: 1 }, '끊긴 호스트의 0% 는 0 이 아니라 na');
  assert.equal(a.clusterCount, 2); assert.equal(a.standalone, 1, "'standalone' 은 클러스터로 세지 않는다");
  assert.equal(a.vcpu, 64, '템플릿 vCPU 는 넣지 않는다'); assert.equal(a.vcpuPerCore, Math.round(64 / (6 * 32) * 10) / 10);
  assert.equal(a.sev, 'crit', '끊김 1대 + HA 꺼진 클러스터 → 위험');
  assert.deepEqual(a.reasons.sort(), ['down', 'ha', 'hot', 'maint', 'n1'].sort());
  assert.deepEqual(a.rtt, rtt[VC]);
  assert.equal(a.cfg.haOff, 1); assert.equal(a.cfg.drsWeak, 1); assert.equal(a.cfg.collected, 2);
  const app = a.clusters.find((c) => c.name === 'APP');
  assert.equal(app.ha, false); assert.equal(app.drs, 'manual'); assert.equal(app.evc, '', "EVC '' = 꺼짐(null 아님)");
  assert.equal(app.sev, 'crit');
  assert.deepEqual(app.hostIds.sort(), [`${VC}:a4`, `${VC}:a5`]);
  assert.equal(app.cpuAvg, 1, '평균은 읽은 호스트만(끊긴 호스트 제외)');
  // 여유 메모리 = 정격 × 90% − 사용 중 — 읽은 호스트만, 뺀 수를 밝힌다
  const gp = a.clusters.find((c) => c.name === 'GPDB');
  assert.equal(gp.headroomGB, Math.round(3 * 512 * 0.4)); assert.equal(gp.headroomExcluded, 0);
  assert.equal(app.headroomExcluded, 1);
  // 분모(용량)를 하나라도 못 읽은 법인은 비율 null — 분자만 남은 틀린 비율 금지
  const b = r.corps.find((c) => c.id === VB);
  assert.equal(b.capUnknown, 1); assert.equal(b.vcpuPerCore, null); assert.equal(b.ramPct, null);
  assert.equal(b.group, 'irs'); assert.equal(b.collect, 'site'); assert.equal(b.sev, 'warn', '낡은 값 → 주의');
  assert.deepEqual(b.reasons, ['stale']);
  assert.equal(b.rtt, null, '핑 값이 없으면 null(0ms 아님)');
  // 첫 수집 중 — 호스트 수를 모른다(0대 아님)
  const p = r.corps.find((c) => c.id === 'vc-p');
  assert.equal(p.hosts, null); assert.equal(p.sev, 'none');
  assert.equal(r.totals.corpsUnknown, 1); assert.equal(r.totals.hot, 2); assert.equal(r.totals.hosts, 8);
  // 클러스터 구성 권한이 없으면 HA·DRS·N+1 키 자체가 없다
  const q = C.hostCorpOf({ vcenters, hosts, vms, ...base, access: { cluster: false } });
  const qa = q.corps.find((c) => c.id === VC);
  assert.equal('cfg' in qa, false);
  assert.equal(['ha', 'drs', 'evc', 'n1Ok', 'findings'].some((k) => k in qa.clusters[0]), false);
  assert.deepEqual(q.access, { cluster: false });
  assert.equal(qa.reasons.includes('ha'), false);
  // dropEmpty — 검색으로 호스트가 0 이 된 법인은 뺀다
  const d = C.hostCorpOf({ vcenters, hosts: hosts.filter((h) => h.vcenterId === VB), vms, ...base, dropEmpty: true });
  assert.deepEqual(d.corps.map((c) => c.id), [VB]);
});

test('③ N+1 은 인사이트와 같은 함수 — 같은 입력에 같은 판정', () => {
  const hosts = [host(VC, 'n1', 'C1', { cpuUsagePct: 80 }), host(VC, 'n2', 'C1', { cpuUsagePct: 80 }), host(VC, 'n3', 'C2', { cpuUsagePct: 20, memUsagePct: 20 }), host(VC, 'n4', 'C2', { cpuUsagePct: 20, memUsagePct: 20 })].map(withMhz);
  const groups = new Map(N1.n1Groups(hosts, usageReadable).map((x) => [x.row.cluster, x.row]));
  const r = C.hostCorpOf({ vcenters: [{ id: VC, name: 'vc-a', status: 'connected', clusterCfg: [] }], hosts, vms: [], ...base });
  for (const c of r.corps[0].clusters) {
    assert.equal(c.n1Ok, groups.get(c.name).n1Ok, c.name);
    assert.equal(c.cpuAfterFailPct, groups.get(c.name).cpuAfterFailPct, c.name);
  }
  assert.equal(groups.get('C1').n1Ok, false, '80% 두 대 — 한 대가 빠지면 160%');
  assert.equal(groups.get('C2').n1Ok, true, '20% 두 대 — CPU·메모리 모두 40%');
});

test('④ 실제 라우트 — inv.hosts · 범위 · 권한 판본 · corp 는 id 가 아니다 · 필터', async () => {
  const prev = store.snapshot;
  const hosts = [host(VC, 'h1', 'CL1', { cpuUsagePct: 95 }), host(VC, 'h2', 'CL1'), host(VB, 'b1', 'CLB'), host(OUT, 'x1', 'CLX')].map(withMhz);
  store.snapshot = { source: 'live', generatedAt: new Date().toISOString(), vms: [], datastores: [], hosts, vcenters: [
    { id: VC, name: 'vc-a', status: 'connected', location: { region: '유럽' }, clusterCfg: [{ name: 'CL1', ha: { enabled: true, admission: false }, drs: { enabled: true, behavior: 'fullyAutomated' }, evc: 'x', numHosts: 2 }] },
    { id: VB, name: 'vc-b-IRS', status: 'connected', location: { region: '아시아' } },
    { id: OUT, name: 'vc-out', status: 'connected', location: { region: '북미' } },
  ] };
  let user = { username: 'adm', role: 'admin' };
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostCorp(api); RC.registerHostChecks(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  closers.push(async () => { store.snapshot = prev; });
  const url = `http://127.0.0.1:${srv.address().port}/api/hosts/corp`;
  const get = async (q = '') => { const r = await fetch(url + q); return { status: r.status, j: r.status === 200 ? await r.json() : null }; };

  let { status, j } = await get();
  assert.equal(status, 200, "'corp' 가 /hosts/:id 로 잡혀 404 가 나면 안 된다");
  assert.deepEqual(j.corps.map((c) => c.id), [VB, VC, OUT]);
  assert.deepEqual(j.access, { cluster: true });
  const a = j.corps.find((c) => c.id === VC);
  assert.equal(a.cfg.acOff, 1); assert.equal(a.sev, 'warn', 'CPU 90% 초과 1대 + 수용 제어 꺼짐 → 주의');
  assert.equal(a.rtt, null, '핑 대상이 없으면 null');
  // 지역 필터 · 검색(호스트가 0 이 된 법인은 뺀다)
  ({ j } = await get('?region=' + encodeURIComponent('유럽')));
  assert.deepEqual(j.corps.map((c) => c.id), [VC]);
  ({ j } = await get('?q=b1'));
  assert.deepEqual(j.corps.map((c) => c.id), [VB]);
  // operator — 클러스터 점검 도구가 막혀 구성·N+1 키 없음
  user = { username: 'op', role: 'operator' };
  ({ j } = await get());
  assert.deepEqual(j.access, { cluster: false });
  assert.equal(j.corps.some((c) => 'cfg' in c), false);
  // 범위 계정 — 다른 법인은 이름도 없다(요청 필터로 넓힐 수 없다)
  user = { username: 'v', role: 'viewer', scope: { vcenters: [VC] } };
  ({ j } = await get());
  assert.deepEqual(j.corps.map((c) => c.id), [VC]);
  assert.equal(j.totals.hosts, 2);
  ({ j } = await get('?vcenterId=' + OUT));
  assert.deepEqual(j.corps, [], '범위 밖 vcenterId 를 요청해도 비어 있다');
  assert.equal(JSON.stringify(j).includes('vc-out'), false);
  // inv.hosts 없는 역할은 403
  user = { username: 'none', role: 'guest' };
  ({ status } = await get());
  assert.equal(status, 403);
});
