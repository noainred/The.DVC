/**
 * v3.22.0 — Hypervisor 탭 '분석' 보기 집계 GET /api/hosts/insight(설계 docs/design/host-insight · 집계 vcenter/hostInsight.js)와
 *   그 화면의 특수 기능 패널이 쓰는 도구 요약 모드(`?summary=1` — host-hygiene · storage-paths · capacity-forecast · contention 의 호스트 칸).
 * **실제 api 라우터**(requirePerm · toolGate · 범위 · memoJson)를 띄워 같은 스냅샷으로 원본 응답과 대조한다:
 *  ① 법인별 합 = /hosts/corp(법인 줄 · 클러스터 줄 · N+1 · HA · 수용 제어 · 여유) · /hosts 합계(수 · 연결 · 점검 · 끊김 · vCore · ESXi 버전) · /hosts/checks(하드웨어 · 재부팅)
 *  ② 못 읽음 · 모름 분리 — 사용률 못 읽음은 칸 · 평균 밖(usageUnknown) · 용량 모름(capUnknown) · 설정 미수집(cfgUnknown) · 개수 모르는 법인(unknown — null)
 *  ③ 범위 계정은 범위 밖 줄 · 이름이 없다 · vcenterIds 는 받지 않는다 · 캐시 키에 범위 · 권한 판본(없는 권한의 칸은 키가 없다)
 *  ④ 도구 요약의 권한 거부가 원본과 같다(tools 없음 · 도구별 거부)
 *  ⑤ 도구 요약 합 = 원본 합계(판정 그대로)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hostinsight3220-'));
Object.assign(process.env, { CONFIG_DIR: TMP, DATA_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
fs.writeFileSync(path.join(TMP, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
// 도구 키 — /tools/capacity-forecast 의 집행 키는 'forecast'(auth/toolAccess.js 세그먼트 매핑).
const TOOL_KEYS = ['host-hygiene', 'storage-paths', 'forecast', 'contention', 'cluster-check'];
// operator = inv.hosts · tools 는 있으나 다섯 도구가 역할 거부 · viewer = 둘 다 없음 · admin = 전부.
fs.writeFileSync(path.join(TMP, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'tools', 'inv.hosts'], viewer: ['dashboard'], toolsDenied: { operator: TOOL_KEYS, viewer: [] } },
}));

const DAY = 86_400_000;
const HOUR = 3_600_000;
// 기준 시각 — 실제 시각을 정시 경계로 떨어뜨려 고정(Date.now() 직접 · 고정 epoch 둘 다 깨진다)
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
// 경합 표본 시각은 판정이 실제 시각(Date.now)과 비교한다(staleAfterMs 45분) — 정시 경계로 떨어뜨린 NOW 에서 1분 전이면 매시 45분 뒤에 낡은 표본이 돼 ⑤ 가 실패했다(v3.22.0 메인 재현). 표본은 실제 시각 1분 전.
const RECENT = Date.now() - 60_000;
let seq = 0;
const GB = 1024;

const host = (vc, id, cluster, o = {}) => {
  const h = {
    id: `${vc}:${id}`, vcenterId: vc, name: `${vc}-${id}`, cluster, clusterRef: cluster === 'standalone' ? null : `domain-${cluster}`,
    connectionState: 'CONNECTED', powerState: 'POWERED_ON', version: '8.0.2', vendor: 'Dell Inc.', model: 'PowerEdge R760',
    cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsagePct: 40, memTotalMB: 512 * GB, memUsagePct: 50, powerWatts: 400,
    hcfg: { at: NOW - HOUR, certNotAfter: NOW + 400 * DAY, services: { ssh: { running: false } }, mp: { luns: 4, shared: 4, paths: 8, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [], policies: { VMW_PSP_RR: 4 } } },
    perfc: { at: RECENT, diskMaxMs: { avg: 5 }, ds: [] },
    ...o,
  };
  h.cpuUsageMhz = h.cpuUsagePct == null || h.cpuTotalMhz == null ? 0 : Math.round(h.cpuTotalMhz * h.cpuUsagePct / 100);
  h.memUsageMB = h.memUsagePct == null || h.memTotalMB == null ? 0 : Math.round(h.memTotalMB * h.memUsagePct / 100);
  return h;
};
const hc = (o) => ({ at: NOW - HOUR, certNotAfter: NOW + 400 * DAY, services: { ssh: { running: false } }, mp: { luns: 4, shared: 4, paths: 8, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [], policies: {} }, ...o });
const vm = (vc, hostName, i, o = {}) => ({
  id: `${vc}:vm-${hostName}-${i}`, vcenterId: vc, name: `${hostName}-vm${i}`, host: hostName, powerState: 'POWERED_ON', template: false,
  cpuCount: 4, memMB: 8 * GB, cpuUsagePct: 10, memUsagePct: 20,
  perfc: { at: RECENT, samples: 15, readyPct: { avg: 2, max: 3 }, costopPct: { avg: 0, max: 0 }, latencyPct: { avg: 0, max: 0 }, readMs: { avg: 3, max: 5 }, writeMs: { avg: 2, max: 4 }, disk: 'scsi0:0' },
  ...o,
});

function buildSnap() {
  const hosts = [
    // vc-a(유럽) — CL1 3대(과부하 1 · 인증서 만료 1 · SSH 1 · 죽은 경로 1) · CL2 3대(끊김 1 · 사용률 못 읽음 1) · 독립 1대
    host('vc-a', 'h1', 'CL1', { cpuUsagePct: 95, memUsagePct: 93, hcfg: hc({ certNotAfter: NOW - 10 * DAY - HOUR, services: { ssh: { running: true } } }) }),
    host('vc-a', 'h2', 'CL1', { cpuUsagePct: 70, version: '7.0.3', hcfg: hc({ certNotAfter: NOW - 40 * DAY - HOUR, mp: { luns: 4, shared: 4, paths: 8, dead: 3, deadLuns: ['naa.1'], singlePath: 1, singleLuns: ['naa.2'], policies: {} } }) }),
    host('vc-a', 'h3', 'CL1', { cpuUsagePct: 20, model: 'PowerEdge R750', powerWatts: undefined }),
    host('vc-a', 'h4', 'CL2', { connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0 }),
    host('vc-a', 'h5', 'CL2', { cpuUsagePct: null, memUsagePct: null, hcfg: null }),
    host('vc-a', 'h6', 'CL2', { cpuUsagePct: 55, memUsagePct: 85, perfc: { at: RECENT, diskMaxMs: { avg: 60 }, ds: [{ uuid: 'vc-a-u1', readMs: { avg: 70 }, writeMs: { avg: 1 } }] } }),
    host('vc-a', 'h7', 'standalone', { cpuUsagePct: 30, vendor: 'HPE', model: 'ProLiant DL380' }),
    // vc-b(아시아) — 클러스터 설정 미수집 · 용량 모름 1 · 점검 1
    host('vc-b', 'h1', 'BCL', { cpuCores: null, cpuTotalMhz: null, memTotalMB: null, cpuUsagePct: 30 }),
    host('vc-b', 'h2', 'BCL', { connectionState: 'MAINTENANCE', cpuUsagePct: 5, version: '' }),
    host('vc-b', 'h3', 'BCL', { cpuUsagePct: 101 }),
  ];
  const vms = [];
  // 호스트당 VM 수 — vc-a h1 14대(대기 심각 2) · h2 10대 · h6 3대 · vc-b h3 20대 · 템플릿 1 · vCPU 못 읽음 1
  for (let i = 0; i < 14; i++) vms.push(vm('vc-a', 'vc-a-h1', i, i < 2 ? { perfc: { ...vm('', '', 0).perfc, readyPct: { avg: 12 + i, max: 20 } } } : {}));
  for (let i = 0; i < 10; i++) vms.push(vm('vc-a', 'vc-a-h2', i, i === 0 ? { cpuCount: null } : {}));
  for (let i = 0; i < 3; i++) vms.push(vm('vc-a', 'vc-a-h6', i, { perfc: { ...vm('', '', 0).perfc, readyPct: { avg: 6, max: 8 } } }));
  vms.push(vm('vc-a', 'vc-a-h1', 99, { template: true, powerState: 'POWERED_OFF', perfc: null }));
  for (let i = 0; i < 20; i++) vms.push(vm('vc-b', 'vc-b-h3', i, { memMB: i === 0 ? '' : 4 * GB }));
  const ds = (vc, i, o = {}) => ({ id: `${vc}:datastore-${i}`, vcenterId: vc, name: `${vc}-ds${i}`, type: 'VMFS', dsUuid: `${vc}-u${i}`, capacityGB: 1000, usedGB: 500, freeGB: 500, usagePct: 50, ...o });
  return {
    source: 'live', generatedAt: new Date(NOW + (seq++) * 1000).toISOString(),
    vcenters: [
      { id: 'vc-a', name: 'VC-A', status: 'connected', location: { region: '유럽', city: 'Warsaw', country: 'PL' }, clusterCfg: [
        { ref: 'domain-CL1', name: 'CL1', ha: { enabled: true, admission: true }, drs: { enabled: true, behavior: 'fullyAutomated' }, evc: 'intel', numHosts: 3 },
        { ref: 'domain-CL2', name: 'CL2', ha: { enabled: false }, drs: { enabled: true, behavior: 'manual' }, evc: '', numHosts: 3 },
      ] },
      { id: 'vc-b', name: 'VC-B', status: 'connected', location: { region: '아시아', city: 'Seoul', country: 'KR' } },
      { id: 'vc-down', name: 'VC-DOWN', status: 'unreachable', location: { region: '북미' } },
    ],
    hosts, vms,
    datastores: [ds('vc-a', 1, { usedGB: 950, freeGB: 50, usagePct: 95 }), ds('vc-a', 2), ds('vc-b', 1, { usedGB: null, freeGB: null, usagePct: null }), ds('vc-b', 2, { usedGB: 920, freeGB: 80, usagePct: 92 })],
    networks: [], alarms: [],
  };
}

let base; let store; const closers = [];
const setSnap = (o = {}) => { store.snapshot = { ...(store.get() || {}), ...buildSnap(), ...o }; };
before(async () => {
  ({ store } = await import('../src/store.js'));
  const prev = store.snapshot;
  closers.push(async () => { store.snapshot = prev; });
  setSnap();
  const express = (await import('express')).default;
  const { queryNormalizer } = await import('../src/util/queryNormalize.js');
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json()); app.use(queryNormalizer());
  app.use((req, _r, n) => {
    const role = req.get('x-role') || 'admin';
    const scope = req.get('x-scope') ? { vcenters: req.get('x-scope').split(',') } : null;
    req.user = { username: role === 'admin' ? (scope ? 'adm-scoped' : 'adm') : `u-${role}`, role, scope };
    n();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  for (const c of closers.reverse()) { try { await c(); } catch { /* */ } }
  const rm = () => { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 늦은 flush */ } };
  rm(); process.once('exit', rm);
});

async function get(p, { role = 'admin', scope = '' } = {}) {
  const headers = { 'x-role': role };
  if (scope) headers['x-scope'] = scope;
  const r = await fetch(base + p, { headers });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, j, text: t };
}
const sum = (rows, f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
const known = (rows) => rows.filter((r) => !r.unknown);

/* ── ① 법인별 합 = /hosts/corp · /hosts · /hosts/checks ─────────────────────────────── */

test('① 법인 줄 = /hosts/corp 법인 줄(같은 함수 · 같은 입력) · 합 = /hosts 합계 · /hosts/checks 수', async () => {
  const ins = await get('/api/hosts/insight');
  assert.equal(ins.status, 200, ins.text.slice(0, 300));
  const I = ins.j;
  const corp = (await get('/api/hosts/corp')).j;
  const hostsR = (await get('/api/hosts')).j;
  const checks = (await get('/api/hosts/checks')).j;
  assert.deepEqual(I.rows.map((r) => r.id).sort(), corp.corps.map((c) => c.id).sort(), '법인 목록이 같다');
  for (const c of corp.corps) {
    const r = I.rows.find((x) => x.id === c.id);
    if (c.hosts == null) { assert.equal(r.unknown, true, c.id); continue; }
    assert.equal(r.hosts.total, c.hosts, `${c.id} hosts`);
    assert.equal(r.hosts.connected, c.connected, `${c.id} connected`);
    assert.equal(r.hosts.maint, c.maint, `${c.id} maint`);
    assert.equal(r.overloaded, c.hot, `${c.id} 과부하 = CPU 90 초과(hot)`);
    assert.equal(r.over90.cpu, c.hot);
    assert.equal(r.cores, c.cores, `${c.id} cores`); assert.equal(r.capUnknown, c.capUnknown);
    assert.equal(r.memTotalMB == null ? null : Math.round(r.memTotalMB / 1024), c.memTotalGB, `${c.id} memTotal`);
    assert.equal(r.vcpu, c.vcpu); assert.equal(r.vcpuUnknown, c.vcpuUnknown);
    assert.equal(r.memVmMB == null ? null : Math.round(r.memVmMB / 1024), c.vmMemGB);
    assert.equal(r.memUnknown, c.vmMemUnknown);
    assert.equal(r.vcpuPerCore, c.vcpuPerCore); assert.equal(r.ramPct, c.ramPct);
    assert.equal(r.headroom.gb, c.headroomGB); assert.equal(r.headroom.excluded, c.headroomExcluded);
    assert.equal(r.cpuAvg.value, c.cpuAvg); assert.equal(r.memAvg.value, c.memAvg);
    assert.equal(Math.round(r.powerW.sum / 100) / 10, c.powerKw, `${c.id} 전력`);
    assert.equal(r.clusters.total, c.clusterCount);
    assert.equal(r.clusters.n1Fail, c.cfg.n1Fail); assert.equal(r.clusters.haOff, c.cfg.haOff); assert.equal(r.clusters.admissionOff, c.cfg.acOff);
    assert.equal(r.clusters.cfgUnknown, c.clusterCount - c.cfg.collected);
    // 클러스터 칸 = 법인 클러스터 줄(+ 독립 호스트 한 줄)
    const cells = I.clusters.filter((x) => x.vcenterId === c.id);
    assert.equal(cells.filter((x) => !x.standalone).length, c.clusterCount);
    assert.equal(sum(cells, (x) => x.hosts), c.hosts, `${c.id} 칸의 호스트 합`);
    assert.equal(cells.filter((x) => x.standalone).length, c.standalone > 0 ? 1 : 0);
    for (const cl of c.clusters) {
      const x = cells.find((y) => y.key === cl.key);
      assert.ok(x, cl.key);
      assert.equal(x.busiestCpu, cl.cpuMax); assert.equal(x.n1Ok, cl.n1Ok); assert.equal(x.n1Mem, cl.memAfterFailPct); assert.equal(x.n1Cpu, cl.cpuAfterFailPct);
      assert.equal(x.ha, cl.ha); assert.equal(x.admission, cl.admission); assert.equal(x.drs, cl.drs);
    }
  }
  // /hosts 합계
  const R = known(I.rows);
  const sm = hostsR.summary;
  assert.equal(sum(R, (r) => r.hosts.total), sm.total);
  assert.equal(sum(R, (r) => r.hosts.connected), sm.connected);
  assert.equal(sum(R, (r) => r.hosts.maint), sm.maintenance);
  assert.equal(sum(R, (r) => r.hosts.down), sm.disconnected);
  assert.equal(sum(R, (r) => r.vcpu), sm.vcoreAllocated);
  assert.equal(sum(R, (r) => r.vcpuUnknown), sm.vcpuUnknown);
  const ver = {};
  for (const r of R) { for (const [k, n] of Object.entries(r.esxi.versions)) ver[k] = (ver[k] || 0) + n; if (r.esxi.unread) ver.unknown = (ver.unknown || 0) + r.esxi.unread; }
  assert.deepEqual(ver, Object.fromEntries(sm.esxiVersions.map((v) => [v.version, v.count])), 'ESXi 버전별 수(못 읽음 = /hosts 의 unknown)');
  // /hosts/checks — 하드웨어 · 예기치 않은 재부팅
  assert.equal(sum(R, (r) => r.hw.warn + r.hw.fault), checks.counts.hw);
  assert.equal(sum(R, (r) => r.reboots30d), checks.counts.unexpected);
  for (const r of R) assert.equal(Object.values(r.hw).reduce((a, b) => a + b, 0), r.hosts.total, `${r.id} 하드웨어 상태 합 = 호스트`);
  assert.equal(I.thresholds.overloadPct, 90); assert.deepEqual(I.thresholds.vmsPerHostEdges, [9, 12, 15]); assert.equal(I.thresholds.bootDays, checks.bootDays);
  // 상위 N — CPU 큰 순 · 못 버티는 클러스터
  const a = I.top.find((t) => t.id === 'vc-a');
  assert.deepEqual(a.cpuTop.map((x) => x.cpu), [95, 70, 55, 30, 20], 'CPU 큰 순 5대(못 읽음 · 끊김 제외)');
  assert.equal(a.cpuTop[0].vms, 14, '템플릿은 VM 수에 넣지 않는다');
  assert.equal(a.n1Fail.length, sum(I.clusters.filter((x) => x.vcenterId === 'vc-a'), (x) => x.n1Ok === false));
  const b = I.rows.find((r) => r.id === 'vc-b');
  assert.deepEqual(b.vmsPerHost, { 9: 2, 12: 0, 15: 0, more: 1 }, '호스트당 VM 수 구간');
});

/* ── ② 못 읽음 · 모름 분리 ─────────────────────────────────────────────────────────── */

test('② 못 읽음 · 모름 — 칸 · 평균 밖으로 따로 센다 · 개수를 모르는 법인은 null', async () => {
  const I = (await get('/api/hosts/insight')).j;
  const a = I.rows.find((r) => r.id === 'vc-a');
  assert.equal(a.usageUnknown.cpu, 2, '끊김 1 + 사용률 못 읽음 1');
  assert.equal(a.cpuHist.reduce((x, y) => x + y, 0) + a.usageUnknown.cpu + a.histOut.cpu, a.hosts.total, '칸 + 모름 = 호스트');
  assert.equal(a.cpuHist[9], 1, '95% 는 마지막 칸');
  assert.equal(a.cpuAvg.n, 5); assert.equal(a.cpuAvg.sum, 95 + 70 + 20 + 55 + 30);
  assert.equal(a.hosts.unread, 1, '연결됐는데 못 읽음'); assert.equal(a.hosts.down, 1);
  assert.equal(a.over90.mem, 1, '메모리 93%');
  assert.equal(a.powerW.n, 6, '전력 센서 없는 호스트 1대는 읽은 수에서 빠진다');
  assert.equal(a.model.models['PowerEdge R760'], 5); assert.equal(a.vendor.vendors.HPE, 1);
  const b = I.rows.find((r) => r.id === 'vc-b');
  assert.equal(b.capUnknown, 1); assert.equal(b.cores, 64, '용량 모름 호스트는 코어 합에서 빠진다');
  assert.equal(b.esxi.unread, 1);
  assert.equal(b.cpuHist[9], 1, '101% 는 마지막 칸(과부하)');
  assert.equal(b.clusters.cfgUnknown, 1, '설정 미수집 클러스터');
  assert.equal(b.clusters.n1Fail, 0);
  const bc = I.clusters.find((x) => x.vcenterId === 'vc-b');
  assert.equal(bc.cfgCollected, false); assert.equal(bc.cfgUnknown, true); assert.equal(bc.ha, null);
  assert.equal(b.memUnknown, 1, '메모리 못 읽은 VM');
  const d = I.rows.find((r) => r.id === 'vc-down');
  assert.equal(d.unknown, true);
  for (const k of ['hosts', 'cores', 'vcpu', 'cpuHist', 'headroom', 'clusters', 'attention']) assert.equal(d[k], null, `vc-down.${k} 는 0 이 아니라 모름`);
  assert.deepEqual(I.top.find((t) => t.id === 'vc-down').cpuTop, []);
  const alone = I.clusters.find((x) => x.vcenterId === 'vc-a' && x.standalone);
  assert.equal(alone.name, '독립 호스트'); assert.equal(alone.hosts, 1); assert.equal(alone.n1Ok, null); assert.equal(alone.n1Unknown, true);
});

/* ── ③ 범위 · 권한 판본 · 캐시 키 ──────────────────────────────────────────────────── */

test('③ 범위 계정은 범위 밖 줄이 없다 · vcenterIds 는 받지 않는다 · 같은 URL 이어도 범위마다 다른 칸', async () => {
  const sc = await get('/api/hosts/insight?vcenterIds=vc-a', { scope: 'vc-b' });
  assert.equal(sc.status, 200);
  assert.deepEqual(sc.j.rows.map((r) => r.id), ['vc-b']);
  assert.ok(sc.j.clusters.every((x) => x.vcenterId === 'vc-b'));
  assert.doesNotMatch(sc.text, /vc-a|VC-A|vc-down|VC-DOWN/, '범위 밖 법인이 응답에 있다');
  const all = await get('/api/hosts/insight?vcenterIds=vc-a');
  assert.deepEqual(all.j.rows.map((r) => r.id).sort(), ['vc-a', 'vc-b', 'vc-down'], '고른 법인으로 줄이지 않는다(화면이 더한다)');
  const sc2 = await get('/api/hosts/insight?vcenterIds=vc-a', { scope: 'vc-b' });
  assert.deepEqual(sc2.j.rows.map((r) => r.id), ['vc-b'], '같은 URL — 캐시가 전체 계정 결과를 돌려주지 않는다');
  const reg = await get('/api/hosts/insight?region=%EC%9C%A0%EB%9F%BD');
  assert.deepEqual(reg.j.rows.map((r) => r.id), ['vc-a'], 'region 은 그 안에서 리전만');
});

// dbg3221(v3.22.1): 범위 바는 등록 데이터에만 있는 리전('Unknown' — registry.js 가 위치 없는 vCenter 에 둔다 · 사용자가 적은 '중동')도 고른다.
//   정해진 4리전만 받으면 그 글자를 버려 전 법인 합이 나왔다 — /vms/insight 처럼 location.region 과 그대로 비교한다. /hosts/corp(VM 분석 분포가 region 으로 부른다)도 같다.
test('③ dbg3221 정해진 4리전 밖 리전(Unknown · 중동)도 그 리전 법인만 — 전 법인 합으로 넓히지 않는다', async () => {
  const snap = buildSnap();
  snap.vcenters = snap.vcenters.map((v) => (v.id === 'vc-down' ? { ...v, location: { region: 'Unknown' } } : v.id === 'vc-b' ? { ...v, location: { region: '중동' } } : v));
  store.snapshot = { ...(store.get() || {}), ...snap };
  try {
    const unk = await get('/api/hosts/insight?region=Unknown');
    assert.equal(unk.status, 200, unk.text.slice(0, 200));
    assert.equal(unk.j.region, 'Unknown', '응답이 고른 리전을 그대로 밝힌다(null 로 버리지 않는다)');
    assert.deepEqual(unk.j.rows.map((r) => r.id), ['vc-down'], 'Unknown 리전 법인만');
    const me = await get(`/api/hosts/insight?region=${encodeURIComponent('중동')}`);
    assert.deepEqual(me.j.rows.map((r) => r.id), ['vc-b'], '사용자가 적은 리전 글자도 그 리전만');
    assert.ok(me.j.clusters.every((x) => x.vcenterId === 'vc-b'));
    const vmi = await get(`/api/vms/insight?region=${encodeURIComponent('중동')}`);
    assert.deepEqual(me.j.rows.map((r) => r.id), vmi.j.rows.map((r) => r.id), 'VM 분석과 같은 법인');
    const corp = await get(`/api/hosts/corp?region=${encodeURIComponent('중동')}`);
    assert.deepEqual(corp.j.corps.map((c) => c.id), ['vc-b'], '/hosts/corp 도 그 리전 법인만');
  } finally { setSnap(); }
});

test('③ 권한 — inv.hosts 없으면 /hosts/corp 와 같은 거부 · 클러스터 구성 · 하드웨어 · 재부팅 권한이 없으면 그 키가 없다', async () => {
  const v1 = await get('/api/hosts/insight', { role: 'viewer' });
  const v0 = await get('/api/hosts/corp', { role: 'viewer' });
  assert.equal(v1.status, 403); assert.equal(v1.status, v0.status);
  const op = await get('/api/hosts/insight', { role: 'operator' });
  assert.equal(op.status, 200, op.text.slice(0, 200));
  const a = op.j.rows.find((r) => r.id === 'vc-a');
  assert.deepEqual(Object.keys(a.clusters), ['total'], '클러스터 구성 권한 없음 — N+1 · HA 칸이 없다(0 이 아니다)');
  assert.equal('hw' in a, false, '관리자 판본이 아니면 하드웨어 칸 없음');
  assert.equal('reboots30d' in a, false, '구성 점검(host-hygiene) 도구가 거부된 계정 — 재부팅 칸 없음(/hosts/checks 와 같은 accessOf)');
  assert.equal(op.j.access.cluster, false);
  assert.equal('n1Fail' in op.j.top.find((t) => t.id === 'vc-a'), false);
  assert.ok(op.j.clusters.every((x) => !('n1Ok' in x)));
});

/* ── ④ 도구 요약 권한 · ⑤ 합 ──────────────────────────────────────────────────────── */

const TOOL_PATHS = ['/api/tools/host-hygiene', '/api/tools/storage-paths', '/api/tools/capacity-forecast', '/api/tools/contention'];

test('④ 도구 요약 — tools 없음 · 도구별 거부는 원본과 같은 거부(상태 · 본문) · 범위 계정은 범위 밖 줄이 없다', async () => {
  for (const p of TOOL_PATHS) {
    for (const role of ['operator', 'viewer']) {
      const orig = await get(p, { role });
      const summ = await get(`${p}?summary=1`, { role });
      assert.equal(orig.status, 403, `${p} 원본 ${role}`);
      assert.equal(summ.status, orig.status, `${p}?summary=1 ${role}`);
      assert.deepEqual(summ.j, orig.j, `${p} ${role}: 거부 본문이 원본과 같다`);
    }
    const adm = await get(`${p}?summary=1`);
    assert.equal(adm.status, 200, `${p}: ${adm.text.slice(0, 200)}`);
    assert.equal(adm.j.summary, true); assert.ok(Array.isArray(adm.j.rows));
    const sc = await get(`${p}?summary=1`, { scope: 'vc-b' });
    assert.ok(sc.j.rows.length >= 1 && sc.j.rows.every((x) => x.vcenterId === 'vc-b'), `${p}: ${JSON.stringify(sc.j.rows.map((x) => x.vcenterId))}`);
    assert.doesNotMatch(sc.text, /vc-a|VC-A/, `${p}: 범위 밖 법인이 응답에 있다`);
  }
});

test('⑤ 호스트 구성 점검 요약 — 문제 종류 · 심각 · SSH · 인증서 · 판정 밖 합 = 원본', async () => {
  const o = (await get('/api/tools/host-hygiene')).j;
  const s = (await get('/api/tools/host-hygiene?summary=1')).j;
  for (const [c, v] of Object.entries(o.byCode)) assert.equal(sum(s.rows, (r) => r.byCode[c]), v.hosts, `byCode.${c}`);
  for (const k of Object.keys(o.coverage)) assert.equal(sum(s.rows, (r) => r.coverage[k]), o.coverage[k], `coverage.${k}`);
  assert.equal(sum(s.rows, (r) => r.problem), o.matched);
  assert.equal(sum(s.rows, (r) => r.crit), o.rows.filter((r) => r.sev === 'crit').length);
  assert.equal(sum(s.rows, (r) => r.warn), o.rows.filter((r) => r.sev === 'warn').length);
  assert.equal(sum(s.rows, (r) => r.ssh), o.byCode['ssh-running'].hosts);
  assert.equal(sum(s.rows, (r) => r.outOfJudgment), o.coverage.notCollected + o.coverage.disconnected);
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.equal(a.certExpired, 2);
  const expDays = o.rows.filter((r) => r.vcenterId === 'vc-a').map((r) => r.findings.find((f) => f.code === 'cert-expired')?.facts.days).filter((d) => d != null).sort((x, y) => y - x);
  assert.deepEqual(a.top.certExpired.map((x) => x.days), expDays, '만료 뒤 지난 일수 큰 순(도구 판정의 일수 그대로)');
  assert.ok(expDays[0] >= 40 && expDays[1] >= 10 && expDays[1] < 40);
  assert.equal(s.status, undefined, '수집 상태(오류 원문)는 싣지 않는다');
});

test('⑤ 경로 · 용량 예측 요약 — 죽은 경로 · 한 줄 경로 · 곧 가득 · 사용률 90% 이상 합 = 원본 · mock/synthesized 표시', async () => {
  const o = (await get('/api/tools/storage-paths')).j;
  const s = (await get('/api/tools/storage-paths?summary=1')).j;
  for (const k of Object.keys(o.paths.totals)) assert.equal(sum(s.rows, (r) => r.totals[k]), o.paths.totals[k], `paths.totals.${k}`);
  for (const k of Object.keys(o.paths.coverage)) assert.equal(sum(s.rows, (r) => r.coverage[k]), o.paths.coverage[k], `paths.coverage.${k}`);
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.deepEqual(a.top.dead.map((x) => [x.name, x.dead]), [['vc-a-h2', 3]]);
  // 용량 예측 — 목(mock) 스냅샷이면 합성 증가율(synthesized)이 붙고 요약이 그 표시를 그대로 싣는다
  setSnap({ source: 'mock' });
  try {
    const fo = (await get('/api/tools/capacity-forecast')).j;
    const fs2 = (await get('/api/tools/capacity-forecast?summary=1')).j;
    assert.equal(fs2.mock, fo.mock); assert.equal(fs2.mock, true);
    assert.equal(fs2.synthesized, fo.items.some((x) => x.synthesized));
    assert.equal(sum(fs2.rows, (r) => r.datastores), fo.items.length);
    assert.equal(sum(fs2.rows, (r) => r.soon), fo.items.filter((x) => x.daysToFull != null && x.daysToFull <= fs2.thresholds.soonDays).length);
    assert.equal(sum(fs2.rows, (r) => r.fullWithin['180']), fo.items.filter((x) => x.daysToFull != null && x.daysToFull <= 180).length);
    assert.equal(sum(fs2.rows, (r) => r.high), fo.items.filter((x) => x.usagePct != null && x.usagePct >= fs2.thresholds.highPct).length);
    assert.equal(sum(fs2.rows, (r) => r.high), 2);
    assert.equal(sum(fs2.rows, (r) => r.usageUnknown), 1, '사용량 못 읽은 데이터스토어는 90% 미만이 아니라 모름');
    assert.equal(sum(fs2.rows, (r) => r.synthesized), fo.items.filter((x) => x.synthesized).length);
    for (const r of fs2.rows) assert.ok(r.top.soonest.every((x, i, arr) => i === 0 || arr[i - 1].daysToFull <= x.daysToFull));
    assert.equal(fs2.items, undefined, '항목 전체는 싣지 않는다');
  } finally { setSnap(); }
});

test('⑤ 경합 요약 — 호스트 칸(경합 · 대기 심각 VM 이 있는 호스트 · 디스크 지연 호스트 · 느린 데이터스토어) = 원본', async () => {
  const o = (await get('/api/tools/contention')).j;
  const s = (await get('/api/tools/contention?summary=1')).j;
  assert.equal(sum(s.rows, (r) => r.kpi.hostsDisk), o.kpi.hostsDisk);
  assert.equal(sum(s.rows, (r) => r.kpi.dsSlow), o.kpi.dsSlow);
  assert.equal(sum(s.rows, (r) => r.hostsContended), o.hosts.filter((h) => h.contended > 0).length);
  const crit = new Set(o.vms.filter((r) => r.findings.some((f) => f.code === 'cpu-ready-crit')).map((r) => `${r.vcenterId}|${r.host}`));
  assert.equal(sum(s.rows, (r) => r.hostsReadyCrit), crit.size);
  assert.equal(s.rows.find((r) => r.vcenterId === 'vc-a').hostsReadyCrit, 1, 'h1 에 대기 12 · 13% VM');
  assert.equal(o.thresholds.readyCrit, 10);
  const a = s.rows.find((r) => r.vcenterId === 'vc-a');
  assert.ok(a.top.hosts.length >= 1 && Array.isArray(a.top.hosts[0].neighbors), '경합이 큰 호스트 · 시끄러운 이웃');
});
