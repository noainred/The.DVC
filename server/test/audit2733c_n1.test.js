/**
 * v2.733 점검 3회차 그룹 c — C2-04: 클러스터 N+1 판정(운영 인사이트 ④)이
 *   ① 유지보수(MAINTENANCE) 호스트를 '1대 장애 후 잔여 용량' 에 넣었다 — 유지보수 호스트는 VM 을 받을 수 없다. 재현: 3대 클러스터 중
 *      1대가 유지보수면 실제는 가용 2대 중 1대 장애 시 160% 인데 화면은 80%·'여유'.
 *   ② 클러스터가 없는 독립 호스트들을 `vc|standalone` 한 그룹으로 묶어 'N+1 여유' 로 판정했다 — 서로 장애를 받아 줄 수 없다(HA 없음).
 * 규칙: 유지보수 호스트는 N+1 용량에서 빼고 `maintenance` 개수로 밝힌다(현재 사용률은 usageReadable 그대로). 독립 호스트 그룹은
 *   `n1Ok: null`(판정 대상 아님) + `standalone: true` + 장애 후 값 null.
 *
 * ⚠ 실제 registerToolsAnalytics 라우터를 띄워 응답 값으로 본다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'a2733c-n1-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'false';
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* 정리 실패는 결과와 무관 */ } });

const H = (id, cl, state, cpuUse, memUse, cap = 100_000) => ({ id: `vcA:${id}`, name: id, vcenterId: 'vcA', cluster: cl, connectionState: state, cpuCores: 32,
  cpuTotalMhz: cap, cpuUsageMhz: cpuUse, memTotalMB: 102_400, memUsageMB: memUse });

async function insights(hosts) {
  const { registerToolsAnalytics } = await import('../src/routes/api/toolsAnalytics.js');
  const { store } = await import('../src/store.js');
  store.snapshot = { source: 'live', generatedAt: new Date(Date.now() + Math.random() * 1000).toISOString(), vcenters: [{ id: 'vcA', name: 'A', status: 'connected' }],
    hosts, vms: [], datastores: [], networks: [], alarms: [], collectionErrors: [] };
  const router = express.Router(); registerToolsAnalytics(router);
  const app = express();
  app.use((req, _r, n) => { req.user = { username: 'admin', role: 'admin', scope: null }; n(); });
  app.use('/api', router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/insights?_=${Math.random()}`);
    assert.equal(res.status, 200);
    return (await res.json()).clusters;
  } finally { srv.close(); }
}
const byName = (cl, name) => cl.find((c) => c.cluster === name);

test('C2-04 ① 유지보수 호스트는 장애 후 잔여 용량에서 빠진다 — 80%·여유 → 160%·위험, 개수로 밝힌다', async () => {
  const cl = await insights([
    H('esx1', 'CL1', 'CONNECTED', 80_000, 81_920), H('esx2', 'CL1', 'CONNECTED', 80_000, 81_920), H('esx3', 'CL1', 'MAINTENANCE', 0, 0),
  ]);
  const c = byName(cl, 'CL1');
  assert.ok(c, JSON.stringify(cl));
  assert.equal(c.hosts, 3);
  assert.equal(c.maintenance, 1, '유지보수 호스트 개수를 밝힌다');
  assert.equal(c.cpuAfterFailPct, 160, `유지보수 호스트를 잔여 용량에 넣었다: ${c.cpuAfterFailPct}`);
  assert.equal(c.memAfterFailPct, 160);
  assert.equal(c.n1Ok, false);
  assert.equal(c.standalone, false);
  // 현재 사용률은 usageReadable 기준 그대로(유지보수 호스트도 읽힌 값이다 — 사용률 판정은 바꾸지 않는다)
  assert.equal(c.cpuUsagePct, 53);
});

test('C2-04 ① 유지보수 호스트가 VM 을 아직 들고 있으면 그 부하도 남은 호스트가 받아야 한다', async () => {
  const cl = await insights([
    H('a1', 'CL2', 'CONNECTED', 20_000, 20_480), H('a2', 'CL2', 'CONNECTED', 20_000, 20_480), H('a3', 'CL2', 'CONNECTED', 20_000, 20_480),
    H('a4', 'CL2', 'MAINTENANCE', 30_000, 30_720),   // 진입 중 — 아직 VM 이 남아 있다
  ]);
  const c = byName(cl, 'CL2');
  // 가용 3대(300,000) − 가장 큰 1대(100,000) = 200,000, 사용 합 90,000 → 45%
  assert.equal(c.cpuAfterFailPct, 45);
  assert.equal(c.n1Ok, true);
  assert.equal(c.maintenance, 1);
});

test('C2-04 ① 가용 호스트가 1대만 남으면 위험(장애를 받아 줄 호스트가 없다)', async () => {
  const cl = await insights([H('b1', 'CL3', 'CONNECTED', 10_000, 10_240), H('b2', 'CL3', 'MAINTENANCE', 0, 0)]);
  const c = byName(cl, 'CL3');
  assert.equal(c.n1Ok, false);
  assert.equal(c.maintenance, 1);
});

test('C2-04 ② 클러스터 없는 독립 호스트는 한 그룹으로 판정하지 않는다 — n1Ok null · standalone · 장애 후 값 null', async () => {
  const cl = await insights([
    H('sa1', '', 'CONNECTED', 30_000, 30_000), H('sa2', 'standalone', 'CONNECTED', 30_000, 30_000), H('sa3', null, 'CONNECTED', 30_000, 30_000),
    H('esx1', 'CL1', 'CONNECTED', 30_000, 30_720), H('esx2', 'CL1', 'CONNECTED', 30_000, 30_720),
  ]);
  const s = byName(cl, 'standalone');
  assert.ok(s, JSON.stringify(cl));
  assert.equal(s.n1Ok, null, `독립 호스트 그룹을 '여유/위험' 으로 판정했다: ${s.n1Ok}`);
  assert.equal(s.standalone, true);
  assert.equal(s.cpuAfterFailPct, null);
  assert.equal(s.memAfterFailPct, null);
  assert.equal(s.hosts, 3);
  assert.equal(s.clusterUnknown, 2, "클러스터 값이 빈 호스트(REST 폴백은 소속을 모른다)는 '독립' 으로 단정하지 않고 센다");
  assert.equal(s.cpuUsagePct, 30, '현재 사용률은 그대로 보인다');
  // 정렬 — 위험(false) → 여유(true) → 판정 안 함(null)
  assert.equal(cl.at(-1).cluster, 'standalone');
  assert.equal(byName(cl, 'CL1').n1Ok, true);
});
