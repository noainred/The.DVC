// v2.743 감사 그룹 F — 회귀 고정.
//   VC-04 끊긴(DISCONNECTED)·무응답(NOT_RESPONDING) ESXi 호스트는 quickStats 가 없어 수집기가 cpuUsagePct·memUsagePct 를 0 으로 채운다.
//     v2.594 store.usageReadable 규칙(사용량을 못 읽은 호스트는 사용률 계산에서 뺀다)을 insights/topology.js 만 지키고
//     관계 그래프(insights/graph.js)·Prometheus /metrics·iDRAC 스캔 매칭(/idrac/:id/vcenter-host)·ChatOps 는 그 0% 를 그대로 내보냈다
//     (v2.742 VC-02 가 온도에 같은 규칙을 적용할 때 빠진 형제 누락). 이제 넷 다 null(못 읽음)이고 /metrics 는 그 시계열을 내지 않는다.
//   LEFT-07 /summary 와 공개 API /inventory/summary 의 클러스터 개수는 `${vcenterId}/${cluster}` 이름으로 세서 ① 다른 데이터센터의 같은 이름
//     클러스터를 하나로 합치고 ② 수집기가 독립 호스트에 채우는 'standalone' 을 클러스터 하나로 셌다 → clustercfg 의 묶음 키(clusterCountOf).
// 실제 함수·실제 라우터(express)를 띄워 응답으로 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743f-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.IDRAC_ENABLED = 'false';
process.env.METRICS_ALLOW_ANON = 'true';
delete process.env.METRICS_EXPORT_TOKEN;

// iDRAC 등록부: 끊긴 호스트·정상 호스트와 서비스태그로 짝지어지는 서버 두 대.
fs.writeFileSync(path.join(tmp, 'idrac.json'), JSON.stringify({ servers: [
  { id: 's-down', name: 'srv-down', host: 'https://10.1.1.21', username: 'u', password: 'x', vcenterId: 'vc1', serviceTag: 'TAGDOWN' },
  { id: 's-ok', name: 'srv-ok', host: 'https://10.1.1.22', username: 'u', password: 'x', vcenterId: 'vc1', serviceTag: 'TAGOK' },
  { id: 's-nr', name: 'srv-nr', host: 'https://10.1.1.23', username: 'u', password: 'x', vcenterId: 'vc1', serviceTag: 'TAGNR' },
] }), { mode: 0o600 });

/*
 * 스냅샷(수집기가 만드는 모양).
 *  vc1: 'Prod' 라는 이름의 클러스터가 데이터센터 둘에 하나씩(domain-c1·domain-c2) + 'Dev'(domain-c3) + 독립 호스트('standalone').
 *  vc2: 독립 호스트 하나뿐.
 *  vc3: 구버전 엣지 스냅샷처럼 clusterRef 가 없다 → 이름 키로 센다(같은 이름은 하나로 — clustercfg 의 정해진 폴백).
 *  예전 이름 셈: vc1/Prod · vc1/Dev · vc1/standalone · vc2/standalone · vc3/Web · vc3/Db = 6. 묶음 키: c1·c2·c3 + vc3 Web·Db = 5.
 */
const HOSTS = [
  { id: 'vc1:host-1', vcenterId: 'vc1', name: 'esx-ok', cluster: 'Prod', clusterRef: 'domain-c1', vcDatacenter: 'DC-A', connectionState: 'CONNECTED', serviceTag: 'TAGOK', cpuUsagePct: 70, memUsagePct: 60, cpuUsageMhz: 7000, cpuTotalMhz: 10000, memUsageMB: 600, memTotalMB: 1000, cpuCores: 16 },
  { id: 'vc1:host-2', vcenterId: 'vc1', name: 'esx-down', cluster: 'Prod', clusterRef: 'domain-c1', vcDatacenter: 'DC-A', connectionState: 'DISCONNECTED', serviceTag: 'TAGDOWN', cpuUsagePct: 0, memUsagePct: 0, cpuUsageMhz: 0, cpuTotalMhz: 10000, memUsageMB: 0, memTotalMB: 1000, cpuCores: 16 },
  { id: 'vc1:host-3', vcenterId: 'vc1', name: 'esx-nr', cluster: 'Prod', clusterRef: 'domain-c2', vcDatacenter: 'DC-B', connectionState: 'NOT_RESPONDING', serviceTag: 'TAGNR', cpuUsagePct: 0, memUsagePct: 0, cpuUsageMhz: 0, cpuTotalMhz: 10000, memUsageMB: 0, memTotalMB: 1000, cpuCores: 16 },
  { id: 'vc1:host-4', vcenterId: 'vc1', name: 'esx-dev', cluster: 'Dev', clusterRef: 'domain-c3', vcDatacenter: 'DC-B', connectionState: 'CONNECTED', cpuUsagePct: 20, memUsagePct: 30, cpuUsageMhz: 2000, cpuTotalMhz: 10000, memUsageMB: 300, memTotalMB: 1000, cpuCores: 16 },
  { id: 'vc1:host-5', vcenterId: 'vc1', name: 'esx-solo', cluster: 'standalone', connectionState: 'CONNECTED', cpuUsagePct: 10, memUsagePct: 10, cpuUsageMhz: 1000, cpuTotalMhz: 10000, memUsageMB: 100, memTotalMB: 1000, cpuCores: 16 },
  { id: 'vc2:host-1', vcenterId: 'vc2', name: 'esx-v2', cluster: 'standalone', connectionState: 'CONNECTED', cpuUsagePct: 5, memUsagePct: 5, cpuUsageMhz: 500, cpuTotalMhz: 10000, memUsageMB: 50, memTotalMB: 1000, cpuCores: 8 },
  { id: 'vc3:host-1', vcenterId: 'vc3', name: 'esx-w1', cluster: 'Web', connectionState: 'CONNECTED', cpuUsagePct: 40, memUsagePct: 40, cpuUsageMhz: 4000, cpuTotalMhz: 10000, memUsageMB: 400, memTotalMB: 1000, cpuCores: 8 },
  { id: 'vc3:host-2', vcenterId: 'vc3', name: 'esx-w2', cluster: 'Web', connectionState: 'CONNECTED', cpuUsagePct: 45, memUsagePct: 45, cpuUsageMhz: 4500, cpuTotalMhz: 10000, memUsageMB: 450, memTotalMB: 1000, cpuCores: 8 },
  { id: 'vc3:host-3', vcenterId: 'vc3', name: 'esx-d1', cluster: 'Db', connectionState: 'CONNECTED', cpuUsagePct: 50, memUsagePct: 50, cpuUsageMhz: 5000, cpuTotalMhz: 10000, memUsageMB: 500, memTotalMB: 1000, cpuCores: 8 },
];
let gen = 0;
function setSnap(store, hosts = HOSTS) {
  gen += 1;
  store.snapshot = {
    vcenters: [
      { id: 'vc1', name: 'VC1', status: 'connected', version: '8.0' },
      { id: 'vc2', name: 'VC2', status: 'connected', version: '8.0' },
      { id: 'vc3', name: 'VC3', status: 'connected', version: '7.0' },
    ],
    hosts: hosts.map((h) => ({ ...h })), vms: [], datastores: [], networks: [], alarms: [],
    generatedAt: new Date(Date.UTC(2026, 9, 16, 3, 30, gen)).toISOString(), source: 'live',
  };
}

let store, srv, base, keyPlain;
before(async () => {
  const express = (await import('express')).default;
  ({ store } = await import('../src/store.js'));
  setSnap(store);
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const { metricsExportRouter } = await import('../src/routes/metricsExport.js');
  const { insightsRouter } = await import('../src/routes/insights.js');
  const v1 = (await import('../src/routes/publicApi.js')).default;
  const keys = await import('../src/publicapi/keys.js');
  keyPlain = keys.issueApiKey({ name: 'a2743f', groups: ['inventory'] }).plaintext;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/metrics', metricsExportRouter);
  app.use('/api/v1', v1);
  app.use((req, _res, next) => { req.user = { username: 'full', role: 'admin', scope: null }; next(); });
  app.use('/api/insights', insightsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  try { srv?.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function getJson(p, headers = {}) {
  const r = await fetch(base + p, { headers });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

/* ── VC-04 ─────────────────────────────────────────────────────────────── */

test('VC-04: 관계 그래프 — 끊긴·무응답 호스트는 cpu/mem 이 0 이 아니라 null + usageUnknown, 연결된 호스트는 그대로', async () => {
  setSnap(store);
  const { buildGraph } = await import('../src/insights/graph.js');
  const g = buildGraph(store.get(), {});
  const byName = Object.fromEntries(g.nodes.filter((n) => n.type === 'host').map((n) => [n.label, n]));
  for (const nm of ['esx-down', 'esx-nr']) {
    assert.equal(byName[nm].cpu, null, `${nm} cpu 는 null 이어야 한다(받은 ${byName[nm].cpu})`);
    assert.equal(byName[nm].mem, null, `${nm} mem 는 null 이어야 한다(받은 ${byName[nm].mem})`);
    assert.equal(byName[nm].usageUnknown, true, `${nm} 는 usageUnknown 표지가 있어야 한다`);
  }
  assert.equal(byName['esx-ok'].cpu, 70);
  assert.equal(byName['esx-ok'].mem, 60);
  assert.equal(byName['esx-ok'].usageUnknown, undefined, '읽은 호스트에는 표지를 싣지 않는다');
  // 상태는 그대로 연결 상태 문자열(3D 색 판정은 status 를 본다)
  assert.equal(byName['esx-down'].status, 'DISCONNECTED');
});

test('VC-04: 관계 그래프 — 연결된 호스트의 결측 사용률(null·빈 문자열)도 0 으로 바꾸지 않는다', async () => {
  setSnap(store, [{ ...HOSTS[0], cpuUsagePct: null, memUsagePct: '' }]);
  const { buildGraph } = await import('../src/insights/graph.js');
  const n = buildGraph(store.get(), {}).nodes.find((x) => x.type === 'host');
  assert.equal(n.cpu, null);
  assert.equal(n.mem, null, `빈 문자열은 0 이 아니라 null(받은 ${JSON.stringify(n.mem)})`);
  setSnap(store);
});

test('VC-04: /api/insights/graph 응답도 같은 값(라우터 경유)', async () => {
  setSnap(store);
  const r = await getJson('/api/insights/graph');
  assert.equal(r.s, 200, r.t.slice(0, 300));
  const down = r.j.nodes.find((n) => n.label === 'esx-down');
  assert.equal(down.cpu, null);
  assert.equal(down.usageUnknown, true);
});

test('VC-04: /metrics — 끊긴·무응답 호스트의 CPU·메모리 시계열을 내지 않는다(vmware_host_up=0 은 낸다)', async () => {
  setSnap(store);
  const r = await fetch(base + '/metrics');
  assert.equal(r.status, 200);
  const txt = await r.text();
  const lines = txt.split('\n');
  const has = (metric, host) => lines.some((l) => l.startsWith(`${metric}{`) && l.includes(`host="${host}"`));
  for (const host of ['esx-down', 'esx-nr']) {
    assert.ok(!has('vmware_host_cpu_percent', host), `${host} 의 CPU 0% 시계열이 나갔다`);
    assert.ok(!has('vmware_host_mem_percent', host), `${host} 의 메모리 0% 시계열이 나갔다`);
    assert.ok(has('vmware_host_up', host), `${host} 의 vmware_host_up 은 그대로 나가야 한다(끊김을 거기서 본다)`);
  }
  const up = lines.find((l) => l.startsWith('vmware_host_up{') && l.includes('host="esx-down"'));
  assert.match(up, / 0$/);
  const okCpu = lines.find((l) => l.startsWith('vmware_host_cpu_percent{') && l.includes('host="esx-ok"'));
  assert.match(okCpu || '', / 70$/, '연결된 호스트의 CPU 는 그대로 나가야 한다');
});

test('VC-04: /admin/idrac/:id/vcenter-host — 끊긴·무응답 호스트와 매칭되면 사용률은 null(화면 —), 연결된 호스트는 값', async () => {
  setSnap(store);
  for (const id of ['s-down', 's-nr']) {
    const r = await getJson(`/api/admin/idrac/${id}/vcenter-host`);
    assert.equal(r.s, 200, r.t.slice(0, 300));
    assert.equal(r.j.matched, true, `${id} 매칭 실패: ${r.t.slice(0, 300)}`);
    assert.equal(r.j.host.cpuUsagePct, null, `${id} cpu 0% 가 그대로 나갔다`);
    assert.equal(r.j.host.memUsagePct, null, `${id} mem 0% 가 그대로 나갔다`);
    assert.notEqual(r.j.host.connectionState, 'CONNECTED');
  }
  const ok = await getJson('/api/admin/idrac/s-ok/vcenter-host');
  assert.equal(ok.j.host.cpuUsagePct, 70);
  assert.equal(ok.j.host.memUsagePct, 60);
});

test('VC-04: ChatOps 컨텍스트 — 끊긴 호스트를 CPU 0% 로 말하지 않고, 뺀 대수를 밝힌다', async () => {
  // 읽은 호스트가 5대 미만이 되도록 줄여 끊긴 호스트가 '상위 5' 에 끼어드는 경우를 만든다(예전에는 0% 로 들어갔다).
  setSnap(store, [HOSTS[0], HOSTS[1], HOSTS[2]]);
  const { chatOps } = await import('../src/llm/chatops.js');
  const r = await chatOps('현황 알려줘', null);
  assert.equal(r.source, 'fallback', 'LLM 은 꺼져 있어야 한다(설정 없음)');
  assert.ok(!/esx-down/.test(r.answer), `끊긴 호스트가 CPU 상위 목록에 들어갔다: ${r.answer}`);
  assert.ok(!/esx-nr/.test(r.answer), `무응답 호스트가 CPU 상위 목록에 들어갔다: ${r.answer}`);
  assert.ok(!/CPU 0%/.test(r.answer), `CPU 0% 가 남았다: ${r.answer}`);
  assert.match(r.answer, /esx-ok\(CPU 70%\/MEM 60%\)/);
  assert.match(r.answer, /사용량을 읽지 못한 호스트 2대 제외/);
  // 읽은 호스트의 결측 값은 0% 가 아니라 —
  setSnap(store, [{ ...HOSTS[0], memUsagePct: null }]);
  const r2 = await chatOps('현황', null);
  assert.match(r2.answer, /esx-ok\(CPU 70%\/MEM —\)/);
  assert.ok(!/사용량을 읽지 못한 호스트/.test(r2.answer), '뺀 호스트가 없으면 문구를 붙이지 않는다');
  setSnap(store);
});

test('VC-04: 3D 토폴로지 툴팁 — 호스트 CPU 가 null 이면 0% 가 아니라 —', () => {
  // ⚠ 이 툴팁은 3d-force-graph 가 innerHTML 로 그리는 인라인 템플릿이라 함수로 꺼내 부를 수 없다 — 소스 검사(최후 수단).
  const src = stripComments(fs.readFileSync(path.join(HERE, '../../web/src/views/Topology3D.jsx'), 'utf8'));
  const line = src.split('\n').find((l) => l.includes('.nodeLabel('));
  assert.ok(line, 'nodeLabel 줄을 찾지 못했다');
  assert.match(line, /n\.cpu != null \? ` · CPU \$\{Number\(n\.cpu\)\}%` : n\.type === 'host' \? ` · CPU —/, `호스트 null CPU 의 '—' 분기가 없다: ${line}`);
  assert.match(line, /usageUnknown/, 'usageUnknown 표지를 툴팁이 읽지 않는다');
});

/* ── LEFT-07 ───────────────────────────────────────────────────────────── */

test('LEFT-07: clusterCountOf — 같은 이름 다른 클러스터는 따로, standalone·빈 값은 세지 않는다, ref 없는 vCenter 는 이름 키', async () => {
  const { clusterCountOf } = await import('../src/clustercfg/analyze.js');
  assert.equal(clusterCountOf(HOSTS), 5);
  assert.equal(clusterCountOf(HOSTS.filter((h) => h.vcenterId === 'vc1')), 3, 'vc1: Prod(c1)·Prod(c2)·Dev(c3)');
  assert.equal(clusterCountOf(HOSTS.filter((h) => h.vcenterId === 'vc2')), 0, '독립 호스트뿐이면 0');
  assert.equal(clusterCountOf(HOSTS.filter((h) => h.vcenterId === 'vc3')), 2, 'ref 없음: Web·Db');
  assert.equal(clusterCountOf([{ vcenterId: 'x', cluster: '' }, { vcenterId: 'x' }, null]), 0);
  assert.equal(clusterCountOf(null), 0);
  // 한 호스트라도 ref 가 없는 vCenter 는 이름 키로 떨어진다(clustercfg/analyze.js 의 정해진 폴백 — 같은 이름은 하나).
  const mixed = [
    { vcenterId: 'm', cluster: 'Prod', clusterRef: 'domain-c1' },
    { vcenterId: 'm', cluster: 'Prod' },
  ];
  assert.equal(clusterCountOf(mixed), 1);
});

test('LEFT-07: 내부 /summary 와 공개 API /inventory/summary 가 같은 클러스터 개수(묶음 키)를 준다', async () => {
  setSnap(store);
  const s = await getJson('/api/summary');
  assert.equal(s.s, 200, s.t.slice(0, 300));
  const p = await getJson('/api/v1/inventory/summary', { 'X-Api-Key': keyPlain });
  assert.equal(p.s, 200, p.t.slice(0, 300));
  assert.equal(s.j.counts.clusters, 5, `내부 /summary 클러스터 수(예전 이름 셈은 6): ${s.j.counts.clusters}`);
  assert.equal(p.j.data.clusters, 5, `공개 API 클러스터 수(예전 이름 셈은 6): ${p.j.data.clusters}`);
  // vCenter 로 좁힌 요약도 같은 규칙
  const one = await getJson('/api/summary?vcenterId=vc2');
  assert.equal(one.j.counts.clusters, 0, '독립 호스트만 있는 vCenter 는 클러스터 0');
});
