// v2.793 VM 백업 센터 — 이력·복원 지점·검증·복구·법인(엣지) 위임·ESXi NFS 데이터스토어 회귀 고정.
//
// 사용자 요구(2026-10-26): "VM 복제(백업) 도구를 Veeam 처럼" + "법인별로 — 법인 vCenter 와 법인 NFS 를 따로" +
//   "백업 NFS 는 엣지 노드에 마운트된 NFS 를 쓰거나, NFS 를 ESXi 데이터스토어로 붙여 클론".
// 여기서 고정하는 것(되돌리면 사고가 나는 것만):
//   · 위임 잡 동기화는 **중앙이 담당이라고 확인한 vCenter 의 잡만** 지운다(빈 목록·담당 미확정으로 백업이 멈추지 않게).
//   · 엣지 보고는 아는 필드만·상한·글자만, 남의 vCenter 잡·남의 작업 회신은 버린다.
//   · 작업 회신에는 시한이 있고, 시한이 지난 복구·연결은 다시 내려보내지 않는다.
//   · NIC 를 끊는 spec 은 장치를 그대로 되돌려 보내고 connectable 만 바꾼다 · 끊김 확인 판정.
//   · 복구 입력 검증(원본 이름 금지 · 네트워크를 끊지 않은 VM 자동 켜기 금지).
//   · 엣지 워커의 진입 함수(syncVmCloneNow)를 가짜 중앙에 실제로 붙여 본다(규약: push/pull 진입 함수는 실제로 호출한다).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmclone2793-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'mock';   // 실행기는 vCenter 에 접속하지 않고 시뮬레이션한다(워커 왕복 테스트용)

// 가짜 중앙 — 워커가 붙을 주소를 import 전에 정한다(config 는 import 시점에 env 를 읽는다).
const central = { syncBody: null, reports: [] };
const srv = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    if (req.url.startsWith('/api/central/vm-clone-sync')) {
      central.lastSyncHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(central.syncBody || { ok: true, vcenters: [], jobs: [], ops: [] }));
    }
    if (req.url.startsWith('/api/central/vm-clone-report')) {
      const b = JSON.parse(buf || '{}');
      central.reports.push(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, acked: (b.acks || []).map((a) => a.id) }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}');
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.CENTRAL_URL = `http://127.0.0.1:${srv.address().port}`;
process.env.CENTRAL_TOKEN = 'edge-a-token';
process.env.AGENT_NAME = 'edge-a';
fs.writeFileSync(path.join(TMP, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc-site', name: 'VA', host: 'https://vc-site.invalid', username: 'u', password: 'p' }] }));

const store = await import('../src/vmclone/store.js');
const dispatch = await import('../src/vmclone/dispatch.js');
const vs = await import('../src/vmclone/vsphere.js');
const ops = await import('../src/vmclone/vsOps.js');
const { dueJobsOf } = await import('../src/vmclone/scheduler.js');
const { mergeJobView, edgeMountsView, scopeCloneStatus } = await import('../src/routes/api/vmClone.js');

test.after(() => { srv.close(); });

const def = (o = {}) => ({ id: 'cj-1', vcenterId: 'vc-site', vmId: 'vc-site:vm-1', vmName: 'web-07', dest: { type: 'datastore', datastoreName: 'DS-BK' }, schedule: { mode: 'daily', time: '02:00' }, keep: 3, quiesce: false, enabled: true, verifyAfter: true, ...o });

test('이력 — 백업마다 한 줄(최근 30) · 스냅샷 경고 덧붙이기는 같은 줄 · 검증·복구는 lastRun 을 바꾸지 않는다', () => {
  const j = store.saveJob({ vcenterId: 'vc-local', vmId: 'vc-local:vm-9', vmName: 'db-01', dest: { type: 'datastore', datastoreName: 'D' }, verifyAfter: true });
  assert.equal(j.verifyAfter, true);
  for (let i = 0; i < 33; i++) store.recordRun(j.id, { ok: true, detail: `run ${i}`, ms: 10, trigger: 'schedule', phases: [{ n: '클론', ms: 5 }, { n: '', ms: 1 }, { n: 'x', ms: -1 }] });
  let cur = store.getJob(j.id);
  assert.equal(cur.history.length, store.HISTORY_MAX);
  assert.equal(cur.history.at(-1).detail, 'run 32');
  assert.deepEqual(cur.history.at(-1).phases, [{ n: '클론', ms: 5 }], '이름 없는 단계·음수 ms 는 버린다');
  store.recordRun(j.id, { ok: true, detail: 'run 32 ⚠ 스냅샷 삭제 실패', ms: 10, history: false });
  cur = store.getJob(j.id);
  assert.equal(cur.history.length, store.HISTORY_MAX, '한 실행이 두 줄이 되지 않는다');
  assert.match(cur.history.at(-1).detail, /스냅샷 삭제 실패/);
  const lastAt = cur.lastRun.at;
  store.recordJobEvent(j.id, { kind: 'verify', ok: false, detail: 'Tools 무응답' });
  store.recordJobEvent(j.id, { kind: 'bogus', ok: true, detail: '무시' });
  cur = store.getJob(j.id);
  assert.equal(cur.lastRun.at, lastAt, '검증 기록이 스케줄 판정(lastRun)을 바꾸면 안 된다');
  assert.equal(cur.history.at(-1).kind, 'verify');
  // NFS 대상은 자동 검증을 켤 수 없다(켤 VM 이 없다)
  assert.equal(store.normalizeJobDef({ ...def(), dest: { type: 'nfs', mountId: 'm1' }, verifyAfter: true }).verifyAfter, false);
});

test('원장 부가 정보 — 크기·검증은 원장에 있는 ref 만 · 작업 기록은 같은 id 를 고쳐 쓴다', () => {
  const j = store.saveJob({ vcenterId: 'vc-local', vmId: 'vc-local:vm-10', vmName: 'app-1', dest: { type: 'datastore', datastoreName: 'D' } });
  store.recordRun(j.id, { ok: true, detail: 'x', ms: 1, addClone: { name: 'app-1-bak', ref: 'vm-500', at: 1 } });
  assert.equal(store.patchClone(j.id, 'vm-404', { bytes: 5 }), false, '지어내지 않는다');
  assert.equal(store.patchClone(j.id, 'vm-500', { bytes: '1024', verify: { ok: true, detail: '부팅 확인' } }), true);
  const c = store.getJob(j.id).clones[0];
  assert.equal(c.bytes, 1024); assert.equal(c.verify.ok, true);
  store.recordOp({ id: 'op-1', kind: 'restore', ok: false, detail: '시한' });
  store.recordOp({ id: 'op-1', kind: 'restore', ok: true, detail: '늦은 회신' });
  const mine = store.listOps().filter((o) => o.id === 'op-1');
  assert.equal(mine.length, 1); assert.equal(mine[0].ok, true);
});

test('위임 잡 동기화 — 담당 확인된 vCenter 만 지운다 · 원장·이력은 보존 · 로컬 잡과 같은 VM 은 받지 않는다', () => {
  let r = store.applyDelegatedJobs([def(), def({ id: 'cj-2', vcenterId: 'vc-other', vmId: 'vc-other:vm-1' })], ['vc-site']);
  assert.equal(r.added, 1); assert.equal(r.invalid.length, 1, '담당이 아닌 vCenter 의 정의는 받지 않는다');
  const j = store.getJob('cj-1');
  assert.equal(j.origin, 'central');
  assert.throws(() => store.saveJob({ ...def(), id: 'cj-1', keep: 9 }), /중앙에서 위임/);
  assert.throws(() => store.deleteJob('cj-1'), /중앙에서 위임/);
  store.recordRun('cj-1', { ok: true, detail: 'ok', ms: 1, addClone: { name: 'web-07-bak', ref: 'vm-77', at: 5 } });
  // 정의가 바뀌면 고치되 원장·이력은 그대로
  r = store.applyDelegatedJobs([def({ keep: 5 })], ['vc-site']);
  assert.equal(r.updated, 1);
  assert.equal(store.getJob('cj-1').keep, 5);
  assert.equal(store.getJob('cj-1').clones.length, 1);
  // 담당을 모르는 동안(빈 vcenters)의 빈 목록은 아무것도 지우지 않는다
  r = store.applyDelegatedJobs([], []);
  assert.equal(r.removed, 0); assert.ok(store.getJob('cj-1'));
  // 무효 정의가 와도 그 id 는 지우지 않는다(이전 정의로 계속 돈다)
  r = store.applyDelegatedJobs([{ id: 'cj-1', vcenterId: 'vc-site' }], ['vc-site']);
  assert.equal(r.removed, 0); assert.equal(r.invalid.length, 1); assert.equal(store.getJob('cj-1').keep, 5);
  // 실행 중 기록이 남은 잡은 정의가 빠져도 정리가 끝날 때까지 둔다
  store.setRunning('cj-1', { snapName: 'portal-clone-x', phase: 'snapshot' });
  r = store.applyDelegatedJobs([], ['vc-site']);
  assert.equal(r.removed, 0);
  store.clearRunning('cj-1');
  r = store.applyDelegatedJobs([], ['vc-site']);
  assert.equal(r.removed, 1, '담당 확인 + 목록에 없음 → 정의만 지운다');
  // 이 노드가 직접 만든 같은 VM 의 잡이 있으면 받지 않는다
  store.saveJob({ vcenterId: 'vc-site', vmId: 'vc-site:vm-1', vmName: 'web-07', dest: { type: 'datastore', datastoreName: 'D' } });
  r = store.applyDelegatedJobs([def()], ['vc-site']);
  assert.equal(r.added, 0); assert.equal(r.conflicts.length, 1);
});

test('잡 파일 손상 → 로드 오류(위임 동기화가 503 으로 답할 근거) · 관리자 저장이 푼다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmclone2793-corrupt-'));
  fs.writeFileSync(path.join(dir, 'vm-clone.json'), '{ broken');
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const s = await import(${JSON.stringify(new URL('../src/vmclone/store.js', import.meta.url).href)});
    const a = !!s.jobsLoadError();
    s.saveJob({ vcenterId: 'v', vmId: 'v:1', vmName: 'n', dest: { type: 'datastore', datastoreName: 'D' } });
    console.log(JSON.stringify({ a, b: !!s.jobsLoadError() }));
  `], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.a, true, '손상이면 오류'); assert.equal(r.b, false, '관리자 저장 뒤 해제');
});

test('실행 위치 — 직접=중앙 · 위임=등록 담당 우선 · 관측과 다르면 충돌(어느 쪽에도 맡기지 않음) · 모르면 none · 데모=중앙', () => {
  const T = dispatch.execTargetOf;
  assert.deepEqual(T({ id: 'a', collectMode: 'direct' }), { where: 'local' });
  assert.deepEqual(T({ id: 'a', collectMode: 'site', remoteAgent: 'edge-a' }, ''), { where: 'edge', agent: 'edge-a' });
  assert.deepEqual(T({ id: 'a', collectMode: 'site' }, 'edge-b'), { where: 'edge', agent: 'edge-b' });
  assert.deepEqual(T({ id: 'a', collectMode: 'site', remoteAgent: 'Edge-A' }, 'edge-a'), { where: 'edge', agent: 'Edge-A' }, '대소문자만 다르면 같은 엣지');
  assert.equal(T({ id: 'a', collectMode: 'site', remoteAgent: 'edge-a' }, 'edge-b').where, 'conflict');
  assert.equal(T({ id: 'a', collectMode: 'site' }, '').where, 'none');
  assert.equal(T(undefined).where, 'none');
  assert.deepEqual(T({ id: 'a', collectMode: 'site', remoteAgent: 'edge-a' }, '', { mock: true }), { where: 'local', corpAgent: 'edge-a' }, '데모: 실행은 이 노드, 묶음만 데모 엣지');
  assert.deepEqual(T({ id: 'a' }, '', { mock: true }), { where: 'local' });
  const simCorps = dispatch.corpsOf([{ id: 'a', collectMode: 'site', remoteAgent: 'edge-a' }], dispatch.execTargets([{ id: 'a', collectMode: 'site', remoteAgent: 'edge-a' }], [], { mock: true }));
  assert.deepEqual(simCorps.map((c) => [c.key, c.agent, c.simulated]), [['edge:edge-a', '', true]]);
  const vcs = [{ id: 'c1' }, { id: 's1', collectMode: 'site', remoteAgent: 'edge-a' }, { id: 's2', collectMode: 'site' }, { id: 's3', collectMode: 'site', remoteAgent: 'edge-a' }];
  const tg = dispatch.execTargets(vcs, [{ vcenterId: 's2', agent: '' }]);
  const corps = dispatch.corpsOf(vcs, tg);
  assert.deepEqual(corps.map((c) => c.key), ['central', 'edge:edge-a', 'unassigned']);
  assert.deepEqual(corps[1].vcenterIds, ['s1', 's3']);
  assert.match(corps[2].problem, /담당 엣지를 아직 모릅니다/);
});

test('엣지 보고 정제 — 아는 필드만·상한·글자만 · 문자열 수치는 수로 · 객체가 아니면 버린다', () => {
  const big = 'x'.repeat(5000);
  const c = dispatch.sanitizeReport({
    proto: '1', version: '2.793.0', evil: { a: 1 },
    jobs: [{ id: 'cj-1', lastRun: { at: '100', ok: true, detail: big, ms: '5' }, history: [{ at: 1, kind: 'hack', ok: 1, detail: 'd', phases: [{ n: 'a', ms: '3' }, 'x'] }, 'nope'],
      clones: [{ ref: 'vm-1', name: 'n', at: 2, bytes: '1024', verify: { ok: true, detail: 'ok', at: 3 }, password: 'secret' }, { ref: '', name: 'n', at: 1 }], extra: 'drop' }, null, { id: '' }],
    mounts: [{ id: 'm1', label: '10.0.0.1:/bk', mounted: true, freeBytes: '100', totalBytes: 0 }],
    acks: [{ id: 'op-1', ok: true, detail: 'd', hosts: [{ hostId: 'h1', ok: true, detail: 'x' }, {}], newName: 'r' }],
    inflight: ['op-2', 5], runner: { running: { jobId: 'cj-1', kind: 'backup', phase: big, startedAt: '7' }, queued: ['cj-2', {}] },
  });
  assert.equal(c.proto, 1);
  assert.equal(c.jobs.length, 1);
  assert.equal(c.jobs[0].lastRun.detail.length, 400);
  assert.equal(c.jobs[0].lastRun.at, 100);
  assert.equal(c.jobs[0].history.length, 1); assert.equal(c.jobs[0].history[0].kind, 'backup'); assert.equal(c.jobs[0].history[0].ok, false, 'ok 는 true 일 때만');
  assert.deepEqual(c.jobs[0].history[0].phases, [{ n: 'a', ms: 3 }]);
  assert.equal(c.jobs[0].clones.length, 1); assert.equal(c.jobs[0].clones[0].bytes, 1024);
  assert.equal(JSON.stringify(c).includes('secret'), false); assert.equal(JSON.stringify(c).includes('drop'), false);
  assert.deepEqual(c.mounts, [{ id: 'm1', label: '10.0.0.1:/bk', mounted: true, freeBytes: 100 }], 'total 0 은 모름(싣지 않음)');
  assert.deepEqual(c.acks[0].hosts, [{ hostId: 'h1', ok: true, detail: 'x' }]);
  assert.deepEqual(c.inflight, ['op-2']);
  assert.equal(c.runner.running.phase.length, 120); assert.deepEqual(c.runner.queued, ['cj-2']);
  assert.deepEqual(dispatch.sanitizeReport(null).jobs, []);
});

test('보고 수신 — 이 엣지 담당 vCenter 의 중앙 잡만 · 회신은 이 엣지의 작업만 · 시한 지난 작업은 닫고 늦은 회신은 결과만 고친다', () => {
  dispatch._resetDispatchForTest();
  const cj = store.saveJob({ vcenterId: 'vc-s1', vmId: 'vc-s1:vm-1', vmName: 'web', dest: { type: 'datastore', datastoreName: 'D' } });
  const other = store.saveJob({ vcenterId: 'vc-s2', vmId: 'vc-s2:vm-1', vmName: 'web2', dest: { type: 'datastore', datastoreName: 'D' } });
  const targets = dispatch.execTargets([{ id: 'vc-s1', collectMode: 'site', remoteAgent: 'edge-a' }, { id: 'vc-s2', collectMode: 'site', remoteAgent: 'edge-b' }], []);
  const opA = dispatch.createOp({ kind: 'verify', jobId: cj.id, vcenterId: 'vc-s1', spec: { ref: 'vm-1' }, target: targets.get('vc-s1') }, 1000);
  const opB = dispatch.createOp({ kind: 'restore', jobId: other.id, vcenterId: 'vc-s2', spec: { ref: 'vm-2', newName: 'r' }, target: targets.get('vc-s2') }, 1000);
  assert.deepEqual(dispatch.takeOps('edge-b', 1000).map((o) => o.id), [opB.id], '남의 작업은 인출하지 않는다');
  assert.deepEqual(dispatch.takeOps('EDGE-A', 1000).map((o) => o.id), [opA.id]);
  assert.deepEqual(dispatch.takeOps('edge-a', 1001), [], '한 번 인출한 작업은 다시 주지 않는다(복구가 두 번 만들어지지 않게)');
  const clean = dispatch.sanitizeReport({ jobs: [{ id: cj.id, lastRun: { at: 5, ok: true } }, { id: other.id, lastRun: { at: 5, ok: true } }, { id: 'unknown' }], acks: [{ id: opA.id, ok: true, detail: '부팅 확인' }, { id: opB.id, ok: true, detail: '위조' }] });
  const r = dispatch.ingestReport('edge-a', clean, targets, 2000);
  assert.equal(r.jobs, 1); assert.equal(r.droppedJobs, 2);
  assert.deepEqual(r.acked, [opA.id]); assert.equal(r.droppedAcks, 1);
  assert.equal(dispatch._opsForTest().get(opB.id).state, 'running', '남의 회신으로 닫히지 않는다');
  // 진행 보고가 끊기면 CLAIM_MS 뒤 '결과 미확인' 으로 닫는다
  dispatch.reapOps(1000 + dispatch.CLAIM_MS + 1);
  const b = dispatch._opsForTest().get(opB.id);
  assert.equal(b.state, 'done'); assert.equal(b.result.ok, false); assert.match(b.result.detail, /결과 미확인/);
  assert.equal(dispatch.ackOp('edge-b', opB.id, { ok: true, detail: '늦게 끝남' }, 99_999_999), true);
  assert.equal(dispatch._opsForTest().get(opB.id).result.late, true);
  // 아무도 가져가지 않은 작업은 PENDING_TTL_MS 뒤 닫는다
  const opC = dispatch.createOp({ kind: 'run', jobId: cj.id, vcenterId: 'vc-s1', target: targets.get('vc-s1') }, 0);
  dispatch.reapOps(dispatch.PENDING_TTL_MS + 1);
  assert.match(dispatch._opsForTest().get(opC.id).result.detail, /가져가지 않았습니다/);
  // 범위 필터
  const view = dispatch.listOpsView({ allowed: new Set(['vc-s1']) });
  assert.ok(view.length >= 2); assert.ok(view.every((o) => o.vcenterId === 'vc-s1'));
});

test('동기화 응답 — 이 엣지 담당 vCenter 의 잡 정의만(실행 상태·데모 잡 제외)', () => {
  const targets = dispatch.execTargets([{ id: 'vc-s1', collectMode: 'site', remoteAgent: 'edge-a' }, { id: 'vc-c', collectMode: 'direct' }], []);
  const jobs = [
    { id: 'a', vcenterId: 'vc-s1', vmId: 'v', vmName: 'n', dest: { type: 'datastore', datastoreName: 'D' }, schedule: { mode: 'manual' }, keep: 2, clones: [{ ref: 'x' }], history: [1], lastRun: { at: 1 } },
    { id: 'b', vcenterId: 'vc-s1', vmId: 'w', vmName: 'm', dest: { type: 'datastore', datastoreName: 'D' }, schedule: { mode: 'manual' }, keep: 2, demo: true },
    { id: 'c', vcenterId: 'vc-c', vmId: 'z', vmName: 'k', dest: { type: 'datastore', datastoreName: 'D' }, schedule: { mode: 'manual' }, keep: 2 },
  ];
  const p = dispatch.syncPayloadFor('edge-a', jobs, targets);
  assert.deepEqual(p.vcenters, ['vc-s1']);
  assert.deepEqual(p.jobs.map((j) => j.id), ['a']);
  assert.equal('clones' in p.jobs[0] || 'history' in p.jobs[0] || 'lastRun' in p.jobs[0], false);
  assert.deepEqual(dispatch.syncPayloadFor('edge-z', jobs, targets), { vcenters: [], jobs: [] });
});

test('NIC 끊기 spec — 장치를 그대로 되돌려 보내고 connectable 만 바꾼다 · 끊김 확인 판정', () => {
  const dev = '<VirtualDevice xsi:type="VirtualDisk"><key>2000</key></VirtualDevice>' +
    '<VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><deviceInfo><label>Network adapter 1</label></deviceInfo>' +
    '<backing xsi:type="VirtualEthernetCardDistributedVirtualPortBackingInfo"><port><switchUuid>50 1a</switchUuid><portgroupKey>dvportgroup-9</portgroupKey></port></backing>' +
    '<connectable><startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>true</connected><status>ok</status></connectable>' +
    '<controllerKey>100</controllerKey><macAddress>00:50:56:aa</macAddress></VirtualDevice>' +
    '<VirtualDevice xsi:type="VirtualE1000"><key>4001</key><backing xsi:type="VirtualEthernetCardNetworkBackingInfo"><deviceName>VM Network</deviceName></backing><controllerKey>100</controllerKey></VirtualDevice>';
  const { specXml, count } = vs.nicDisconnectSpec(dev);
  assert.equal(count, 2);
  assert.match(specXml, /<device xsi:type="VirtualVmxnet3"><key>4000<\/key>/);
  assert.match(specXml, /<portgroupKey>dvportgroup-9<\/portgroupKey>/, 'DVS backing 을 비우지 않는다');
  assert.match(specXml, /<connectable><startConnected>false<\/startConnected><allowGuestControl>true<\/allowGuestControl><connected>false<\/connected><\/connectable><controllerKey>100/);
  assert.match(specXml, /VirtualE1000"><key>4001<\/key>.*<connectable><startConnected>false.*<\/connectable><controllerKey>100/, 'connectable 이 없던 NIC 는 controllerKey 앞에 넣는다');
  assert.equal(specXml.includes('VirtualDisk'), false, '디스크는 건드리지 않는다');
  assert.equal(vs.allNicsDisconnected(dev), false);
  const after = dev.replace('<startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>true</connected>', '<startConnected>false</startConnected><allowGuestControl>true</allowGuestControl><connected>false</connected>');
  assert.equal(vs.allNicsDisconnected(after), false, 'connectable 이 없는 NIC 는 끊겼다고 보지 않는다');
  assert.equal(vs.allNicsDisconnected(after.replace('<controllerKey>100</controllerKey></VirtualDevice>', '<connectable><startConnected>false</startConnected><connected>false</connected></connectable><controllerKey>100</controllerKey></VirtualDevice>')), true);
  assert.equal(vs.allNicsDisconnected('<VirtualDevice xsi:type="VirtualDisk"><key>1</key></VirtualDevice>'), true, 'NIC 가 없으면 참');
});

test('NFS 데이터스토어 정의 검증·요청 XML — 이름·서버·경로 화이트리스트 · NFS 3/4.1 요소 순서', () => {
  assert.throws(() => vs.validateNfsDsSpec({ name: '-bad', server: 'nas', exportPath: '/a' }), /이름/);
  assert.throws(() => vs.validateNfsDsSpec({ name: 'bk', server: '-oops', exportPath: '/a' }), /서버/);
  assert.throws(() => vs.validateNfsDsSpec({ name: 'bk', server: 'nas', exportPath: '/a/../etc' }), /경로/);
  assert.throws(() => vs.validateNfsDsSpec({ name: 'x'.repeat(43), server: 'nas', exportPath: '/a' }), /이름/);
  assert.equal(vs.validateNfsDsSpec({ name: 'bk', server: 'nas', exportPath: '/a', nfsVersion: 'x' }).nfsVersion, '3');
  const x3 = vs.nasDatastoreXml('datastoreSystem-1', { name: 'va-bk02', server: '10.20.1.50', exportPath: '/bk02' });
  assert.match(x3, /<remoteHost>10\.20\.1\.50<\/remoteHost><remotePath>\/bk02<\/remotePath><localPath>va-bk02<\/localPath><accessMode>readWrite<\/accessMode><type>NFS<\/type><\/spec>/);
  const x41 = vs.nasDatastoreXml('datastoreSystem-1', { name: 'b', server: 'nas', exportPath: '/e', nfsVersion: '4.1' });
  assert.match(x41, /<type>NFS41<\/type><remoteHostNames>nas<\/remoteHostNames><securityType>AUTH_SYS<\/securityType>/);
});

test('복구 입력 검증 — 원본 이름 금지 · 없는 데이터스토어·같은 이름 VM 거부 · 네트워크를 끊지 않은 VM 은 자동으로 켜지 않는다', () => {
  const job = { vcenterId: 'vc1', vmName: 'db-01' };
  const snap = { datastores: [{ vcenterId: 'vc1', name: 'DS1' }], vms: [{ vcenterId: 'vc1', name: 'taken' }] };
  const V = (s) => ops.validateRestoreSpec(job, s, snap);
  assert.throws(() => V({ newName: 'db-01', datastoreName: 'DS1' }), /원본과 같은 이름/);
  assert.throws(() => V({ newName: 'a/b', datastoreName: 'DS1' }), /쓸 수 없습니다/);
  assert.throws(() => V({ newName: 'r', datastoreName: 'DS9' }), /데이터스토어/);
  assert.throws(() => V({ newName: 'taken', datastoreName: 'DS1' }), /이미 있습니다/);
  assert.throws(() => V({ newName: 'r', datastoreName: 'DS1', nicDisconnect: false, powerOn: true }), /자동으로 켜지 않습니다/);
  assert.deepEqual(V({ newName: ' db-01-restore ', datastoreName: 'DS1' }), { newName: 'db-01-restore', datastoreName: 'DS1', nicDisconnect: true, powerOn: false }, '기본은 NIC 끊김 · 꺼진 상태');
});

test('단계 기록기 · 스케줄러는 이 노드가 위임한(site) vCenter 의 잡을 넣지 않는다', () => {
  const ph = ops.phaseRecorder();
  ph.step('a'); ph.step('b');
  const list = ph.end(false);
  assert.deepEqual(list.map((p) => p.n), ['a', 'b']); assert.equal(list[1].ok, false);
  const now = Date.now();
  const jobs = [{ id: 'x', vcenterId: 's', enabled: true, schedule: { mode: 'interval', hours: 1 }, lastRun: null }, { id: 'y', vcenterId: 'd', enabled: true, schedule: { mode: 'interval', hours: 1 }, lastRun: null }];
  const r = dueJobsOf(jobs, now, { mock: true, siteVcIds: new Set(['s']) });
  assert.deepEqual(r.run.map((j) => j.id), ['y']); assert.deepEqual(r.delegated.map((j) => j.id), ['x']);
});

test('화면용 병합 — 엣지 위임 잡은 엣지가 보고한 원장·이력 · 마운트 가림 · 작업 대기열 범위', () => {
  const job = { id: 'j', vcenterId: 's', vmName: 'w', clones: [], history: [] };
  const edge = { at: 9, runner: { running: { jobId: 'j', kind: 'backup', phase: '클론', startedAt: 3 } }, jobs: new Map([['j', { lastRun: { at: 1, ok: true }, history: [{ at: 1 }], clones: [{ ref: 'vm-1' }] }]]) };
  const v = mergeJobView(job, { where: 'edge', agent: 'edge-a' }, edge);
  assert.equal(v.clones[0].ref, 'vm-1'); assert.equal(v.exec.where, 'edge'); assert.equal(v.exec.reported, true); assert.equal(v.exec.runningPhase, '클론');
  const nr = mergeJobView(job, { where: 'edge', agent: 'edge-a' }, null);
  assert.equal(nr.exec.reported, false); assert.equal(nr.lastRun, null);
  assert.equal(mergeJobView(job, { where: 'conflict', reason: '불일치' }, null).exec.reason, '불일치');
  assert.deepEqual(edgeMountsView([{ id: 'm1', label: '10.1.1.1:/x', mounted: true, freeBytes: 5 }], { full: false }), [{ id: 'm1', label: 'NFS 마운트 m1', mounted: true, freeBytes: 5 }]);
  const st = scopeCloneStatus({ running: null, queued: [], queuedOps: [{ id: 'o1', kind: 'verify', jobId: 'j' }, { id: 'o2', kind: 'nfsds-attach', jobId: '' }] }, [job], [job, { id: 'k' }]);
  assert.deepEqual(st.queuedOps.map((o) => o.id), ['o1'], '잡 없는 작업(NFS 연결)은 범위 계정에 싣지 않는다');
});

test('엣지 워커 왕복 — 가짜 중앙에서 정의·작업을 받아 로컬에 맞추고 실행·보고·회신한다(진입 함수 실제 호출)', async () => {
  const { syncVmCloneNow, reportNow, vmCloneWorkerStatus } = await import('../src/agent/vmCloneWorker.js');
  central.syncBody = { ok: true, vcenters: ['vc-site'], jobs: [def({ id: 'cj-w', vmId: 'vc-site:vm-w', vmName: 'web-w', verifyAfter: false })], ops: [{ id: 'vco-1', kind: 'run', jobId: 'cj-w', vcenterId: 'vc-site', spec: {} }] };
  const r = await syncVmCloneNow();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(String(central.lastSyncHeaders['x-central-token'] || ''), /edge-a-token/);
  const j = store.getJob('cj-w');
  assert.ok(j && j.origin === 'central', '위임 잡으로 저장');
  // 'run' 회신(큐 등록)이 다음 보고에 실린다 — 작업이 끝나면 즉시 한 번 더 보고한다
  for (let i = 0; i < 40 && !central.reports.some((b) => (b.acks || []).some((a) => a.id === 'vco-1')); i++) await new Promise((res) => setTimeout(res, 100));
  const withAck = central.reports.find((b) => (b.acks || []).some((a) => a.id === 'vco-1'));
  assert.ok(withAck, '회신이 보고에 실린다');
  assert.equal(withAck.acks.find((a) => a.id === 'vco-1').ok, true);
  // 실행(데모 시뮬레이션 2초)이 끝나면 보고에 lastRun·원장이 실린다
  for (let i = 0; i < 60 && !store.getJob('cj-w')?.lastRun; i++) await new Promise((res) => setTimeout(res, 100));
  await reportNow();
  const last = central.reports.at(-1);
  const rj = last.jobs.find((x) => x.id === 'cj-w');
  assert.ok(rj?.lastRun?.ok, '실행 결과가 중앙으로 올라간다');
  assert.equal(rj.clones.length, 1);
  assert.equal(last.proto, 1);
  assert.ok(Array.isArray(last.mounts), '마운트 목록(0개여도)');
  assert.equal(vmCloneWorkerStatus().pendingAcks, 0, '중앙이 받은 회신은 지운다');
  // 0개여도 보고한다(무음 실패 금지) — 담당 vCenter 가 없어도 보고는 간다
  const before = central.reports.length;
  central.syncBody = { ok: true, vcenters: [], jobs: [], ops: [] };
  await syncVmCloneNow();
  assert.ok(central.reports.length > before);
  assert.ok(store.getJob('cj-w'), '담당 미확정(빈 vcenters)으로는 지우지 않는다');
});

// ── v2.793 반증 검토(F1~F6) 회귀 ─────────────────────────────────────────────
test('F1 — 점검중·꺼진 위임 vCenter 도 위임이다(중앙 스케줄러가 넣지 않는다)', async () => {
  const src = fs.readFileSync(new URL('../src/vmclone/scheduler.js', import.meta.url), 'utf8');
  assert.match(src, /v\?\.collectMode === 'site'/);
  assert.doesNotMatch(src, /directCollectSkipReason\(v\) === 'site'/, 'disabled·maintenance 를 먼저 돌려주는 판정으로 되돌리지 말 것');
  const rsrc = fs.readFileSync(new URL('../src/vmclone/runner.js', import.meta.url), 'utf8');
  assert.match(rsrc, /vcCfg\.collectMode === 'site'/);
  const r = dueJobsOf([{ id: 'm', vcenterId: 'vm-maint', enabled: true, schedule: { mode: 'interval', hours: 1 }, lastRun: null }], Date.now(), { mock: true, siteVcIds: new Set(['vm-maint']) });
  assert.deepEqual(r.run, []);
});

test('F2 — 잡 파일 로드 오류 중에는 실행·작업 기록이 빈 목록을 파일에 쓰지 않는다(관리자 저장만 쓴다)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmclone2793-f2-'));
  fs.writeFileSync(path.join(dir, 'vm-clone.json.corrupt.2026-10-26T00-00-00'), 'x');   // 재시작 뒤: 보존본만 남음
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    const s = await import(${JSON.stringify(new URL('../src/vmclone/store.js', import.meta.url).href)});
    const fs = await import('node:fs');
    const e1 = !!s.jobsLoadError();
    s.recordOp({ kind: 'nfsds-attach', ok: true, detail: 'x' });
    s.applyDelegatedJobs([], ['vc']);
    const wrote = fs.existsSync(${JSON.stringify(path.join(dir, 'vm-clone.json'))});
    s.saveJob({ vcenterId: 'v', vmId: 'v:1', vmName: 'n', dest: { type: 'datastore', datastoreName: 'D' } });
    console.log(JSON.stringify({ e1, wrote, after: fs.existsSync(${JSON.stringify(path.join(dir, 'vm-clone.json'))}), e2: !!s.jobsLoadError() }));
  `], { env: { ...process.env, CONFIG_DIR: dir }, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r, { e1: true, wrote: false, after: true, e2: false });
});

test('F3 — 담당이 아닌 vCenter 의 위임 잡은 멈춘다(지우지 않는다) · 담당이 돌아오면 푼다 · released 판정', () => {
  store.applyDelegatedJobs([def({ id: 'f3', vcenterId: 'vc-f3', vmId: 'vc-f3:vm', vmName: 'f3' })], ['vc-f3']);
  assert.equal(store.suspendDelegated(['vc-f3'], '담당 변경'), 1);
  assert.equal(store.getJob('f3').suspended, '담당 변경');
  const r = dueJobsOf([{ ...store.getJob('f3'), lastRun: null }], Date.now(), { mock: true });
  assert.deepEqual(r.run, [], '멈춘 잡은 스케줄되지 않는다');
  store.applyDelegatedJobs([], []);
  assert.ok(store.getJob('f3'), '원장·이력이 사라지지 않게 지우지 않는다');
  const back = store.applyDelegatedJobs([def({ id: 'f3', vcenterId: 'vc-f3', vmId: 'vc-f3:vm', vmName: 'f3' })], ['vc-f3']);
  assert.equal(back.resumed, 1); assert.equal(store.getJob('f3').suspended, undefined);
  const targets = dispatch.execTargets([{ id: 'a', collectMode: 'site', remoteAgent: 'edge-a' }, { id: 'b', collectMode: 'site', remoteAgent: 'edge-b' }, { id: 'c', collectMode: 'site', remoteAgent: 'edge-a' }], [{ vcenterId: 'c', agent: 'edge-z' }]);
  assert.deepEqual(dispatch.releasedFor('edge-a', ['a', 'b', 'c', 'gone', ''], targets), ['b', 'c', 'gone'], '다른 엣지·충돌·등록부에 없음');
});

test('F4·F6·부수 — 모르는 회신은 rejected 로 돌려준다 · 요청하지 않은 호스트 결과는 받지 않는다 · 담당이 바뀐 작업은 보내지 않는다', async () => {
  dispatch._resetDispatchForTest();
  const nfs = await import('../src/vmclone/nfsDs.js');
  const item = nfs.createNfsDs({ vcenterId: 'vc-s1', name: 'bk', server: 'nas', exportPath: '/e' });
  const targets = dispatch.execTargets([{ id: 'vc-s1', collectMode: 'site', remoteAgent: 'edge-a' }], []);
  const op = dispatch.createOp({ kind: 'nfsds-attach', vcenterId: 'vc-s1', spec: { nfsDsId: item.id, hostIds: ['h1'] }, target: targets.get('vc-s1') }, 10);
  dispatch.takeOps('edge-a', 11);
  const r = dispatch.ingestReport('edge-a', dispatch.sanitizeReport({ acks: [{ id: op.id, ok: true, hosts: [{ hostId: 'h1', ok: true }, { hostId: 'host-999', ok: true }] }, { id: 'vco-gone', ok: true }] }), targets, 20);
  assert.deepEqual(r.acked, [op.id]); assert.deepEqual(r.rejected, ['vco-gone']);
  assert.deepEqual(Object.keys(nfs.getNfsDs(item.id).hosts), ['h1']);
  const op2 = dispatch.createOp({ kind: 'run', jobId: 'x', vcenterId: 'vc-s1', target: targets.get('vc-s1') }, 30);
  assert.deepEqual(dispatch.takeOps('edge-a', 31, () => false), []);
  assert.match(dispatch._opsForTest().get(op2.id).result.detail, /담당 엣지가 바뀌어/);
});

test('F5 — 범위 계정에는 엣지 동기화 상세(다른 vCenter 의 VM 이름) 대신 개수만', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/vmClone.js', import.meta.url), 'utf8');
  assert.match(src, /sync: allowed && edge\.sync \? \{[^}]*conflicts: \(edge\.sync\.conflicts \|\| \[\]\)\.length/);
});
