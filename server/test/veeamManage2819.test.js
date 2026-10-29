import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

// v2.819 포탈 백업 관리 — 복원 지점 · 새 VM 으로만 복원 · 포탈 잡에서 빼기 · 백업 삭제(포탈 잡 · 이 VM 만) · 포탈 백업 VM 목록 · 라우트 범위.
// 실제 VBR 은 없다 — 가짜 응답으로 '보내지 않을 것' 과 '결과 모름' 계약을 고정한다.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-veeammanage-'));
process.env.CONFIG_DIR = CFG;
process.env.AUTH_ENABLED = 'false';   // reauth 는 인증이 꺼져 있으면 통과(라우트 범위·검증만 본다)

const manage = await import('../src/veeam/run/manage.js');
const ops = await import('../src/veeam/run/ops.js');
const parse = await import('../src/veeam/run/parse.js');
const portalVms = await import('../src/veeam/run/portalVms.js');
const runs = await import('../src/veeam/run/runs.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

function fakeVbr(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    let body = init.body;
    try { body = typeof body === 'string' && body.startsWith('{') ? JSON.parse(body) : body; } catch { /* form */ }
    calls.push({ key, body, query: Object.fromEntries(u.searchParams) });
    const h = routes[key];
    const r = typeof h === 'function' ? h({ body, url: u }) : h;
    if (r === 'THROW') { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('reset'), { code: 'ECONNRESET' }); throw e; }
    if (!r) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    return new Response(r.status === 204 ? null : (r.json !== undefined ? JSON.stringify(r.json) : ''), { status: r.status || 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  fn.writes = () => calls.filter((c) => c.key.startsWith('POST /api/v1/') || c.key.startsWith('PUT ') || c.key.startsWith('DELETE '));
  return fn;
}
const TOKEN = { 'POST /api/oauth2/token': { json: { access_token: 't' } }, 'POST /api/oauth2/logout': { status: 200 } };
const SRV = { id: 'vbr-1', name: 'OC2', host: 'vbr.corp.local', port: 9419, username: 'svc', password: 'pw', enabled: true, agent: '' };
const VM = { name: 'LESAREP02', objectId: 'vm-77', hostName: 'oc2-vc.corp.local' };
const MARK = 'x [vmware-portal:managed] y';
const JOB = (includes, description = MARK) => ({ 'GET /api/v1/jobs': { json: { data: [{ id: 'job-1', name: 'PORTAL-OC2-d6c8d5' }] } },
  'GET /api/v1/jobs/job-1': { json: { id: 'job-1', name: 'PORTAL-OC2-d6c8d5', description, virtualMachines: { includes } } } });
const INC = (n, o) => ({ type: 'VirtualMachine', hostName: 'oc2-vc.corp.local', name: n, objectId: o });

test('복원 지점: v1.1 objectRestorePoints · 이름 정확 일치만 · 백업→잡 이름 · 포탈 잡 표지 · 포함 여부', async () => {
  const f = fakeVbr({ ...TOKEN, ...JOB([INC('LESAREP02', 'vm-77'), INC('other', 'vm-5')]),
    'GET /api/v1/objectRestorePoints': { json: { data: [
      { id: 'rp-1', name: 'LESAREP02', creationTime: '2026-10-29T12:27:00Z', backupId: 'bk-1' },
      { id: 'rp-2', name: 'LESAREP02-old', creationTime: '2026-10-28T12:27:00Z', backupId: 'bk-1' },   // 이름 앞부분만 같은 다른 VM — 빼야 한다
      { id: 'rp-3', name: 'LESAREP02', creationTime: '2026-10-29T13:00:00Z', backupId: 'bk-2' }] } },
    'GET /api/v1/backups/bk-1': { json: { id: 'bk-1', name: 'PORTAL-OC2-d6c8d5', jobId: 'job-1' } },
    'GET /api/v1/backups/bk-2': { json: { id: 'bk-2', name: 'Daily', jobId: 'job-9' } },
    'GET /api/v1/jobs/job-9': { json: { id: 'job-9', name: 'Daily', description: 'made by human' } },
  });
  const r = await manage.opVmPoints(SRV, { vm: VM, jobName: 'PORTAL-OC2-d6c8d5', fetchImpl: f });
  assert.equal(r.ok, true, r.reason); assert.equal(r.variant, 'objectRestorePoints');
  assert.deepEqual(r.points.map((p) => [p.id, p.jobName, p.portal]), [['rp-3', 'Daily', false], ['rp-1', 'PORTAL-OC2-d6c8d5', true]]);   // 최신 먼저
  assert.deepEqual(r.job, { id: 'job-1', name: 'PORTAL-OC2-d6c8d5', found: true, marker: true, included: true });
  assert.equal(f.writes().length, 0, '읽기만 한다');
  // 옛 경로 후보
  const g = fakeVbr({ ...TOKEN, 'GET /api/v1/restorePoints': { json: { data: [{ id: 'rp-9', name: 'LESAREP02', creationTime: '2026-10-29T01:00:00Z' }] } } });
  const r2 = await manage.opVmPoints(SRV, { vm: VM, fetchImpl: g });
  assert.equal(r2.variant, 'restorePoints'); assert.equal(r2.points[0].id, 'rp-9');
});

test('복원: 항상 새 VM(type Customized · 전원 꺼짐) · 복원 지점이 다른 VM 것이면 보내지 않음 · 응답 없음은 unknown(다음 후보 없음)', async () => {
  const dest = { hostName: 'oc2-vc.corp.local', host: { name: 'esxi-01', objectId: 'host-11' } };
  const ok = fakeVbr({ ...TOKEN, 'GET /api/v1/objectRestorePoints/rp-1': { json: { id: 'rp-1', name: 'LESAREP02' } },
    [`POST ${manage.RESTORE_PATH}`]: { status: 201, json: { id: 'sess-r1', state: 'Starting' } } });
  const r = await manage.opRestoreVm(SRV, { restorePointId: 'rp-1', vm: VM, newName: 'LESAREP02-restored-1', dest, fetchImpl: ok });
  assert.equal(r.ok, true, r.reason); assert.equal(r.sessions[0].id, 'sess-r1');
  const body = ok.writes()[0].body;
  assert.equal(body.type, 'Customized'); assert.equal(body.powerUp, false); assert.equal(body.vmName, 'LESAREP02-restored-1');
  assert.deepEqual(body.destinationHost, { type: 'Host', hostName: 'oc2-vc.corp.local', name: 'esxi-01', objectId: 'host-11' });
  // 다른 VM 의 복원 지점
  const other = fakeVbr({ ...TOKEN, 'GET /api/v1/objectRestorePoints/rp-1': { json: { id: 'rp-1', name: 'someone-else' } } });
  const r2 = await manage.opRestoreVm(SRV, { restorePointId: 'rp-1', vm: VM, newName: 'x-1', dest, fetchImpl: other });
  assert.equal(r2.ok, false); assert.equal(r2.notSent, true); assert.equal(other.writes().length, 0);
  // 원본과 같은 이름 · 형식 위반은 보내기 전에 거절
  for (const nn of ['LESAREP02', 'lesarep02', '-bad', 'a b', '']) {
    const z = fakeVbr({ ...TOKEN });
    const rz = await manage.opRestoreVm(SRV, { restorePointId: 'rp-1', vm: VM, newName: nn, dest, fetchImpl: z });
    assert.equal(rz.notSent, true, nn); assert.equal(z.calls.length, 0, nn);
  }
  // 응답 없음 → unknown, 두 번째 후보로 다시 보내지 않는다
  const t = fakeVbr({ ...TOKEN, 'GET /api/v1/objectRestorePoints/rp-1': { json: { id: 'rp-1', name: 'LESAREP02' } }, [`POST ${manage.RESTORE_PATH}`]: 'THROW' });
  const r3 = await manage.opRestoreVm(SRV, { restorePointId: 'rp-1', vm: VM, newName: 'n-1', dest, fetchImpl: t });
  assert.equal(r3.unknown, true); assert.equal(t.writes().length, 1);
  // 모양 거절 → 최소 본문 후보
  let n = 0;
  const s = fakeVbr({ ...TOKEN, 'GET /api/v1/objectRestorePoints/rp-1': { json: { id: 'rp-1', name: 'LESAREP02' } },
    [`POST ${manage.RESTORE_PATH}`]: ({ body: b }) => (++n === 1 ? { status: 400, json: { message: 'restoreProxies' } } : { status: 201, json: { id: 'sess-2', state: 'Starting' } }) });
  const r4 = await manage.opRestoreVm(SRV, { restorePointId: 'rp-1', vm: VM, newName: 'n-2', dest, fetchImpl: s });
  assert.equal(r4.variant, 'vmRestore:min'); assert.equal(s.writes()[1].body.type, 'Customized');
});

test('원래 위치 복원은 코드에 없다 — 복원 type 은 상수 하나(Customized)', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '../src/veeam/run/manage.js'), 'utf8'));
  assert.ok(!/OriginalLocation/i.test(src), 'manage.js 코드에 OriginalLocation 이 있으면 안 된다');
  assert.equal(manage.RESTORE_TYPE, 'Customized');
  assert.equal((src.match(/type:\s*RESTORE_TYPE/g) || []).length, 2, '두 후보 모두 RESTORE_TYPE');
});

test('잡에서 빼기: 표지 없는 잡은 고치지 않음 · 그 VM 만 뺀다 · 마지막 VM 은 빼지 않음', async () => {
  const human = fakeVbr({ ...TOKEN, ...JOB([INC('LESAREP02', 'vm-77'), INC('b', 'vm-2')], 'made by human') });
  const r0 = await manage.opJobExclude(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vms: [VM], fetchImpl: human });
  assert.equal(r0.notSent, true); assert.equal(human.writes().length, 0);
  const f = fakeVbr({ ...TOKEN, ...JOB([INC('LESAREP02', 'vm-77'), INC('b', 'vm-2')]), 'PUT /api/v1/jobs/job-1': { json: {} } });
  const r = await manage.opJobExclude(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vms: [VM], fetchImpl: f });
  assert.equal(r.ok, true); assert.equal(r.removed, 1);
  assert.deepEqual(f.writes()[0].body.virtualMachines.includes.map((x) => x.objectId), ['vm-2']);
  const last = fakeVbr({ ...TOKEN, ...JOB([INC('LESAREP02', 'vm-77')]) });
  const r2 = await manage.opJobExclude(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vms: [VM], fetchImpl: last });
  assert.equal(r2.notSent, true); assert.match(r2.reason, /마지막 VM/); assert.equal(last.writes().length, 0);
});

test('백업 삭제: 포탈 잡만 · 먼저 잡에서 뺀다 · 다른 VM 이 든 백업은 통째로 지우지 않는다 · 응답 없음은 unknown', async () => {
  const base = { ...TOKEN, ...JOB([INC('LESAREP02', 'vm-77'), INC('b', 'vm-2')]), 'PUT /api/v1/jobs/job-1': { json: {} },
    'GET /api/v1/backups': { json: { data: [{ id: 'bk-1', jobId: 'job-1' }] } },
    'GET /api/v1/backups/bk-1/objects': { json: { data: [{ id: 'obj-77', name: 'LESAREP02' }, { id: 'obj-2', name: 'b' }] } } };
  // 사람이 만든 잡
  const human = fakeVbr({ ...base, ...JOB([INC('LESAREP02', 'vm-77')], 'human') });
  const h = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: human });
  assert.equal(h.notSent, true); assert.equal(human.writes().length, 0);
  // VM 단위 삭제 성공
  const ok = fakeVbr({ ...base, 'DELETE /api/v1/backupObjects/obj-77': { status: 202, json: {} } });
  const r = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: ok });
  assert.equal(r.ok, true, r.reason); assert.equal(r.excluded, true); assert.equal(r.deleted, 1);
  assert.deepEqual(ok.writes().map((c) => c.key), ['PUT /api/v1/jobs/job-1', 'DELETE /api/v1/backupObjects/obj-77'], '빼기 → 삭제 순서');
  // VM 단위 경로가 없고 백업에 다른 VM 도 있다 → 백업 통째 삭제 금지
  const no = fakeVbr({ ...base });
  const r2 = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: no });
  assert.equal(r2.ok, false); assert.equal(r2.excluded, true); assert.match(r2.reason, /Delete from disk/);
  assert.ok(!no.writes().some((c) => c.key === 'DELETE /api/v1/backups/bk-1'));
  // 그 백업에 이 VM 하나뿐이면 백업 삭제 후보
  const only = fakeVbr({ ...base, 'GET /api/v1/backups/bk-1/objects': { json: { data: [{ id: 'obj-77', name: 'LESAREP02' }] } }, 'DELETE /api/v1/backups/bk-1': { status: 204 } });
  const r3 = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: only });
  assert.equal(r3.ok, true); assert.equal(r3.variant, 'backup(only-this-vm)');
  // 삭제 요청 응답 없음 → unknown
  const t = fakeVbr({ ...base, 'DELETE /api/v1/backupObjects/obj-77': 'THROW' });
  const r4 = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: t });
  assert.equal(r4.unknown, true);
  // 잡에서 빼기가 실패하면 지우지 않는다
  const exFail = fakeVbr({ ...base, 'PUT /api/v1/jobs/job-1': { status: 409, json: { message: 'job is running' } } });
  const r5 = await manage.opDeleteBackup(SRV, { jobName: 'PORTAL-OC2-d6c8d5', vm: VM, fetchImpl: exFail });
  assert.equal(r5.ok, false); assert.ok(!exFail.writes().some((c) => c.key.startsWith('DELETE')));
});

test('작업 표: 새 작업은 상태 변경으로 분류 · 결과는 정제(모르는 필드 버림)', () => {
  for (const k of ['restoreVm', 'jobExclude', 'deleteBackup']) assert.ok(ops.MUTATING.has(k), k);
  assert.ok(!ops.MUTATING.has('vmPoints'));
  const s = parse.SANITIZERS.vmPoints({ ok: true, points: [{ id: 'rp', name: 'n', creationTime: '2026-10-29T00:00:00Z', password: 'x', evil: 1 }, { name: 'no-id' }] });
  assert.equal(s.points.length, 1); assert.ok(!JSON.stringify(s).includes('password'));
  const m = parse.SANITIZERS.deleteBackup({ ok: true, deleted: '2', excluded: true, extra: 'x' });
  assert.equal(m.deleted, 2); assert.ok(!('extra' in m));
});

test('포탈 백업 VM 목록: 보낸 VM 만(건너뜀 제외) · 복원은 기존 VM 에만 덧붙인다 · 빼냄 기록', () => {
  portalVms._resetForTest();
  const run = { id: 'vbr_a', at: 1000, groups: [{ serverId: 's', kind: 'portal', vcenterId: 'vc', jobName: 'PORTAL-x' }],
    vms: [{ vmId: 'vc:vm-1', name: 'a', vcenterId: 'vc', objectId: 'vm-1', hostName: 'h', serverId: 's', serverName: 'S', how: 'portal', state: 'success' },
      { vmId: 'vc:vm-2', name: 'b', vcenterId: 'vc', serverId: 's', how: 'skip', state: 'skipped' }] };
  assert.equal(portalVms.notePortalRun(run), true);
  assert.equal(portalVms.notePortalRun(run), false, '바뀐 것이 없으면 쓰지 않는다');
  assert.deepEqual(portalVms.listPortalVms().map((r) => [r.vmId, r.jobName, r.lastState]), [['vc:vm-1', 'PORTAL-x', 'success']]);
  portalVms.notePortalRun({ id: 'vbr_r', at: 2000, groups: [], vms: [
    { vmId: 'vc:vm-1', name: 'a', vcenterId: 'vc', how: 'restore', state: 'running', restore: { newName: 'a-r1' } },
    { vmId: 'vc:vm-9', name: 'z', vcenterId: 'vc', how: 'restore', state: 'running', restore: { newName: 'z-r1' } }] });
  assert.equal(portalVms.getPortalVm('vc:vm-1').restores[0].newName, 'a-r1');
  assert.equal(portalVms.getPortalVm('vc:vm-9'), null, '포탈로 백업한 적 없는 VM 의 복원은 목록에 새로 만들지 않는다');
  portalVms.notePortalVm('vc:vm-1', { excludedAt: 3000 });
  assert.equal(portalVms.getPortalVm('vc:vm-1').excludedAt, 3000);
  assert.equal(portalVms.listPortalVms({ allowed: new Set(['other']) }).length, 0, '범위 밖 vCenter 는 빼고');
});

test('라우트: VM 단건 조회 밖 404 → 쓰기 밖 403 · 새 이름 겹침 409 · 삭제 이름 재입력 · 목록은 범위 교집합', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const reg = await import('../src/veeam/registry.js');
  const { registerBackupManage, suggestName } = await import('../src/routes/api/backupManage.js');
  reg.saveServer({ name: 'OC2', host: 'vbr.corp.local', port: 9419, username: 'svc', password: 'pw', vcenterIds: ['kr1'] });
  const SNAP = { vcenters: [{ id: 'kr1', name: 'kr1' }, { id: 'kr2', name: 'kr2' }, { id: 'us1', name: 'us1' }],
    hosts: [{ id: 'kr1:host-11', vcenterId: 'kr1', name: 'esxi-01' }],
    vms: [{ id: 'kr1:vm-1', vcenterId: 'kr1', name: 'a', host: 'esxi-01' }, { id: 'kr1:vm-5', vcenterId: 'kr1', name: 'taken', host: 'esxi-01' },
      { id: 'kr2:vm-2', vcenterId: 'kr2', name: 'b' }, { id: 'us1:vm-3', vcenterId: 'us1', name: 'c' }] };
  const origGet = store.get; store.get = () => SNAP;
  portalVms._resetForTest(); runs._resetForTest();
  portalVms.notePortalRun({ id: 'vbr_1', at: 1, groups: [], vms: [{ vmId: 'us1:vm-3', name: 'c', vcenterId: 'us1', how: 'quick', state: 'success' }, { vmId: 'kr1:vm-1', name: 'a', vcenterId: 'kr1', objectId: 'vm-1', hostName: 'kr1-vc.corp.local', how: 'quick', state: 'success' }] });
  const user = { username: 'scoped', role: 'admin', scope: { vcenters: ['kr1', 'kr2'], regions: [], writeVcenters: ['kr1'] } };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupManage(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  const b = `http://127.0.0.1:${srv.address().port}/api/tools/backup-run`;
  const post = (p, body) => fetch(`${b}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const list = await (await fetch(`${b}/portal-vms`)).json();
    assert.deepEqual(list.vms.map((v) => v.vmId), ['kr1:vm-1'], '범위 밖 us1 은 목록에서 빠진다');
    assert.equal((await fetch(`${b}/portal-vms?vcenterId=us1`)).status, 404);
    assert.equal((await fetch(`${b}/vm/${encodeURIComponent('us1:vm-3')}`)).status, 404);
    const one = await (await fetch(`${b}/vm/${encodeURIComponent('kr1:vm-1')}`)).json();
    assert.equal(one.ok, true); assert.equal(one.canRestore, true); assert.match(one.suggestName, /^a-restored-\d{8}-\d{4}$/);
    assert.equal((await post(`/vm/${encodeURIComponent('us1:vm-3')}/restore`, { restorePointId: 'rp-1', newName: 'x-1' })).status, 404);
    assert.equal((await post(`/vm/${encodeURIComponent('kr2:vm-2')}/restore`, { restorePointId: 'rp-1', newName: 'x-1' })).status, 403);
    assert.equal((await post(`/vm/${encodeURIComponent('kr2:vm-2')}/exclude`, {})).status, 403);
    assert.equal((await post(`/vm/${encodeURIComponent('kr2:vm-2')}/delete-backup`, { confirmName: 'b' })).status, 403);
    assert.equal((await post(`/vm/${encodeURIComponent('kr1:vm-1')}/restore`, { restorePointId: 'rp-1', newName: 'TAKEN' })).status, 409, '인벤토리 이름과 겹침');
    assert.equal((await post(`/vm/${encodeURIComponent('kr1:vm-1')}/restore`, { restorePointId: 'rp-1', newName: 'bad name' })).status, 400);
    assert.equal((await post(`/vm/${encodeURIComponent('kr1:vm-1')}/delete-backup`, { confirmName: 'A' })).status, 400, '이름 재입력이 다르면 거절');
  } finally { store.get = origGet; srv.close(); }
  assert.equal(suggestName('한글 VM', new Set(), new Date(2026, 9, 29, 21, 5)), 'VM-restored-20261029-2105');
  assert.equal(suggestName('web 01', new Set(['web-01-restored-20261029-2105']), new Date(2026, 9, 29, 21, 5)), 'web-01-restored-20261029-2105-2');
});
