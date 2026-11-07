/**
 * v2.939 — SAN·CVP C 단계 남긴 것 다섯.
 *  ① 엣지 위치 조회 시각 원본(C-③ 반증 L-10) — 수신 시각으로 자르고 원본(edgeAt)은 따로 · DB edge_at · 화면 '엣지 시계 +n분'
 *  ② CVP 위치 주기 요약 — 엣지 상태 정제가 아는 필드만 받아 넘긴다(예전에는 버렸다)
 *  ③ 플로우 비활성화 · 다시 켜기 — 명령 · 상태 · 속도 비움 · 엣지 버전 · 라우트 게이트 · OTP
 *  ④ '실측(스위치 플로우)' — 귀속 엔진이 플로우를 타깃 → 스토리지로 묶어 나란히(분배 값과 섞지 않음)
 *  ⑤ 원문 표본 — 못 푼 경로 이름(엣지 정제 포함) · 못 읽은 플로우 출력 앞부분
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sancvp2939-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true' });
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'security-session.json'), JSON.stringify({ settingsOwners: ['owner'] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const INI = '10:00:00:10:9b:00:00:01'; const T1 = '50:00:09:73:00:00:00:01'; const T2 = '58:cc:f0:00:00:00:00:c0';

test('① 엣지 위치 조회 시각 — 자르고 원본은 따로 · DB 왕복', async () => {
  const { cleanEp } = await import('../src/central/cvpEdge.js');
  const ahead = cleanEp({ mac: '005056aa0001', at: NOW + 10 * 60_000, status: 'none', locations: [] }, NOW);
  assert.equal(ahead.at, NOW); assert.equal(ahead.edgeAt, NOW + 10 * 60_000);
  const normal = cleanEp({ mac: '005056aa0002', at: NOW - 1000, status: 'none', locations: [] }, NOW);
  assert.equal(normal.at, NOW - 1000); assert.equal('edgeAt' in normal, false, '잘리지 않았으면 원본을 따로 싣지 않는다');
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  await db.saveEndpoints('edge-a', 'cvp-1', [ahead, normal, { mac: '005056aa0003', at: NOW, edgeAt: NOW - 5, status: 'none' }]);
  const r = await db.endpointsByMacs(['005056aa0001', '005056aa0002', '005056aa0003']);
  assert.equal(r.meta.get('005056aa0001')[0].edgeAt, NOW + 10 * 60_000);
  assert.equal(r.meta.get('005056aa0002')[0].edgeAt, null);
  assert.equal(r.meta.get('005056aa0003')[0].edgeAt, null, '잘린 시각보다 앞선 원본은 저장하지 않는다(뜻 없음)');
});

test('② CVP 위치 주기 요약 — 엣지 상태 정제', async () => {
  const { cleanStatus } = await import('../src/central/cvpEdge.js');
  const st = cleanStatus({ cvpId: 'c1', name: 'C', ok: true, endpoints: { at: NOW + 99_999, asked: '200', ok: 150, none: 40, errors: 3, cut: 7, unsupported: true, stopped: 'auth', evil: 'x' } }, NOW);
  assert.deepEqual(st.endpoints, { at: NOW, asked: 200, ok: 150, none: 40, errors: 3, cut: 7, unsupported: true, stopped: 'auth' });
  assert.equal(cleanStatus({ cvpId: 'c1', endpoints: { stopped: 'reboot', asked: 'abc' } }, NOW).endpoints.stopped, null, '멈춤 사유는 열거값만');
  assert.equal(cleanStatus({ cvpId: 'c1', endpoints: { asked: 'abc' } }, NOW).endpoints.asked, null, '못 읽은 수는 0 이 아니라 null');
  assert.equal('endpoints' in cleanStatus({ cvpId: 'c1' }, NOW), false, '구버전 엣지는 필드 자체가 없다');
});

test('③ 플로우 비활성화 · 다시 켜기', async () => {
  const C = await import('../src/sanswitch/flowCmd.js');
  const J = await import('../src/sanswitch/flowJobs.js');
  const R = await import('../src/routes/api/sanFlow.js');
  const V = await import('../src/sanswitch/flowView.js');
  const N = 'dvc_esx1abc12_01';
  assert.deepEqual(C.buildFlowCommands('deactivate', [{ name: N }]).cmds, [`flow --deactivate ${N} -feature monitor`, `flow --show ${N}`]);
  assert.deepEqual(C.buildFlowCommands('activate', [{ name: N }]).cmds, [`flow --activate ${N} -feature monitor`, `flow --show ${N}`]);
  assert.ok(C.buildFlowCommands('deactivate', [{ name: 'sys_mon_all_fports' }]).issue, '사람 · 장비 플로우는 손대지 않는다');
  assert.ok(C.FLOW_ACTIONS.includes('deactivate'));
  // 엣지 버전 — 비활성화 · 다시 켜기는 2.939.0 부터(그 전 엣지는 '알 수 없는 동작' 으로 실행하지 않는다)
  assert.match(R.flowEdgeIssue('e', '2.937.0', 'deactivate'), /2\.939\.0 이상/);
  assert.equal(R.flowEdgeIssue('e', '2.937.0', 'show'), null, '다른 동작은 예전 하한');
  assert.equal(R.flowEdgeIssue('e', '2.939.0', 'activate'), null);
  assert.match(R.flowEdgeIssue('e', '2.938.0', 'activate'), /2\.939\.0 이상/, '2.938.0(다른 작업 릴리스)은 아직 모른다');
  // 작업 반영 — 엣지 위임(큐)으로 결과를 직접 넣는다
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ deviceId: 'sw-e', name: N, state: 'active', srcdev: INI, dstdev: T1, ingrport: '1/1',
    counters: { rxBytes: 1000, txBytes: 2000 }, lastAt: NOW - 60_000, prevCounters: { rxBytes: 500, txBytes: 1000 }, prevAt: NOW - 120_000 }], checks: {} }));
  J._resetFlowsForTest();
  const dev = { id: 'sw-e', name: 'SW', host: 'x.invalid', username: 'u', password: 'p', agent: 'edge-a' };
  const show = (state) => `Name : ${N}   Features: mon(${state})\n| Rx Frames Count | Tx Frames Count | Rx Bytes Count | Tx Bytes Count |\n|---|---|---|---|\n| 1 | 1 | 1200 | 2400 |\n`;
  let r = J.startFlowJob({ device: dev, action: 'deactivate', flows: [{ name: N }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r.id, 'edge-a', { outputs: [{ cmd: `flow --deactivate ${N} -feature monitor`, ok: true, out: `Flow ${N} deactivated` }, { cmd: `flow --show ${N}`, ok: true, out: show('Deactivated') }] });
  let rec = J.listFlows().find((f) => f.name === N);
  assert.equal(rec.state, 'inactive'); assert.ok(rec.deactivatedAt);
  assert.deepEqual(V.flowRatesOf(rec), { rxBps: null, txBps: null }, '비활성은 속도를 비운다(0 이 아니다)');
  // 주기 카운터는 비활성을 읽지 않는다
  assert.equal(J.scheduleFlowShows(() => dev, {}), 0);
  r = J.startFlowJob({ device: dev, action: 'activate', flows: [{ name: N }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r.id, 'edge-a', { outputs: [{ cmd: `flow --activate ${N} -feature monitor`, ok: true, out: `Flow ${N} activated` }, { cmd: `flow --show ${N}`, ok: true, out: show('Activated') }] });
  rec = J.listFlows().find((f) => f.name === N);
  assert.equal(rec.state, 'active'); assert.equal(rec.prevCounters, null, '다시 켠 뒤 첫 델타가 꺼져 있던 시간까지 나누지 않게 기준을 새로 잡는다');
  assert.deepEqual(rec.counters, { rxFrames: 1, txFrames: 1, rxBytes: 1200, txBytes: 2400, rxBps: null, txBps: null });
  // 장비에서 직접 끈 것을 따라간다(활성 여부를 읽었을 때만)
  r = J.startFlowJob({ device: dev, action: 'show', flows: [{ name: N }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r.id, 'edge-a', { outputs: [{ cmd: `flow --show ${N}`, ok: true, out: show('Deactivated') }] });
  assert.equal(J.listFlows().find((f) => f.name === N).state, 'inactive');
  // 실패 · 시한 — 상태를 바꾸지 않고 사유
  r = J.startFlowJob({ device: dev, action: 'activate', flows: [{ name: N }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r.id, 'edge-a', { outputs: [{ cmd: `flow --activate ${N} -feature monitor`, ok: false, out: 'Permission denied' }] });
  rec = J.listFlows().find((f) => f.name === N);
  assert.equal(rec.state, 'inactive'); assert.match(rec.lastError, /권한/);
  J._resetFlowsForTest();
});

test('③ 라우트 — OTP · 상태 맞춤 · dvc_ 만', async () => {
  const J = await import('../src/sanswitch/flowJobs.js');
  const reg = await import('../src/sanswitch/registry.js');
  const dev = reg.saveDevice({ type: 'brocade', name: 'SW-T', host: 'swt.example.invalid', username: 'admin', password: 'PW', collectMethod: 'ssh' });
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ deviceId: dev.id, name: 'dvc_t000aaaaa_01', state: 'active', srcdev: INI, dstdev: T1, ingrport: '1/1' },
    { deviceId: dev.id, name: 'dvc_t000aaaaa_02', state: 'inactive', srcdev: INI, dstdev: T2, ingrport: '1/1' }], checks: {} }));
  J._resetFlowsForTest();
  const express = (await import('express')).default;
  const R = await import('../src/routes/api/sanFlow.js');
  let user = { username: 'adm', role: 'admin' };
  const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerSanFlow(api); app.use('/api', api);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const post = (p, body) => fetch(`http://127.0.0.1:${srv.address().port}/api/tools/san-flow${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/deactivate', { deviceId: dev.id, name: 'dvc_t000aaaaa_01' })).status, 403, 'OTP 없는 · 소유자 아닌 admin 은 막힌다(설정 변경)');
  user = { username: 'v', role: 'viewer' };
  assert.equal((await post('/activate', { deviceId: dev.id, name: 'dvc_t000aaaaa_02' })).status, 403);
  user = { username: 'owner', role: 'admin' };
  assert.equal((await post('/deactivate', { deviceId: dev.id, name: 'dvc_t000aaaaa_02' })).status, 409, '비활성은 비활성화하지 않는다');
  assert.equal((await post('/activate', { deviceId: dev.id, name: 'dvc_t000aaaaa_01' })).status, 409, '활성은 다시 켜지 않는다');
  assert.equal((await post('/deactivate', { deviceId: dev.id, name: 'sys_mon_all_fports' })).status, 400);
  assert.equal((await post('/deactivate', { deviceId: dev.id, name: 'dvc_nothere_01' })).status, 404);
  const x = await post('/deactivate', { deviceId: dev.id, name: 'dvc_t000aaaaa_01' });
  assert.equal(x.status, 200);
  J._resetFlowsForTest();
});

test('④ 실측(스위치 플로우) — 타깃 → 스토리지로 묶어 행에 · 분배 값과 섞지 않음', async () => {
  const A = await import('../src/sanswitch/attribution.js');
  const V = await import('../src/sanswitch/flowView.js');
  const port = (index, attached) => ({ index, slotPort: `0/${index}`, name: `p${index}`, state: 'online', attached, inBps: 100, outBps: 200 });
  const fabrics = A.buildFabrics([{ deviceId: 'swA', name: 'SW-A', collectedAt: NOW, ok: true, ports: { list: [port(0, [INI]), port(1, [T1]), port(2, [T2])] },
    zoning: { available: true, zones: [{ name: 'Z1', members: [INI, T1] }, { name: 'Z2', members: [INI, T2] }] }, nsRoles: { [INI]: 'initiator', [T1]: 'target', [T2]: 'target' } }]);
  const host = { id: 'vc:h1', name: 'esx1', vcenterId: 'vc', hbas: [{ name: 'vmhba1', wwn: INI }] };
  const flows = [V.hostFlowOut({ name: 'dvc_a_01', state: 'active', hba: 'vmhba1', srcdev: INI, dstdev: T1, deviceId: 'swA', counters: { rxBytes: 2000, txBytes: 4000 }, lastAt: 2000, prevCounters: { rxBytes: 1000, txBytes: 2000 }, prevAt: 1000 }),
    V.hostFlowOut({ name: 'dvc_a_02', state: 'inactive', hba: 'vmhba1', srcdev: INI, dstdev: T2, deviceId: 'swA' })];
  const without = A.attributeFleet([host], fabrics, {});
  const withF = A.attributeFleet([host], fabrics, { flowsOf: () => flows });
  assert.deepEqual(withF.rows.map((x) => [x.confirmedBytes, x.estimatedBytes, x.measuredBytes]), without.rows.map((x) => [x.confirmedBytes, x.estimatedBytes, x.measuredBytes]), '분배 값은 그대로');
  const flowRows = withF.rows.filter((x) => x.flow);
  assert.equal(flowRows.length, 2, '타깃마다 그 스토리지 행에');
  const measured = flowRows.find((x) => x.flow.measured === 1);
  assert.deepEqual(measured.flow, { n: 1, measured: 1, rxBps: 1000, txBps: 2000 });
  const inactive = flowRows.find((x) => x.flow.measured === 0);
  assert.deepEqual(inactive.flow, { n: 1, measured: 0, rxBps: null, txBps: null }, '속도를 못 읽은 플로우는 개수에만');
  assert.equal(V.FLOW_SHOWN_STATES.has('failed'), false); assert.equal(V.FLOW_SHOWN_STATES.has('deleted'), false);
});

test('⑤ 원문 표본 — 못 푼 경로 이름 · 엣지 정제 · 못 읽은 플로우 출력', async () => {
  const P = await import('../src/storpath/parse.js');
  const ids = { read: '11', write: '12' };
  const names = ['weird-1', 'weird-2\u0001ctl', 'vmhba9:C0:T9:L1', ...Array.from({ length: 8 }, (_, i) => `x${i}`)];
  const byC = new Map([['11', new Map(names.map((n) => [n, [1, 1]]))], ['12', new Map()]]);
  const s = P.summarizeHostPaths(byC, ids, { at: NOW, samples: 2 });
  assert.equal(s.unparsed, names.length);
  assert.equal(s.unparsedSamples.length, P.UNPARSED_SAMPLES, '표본은 상한까지만');
  assert.ok(s.unparsedSamples.every((x) => !/[\u0000-\u001f]/.test(x.name)), '제어문자 제거'); // eslint-disable-line no-control-regex
  assert.equal(s.unparsedSamples.find((x) => x.name.startsWith('vmhba9')).why, 'no-target', '멀티패스 표에 없는 런타임 이름');
  const clean = P.sanitizeHostSpath({ at: NOW, targets: [], unparsedSamples: [{ name: 'a'.repeat(500), why: 'evil' }, 'str', null, ...Array.from({ length: 9 }, () => ({ name: 'n', why: 'format' }))] }, NOW);
  assert.equal(clean.unparsedSamples.length, 3, '앞 5개를 자른 뒤 모양이 아닌 것(글자 · null)은 버린다');
  assert.equal(clean.unparsedSamples[0].name.length, 120); assert.equal(clean.unparsedSamples[0].why, 'format', '모르는 사유는 format');
  // 못 읽은 플로우 출력 — 앞부분을 기록에(작업 기록은 1시간 뒤 사라진다)
  const J = await import('../src/sanswitch/flowJobs.js');
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ deviceId: 'sw-r', name: 'dvc_raw00000_01', state: 'active', srcdev: INI, dstdev: T1, ingrport: '1/1' }], checks: {} }));
  J._resetFlowsForTest();
  const dev = { id: 'sw-r', name: 'SW', host: 'x.invalid', username: 'u', password: 'p', agent: 'edge-a' };
  const r = J.startFlowJob({ device: dev, action: 'show', flows: [{ name: 'dvc_raw00000_01' }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r.id, 'edge-a', { outputs: [{ cmd: 'flow --show dvc_raw00000_01', ok: true, out: `New format v9 ${'z'.repeat(1000)}` }] });
  const rec = J.listFlows().find((f) => f.name === 'dvc_raw00000_01');
  assert.ok(rec.rawSample.startsWith('New format v9')); assert.equal(rec.rawSample.length, 400);
  assert.equal(rec.lastAt, undefined, '못 읽은 시도는 성공 시각을 움직이지 않는다');
  J._resetFlowsForTest();
});
