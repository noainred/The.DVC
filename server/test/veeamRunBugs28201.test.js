import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.820.1 Veeam 백업 실행·관리 버그 수정 회귀(사용자 요청 '버그 5개 찾아서 수정' — 2026-10-30).
//  B1 복원 지점 '있음(개수 모름)'(rp -1)을 미보호로 판정 → 이미 백업된 VM 이 포탈 전용 잡에도 들어갔다
//  B3 Veeam 서버 등록부를 못 읽은 채 설정을 저장하면 서버별 저장소·보존이 전부 지워졌다
//  B5 VM 하나만 담은 세션(복원·VM 별 Quick)이 작업 목록에 그 VM 이름이 없다는 이유로 '확인 불가' 가 됐다
// (B2·B4 는 웹 — web/src/views/tools/backupRunText.test.js)
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-veeambugs-'));
process.env.CONFIG_DIR = CFG;
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(CFG, 'veeam-servers.json'), '{ broken json');   // B3: 등록부 손상

const plan = await import('../src/veeam/run/plan.js');
const runs = await import('../src/veeam/run/runs.js');
const settings = await import('../src/veeam/run/settings.js');

test('B1: 복원 지점 있음(개수 모름, rp -1)은 보호됨 — 미보호로 보고 포탈 전용 잡에 넣지 않는다', () => {
  const vm = { id: 'vc1:vm-7', vcenterId: 'vc1', name: 'db' };
  const servers = [{ id: 's1', name: 'VBR-KR' }];
  const r = plan.runStatusOf(vm, { servers, known: true, entry: { rp: -1, jobs: ['Daily'], servers: ['VBR-KR'] } });
  assert.equal(r.status, 'protected');
  assert.equal(r.serverId, 's1');
  // 서버를 모르면 elsewhere(보내지 않음) — in-job/unprotected 가 아니다
  assert.equal(plan.runStatusOf(vm, { servers, known: true, entry: { rp: -1, jobs: ['Daily'], servers: ['OTHER'] } }).status, 'elsewhere');
  // 기본 설정(미보호 → 포탈 잡)으로 배정해도 포탈 잡으로 가지 않는다
  const p = plan.planBackup([{ vm, run: r, hostName: 'vc1.local' }], { mode: 'quick', unprotected: 'portal' });
  assert.deepEqual(p.vms.map((v) => v.how), ['quick']);
  // 0 은 여전히 '복원 지점 없음'
  assert.equal(plan.runStatusOf(vm, { servers, known: true, entry: { rp: 0, jobs: ['Daily'], servers: ['VBR-KR'] } }).status, 'in-job');
});

test('B3: 등록부를 못 읽으면 백업 실행 설정 저장은 503 — 서버별 저장소·보존이 지워지지 않는다', async () => {
  settings._resetForTest();
  fs.writeFileSync(path.join(CFG, 'veeam-backup-run.json'), JSON.stringify({ version: 1, jobPrefix: 'PORTAL-', servers: { 'vbr-a': { repositoryId: 'repo-1', retention: 14 } }, hosts: {} }));
  const express = (await import('express')).default;
  const { registerBackupRun } = await import('../src/routes/api/backupRun.js');
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin' }; next(); });
  const api = express.Router(); registerBackupRun(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  try {
    const b = `http://127.0.0.1:${srv.address().port}/api/tools/backup-run/settings`;
    const g = await (await fetch(b)).json();
    assert.equal(g.registryUnreadable, true); assert.deepEqual(g.servers, []);
    // 화면은 서버 목록이 비어 servers:{} 를 보낸다 — 그대로 저장하면 repo-1 이 사라진다
    const r = await fetch(b, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobPrefix: 'PORTAL-', servers: {}, hosts: {} }) });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).registryUnreadable, true);
    settings._resetForTest();
    assert.equal(settings.serverRunSettings('vbr-a').repositoryId, 'repo-1', '저장소 설정이 남아 있다');
  } finally { srv.close(); }
});

test('B5: VM 하나만 담은 세션(복원)은 작업 목록에 그 이름이 없어도 세션 결과로 판정 · 여러 VM 세션은 그대로 단정하지 않음', () => {
  const restoreRun = { vms: [{ vmId: 'a', name: 'erp-db', objectId: 'vm-10', sessionId: 's1', state: 'running', how: 'restore', restore: { newName: 'erp-db-restored-1' } }],
    groups: [{ kind: 'restore', sessions: [{ id: 's1', objectIds: ['vm-10'] }] }] };
  // 복원 작업은 새 VM 이름으로 기록될 수 있다
  runs.applySession(restoreRun, 's1', { finished: true, tasksKnown: true, result: 'Success', tasks: [{ name: 'erp-db-restored-1', result: 'Success', state: 'Stopped', progress: 100 }] });
  assert.equal(restoreRun.vms[0].state, 'success');
  // 작업 목록이 비어 있어도(이 세션 종류에 작업이 없음) 이 VM 만의 세션이면 세션 결과
  const quick1 = { vms: [{ vmId: 'b', name: 'web', objectId: 'vm-3', sessionId: 's2', state: 'running', how: 'quick' }], groups: [{ kind: 'quick', sessions: [{ id: 's2', objectIds: ['vm-3'] }] }] };
  runs.applySession(quick1, 's2', { finished: true, tasksKnown: true, result: 'Warning', message: 'slow', tasks: [] });
  assert.equal(quick1.vms[0].state, 'warning');
  // 여러 VM 을 담은 세션(포탈 잡)은 작업 기록이 없는 VM 을 세션 결과로 단정하지 않는다(기존 규칙)
  const multi = { vms: [{ vmId: 'c', name: 'x', objectId: 'vm-1', sessionId: 's3', state: 'running' }, { vmId: 'd', name: 'y', objectId: 'vm-2', sessionId: 's3', state: 'running' }],
    groups: [{ kind: 'portal', sessions: [{ id: 's3', objectIds: ['vm-1', 'vm-2'] }] }] };
  runs.applySession(multi, 's3', { finished: true, tasksKnown: true, result: 'Success', tasks: [{ name: 'x', result: 'Success', state: 'Stopped' }] });
  assert.deepEqual(multi.vms.map((v) => v.state), ['success', 'unknown']);
});
