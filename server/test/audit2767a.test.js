/**
 * v2.767 점검 2회차 — 수정 그룹 F1(프로비저닝·VM 복제) 회귀 고정.
 *  R2-B3-1  프로비저닝 생성의 쓰기 범위를 body.vcenterId 로만 봐서 범위 관리자가 범위 밖 원본 VM 으로 범위 밖 vCenter 에 VM 을 만들었다
 *           (반대로 화면은 vcenterId 를 보내지 않아 범위 관리자는 늘 403) — 원본 VM 의 vCenter 로 '조회 밖 404 → 쓰기 밖 403'.
 *  R2-B3-2  NFS 백업 경로에 vCenter·VM 구분이 없고 vmName 이 정제되지 않아 보존정책이 다른 잡의 백업을 지웠다.
 *  R2-B3-3  실패한 NFS 백업의 불완전 폴더가 보존 개수에 끼어 온전한 백업을 밀어냈다.
 *  R2-B3-4  두 데이터스토어의 동명 디스크가 같은 파일로 덮어써졌다.
 *  R2-B3-5  Sysprep guiUnattended 요소 순서가 vim25 스키마와 달랐다.
 *  R2-B3-6  보존 삭제가 ref 의 VM 이름을 원장 이름과 대조하지 않았다.
 *  R2-B3-7  잡 수정으로 vmId 를 바꿔 '같은 VM 잡 중복 금지' 를 우회했다.
 *  R2-B3-8  조회 범위 밖 잡·저장 작업에 403(존재 노출) · 없는 잡 run 이 202.
 *  R2-B3-9  꺼진 잡 수동 실행이 202 '큐 등록'(runner 는 바로 끝낸다) · 콘솔 문구.
 *  R2-B3-10 reconfig 의 networkMoref 가 이스케이프 없이 RetrieveProperties XML 에 들어갔다.
 *  R2-B3-11 provision perVm 경로에 상한이 없고 중복 검사가 O(n²) · null 원소 500.
 *
 * ⚠ 라우트는 **실제 라우터를 express 에 띄워** 역할·범위별 응답으로 본다(audit2599c 패턴 — config.js 싱글턴이라 자식 프로세스).
 *   NFS 는 **실제 runner 를 돌리고** vCenter 접점(vmclone/vsphere.js)·스냅샷 스토어·NFS 마운트만 가짜다(audit2741b 패턴).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2767a-'));
process.env.CONFIG_DIR = TMP;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (p) => JSON.stringify(path.join(SRC, p));
const u = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);

/* ── 실제 라우터(B3-1·7·8·9) ─────────────────────────────────────────────── */

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2767a-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const { adminRouter } = await import(${J('routes/admin.js')});
    const provJobs = await import(${J('provision/jobs.js')});
    const saved = await import(${J('provision/saved.js')});
    const vmclone = await import(${J('vmclone/store.js')});
    await store.refresh({ force: true });
    const snap = store.get();
    const vcs = snap.vcenters.map((v) => v.id);
    const mk = (user) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.user = user; next(); });
      app.use('/api', api);
      app.use('/api/admin', adminRouter);
      return app;
    };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p, init = {}) => {
      const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
      let b = null; try { b = await r.json(); } catch {}
      return { status: r.status, body: b };
    };
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', SSH_READY_TIMEOUT_MS: '2000' },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

let live = null;
function liveResult() {
  if (live) return live;
  live = runLive(`
    // VM 이 2대 이상인 vCenter 두 개를 고른다(목 데이터 순서에 기대지 않게)
    const withVms = vcs.filter((id) => snap.vms.filter((v) => v.vcenterId === id).length >= 2);
    const [A, B] = withVms;
    const vmA = snap.vms.find((v) => v.vcenterId === A);
    const vmB = snap.vms.find((v) => v.vcenterId === B);
    const body = (extra) => JSON.stringify({ perVm: [{ name: 'x-2767-' + Math.random().toString(36).slice(2, 7) }], guest: { ipMode: 'dhcp' }, ...extra });
    const sadmin = await start(mk({ username: 'sadmin', role: 'admin', scope: { vcenters: [A] } }));
    const wadmin = await start(mk({ username: 'wadmin', role: 'admin', scope: { vcenters: [A, B], writeVcenters: [A] } }));
    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const jobsOf = (vc) => provJobs.listJobs({ username: 'root', role: 'admin' }, null).filter((j) => j.vcenterId === vc).length;
    const o = { A, B };

    // ── B3-1 ──
    o.bypass = await req(sadmin, '/api/admin/provision/jobs', { method: 'POST', body: body({ vcenterId: A, sourceId: vmB.id }) });
    o.jobsB_afterBypass = jobsOf(B);
    o.webNoVc = await req(sadmin, '/api/admin/provision/jobs', { method: 'POST', body: body({ sourceId: vmA.id }) });   // 화면이 보내는 꼴(vcenterId 없음)
    o.mismatch = await req(sadmin, '/api/admin/provision/jobs', { method: 'POST', body: body({ vcenterId: B, sourceId: vmA.id }) });
    o.readOnly = await req(wadmin, '/api/admin/provision/jobs', { method: 'POST', body: body({ sourceId: vmB.id }) });
    o.jobsB_afterReadOnly = jobsOf(B);
    o.full = await req(admin, '/api/admin/provision/jobs', { method: 'POST', body: body({ sourceId: vmB.id }) });
    o.noSource = await req(sadmin, '/api/admin/provision/jobs', { method: 'POST', body: body({ sourceId: 'nope:vm-0' }) });

    // ── B3-8 저장 작업 ──
    // 저장 작업은 직접 만든다(위 생성 결과와 무관하게 — 수정 전 코드로 되돌린 변이 검증에서도 이 단계가 돌게)
    const sA = saved.addSaved({ spec: { namePattern: 'sa-{n}' }, source: { name: 'sa', vcenterId: A, id: vmA.id }, user: { username: 'root' } });
    const sB = saved.addSaved({ spec: { namePattern: 'sb-{n}' }, source: { name: 'sb', vcenterId: B, id: vmB.id }, user: { username: 'root' } });
    o.savedPutOut = await req(sadmin, '/api/admin/provision/saved/' + sB.id, { method: 'PUT', body: JSON.stringify({ memo: 'x' }) });
    o.savedDelOut = await req(sadmin, '/api/admin/provision/saved/' + sB.id, { method: 'DELETE' });
    o.savedPutRO = await req(wadmin, '/api/admin/provision/saved/' + sB.id, { method: 'PUT', body: JSON.stringify({ memo: 'x' }) });
    o.savedPutIn = await req(sadmin, '/api/admin/provision/saved/' + sA.id, { method: 'PUT', body: JSON.stringify({ memo: 'ok' }) });
    o.savedBStill = !!saved.getSaved(sB.id);

    // ── B3-7·8·9 VM 복제 잡 ──
    const vmA2 = snap.vms.filter((v) => v.vcenterId === A)[1];
    const jobB = vmclone.saveJob({ vcenterId: B, vmId: vmB.id, vmName: vmB.name, dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 1 });
    const jobA = vmclone.saveJob({ vcenterId: A, vmId: vmA.id, vmName: vmA.name, dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 1, enabled: false });
    const jobA2 = vmclone.saveJob({ vcenterId: A, vmId: vmA2.id, vmName: vmA2.name, dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 1, enabled: false });
    o.runOut = await req(sadmin, '/api/tools/vm-clone/jobs/' + jobB.id + '/run', { method: 'POST', body: '{}' });
    o.delOut = await req(sadmin, '/api/tools/vm-clone/jobs/' + jobB.id, { method: 'DELETE' });
    o.runRO = await req(wadmin, '/api/tools/vm-clone/jobs/' + jobB.id + '/run', { method: 'POST', body: '{}' });
    o.delRO = await req(wadmin, '/api/tools/vm-clone/jobs/' + jobB.id, { method: 'DELETE' });
    o.runMissing = await req(admin, '/api/tools/vm-clone/jobs/vc-nope-1/run', { method: 'POST', body: '{}' });
    o.runDisabled = await req(admin, '/api/tools/vm-clone/jobs/' + jobA.id + '/run', { method: 'POST', body: '{}' });
    o.jobBStill = !!vmclone.getJob(jobB.id);
    // jobA2 를 vmA 로 바꾸려는 수정 — vmA 에는 이미 jobA 가 있다
    o.editVm = await req(admin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ id: jobA2.id, vcenterId: A, vmId: vmA.id, vmName: vmA.name, dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 1 }) });
    o.editSame = await req(admin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ id: jobA2.id, vcenterId: A, vmId: vmA2.id, vmName: vmA2.name, dest: { type: 'datastore', datastoreName: 'ds2' }, schedule: { mode: 'manual' }, keep: 2, enabled: false }) });
    o.jobsOnVmA = vmclone.listJobs().filter((j) => j.vmId === vmA.id).length;
    return o;
  `);
  return live;
}

test('R2-B3-1: 범위 관리자가 범위 밖 원본 VM 으로 프로비저닝하면 404 이고 작업이 만들어지지 않는다', () => {
  const r = liveResult();
  assert.equal(r.bypass.status, 404, JSON.stringify(r.bypass.body));
  assert.equal(r.jobsB_afterBypass, 0, '범위 밖 vCenter 에 작업이 생기면 안 된다');
});

test('R2-B3-1: 화면처럼 vcenterId 없이 보내도 범위 관리자의 자기 vCenter 원본은 201(예전 403 — 기능 고장)', () => {
  const r = liveResult();
  assert.equal(r.webNoVc.status, 201, JSON.stringify(r.webNoVc.body));
  assert.equal(r.webNoVc.body.job.vcenterId, r.A);
});

test('R2-B3-1: body.vcenterId 가 원본과 다르면 400 · 조회는 되지만 쓰기 밖 원본은 403 · 원본 없음은 404 · 전체 범위는 201', () => {
  const r = liveResult();
  assert.equal(r.mismatch.status, 400, JSON.stringify(r.mismatch.body));
  assert.equal(r.readOnly.status, 403, JSON.stringify(r.readOnly.body));
  assert.equal(r.jobsB_afterReadOnly, 0);
  assert.equal(r.noSource.status, 404, "원본을 못 찾으면 라우트가 범위 검사 전에 404(리드 검토 — createJob 으로 넘기지 않는다)");
  assert.equal(r.full.status, 201, JSON.stringify(r.full.body));
  assert.equal(r.full.body.job.vcenterId, r.B);
});

test('R2-B3-8: 저장 작업 PUT/DELETE — 조회 밖 404 · 쓰기 밖 403 · 범위 안 200', () => {
  const r = liveResult();
  assert.equal(r.savedPutOut.status, 404, JSON.stringify(r.savedPutOut.body));
  assert.equal(r.savedDelOut.status, 404);
  assert.equal(r.savedPutRO.status, 403);
  assert.equal(r.savedPutIn.status, 200);
  assert.equal(r.savedBStill, true, '거부된 DELETE 가 지우면 안 된다');
});

test('R2-B3-8·9: VM 복제 run/delete — 조회 밖 404 · 쓰기 밖 403 · 없는 잡 404 · 꺼진 잡 409', () => {
  const r = liveResult();
  assert.equal(r.runOut.status, 404, JSON.stringify(r.runOut.body));
  assert.equal(r.delOut.status, 404);
  assert.equal(r.runRO.status, 403);
  assert.equal(r.delRO.status, 403);
  assert.equal(r.jobBStill, true);
  assert.equal(r.runMissing.status, 404, '없는 잡을 큐에 넣고 202 라고 답하지 않는다');
  assert.equal(r.runDisabled.status, 409, JSON.stringify(r.runDisabled.body));
});

test('R2-B3-7: 잡 수정으로 대상 VM 을 바꾸면 400 — 한 VM 에 잡 두 개가 붙지 않는다(같은 VM 수정은 그대로 201)', () => {
  const r = liveResult();
  assert.equal(r.editVm.status, 400, JSON.stringify(r.editVm.body));
  assert.equal(r.jobsOnVmA, 1);
  assert.equal(r.editSame.status, 201, JSON.stringify(r.editSame.body));
});

/* ── NFS 백업(B3-2·3·4) — 실제 runner ──────────────────────────────────── */

function runNfs(body) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'a2767a-nfs-cfg-'));
  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2767a-nfs-mp-'));
  fs.writeFileSync(path.join(cfg, 'vcenters.json'), JSON.stringify({ vcenters: ['vcA', 'vcB', 'vcC', 'vcD'].map((id) => ({ id, host: 'https://127.0.0.1:1', username: 'u', password: 'p' })) }));
  const script = `
    import { mock } from 'node:test';
    import fs from 'node:fs';
    import path from 'node:path';
    const MP = ${JSON.stringify(mp)};
    globalThis.FAIL = false;
    globalThis.FILES = ['[ds1] web01/web01.vmx', '[ds1] web01/web01-flat.vmdk'];
    mock.module(${u('vmclone/vsphere.js')}, { namedExports: {
      VimSoapClient: class { constructor(vc) { this.vc = vc; } async login() {} async logout() {} async retrieveObjectProps() { return [{ props: {} }]; } },
      createSnapshot: async () => 'snapshot-1', removeSnapshot: async () => {},
      parentFolderOf: async () => 'group-v1', cloneFromSnapshot: async () => 'vm-99', destroyClone: async () => ({ gone: true }),
      vmFilePaths: async () => ({ vmx: globalThis.FILES[0], files: globalThis.FILES }),
      parseDsPath: (s) => { const m = /^\\[([^\\]]+)\\]\\s*(.+)$/.exec(String(s || '').trim()); return m ? { ds: m[1], rel: m[2] } : null; },
      backupFileFilter: () => true,
      datacenterPathOf: async () => 'DC1',
      downloadDsFile: async (c, vc, { ds, rel, destFile }) => {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.writeFileSync(destFile, vc.id + '|' + ds + '|' + rel);
        if (globalThis.FAIL) throw new Error('download failed (test)');
        return 10;
      },
    } });
    mock.module(${u('store.js')}, { namedExports: { store: { get: () => ({ datastores: [], vms: [] }) } } });
    mock.module(${u('system/nfsMounts.js')}, { namedExports: {
      getMount: (id) => ({ id }), mountPointOf: () => MP, mountedSet: () => new Set([MP]),
    } });
    // 스탬프(분 단위)가 겹치지 않게 시계를 실행마다 61분씩 민다.
    const realNow = Date.now.bind(Date);
    let clock = Math.floor(realNow() / 3_600_000) * 3_600_000 - 30 * 24 * 3_600_000;
    Date.now = () => clock;
    const tick = () => { clock += 61 * 60_000; };
    const st = await import(${u('vmclone/store.js')});
    const r = await import(${u('vmclone/runner.js')});
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms));
    const runOnce = async (jobId) => {
      tick();
      r.enqueueRun(jobId, 'manual');
      for (let i = 0; i < 400 && (r.runnerStatus().running || r.runnerStatus().queued.length); i++) await sleep(10);
      await sleep(20);
      return st.getJob(jobId).lastRun;
    };
    const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(path.relative(MP, p).split(path.sep).join('/')); } return acc; };
    const nfs = (vcenterId, vmId, vmName, keep, subdir = '') => st.saveJob({ vcenterId, vmId, vmName, dest: { type: 'nfs', mountId: 'm1', subdir }, schedule: { mode: 'manual' }, keep });
    const out = {};
    ${body}
    out.files = walk(MP);
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  return { out, mp };
}

const stampDirsWith = (files, re) => new Set(files.filter((f) => re.test(f) && f.endsWith('/manifest.json')).map((f) => f.split('/').slice(0, -1).join('/')));

test('R2-B3-2: 다른 vCenter 의 동명 VM 두 잡이 서로의 NFS 백업을 지우지 않는다 · ../ 이름 잡이 남의 폴더로 못 들어간다 · 옛 경로 백업은 남긴다', () => {
  const { out, mp } = runNfs(`
    // 이전 판 경로(<마운트>/<VM 이름>/<스탬프>)에 남은 백업 — 지우지 않고 남겨야 한다
    fs.mkdirSync(path.join(MP, 'web01', '20200101-0000'), { recursive: true });
    fs.writeFileSync(path.join(MP, 'web01', '20200101-0000', 'manifest.json'), JSON.stringify({ vm: 'web01', vcenterId: 'vcA', files: [] }));
    const a = nfs('vcA', 'vcA:vm-1', 'web01', 2);
    const b = nfs('vcB', 'vcB:vm-1', 'web01', 2);
    for (let d = 0; d < 2; d++) { await runOnce(a.id); await runOnce(b.id); }
    out.lastA = st.getJob(a.id).lastRun;
    const c = nfs('vcC', 'vcC:vm-7', '../web01', 1, 'x');
    out.lastC = await runOnce(c.id);
  `);
  try {
    const okA = stampDirsWith(out.files, /^vcA\//);
    const okB = stampDirsWith(out.files, /^vcB\//);
    assert.equal(okA.size, 2, `vcA 백업은 keep=2 개가 남아야 한다: ${out.files.join(' ')}`);
    assert.equal(okB.size, 2, `vcB 백업은 keep=2 개가 남아야 한다: ${out.files.join(' ')}`);
    assert.equal(out.lastA.ok, true, out.lastA.detail);
    assert.ok(out.files.includes('web01/20200101-0000/manifest.json'), '옛 경로 백업은 지우지 않는다');
    assert.match(out.lastA.detail, /이전 판의 경로/, '옛 경로에 백업이 남아 있다는 사실을 실행 결과에 적는다');
    assert.equal(out.lastC.ok, true, out.lastC.detail);
    assert.ok(out.files.every((f) => !f.startsWith('web01/') || f.startsWith('web01/20200101-0000/')), `../ 이름 잡이 마운트 루트의 web01 로 들어가면 안 된다: ${out.files.join(' ')}`);
    assert.ok(out.files.some((f) => f.startsWith('x/vcC/')), out.files.join(' '));
  } finally { fs.rmSync(mp, { recursive: true, force: true }); }
});

test('R2-B3-3: 실패한 NFS 백업의 불완전 폴더는 지워지고 보존 개수에 끼지 않는다(keep=3: 성공3 → 실패2 → 성공1 ⇒ 온전한 3개)', () => {
  const { out, mp } = runNfs(`
    const d = nfs('vcD', 'vcD:vm-3', 'db01', 3);
    for (const f of [0, 0, 0, 1, 1, 0]) { globalThis.FAIL = !!f; out['run' + Object.keys(out).length] = (await runOnce(d.id)).ok; }
  `);
  try {
    const all = new Set(out.files.map((f) => f.split('/').slice(0, 3).join('/')));
    const ok = stampDirsWith(out.files, /^vcD\//);
    assert.equal(ok.size, 3, `온전한 백업 3개: ${out.files.join(' ')}`);
    assert.equal(all.size, 3, `불완전 폴더가 남으면 안 된다: ${out.files.join(' ')}`);
  } finally { fs.rmSync(mp, { recursive: true, force: true }); }
});

test('R2-B3-4: 두 데이터스토어의 동명 디스크가 서로 덮어쓰지 않고, manifest file 이 각 사본을 가리킨다', () => {
  const { out, mp } = runNfs(`
    globalThis.FILES = ['[ds-ssd01] web01/web01.vmx', '[ds-ssd01] web01/web01-flat.vmdk', '[ds-hdd02] web01/web01-flat.vmdk'];
    const j = nfs('vcA', 'vcA:vm-5', 'web01', 2);
    out.last = await runOnce(j.id);
    const mf = walkFind(MP);
    function walkFind(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { const x = walkFind(p); if (x) return x; } else if (e.name === 'manifest.json') return p; } return null; }
    out.manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    out.contents = out.manifest.files.map((f) => fs.readFileSync(path.join(path.dirname(mf), f.file), 'utf8'));
  `);
  try {
    assert.equal(out.last.ok, true, out.last.detail);
    const files = out.manifest.files.map((f) => f.file);
    assert.equal(new Set(files).size, 3, `대상 파일이 겹치면 안 된다: ${files.join(' ')}`);
    assert.deepEqual(out.contents.sort(), ['vcA|ds-hdd02|web01/web01-flat.vmdk', 'vcA|ds-ssd01|web01/web01-flat.vmdk', 'vcA|ds-ssd01|web01/web01.vmx'].sort());
    assert.equal(out.manifest.vmId, 'vcA:vm-5', '보존 판정이 쓰는 vmId 를 manifest 에 남긴다');
  } finally { fs.rmSync(mp, { recursive: true, force: true }); }
});

/* ── 순수·모듈 단위 ─────────────────────────────────────────────────────── */

test('R2-B3-2·3: pruneNfsBackups — 같은 폴더에 섞인 남의 백업(manifest 불일치)·불완전 폴더(manifest 없음)는 세지도 지우지도 않는다', async () => {
  const { pruneNfsBackups, pathSlug } = await import('../src/vmclone/runner.js');
  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2767a-prune-'));
  try {
    const root = path.join(mp, 'vc_a', 'web01__vm-1');
    const mk = (name, man) => { fs.mkdirSync(path.join(root, name), { recursive: true }); if (man) fs.writeFileSync(path.join(root, name, 'manifest.json'), JSON.stringify(man)); };
    const job = { vcenterId: 'vc:a', vmId: 'vc:a:vm-1', keep: 1 };
    mk('20261001-0100', { vcenterId: 'vc:a', vmId: 'vc:a:vm-1' });
    mk('20261002-0100', { vcenterId: 'vc_a', vmId: 'vc_a:vm-1' });   // 슬러그가 같은 다른 vCenter
    mk('20261003-0100', null);                                         // 불완전
    mk('20261004-0100', { vcenterId: 'vc:a', vmId: 'vc:a:vm-1' });
    fs.mkdirSync(path.join(root, 'not-a-stamp'));
    assert.deepEqual(pruneNfsBackups(mp, root, job), ['20261001-0100']);
    assert.deepEqual(fs.readdirSync(root).sort(), ['20261002-0100', '20261003-0100', '20261004-0100', 'not-a-stamp']);
    assert.deepEqual(pruneNfsBackups(mp, path.join(os.tmpdir(), 'elsewhere'), job), [], '마운트 밖 루트는 아무것도 지우지 않는다');
    assert.equal(pathSlug('../web01'), '__web01');
    assert.equal(pathSlug('..'), '_');
    assert.equal(pathSlug(''), '_');
    assert.equal(pathSlug('a b/c'), 'a_b_c');
  } finally { fs.rmSync(mp, { recursive: true, force: true }); }
});

test('R2-B3-1: createJob 이중 방어 — 라우트가 판정한 vCenter(expectVcenterId)와 원본이 다르면 만들지 않는다', async () => {
  const { store } = await import('../src/store.js');
  const { createJob } = await import('../src/provision/jobs.js');
  store.snapshot = { ...store.snapshot, vms: [{ id: 'vc-b:vm-1', name: 'B-src', vcenterId: 'vc-b', guestOS: 'linux' }] };
  const r = createJob({ sourceId: 'vc-b:vm-1', perVm: [{ name: 'n1' }], guest: { ipMode: 'dhcp' } }, { user: { username: 'u' }, expectVcenterId: 'vc-a' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /확인한 값과 다릅니다/);
});


test('R2-B3-5: Sysprep guiUnattended 요소 순서 = timeZone → autoLogon → autoLogonCount, 그 뒤 userData → identification', async () => {
  const { customizationXml } = await import('../src/provision/vsphere.js');
  const xml = customizationXml({ name: 'w1', hostname: 'w1' }, { ipMode: 'dhcp' }, true);
  const gui = /<guiUnattended>([\s\S]*?)<\/guiUnattended>/.exec(xml)?.[1] || '';
  const order = [...gui.matchAll(/<(\w+)>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['timeZone', 'autoLogon', 'autoLogonCount']);
  const iGui = xml.indexOf('<guiUnattended>'), iUser = xml.indexOf('<userData>'), iId = xml.indexOf('<identification>');
  assert.ok(iGui >= 0 && iGui < iUser && iUser < iId, xml);
  const linux = customizationXml({ name: 'l1' }, { ipMode: 'dhcp' }, false);
  assert.ok(!linux.includes('guiUnattended'));
});

test('R2-B3-6: destroyClone — ref 의 VM 이름이 원장 이름과 다르면 지우지 않는다(같으면·%2f 표기는 지운다)', async () => {
  const { destroyClone } = await import('../src/vmclone/vsphere.js');
  const fake = (name) => {
    const calls = [];
    return { calls, retrieveObjectProps: async () => [{ props: { name, 'runtime.powerState': 'poweredOff' } }], callRaw: async (x) => { calls.push(x); return '<returnval type="Task"></returnval>'; } };
  };
  const other = fake('prod-db01');
  await assert.rejects(destroyClone(other, 'vm-5', { expectedName: 'web01-bak-20261020-0200' }), /다른 이름/);
  assert.equal(other.calls.length, 0, 'Destroy_Task 를 내면 안 된다');
  const same = fake('web01-bak-20261020-0200');
  await destroyClone(same, 'vm-5', { expectedName: 'web01-bak-20261020-0200' });
  assert.equal(same.calls.length, 1);
  const enc = fake('a%2fb-bak-1');
  await destroyClone(enc, 'vm-6', { expectedName: 'a/b-bak-1' });
  assert.equal(enc.calls.length, 1, 'vSphere 의 %2f 표기는 같은 이름이다');
});

test('R2-B3-9: 스케줄러 콘솔 문구가 꺼진 잡을 수동 실행 때 정리한다고 말하지 않는다', () => {
  const src = fs.readFileSync(path.join(SRC, 'vmclone/scheduler.js'), 'utf8');
  assert.ok(!src.includes('꺼진 잡은 수동 실행 때 정리'));
});

test('R2-B3-10: reconfig — networkMoref 화이트리스트(XML 특수문자 거부) · 형식이 틀리면 로그인 전에 거절', async () => {
  const { isSafeMoref, reconfigVm } = await import('../src/provision/reconfig.js');
  for (const ok of ['dvportgroup-123', 'network-7', 'group-v3']) assert.equal(isSafeMoref(ok), true, ok);
  for (const bad of ['dvportgroup-1</obj><obj type="X">y', 'a"b', "a'b", 'a&b', '', ' dv', '-x', 'x'.repeat(101), null, 7]) assert.equal(isSafeMoref(bad), false, String(bad));
  const r = await reconfigVm({ id: 'vc-x', host: 'https://127.0.0.1:1' }, 'vm-1', { nicAdds: [{ type: 'DISTRIBUTED_PORTGROUP', networkMoref: 'dvportgroup-1</obj><x>' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /MoRef 형식/);
});

test('R2-B3-11: expandSpec perVm — 500대 상한(넘으면 펼치지 않음) · null 원소는 오류 사유 · 중복 검출 유지', async () => {
  const { expandSpec } = await import('../src/provision/spec.js');
  const mkList = (n) => Array.from({ length: n }, (_, i) => ({ name: 'v' + i }));
  const ok = expandSpec({ perVm: mkList(500), guest: { ipMode: 'dhcp' } });
  assert.equal(ok.errors.length, 0); assert.equal(ok.vms.length, 500);
  const t0 = performance.now();
  const big = expandSpec({ perVm: mkList(50_000), guest: { ipMode: 'dhcp' } });
  const ms = performance.now() - t0;
  assert.equal(big.vms.length, 0); assert.match(big.errors.join(' '), /최대 500대/);
  // 절대 ms 짧은 상한은 CPU 에 따라 깨진다(TESTDOC2613-02) — 예전 O(n²) 경로(5만 개면 수 초)와 확실히 갈리는 넉넉한 상한만 둔다.
  assert.ok(ms < 2000, `상한 초과는 펼치지 않고 바로 돌려준다(${ms.toFixed(1)}ms)`);
  const nul = expandSpec({ perVm: [{ name: 'a' }, null], guest: { ipMode: 'dhcp' } });
  assert.match(nul.errors.join(' '), /2번째 항목/);
  const dup = expandSpec({ perVm: [{ name: 'a' }, { name: 'b' }, { name: 'a' }, { name: 'a' }], guest: { ipMode: 'dhcp' } });
  assert.deepEqual(dup.errors, ['중복된 VM 이름: a']);
});
