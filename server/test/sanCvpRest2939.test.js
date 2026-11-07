/**
 * v2.939 — SAN·CVP C 단계 남긴 것 다섯.
 *  ① 엣지 위치 조회 시각 원본(C-③ 반증 L-10) — 수신 시각으로 자르고 원본(edgeAt)은 따로 · DB edge_at · 화면 '엣지 시계 +n분'
 *  ② CVP 위치 주기 요약 — 엣지 상태 정제가 아는 필드만 받아 넘긴다(예전에는 버렸다)
 *  ③ 플로우 비활성화 · 다시 켜기 — 명령 · 상태 · 속도 비움 · 엣지 버전 · 라우트 게이트 · OTP
 *  ④ '실측(스위치 플로우)' — 귀속 엔진이 플로우를 타깃 → 스토리지로 묶어 나란히(분배 값과 섞지 않음)
 *  ⑤ 원문 표본 — 못 푼 경로 이름(엣지 정제 포함) · 못 읽은 플로우 출력 앞부분
 */
import { test, after, mock } from 'node:test';
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
  const near = cleanEp({ mac: '005056aa0009', at: NOW + 1500, status: 'none', locations: [] }, NOW);
  assert.equal(near.at, NOW); assert.equal('edgeAt' in near, false, '반증 L-1: 허용 오차(5초) 안이면 전송 지연과 구분할 수 없어 원본을 싣지 않는다');
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

test('② 실제 화면 라우트 — 중앙 직접 · 엣지 둘 다 요약이 응답에 실린다(반증 M-1 — pickStatus 화이트리스트)', async () => {
  const express = (await import('express')).default;
  const reg = await import('../src/cvp/registry.js');
  const { putStatus } = await import('../src/cvp/store.js');
  const { cleanStatus, saveEdgeCvpStatus } = await import('../src/central/cvpEdge.js');
  const { registerCvp } = await import('../src/routes/api/cvp.js');
  const local = reg.saveServer({ name: 'CVP-L9', host: 'https://10.1.1.1', authMode: 'token', token: 't', agent: '' });
  const deleg = reg.saveServer({ name: 'CVP-E9', host: 'https://10.1.1.2', authMode: 'token', token: 't', agent: 'edge-a' });
  const ep = { at: NOW - 60_000, asked: 200, ok: 150, none: 40, errors: 3, unsupported: false, cut: 7, stopped: 'auth' };
  putStatus(local.id, { name: 'CVP-L9', ok: true, collectedAt: NOW, lastAttemptAt: NOW, deviceCount: 3, endpoints: ep });
  saveEdgeCvpStatus('edge-a', [cleanStatus({ cvpId: deleg.id, name: 'CVP-E9', ok: true, collectedAt: NOW, endpoints: ep }, NOW)], { now: NOW });
  const app = express(); app.use((req, _r, n) => { req.user = { username: 'adm', role: 'admin' }; n(); });
  const api = express.Router(); registerCvp(api); app.use('/api', api);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const j = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/cvp`)).json();
  for (const name of ['CVP-L9', 'CVP-E9']) {
    const s = (j.servers || []).find((x) => x.name === name);
    assert.ok(s, name);
    assert.deepEqual({ asked: s.status?.endpoints?.asked, stopped: s.status?.endpoints?.stopped }, { asked: 200, stopped: 'auth' }, `${name} — 요약이 응답에 실린다`);
  }
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

test('③ 반증 확정분 — 늦은 회신 순서(L-1) · 결과 모름(L-2) · 다시 켜질 때 기준(M-2)', async () => {
  const J = await import('../src/sanswitch/flowJobs.js');
  const V = await import('../src/sanswitch/flowView.js');
  const N = 'dvc_esx1late1_01';
  const D = `flow --deactivate ${N} -feature monitor`; const A = `flow --activate ${N} -feature monitor`; const S = `flow --show ${N}`;
  const show = (state, rx = 1200, tx = 2400) => `Name : ${N}   Features: mon(${state})\n| Rx Frames Count | Tx Frames Count | Rx Bytes Count | Tx Bytes Count |\n|---|---|---|---|\n| 1 | 1 | ${rx} | ${tx} |\n`;
  const base = { deviceId: 'sw-l', name: N, srcdev: INI, dstdev: T1, ingrport: '1/1', counters: { rxBytes: 1000, txBytes: 2000 }, lastAt: NOW - 60_000, prevCounters: { rxBytes: 500, txBytes: 1000 }, prevAt: NOW - 120_000 };
  const dev = { id: 'sw-l', name: 'SW', host: 'x.invalid', username: 'u', password: 'p', agent: 'edge-a' };
  const run = (action, result) => { const r = J.startFlowJob({ device: dev, action, flows: [{ name: N }], user: 'adm' }); assert.ok(r.id, r.issue); J.takeFlowJobsForAgent('edge-a'); if (result) J.completeFlowJob(r.id, 'edge-a', result); return r; };
  const rec = () => J.listFlows().find((f) => f.name === N);
  // L-1 + L-2: 끄기가 시한으로 닫힘(결과 모름) → 켜기 성공 → 끄기 늦은 회신은 켜기를 덮지 않는다
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ ...base, state: 'active' }], checks: {} }));
  J._resetFlowsForTest();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let off;
  try {
    off = run('deactivate');
    mock.timers.tick(J.EDGE_DEADLINE_MS + 1);
    assert.equal(rec().state, 'unknown', 'L-2: 보냈는데 결과를 모르면 결과 모름(활성으로 남기지 않는다)');
    assert.match(rec().lastError, /비활성화 결과를 모릅니다/);
    mock.timers.tick(1000);
    run('activate', { outputs: [{ cmd: A, ok: true, out: `Flow ${N} activated` }, { cmd: S, ok: true, out: show('Activated') }] });
    assert.equal(rec().state, 'active');
    assert.equal(J.completeFlowJob(off.id, 'edge-a', { outputs: [{ cmd: D, ok: true, out: `Flow ${N} deactivated` }, { cmd: S, ok: true, out: show('Deactivated') }] }).late, true);
    assert.equal(rec().state, 'active', 'L-1: 그 뒤에 시작한 켜기가 이미 반영됐으면 끄기 늦은 회신은 상태를 바꾸지 않는다');
  } finally { mock.timers.reset(); }
  // L-2: 세션이 끊겨 보낸 명령의 결과를 모르면 결과 모름 · 실행하지 않았으면(notRun) 상태 그대로
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ ...base, state: 'active' }], checks: {} }));
  J._resetFlowsForTest();
  run('deactivate', { outputs: [], notRun: true, reason: '실행하지 않았습니다' });
  assert.equal(rec().state, 'active', '보내지 않았으면 상태 그대로');
  run('deactivate', { outputs: [], inFlight: D, reason: '세션이 끊겼습니다' });
  assert.equal(rec().state, 'unknown');
  // M-2: 결과 모름 → 카운터 읽기가 켜져 있음을 읽으면 기준을 새로 잡는다(직전 카운터로 델타를 내지 않는다)
  run('show', { outputs: [{ cmd: S, ok: true, out: show('Activated', 9000, 9000) }] });
  assert.equal(rec().state, 'active'); assert.equal(rec().prevCounters, null);
  assert.deepEqual(V.flowRatesOf(rec()), { rxBps: null, txBps: null }, '기준 하나로는 속도를 내지 않는다(꺼져 있던 시간까지 나누지 않는다)');
  // M-2: 비활성 기록을 장비에서 직접 켠 것을 따라갈 때도 같다
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ ...base, state: 'inactive', deactivatedAt: NOW - 600_000 }], checks: {} }));
  J._resetFlowsForTest();
  run('show', { outputs: [{ cmd: S, ok: true, out: show('Activated') }] });
  assert.equal(rec().state, 'active'); assert.equal(rec().prevCounters, null, '장비에서 켠 것을 따라갈 때도 직전 카운터를 버린다');
  assert.equal(rec().deactivatedAt, null);
  run('show', { outputs: [{ cmd: S, ok: true, out: show('Activated', 1300, 2600) }] });
  assert.deepEqual(rec().prevCounters?.rxBytes, 1200, '다음 읽기부터 델타');
  // 활성 여부를 모르는 출력은 비활성을 켜지 않는다
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ ...base, state: 'inactive' }], checks: {} }));
  J._resetFlowsForTest();
  run('show', { outputs: [{ cmd: S, ok: true, out: show('Activated').replace(/\s+Features: mon\(Activated\)/, '') }] });
  assert.equal(rec().state, 'inactive');
  J._resetFlowsForTest();
});

test('③ 반증 확정분 — 오래된 · 장비 상태가 불확실한 속도는 비운다(M-1)', async () => {
  const V = await import('../src/sanswitch/flowView.js');
  const A = await import('../src/sanswitch/attribution.js');
  const f = { name: 'dvc_s_01', hba: 'vmhba1', srcdev: INI, dstdev: T1, deviceId: 'swA', counters: { rxBytes: 2000, txBytes: 4000 }, lastAt: NOW - 1000, prevCounters: { rxBytes: 1000, txBytes: 2000 }, prevAt: NOW - 2000 };
  for (const state of ['gone', 'conflict', 'unknown', 'pending', 'inactive']) assert.deepEqual(V.flowRatesOf({ ...f, state }), { rxBps: null, txBps: null }, `${state} — 옛 속도를 지금으로 말하지 않는다`);
  const staleMs = V.staleMsOf(15 * 60_000);
  assert.equal(staleMs, 30 * 60_000); assert.equal(V.staleMsOf(0), 30 * 60_000); assert.equal(V.staleMsOf(10_000), 120_000, '주기 하한 1분');
  assert.deepEqual(V.flowRatesOf({ ...f, state: 'active' }, { now: NOW, staleMs }), { rxBps: 1000, txBps: 2000 });
  const old = { ...f, state: 'active', lastAt: NOW - staleMs - 1, prevAt: NOW - staleMs - 1001 };
  assert.deepEqual(V.flowRatesOf(old, { now: NOW, staleMs }), { rxBps: null, txBps: null, stale: true });
  const out = V.hostFlowOut(old, 'SW-A', { now: NOW, staleMs });
  assert.equal(out.stale, true); assert.equal(out.rxBps, null);
  assert.equal('stale' in V.hostFlowOut({ ...f, state: 'active' }, 'SW-A', { now: NOW, staleMs }), false);
  const port = (index, attached) => ({ index, slotPort: `0/${index}`, name: `p${index}`, state: 'online', attached, inBps: 100, outBps: 200 });
  const fabrics = A.buildFabrics([{ deviceId: 'swA', name: 'SW-A', collectedAt: NOW, ok: true, ports: { list: [port(0, [INI]), port(1, [T1])] },
    zoning: { available: true, zones: [{ name: 'Z1', members: [INI, T1] }] }, nsRoles: { [INI]: 'initiator', [T1]: 'target' } }]);
  const host = { id: 'vc:h1', name: 'esx1', vcenterId: 'vc', hbas: [{ name: 'vmhba1', wwn: INI }] };
  const row = A.attributeFleet([host], fabrics, { flowsOf: () => [out, V.hostFlowOut({ ...f, name: 'dvc_s_02', state: 'active' }, 'SW-A', { now: NOW, staleMs })] }).rows.find((x) => x.flow);
  assert.deepEqual(row.flow, { n: 2, measured: 1, stale: 1, rxBps: 1000, txBps: 2000 }, '오래된 것은 합에 넣지 않고 따로 센다');
});

test('③ 반증 확정분 — WWN 은 가리지 않는다(L-3) · 구버전 엣지는 OTP 전에 거부(L-4) · 화면 잠금 근거', async () => {
  const R = await import('../src/routes/api/sanFlow.js');
  const m = R.maskKeepWwn(`SrcDev: ${INI} DstDev: ${T1} via 10.1.2.3 fe80::1 https://sw9.example.invalid/x swt9.example.invalid`, ['swt9.example.invalid']);
  assert.ok(m.includes(INI) && m.includes(T1), m);
  assert.ok(!m.includes('10.1.2.3') && !m.includes('fe80::1') && !m.includes('swt9.example.invalid'), m);
  assert.equal(R.maskKeepWwn(null), null);
  assert.equal(R.maskKeepWwn('a \u00010\u0001 b'), 'a  b', '가짜 자리 표시는 남기지 않는다');
  // 라우트 — 구버전 엣지(2.937.0) 스위치
  fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'edge-old9', name: 'edge-old9', url: 'https://10.9.9.9:3001', token: 'synthetic-token-123456', enabled: true }] }));
  const { setCollectorStatus } = await import('../src/collector/state.js');
  setCollectorStatus('edge-old9', { ok: true, version: '2.937.0', agent: 'edge-old9' });
  const J = await import('../src/sanswitch/flowJobs.js');
  const reg = await import('../src/sanswitch/registry.js');
  const dev = reg.saveDevice({ type: 'brocade', name: 'SW-O', host: 'swo.example.invalid', username: 'admin', password: 'PW', collectMethod: 'ssh', agent: 'edge-old9' });
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify({ flows: [{ deviceId: dev.id, name: 'dvc_o000aaaaa_01', state: 'active', srcdev: INI, dstdev: T1, ingrport: '1/1',
    lastError: '카운터 형식을 알아보지 못했습니다', rawSample: `SrcDev ${INI} mgmt 10.4.4.4` }], checks: {} }));
  J._resetFlowsForTest();
  const express = (await import('express')).default;
  const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = { username: 'adm', role: 'admin' }; next(); });
  const api = express.Router(); R.registerSanFlow(api); app.use('/api', api);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/san-flow`;
  const x = await fetch(`${base}/deactivate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: dev.id, name: 'dvc_o000aaaaa_01' }) });
  assert.equal(x.status, 409, 'OTP 재인증(이 계정이면 403) 전에 엣지 버전을 본다 — 거부할 요청이 OTP 를 써 버리지 않게');
  assert.match((await x.json()).reason, /2\.939\.0 이상/);
  const g = await (await fetch(base)).json();
  const d = g.devices.find((v) => v.id === dev.id);
  assert.match(d.toggleIssue || '', /2\.939\.0 이상/, '화면이 비활성화 버튼을 미리 잠근다');
  assert.equal(d.edgeIssue, null, '다른 동작은 그대로');
  const fl = g.flows.find((v) => v.name === 'dvc_o000aaaaa_01');
  assert.ok(fl.rawSample.includes(INI) && !fl.rawSample.includes('10.4.4.4'), fl.rawSample);
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
  assert.deepEqual(measured.flow, { n: 1, measured: 1, stale: 0, rxBps: 1000, txBps: 2000 });
  const inactive = flowRows.find((x) => x.flow.measured === 0);
  assert.deepEqual(inactive.flow, { n: 1, measured: 0, stale: 0, rxBps: null, txBps: null }, '속도를 못 읽은 플로우는 개수에만');
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
  assert.equal(P.sanitizeHostSpath({ at: NOW, targets: [], unparsedSamples: [{ name: 'abc\u202Efdp.exe', why: 'format' }] }, NOW).unparsedSamples[0].name, 'abc fdp.exe', '반증 L-4: 양방향 제어문자 제거');
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
