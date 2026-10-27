/**
 * v2.785(점검 GV) — 실제 라우터·함수로 본다(소스 grep 은 계약 고정용 보조만).
 *  ① D-B2 VM 상세 이력(/tools/vm-changes/of): 서버가 '지연 없음' 을 판정했으면 lagging=false — 예전에는 [] 와 판정 실패(null)를
 *     같은 null 로 보내 웹이 마지막 이벤트 2일 기준으로 대신 판단했다 → 조용한 vCenter(수집 정상·이벤트 드묾)의 모든 VM 에 거짓
 *     '수집 지연·정지'. 판정하지 못했으면(mock — 판정 대상 없음) 여전히 null(웹이 lastTs 로 대신). 수집하지 않는 vCenter 는 notCollected.
 *  ② P-B4 /insights/finops?vcenterId=X (전체 범위 계정): 고른 vCenter 에 귀속되지 않는 서버 전력을 '(미매핑)' 으로 합산했다(전 함대 전력).
 *     형제 /power-breakdown 과 같은 뜻 — vCenter 를 고르면 귀속된 서버만. 고르지 않은 전체 보기는 예전처럼 (미매핑) 포함.
 *  ③ J-I2 OS 키: SOAP 수집기의 'unknown'(guestFullName 없음)과 REST 의 빈 값('~')이 OS 패널에서 두 줄로 갈렸다 → osKeyOf 에서 '~' 로 접는다.
 *     수집기 문자열은 그대로(OS 통계·CSV 소비처).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2785e-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'vc-a', name: 'Quiet', host: 'a.example.invalid', username: 'u', password: 'p' },
    { id: 'vc-b', name: 'Behind', host: 'b.example.invalid', username: 'u', password: 'p' },
    { id: 'vc-s', name: 'Site', host: 's.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-x' },
  ],
}));
// 기준 시각 — 정시에서 30분 뺀 값(실제 시각 기준 · CLAUDE.md 테스트 규약)
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;
const DAY = 86_400_000;
// 로그 폴러 커서 — vc-a 는 5분 전에 수집을 끝까지 돌았다(조용할 뿐 정상), vc-b 는 기록이 없다(마지막 저장 3일 전 → 지연)
fs.writeFileSync(path.join(DIR, 'vcenter-logs-cursor.json'), JSON.stringify({ vcenters: { 'vc-a': { okAt: Date.now() - 5 * 60_000, readTs: Date.now() - 5 * 60_000 } } }));

const servers = [];
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const express = (await import('express')).default;
const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { api } = await import('../src/routes/api.js');
const { insightsRouter } = await import('../src/routes/insights.js');
const { getLogsDb } = await import('../src/logs/db.js');
const P = await import('../src/logs/poller.js');
const idracReg = await import('../src/idrac/registry.js');
const { getDb: getPowerDb } = await import('../src/idrac/db.js');
const { osKeyOf, vmDistribution, filterVmsByFacets, parseVmFacets } = await import('../src/inventory/vmDist.js');

P._resetCursorsForTest();
P.loadCursorFile({ force: true });

const db = await getLogsDb();
db.insertMany([
  { vcenterId: 'vc-a', key: 'a-reconf', ts: NOW - 3 * DAY, severity: 'info', type: 'VmReconfiguredEvent', user: 'admin', entity: 'vm-a1', message: 'Reconfigured vm-a1' },
  { vcenterId: 'vc-b', key: 'b-reconf', ts: NOW - 3 * DAY, severity: 'info', type: 'VmReconfiguredEvent', user: 'admin', entity: 'vm-b1', message: 'Reconfigured vm-b1' },
  { vcenterId: 'vc-s', key: 's-reconf', ts: NOW - 3 * DAY, severity: 'info', type: 'VmReconfiguredEvent', user: 'admin', entity: 'vm-s1', message: 'Reconfigured vm-s1' },
]);

store.snapshot = {
  generatedAt: new Date(NOW).toISOString(), source: 'live',
  vcenters: [
    { id: 'vc-a', name: 'Quiet', status: 'connected', location: { region: 'Asia' } },
    { id: 'vc-b', name: 'Behind', status: 'connected', location: { region: 'Asia' } },
    { id: 'vc-s', name: 'Site', status: 'connected', collectSource: 'site' },
  ],
  // 호스트 powerWatts 는 비워 둔다 — 전력은 iDRAC 실측만(아래 등록부)
  hosts: [
    { id: 'vc-a:esx-a1', vcenterId: 'vc-a', name: 'esx-a1', cluster: 'CL', connectionState: 'CONNECTED' },
    { id: 'vc-b:esx-b1', vcenterId: 'vc-b', name: 'esx-b1', cluster: 'CL', connectionState: 'CONNECTED' },
  ],
  vms: [
    { id: 'vc-a:vm-1', name: 'vm-a1', vcenterId: 'vc-a', powerState: 'POWERED_ON' },
    { id: 'vc-b:vm-1', name: 'vm-b1', vcenterId: 'vc-b', powerState: 'POWERED_ON' },
    { id: 'vc-s:vm-1', name: 'vm-s1', vcenterId: 'vc-s', powerState: 'POWERED_ON' },
  ],
  datastores: [], networks: [], alarms: [], collectionErrors: [],
};

const ADMIN = { username: 'adm', role: 'admin', name: 'adm', scope: null };
async function serve(user = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...user }; next(); });
  app.use('/api/insights', insightsRouter);
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, b }; };
}
const of = (get, vmId) => get(`/api/tools/vm-changes/of?vmId=${encodeURIComponent(vmId)}`);

/* ── ① D-B2 ─────────────────────────────────────────────────────────────── */
test('D-B2: 수집은 정상인데 이벤트가 드문 vCenter — lagging=false(지연 없음 판정) · 뒤처진 vCenter 는 지연 객체 · 수집 안 함은 notCollected', async () => {
  const get = await serve();
  const a = await of(get, 'vc-a:vm-1');
  assert.equal(a.status, 200);
  assert.equal(a.b.notCollected, null);
  assert.ok(a.b.lastTs > 0 && Date.now() - a.b.lastTs > 2 * DAY, '전제 — 마지막 이벤트가 2일보다 오래됐다(웹의 옛 대체 기준이면 경고)');
  assert.equal(a.b.lagging, false, `서버가 '지연 없음' 을 판정했다 — null(판정 실패)과 구분해야 한다. 실제 ${JSON.stringify(a.b.lagging)}`);

  const b = await of(get, 'vc-b:vm-1');
  assert.equal(b.b.notCollected, null);
  assert.equal(typeof b.b.lagging, 'object');
  assert.ok(b.b.lagging && b.b.lagging.vcenterId === 'vc-b' && b.b.lagging.lagMs > 2 * DAY, JSON.stringify(b.b.lagging));

  const s = await of(get, 'vc-s:vm-1');
  assert.equal(s.b.notCollected, 'site', "수집하지 않는 vCenter 는 lagging 이 아니라 notCollected 가 말한다(false 가 그것을 가리지 않는다)");
});

test('D-B2: 판정 대상이 없는 경우(mock — 로그 폴러와 같은 기준으로 판정하지 않는다)는 false 가 아니라 null — 웹이 lastTs 로 대신 판단', async () => {
  const prev = config.dataSource;
  config.dataSource = 'mock';
  try {
    const get = await serve();
    const a = await of(get, 'vc-a:vm-1');
    assert.equal(a.status, 200);
    assert.equal(a.b.lagging, null, '판정하지 않았으면 지연 없음(false)이라 말하지 않는다');
  } finally { config.dataSource = prev; }
});

test('D-B2: 소스 계약 — 변수명·응답 끝(evlog2772c 정규식)을 지키고 ?? false', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/vmChanges.js', import.meta.url), 'utf8');
  assert.match(src, /lagList\[0\] \?\? \(eventCoverageIsMock\(\) \? null : false\)/);
  assert.match(src, /notCollected, lagging \}\);/);
});

/* ── ② P-B4 ─────────────────────────────────────────────────────────────── */
test('P-B4: /insights/finops?vcenterId=vc-a (전체 범위 계정) — 다른 vCenter 서버 전력을 (미매핑) 으로 더하지 않는다 · 전체 보기는 그대로', async () => {
  const add = (id, vc, hn) => idracReg.addServer({ id, name: hn, host: `https://10.99.7.${id === 'idr-a' ? 1 : 2}`, username: 'root', password: 'pw', vcenterId: vc, hostNames: [hn], enabled: true });
  assert.equal(add('idr-a', 'vc-a', 'esx-a1').ok, true);
  assert.equal(add('idr-b', 'vc-b', 'esx-b1').ok, true);
  const pdb = await getPowerDb();
  const ts = Date.now() - 60_000;
  pdb.insert('idr-a', 300, ts);
  pdb.insert('idr-b', 9000, ts);

  const get = await serve();
  const one = await get('/api/insights/finops?vcenterId=vc-a');
  assert.equal(one.status, 200);
  assert.equal(one.b.totals.watts, 300, `vc-a 만 — 실제 ${one.b.totals.watts}(예전 9,300W: vc-b 서버가 (미매핑) 으로 합산)`);
  assert.ok(!(one.b.byVcenter || []).some((v) => v.vcId === '(미매핑)'), JSON.stringify(one.b.byVcenter));
  assert.equal(one.b.unmappedServers, 0);
  // 형제 라우트와 같은 값
  const pb = await get('/api/insights/power-breakdown?vcenterId=vc-a');
  assert.equal(pb.b.totals.watts, one.b.totals.watts);

  const all = await get('/api/insights/finops');
  assert.equal(all.b.totals.watts, 9300, '전체 보기는 예전 그대로');
});

/* ── ③ J-I2 ─────────────────────────────────────────────────────────────── */
test("J-I2: osKeyOf — SOAP 'unknown' 은 '~'(OS 정보 없음)로 접힌다 · 그 밖의 이름은 그대로 · 패널·필터가 같은 키", () => {
  assert.equal(osKeyOf({ guestOS: 'unknown' }), '~');
  assert.equal(osKeyOf({ guestOS: '  unknown ' }), '~');
  assert.equal(osKeyOf({ guestOS: '' }), '~');
  assert.equal(osKeyOf({ guestOS: 'Unknown Linux 9' }), 'Unknown Linux 9', '이름의 일부는 접지 않는다');
  const vms = [
    { id: '1', vcenterId: 'v', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 10, guestOS: 'unknown' },
    { id: '2', vcenterId: 'v', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 10 },
    { id: '3', vcenterId: 'v', powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 10, guestOS: 'Linux A 9' },
  ];
  const d = vmDistribution(vms, {});
  assert.deepEqual(d.os.top.map((t) => [t.name, t.n]), [['~', 2], ['Linux A 9', 1]], '한 줄로 선다');
  const sel = parseVmFacets({ osName: '~' }).sel;
  assert.deepEqual(filterVmsByFacets(vms, sel).map((v) => v.id), ['1', '2'], '하나를 골라도 다른 쪽이 빠지지 않는다');
  assert.equal(vmDistribution(vms, sel).total, 2);
});
