/**
 * v2.605 감사 그룹 a — 중앙 수신·전력·RMA 회귀.
 *
 * CEN2605-01 /inventory 수치 필드 좁힘 · CEN2605-02 파트 장애 보고 엣지 수 상한 + partId 길이 상한 ·
 * CEN2605-03 원격 전력 키에 수집 서버(법인) 축 · CEN2605-04 SAN 사용량 상태 admitAgent ·
 * CEN2605-05/TIM2605-03 RMA 하트비트 상한·정리 · RECENT2605-02 edge-log-result 등록부 이름 + acked ·
 * EDGE2605-03 즉시 당김 상태 필드 · DB2605-02 전력 서버 삭제 청크·양보 · TIM2605-05 거부 로그 스로틀 맵 상한.
 * 전부 실제 함수·실제 라우터를 호출해 동작으로 본다(기준 시각은 고정값 T0 — Date.now() 를 기준으로 쓰지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2605a-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2605a', DATA_SOURCE: 'live', AUTH_ENABLED: 'true',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true', CENTRAL_EDGE_MAX_AGENTS: '8', PRUNE_CHUNK_ROWS: '500',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
// RECENT2605-02: 자기등록 검증에 실패한(중앙이 닿지 못하는) 공유 토큰 엣지.
fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [
  { id: 'site-b', name: 'site-b', url: 'http://127.0.0.1:1', token: 'x', enabled: true, selfRegUnverified: true },
] }));

const express = (await import('express')).default;
const { centralRouter } = await import('../src/routes/central.js');
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/api/central', centralRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/central`;
test.after(() => srv.close());
const H = { 'Content-Type': 'application/json', 'X-Central-Token': 'shared-2605a' };
const T0 = 1_780_000_000_000;

test('CEN2605-01: /inventory 의 글자 수치는 수로, 수가 아닌 값은 null 로 좁혀 저장한다(문자열 이어붙이기 방지)', async () => {
  const body = {
    agent: 'edge-inv', vcenterId: 'vc-2605a', vcenter: { name: 'vc-2605a', status: 'ok' },
    hosts: [
      { id: 'h1', name: 'esx-a', cpuCores: 16, cpuTotalMhz: 40000, cpuUsageMhz: 10000, memTotalMB: 256000, memUsageMB: 1000 },
      { id: 'h2', name: 'esx-b', cpuCores: '16', cpuTotalMhz: '40000', cpuUsageMhz: '10000', memTotalMB: { toString: 1 }, memUsageMB: 'abc' },
    ],
    datastores: [{ id: 'ds1', name: 'ds1', capacityGB: '1000', freeGB: '400' }],
    vms: [{ id: 'vm1', name: 'vm1', cpuCount: '4', memMB: [8] }],
  };
  const r = await fetch(`${base}/inventory`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const { getInventory } = await import('../src/central/inventory.js');
  const inv = getInventory('vc-2605a').data;
  const h2 = inv.hosts.find((h) => h.id === 'h2');
  assert.equal(h2.cpuCores, 16);
  assert.equal(h2.cpuTotalMhz, 40000);
  assert.equal(h2.memTotalMB, null);
  assert.equal(h2.memUsageMB, null);
  assert.equal(inv.datastores[0].capacityGB, 1000);
  assert.equal(inv.vms[0].cpuCount, 4);
  assert.equal(inv.vms[0].memMB, null);
  // 합산이 문자열 연결이 되지 않는다(수정 전 '1616').
  const cores = inv.hosts.reduce((a, h) => a + (h.cpuCores || 0), 0);
  assert.equal(cores, 32);
  assert.ok(j.dropped && j.dropped.coerced >= 7, `coerced 를 밝힌다: ${JSON.stringify(j.dropped)}`);
});

test('CEN2605-02: 파트 장애 보고는 엣지 수 상한(admitAgent)을 따르고, 긴 partId 는 버리며 그 장비를 닫지 않는 쪽으로 둔다', async () => {
  const pf = await import('../src/central/partFaultEdge.js');
  pf._resetForTest(async () => ({ storage: new Set(), sanswitch: new Set() }));
  const dev = (tails) => ({ v: 2, devices: [{ scope: 'idrac', deviceId: 'srv1', ok: true, states: { ok: tails } }] });
  for (let i = 0; i < 8; i++) assert.equal((await pf.putEdgeReport(`edge-${i}`, dev(['psu:PSU1']))).ok, true);
  const refused = await pf.putEdgeReport('edge-fake', dev(['psu:PSU1']));
  assert.equal(refused.ok, false, '모두 최근이면 새 이름은 거절한다(수정 전: 무한히 쌓였다)');
  assert.equal(refused.refused, true);
  assert.equal(pf.edgeReports().length, 8);
  // 이미 있는 이름은 계속 받는다.
  assert.equal((await pf.putEdgeReport('edge-3', dev(['psu:PSU2']))).ok, true);
  // partId 길이 상한 — 자르지 않고 빼며, 장비를 ok:false(parts-capped)로.
  const long = 'x'.repeat(4000);
  const r = await pf.putEdgeReport('edge-3', dev(['psu:PSU1', `psu:${long}`]));
  assert.equal(r.partsOmitted, 1);
  const d = pf.edgeReport('edge-3').devices[0];
  assert.equal(d.parts.length, 1);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'parts-capped');
  // 라우트: 상한 거절은 429.
  const rr = await fetch(`${base}/part-faults`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'edge-new', ...dev(['psu:PSU1']) }) });
  assert.equal(rr.status, 429);
});

test('CEN2605-03: 두 수집 서버가 같은 호스트명을 보고해도 서로 지우지 않고, 호스트명 보기는 ts 최신이 이긴다', async () => {
  const st = await import('../src/collector/state.js');
  const svc = await import('../src/idrac/service.js');
  const now = Date.now(); // 신선도 컷(2시간) 안의 값이 필요하다 — 판정 기준이 아니라 표본 시각이다
  st.setRemoteHost('esx01', { watts: 300, ts: now - 1000, collectorId: 'edgeA', serverName: 'esx01', serverId: 1 });
  st.setRemoteHost('esx01', { watts: 900, ts: now - 2000, collectorId: 'edgeB', serverName: 'esx01', serverId: 1 });
  assert.equal(st.remotePowerEntries().filter((x) => x.host === 'esx01').length, 2, '수정 전: 나중 것이 앞의 것을 덮었다');
  assert.equal(st.remotePowerByHost().get('esx01').collectorId, 'edgeA', '호스트명 보기는 ts 최신');
  assert.deepEqual(st.remoteHostConflicts().map((x) => [x.host, x.collectors.sort()]), [['esx01', ['edgeA', 'edgeB']]]);
  const measured = (await svc.allMeasuredPower()).filter((m) => m.source === 'remote' && m.host === 'esx01');
  assert.equal(measured.length, 2, '두 법인 서버를 모두 센다');
  assert.equal(measured.reduce((a, m) => a + m.watts, 0), 1200);
  st.clearCollectorHosts('edgeA'); st.clearCollectorHosts('edgeB');
});

async function edgeServer(payload) {
  const ea = express();
  ea.get('/api/collector/export', (_q, s) => s.json(payload));
  const s = await new Promise((r) => { const x = ea.listen(0, '127.0.0.1', () => r(x)); });
  test.after(() => s.close());
  return `http://127.0.0.1:${s.address().port}`;
}

test('CEN2605-03(pull) + EDGE2605-03: 같은 호스트명은 수집 서버별 DB 키로 나누고, 즉시 당김도 주기 pull 과 같은 상태 필드를 싣는다', async () => {
  const { addCollector } = await import('../src/collector/registry.js');
  const puller = await import('../src/collector/puller.js');
  const st = await import('../src/collector/state.js');
  const now = Date.now();
  const urlA = await edgeServer({ version: '2.605.0', agent: 'pa', datacenter: 'A', mock: true, authDeny: { count: 3, lastWhy: '토큰 불일치' }, power: { byHost: [{ host: 'esx-dup', watts: 300, ts: now - 5000, serverId: 7 }, { host: 'esx-only-a', watts: 100, ts: now - 5000, serverId: 8 }] } });
  const urlB = await edgeServer({ version: '2.605.0', agent: 'pb', datacenter: 'B', power: { byHost: [{ host: 'esx-dup', watts: 900, ts: now - 6000, serverId: 7 }] } });
  addCollector({ id: 'pa', name: 'pa', url: urlA, token: 't', enabled: true });
  addCollector({ id: 'pb', name: 'pb', url: urlB, token: 't', enabled: true });
  assert.equal(await puller.pullCollectorByAgent('pa'), true);
  const sa = st.getCollectorStatus('pa');
  assert.equal(sa.mock, true, '즉시 당김도 mock 을 싣는다(수정 전: 키 없음)');
  assert.equal(sa.authDeny?.count, 3);
  assert.ok('serversCoerced' in sa && 'serversDropped' in sa);
  assert.equal(await puller.pullCollectorByAgent('pb'), true);
  const entries = st.remotePowerEntries().filter((x) => x.host === 'esx-dup');
  assert.equal(entries.length, 2);
  const b = entries.find((x) => x.collectorId === 'pb');
  assert.equal(b.dbKey, 'rmt:pb:esx-dup', '충돌 호스트는 법인 축 키');
  assert.deepEqual(st.getCollectorStatus('pb').hostConflicts, ['esx-dup']);
  const onlyA = st.remotePowerEntries().find((x) => x.host === 'esx-only-a');
  assert.equal(onlyA.dbKey, 'rmt:esx-only-a', '충돌 없는 호스트는 예전 키 그대로(이력 연속성)');
  const { getDb } = await import('../src/idrac/db.js');
  const db = await getDb();
  assert.equal(db.latest('rmt:pb:esx-dup')?.watts, 900);
  assert.equal(db.latest('rmt:esx-dup')?.watts, 300, 'A 의 첫 pull(충돌 전)은 예전 키에 적재됐다');
});

test('CEN2605-04: SAN 사용량 상태는 새 이름이 최근 실제 엣지 행을 밀어내지 못하고, 위임 0대 공유 토큰 이름은 저장하지 않는다', async () => {
  const pe = await import('../src/central/sanSwitchPerfEdge.js');
  pe.saveEdgePerfStatus('edge-real', { enabled: true, at: T0, devices: [] });
  let refused = 0;
  for (let i = 0; i < 200; i++) if (pe.saveEdgePerfStatus(`fake-${i}`, { enabled: true }).refused) refused++;
  assert.ok(pe.listEdgePerfStatus().some((x) => x.agent === 'edge-real'), '수정 전: 삽입순으로 밀려났다');
  assert.ok(refused >= 1);
  assert.ok(pe.listEdgePerfStatus().length <= 200);
  const r = await fetch(`${base}/sanswitch-perf`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'ghost-perf', rows: [], status: { enabled: true } }) });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.statusIgnored, 'no-delegated-devices');
  assert.ok(!pe.listEdgePerfStatus().some((x) => x.agent === 'ghost-perf'));
});

test('CEN2605-05/TIM2605-03: RMA 하트비트는 원소 길이·인스턴스 수에 상한이 있고 오래된 항목은 정리된다', async () => {
  const jobs = await import('../src/rma/jobs.js');
  jobs._resetRma();
  const realNow = Date.now;
  let now = T0;
  Date.now = () => now;
  try {
    const info = { policy: { enabled: Array.from({ length: 200 }, () => 'y'.repeat(4000)) } };
    for (let i = 0; i < 40; i++) jobs.noteHeartbeat('edge-rma', `i${i}`, info);
    const g = jobs.listRmaAgents(now).find((x) => x.agent === 'edge-rma');
    assert.equal(g.instances.length, jobs.HEARTBEAT_MAX_INSTANCES, '수정 전: 40개 전부 상주');
    assert.ok(g.instances.every((x) => x.policy.enabled.every((e) => e.length <= 200)), '원소 글자 상한');
    // 온라인 인스턴스는 밀어내지 않는다 — 새 이름 거절.
    assert.equal(jobs.noteHeartbeat('edge-rma', 'late', info).refused, true);
    // 오프라인이 되면 새 이름이 가장 오래된 것을 대신한다.
    now += jobs.HEARTBEAT_STALE_MS + 1;
    assert.equal(jobs.noteHeartbeat('edge-rma', 'late', info).ok, true);
    assert.equal(jobs.listRmaAgents(now).find((x) => x.agent === 'edge-rma').instances.length, jobs.HEARTBEAT_MAX_INSTANCES);
    // 오래 무응답 항목 정리.
    now += jobs.HEARTBEAT_PURGE_MS + 120_000;
    jobs.noteHeartbeat('edge-other', 'a', {});
    assert.equal(jobs.listRmaAgents(now).find((x) => x.agent === 'edge-rma'), undefined);
  } finally { Date.now = realNow; jobs._resetRma(); }
});

test('RECENT2605-02: 등록부에 있는 미검증 공유 토큰 엣지도 중앙이 요청해 둔(acked) 로그 회신은 받는다', async () => {
  const { enqueueEdgeLogJob } = await import('../src/central/edgeLogJobs.js');
  enqueueEdgeLogJob('site-b', {});
  const j = await (await fetch(`${base}/edge-log-jobs?agent=site-b`, { headers: H })).json();
  assert.ok(j.job, '작업 인출은 된다');
  const r = await fetch(`${base}/edge-log-result?agent=site-b`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'site-b', logs: { lines: [] } }) });
  const rj = await r.json();
  assert.equal(r.status, 200, `수정 전 403: ${JSON.stringify(rj)}`);
  assert.equal(rj.stored, true);
  // 요청하지 않은 회신은 여전히 보관하지 않는다.
  const r2 = await fetch(`${base}/edge-log-result?agent=site-b`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'site-b', logs: { lines: [] } }) });
  assert.equal((await r2.json()).stored, false);
  // 등록부에 없는 이름은 403 그대로.
  const r3 = await fetch(`${base}/edge-log-result?agent=ghost-log`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'ghost-log' }) });
  assert.equal(r3.status, 403);
});

test('DB2605-02: 전력 서버 삭제는 비동기·청크로 돌며 그 사이 이벤트 루프가 돈다', async () => {
  const { getDb } = await import('../src/idrac/db.js');
  const db = await getDb();
  assert.equal(db.kind, 'sqlite');
  for (const id of ['vc:del-1', 'vc:del-2', 'vc:del-3']) {
    const samples = [];
    for (let i = 0; i < 2000; i++) samples.push({ serverId: id, watts: 100 + (i % 50) * 10, ts: T0 + i * 60_000 });
    db.insertMany(samples);
  }
  assert.ok(db.serverIds().includes('vc:del-2'));
  let ticks = 0;
  let stop = false;
  const spin = () => { if (stop) return; ticks++; setImmediate(spin); };
  setImmediate(spin);
  const p = db.deleteServers(['vc:del-1', 'vc:del-2', 'vc:del-3']);
  assert.ok(p instanceof Promise, '수정 전: 동기 한 트랜잭션');
  const n = await p;
  stop = true;
  assert.ok(n > 0);
  assert.ok(ticks >= 3, `청크 사이 양보(ticks=${ticks})`);
  assert.ok(!db.serverIds().some((x) => x.startsWith('vc:del-')));
  assert.equal(db.latest('vc:del-1'), null);
  // purgeStalePower(mode=all)도 await 로 끝까지 지운다.
  db.insertMany([{ serverId: 'vc:orphan-x', watts: 50, ts: T0 }]);
  const { purgeStalePower } = await import('../src/idrac/service.js');
  const pr = await purgeStalePower({ mode: 'all' });
  assert.ok(pr.dbRemoved >= 1);
  assert.ok(!db.serverIds().includes('vc:orphan-x'));
});

test('TIM2605-05: 수집 토큰 거부 로그 스로틀 맵은 출처 수만큼 무한히 자라지 않는다', async () => {
  const dl = await import('../src/collector/denyLog.js');
  dl._resetCollectorDenyStats();
  const orig = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < 6000; i++) {
      const ip = `2001:db8::${i.toString(16)}`;
      dl.logCollectorDeny({ ip, socket: {}, get: () => '' }, 'ping');
    }
  } finally { console.warn = orig; }
  assert.ok(dl._denyLogKeyCount() <= dl.DENY_LOG_KEYS_MAX, `수정 전: 6000개(${dl._denyLogKeyCount()})`);
  assert.equal(dl.getCollectorDenyStats().count, 6000, '통계는 그대로');
  dl._resetCollectorDenyStats();
});
