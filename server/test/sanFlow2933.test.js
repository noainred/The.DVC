/**
 * v2.933(SAN·CVP 설계 C-②) — Brocade Flow Vision 플로우 모니터(도구 키 san-flow · ‘운영 작업’).
 *  ① 명령 조립 — 이름(dvc_ 고정) · 포트 · WWN 화이트리스트 · 주입 시도는 명령을 만들지 않는다 · 지우기는 dvc_ 만
 *  ② 출력 판독 — 오류 분류(라이선스 · 명령 없음 · 권한 · 이미 있음 · 없음) · 카운터 표 · 못 읽으면 parsed:false(0 으로 단정하지 않는다)
 *  ③ 작업 큐 — 엣지 위임 스위치는 큐(비밀 없음) · 그 엣지만 가져가고 회신한다 · 회신은 그 작업이 실행했어야 하는 명령 출력만
 *  ④ 실제 중앙 라우트 — sanswitch-config 의 flowNow · sanswitch-flow-result 의 agent 대조
 *  ⑤ 실제 화면 라우트 — admin · 전체 범위 · tools 권한 · 만들기 · 지우기 OTP 재인증 · 서버가 포트 · 타깃을 다시 판정 · 상한
 *  ⑥ 엣지 대행 — 중앙 문자열이 아닌 정의로 명령을 다시 만든다(형식 밖 정의는 실행하지 않고 사유를 회신)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sanflow2933-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', CENTRAL_TOKEN: 'ctok-2929f' });
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { viewer: ['dashboard', 'tools', 'inv.hosts'], operator: ['dashboard', 'tools', 'inv.hosts'] } }));
// 설정 소유자 = OTP 가 없는 계정의 재인증 경로(routes/api/reauth.js) — 'owner' 만 통과, 'adm' 은 막힌다.
fs.writeFileSync(path.join(DIR, 'security-session.json'), JSON.stringify({ settingsOwners: ['owner'] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const C = await import('../src/sanswitch/flowCmd.js');
const J = await import('../src/sanswitch/flowJobs.js');
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const INI = '10:00:00:10:9b:00:00:01'; const T1 = '50:00:09:73:00:00:00:01'; const T2 = '58:cc:f0:00:00:00:00:c0'; const OUTSIDE = '50:00:09:73:00:00:00:99';

test('① 명령 조립 — 화이트리스트 · 주입 거부 · dvc_ 만 지운다', () => {
  assert.equal(C.flowNameFor('ESX-US-003.corp.local', 'vmhba1', 1), 'dvc_esxus003_vmhba1_01');
  assert.match(C.flowNameFor('a;rm -rf /', 'x$(id)', 7), /^dvc_[a-z0-9]+_[a-z0-9]+_07$/);
  const ok = { name: 'dvc_esx1_vmhba1_01', ingrport: '1/12', srcdev: INI, dstdev: T1 };
  assert.equal(C.flowDefIssue(ok), null);
  for (const bad of [{ ...ok, name: 'ops_backup' }, { ...ok, name: 'dvc_x;reboot' }, { ...ok, name: 'dvc_' + 'a'.repeat(41) }, { ...ok, ingrport: '1/12 -feature x' },
    { ...ok, ingrport: '-1' }, { ...ok, srcdev: INI.toUpperCase() }, { ...ok, dstdev: `${T1};reboot` }, { ...ok, dstdev: '-50:00:09:73:00:00:00:01' }]) {
    assert.ok(C.flowDefIssue(bad), JSON.stringify(bad));
    assert.ok(C.buildFlowCommands('create', [bad]).issue, '형식 밖이면 명령을 만들지 않는다');
  }
  assert.deepEqual(C.buildFlowCommands('create', [ok]).cmds, [`flow --create dvc_esx1_vmhba1_01 -feature monitor -ingrport 1/12 -srcdev ${INI} -dstdev ${T1} -bidir`, 'flow --show dvc_esx1_vmhba1_01']);
  assert.deepEqual(C.buildFlowCommands('delete', [{ name: 'dvc_esx1_vmhba1_01' }]).cmds, ['flow --delete dvc_esx1_vmhba1_01']);
  assert.ok(C.buildFlowCommands('delete', [{ name: 'sys_mon_all_fports' }]).issue, '사람 · 장비 플로우는 지우지 않는다');
  assert.deepEqual(C.buildFlowCommands('check').cmds, ['flow --show']);
  assert.ok(C.buildFlowCommands('reboot', [ok]).issue);
  assert.ok(C.buildFlowCommands('create', []).issue);
  assert.equal(C.buildFlowCommands('show', Array.from({ length: 40 }, (_, i) => ({ name: `dvc_h_a_${i}` }))).cmds.length, 16, '한 작업 16개 상한');
  assert.equal(C.flowLimitOf('DCX 8510-8'), 512); assert.equal(C.flowLimitOf('G620'), 128); assert.equal(C.flowLimitOf(''), 128, '모르면 작은 쪽');
});

test('② 출력 판독 — 오류 분류 · 카운터 · 못 읽음', () => {
  assert.equal(C.flowOutputIssue('Fabric Vision license not present').kind, 'license');
  assert.equal(C.flowOutputIssue('rbash: flow: command not found').kind, 'no-command');
  assert.equal(C.flowOutputIssue('Permission denied: RBAC').kind, 'permission');
  assert.equal(C.flowOutputIssue('Flow dvc_a already exists').kind, 'exists');
  assert.equal(C.flowOutputIssue('Flow dvc_a does not exist').kind, 'missing');
  assert.equal(C.flowOutputIssue('Flow dvc_a created and activated'), null);
  const show = 'Name          : dvc_a_b_01   Features: mon(Activated)\n'
    + '| Rx Frames Count | Tx Frames Count | Rx Bytes Count | Tx Bytes Count | Rx Throughput(Bps) | Tx Throughput(Bps) |\n'
    + '|---|---|---|---|---|---|\n| 1,200 | 900 | 1.5g | 345k | 12m | 7 |\n';
  const p = C.parseFlowShow(show);
  assert.equal(p.parsed, true); assert.equal(p.name, 'dvc_a_b_01'); assert.equal(p.active, true);
  assert.deepEqual(p.counters, { rxFrames: 1200, txFrames: 900, rxBytes: 1.5e9, txBytes: 345e3, rxBps: 12e6, txBps: 7 });
  const g = C.parseFlowShow('something unexpected\nno table here');
  assert.equal(g.parsed, false); assert.equal(g.counters, null, '못 읽으면 0 이 아니라 null');
  assert.equal(C.countOf(''), null); assert.equal(C.countOf('abc'), null); assert.equal(C.countOf('1,234'), 1234);
  const l = C.parseFlowList('Flow Name | Feature\nsys_mon_all_fports | mon+\ndvc_a_b_01 | mon+\nops_backup | mon+\n');
  assert.deepEqual([l.total, l.portal], [3, 1]);
  // ReDoS — 긴 입력도 선형(상한으로 자른다)
  const t0 = process.hrtime.bigint(); C.parseFlowShow(`| frames | bytes |\n${'|'.repeat(200_000)}`); C.flowOutputIssue('license '.repeat(50_000));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500);
});

test('③ 작업 큐 — 위임 스위치는 큐 · 비밀 없음 · 그 엣지만 · 회신 정제', async () => {
  J._resetFlowsForTest();
  const dev = { id: 'sw-edge', name: 'SW-E', host: 'sw.example.invalid', username: 'admin', password: 'PW-SECRET', agent: 'edge-a' };
  const flows = [{ name: 'dvc_esx1_vmhba1_01', ingrport: '1/12', srcdev: INI, dstdev: T1, hostId: 'vc-a:h1', hostName: 'esx1', hba: 'vmhba1', targetName: 'PMAX' }];
  const r = J.startFlowJob({ device: dev, action: 'create', flows, user: 'adm' });
  assert.ok(r.id && r.target === 'edge-a');
  assert.equal(J.startFlowJob({ device: dev, action: 'show', flows, user: 'adm' }).issue?.includes('진행 중'), true, '같은 스위치 동시 작업 금지');
  assert.deepEqual(J.takeFlowJobsForAgent('edge-b'), [], '다른 엣지는 못 가져간다');
  const got = J.takeFlowJobsForAgent('EDGE-A');
  assert.equal(got.length, 1);
  assert.equal(JSON.stringify(got).includes('PW-SECRET'), false, '큐 항목에 비밀 없음');
  assert.deepEqual(Object.keys(got[0]).sort(), ['action', 'deviceId', 'flows', 'id']);
  assert.equal(J.getFlowJob(r.id).status, 'dispatched');
  assert.equal(JSON.stringify(J.getFlowJob(r.id)).includes('PW-SECRET'), false, '화면 응답에도 비밀 없음');
  assert.equal(J.completeFlowJob(r.id, 'edge-b', { ok: true, outputs: [] }).ok, false, '대상 엣지가 아니면 거부');
  const create = `flow --create dvc_esx1_vmhba1_01 -feature monitor -ingrport 1/12 -srcdev ${INI} -dstdev ${T1} -bidir`;
  const res = { ok: true, outputs: [{ cmd: create, ok: true, out: 'Flow dvc_esx1_vmhba1_01 created' }, { cmd: 'reboot', ok: true, out: 'x' }, { cmd: 'flow --show dvc_esx1_vmhba1_01', ok: true, out: 'y'.repeat(100_000) }], extra: { a: 1 } };
  assert.equal(J.completeFlowJob(r.id, 'edge-a', res).ok, true);
  const done = J.getFlowJob(r.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result.outputs.map((o) => o.cmd), [create, 'flow --show dvc_esx1_vmhba1_01'], '실행했어야 하는 명령만');
  assert.ok(done.result.outputs[1].out.length <= C.OUT_MAX);
  assert.equal('extra' in done.result, false);
  const rec = J.listFlows().find((f) => f.name === 'dvc_esx1_vmhba1_01');
  assert.equal(rec.state, 'active'); assert.equal(rec.lastError, '카운터 형식을 알아보지 못했습니다(원문은 작업 기록에)', '카운터를 못 읽으면 0 이 아니라 사유');
  assert.equal(rec.counters, undefined);
  assert.equal(J.completeFlowJob(r.id, 'edge-a', res).already, true, '두 번째 회신은 무시');
  // 기록 파일 — 원자적 쓰기 · 비밀 없음
  const file = fs.readFileSync(path.join(DIR, 'san-flows.json'), 'utf8');
  assert.equal(file.includes('PW-SECRET'), false);
});

let central; let cport;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  cport = await new Promise((r) => central.listen(0, '127.0.0.1', () => r(central.address().port)));
  closers.push(() => new Promise((r) => central.close(() => r())));
});
const hdr = (agent) => ({ 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2929f', 'X-Agent-Name': agent });

test('④ 실제 중앙 라우트 — flowNow · flow-result agent 대조', async () => {
  J._resetFlowsForTest();
  const dev = { id: 'sw-edge2', name: 'SW-E2', host: 'sw2.example.invalid', username: 'admin', password: 'PW2', agent: 'edge-a' };
  const r = J.startFlowJob({ device: dev, action: 'check', user: 'adm' });
  const cfgB = await (await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-config?agent=edge-b`, { headers: hdr('edge-b') })).json();
  assert.deepEqual(cfgB.flowNow, [], '다른 엣지 몫은 안 내려간다');
  const cfg = await (await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-config?agent=edge-a`, { headers: hdr('edge-a') })).json();
  assert.equal(cfg.flowNow.length, 1); assert.equal(cfg.flowNow[0].action, 'check');
  assert.equal(JSON.stringify(cfg.flowNow).includes('PW2'), false);
  let x = await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-flow-result`, { method: 'POST', headers: hdr('edge-b'), body: JSON.stringify({ agent: 'edge-b', id: r.id, result: { ok: true, outputs: [] } }) });
  assert.equal(x.status, 404, '대상이 아닌 엣지의 회신은 거부');
  x = await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-flow-result`, { method: 'POST', headers: hdr('edge-a'),
    body: JSON.stringify({ agent: 'edge-a', id: r.id, result: { ok: true, outputs: [{ cmd: 'flow --show', ok: true, out: 'Flow Name | Feature\nsys_mon_all_fports | mon+\nops_backup | mon+\ndvc_a_b_01 | mon+\n' }] } }) });
  assert.equal(x.status, 200);
  const ck = J.flowChecks()['sw-edge2'];
  assert.equal(ck.ok, true); assert.equal(ck.total, 3); assert.equal(ck.portal, 1);
  assert.deepEqual(ck.others, ['sys_mon_all_fports', 'ops_backup'], '사람이 만든 플로우는 이름만(보여 주기)');
  x = await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-flow-result`, { method: 'POST', headers: hdr('edge-a'), body: JSON.stringify({ agent: 'edge-a', id: 'nope', result: {} }) });
  assert.equal(x.status, 404);
});

test('⑤ 실제 화면 라우트 — 게이트 · OTP · 서버 재판정 · 상한', async () => {
  J._resetFlowsForTest();
  const reg = await import('../src/sanswitch/registry.js');
  const sst = await import('../src/sanswitch/store.js');
  const dev = reg.saveDevice({ type: 'brocade', name: 'SW-L', host: 'swl.example.invalid', username: 'admin', password: 'PWL', collectMethod: 'ssh' });
  sst.putSnapshot({ deviceId: dev.id, name: 'SW-L', model: 'G620', collectedAt: NOW, ok: true, licenses: [{ name: 'Fabric Vision', expires: '' }],
    ports: { list: [{ index: 12, slotPort: '1/12', name: 'p12', state: 'online', attached: [INI] }, { index: 20, slotPort: '1/20', state: 'online', attached: [T1] }, { index: 21, slotPort: '1/21', state: 'online', attached: [T2] }] },
    zoning: { available: true, zones: [{ name: 'Z1', members: [INI, T1] }, { name: 'Z2', members: [INI, T2] }] }, nsRoles: { [INI]: 'initiator', [T1]: 'target', [T2]: 'target' } });
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc-a', name: 'vc-a' }],
    hosts: [{ id: 'vc-a:h1', name: 'esx1.corp.local', vcenterId: 'vc-a', hbas: [{ name: 'vmhba1', wwn: INI, type: 'FC' }] }], vms: [], datastores: [] };
  closers.push(async () => { store.snapshot = prev; });
  const express = (await import('express')).default;
  const R = await import('../src/routes/api/sanFlow.js');
  let user = { username: 'owner', role: 'admin' };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerSanFlow(api); app.use('/api', api);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/san-flow`;
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  let j = await (await fetch(base)).json();
  const d = j.devices.find((x) => x.id === dev.id);
  assert.equal(d.fv.state, 'yes'); assert.equal(d.limit, 128);
  assert.equal(JSON.stringify(j).includes('PWL'), false); assert.equal(JSON.stringify(j).includes('swl.example.invalid'), false, '관리 주소를 싣지 않는다');
  j = await (await fetch(`${base}/hosts?deviceId=${encodeURIComponent(dev.id)}`)).json();
  assert.deepEqual(j.hosts.map((h) => [h.id, h.hbas]), [['vc-a:h1', ['vmhba1']]]);
  j = await (await fetch(`${base}/candidates?hostId=${encodeURIComponent('vc-a:h1')}`)).json();
  assert.equal(j.hbas[0].port.slotPort, '1/12');
  assert.deepEqual(j.hbas[0].targets.flatMap((t) => t.wwns).sort(), [T1, T2].sort());

  // 서버 재판정 — zone 밖 타깃 · 형식 밖 · 로그인 안 한 HBA
  let x = await post('/create', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [OUTSIDE] });
  assert.equal(x.status, 400);
  x = await post('/create', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [`${T1} -bidir; reboot`] });
  assert.equal(x.status, 400);
  x = await post('/create', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba9', targets: [T1] });
  assert.equal(x.status, 409);
  // OTP 재인증 — OTP 없는 · 소유자 아닌 admin 은 막힌다(설정 변경)
  user = { username: 'adm', role: 'admin' };
  x = await post('/create', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [T1] });
  assert.equal(x.status, 403);
  x = await post('/delete', { deviceId: dev.id, name: 'dvc_a_b_01' });
  assert.equal(x.status, 403);
  // 게이트 — operator · 범위 계정 · viewer
  for (const u of [{ username: 'op', role: 'operator' }, { username: 'v', role: 'viewer' }, { username: 'sc', role: 'admin', scope: { vcenters: ['vc-a'] } }]) {
    user = u;
    assert.equal((await fetch(base)).status, 403, JSON.stringify(u));
    assert.equal((await post('/check', { deviceId: dev.id })).status, 403, JSON.stringify(u));
  }
  // 정상 — 소유자 admin · 직접 수집 스위치(엣지 없음)는 이 포탈이 실행한다(이 테스트에서는 닿지 않는 주소 → 실패로 닫힌다)
  user = { username: 'owner', role: 'admin' };
  x = await post('/create', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [T1, T2, T1] });
  assert.equal(x.status, 200);
  j = await x.json();
  assert.deepEqual(j.flows.map((f) => [f.name, f.ingrport, f.srcdev, f.dstdev]), [['dvc_esx1_vmhba1_01', '1/12', INI, T1], ['dvc_esx1_vmhba1_02', '1/12', INI, T2]], '중복 타깃은 하나 · 포트는 서버가 정한다');
  // 미리보기 — 만들기와 같은 판정 · 같은 명령(스위치는 건드리지 않는다)
  let pv = await (await post('/preview', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [T1] })).json();
  assert.equal(pv.ok, true); assert.equal(pv.cmds[0].startsWith('flow --create dvc_esx1_vmhba1_'), true); assert.equal(pv.limit, 128);
  // 지우기 — 기록에 없는 이름 · dvc_ 아닌 이름
  assert.equal((await post('/delete', { deviceId: dev.id, name: 'sys_mon_all_fports' })).status, 400);
  // 작업 조회 — 끝날 때까지(닿지 않는 주소)
  let job = null;
  for (let i = 0; i < 100; i++) { job = (await (await fetch(`${base}/job/${j.id}`)).json()).job; if (job.status === 'done') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.status, 'done');
  assert.equal(JSON.stringify(job).includes('PWL'), false);
  const recs = J.listFlows().filter((f) => f.deviceId === dev.id);
  assert.deepEqual(recs.map((f) => f.state), ['failed', 'failed'], '만들지 못하면 활성으로 적지 않는다');
  // 같은 정의 중복 — 활성 기록이 있으면 거부(이름만 바꿔 또 만들지 않는다)
  { const raw0 = JSON.parse(fs.readFileSync(path.join(DIR, 'san-flows.json'), 'utf8'));
    raw0.flows.push({ deviceId: dev.id, name: 'dvc_esx1_vmhba1_09', state: 'active', srcdev: INI, dstdev: T2, ingrport: '1/12' });
    fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify(raw0)); J._resetFlowsForTest(); }
  x = await post('/preview', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [T2] });
  assert.equal(x.status, 409); assert.match((await x.json()).reason, /dvc_esx1_vmhba1_09/);
  // 상한 — 기존 128 이 있다고 점검이 말하면 거부
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'san-flows.json'), 'utf8'));
  raw.checks[dev.id] = { at: NOW, ok: true, total: 128, portal: 0 };
  fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify(raw));
  J._resetFlowsForTest();
  x = await post('/create', { deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets: [T1] });
  assert.equal(x.status, 409); assert.match((await x.json()).reason, /상한\(128\)/);
});

test('⑥ 엣지 대행 — 정의로 명령을 다시 만든다 · 형식 밖이면 실행하지 않는다', async () => {
  const src = fs.readFileSync(new URL('../src/agent/sanSwitchConfigPull.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function runDelegatedFlow'), src.indexOf('export function startSanSwitchConfigPull'));
  assert.ok(fn.includes('buildFlowCommands('), '엣지가 명령을 직접 만든다');
  assert.ok(fn.includes('getDeviceWithSecret('), '자기 등록부의 장치 · 자격증명');
  assert.ok(fn.includes('withHostLock('), '같은 호스트 세션을 겹치지 않는다');
  assert.equal(/\bj\.cmds\b|\bcmds:\s*j\./.test(fn), false, '중앙이 보낸 명령 글자를 쓰지 않는다');
  // 형식 밖 정의 → issue(실행 안 함)
  assert.ok(C.buildFlowCommands('create', [{ name: 'dvc_a_b_01', ingrport: '1/1', srcdev: INI, dstdev: 'x; reboot' }]).issue);
  // 세션 시한 — 4분 상한(엣지 회신 시한 5분 안)
  assert.ok(J.flowSessionMs(40) <= 4 * 60_000);
  assert.ok(J.flowSessionMs(40) < J.EDGE_RESULT_MS);
});
