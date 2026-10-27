/**
 * v2.794 VM 백업 센터 2회차(누락 기능) 회귀.
 *  K — 보존 기간(keepDays): 개수 규칙 + 기간이 지난 사본 · 가장 최근 1개는 언제나 남긴다 · 시각을 모르는 사본은 기간으로 지우지 않는다(원장·NFS 같은 규칙).
 *  D — NFS 데이터스토어 떼어 내기: 같은 NFS 일 때만 · 이 호스트의 VM 이 쓰면 거부 · 다른 호스트의 VM 은 무관 · 붙어 있지 않으면 성공.
 *      결과 반영: 성공 호스트는 연결 기록을 지우고, 실패 호스트는 연결 상태를 그대로 둔 채 사유만 고친다.
 *  R — 실제 라우터: 그 데이터스토어를 쓰는 잡이 있으면 409 · 법인 마운트 지정(조회 밖 404 → 쓰기 밖 403) · 지정 밖 마운트 잡 저장 거부 ·
 *      기존 잡이 같은 마운트를 그대로 두는 수정은 허용.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const J = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2794f-'));
const { pruneList, clampKeepDays, normalizeJobDef } = await import('../src/vmclone/store.js');
const { pruneNfsBackups } = await import('../src/vmclone/runner.js');
const { detachNasFromHost } = await import('../src/vmclone/vsphere.js');
const nfsDs = await import('../src/vmclone/nfsDs.js');

const DAY = 86_400_000;

test('K1: pruneList — 개수 + 기간 · 최근 1개는 남긴다 · 시각 모름은 기간으로 지우지 않는다 · 0 이면 개수만', () => {
  const now = Date.UTC(2026, 9, 26);
  const c = (n, d) => ({ name: n, ref: n, at: d == null ? 0 : now - d * DAY });
  const list = [c('a', 40), c('b', 35), c('x'), c('d', 10), c('e', 1)];
  assert.deepEqual(pruneList(list, 30, 0, now).map((x) => x.name), [], '기간 끔 — 개수(30) 안이면 아무것도');
  assert.deepEqual(pruneList(list, 30, 30, now).map((x) => x.name), ['a', 'b'], '30일 지난 것만 · 시각 모름(x)은 남긴다');
  assert.deepEqual(pruneList(list, 2, 30, now).map((x) => x.name).sort(), ['a', 'b', 'x'], '개수 초과분(시각 순 3개 — 시각 모름이 가장 앞) ∪ 기간(a·b)');
  assert.deepEqual(pruneList(list, 3, 5, now).map((x) => x.name).sort(), ['a', 'b', 'd', 'x'], '개수 초과분(x·a) ∪ 기간 5일(b·d) — 최근(e)은 남긴다');
  const old = [c('p', 90), c('q', 60)];
  assert.deepEqual(pruneList(old, 30, 7, now).map((x) => x.name), ['p'], '전부 오래돼도 가장 최근 1개(q)는 남긴다');
  assert.equal(clampKeepDays(-3), 0); assert.equal(clampKeepDays('abc'), 0); assert.equal(clampKeepDays(9999), 365); assert.equal(clampKeepDays(14.7), 14);
  const def = normalizeJobDef({ vcenterId: 'v', vmId: 'v:vm-1', vmName: 'w', dest: { type: 'datastore', datastoreName: 'ds' }, keepDays: '30' });
  assert.equal(def.keepDays, 30);
});

test('K2: pruneNfsBackups — 이 잡의 온전한 백업만 · 개수 + 기간(manifest 시각) · 최근 1개 · 마운트 밖 금지', () => {
  const mp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2794f-mp-'));
  const root = path.join(mp, 'vcA', 'web01__vm-1');
  const job = { vcenterId: 'vcA', vmId: 'vcA:vm-1', keep: 10, keepDays: 30 };
  const mk = (stamp, daysAgo, owner = job) => {
    const dir = path.join(root, stamp); fs.mkdirSync(dir, { recursive: true });
    if (owner) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ vcenterId: owner.vcenterId, vmId: owner.vmId, at: new Date(Date.now() - daysAgo * DAY).toISOString() }));
  };
  mk('20260801-0200', 80); mk('20260901-0200', 50); mk('20261001-0200', 20); mk('20261025-0200', 1);
  mk('20260701-0200', 100, { vcenterId: 'vcA', vmId: 'vcA:vm-OTHER' });   // 남의 백업 — 세지도 지우지도 않는다
  mk('20260601-0200', 120, null);                                           // manifest 없음(불완전) — 건드리지 않는다
  const removed = pruneNfsBackups(mp, root, job);
  assert.deepEqual(removed, ['20260801-0200', '20260901-0200']);
  assert.deepEqual(fs.readdirSync(root).sort(), ['20260601-0200', '20260701-0200', '20261001-0200', '20261025-0200']);
  const onlyOld = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2794f-mp2-'));
  const r2 = path.join(onlyOld, 'x');
  for (const [s, d] of [['20250101-0000', 300], ['20250201-0000', 270]]) { fs.mkdirSync(path.join(r2, s), { recursive: true }); fs.writeFileSync(path.join(r2, s, 'manifest.json'), JSON.stringify({ vcenterId: 'vcA', vmId: 'vcA:vm-1', at: new Date(Date.now() - d * DAY).toISOString() })); }
  assert.deepEqual(pruneNfsBackups(onlyOld, r2, job), ['20250101-0000'], '전부 오래돼도 최근 1개는 남긴다');
  assert.deepEqual(pruneNfsBackups(onlyOld, mp, job), [], '마운트 지점 밖 루트는 아무것도 지우지 않는다');
});

/** 떼어 내기용 가짜 vCenter — host-1 에 데이터스토어 bk(nfs1:/backup) · VM 목록은 인자. */
function fakeVc({ dsName = 'bk', remoteHost = 'nfs1', remotePath = '/backup/', vms = [] } = {}) {
  const sent = [];
  const c = {
    sent,
    async retrieveObjectProps(type, ref, props) {
      if (type === 'HostSystem') return [{ props: { name: 'esx1', 'configManager.datastoreSystem': 'dsSys-1', datastore: '<ManagedObjectReference type="Datastore">datastore-1</ManagedObjectReference><ManagedObjectReference type="Datastore">datastore-2</ManagedObjectReference>' } }];
      if (type === 'Datastore' && props.includes('info')) {
        return [{ props: { info: `<url>ds:///x</url><nas><remoteHost>${remoteHost}</remoteHost><remotePath>${remotePath}</remotePath></nas>`, vm: vms.map((v) => `<ManagedObjectReference type="VirtualMachine">${v.ref}</ManagedObjectReference>`).join('') } }];
      }
      return [{ props: {} }];
    },
    async retrieveManyObjectProps(type, refs) {
      if (type === 'Datastore') return refs.map((r) => ({ ref: r, props: { name: r === 'datastore-1' ? 'local-ssd' : dsName } }));
      return refs.map((r) => { const v = vms.find((x) => x.ref === r); return { ref: r, props: { name: v?.name, 'runtime.host': v?.host } }; });
    },
    async callRaw(xml) { sent.push(xml); return ''; },
  };
  return c;
}
const SPEC = { name: 'bk', server: 'nfs1', exportPath: '/backup', nfsVersion: '3' };

test('D1: detachNasFromHost — 같은 NFS 이고 이 호스트 VM 이 없을 때만 RemoveDatastore', async () => {
  const ok = fakeVc({ vms: [{ ref: 'vm-9', name: 'other-host-vm', host: 'host-2' }] });
  const r = await detachNasFromHost(ok, 'host-1', SPEC);
  assert.equal(r.ok, true, r.detail);
  assert.equal(ok.sent.length, 1);
  assert.match(ok.sent[0], /<RemoveDatastore xmlns="urn:vim25"><_this type="HostDatastoreSystem">dsSys-1<\/_this><datastore type="Datastore">datastore-2<\/datastore><\/RemoveDatastore>/);

  const busy = fakeVc({ vms: [{ ref: 'vm-1', name: 'web01-bak-1', host: 'host-1' }, { ref: 'vm-2', name: 'db-bak', host: 'host-1' }] });
  const rb = await detachNasFromHost(busy, 'host-1', SPEC);
  assert.equal(rb.ok, false); assert.match(rb.detail, /VM 2대가 이 데이터스토어를 씁니다\(web01-bak-1, db-bak\)/);
  assert.equal(busy.sent.length, 0, '쓰는 VM 이 있으면 요청하지 않는다');

  const other = fakeVc({ remoteHost: 'nfs-OTHER' });
  const ro = await detachNasFromHost(other, 'host-1', SPEC);
  assert.equal(ro.ok, false); assert.match(ro.detail, /다른 데이터스토어/); assert.equal(other.sent.length, 0);

  const none = fakeVc({ dsName: 'unrelated' });
  const rn = await detachNasFromHost(none, 'host-1', SPEC);
  assert.equal(rn.ok, true); assert.equal(rn.already, true); assert.equal(none.sent.length, 0);
});

test('D2: applyDetachResult — 성공 호스트는 기록 삭제 · 실패 호스트는 연결 상태 유지 + 사유', () => {
  nfsDs._resetNfsDsForTest();
  const it = nfsDs.createNfsDs({ vcenterId: 'vcA', ...SPEC });
  nfsDs.applyAttachResult(it.id, [{ hostId: 'vcA:host-1', ok: true, detail: 'ok' }, { hostId: 'vcA:host-2', ok: true, detail: 'ok' }]);
  nfsDs.applyDetachResult(it.id, [{ hostId: 'vcA:host-1', ok: true, detail: '떼어 냈습니다' }, { hostId: 'vcA:host-2', ok: false, detail: 'VM 1대가 씁니다' }]);
  const after = nfsDs.getNfsDs(it.id);
  assert.equal(after.hosts['vcA:host-1'], undefined);
  assert.equal(after.hosts['vcA:host-2'].ok, true, '떼지 못한 호스트는 여전히 연결됨');
  assert.match(after.hosts['vcA:host-2'].detail, /떼어 내기 실패 — VM 1대가 씁니다/);
});

function runLive(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2794r-'));
  const boot = `
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const vmclone = await import(${J('vmclone/store.js')});
    const nfs = await import(${J('vmclone/nfsDs.js')});
    await store.refresh({ force: true });
    const snap = store.get();
    const mk = (user) => { const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = user; next(); }); app.use('/api', api); return app; };
    const servers = [];
    const start = async (app) => { const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); servers.push(s); return 'http://127.0.0.1:' + s.address().port; };
    const req = async (base, p, init = {}) => { const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = await (async () => { ${script} })();
    for (const s of servers) s.close();
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', boot], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

test('R1: 떼어 내기 라우트 — 쓰는 잡이 있으면 409 · 잡을 지우면 떼어 내고 연결 기록이 빠진다', () => {
  const o = runLive(`
    const admin = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const A = snap.vcenters.find((v) => snap.hosts.filter((h) => h.vcenterId === v.id).length >= 2 && snap.vms.some((x) => x.vcenterId === v.id)).id;
    const hostIds = snap.hosts.filter((h) => h.vcenterId === A).slice(0, 2).map((h) => h.id);
    const o = {};
    const add = await req(admin, '/api/tools/vm-clone/nfs-datastores', { method: 'POST', body: JSON.stringify({ vcenterId: A, name: 'bk2794', server: 'nfs1', exportPath: '/backup', hostIds }) });
    o.add = add.status;
    const id = add.body.item.id;
    for (let i = 0; i < 100 && Object.keys(nfs.getNfsDs(id).hosts || {}).length < 2; i++) await sleep(50);
    o.attached = Object.values(nfs.getNfsDs(id).hosts).filter((h) => h.ok).length;
    const vm = snap.vms.find((x) => x.vcenterId === A);
    const job = await req(admin, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ vcenterId: A, vmId: vm.id, vmName: vm.name, dest: { type: 'datastore', nfsDsId: id }, schedule: { mode: 'manual' }, keep: 2 }) });
    o.job = job.status;
    o.inUse = await req(admin, '/api/tools/vm-clone/nfs-datastores/' + id + '/detach', { method: 'POST', body: '{}' });
    o.del = (await req(admin, '/api/tools/vm-clone/jobs/' + job.body.job.id, { method: 'DELETE' })).status;
    o.detach = await req(admin, '/api/tools/vm-clone/nfs-datastores/' + id + '/detach', { method: 'POST', body: '{}' });
    for (let i = 0; i < 100 && Object.keys(nfs.getNfsDs(id).hosts || {}).length; i++) await sleep(50);
    o.left = Object.keys(nfs.getNfsDs(id).hosts || {}).length;
    o.again = await req(admin, '/api/tools/vm-clone/nfs-datastores/' + id + '/detach', { method: 'POST', body: '{}' });
    return o;
  `);
  assert.equal(o.add, 202); assert.equal(o.attached, 2); assert.equal(o.job, 201);
  assert.equal(o.inUse.status, 409); assert.match(o.inUse.body.reason, /백업 잡 1개/);
  assert.equal(o.del, 200);
  assert.equal(o.detach.status, 202, JSON.stringify(o.detach.body));
  assert.equal(o.left, 0, '떼어 낸 호스트의 연결 기록은 지운다');
  assert.equal(o.again.status, 400, '연결 기록이 없으면 뗄 호스트가 없다');
});

test('R2: 법인 마운트 지정 — 조회 밖 404 · 쓰기 밖 403 · 지정 밖 마운트 잡 거부 · 기존 잡의 같은 마운트 수정은 허용 · 해제하면 전부', () => {
  const o = runLive(`
    const root = await start(mk({ username: 'root', role: 'admin', scope: null }));
    const g = await req(root, '/api/tools/vm-clone');
    const corp = g.body.corps.find((c) => c.vcenterIds.length >= 1 && c.key !== 'unassigned');
    const A = corp.vcenterIds[0];
    const outside = snap.vcenters.map((v) => v.id).find((id) => !corp.vcenterIds.includes(id));
    const vm = snap.vms.find((x) => x.vcenterId === A);
    const o = { corpKey: corp.key, initial: corp.mountUse };
    const scopedOut = await start(mk({ username: 's1', role: 'admin', scope: { vcenters: [outside] } }));
    const readOnly = await start(mk({ username: 's2', role: 'admin', scope: { vcenters: corp.vcenterIds, writeVcenters: [outside] } }));
    o.notVisible = (await req(scopedOut, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: corp.key, mountIds: [] }) })).status;
    o.readOnly = (await req(readOnly, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: corp.key, mountIds: [] }) })).status;
    o.bad = (await req(root, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: corp.key, mountIds: 'x' }) })).status;
    o.unassigned = (await req(root, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: 'unassigned', mountIds: [] }) })).status;
    const set = await req(root, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: corp.key, mountIds: ['m-ok'] }) });
    o.set = [set.status, set.body.mountUse?.mountIds];
    o.viewAfter = (await req(root, '/api/tools/vm-clone')).body.corps.find((c) => c.key === corp.key).mountUse?.mountIds;
    const save = (mountId, extra = {}) => req(root, '/api/tools/vm-clone/jobs', { method: 'POST', body: JSON.stringify({ vcenterId: A, vmId: vm.id, vmName: vm.name, dest: { type: 'nfs', mountId }, schedule: { mode: 'manual' }, keep: 2, ...extra }) });
    const denied = await save('m-no');
    o.denied = [denied.status, denied.body.reason];
    const okJob = await save('m-ok');
    o.ok = okJob.status;
    // 지정을 바꿔 m-ok 를 빼도, 그 잡이 같은 마운트를 그대로 두는 수정은 허용
    await req(root, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: corp.key, mountIds: ['m-other'] }) });
    o.editSame = (await save('m-ok', { id: okJob.body.job.id, keep: 5 })).status;
    o.editMove = (await save('m-no', { id: okJob.body.job.id })).status;
    o.clear = (await req(root, '/api/tools/vm-clone/corps/mounts', { method: 'PUT', body: JSON.stringify({ corpKey: corp.key, mountIds: null }) })).body.mountUse;
    o.editAfterClear = (await save('m-no', { id: okJob.body.job.id })).status;
    return o;
  `);
  assert.equal(o.initial, null, '지정이 없으면 null(전부)');
  assert.equal(o.notVisible, 404); assert.equal(o.readOnly, 403); assert.equal(o.bad, 400); assert.equal(o.unassigned, 404);
  assert.deepEqual(o.set, [200, ['m-ok']]); assert.deepEqual(o.viewAfter, ['m-ok']);
  assert.equal(o.denied[0], 400); assert.match(o.denied[1], /지정하지 않은 마운트/);
  assert.equal(o.ok, 201); assert.equal(o.editSame, 201); assert.equal(o.editMove, 400);
  assert.equal(o.clear, null); assert.equal(o.editAfterClear, 201);
});

/* ── 3회차: 실패 메일(vmclone/notify.js) ───────────────────────────────── */

test('M1: collectNewFailures — 기준 시각 이후의 실패만 · 건너뜀(데모·위임·멈춤)은 알리지 않는다 · 성공 줄도 기준을 옮긴다', async () => {
  const { collectNewFailures, isMailableFailure } = await import('../src/vmclone/notify.js');
  const src = [
    { jobId: 'j1', vmName: 'web01', vcenterId: 'vcA', corp: '중앙', history: [
      { at: 100, kind: 'backup', ok: false, detail: '옛 실패' },
      { at: 300, kind: 'backup', ok: false, detail: '스냅샷 실패' },
      { at: 400, kind: 'verify', ok: false, detail: 'Tools 무응답' },
      { at: 500, kind: 'backup', ok: false, skipped: 'delegated', detail: '위임' },
    ] },
    { jobId: 'j2', vmName: 'db01', vcenterId: 'vcB', corp: 'edge-kr', history: [{ at: 600, kind: 'backup', ok: true, detail: 'ok' }] },
    { jobId: 'j3', vmName: 'x', vcenterId: 'vcB', corp: 'edge-kr', history: [{ at: 50, kind: 'restore', ok: false, detail: '설치 전' }] },
  ];
  const r = collectNewFailures(src, { since: 200, jobs: { j1: 250 } });
  assert.deepEqual(r.rows.map((x) => [x.jobId, x.kind, x.detail]), [['j1', '백업', '스냅샷 실패'], ['j1', '검증', 'Tools 무응답']]);
  assert.deepEqual(r.marks, { j1: 500, j2: 600 }, '건너뜀·성공 줄도 기준을 옮긴다 · since 이전(j3)은 보지 않는다');
  const again = collectNewFailures(src, { since: 200, jobs: { j1: 500, j2: 600 } });
  assert.equal(again.rows.length, 0); assert.deepEqual(again.marks, {});
  assert.equal(isMailableFailure({ at: 1, ok: false, skipped: 'restart-cleanup-gave-up' }), true, '정리 포기는 알린다');
  assert.equal(isMailableFailure({ at: 1, ok: false, skipped: 'demo-job' }), false);
});

test('M2: sourcesOf — 엣지 이력 시각은 수신 시각으로 자른다 · 이름은 중앙 정의 · 위임 잡은 한 번만', async () => {
  const { sourcesOf, collectNewFailures } = await import('../src/vmclone/notify.js');
  const jobs = [{ id: 'j1', vmName: 'web01', vcenterId: 'vcA', history: [{ at: 1, ok: false }] }, { id: 'j9', vmName: 'local', vcenterId: 'vcC', history: [] }];
  const edges = [{ agent: 'edge-kr', at: 1000, jobs: new Map([['j1', { history: [{ at: 999_999, kind: 'backup', ok: false, detail: '미래 시계' }] }], ['nope', { history: [{ at: 5, ok: false }] }]]) }];
  const s = sourcesOf(jobs, edges);
  assert.deepEqual(s.map((x) => [x.jobId, x.corp, x.vmName]), [['j1', 'edge-kr', 'web01'], ['j9', '중앙', 'local']]);
  assert.equal(s[0].history[0].at, 1000, '엣지 시계가 앞서도 수신 시각을 넘지 않는다');
  const r = collectNewFailures(s, { since: 0, jobs: {} });
  assert.equal(r.marks.j1, 1000);
});

test('M3: renderFailureMail — HTML 이스케이프 · 제목 VM 3개까지 · 상한 넘으면 개수만', async () => {
  const { renderFailureMail } = await import('../src/vmclone/notify.js');
  const rows = Array.from({ length: 55 }, (_, i) => ({ at: Date.UTC(2026, 9, 26, 1, i), jobId: 'j' + i, vmName: i === 0 ? '<b>evil</b>' : `vm${i}`, vcenterId: 'vcA', corp: '중앙', kind: '백업', detail: i === 0 ? '<script>x</script>' : 'fail' }));
  const m = renderFailureMail(rows, (id) => (id === 'vcA' ? 'VC-서울' : id));
  assert.match(m.subject, /^\[VM 백업\] 실패 55건 — <b>evil<\/b>, vm1, vm2 외 52$/);
  assert.doesNotMatch(m.html, /<script>|<b>evil/);
  assert.match(m.html, /&lt;script&gt;/); assert.match(m.html, /VC-서울/);
  assert.match(m.html, /그 밖에 5건/);
});

test('M4: tick — 실패를 한 통으로 보내고 기준을 옮긴다 · 발송 실패면 옮기지 않는다 · 메일이 꺼져 있으면 기준만 옮긴다', () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'vmc2794m-'));
  fs.writeFileSync(path.join(cfg, 'vm-clone.json'), JSON.stringify({ version: 1, ops: [], jobs: [{ id: 'j1', vcenterId: 'vcA', vmId: 'vcA:vm-1', vmName: 'web01', dest: { type: 'datastore', datastoreName: 'ds' }, schedule: { mode: 'manual' }, keep: 2, enabled: true, clones: [], history: [] }] }));
  const script = `
    import { mock } from 'node:test';
    globalThis.SENT = []; globalThis.MAIL = { enabled: true, kinds: {} }; globalThis.FAILSEND = false;
    mock.module(${J('mail/service.js')}, { namedExports: { sendPortalMail: async (m) => { globalThis.SENT.push(m); return globalThis.FAILSEND ? { ok: false, reason: 'SMTP 오류' } : { ok: true }; } } });
    mock.module(${J('mail/settings.js')}, { namedExports: { load: () => globalThis.MAIL } });
    mock.module(${J('store.js')}, { namedExports: { store: { get: () => ({ source: 'live', vcenters: [{ id: 'vcA', name: 'VC-A' }] }) } } });
    const st = await import(${J('vmclone/store.js')});
    const n = await import(${J('vmclone/notify.js')});
    const fail = (detail) => st.recordRun('j1', { ok: false, detail, ms: 1 });
    const out = {};
    await n.tick();                               // 처음 — 지금부터 센다(지난 이력 없음)
    await new Promise((r) => setTimeout(r, 5));
    fail('A'); fail('B');
    globalThis.FAILSEND = true; await n.tick();
    out.afterFail = [globalThis.SENT.length, n.vmBackupMailStatus().sent];
    globalThis.FAILSEND = false; await n.tick();
    out.afterOk = [globalThis.SENT.length, globalThis.SENT.at(-1).kind, globalThis.SENT.at(-1).subject, (globalThis.SENT.at(-1).text.match(/web01/g) || []).length];
    await n.tick();
    out.noDup = globalThis.SENT.length;
    globalThis.MAIL = { enabled: false }; fail('C'); await n.tick();
    globalThis.MAIL = { enabled: true, kinds: {} }; await n.tick();
    out.offThenOn = globalThis.SENT.length;
    console.log(JSON.stringify(out));
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, CONFIG_DIR: cfg, DATA_SOURCE: 'live' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.deepEqual(out.afterFail, [1, false], '발송 실패 — 기록');
  assert.equal(out.afterOk[0], 2, '다음 주기에 같은 실패를 다시 보낸다');
  assert.equal(out.afterOk[1], 'vm-backup');
  assert.match(out.afterOk[2], /실패 2건 — web01/);
  assert.equal(out.noDup, 2, '보낸 실패는 다시 보내지 않는다');
  assert.equal(out.offThenOn, 2, '메일이 꺼져 있던 동안의 실패는 켠 뒤 쏟지 않는다');
});
