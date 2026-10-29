/**
 * v2.794 VM 백업 센터 1회차(실장비 안전성) 회귀.
 *  S1 — 검증의 전원 켜기 태스크가 오류로 끝나도 VM 이 켜졌으면 끈다(전원 상태 실측).
 *  S2 — 재시작으로 중단된 검증: 기동 때 이력에 남기고, 새 검증을 막고, 정리(끄기 → 되돌리기 → 스냅샷 삭제)한 뒤 기록을 내린다.
 *  S3 — 정리를 못 하면 미루고(nextAt), 시한(RECOVER_GIVE_UP_MS)이 지나면 기록을 내리고 수동 정리를 안내한다.
 *  S4 — 복구 VM 은 NIC 가 끊긴 채로 태어난다(CloneSpec config 의 deviceChange — 순서: template 뒤·powerOn 앞).
 *  S5 — 뒷정리가 남은 잡은 지우지 않고(deleteJob), 엣지 위임 동기화도 지우지 않는다(applyDelegatedJobs). 스케줄러는 위임 vCenter 를 거른다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const u = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);

const JOB = (extra = {}) => ({
  id: 'j1', vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' },
  schedule: { mode: 'manual' }, keep: 3, quiesce: false, enabled: true,
  clones: [{ name: 'web01-bak-1', ref: 'vm-5', at: 1 }], lastRun: null, createdAt: 1, ...extra,
});

/** vsphere.js 를 가짜로 바꾼 자식 프로세스에서 body 를 돌린다(실제 store·vsOps·scheduler). */
function run(body, { jobs = [JOB()] } = {}) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2794-'));
  fs.writeFileSync(path.join(cfg, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcA', host: 'https://127.0.0.1:1', username: 'u', password: 'p' }] }));
  fs.writeFileSync(path.join(cfg, 'vm-clone.json'), JSON.stringify({ version: 1, jobs, ops: [] }));
  const script = `
    import { mock } from 'node:test';
    const calls = []; globalThis.CALLS = calls;
    globalThis.STATE = { powerState: 'poweredOff', name: 'web01-bak-1', snaps: [] };
    globalThis.FAIL = {};
    const step = (n, a) => { calls.push(n + (a ? ':' + a : '')); if (globalThis.FAIL[n]) throw new Error(globalThis.FAIL[n]); };
    mock.module(${u('vmclone/vsphere.js')}, { namedExports: {
      VimSoapClient: class { constructor(vc) { this.vc = vc; } async login() { step('login'); } async logout() {}
        async retrieveObjectProps(type, ref, props) {
          if (props.includes('snapshot')) { step('snapTree'); return [{ props: { snapshot: globalThis.STATE.snaps.map((s) => '<rootSnapshotList><snapshot type="VirtualMachineSnapshot">' + s.ref + '</snapshot><vm type="VirtualMachine">' + ref + '</vm><name>' + s.name + '</name></rootSnapshotList>').join('') } }]; }
          return [{ props: {} }];
        } },
      createSnapshot: async (c, ref, { name }) => { step('createSnapshot', name); globalThis.STATE.snaps.push({ ref: 'snapshot-1', name }); return 'snapshot-1'; },
      removeSnapshot: async (c, ref) => { step('removeSnapshot', ref); globalThis.STATE.snaps = globalThis.STATE.snaps.filter((s) => s.ref !== ref); },
      revertToSnapshot: async (c, ref) => { step('revert', ref); globalThis.STATE.powerState = 'poweredOff'; },
      vmStateOf: async (c, ref) => { step('vmStateOf', ref); if (globalThis.STATE.gone) throw new Error('VM 을 찾을 수 없습니다(' + ref + ')'); return { name: globalThis.STATE.name, powerState: globalThis.STATE.powerState, deviceXml: '<VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><connectable><startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>true</connected></connectable></VirtualDevice>' }; },
      disconnectAllNics: async (c, ref) => { step('disconnect', ref); return 1; },
      powerOnVm: async (c, ref) => { calls.push('powerOn'); if (globalThis.POWER_ON_BUT_FAIL) { globalThis.STATE.powerState = 'poweredOn'; throw new Error('전원 켜기 시간 초과(10분)'); } globalThis.STATE.powerState = 'poweredOn'; },
      powerOffVm: async (c, ref) => { step('powerOff', ref); globalThis.STATE.powerState = 'poweredOff'; },
      waitToolsRunning: async () => { step('tools'); return 30_000; },
      nicDisconnectSpec: () => ({ specXml: '<deviceChange>X</deviceChange>', count: 1 }),
      cloneFromSnapshot: async (c, o) => { step('clone', o.configXml || '(none)'); return 'vm-77'; },
      parentFolderOf: async () => 'group-v1', destroyClone: async () => ({ gone: true }),
      attachNasToHost: async () => ({ ok: true, detail: 'ok' }), detachNasFromHost: async () => ({ ok: true, detail: 'ok' }), validateNfsDsSpec: (s) => s, vmCommittedBytes: async () => null,
      vmFilePaths: async () => ({ vmx: '', files: [] }), parseDsPath: () => null, backupFileFilter: () => true,
      datacenterPathOf: async () => 'DC1', downloadDsFile: async () => 0,
    } });
    mock.module(${u('store.js')}, { namedExports: { store: { get: () => ({ datastores: [{ id: 'vcA:datastore-1', vcenterId: 'vcA', name: 'ds1' }], vms: [] }) } } });
    const st = await import(${u('vmclone/store.js')});
    const ops = await import(${u('vmclone/vsOps.js')});
    const sch = await import(${u('vmclone/scheduler.js')});
    const out = {};
    ${body}
    out.calls = calls;
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

test('S1: 전원 켜기 태스크가 오류로 끝나도 VM 이 켜졌으면 끄고 되돌린다 · 진행 기록을 내린다', () => {
  const out = run(`
    globalThis.POWER_ON_BUT_FAIL = true;
    out.r = await ops.verifyClone(st.getJob('j1'), 'vm-5');
    out.verifying = st.getJob('j1').verifying || null;
  `);
  assert.equal(out.r.ok, false);
  assert.match(out.r.detail, /전원 켜기 시간 초과/);
  const i = (n) => out.calls.findIndex((c) => c.startsWith(n));
  assert.ok(i('powerOff') > i('powerOn'), `켜기 뒤 끄기 — ${out.calls}`);
  assert.ok(i('revert') > i('powerOff'), '끈 뒤 되돌리기');
  assert.ok(i('removeSnapshot') > i('revert'), '되돌린 뒤 스냅샷 삭제');
  assert.equal(out.verifying, null, '뒷정리를 마쳤으면 진행 기록이 없다');
});

test('S1b: 정상 검증 — 스냅샷 전에 진행 기록을 남기고 끝나면 지운다 · 이미 꺼졌으면 다시 끄지 않는다', () => {
  const out = run(`
    out.r = await ops.verifyClone(st.getJob('j1'), 'vm-5');
    out.verifying = st.getJob('j1').verifying || null;
  `);
  assert.equal(out.r.ok, true, out.r.detail);
  assert.equal(out.verifying, null);
  assert.ok(out.calls.includes('powerOff:vm-5'), 'Tools 확인 뒤 켜진 사본을 끈다');
});

test('S2: 재시작으로 중단된 검증 — 이력에 남기고 · 새 검증을 막고 · 끄고 되돌리고 스냅샷을 지운 뒤 기록을 내린다', () => {
  const now = Date.now();
  const out = run(`
    globalThis.STATE.powerState = 'poweredOn';
    globalThis.STATE.snaps = [{ ref: 'snapshot-9', name: 'portal-verify-x' }];
    out.marked = st.markInterruptedVerifies();
    out.marked2 = st.markInterruptedVerifies();
    out.blocked = await ops.verifyClone(st.getJob('j1'), 'vm-5');
    out.due = sch.verifyCleanupJobsOf(st.listJobs(), Date.now()).map((j) => j.id);
    out.siteSkip = sch.verifyCleanupJobsOf(st.listJobs(), Date.now(), { siteVcIds: new Set(['vcA']) }).length;
    out.rec = await ops.recoverInterruptedVerify('j1');
    const j = st.getJob('j1');
    out.verifying = j.verifying || null;
    out.hist = j.history.map((h) => [h.kind, h.ok, h.trigger, h.skipped || '']);
    out.cloneVerify = j.clones[0].verify;
  `, { jobs: [JOB({ verifying: { ref: 'vm-5', cloneName: 'web01-bak-1', snapName: 'portal-verify-x', snapRef: 'snapshot-9', phase: 'power', at: now - 60_000, boot: 'old-boot' } })] });
  assert.equal(out.marked, 1); assert.equal(out.marked2, 0, '이미 남긴 기록은 다시 쓰지 않는다');
  assert.equal(out.blocked.ok, false); assert.match(out.blocked.detail, /뒷정리가 먼저/);
  assert.ok(!out.calls.some((c) => c.startsWith('createSnapshot')), '정리 전 새 검증용 스냅샷을 만들지 않는다');
  assert.deepEqual(out.due, ['j1']); assert.equal(out.siteSkip, 0, '위임(site) vCenter 의 잡은 이 노드가 정리하지 않는다');
  assert.equal(out.rec.ok, true, out.rec.detail);
  const seq = out.calls.filter((c) => /^(powerOff|revert|removeSnapshot)/.test(c));
  assert.deepEqual(seq, ['powerOff:vm-5', 'revert:snapshot-9', 'removeSnapshot:snapshot-9']);
  assert.equal(out.verifying, null);
  assert.deepEqual(out.hist[0], ['verify', false, 'restart', 'restart-interrupted']);
  assert.deepEqual(out.hist.at(-1).slice(0, 3), ['verify', true, 'restart']);
  assert.equal(out.cloneVerify.ok, false, '중단된 검증은 그 사본을 검증된 것으로 두지 않는다');
});

test('S2b: 기록한 사본 자리에 다른 이름의 VM 이 있으면 손대지 않는다 · 사본이 없어졌으면 기록만 내린다', () => {
  const rec = { ref: 'vm-5', cloneName: 'web01-bak-1', snapName: 'portal-verify-x', snapRef: 'snapshot-9', phase: 'power', at: Date.now() - 60_000, boot: 'old' };
  const other = run(`
    globalThis.STATE.name = 'prod-db'; globalThis.STATE.powerState = 'poweredOn';
    out.rec = await ops.recoverInterruptedVerify('j1');
  `, { jobs: [JOB({ verifying: rec })] });
  assert.equal(other.rec.ok, true);
  assert.match(other.rec.detail, /손대지 않았습니다/);
  assert.ok(!other.calls.some((c) => /^(powerOff|revert|removeSnapshot)/.test(c)), `다른 VM 은 끄지도 되돌리지도 않는다 — ${other.calls}`);
  const gone = run(`
    globalThis.STATE.gone = true;
    out.rec = await ops.recoverInterruptedVerify('j1');
    out.verifying = st.getJob('j1').verifying || null;
  `, { jobs: [JOB({ verifying: rec })] });
  assert.equal(gone.rec.ok, true); assert.equal(gone.verifying, null);
});

test('S3: 정리를 못 하면 미루고(다음 시각) · 시한이 지나면 기록을 내리고 수동 정리를 안내한다', () => {
  const rec = { ref: 'vm-5', cloneName: 'web01-bak-1', snapName: 'portal-verify-x', snapRef: 'snapshot-9', phase: 'power', at: Date.now() - 60_000, boot: 'old' };
  const out = run(`
    globalThis.FAIL.login = 'connect ECONNREFUSED';
    out.r1 = await ops.recoverInterruptedVerify('j1');
    out.v1 = st.getJob('j1').verifying;
    out.dueNow = sch.verifyCleanupJobsOf(st.listJobs(), Date.now()).length;
    out.dueLater = sch.verifyCleanupJobsOf(st.listJobs(), Date.now() + st.RECOVER_RETRY_MS + 1).length;
    st.patchVerifying('j1', { detectedAt: Date.now() - st.RECOVER_GIVE_UP_MS - 1, nextAt: 0 }, { anyBoot: true });
    out.r2 = await ops.recoverInterruptedVerify('j1');
    out.v2 = st.getJob('j1').verifying || null;
    out.last = st.getJob('j1').history.at(-1);
  `, { jobs: [JOB({ verifying: rec })] });
  assert.equal(out.r1.ok, false); assert.match(out.r1.detail, /다시 시도/);
  assert.ok(out.v1.nextAt > Date.now() - 5_000 && out.v1.tries === 1);
  assert.equal(out.dueNow, 0, '다음 시각 전에는 다시 넣지 않는다'); assert.equal(out.dueLater, 1);
  assert.equal(out.r2.ok, false); assert.equal(out.v2, null, '시한이 지나면 기록을 내린다(보류에는 시한)');
  assert.equal(out.last.skipped, 'restart-cleanup-gave-up'); assert.match(out.last.detail, /vCenter 에서 사본/);
});

test('S3b: 이 프로세스의 검증이 뒷정리를 못 끝내면 재시도 기록으로 넘긴다', () => {
  const out = run(`
    globalThis.FAIL.revert = 'revert failed';
    out.r = await ops.verifyClone(st.getJob('j1'), 'vm-5');
    out.v = st.getJob('j1').verifying || null;
    out.left = !!st.interruptedVerifyOf(st.getJob('j1'));
  `);
  assert.equal(out.r.ok, false); assert.match(out.r.detail, /되돌리지 못했습니다/);
  assert.equal(out.v.boot, 'cleanup-retry'); assert.equal(out.left, true, '다음 확인이 다시 정리한다');
  assert.equal(out.v.snapRef, 'snapshot-1');
});

test('S4: 네트워크를 끊는 복구는 클론 스펙에 NIC 끊김을 실어 보낸다(끊지 않는 복구는 싣지 않는다)', () => {
  const out = run(`
    out.a = await ops.restoreFromClone(st.getJob('j1'), 'vm-5', { newName: 'web01-restore', datastoreName: 'ds1' });
    out.b = await ops.restoreFromClone(st.getJob('j1'), 'vm-5', { newName: 'web01-restore2', datastoreName: 'ds1', nicDisconnect: false });
  `);
  assert.equal(out.a.ok, true, out.a.detail); assert.equal(out.b.ok, true, out.b.detail);
  const clones = out.calls.filter((c) => c.startsWith('clone:'));
  assert.deepEqual(clones, ['clone:<deviceChange>X</deviceChange>', 'clone:(none)']);
});

test('S4b: cloneFromSnapshot — config 는 template 뒤·powerOn 앞(vim25 VirtualMachineCloneSpec 순서) · 비우면 이전과 같은 요청', async () => {
  const { cloneFromSnapshot, nicDisconnectSpec } = await import('../src/vmclone/vsphere.js');
  const sent = [];
  const c = {
    callRaw: async (xml) => { sent.push(xml); return '<returnval type="Task">task-1</returnval>'; },
    retrieveObjectProps: async () => [{ props: { 'info.state': 'success', 'info.result': 'vm-200' } }],
  };
  const dev = '<VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><connectable><startConnected>true</startConnected><allowGuestControl>true</allowGuestControl><connected>true</connected></connectable><controllerKey>100</controllerKey></VirtualDevice>';
  const { specXml } = nicDisconnectSpec(dev);
  assert.equal(await cloneFromSnapshot(c, { vmRef: 'vm-5', folderRef: 'group-v1', name: 'r1', dsRef: 'datastore-1', configXml: specXml }), 'vm-200');
  assert.match(sent[0], /<template>false<\/template><config><deviceChange><operation>edit<\/operation><device xsi:type="VirtualVmxnet3"><key>4000<\/key><connectable><startConnected>false<\/startConnected>[\s\S]*<connected>false<\/connected>[\s\S]*<\/config><powerOn>false<\/powerOn>/);
  await cloneFromSnapshot(c, { vmRef: 'vm-5', folderRef: 'group-v1', name: 'r2' });
  assert.doesNotMatch(sent[1], /<config>/);
  assert.match(sent[1], /<template>false<\/template><powerOn>false<\/powerOn>/);
});

test('S4c: disconnectAllNics — 이미 끊겨 태어난 VM 은 다시 재구성하지 않고 확인만 한다', async () => {
  const { disconnectAllNics } = await import('../src/vmclone/vsphere.js');
  const off = '<VirtualDevice xsi:type="VirtualVmxnet3"><key>4000</key><connectable><startConnected>false</startConnected><allowGuestControl>true</allowGuestControl><connected>false</connected></connectable></VirtualDevice>';
  const sent = [];
  const c = { callRaw: async (x) => { sent.push(x); return ''; }, retrieveObjectProps: async () => [{ props: { name: 'r1', 'runtime.powerState': 'poweredOff', 'config.hardware.device': off } }] };
  assert.equal(await disconnectAllNics(c, 'vm-200'), 1);
  assert.equal(sent.length, 0, 'ReconfigVM_Task 를 보내지 않는다');
});

test('S5: 뒷정리가 남은 잡은 지우지 않는다 · 엣지 위임 동기화도 지우지 않는다', () => {
  const rec = { ref: 'vm-5', cloneName: 'web01-bak-1', snapName: 'p', phase: 'power', at: Date.now(), boot: 'old' };
  const out = run(`
    try { st.deleteJob('j1'); out.del = 'deleted'; } catch (e) { out.del = e.message; }
    out.apply = st.applyDelegatedJobs([], ['vcA']);
    out.still = !!st.getJob('j2');
  `, { jobs: [JOB({ verifying: rec }), JOB({ id: 'j2', vmId: 'vcA:vm-2', origin: 'central', verifying: rec })] });
  assert.match(out.del, /뒷정리가 남아/);
  assert.equal(out.apply.removed, 0); assert.equal(out.still, true);
});
