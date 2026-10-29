import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.822.2 포탈 백업 진행 상세 · 백업 대상 VM 크기(사용자 요청 2026-10-30 '백업하는 세부 내용' · 'VM 크기').
// 실제 VBR 의 작업 세션 용량·시각 필드 이름은 추정(모니터링 모듈과 같은 후보) — 못 읽으면 null 이고 0 을 만들지 않는다.
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-veeamdetail-'));
process.env.CONFIG_DIR = CFG;
process.env.AUTH_ENABLED = 'false';

const P = await import('../src/veeam/run/parse.js');
const plan = await import('../src/veeam/run/plan.js');
const runs = await import('../src/veeam/run/runs.js');
const portalVms = await import('../src/veeam/run/portalVms.js');

test('세션·작업 원문 → 진행 상세(시작·용량) · 정제는 아는 필드만 · 음수·문자는 null', () => {
  const s = P.sessionFrom({ id: 's1', state: 'Working', creationTime: '2026-10-30T00:00:00Z', progress: { progressPercent: 37 } },
    [{ name: 'erp', objectId: 'vm-1', state: 'Working', creationTime: '2026-10-30T00:01:00Z', progress: { progressPercent: 40, processedSize: 120e9, readSize: 100e9, transferredSize: 50e9 } },
      { name: 'web', progress: { progressPercent: 5 } }]);
  assert.equal(s.startedAt, Date.parse('2026-10-30T00:00:00Z'));
  assert.deepEqual([s.tasks[0].processedBytes, s.tasks[0].readBytes, s.tasks[0].transferredBytes], [120e9, 100e9, 50e9]);
  assert.deepEqual([s.tasks[1].processedBytes, s.tasks[1].startedAt], [null, null], '없는 값은 null(0 아님)');
  // 엣지 회신 정제 — 모르는 필드는 버리고, 음수·문자열 숫자 아닌 값은 null
  const out = P.sanitizeSessions({ ok: true, sessions: [{ ...s, id: 's1', ok: true, evil: 'x', tasks: [{ ...s.tasks[0], processedBytes: -5, readBytes: 'abc', token: 't' }] }] }).sessions[0];
  assert.ok(!('evil' in out)); assert.ok(!('token' in out.tasks[0]));
  assert.deepEqual([out.tasks[0].processedBytes, out.tasks[0].readBytes, out.tasks[0].transferredBytes], [null, null, 50e9]);
});

test('applySession 이 VM 별 진행 지표를 남긴다 — 작업 값(vm) · 없으면 세션 값(session)', () => {
  const run = { vms: [{ vmId: 'a', name: 'erp', objectId: 'vm-1', sessionId: 's1', state: 'running' }, { vmId: 'b', name: 'zzz', objectId: 'vm-9', sessionId: 's1', state: 'running' }],
    groups: [{ kind: 'portal', sessions: [{ id: 's1', objectIds: ['vm-1', 'vm-9'] }] }] };
  const s = P.sanitizeSessions({ ok: true, sessions: [{ ...P.sessionFrom({ id: 's1', state: 'Working', creationTime: '2026-10-30T00:00:00Z', progress: { progressPercent: 30 } },
    [{ name: 'erp', objectId: 'vm-1', state: 'Working', creationTime: '2026-10-30T00:01:00Z', progress: { progressPercent: 40, processedSize: 120e9, transferredSize: 50e9 } }]), id: 's1', ok: true }] }).sessions[0];
  runs.applySession(run, 's1', s);
  const a = run.vms[0].metrics; const b = run.vms[1].metrics;
  assert.equal(a.scope, 'vm'); assert.equal(a.processedBytes, 120e9); assert.equal(a.startedAt, Date.parse('2026-10-30T00:01:00Z')); assert.equal(a.sessionState, 'Working');
  assert.equal(run.vms[0].progress, 40);
  assert.equal(b.scope, 'session', '작업 기록이 없는 VM 은 세션 값(화면이 세션 전체라고 말한다)'); assert.equal(b.processedBytes, null); assert.equal(b.startedAt, Date.parse('2026-10-30T00:00:00Z'));
});

test('VM 크기 — 사용량(committed) · 할당량(committed+uncommitted, 둘 다 있을 때만) · 못 읽음은 null', () => {
  assert.deepEqual(plan.vmSizeOf({ storageGB: 120.5, uncommittedGB: 79.5 }), { sizeGB: 120.5, provisionedGB: 200 });
  assert.deepEqual(plan.vmSizeOf({ storageGB: 120, uncommittedGB: null }), { sizeGB: 120, provisionedGB: null });
  assert.deepEqual(plan.vmSizeOf({ storageGB: null }), { sizeGB: null, provisionedGB: null });
  assert.deepEqual(plan.vmSizeOf(undefined), { sizeGB: null, provisionedGB: null });
  // 계획 행에 크기가 실린다(실행 기록으로 이어진다)
  const p = plan.planBackup([{ vm: { id: 'vc:vm-1', vcenterId: 'vc', name: 'a', storageGB: 10, uncommittedGB: 5 }, run: { status: 'unprotected', serverId: 's', serverName: 'S', objectId: 'vm-1' }, hostName: 'vc.local' }], {});
  assert.deepEqual([p.vms[0].sizeGB, p.vms[0].provisionedGB], [10, 15]);
});

test('미리보기 합계 — 보낼 VM 만 · 모르는 VM 은 더하지 않고 센다', async () => {
  const { sizeTotal } = await import('../src/routes/api/backupRun.js');
  const t = sizeTotal([{ how: 'quick', sizeGB: 10, provisionedGB: 20 }, { how: 'portal', sizeGB: 5.5, provisionedGB: null }, { how: 'portal', sizeGB: null }, { how: 'skip', sizeGB: 999 }]);
  assert.deepEqual(t, { totalSizeGB: 15.5, totalProvisionedGB: 20, sizeUnknown: 1, sendCount: 3 });
  assert.deepEqual(sizeTotal([{ how: 'quick', sizeGB: null }]), { totalSizeGB: null, totalProvisionedGB: null, sizeUnknown: 1, sendCount: 1 });
});

test('portal-vms 응답에 크기와 마지막 실행의 진행(live)이 실린다 — 범위 밖 VM 은 여전히 빠진다', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupManage } = await import('../src/routes/api/backupManage.js');
  portalVms._resetForTest(); runs._resetForTest();
  const SNAP = { vcenters: [{ id: 'kr1', name: 'kr1' }, { id: 'us1', name: 'us1' }], hosts: [],
    vms: [{ id: 'kr1:vm-1', vcenterId: 'kr1', name: 'a', storageGB: 100, uncommittedGB: 50 }, { id: 'us1:vm-3', vcenterId: 'us1', name: 'c', storageGB: 1 }] };
  const origGet = store.get; store.get = () => SNAP;
  // 진행 중 실행 기록(파일 — 이전 프로세스의 것이면 load 가 복구하므로 세션을 받은 상태로)
  fs.writeFileSync(path.join(CFG, 'veeam-backup-runs.json'), JSON.stringify({ version: 1, runs: [{ id: 'vbr_x', at: 1000, status: 'running', groups: [{ serverId: 's', kind: 'portal', vcenterId: 'kr1', state: 'running', variant: 'update:flat+start:body', sessions: [{ id: 'sess', objectIds: ['vm-1'] }] }],
    vms: [{ vmId: 'kr1:vm-1', name: 'a', vcenterId: 'kr1', serverId: 's', how: 'portal', state: 'running', progress: 37, sessionId: 'sess', detail: "포탈 전용 잡 'PORTAL-x'",
      metrics: { scope: 'vm', state: 'Working', startedAt: 900, processedBytes: 120e9, readBytes: null, transferredBytes: 50e9 } }] }] }));
  portalVms.notePortalRun({ id: 'vbr_x', at: 1000, groups: [{ serverId: 's', kind: 'portal', vcenterId: 'kr1', jobName: 'PORTAL-x' }],
    vms: [{ vmId: 'kr1:vm-1', name: 'a', vcenterId: 'kr1', serverId: 's', how: 'portal', state: 'running' }, { vmId: 'us1:vm-3', name: 'c', vcenterId: 'us1', serverId: 's', how: 'quick', state: 'success' }] });
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.user = { username: 'scoped', role: 'admin', scope: { vcenters: ['kr1'], regions: [] } }; next(); });
  const api = express.Router(); registerBackupManage(api); app.use('/api', api);
  const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
  try {
    const j = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/backup-run/portal-vms`)).json();
    assert.deepEqual(j.vms.map((v) => v.vmId), ['kr1:vm-1']);
    const v = j.vms[0];
    assert.deepEqual([v.sizeGB, v.provisionedGB], [100, 150]);
    assert.equal(v.live.progress, 37); assert.equal(v.live.metrics.processedBytes, 120e9); assert.equal(v.live.variant, 'update:flat+start:body');
  } finally { store.get = origGet; srv.close(); }
});
