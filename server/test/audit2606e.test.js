// v2.606 수정 그룹 e — 웹·설정 빈 칸·표시(서버 쪽 단언). 웹 판정·문구는 web/src/views/audit2606e.test.js(vitest).
// 감사 입력: scratchpad/audit2606/web.json · recent.json. 각 절은 재현 입력으로 수정 전 실패·수정 후 통과한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2606e-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';

const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

const admin = { username: 'admin', role: 'admin', scope: null };
async function serve(register) {
  const express = (await import('express')).default;
  const router = express.Router();
  register(router);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = admin; next(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(r)));
  return `http://127.0.0.1:${srv.address().port}/api`;
}

// 100GHz·100GB 호스트 3대 — 2대는 80 사용, 1대는 끊김(SOAP 이 사용량 0 을 싣는다).
const H = (id, state, cpuUse, memUse) => ({
  id: `vcA:${id}`, name: id, vcenterId: 'vcA', cluster: 'CL1', connectionState: state, cpuCores: 32,
  cpuTotalMhz: 100_000, cpuUsageMhz: cpuUse, memTotalMB: 102_400, memUsageMB: memUse,
  cpuUsagePct: state === 'CONNECTED' ? 80 : 0, memUsagePct: state === 'CONNECTED' ? 80 : 0,
});
const HOSTS = [H('esx1', 'CONNECTED', 80_000, 81_920), H('esx2', 'CONNECTED', 80_000, 81_920), H('esx3', 'DISCONNECTED', 0, 0)];
const snapOf = (gen) => ({
  source: 'live', generatedAt: gen, vcenters: [{ id: 'vcA', name: 'A' }], hosts: HOSTS, vms: [],
  datastores: [], networks: [], alarms: [], collectionErrors: [],
});

/* ───────── WEB2606-02 ① 비교 매트릭스 클러스터 셀 ───────── */
test('WEB2606-02 compareMatrix: 끊긴 호스트는 사용률 분자·분모에서 빠지고 뺀 대수를 싣는다', async () => {
  const { clusterMatrix } = await import('../src/tools/compareMatrix.js');
  const m = clusterMatrix({ vcenters: [{ id: 'vcA', name: 'A' }], hosts: HOSTS, vms: [] });
  const cell = m.rows[0].cells.vcA;
  assert.equal(cell.cpuUsagePct, 80, '예전: 53.3(끊긴 호스트 총량이 분모에 들어갔다)');
  assert.equal(cell.memUsagePct, 80);
  assert.equal(cell.hostsUsageExcluded, 1);
  assert.equal(cell.hosts, 3, '호스트 수·용량 합계에는 남는다');
  assert.equal(cell.cpuTotalGhz, 300);
  // 전부 끊기면 사용률은 null('—') — 0% 가 아니다
  const all = clusterMatrix({ vcenters: [{ id: 'vcA' }], hosts: [H('x', 'NOT_RESPONDING', 0, 0)], vms: [] });
  assert.equal(all.rows[0].cells.vcA.cpuUsagePct, null);
});

/* ───────── WEB2606-02 ② 인사이트 N+1 ───────── */
test('WEB2606-02 /tools/insights N+1: 끊긴 호스트를 장애 후 잔여 용량에 넣지 않는다', async () => {
  const { registerToolsAnalytics } = await import('../src/routes/api/toolsAnalytics.js');
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = snapOf('2026-09-24T01:00:00.000Z');
  try {
    const base = await serve(registerToolsAnalytics);
    const r = await fetch(`${base}/tools/insights`);
    assert.equal(r.status, 200);
    const c = (await r.json()).clusters.find((x) => x.cluster === 'CL1');
    assert.equal(c.hostsUsageExcluded, 1);
    assert.equal(c.cpuUsagePct, 80, '예전 53');
    assert.equal(c.cpuAfterFailPct, 160, '가용 2대 중 1대 장애 → 잔여 100GHz 에 160GHz(예전: 잔여 200GHz 로 80)');
    assert.equal(c.n1Ok, false, '예전 true — 끊긴 호스트 용량을 여유로 셌다');
    assert.equal(c.hosts, 3);
  } finally { store.snapshot = prev; }
});

/* ───────── WEB2606-02 ③ 용량 도구 클러스터 ───────── */
test('WEB2606-02 /tools/capacity: 클러스터 사용률은 읽은 호스트만, 뺀 대수를 싣는다', async () => {
  const { registerToolsCapacity } = await import('../src/routes/api/toolsCapacity.js');
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = snapOf('2026-09-24T01:01:00.000Z');
  try {
    const base = await serve(registerToolsCapacity);
    const r = await fetch(`${base}/tools/capacity`);
    assert.equal(r.status, 200);
    const body = await r.json();
    const c = body.clusters.find((x) => x.cluster === 'CL1');
    assert.equal(c.cpuUsedPct, 80, '예전 53');
    assert.equal(c.memUsedPct, 80);
    assert.equal(c.hostsUsageExcluded, 1);
    assert.equal(c.memTotalGB, 300, '용량 합계는 전 호스트');
    assert.equal(body.totals.hostsUsageExcluded, 1);
  } finally { store.snapshot = prev; }
});

/* ───────── WEB2606-04 프록시 포트 ───────── */
test('WEB2606-04 proxy/registry: 포트는 1~65535 정수, 빈 값·범위 밖은 이전 값 유지', async () => {
  const reg = await import('../src/proxy/registry.js');
  reg.saveConfig({ publicPortBase: 21000, guacd: { host: 'g', port: 4900 }, deploy: { host: '10.0.0.9', port: 2222, username: 'root', password: 'pw' } });
  reg.saveConfig({ publicPortBase: '', guacd: { port: '' }, deploy: { port: '' } });
  let c = reg.getConfig();
  assert.equal(c.deploy.port, 2222, "예전 '' 저장(사용 지점에서 조용히 22)");
  assert.equal(c.guacd.port, 4900);
  assert.equal(c.publicPortBase, 21000);
  assert.equal(c.deploy.password, 'pw', '빈 포트 칸이 접속처 변경으로 읽혀 비밀이 버려지면 안 된다');
  reg.saveConfig({ publicPortBase: 0, guacd: { port: 0 }, deploy: { port: 99999 } });
  c = reg.getConfig();
  assert.equal(c.deploy.port, 2222, '예전 99999');
  assert.equal(c.guacd.port, 4900, '예전 0');
  assert.equal(c.publicPortBase, 21000, '예전 0');
  reg.saveConfig({ deploy: { port: '2200' } });
  assert.equal(reg.getConfig().deploy.port, 2200, '숫자 문자열은 값이다');
  // 추가 프록시
  const a = reg.saveProxy({ name: 'P1', publicPortBase: 22000, deploy: { host: '10.0.0.8', port: 2022 }, guacd: { port: 4823 } });
  assert.equal(a.ok, true);
  const b = reg.saveProxy({ id: a.proxy.id, publicPortBase: '', deploy: { port: '' }, guacd: { port: 'abc' } });
  assert.equal(b.proxy.deploy.port, 2022, "예전 ''");
  assert.equal(b.proxy.guacd.port, 4823);
  assert.equal(b.proxy.publicPortBase, 22000);
  assert.equal(reg.portOrPrev(undefined, 7), 7);
  assert.equal(reg.portOrPrev('65535', 7), 65535);
  assert.equal(reg.portOrPrev(1.5, 7), 7);
});

/* ───────── WEB2606-10 중계 토폴로지 ───────── */
test('WEB2606-10 relaytopo: 버린 서비스 행을 응답에 싣고, 빈 Main·SSH 포트는 이전 값을 잇는다', async () => {
  const store = await import('../src/relaytopo/store.js');
  const n = store.normalizeTopology({ services: [
    { key: 'portal', label: '포탈', listenPort: '', target: 'irs', targetPort: 4000 },
    { key: 'ssh', label: 'SSH', listenPort: 4067, target: 'irs', targetPort: 22 },
    { key: 'dup', label: '중복', listenPort: 4067, target: 'irs', targetPort: 23 },
  ] });
  assert.deepEqual(n.services.map((s) => s.key), ['ssh']);
  assert.deepEqual((n.servicesDropped || []).map((d) => `${d.key}:${d.reason}`), ['portal:listen-port', 'dup:duplicate-port'], '예전: 버린 개수 없음');
  assert.equal(Object.keys(n).includes('servicesDropped'), false, '비열거 — 저장 파일에 남지 않는다');

  const prev = { main: { portalPort: 4100, ssh: { port: 2201 } }, services: [], sites: [] };
  const m = store.normalizeTopology({ main: { portalPort: '', ssh: { port: '' } } }, prev);
  assert.equal(m.main.portalPort, 4100, '예전 4000(기본값으로 튐)');
  assert.equal(m.main.ssh.port, 2201, '예전 22');

  const { registerRelayTopo } = await import('../src/routes/api/relaytopo.js');
  const base = await serve(registerRelayTopo);
  const r = await fetch(`${base}/tools/relaytopo`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ main: { name: 'M' }, services: [{ key: 'portal', label: '포탈', target: 'irs', targetPort: 4000 }, { key: 'ssh', label: 'SSH', listenPort: 4067, target: 'irs', targetPort: 22 }], sites: [] }),
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.servicesDropped.map((d) => d.key), ['portal'], '예전: 응답에 없음(행이 말없이 사라졌다)');
  assert.equal(body.servicesReset, false);
  assert.deepEqual(body.topology.services.map((s) => s.key), ['ssh']);
});
