/**
 * v2.741 감사 그룹 GB — VM 복제 재시작 중단 · 적응 타이머 재무장 기준 · IP 스캔 재시작.
 *  TIMING-01 ①② VM 복제 실행 중 업그레이드·재시작이 오면 원본 VM 에 portal-clone 스냅샷이 남고, 재기동 1분 뒤 같은 잡이 다시 돌아
 *               스냅샷을 겹쳐 만들었다 — 실행 중 기록(vm-clone.json running) + 기동 표시 + 새 스냅샷 전에 남은 스냅샷 정리.
 *  TIMING-05    adaptiveTimer 의 변경 알림 재무장이 '실행 시작' 기준이라, 긴 실행 직후 설정을 저장하면 다음 실행이 하한 1초로 당겨졌다.
 *  TIMING-06    IP 스캔(중앙·엣지)이 재시작마다 주기와 무관하게 대역 전체를 다시 스캔했다(v2.737 재개는 유지).
 * 재시작은 실제 자식 프로세스 두 개(같은 CONFIG_DIR)로 흉내 낸다 — vmclone/vsphere.js·store.js(스냅샷)만 가짜다.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741b-'));
process.env.CONFIG_DIR = TMP;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const u = (p) => pathToFileURL(path.join(SRC, p)).href;
const HOUR = 3_600_000;

// ── TIMING-01 ─────────────────────────────────────────────────────────────
// 가짜 vsphere: 호출 기록(calls)을 남긴다. snapshotXml 은 VM 'snapshot' 속성으로 돌려줄 트리다.
function vsphereMock({ cloneHangs = false, removeFails = '', snapshotXml = '' } = {}) {
  return `
    mock.module(${JSON.stringify(u('vmclone/vsphere.js'))}, { namedExports: {
      VimSoapClient: class {
        async login() { calls.push('login'); }
        async logout() { calls.push('logout'); }
        async retrieveObjectProps(type, ref, paths) { calls.push('props:' + ref + ':' + paths.join(',')); return [{ props: { snapshot: ${JSON.stringify(snapshotXml)} } }]; }
      },
      createSnapshot: async (c, vm, o) => { calls.push('createSnapshot:' + o.name); return 'snapshot-new-' + calls.length; },
      removeSnapshot: async (c, ref) => { calls.push('removeSnapshot:' + ref); ${removeFails ? `throw new Error(${JSON.stringify(removeFails)});` : ''} },
      parentFolderOf: async () => 'group-v1',
      cloneFromSnapshot: (c, o) => { calls.push('clone:' + o.name); return ${cloneHangs ? 'new Promise(() => {})' : "Promise.resolve('vm-99')"}; },
      destroyClone: async () => ({ gone: true }),
      vmFilePaths: async () => ({ vmx: null, files: [] }), parseDsPath: () => null, backupFileFilter: () => true,
      datacenterPathOf: async () => null, downloadDsFile: async () => 0,
    } });
    mock.module(${JSON.stringify(u('store.js'))}, { namedExports: { store: { get: () => ({ datastores: [{ vcenterId: 'vc1', name: 'ds1', id: 'vc1:datastore-1' }] }) } } });
  `;
}
function runChild(cfg, body, mockOpts) {
  const script = `
    import { mock } from 'node:test';
    const calls = [];
    ${vsphereMock(mockOpts)}
    const st = await import(${JSON.stringify(u('vmclone/store.js'))});
    const r = await import(${JSON.stringify(u('vmclone/runner.js'))});
    const sch = await import(${JSON.stringify(u('vmclone/scheduler.js'))});
    const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((x) => setTimeout(x, 10)); };
    const out = {};
    ${body}
    out.calls = calls;
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}
function newCfg() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741b-vc-'));
  fs.writeFileSync(path.join(cfg, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vc1', host: 'https://127.0.0.1:1', username: 'u', password: 'p' }] }));
  return cfg;
}
const readJob = (cfg) => JSON.parse(fs.readFileSync(path.join(cfg, 'vm-clone.json'), 'utf8')).jobs[0];
const tree = (nodes) => `<currentSnapshot type="VirtualMachineSnapshot">${nodes[0]?.ref || ''}</currentSnapshot>` + nodes.map((n) =>
  `<rootSnapshotList><snapshot type="VirtualMachineSnapshot">${n.ref}</snapshot><vm type="VirtualMachine">vm-1</vm><name>${n.name}</name><description>x</description><id>1</id><createTime>2026-10-15T00:00:00Z</createTime><state>poweredOn</state><quiesced>false</quiesced></rootSnapshotList>`).join('');

// 1단계: 스냅샷을 만든 뒤 클론이 도는 중에 프로세스가 끝난다(업그레이드 재시작과 같은 종료).
function interruptedRun() {
  const cfg = newCfg();
  const a = runChild(cfg, `
    const job = st.saveJob({ vcenterId: 'vc1', vmId: 'vc1:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'daily', time: '02:00' }, keep: 3 });
    r.enqueueRun(job.id, 'schedule');
    await waitFor(() => calls.some((c) => c.startsWith('clone:')));
    out.jobId = job.id;
  `, { cloneHangs: true });
  return { cfg, a };
}

test('TIMING-01 ① 실행 중 기록이 동기로 남는다 — 스냅샷 이름·ref·클론 이름·이 프로세스 표지', () => {
  const { cfg, a } = interruptedRun();
  assert.ok(a.calls.some((c) => c.startsWith('createSnapshot:portal-clone-')), a.calls.join(','));
  assert.ok(!a.calls.some((c) => c.startsWith('removeSnapshot')), '종료로 finally 의 삭제가 불리지 않았다(결함 조건 재현)');
  const j = readJob(cfg);
  assert.ok(j.running, '실행 중 기록이 파일에 있다');
  assert.match(j.running.snapName, /^portal-clone-\d{8}-\d{4}$/);
  assert.match(j.running.snapRef, /^snapshot-new-/);
  assert.equal(j.running.phase, 'clone');
  assert.match(j.running.cloneName, /^web01-bak-/);
  assert.ok(j.running.boot && j.running.at > 0);
});

test('TIMING-01 ② 재기동: lastRun 에 재시작 중단을 남기고, 첫 실행이 새 스냅샷 **전에** 남은 스냅샷을 지운 뒤 다시 실행한다', () => {
  const { cfg } = interruptedRun();
  const snap = readJob(cfg).running;
  const b = runChild(cfg, `
    const id = st.listJobs()[0].id;
    out.marked = st.markInterruptedRuns();
    out.lastRun = st.getJob(id).lastRun;
    out.isDue = st.isDue(st.getJob(id));
    const d = sch.dueJobsOf(st.listJobs(), Date.now(), { mock: false });
    out.due = d.run.map((j) => j.id); out.resume = d.resume;
    r.enqueueRun(id, out.resume.includes(id) ? 'resume' : 'schedule');
    await waitFor(() => st.getJob(id).lastRun?.ok === true && !r.runnerStatus().running);
    out.after = st.getJob(id);
  `, { snapshotXml: tree([{ ref: snap.snapRef, name: snap.snapName }, { ref: 'snapshot-other', name: 'portal-clone-20200101-0000' }]) });
  assert.equal(b.marked, 1);
  assert.equal(b.lastRun.skipped, 'restart-interrupted');
  assert.match(b.lastRun.detail, /재시작으로 실행이 중단/);
  assert.equal(b.isDue, false, '기동 표시 뒤에는 정규 스케줄 만기가 아니다(재실행은 resume 이 맡는다)');
  assert.equal(b.due.length, 1); assert.equal(b.resume.length, 1, '남은 실행은 resume 으로 다시 돈다');
  const iRemove = b.calls.indexOf(`removeSnapshot:${snap.snapRef}`);
  const iCreate = b.calls.findIndex((c) => c.startsWith('createSnapshot:'));
  assert.ok(iRemove >= 0, `기록한 ref 의 스냅샷을 지운다: ${b.calls.join(',')}`);
  assert.ok(iCreate > iRemove, '새 스냅샷은 정리 뒤에 만든다(겹쳐 만들지 않는다)');
  assert.ok(!b.calls.includes('removeSnapshot:snapshot-other'), '기록에 없는 다른 portal-clone 스냅샷은 건드리지 않는다');
  assert.equal(b.after.lastRun.ok, true);
  assert.match(b.after.lastRun.detail, /재시작 정리: 남은 스냅샷 ‘portal-clone-/);
  assert.match(b.after.lastRun.detail, /중단 당시 만들던 클론 ‘web01-bak-/, '끝났을 수 있는 클론을 원장 밖이라고 밝힌다');
  assert.equal(b.after.running, undefined, '다 끝나면 실행 기록이 없다');
});

test('TIMING-01 ② 남은 스냅샷을 못 지우면 새 스냅샷을 만들지 않고 시한 안에서 다시 시도한다', () => {
  const { cfg } = interruptedRun();
  const snap = readJob(cfg).running;
  const b = runChild(cfg, `
    const id = st.listJobs()[0].id;
    st.markInterruptedRuns();
    r.enqueueRun(id, 'resume');
    await waitFor(() => st.getJob(id).lastRun?.skipped === 'restart-cleanup-pending' && !r.runnerStatus().running);
    out.job = st.getJob(id);
    out.dueNow = st.recoveryDue(out.job, Date.now());
    out.dueLater = st.recoveryDue(out.job, Date.now() + st.RECOVER_RETRY_MS + 1000);
  `, { snapshotXml: tree([{ ref: snap.snapRef, name: snap.snapName }]), removeFails: 'The operation is not allowed in the current state (TaskInProgress)' });
  assert.ok(!b.calls.some((c) => c.startsWith('createSnapshot')), `새 스냅샷을 만들지 않는다: ${b.calls.join(',')}`);
  assert.equal(b.job.lastRun.skipped, 'restart-cleanup-pending');
  assert.match(b.job.lastRun.detail, /아직 지우지 못했습니다\(The operation is not allowed/);
  assert.ok(b.job.running && b.job.running.tries === 1 && b.job.running.nextAt > 0, '기록을 남기고 재시도 시각을 적는다');
  assert.equal(b.dueNow, false, '재시도 시각 전에는 다시 돌지 않는다(매 틱 로그인하지 않게)');
  assert.equal(b.dueLater, true);
});

test('TIMING-01 ② 정리 시한(RECOVER_GIVE_UP_MS)이 지나면 그만두고 수동 삭제를 안내한다(보류에는 시한)', () => {
  const { cfg } = interruptedRun();
  const snap = readJob(cfg).running;
  const db = JSON.parse(fs.readFileSync(path.join(cfg, 'vm-clone.json'), 'utf8'));
  db.jobs[0].running.detectedAt = Date.now() - 7 * HOUR;
  fs.writeFileSync(path.join(cfg, 'vm-clone.json'), JSON.stringify(db));
  const b = runChild(cfg, `
    const id = st.listJobs()[0].id;
    r.enqueueRun(id, 'resume');
    await waitFor(() => st.getJob(id).lastRun?.skipped === 'restart-cleanup-gave-up' && !r.runnerStatus().running);
    out.job = st.getJob(id);
  `, { snapshotXml: tree([{ ref: snap.snapRef, name: snap.snapName }]), removeFails: 'TaskInProgress' });
  assert.equal(b.job.lastRun.skipped, 'restart-cleanup-gave-up');
  assert.match(b.job.lastRun.detail, /수동으로 삭제하세요/);
  assert.equal(b.job.running, undefined, '기록을 내린다 — 다음 실행은 평소대로');
  assert.ok(!b.calls.some((c) => c.startsWith('createSnapshot')));
});

test('TIMING-01 ② ref 를 적기 전에 끊긴 실행은 생성 태스크 시한 안에서는 "없다" 고 단정하지 않고 기다린다', () => {
  const cfg = newCfg();
  const b = runChild(cfg, `
    const job = st.saveJob({ vcenterId: 'vc1', vmId: 'vc1:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' }, keep: 3 });
    // 이전 프로세스가 스냅샷 요청 직후 끊긴 기록(ref 없음) — 같은 파일을 직접 고쳐 흉내 낸다
    const fs = await import('node:fs');
    const f = process.env.CONFIG_DIR + '/vm-clone.json';
    const db = JSON.parse(fs.readFileSync(f, 'utf8'));
    db.jobs[0].running = { boot: 'old-boot', at: Date.now() - 60_000, trigger: 'schedule', vmRef: 'vm-1', snapName: 'portal-clone-20261015-0200', phase: 'snapshot' };
    fs.writeFileSync(f, JSON.stringify(db));
    st._resetForTest();
    st.markInterruptedRuns();
    r.enqueueRun(job.id, 'resume');
    await waitFor(() => st.getJob(job.id).lastRun?.skipped === 'restart-cleanup-pending' && !r.runnerStatus().running);
    out.job = st.getJob(job.id);
  `, { snapshotXml: '' });
  assert.ok(!b.calls.some((c) => c.startsWith('createSnapshot')), b.calls.join(','));
  assert.match(b.job.lastRun.detail, /스냅샷 생성 태스크가 vCenter 에서 아직 끝나지 않았을 수 있어/);
});

test('TIMING-01 snapshotTreeList — 트리 노드의 ref·이름만, currentSnapshot 은 섞지 않는다', async () => {
  const { snapshotTreeList } = await import('../src/vmclone/runner.js');
  const xml = tree([{ ref: 'snapshot-1', name: 'a &amp; b' }, { ref: 'snapshot-2', name: 'portal-clone-20261015-0200' }]);
  assert.deepEqual(snapshotTreeList(xml), [{ ref: 'snapshot-1', name: 'a & b' }, { ref: 'snapshot-2', name: 'portal-clone-20261015-0200' }]);
  assert.deepEqual(snapshotTreeList(''), []);
  assert.deepEqual(snapshotTreeList(null), []);
  const t0 = Date.now(); snapshotTreeList('<snapshot type="VirtualMachineSnapshot">x</snapshot>' + ' '.repeat(200_000)); // 긴 공백 입력에서도 선형
  assert.ok(Date.now() - t0 < 1000);
});

test('TIMING-01 NFS 중단분 — 기록한 폴더가 manifest 없이 남아 있으면 지운다(마운트 안·스탬프 형식만)', () => {
  const cfg = newCfg();
  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741b-nfs-'));
  const partial = path.join(mp, 'web01', '20261015-0200');
  const complete = path.join(mp, 'web01', '20261014-0200');
  for (const d of [partial, complete]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(partial, 'disk-flat.vmdk'), 'partial');
  fs.writeFileSync(path.join(complete, 'manifest.json'), '{}');
  const script = `
    import { mock } from 'node:test';
    mock.module(${JSON.stringify(u('system/nfsMounts.js'))}, { namedExports: {
      getMount: (id) => (id === 'm1' ? { id: 'm1' } : null), mountPointOf: () => ${JSON.stringify(mp)}, mountedSet: () => new Set([${JSON.stringify(mp)}]),
      listMounts: () => [], validateMountSpec: () => ({}),
    } });
    const r = await import(${JSON.stringify(u('vmclone/runner.js'))});
    const job = { dest: { type: 'nfs', mountId: 'm1' } };
    const out = {
      partial: r.cleanupPartialNfs(job, { destDir: ${JSON.stringify(partial)} }),
      complete: r.cleanupPartialNfs(job, { destDir: ${JSON.stringify(complete)} }),
      outside: r.cleanupPartialNfs(job, { destDir: '/etc/20261015-0200' }),
    };
    console.log(JSON.stringify(out)); process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.match(o.partial, /불완전 폴더 20261015-0200 를 지웠습니다/);
  assert.equal(fs.existsSync(partial), false);
  assert.equal(o.complete, '', '끝까지 받은 백업(manifest 있음)은 그대로');
  assert.equal(fs.existsSync(complete), true);
  assert.match(o.outside, /마운트 지점 밖/);
});

// ── TIMING-05 ─────────────────────────────────────────────────────────────
test('TIMING-05 adaptiveTimer — 긴 실행 직후 같은 주기로 알림이 와도 다음 실행은 종료 + 주기 뒤다(하한 1초로 당겨지지 않는다)', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const log = mock.method(console, 'log', () => {});
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const cbs = [];
  let ms = 3000;
  const starts = []; const ends = [];
  const t = startAdaptiveTimer(() => ms, async () => {
    starts.push(Date.now());
    await new Promise((r) => setTimeout(r, 2500));
    ends.push(Date.now());
  }, { firstDelayMs: 0, name: 't5', subscribe: (cb) => { cbs.push(cb); return () => {}; } });
  try {
    mock.timers.tick(1000); await flush();          // 첫 실행 시작(하한 1초)
    assert.equal(starts.length, 1);
    mock.timers.tick(2500); await flush();          // 첫 실행 종료
    assert.equal(ends.length, 1);
    mock.timers.tick(100); await flush();
    cbs.forEach((c) => c());                        // 같은 주기로 설정 저장 알림
    mock.timers.tick(1500); await flush();
    assert.equal(starts.length, 1, '종료 1.6초 뒤에 다시 돌지 않는다(예전: 하한 1초 → 종료 1.1초 뒤)');
    mock.timers.tick(1400); await flush();          // 종료 + 3.0초
    assert.equal(starts.length, 2, '종료 + 주기(3초) 에 다시 돈다');
    assert.equal(starts[1] - ends[0], 3000);
    // 주기를 늘린 알림은 '마지막 종료 뒤' 기준으로 남은 시간을 다시 센다
    mock.timers.tick(2500); await flush();          // 두 번째 실행 종료
    mock.timers.tick(500); await flush();
    ms = 6000; cbs.forEach((c) => c());
    mock.timers.tick(5400); await flush();
    assert.equal(starts.length, 2, '종료 5.9초 — 아직');
    mock.timers.tick(100); await flush();          // 종료 + 6.0초
    assert.equal(starts.length, 3);
    assert.equal(starts[2] - ends[1], 6000, '주기 변경도 종료 기준');
  } finally { t.stop(); mock.timers.reset(); log.mock.restore(); }
});

// ── TIMING-06 ─────────────────────────────────────────────────────────────
test('TIMING-06 중앙 firstScanDelayMs — 마지막 완료 스캔이 주기 안이면 첫 스캔을 미루고, 재개 대기·기록 없음은 30초', async () => {
  const { firstScanDelayMs, FIRST_SCAN_MIN_DELAY_MS } = await import('../src/ipam/scanPoller.js');
  const now = 10 * HOUR;
  assert.equal(FIRST_SCAN_MIN_DELAY_MS, 30_000);
  assert.equal(firstScanDelayMs({ intervalMs: 6 * HOUR, lastDoneAt: now - HOUR, now }), 5 * HOUR, '주기 6시간·1시간 전 완료 → 5시간 뒤');
  assert.equal(firstScanDelayMs({ intervalMs: 6 * HOUR, lastDoneAt: now - 7 * HOUR, now }), 30_000, '주기가 지났으면 예전처럼 30초');
  assert.equal(firstScanDelayMs({ intervalMs: 6 * HOUR, lastDoneAt: now - HOUR, now, pendingResume: true }), 30_000, '재시작으로 끊긴 스캔이 있으면 그대로(재개 유지)');
  assert.equal(firstScanDelayMs({ intervalMs: 6 * HOUR, lastDoneAt: null, now }), 30_000);
  assert.equal(firstScanDelayMs({ intervalMs: 6 * HOUR, lastDoneAt: '', now }), 30_000, '빈 값은 0 이 아니라 기록 없음');
  assert.equal(firstScanDelayMs({ intervalMs: HOUR, lastDoneAt: now + 5 * HOUR, now }), HOUR, '시계가 뒤로 가도 최대 한 주기');
  assert.equal(firstScanDelayMs({ intervalMs: HOUR, lastDoneAt: now - HOUR + 1000, now }), 30_000, '하한 30초');
});

test('TIMING-06 중앙 startIpScanPoller — 영속된 마지막 완료(LOCAL)가 주기 안이면 기동 30초 스캔을 하지 않는다', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741b-ip-'));
  fs.writeFileSync(path.join(cfg, 'ipam-scan.json'), JSON.stringify({ agents: { __local__: { enabled: true, ranges: ['10.255.255.0/30'], intervalMs: 6 * HOUR } } }));
  fs.writeFileSync(path.join(cfg, 'ipam-scan-agents.json'), JSON.stringify({ __local__: { at: Date.now() - HOUR, scanned: 2, alive: 0 } }));
  const script = `
    const sp = await import(${JSON.stringify(u('ipam/scanPoller.js'))});
    console.log = () => {};
    sp.startIpScanPoller();
    const st = sp.scanStatus();
    process.stdout.write(JSON.stringify({ firstScan: st.firstScan, enabled: st.enabled }) + '\\n');
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, CONFIG_DIR: cfg } });
  assert.equal(res.status, 0, res.stderr);
  const o = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(o.enabled, true);
  assert.equal(o.firstScan?.reason, 'recent-scan', JSON.stringify(o));
  assert.ok(o.firstScan.delayMs > 4.9 * HOUR && o.firstScan.delayMs <= 5 * HOUR, `5시간 뒤로 미룬다(${o.firstScan.delayMs})`);
});

test('TIMING-06 엣지 — 마지막 스캔 시각을 파일에 남겨, 재시작 직후 첫 dueOnly 확인이 주기 전이면 다시 스캔하지 않는다', async () => {
  const http = await import('node:http');
  let results = 0;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/ip-scan-assignment')) return res.end(JSON.stringify({ assigned: true, ranges: [], ports: [80], intervalMs: 6 * HOUR }));
      if (req.url.startsWith('/api/central/ip-scan-result')) { results++; return res.end('{"ok":true}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2741b-edge-'));
  const central = `http://127.0.0.1:${srv.address().port}`;
  const env = { ...process.env, CONFIG_DIR: cfg, CENTRAL_URL: central, AGENT_NAME: 'edge-t6', CENTRAL_TOKEN: 'x', SSRF_ALLOW_LOOPBACK: 'true' };
  const child = (body) => new Promise((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', `
        const w = await import(${JSON.stringify(u('agent/ipScanWorker.js'))});
        console.warn = () => {};
        ${body}
        process.exit(0);
      `], { env });
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
    });
  });
  try {
    await child(`const r = await w.runIpScanAgentOnce({ dueOnly: true }); process.stdout.write(JSON.stringify(r));`);
    assert.equal(results, 1, '첫 프로세스는 스캔·보고한다');
    const saved = JSON.parse(fs.readFileSync(path.join(cfg, 'ipscan-agent-state.json'), 'utf8'));
    assert.ok(saved.lastScanAt > 0);
    const out2 = await child(`const s0 = w.ipScanAgentStatus(); const r = await w.runIpScanAgentOnce({ dueOnly: true }); process.stdout.write(JSON.stringify({ restored: s0.lastScanRestored, r }));`);
    const o2 = JSON.parse(out2);
    assert.equal(o2.restored, saved.lastScanAt, '기동 때 되살린다');
    assert.equal(results, 1, '재시작 직후 첫 dueOnly 확인은 주기(6시간) 전이라 다시 스캔하지 않는다');
    // 재시작으로 끊긴 스캔이 재개를 기다리면(v2.737 scanJournal) 주기 전이어도 스캔한다 — 재개 유지
    fs.writeFileSync(path.join(cfg, 'scan-journal.json'), JSON.stringify({ v: 1, savedAt: Date.now(), active: { 'ipscan-agent:scan': { kind: 'ipscan-agent', key: 'scan', label: 'IP 스캔', trigger: 'periodic', since: Date.now() - 5000, resumes: 0, meta: {} } }, interrupted: [], history: [] }));
    await child(`const r = await w.runIpScanAgentOnce({ dueOnly: true }); process.stdout.write(JSON.stringify(r));`);
    assert.equal(results, 2, '재개 대기 항목이 있으면 주기와 무관하게 스캔한다');
    // 미래 시각(시계 역행)은 믿지 않는다
    fs.writeFileSync(path.join(cfg, 'ipscan-agent-state.json'), JSON.stringify({ v: 1, lastScanAt: Date.now() + 10 * HOUR }));
    const out3 = await child(`process.stdout.write(JSON.stringify(w.ipScanAgentStatus()));`);
    assert.equal(JSON.parse(out3).lastScanAt, null, '지금보다 미래인 값은 버린다');
  } finally { srv.close(); }
});
