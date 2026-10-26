/**
 * v2.795 VM 백업 실행 경로 개선 회귀 — 실제 runner(vsphere.js 만 가짜).
 *  P1 신원: 처음 본 instanceUuid 를 적고, 다음 실행에서 다르면 스냅샷 전에 멈춘다 · 원본 VM 이 없으면 분명한 사유로 멈춘다.
 *  P2 용량: 대상 데이터스토어 실시간 여유 < 필요량 + 하한이면 스냅샷 전에 멈춘다 · 못 읽으면 검사하지 않는다 · 접근 불가면 멈춘다.
 *  P3 같은 데이터스토어면 성공 결과에 ⚠ 경고 · NFS 는 마운트 지점 여유(statfs)로 같은 검사.
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
const GIB = 1024 ** 3;

const { capacityShortfall, shortfallText, MIN_FREE_FLOOR } = await import('../src/vmclone/capacity.js');

test('P0: capacityShortfall — 하한 max(10GiB, 5%) · 못 읽으면 null · 문자열 수치', () => {
  assert.equal(capacityShortfall({ free: 100 * GIB, capacity: 1000 * GIB, need: 40 * GIB }), null);
  const s = capacityShortfall({ free: 100 * GIB, capacity: 1000 * GIB, need: 60 * GIB });   // 남는 40 < 하한 50
  assert.ok(s); assert.equal(s.floor, 50 * GIB);
  assert.equal(capacityShortfall({ free: 15 * GIB, capacity: 20 * GIB, need: 6 * GIB })?.floor, MIN_FREE_FLOOR, '작은 저장소는 10GiB 하한');
  assert.equal(capacityShortfall({ free: null, capacity: 1, need: 1 }), null, '여유를 못 읽으면 판정하지 않는다');
  assert.equal(capacityShortfall({ free: 1, capacity: 1, need: '' }), null, '필요량을 못 읽으면 판정하지 않는다(0 으로 보지 않는다)');
  assert.ok(capacityShortfall({ free: String(5 * GIB), need: String(1 * GIB) }), '문자열 수치');
  assert.match(shortfallText('대상', s), /여유 100GB, 필요 약 60\.0GB \+ 남겨 둘 여유 50\.0GB/);
});

/** 실제 runner + 가짜 vSphere. VM·데이터스토어 속성은 globalThis.VM·DS 로 바꾼다. */
function run(body, { mountPoint = '' } = {}) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2795-'));
  fs.writeFileSync(path.join(cfg, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcA', host: 'https://127.0.0.1:1', username: 'u', password: 'p' }] }));
  const script = `
    import { mock } from 'node:test';
    const calls = []; globalThis.CALLS = calls;
    globalThis.VM = { name: 'web01', 'config.instanceUuid': 'uuid-A', 'summary.storage.committed': String(40 * ${GIB}), 'summary.storage.uncommitted': String(10 * ${GIB}), datastore: '<ManagedObjectReference type="Datastore">datastore-9</ManagedObjectReference>' };
    globalThis.DS = { 'summary.freeSpace': String(500 * ${GIB}), 'summary.capacity': String(1000 * ${GIB}), 'summary.accessible': 'true' };
    globalThis.VM_THROW = ''; globalThis.QFAIL = '';
    mock.module(${u('vmclone/vsphere.js')}, { namedExports: {
      VimSoapClient: class { constructor(vc) { this.vc = vc; } async login() {} async logout() {}
        async retrieveObjectProps(type, ref, props) {
          if (type === 'VirtualMachine' && props.includes('config.instanceUuid')) { if (globalThis.VM_THROW) throw new Error(globalThis.VM_THROW); return [{ props: { ...globalThis.VM } }]; }
          if (type === 'Datastore') return [{ props: { ...globalThis.DS } }];
          return [{ props: {} }];
        } },
      createSnapshot: async (c, ref, o = {}) => { calls.push(o.quiesce ? 'snapshot:q' : 'snapshot'); if (o.quiesce && globalThis.QFAIL) throw new Error(globalThis.QFAIL); return 'snapshot-1'; },
      removeSnapshot: async () => { calls.push('removeSnapshot'); },
      parentFolderOf: async () => 'group-v1', cloneFromSnapshot: async () => { calls.push('clone'); return 'vm-' + (100 + calls.length) + '-' + Date.now(); },
      destroyClone: async (c, ref) => { calls.push('destroy:' + ref); return { gone: true }; },
      vmFilePaths: async () => ({ vmx: '[ds1] web01/web01.vmx', files: [] }),
      parseDsPath: (s) => { const m = /^\\[([^\\]]+)\\]\\s*(.+)$/.exec(String(s || '').trim()); return m ? { ds: m[1], rel: m[2] } : null; },
      backupFileFilter: () => true, datacenterPathOf: async () => 'DC1',
      downloadDsFile: async (c, vc, { destFile }) => { const fs = await import('node:fs'); const p = await import('node:path'); fs.mkdirSync(p.dirname(destFile), { recursive: true }); fs.writeFileSync(destFile, 'x'); calls.push('download'); return 1; },
    } });
    mock.module(${u('store.js')}, { namedExports: { store: { get: () => ({ datastores: [{ id: 'vcA:datastore-1', vcenterId: 'vcA', name: 'ds1' }, { id: 'vcA:datastore-9', vcenterId: 'vcA', name: 'ds-src' }], vms: [] }) } } });
    mock.module(${u('system/nfsMounts.js')}, { namedExports: { getMount: (id) => ({ id }), mountPointOf: () => ${JSON.stringify(mountPoint)}, mountedSet: () => new Set([${JSON.stringify(mountPoint)}]) } });
    const st = await import(${u('vmclone/store.js')});
    const r = await import(${u('vmclone/runner.js')});
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const runOnce = async (jobId) => {
      calls.length = 0;
      r.enqueueRun(jobId, 'manual');
      for (let i = 0; i < 400 && (r.runnerStatus().running || r.runnerStatus().queued.length); i++) await sleep(10);
      await sleep(20);
      return { ...st.getJob(jobId).lastRun, calls: [...calls] };
    };
    const ds = (name = 'ds1') => st.saveJob({ vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: name }, schedule: { mode: 'manual' }, keep: 3 });
    const out = {};
    ${body}
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

test('P1: 신원 — 첫 실행이 instanceUuid 를 적고 · 다르면 스냅샷 전에 멈춘다 · 원본 VM 이 없으면 분명한 사유', () => {
  const o = run(`
    const j = ds();
    out.first = await runOnce(j.id);
    out.uuid = st.getJob(j.id).vmUuid;
    globalThis.VM['config.instanceUuid'] = 'uuid-OTHER'; globalThis.VM.name = 'prod-db';
    out.other = await runOnce(j.id);
    out.uuidAfter = st.getJob(j.id).vmUuid;
    globalThis.VM_THROW = 'ManagedObjectNotFound: vm-1';
    out.gone = await runOnce(j.id);
    globalThis.VM_THROW = 'socket hang up';   // 다른 조회 오류는 넘긴다(스냅샷 단계가 원래 오류를 드러낸다)
    globalThis.VM['config.instanceUuid'] = 'uuid-A';
    out.flaky = await runOnce(j.id);
  `);
  assert.equal(o.first.ok, true, o.first.detail);
  assert.equal(o.uuid, 'uuid-A');
  assert.equal(o.other.ok, false); assert.match(o.other.detail, /다른 VM ‘prod-db’ 이 있습니다/);
  assert.deepEqual(o.other.calls, [], '스냅샷을 만들지 않는다');
  assert.equal(o.uuidAfter, 'uuid-A', '기록한 신원을 바꾸지 않는다');
  assert.equal(o.gone.ok, false); assert.match(o.gone.detail, /원본 VM 을 vCenter 에서 찾을 수 없습니다/); assert.deepEqual(o.gone.calls, []);
  assert.equal(o.flaky.ok, true, '신원·크기를 못 읽은 조회 오류는 막지 않는다');
});

test('P2: 용량 — 부족하면 스냅샷 전에 멈춘다 · 못 읽으면 검사하지 않는다 · 접근 불가면 멈춘다', () => {
  const o = run(`
    const j = ds();
    globalThis.DS['summary.freeSpace'] = String(80 * ${GIB});   // 80 - 40 = 40 < 하한 50
    out.short = await runOnce(j.id);
    globalThis.DS['summary.freeSpace'] = String(100 * ${GIB});  // 100 - 40 = 60 ≥ 50
    out.enough = await runOnce(j.id);
    globalThis.DS = {}; globalThis.VM['summary.storage.committed'] = '';
    out.unknown = await runOnce(j.id);
    globalThis.DS = { 'summary.accessible': 'false' };
    out.inaccessible = await runOnce(j.id);
  `);
  assert.equal(o.short.ok, false); assert.match(o.short.detail, /대상 데이터스토어 ‘ds1’ 여유가 부족해 시작하지 않았습니다/);
  assert.deepEqual(o.short.calls, [], '스냅샷을 만들지 않는다');
  assert.equal(o.enough.ok, true, o.enough.detail); assert.ok(o.enough.calls.includes('clone'));
  assert.equal(o.unknown.ok, true, '여유·사용량을 못 읽으면 막지 않는다');
  assert.equal(o.inaccessible.ok, false); assert.match(o.inaccessible.detail, /접근할 수 없습니다/); assert.deepEqual(o.inaccessible.calls, []);
});

test('P3: 원본과 같은 데이터스토어면 성공 결과에 ⚠ 경고 · 다른 데이터스토어면 경고 없음', () => {
  const o = run(`
    const j = ds('ds-src');
    out.same = await runOnce(j.id);
    st.deleteJob(j.id);
    const k = ds('ds1');
    out.other = await runOnce(k.id);
  `);
  assert.equal(o.same.ok, true); assert.match(o.same.detail, /⚠ 원본과 같은 데이터스토어/);
  assert.doesNotMatch(o.other.detail, /원본과 같은 데이터스토어/);
});

test('P3b: NFS — 마운트 지점 여유(statfs)로 같은 검사(필요량 = 프로비저닝 크기)', () => {
  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2795-mp-'));
  const o = run(`
    const j = st.saveJob({ vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', dest: { type: 'nfs', mountId: 'm1' }, schedule: { mode: 'manual' }, keep: 2 });
    globalThis.VM['summary.storage.uncommitted'] = String(1e18);   // 어떤 디스크보다 큰 필요량
    out.short = await runOnce(j.id);
    // 사용량을 못 읽으면 검사하지 않고 진행한다 — 실제 디스크 여유(러너마다 다름)에 기대지 않으려고 이 경로로 성공을 본다('충분' 판정은 P0).
    globalThis.VM['summary.storage.uncommitted'] = ''; globalThis.VM['summary.storage.committed'] = '';
    out.ok = await runOnce(j.id);
  `, { mountPoint: mp });
  assert.equal(o.short.ok, false); assert.match(o.short.detail, /NFS 마운트 여유가 부족해 시작하지 않았습니다/); assert.deepEqual(o.short.calls, []);
  assert.equal(o.ok.ok, true, o.ok.detail); assert.ok(o.ok.calls.includes('download'));
});

test('Q1: 정지점 실패(태스크 오류) → 일반 스냅샷으로 한 번 다시 · ⚠ 표시 · 옵션을 끄면 실패 · 시간 초과는 다시 하지 않는다', () => {
  const o = run(`
    const j = st.saveJob({ vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'manual' }, keep: 3, quiesce: true });
    out.saved = st.getJob(j.id).quiesceFallback;
    globalThis.QFAIL = '스냅샷 생성 실패: An error occurred while quiescing the virtual machine';
    out.fallback = await runOnce(j.id);
    globalThis.QFAIL = '스냅샷 생성 시간 초과(15분) — 태스크 취소 요청함';
    out.timeout = await runOnce(j.id);
    st.saveJob({ ...st.getJob(j.id), quiesceFallback: false });
    out.savedOff = st.getJob(j.id).quiesceFallback;
    globalThis.QFAIL = '스냅샷 생성 실패: quiesce error';
    out.off = await runOnce(j.id);
  `);
  assert.equal(o.saved, undefined, '기본(켬)은 파일에 적지 않는다');
  assert.equal(o.fallback.ok, true, o.fallback.detail);
  assert.deepEqual(o.fallback.calls.filter((x) => x.startsWith('snapshot')), ['snapshot:q', 'snapshot']);
  assert.match(o.fallback.detail, /⚠ 정지점 스냅샷 실패\(An error occurred while quiescing/);
  assert.equal(o.timeout.ok, false); assert.deepEqual(o.timeout.calls.filter((x) => x.startsWith('snapshot')), ['snapshot:q'], '시간 초과는 다시 시도하지 않는다');
  assert.equal(o.savedOff, false);
  assert.equal(o.off.ok, false); assert.deepEqual(o.off.calls.filter((x) => x.startsWith('snapshot')), ['snapshot:q']);
});

test('V1: 보존정책 — 검증을 통과한 가장 최근 복원 지점은 지우지 않는다(보존 +1) · 검증 사본이 없으면 평소대로', () => {
  const o = run(`
    // 보존 1개 + 사본 a(검증 통과)·b(검증 실패) + 새 사본 → 평소라면 a·b 를 지운다. a 는 보호한다.
    const j = st.saveJob({ vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds1' }, schedule: { mode: 'manual' }, keep: 1 });
    const t = Date.now();
    st.recordRun(j.id, { ok: true, detail: 'seed', ms: 1, addClone: { name: 'web01-bak-a', ref: 'vm-a', at: t - 3000 } });
    st.recordRun(j.id, { ok: true, detail: 'seed', ms: 1, addClone: { name: 'web01-bak-b', ref: 'vm-b', at: t - 2000 } });
    st.patchClone(j.id, 'vm-a', { verify: { at: t, ok: true, detail: 'ok' } });
    st.patchClone(j.id, 'vm-b', { verify: { at: t, ok: false, detail: 'Tools 무응답' } });
    out.r = await runOnce(j.id);
    out.refs = st.getJob(j.id).clones.map((c) => c.ref).filter((r) => r.startsWith('vm-a') || r.startsWith('vm-b'));
    out.pure = { plain: st.pruneList([{ ref: 'a', at: 1 }, { ref: 'b', at: 2 }, { ref: 'c', at: 3 }], 1).map((x) => x.ref), prot: st.pruneList([{ ref: 'a', at: 1 }, { ref: 'b', at: 2 }, { ref: 'c', at: 3 }], 1, 0, Date.now(), { protectRef: 'a' }).map((x) => x.ref) };
    out.last = st.lastVerifiedRef([{ ref: 'x', at: 1, verify: { ok: true } }, { ref: 'y', at: 5, verify: { ok: true } }, { ref: 'z', at: 9, verify: { ok: false } }]);
  `);
  assert.equal(o.r.ok, true, o.r.detail);
  assert.ok(o.r.calls.includes('destroy:vm-b') && !o.r.calls.includes('destroy:vm-a'), `검증 실패 사본(b)만 지운다 — ${o.r.calls}`);
  assert.match(o.r.detail, /검증을 통과한 최신 복원 지점 ‘web01-bak-a’ 은 남겼습니다/);
  assert.deepEqual(o.refs, ['vm-a']);
  assert.deepEqual(o.pure, { plain: ['a', 'b'], prot: ['b'] });
  assert.equal(o.last, 'y');
});

test('G1: waitTask onProgress — 진행 중 퍼센트를 알린다(표시용 — 콜백이 던져도 대기는 계속)', async () => {
  const { waitTask } = await import('../src/vmclone/vsphere.js');
  const seq = [{ 'info.state': 'running', 'info.progress': '42' }, { 'info.state': 'running', 'info.progress': '' }, { 'info.state': 'success', 'info.result': 'vm-7' }];
  const c = { retrieveObjectProps: async () => [{ props: seq.shift() }], callRaw: async () => '' };
  const seen = [];
  const r = await waitTask(c, 'task-1', { pollMs: 1, onProgress: (p) => { seen.push(p); throw new Error('표시 오류'); } });
  assert.equal(r.result, 'vm-7'); assert.deepEqual(seen, [42]);
});
