/**
 * v2.769 4회차 점검 — 수정 그룹 G4(GPU·CVP) 회귀.
 *  ① R4-D5-1 호스트 GPU 사용률(게스트)은 표·상세·추이가 같은 정의 — 켜진 GPU VM 최댓값(MIG 제외).
 *     예전: 표·상세는 평균(40), 추이(gpu_util ← poller 호스트 대표값 = 최댓값)는 80.
 *  ② R4-D5-2 비-admin BGP 장애 라벨은 피어를 통째로 가린다(IPv6 포함) — 장애 목록·Overview·장비 상세 세 응답 전부.
 *     maskErrText 는 IPv6 리터럴도 선형으로 가린다(시각·MAC 은 건드리지 않는다).
 *  ③ R4-D5-3 일부 GPU '응답 없음'(gpuErrors)이 레코드·store·호스트 요약·/tools/gpu 행까지 실린다.
 *  ④ R4-D5-4 클러스터 추이 키 범위 판정은 split('|') 가 아니라 최장 프리픽스 — vCenter id 에 '|' 가 있어도
 *     범위 밖 클러스터 이력이 새지 않고, 자기 클러스터는 보인다(gpu/history · esxi-temp/history · esxi-temp/spark).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2769d-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const MIN = 60_000;

const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  kr: { username: 'kr', role: 'operator', scope: { vcenters: ['kr'] } },
  krpl: { username: 'krpl', role: 'operator', scope: { vcenters: ['kr|pl'] } },
};
let srv; let base; let store; let cdb; let reg; let prevSnap;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  cdb = await import('../src/cvp/db.js');
  reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  prevSnap = store.snapshot;
});
after(() => {
  try { if (store) store.snapshot = prevSnap; } catch { /* */ }
  try { srv?.close(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, t, j };
}

// ---------------------------------------------------------------- ① D5-1
test('R4-D5-1 표(/tools/gpu 집계)·호스트 상세·추이 입력(poller 호스트 대표값)이 같은 값 — 켜진 GPU VM 최댓값, MIG·꺼진 VM 제외', async () => {
  const { buildGpuInventory } = await import('../src/routes/api/hardwareGpu.js');
  const { summarizeHostGpu } = await import('../src/gpu/hostGpu.js');
  const gs = await import('../src/gpu/store.js');
  gs._resetGuestGpuForTest?.();
  const snap = {
    source: 'vcenter',
    vcenters: [{ id: 'vcG' }],
    hosts: [{ id: 'vcG:h1', name: 'esx-g1', vcenterId: 'vcG', cluster: 'c1', gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'passthrough' }, { model: 'NVIDIA A40', memGB: 45, mode: 'passthrough' }] }],
    vms: [
      { id: 'vcG:vm-a', vcenterId: 'vcG', host: 'esx-g1', name: 'a', powerState: 'POWERED_ON', gpu: { type: 'passthrough', passthrough: 1, count: 1 } },
      { id: 'vcG:vm-b', vcenterId: 'vcG', host: 'esx-g1', name: 'b', powerState: 'POWERED_ON', gpu: { type: 'passthrough', passthrough: 1, count: 1 } },
      { id: 'vcG:vm-m', vcenterId: 'vcG', host: 'esx-g1', name: 'm', powerState: 'POWERED_ON', gpu: { type: 'passthrough', passthrough: 1, count: 1 } },
      { id: 'vcG:vm-off', vcenterId: 'vcG', host: 'esx-g1', name: 'off', powerState: 'POWERED_OFF', gpu: { type: 'passthrough', passthrough: 1, count: 1 } },
    ],
  };
  // 폴러(gpu/poller.js pollLive)와 같은 모양: VM 레코드 + 호스트 대표값 = MIG 를 뺀 VM 사용률 최댓값.
  const vmRecs = [
    { vmId: 'vcG:vm-a', host: 'esx-g1', vcenterId: 'vcG', utilPct: 80, utilNA: false, gpus: 1 },
    { vmId: 'vcG:vm-b', host: 'esx-g1', vcenterId: 'vcG', utilPct: 0, utilNA: false, gpus: 1 },
    { vmId: 'vcG:vm-m', host: 'esx-g1', vcenterId: 'vcG', utilPct: null, utilNA: true, gpus: 1 },
    { vmId: 'vcG:vm-off', host: 'esx-g1', vcenterId: 'vcG', utilPct: 99, utilNA: false, gpus: 1 }, // 꺼진 VM 의 낡은 값(폴러는 켜진 VM 만 수집)
  ];
  const hostRep = Math.max(...vmRecs.filter((v) => v.vmId !== 'vcG:vm-off' && !v.utilNA).map((v) => v.utilPct));
  gs.setGuestGpu({ hosts: [{ hostId: 'vcG:h1', utilPct: hostRep }], vms: vmRecs });
  const trend = gs.getGuestGpuHost('vcG:h1').utilPct; // metrics/sampler.js 가 gpu_util 로 적재하는 입력
  const inv = buildGpuInventory(snap, null, null);
  const row = inv.items.find((x) => x.id === 'vcG:h1');
  assert.equal(row.utilSource, 'guest');
  assert.equal(row.utilPct, 80, '예전 평균이면 40');
  assert.equal(row.utilPct, trend, '표 = 추이 입력');
  const guestByVm = new Map(gs.getGuestGpuVms().map((g) => [g.vmId, g]));
  const detail = summarizeHostGpu(snap.hosts[0], snap.vms, guestByVm);
  assert.equal(detail.utilPct, trend, '호스트 상세 = 추이 입력');
  // ESXi 카운터가 있으면 그것이 먼저(바뀌지 않았다)
  assert.equal(summarizeHostGpu({ ...snap.hosts[0], gpuUtilPct: 12 }, snap.vms, guestByVm).utilPct, 12);
  // 폴러의 호스트 대표값 정의(최댓값)는 그대로 — 바꾸면 저장 이력·엣지 push 와 갈린다.
  const poller = stripComments(fs.readFileSync(path.join(SRC, 'gpu/poller.js'), 'utf8'));
  assert.match(poller, /hosts\.push\(\{ hostId: h\.id, utilPct: Math\.max\(\.\.\.arr\) \}\)/);
  gs._resetGuestGpuForTest?.();
});

// ---------------------------------------------------------------- ② D5-2
test('R4-D5-2 maskErrText 는 IPv6 리터럴을 가리고 시각·MAC·이름은 두며, 최악 입력에도 선형이다', async () => {
  const { maskErrText, maskBgpLabel } = await import('../src/routes/api/cvp.js');
  assert.equal(maskErrText('2001:db8:10::1 (default)'), '(주소 가림) (default)');
  assert.equal(maskErrText('peer fe80::1%Ethernet1 down'), 'peer (주소 가림)%Ethernet1 down');
  assert.equal(maskErrText('x 2001:0db8:0000:0000:0000:0000:0000:0001 y'), 'x (주소 가림) y');
  assert.equal(maskErrText('10.1.2.3 (default)'), '(주소 가림) (default)', 'IPv4 는 예전 그대로');
  assert.equal(maskErrText('at 12:30:45 ok'), 'at 12:30:45 ok', '시각은 주소가 아니다');
  assert.equal(maskErrText('mac aa:bb:cc:dd:ee:ff'), 'mac aa:bb:cc:dd:ee:ff');
  assert.equal(maskErrText('std::vector ::'), 'std::vector ::', '영숫자 연속 안의 :: 는 후보가 아니다');
  // 라벨: VRF 만 남긴다(faultKey 와 대조)
  assert.equal(maskBgpLabel({ label: '2001:db8::1 (blue)', faultKey: 'bgp:blue|2001:db8::1' }), '(주소 가림) (blue)');
  assert.equal(maskBgpLabel({ label: 'fe80::1', faultKey: 'bgp:default|fe80::1' }), '(주소 가림)');
  assert.equal(maskBgpLabel({ label: 'a|b (v|x)', faultKey: 'bgp:v|x|a|b' }), '(주소 가림) (v|x)', 'VRF·피어에 | 가 있어도 정확히');
  assert.equal(maskBgpLabel({ label: 'odd label' }), '(주소 가림)', '대조 못 하면 VRF 도 지어내지 않는다');
  // ReDoS — 비율로(절대 ms 금지): 입력 8배에 시간이 64배(이차) 가까이 늘면 안 된다.
  const time = (s) => { const t = process.hrtime.bigint(); for (let i = 0; i < 3; i++) maskErrText(s); return Number(process.hrtime.bigint() - t) + 1; };
  for (const unit of [':', 'a', 'a:', '1:']) {
    const small = unit.repeat(Math.floor(20_000 / unit.length));
    const big = unit.repeat(Math.floor(160_000 / unit.length));
    time(small);
    const r = time(big) / time(small);
    assert.ok(r < 40, `'${unit}' 반복: 8배 입력에 ${r.toFixed(1)}배(선형이면 ~8)`);
  }
});

test('R4-D5-2 비-admin 세 응답(장애 목록·Overview·장비 상세)에 IPv6 BGP 피어가 없다 — admin 은 그대로', async () => {
  const saved = reg.saveServer({ name: 'CVP-6', host: 'https://10.98.0.1', authMode: 'token', token: 'tok', agent: '' });
  const now = Date.now();
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: saved.id, devices: [{
    key: 'SN6', ts: now, hostname: 'leaf6', model: 'DCS', serial: 'SN6', eosVersion: '4.30', streaming: true, telemetry: 'ok',
    parts: [{ kind: 'fan', name: 'Fan1', state: 'ok', detail: '' }], partsAt: now,
    bgp: [{ peer: '2001:db8:10::1', asn: '65001', vrf: 'blue', state: 'Idle', prefixes: null }, { peer: 'fe80::1%Ethernet1', asn: '65002', vrf: '', state: 'Active', prefixes: null }],
    ports: [{ name: 'Ethernet1', desc: 'up', speedBps: 1e10, oper: 'up', admin: 'up', inBps: 1, outBps: 1 }],
  }], samples: false });
  const run = await call('op', 'POST', '/tools/cvp/faults/scan', {});
  assert.equal(run.s, 200, run.t);
  const a = await call('admin', 'GET', `/tools/cvp/faults?cvpId=${saved.id}`);
  const bgpA = a.j.open.filter((f) => f.kind === 'bgp');
  assert.equal(bgpA.length, 2, a.t);
  assert.ok(bgpA.some((f) => f.label === '2001:db8:10::1 (blue)'), 'admin 은 원문');
  const leak = (j) => /2001:db8|fe80::/i.test(JSON.stringify(j));
  const o = await call('op', 'GET', `/tools/cvp/faults?cvpId=${saved.id}`);
  assert.equal(o.s, 200);
  assert.equal(leak(o.j), false, `장애 목록: ${o.t.slice(0, 400)}`);
  assert.deepEqual(o.j.open.filter((f) => f.kind === 'bgp').map((f) => f.label).sort(), ['(주소 가림)', '(주소 가림) (blue)']);
  const ov = await call('op', 'GET', '/tools/cvp/overview');
  assert.equal(ov.s, 200, ov.t);
  assert.ok((ov.j.recentFaults || []).some((f) => f.kind === 'bgp'), 'Overview 최근 전이에 BGP 가 있어야 시험이 성립한다');
  assert.equal(leak(ov.j), false, 'Overview recentFaults');
  const dv = await call('op', 'GET', `/tools/cvp/device?cvpId=${saved.id}&key=SN6`);
  assert.equal(dv.s, 200, dv.t);
  assert.ok(dv.j.history.openFaults.some((f) => f.kind === 'bgp'));
  assert.equal(leak(dv.j), false, '장비 상세 openFaults·faultEvents·bgp.peers');
});

// ---------------------------------------------------------------- ③ D5-3
test('R4-D5-3 일부 GPU 응답 없음(gpuErrors)이 store·호스트 요약·/tools/gpu 행·VM 행까지 실린다(폴러 두 곳도 싣는다)', async () => {
  const { parseNvidiaSmiCsv } = await import('../src/gpu/guestops.js');
  const { buildGpuInventory } = await import('../src/routes/api/hardwareGpu.js');
  const gs = await import('../src/gpu/store.js');
  gs._resetGuestGpuForTest?.();
  const r = parseNvidiaSmiCsv('Unable to determine the device handle for GPU0000:3B:00.0: Unknown Error\n87, 40, 30000, 81920, Disabled, 71\n');
  assert.equal(r.count, 1); assert.equal(r.gpuErrors, 1);
  const snap = {
    source: 'vcenter', vcenters: [{ id: 'vcE' }],
    hosts: [{ id: 'vcE:h1', name: 'esx-e1', vcenterId: 'vcE', gpus: [{ model: 'NVIDIA A100', memGB: 80, mode: 'passthrough' }, { model: 'NVIDIA A100', memGB: 80, mode: 'passthrough' }] }],
    vms: [{ id: 'vcE:vm-1', vcenterId: 'vcE', host: 'esx-e1', name: 'e1', powerState: 'POWERED_ON', gpu: { type: 'passthrough', passthrough: 2, count: 2 } }],
  };
  gs.setGuestGpu({ hosts: [{ hostId: 'vcE:h1', utilPct: r.utilPct }], vms: [{ vmId: 'vcE:vm-1', host: 'esx-e1', vcenterId: 'vcE', utilPct: r.utilPct, gpus: r.count, gpuErrors: r.gpuErrors }] });
  assert.equal(gs.getGuestGpuVms()[0].gpuErrors, 1);
  const row = buildGpuInventory(snap, null, null).items[0];
  assert.equal(row.gpuErrors, 1, '호스트 행');
  assert.equal(row.vms[0].gpuErrors, 1, 'VM 행');
  // 이상값은 store 가 좁힌다(0~64 정수, 밖이면 null = 모름)
  gs.setGuestGpu({ vms: [{ vmId: 'vcE:vm-1', utilPct: 5, gpuErrors: 'x' }] });
  assert.equal(gs.getGuestGpuVms()[0].gpuErrors, null);
  gs.setGuestGpu({ vms: [{ vmId: 'vcE:vm-1', utilPct: 5, gpuErrors: 999 }] });
  assert.equal(gs.getGuestGpuVms()[0].gpuErrors, null);
  assert.equal(buildGpuInventory(snap, null, null).items[0].gpuErrors, 0, '모르면 0 장으로 더하지 않는다');
  const poller = stripComments(fs.readFileSync(path.join(SRC, 'gpu/poller.js'), 'utf8'));
  assert.match(poller, /gpus: r\.count, gpuErrors \}\);/, '폴러 VM 레코드');
  assert.match(poller, /temp: r\.tempC \?\? null, gpus: r\.count, gpuErrors \}\)/, '폴러 진단 결과');
  const phys = stripComments(fs.readFileSync(path.join(SRC, 'gpu/physicalPoller.js'), 'utf8'));
  assert.match(phys, /gpuErrors: Number\.isFinite\(r\.gpuErrors\)/, '물리 서버 폴러');
  gs._resetGuestGpuForTest?.();
});

// ---------------------------------------------------------------- ④ D5-4
test('R4-D5-4 clusterKeyVcenter·ownsClusterKey — 최장 프리픽스(알려진 vCenter ∪ 허용), 허용 id 만으로 찾지 않는다', async () => {
  const { clusterKeyVcenter, ownsClusterKey } = await import('../src/gpu/clusterKeyScope.js');
  const ids = ['kr', 'kr|pl', 'us'];
  assert.equal(clusterKeyVcenter('kr|pl|cl1', ids), 'kr|pl');
  assert.equal(clusterKeyVcenter('kr|cl0', ids), 'kr');
  assert.equal(clusterKeyVcenter('krx|cl', ids), null, "'kr' 은 'krx|' 의 프리픽스가 아니다(구분자 필수)");
  assert.equal(clusterKeyVcenter('kr', ids), null);
  const snap = { vcenters: [{ id: 'kr' }, { id: 'kr|pl' }], hosts: [] };
  assert.equal(ownsClusterKey(new Set(['kr']), 'kr|pl|cl1', snap), false, '범위 밖(kr|pl) 클러스터 — 예전 split 이면 통과');
  assert.equal(ownsClusterKey(new Set(['kr|pl']), 'kr|pl|cl1', snap), true, '자기 클러스터 — 예전 split 이면 빈 응답');
  assert.equal(ownsClusterKey(new Set(['kr']), 'kr|cl0', snap), true);
  assert.equal(ownsClusterKey(null, 'anything', snap), true, '전체 범위');
  assert.equal(ownsClusterKey(new Set(['gone']), 'gone|c', { vcenters: [] }), true, '스냅샷에서 빠진 허용 vCenter 의 이력도 본다');
  // 세 곳 모두 split('|') 판정을 쓰지 않는다
  for (const f of ['routes/api/toolsAnalytics.js', 'routes/api/toolsCapacity.js']) {
    const s = stripComments(fs.readFileSync(path.join(SRC, f), 'utf8'));
    assert.equal(/\.split\('\|'\)\[0\]/.test(s), false, `${f} 에 split('|')[0] 범위 판정이 남았다`);
  }
});

test('R4-D5-4 실제 라우트 — gpu/history · esxi-temp/history · esxi-temp/spark 의 클러스터 키 범위', async () => {
  const { getMetricsDb } = await import('../src/metrics/db.js');
  const db = await getMetricsDb();
  const t0 = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * MIN; // 정시 경계에서 떨어뜨린 기준
  for (let i = 0; i < 5; i++) {
    db.insertMany([
      { metric: 'gpu_cluster', k: 'kr|pl|cl1', v: 50 + i }, { metric: 'gpu_cluster', k: 'kr|cl0', v: 10 + i },
      { metric: 'temp_cluster', k: 'kr|pl|cl1', v: 30 + i }, { metric: 'temp_cluster', k: 'kr|cl0', v: 20 + i },
    ], t0 - (4 - i) * MIN);
  }
  // 스파크는 1시간 버킷이고 점 2개 이상이어야 선이다 — 앞선 시간대에도 한 점씩.
  for (let h = 1; h <= 3; h++) db.insertMany([{ metric: 'temp_cluster', k: 'kr|pl|cl1', v: 31 }, { metric: 'temp_cluster', k: 'kr|cl0', v: 21 }], t0 - h * 3_600_000);
  store.snapshot = { ...(prevSnap || {}), source: 'vcenter', vcenters: [{ id: 'kr' }, { id: 'kr|pl' }], hosts: [], vms: [] };
  const gpu = async (u, k) => (await call(u, 'GET', `/tools/gpu/history?level=cluster&key=${encodeURIComponent(k)}&days=1&bucket=1m`)).j;
  const temp = async (u, k) => (await call(u, 'GET', `/tools/esxi-temp/history?level=cluster&key=${encodeURIComponent(k)}&days=1&bucket=minute`)).j;
  assert.equal((await gpu('admin', 'kr|pl|cl1')).points.length > 0, true, '시험 데이터가 읽혀야 시험이 성립한다');
  assert.equal((await gpu('kr', 'kr|pl|cl1')).points.length, 0, "범위 'kr' 은 'kr|pl' 클러스터 GPU 이력을 못 본다");
  assert.equal((await gpu('kr', 'kr|cl0')).points.length > 0, true);
  assert.equal((await gpu('krpl', 'kr|pl|cl1')).points.length > 0, true, "범위 'kr|pl' 은 자기 클러스터를 본다");
  assert.equal((await temp('admin', 'kr|pl|cl1')).points.length > 0, true);
  assert.equal((await temp('kr', 'kr|pl|cl1')).points.length, 0, '온도 추이도 같은 판정');
  assert.equal((await temp('krpl', 'kr|pl|cl1')).points.length > 0, true);
  const spark = async (u) => (await call(u, 'POST', '/tools/esxi-temp/spark', { hours: 24, items: [{ key: 'kr|pl|cl1', source: 'cluster' }, { key: 'kr|cl0', source: 'cluster' }] })).j;
  const sk = await spark('kr');
  assert.equal(sk.series['kr|pl|cl1'], null, '스파크도 범위 밖은 null');
  assert.ok(Array.isArray(sk.series['kr|cl0']));
  const sp = await spark('krpl');
  assert.ok(Array.isArray(sp.series['kr|pl|cl1']));
  assert.equal(sp.series['kr|cl0'], null);
});

test('R4-D5-3 후속 — 엣지 push 행과 중앙 정제 화이트리스트가 gpuErrors 를 나른다(범위 밖은 null)', async () => {
  const { narrowGpuRow } = await import('../src/routes/central.js');
  assert.deepEqual(narrowGpuRow({ vmId: 'vc:vm-1', gpuErrors: '2' }), { vmId: 'vc:vm-1', gpuErrors: 2 });
  assert.equal(narrowGpuRow({ vmId: 'vc:vm-1', gpuErrors: 99 }).gpuErrors, null);
  assert.equal(narrowGpuRow({ vmId: 'vc:vm-1', gpuErrors: -1 }).gpuErrors, null);
  assert.equal(Object.hasOwn(narrowGpuRow({ vmId: 'vc:vm-1' }), 'gpuErrors'), false, '구버전 엣지(필드 없음)는 키를 만들지 않는다');
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/agent/gpuGuestPush.js', import.meta.url), 'utf8');
  assert.match(src, /gpuErrors: v\.gpuErrors \?\? null/, '엣지 push 행에 gpuErrors 가 실린다');
});
