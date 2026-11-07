/**
 * v2.934(SAN·CVP 설계 C-②) — Brocade Flow Vision 플로우 모니터(도구 키 san-flow · ‘운영 작업’) + 반증 1인 확정분 회귀.
 *  ① 명령 조립 — 이름(dvc_ · 20자 이하 · 소문자 — 반증 H-1) · 포트 · WWN 화이트리스트 · 주입 거부 · 지우기는 dvc_ 만 · 출력 분류(이름 글자에 반응하지 않음 — L-5) · 정규식 비용(L-6)
 *  ② 출력 판독 — 오류 분류 · 카운터 표 · 못 읽으면 parsed:false(0 으로 단정하지 않는다)
 *  ③ 작업 큐 — 비밀 없음 · 그 엣지만 · 남은 시한(ttlMs) · 회신 정제 · pending 먼저 · 시한 뒤 늦은 회신 반영(M-2) · exists 판정(M-3) · 못 읽은 카운터(M-4)
 *  ④ 실제 중앙 라우트 — sanswitch-config 의 flowNow · sanswitch-flow-result 의 agent 대조 · 기록 없는 dvc_(orphans)
 *  ⑤ 실제 화면 라우트 — admin · 조회 · 쓰기 전체 범위(L-1) · 점검 먼저(L-2) · OTP · 서버 재판정 · 중복 · 상한(L-3) · 주소 가림(L-4) · 기록 정리(L-11) · 미리보기 감사 제외(L-8)
 *  ⑥ 주기 — 꺼짐 · 인증 정지(H-2) · live 데모(M-1) · 등록부에 없음 · 오래된 것부터 · 상한(M-6) · 사용자 상한과 분리
 *  ⑦ 엣지 대행 — 정의로 명령을 다시 만든다 · 남은 시한 · 회신 실패 상태 · 버전 확인(M-7)
 */
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sanflow2934-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', CENTRAL_TOKEN: 'ctok-2934f' });
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
const N1 = 'dvc_esx1abc12_01'; const N2 = 'dvc_esx1abc12_02';
const createCmd = (name, dst = T1, port = '1/12') => `flow --create ${name} -feature monitor -ingrport ${port} -srcdev ${INI} -dstdev ${dst} -bidir`;
const writeReg = (o) => { fs.writeFileSync(path.join(DIR, 'san-flows.json'), JSON.stringify(o)); J._resetFlowsForTest(); };

test('① 명령 조립 — 20자 이름 · 화이트리스트 · 주입 거부 · 출력 분류 · 정규식 비용', () => {
  const a = C.flowNameFor('vc-a:h1', 'seoul-prod-cluster01-esx01.corp.local', 'vmhba1', 1);
  const b = C.flowNameFor('vc-a:h2', 'seoul-prod-cluster01-esx02.corp.local', 'vmhba1', 1);
  assert.ok(a.length <= C.FLOW_NAME_MAX && C.FLOW_NAME_RE.test(a), a);
  assert.notEqual(a, b, '같은 접두의 호스트도 이름이 다르다(해시)');
  assert.match(C.flowNameFor('x', 'A;rm -rf /', 'x$(id)', 7), /^dvc_[a-z0-9]+_07$/);
  assert.equal(C.FLOW_NAME_RE.test('dvc_' + 'a'.repeat(17)), false, '21자 거부');
  assert.equal(C.FLOW_NAME_RE.test('dvc_ESX1'), false, '대문자 거부(장비가 소문자로 저장)');
  const ok = { name: N1, ingrport: '1/12', srcdev: INI, dstdev: T1 };
  assert.equal(C.flowDefIssue(ok), null);
  for (const bad of [{ ...ok, name: 'ops_backup' }, { ...ok, name: 'dvc_x;reboot' }, { ...ok, name: 'dvc_' + 'a'.repeat(17) }, { ...ok, ingrport: '1/12 -feature x' },
    { ...ok, ingrport: '-1' }, { ...ok, srcdev: INI.toUpperCase() }, { ...ok, dstdev: `${T1};reboot` }, { ...ok, dstdev: '-50:00:09:73:00:00:00:01' }]) {
    assert.ok(C.flowDefIssue(bad), JSON.stringify(bad));
    assert.ok(C.buildFlowCommands('create', [bad]).issue, '형식 밖이면 명령을 만들지 않는다');
  }
  assert.deepEqual(C.buildFlowCommands('create', [ok]).cmds, [createCmd(N1), `flow --show ${N1}`]);
  assert.deepEqual(C.buildFlowCommands('delete', [{ name: N1 }]).cmds, [`flow --delete ${N1}`]);
  assert.ok(C.buildFlowCommands('delete', [{ name: 'sys_mon_all_fports' }]).issue, '사람 · 장비 플로우는 지우지 않는다');
  assert.deepEqual(C.buildFlowCommands('check').cmds, ['flow --show']);
  assert.ok(C.buildFlowCommands('reboot', [ok]).issue);
  assert.ok(C.buildFlowCommands('create', []).issue);
  assert.equal(C.buildFlowCommands('show', Array.from({ length: 40 }, (_, i) => ({ name: `dvc_h_${i}` }))).cmds.length, 16, '한 작업 16개 상한');
  assert.equal(C.flowLimitOf('DCX 8510-8'), 512); assert.equal(C.flowLimitOf('G620'), 128); assert.equal(C.flowLimitOf(''), 128, '모르면 작은 쪽');
  // 반증 L-5: 플로우 이름 · 표 줄의 글자에 반응하지 않는다
  assert.equal(C.flowOutputIssue('Flow dvc_failedhost_01 created and activated'), null);
  assert.equal(C.flowOutputIssue('Name : dvc_invalid01_01   Features: mon(Activated)'), null);
  assert.equal(C.flowOutputIssue('Flow Name | Feature\nops_restricted_mon | mon+\nduplicate_chk | mon+\n'), null);
  assert.equal(C.flowOutputIssue('rbash: flow: command not found').kind, 'no-command');
  // 반증 L-6: 'no … license' 가 길이의 제곱으로 커지지 않는다
  const big = `${'no x '.repeat(13_000)}license`;
  const t0 = process.hrtime.bigint(); C.flowOutputIssue(big); C.flowOutputIssue(`${'no '.repeat(5_000)}\n`.repeat(3) + 'license missing');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300, '64KB 입력이 선형');
});

test('② 출력 판독 — 오류 분류 · 카운터 · 못 읽음', () => {
  assert.equal(C.flowOutputIssue('Fabric Vision license not present').kind, 'license');
  assert.equal(C.flowOutputIssue('Permission denied: RBAC').kind, 'permission');
  assert.equal(C.flowOutputIssue('Flow already exists').kind, 'exists');
  assert.equal(C.flowOutputIssue('Flow does not exist').kind, 'missing');
  assert.equal(C.flowOutputIssue('Flow created and activated'), null);
  const show = `Name          : ${N1}   Features: mon(Activated)\n`
    + '| Rx Frames Count | Tx Frames Count | Rx Bytes Count | Tx Bytes Count | Rx Throughput(Bps) | Tx Throughput(Bps) |\n'
    + '|---|---|---|---|---|---|\n| 1,200 | 900 | 1.5g | 345k | 12m | 7 |\n';
  const p = C.parseFlowShow(show);
  assert.equal(p.parsed, true); assert.equal(p.name, N1); assert.equal(p.active, true);
  assert.deepEqual(p.counters, { rxFrames: 1200, txFrames: 900, rxBytes: 1.5e9, txBytes: 345e3, rxBps: 12e6, txBps: 7 });
  const g = C.parseFlowShow('something unexpected\nno table here');
  assert.equal(g.parsed, false); assert.equal(g.counters, null, '못 읽으면 0 이 아니라 null');
  assert.equal(C.countOf(''), null); assert.equal(C.countOf('abc'), null); assert.equal(C.countOf('1,234'), 1234);
  const l = C.parseFlowList(`Flow Name | Feature\nsys_mon_all_fports | mon+\n${N1} | mon+\nops_backup | mon+\n`);
  assert.deepEqual([l.total, l.portal], [3, 1]);
  const t0 = process.hrtime.bigint(); C.parseFlowShow(`| frames | bytes |\n${'|'.repeat(200_000)}`); C.flowOutputIssue('license '.repeat(50_000));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1500);
});

test('③ 작업 큐 — 비밀 없음 · 그 엣지만 · ttl · pending · 늦은 회신 · exists · 못 읽은 카운터', async () => {
  writeReg({ flows: [], checks: {} });
  const dev = { id: 'sw-edge', name: 'SW-E', host: 'sw.example.invalid', username: 'admin', password: 'PW-SECRET', agent: 'edge-a' };
  const def = { name: N1, ingrport: '1/12', srcdev: INI, dstdev: T1, hostId: 'vc-a:h1', hostName: 'esx1', hba: 'vmhba1', targetName: 'PMAX' };
  mock.timers.enable({ apis: ['setTimeout'] });
  let r;
  try {
    r = J.startFlowJob({ device: dev, action: 'create', flows: [def], user: 'adm' });
    assert.ok(r.id && r.target === 'edge-a');
    assert.equal(J.listFlows().find((f) => f.name === N1).state, 'pending', '반증 M-2: 실행 전에 기록을 먼저 쓴다');
    assert.equal(J.startFlowJob({ device: dev, action: 'show', flows: [def], user: 'adm' }).issue?.includes('진행 중'), true, '같은 스위치 동시 작업 금지');
    assert.deepEqual(J.takeFlowJobsForAgent('edge-b'), [], '다른 엣지는 못 가져간다');
    const got = J.takeFlowJobsForAgent('EDGE-A');
    assert.equal(got.length, 1);
    assert.equal(JSON.stringify(got).includes('PW-SECRET'), false, '큐 항목에 비밀 없음');
    assert.deepEqual(Object.keys(got[0]).sort(), ['action', 'deviceId', 'flows', 'id', 'ttlMs']);
    assert.ok(got[0].ttlMs > 0 && got[0].ttlMs < J.EDGE_DEADLINE_MS, '남은 시한(1분 여유)');
    assert.match(J.getFlowJob(r.id).trace.at(-1).msg, /응답에 실었습니다/, '가져갔다고 단정하지 않는다(M-7)');
    // 시한 — 결과 모름(failed 가 아님)
    mock.timers.tick(J.EDGE_DEADLINE_MS + 1);
  } finally { mock.timers.reset(); }
  let rec = J.listFlows().find((f) => f.name === N1);
  assert.equal(rec.state, 'unknown'); assert.match(rec.lastError, /만들어졌을 수 있습니다/);
  // 늦은 회신 — 반영한다(한 번)
  const res = { ok: true, outputs: [{ cmd: createCmd(N1), ok: true, out: `Flow ${N1} created` }, { cmd: 'reboot', ok: true, out: 'x' }, { cmd: `flow --show ${N1}`, ok: true, out: 'y'.repeat(100_000) }], extra: { a: 1 } };
  assert.equal(J.completeFlowJob(r.id, 'edge-b', res).ok, false, '대상 엣지가 아니면 거부');
  assert.equal(J.completeFlowJob(r.id, 'edge-a', res).late, true);
  rec = J.listFlows().find((f) => f.name === N1);
  assert.equal(rec.state, 'active');
  const done = J.getFlowJob(r.id);
  assert.deepEqual(done.result.outputs.map((o) => o.cmd), [createCmd(N1), `flow --show ${N1}`], '실행했어야 하는 명령만');
  assert.ok(done.result.outputs[1].out.length <= C.OUT_MAX);
  assert.equal('extra' in done.result, false);
  assert.equal(rec.lastError, '카운터 형식을 알아보지 못했습니다(원문은 작업 기록에)', '카운터를 못 읽으면 0 이 아니라 사유');
  assert.equal(rec.counters, undefined); assert.equal(rec.lastAt, undefined, '반증 M-4: 못 읽은 시도는 성공 시각을 움직이지 않는다'); assert.ok(rec.lastTryAt);
  assert.equal(J.completeFlowJob(r.id, 'edge-a', res).already, true, '두 번째 회신은 무시');

  // 반증 M-3: exists — show 에 초기자 · 타깃이 둘 다 보이면 활성, 아니면 conflict
  const r2 = J.startFlowJob({ device: dev, action: 'create', flows: [{ ...def, name: N2, dstdev: T2 }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r2.id, 'edge-a', { outputs: [{ cmd: createCmd(N2, T2), ok: false, out: `Flow ${N2} already exists` }, { cmd: `flow --show ${N2}`, ok: true, out: `Name : ${N2}\nSrcDev: ${INI} DstDev: ${T1}\n` }] });
  assert.equal(J.listFlows().find((f) => f.name === N2).state, 'conflict', '다른 타깃 정의면 활성으로 적지 않는다');
  const N3 = 'dvc_esx1abc12_03';
  const r3 = J.startFlowJob({ device: dev, action: 'create', flows: [{ ...def, name: N3, dstdev: T2 }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a');
  J.completeFlowJob(r3.id, 'edge-a', { outputs: [{ cmd: createCmd(N3, T2), ok: false, out: `Flow ${N3} already exists` }, { cmd: `flow --show ${N3}`, ok: true, out: `Name : ${N3}\nSrcDev: ${INI} DstDev: ${T2}\n` }] });
  assert.equal(J.listFlows().find((f) => f.name === N3).state, 'active', '같은 정의면 활성');
  // notRun(엣지가 실행하지 않음) → failed · 세션 중간 끊김(inFlight) → unknown
  const N4 = 'dvc_esx1abc12_04';
  const r4 = J.startFlowJob({ device: dev, action: 'create', flows: [{ ...def, name: N4 }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a'); J.completeFlowJob(r4.id, 'edge-a', { outputs: [], notRun: true, reason: '시한이 지나 실행하지 않았습니다' });
  assert.equal(J.listFlows().find((f) => f.name === N4).state, 'failed');
  const N5 = 'dvc_esx1abc12_05';
  const r5 = J.startFlowJob({ device: dev, action: 'create', flows: [{ ...def, name: N5 }], user: 'adm' });
  J.takeFlowJobsForAgent('edge-a'); J.completeFlowJob(r5.id, 'edge-a', { outputs: [], inFlight: createCmd(N5), reason: '세션 끊김' });
  assert.equal(J.listFlows().find((f) => f.name === N5).state, 'unknown');
  // 재시작 — 남은 pending 은 unknown(작업 기록이 사라졌다)
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'san-flows.json'), 'utf8'));
  raw.flows.push({ deviceId: 'sw-edge', name: 'dvc_esx1abc12_06', state: 'pending', srcdev: INI, dstdev: T1, ingrport: '1/12' });
  writeReg(raw);
  assert.equal(J.listFlows().find((f) => f.name === 'dvc_esx1abc12_06').state, 'unknown');
  // 반증 L-7: 지운 이름을 다시 쓰면 새 기록
  const raw2 = JSON.parse(fs.readFileSync(path.join(DIR, 'san-flows.json'), 'utf8'));
  raw2.flows.push({ deviceId: 'sw-edge', name: 'dvc_esx1abc12_07', state: 'deleted', deletedAt: NOW, deletedBy: 'old', createdAt: 1, prevCounters: { rxBytes: 9 } });
  writeReg(raw2);
  J.startFlowJob({ device: dev, action: 'create', flows: [{ ...def, name: 'dvc_esx1abc12_07' }], user: 'adm' });
  const recs = J.listFlows({ includeDeleted: true }).filter((f) => f.name === 'dvc_esx1abc12_07');
  assert.equal(recs.length, 1); assert.equal(recs[0].deletedBy, undefined); assert.equal(recs[0].prevCounters, undefined); assert.ok(recs[0].createdAt > 1);
  // 기록 파일 — 비밀 없음
  assert.equal(fs.readFileSync(path.join(DIR, 'san-flows.json'), 'utf8').includes('PW-SECRET'), false);
  J._resetFlowsForTest();
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
const hdr = (agent) => ({ 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2934f', 'X-Agent-Name': agent });

test('④ 실제 중앙 라우트 — flowNow · flow-result agent 대조 · 기록 없는 dvc_', async () => {
  writeReg({ flows: [{ deviceId: 'sw-edge2', name: N1, state: 'active', srcdev: INI, dstdev: T1, ingrport: '1/12' }], checks: {} });
  const dev = { id: 'sw-edge2', name: 'SW-E2', host: 'sw2.example.invalid', username: 'admin', password: 'PW2', agent: 'edge-a' };
  const r = J.startFlowJob({ device: dev, action: 'check', user: 'adm' });
  const cfgB = await (await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-config?agent=edge-b`, { headers: hdr('edge-b') })).json();
  assert.deepEqual(cfgB.flowNow, [], '다른 엣지 몫은 안 내려간다');
  const cfg = await (await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-config?agent=edge-a`, { headers: hdr('edge-a') })).json();
  assert.equal(cfg.flowNow.length, 1); assert.equal(cfg.flowNow[0].action, 'check'); assert.ok(cfg.flowNow[0].ttlMs > 0);
  assert.equal(JSON.stringify(cfg.flowNow).includes('PW2'), false);
  let x = await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-flow-result`, { method: 'POST', headers: hdr('edge-b'), body: JSON.stringify({ agent: 'edge-b', id: r.id, result: { ok: true, outputs: [] } }) });
  assert.equal(x.status, 404, '대상이 아닌 엣지의 회신은 거부');
  x = await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-flow-result`, { method: 'POST', headers: hdr('edge-a'),
    body: JSON.stringify({ agent: 'edge-a', id: r.id, result: { ok: true, outputs: [{ cmd: 'flow --show', ok: true, out: `Flow Name | Feature\nsys_mon_all_fports | mon+\nops_backup | mon+\n${N1} | mon+\ndvc_orphan9abcd_01 | mon+\n` }] } }) });
  assert.equal(x.status, 200);
  const ck = J.flowChecks()['sw-edge2'];
  assert.equal(ck.ok, true); assert.equal(ck.total, 4); assert.equal(ck.portal, 2);
  assert.deepEqual(ck.others, ['sys_mon_all_fports', 'ops_backup'], '사람이 만든 플로우는 이름만(보여 주기)');
  assert.deepEqual(ck.orphans, ['dvc_orphan9abcd_01'], '반증 M-2: 장비에 있는데 기록이 없는 dvc_');
  x = await fetch(`http://127.0.0.1:${cport}/api/central/sanswitch-flow-result`, { method: 'POST', headers: hdr('edge-a'), body: JSON.stringify({ agent: 'edge-a', id: 'nope', result: {} }) });
  assert.equal(x.status, 404);
});

test('⑤ 실제 화면 라우트 — 게이트 · 점검 먼저 · OTP · 서버 재판정 · 중복 · 상한 · 주소 가림 · 정리 · 감사 제외', async () => {
  writeReg({ flows: [], checks: {} });
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
  const body = (targets) => ({ deviceId: dev.id, hostId: 'vc-a:h1', hba: 'vmhba1', targets });

  let j = await (await fetch(base)).json();
  const d = j.devices.find((x) => x.id === dev.id);
  assert.equal(d.fv.state, 'yes'); assert.equal(d.limit, 128);
  assert.equal(JSON.stringify(j).includes('PWL'), false); assert.equal(JSON.stringify(j).includes('swl.example.invalid'), false, '관리 주소를 싣지 않는다');
  j = await (await fetch(`${base}/hosts?deviceId=${encodeURIComponent(dev.id)}`)).json();
  assert.deepEqual(j.hosts.map((h) => [h.id, h.hbas]), [['vc-a:h1', ['vmhba1']]]);
  j = await (await fetch(`${base}/candidates?hostId=${encodeURIComponent('vc-a:h1')}`)).json();
  assert.equal(j.hbas[0].port.slotPort, '1/12');

  // 반증 L-2: 권한 점검을 통과하지 않은 스위치에는 미리보기 · 만들기 거부
  let x = await post('/preview', body([T1]));
  assert.equal(x.status, 409); assert.match((await x.json()).reason, /권한 점검/);
  writeReg({ flows: [], checks: { [dev.id]: { at: NOW - 60_000, ok: true, total: 1, portal: 0, others: ['sys_mon_all_fports'], orphans: ['dvc_orphan9abcd_01'] } } });

  // 서버 재판정 — zone 밖 타깃 · 형식 밖 · 로그인 안 한 HBA
  x = await post('/create', body([OUTSIDE])); assert.equal(x.status, 400);
  x = await post('/create', body([`${T1} -bidir; reboot`])); assert.equal(x.status, 400);
  x = await post('/create', { ...body([T1]), hba: 'vmhba9' }); assert.equal(x.status, 409);
  // 미리보기 — 같은 판정 · 같은 명령 · 이름 20자
  const pv = await (await post('/preview', body([T1]))).json();
  assert.equal(pv.ok, true); assert.ok(C.FLOW_NAME_RE.test(pv.flows[0].name)); assert.equal(pv.cmds[0], `flow --create ${pv.flows[0].name} -feature monitor -ingrport 1/12 -srcdev ${INI} -dstdev ${T1} -bidir`);
  // OTP 재인증 — OTP 없는 · 소유자 아닌 admin 은 막힌다(설정 변경)
  user = { username: 'adm', role: 'admin' };
  assert.equal((await post('/create', body([T1]))).status, 403);
  assert.equal((await post('/delete', { deviceId: dev.id, name: 'dvc_orphan9abcd_01' })).status, 403);
  // 게이트 — operator · viewer · 조회 범위 admin · 반증 L-1: 쓰기 범위만 줄인 admin
  for (const u of [{ username: 'op', role: 'operator' }, { username: 'v', role: 'viewer' }, { username: 'sc', role: 'admin', scope: { vcenters: ['vc-a'] } },
    { username: 'wsc', role: 'admin', scope: { writeVcenters: ['vc-a'] } }]) {
    user = u;
    assert.equal((await fetch(base)).status, 403, JSON.stringify(u));
    assert.equal((await post('/check', { deviceId: dev.id })).status, 403, JSON.stringify(u));
  }
  // 정상 — 소유자 admin · 직접 수집 스위치는 이 포탈이 실행한다(닿지 않는 주소 → 실패로 닫힌다)
  user = { username: 'owner', role: 'admin' };
  x = await post('/create', body([T1, T2, T1]));
  assert.equal(x.status, 200);
  j = await x.json();
  assert.equal(j.flows.length, 2, '중복 타깃은 하나'); assert.ok(j.flows.every((f) => f.ingrport === '1/12' && f.srcdev === INI));
  let job = null;
  for (let i = 0; i < 100; i++) { job = (await (await fetch(`${base}/job/${j.id}`)).json()).job; if (job.status === 'done') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.status, 'done');
  assert.equal(JSON.stringify(job).includes('PWL'), false);
  assert.equal(JSON.stringify(job).includes('swl.example.invalid'), false, '반증 L-4: 작업 사유의 관리 주소를 가린다');
  assert.deepEqual(J.listFlows().filter((f) => f.deviceId === dev.id).map((f) => f.state), ['failed', 'failed'], '접속하지 못했으면 만들지 못함');
  j = await (await fetch(base)).json();
  assert.equal(JSON.stringify(j).includes('swl.example.invalid'), false);
  // 반증 M-3: 장비에 있을 수 있는 기록(결과 모름 · 만드는 중 · 충돌)과 같은 정의는 거부 — 활성만 보면 이름만 바꿔 또 만들었다
  const ck0 = J.flowChecks()[dev.id];
  for (const st of ['unknown', 'pending', 'conflict']) {
    writeReg({ flows: [{ deviceId: dev.id, name: 'dvc_esx1prev0_01', state: st, srcdev: INI, dstdev: T1, ingrport: '1/12' }], checks: { [dev.id]: ck0 } });
    x = await post('/preview', body([T1]));
    assert.equal(x.status, 409, st); assert.match((await x.json()).reason, /dvc_esx1prev0_01\((unknown|conflict)\)/, '읽을 때 남은 pending 은 unknown 이 된다(재시작 규칙)');
  }
  writeReg({ flows: [], checks: { [dev.id]: ck0 } });
  // 기록 없는 dvc_(점검이 찾은 것) — 지울 수 있다 · 그 밖은 404
  assert.equal((await post('/delete', { deviceId: dev.id, name: 'dvc_orphan9abcd_01' })).status, 200);
  assert.equal((await post('/delete', { deviceId: dev.id, name: 'dvc_nothere_01' })).status, 404);
  assert.equal((await post('/delete', { deviceId: dev.id, name: 'sys_mon_all_fports' })).status, 400);
  // 반증 L-3: 상한 — 점검 때 장비가 센 개수 + 그 뒤에 만든 것
  await new Promise((r) => setTimeout(r, 300));
  writeReg({ flows: Array.from({ length: 30 }, (_, i) => ({ deviceId: dev.id, name: `dvc_bulk${String(i).padStart(4, '0')}_01`, state: 'active', createdAt: NOW, srcdev: '10:00:00:00:00:00:00:99', dstdev: T1, ingrport: '1/30' })),
    checks: { [dev.id]: { at: NOW - 60_000, ok: true, total: 70, portal: 0, others: [] } } });
  x = await post('/preview', body([T1]));
  assert.equal(x.status, 200); assert.equal((await x.json()).known, 100, '사람 70 + 그 뒤 포탈 30(예전 max 로는 70)');
  writeReg({ flows: [], checks: { [dev.id]: { at: NOW, ok: true, total: 128, portal: 0 } } });
  x = await post('/preview', body([T1]));
  assert.equal(x.status, 409); assert.match((await x.json()).reason, /상한\(128\)/);
  // 반증 L-11: 등록부에 없는 스위치의 기록만 정리(장비 명령 없음) · 등록부에 있으면 거부
  writeReg({ flows: [{ deviceId: 'gone-sw', name: 'dvc_gone12345_01', state: 'active' }, { deviceId: dev.id, name: N1, state: 'active' }], checks: {} });
  assert.equal((await post('/forget', { deviceId: 'gone-sw', name: 'dvc_gone12345_01' })).status, 200);
  assert.equal(J.listFlows().some((f) => f.name === 'dvc_gone12345_01'), false);
  assert.equal((await post('/forget', { deviceId: dev.id, name: N1 })).status, 409);
  // 반증 L-8: 미리보기는 감사 줄을 남기지 않는다
  const { auditSkipped } = await import('../src/audit.js');
  assert.equal(auditSkipped('POST', '/api/tools/san-flow/preview'), true);
  assert.equal(auditSkipped('POST', '/api/tools/san-flow/create'), false);
});

test('⑥ 주기 — 꺼짐 · 인증 정지 · live 데모 · 등록부 없음 · 오래된 것부터 · 상한 · 사용자 상한과 분리', async () => {
  const { sanAuthGuard } = await import('../src/sanswitch/poller.js');
  const mk = (id, extra = {}) => ({ id, name: id, host: `${id}.invalid`, username: 'u', password: 'p', agent: 'edge-z', ...extra });
  const flows = [];
  for (let i = 0; i < 70; i++) flows.push({ deviceId: `sw${i}`, name: `dvc_p${String(i).padStart(3, '0')}aaaaa_01`, state: 'active', lastTryAt: NOW - (70 - i) * 1000, srcdev: INI, dstdev: T1, ingrport: '1/1' });
  for (const id of ['sw-off', 'sw-auth', 'mock-san-x', 'sw-gone']) flows.push({ deviceId: id, name: `dvc_${id.replace(/[^a-z0-9]/g, '')}zz_01`, state: 'active', lastTryAt: 0, srcdev: INI, dstdev: T1, ingrport: '1/1' });
  writeReg({ flows, checks: {} });
  sanAuthGuard.markAuthStopped('sw-auth', mk('sw-auth'), '인증 실패');
  const deviceOf = (id) => (id === 'sw-gone' ? null : id === 'sw-off' ? mk(id, { enabled: false }) : mk(id));
  const started = J.scheduleFlowShows(deviceOf, {});
  const cyc = J.lastShowCycle();
  assert.equal(started, 64, '주기 작업 상한');
  assert.deepEqual(cyc.skipped, { '등록부에 없음': 1, '꺼짐': 1, '데모 장비(live)': 1, '인증 실패 정지': 1, '주기 작업 상한': 6 });
  const queued = new Set(J.recentFlowJobs(100).map((j) => j.deviceId));
  assert.ok(queued.has('sw0') && !queued.has('sw69'), '오래전에 읽은 스위치부터');
  // 사용자 작업은 주기 작업 상한과 따로 센다(반증 M-6)
  const r = J.startFlowJob({ device: mk('sw-user'), action: 'check', user: 'adm' });
  assert.ok(r.id, `주기 작업 64개가 있어도 사용자 작업은 된다: ${r.issue}`);
  // 엣지가 올린 인증 정지도 건너뛴다
  writeReg({ flows: [{ deviceId: 'sw-e', name: 'dvc_edgestop1_01', state: 'active', srcdev: INI, dstdev: T1, ingrport: '1/1' }], checks: {} });
  assert.equal(J.scheduleFlowShows(() => mk('sw-e'), { stoppedOf: () => ({ reason: '엣지 정지' }) }), 0);
  assert.equal(J.lastShowCycle().skipped['인증 실패 정지'], 1);
  // 반증 M-1: live 모드 데모 장비는 사용자 작업으로도 접속하지 않는다
  assert.match(J.startFlowJob({ device: mk('mock-san-y', { agent: '' }), action: 'check', user: 'adm' }).issue, /데모/);
  const rr = await J.runFlowCommands(mk('mock-san-y'), ['flow --show']);
  assert.equal(rr.notRun, true);
  J._resetFlowsForTest();
});

test('⑦ 속도 · 부분 합 · 엣지 버전 · 엣지 대행 소스', async () => {
  const R = await import('../src/routes/api/sanFlow.js');
  // 반증 M-4: 못 읽은 카운터는 0 이 아니다
  assert.equal(R.rateOf({ rxBytes: 2000 }, { rxBytes: 1000 }, 2000, 1000, 'rxBytes'), 1000);
  assert.equal(R.rateOf({ rxBytes: null }, { rxBytes: null }, 2000, 1000, 'rxBytes'), null);
  assert.equal(R.rateOf({ rxBytes: 2000 }, { rxBytes: null }, 2000, 1000, 'rxBytes'), null);
  assert.equal(R.rateOf({ rxBytes: 500 }, { rxBytes: 1000 }, 2000, 1000, 'rxBytes'), null, '리셋');
  // 반증 M-5: ESXi 실측은 읽기 · 쓰기 둘 다 있을 때만
  assert.equal(R.esxiBpsOf({ rKBps: 10, wKBps: 5 }), 15 * 1024);
  assert.equal(R.esxiBpsOf({ rKBps: 10, wKBps: null }), null);
  // 반증 M-7: 구버전 엣지
  assert.match(R.flowEdgeIssue('edge-a', '2.932.0'), /2\.934\.0 이상/);
  assert.equal(R.flowEdgeIssue('edge-a', '2.934.0'), null);
  assert.equal(R.flowEdgeIssue('edge-a', ''), null, '모르면 보낸다(시한이 지나면 결과 모름)');
  const src = fs.readFileSync(new URL('../src/agent/sanSwitchConfigPull.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function runDelegatedFlow'), src.indexOf('export function startSanSwitchConfigPull'));
  assert.ok(fn.includes('buildFlowCommands('), '엣지가 명령을 직접 만든다');
  assert.ok(fn.includes('getDeviceWithSecret('), '자기 등록부의 장치 · 자격증명');
  assert.ok(fn.includes('withHostLock('), '같은 호스트 세션을 겹치지 않는다');
  assert.ok(/Date\.now\(\) > deadline/.test(fn), '남은 시한이 지나면 실행하지 않는다');
  assert.ok(fn.includes('_flowLast = { at: Date.now(), ok: false'), '회신 실패를 상태에 남긴다');
  assert.equal(/\bj\.cmds\b|\bcmds:\s*j\./.test(fn), false, '중앙이 보낸 명령 글자를 쓰지 않는다');
  // 세션 시한 — 4분 상한 < 엣지 시한
  assert.ok(J.flowSessionMs(40) <= 4 * 60_000);
  assert.ok(J.flowSessionMs(40) < J.EDGE_DEADLINE_MS);
  // 반증 H-2: 인증 실패는 정지 기록에 남긴다(로그인 전 실패 · 폴러와 같은 기록)
  const fsrc = fs.readFileSync(new URL('../src/sanswitch/flowJobs.js', import.meta.url), 'utf8');
  assert.match(fsrc, /isSanAuthError\(e\)[\s\S]{0,120}sanAuthGuard\.markAuthStopped/);
});
