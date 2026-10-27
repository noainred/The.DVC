/**
 * v2.767 점검 2회차 F2 그룹 — 폴더 사용량·로그 분석·게스트 디스크.
 *
 *  B2-01 du-top 이 exit 1(읽지 못한 하위 폴더)·공용 출력 상한(256KB)이면 스캔 전체를 버리던 것 — 루트 합계 행이 있으면 성공 + 경고 수,
 *        du-top 전용 출력 상한(실제 runCommand 로 확인), 실제 스케줄러(runNow → 잡 결과 → 수거 → DB)로 끝까지.
 *  B2-02 (보안) 엣지 guest-disk push 의 vmId 가 vcenterId 에 묶이지 않아 남의 vCenter VM 행을 덮고 범위 계정이 그 이력을 읽던 것 —
 *        실제 centralRouter + 실제 api 라우터로 끝까지(수신 드롭 + vmDetail 판정 이중화 + 목록 필터).
 *  B2-03 로그 분석 규칙 정규식(카탈로그 24개 + 같은 점검에서 찾은 3+2개)의 다항식 시간 — 예전 정규식과 캡처 동일(표본 + 결정적 난수) +
 *        전 규칙 × 적대 입력 비율 검사.
 *  B2-04 dirusage stripSlash 의 `/\/+$/` O(n²) — 선형 + 의미 동일.
 *  B2-05 폴더 사용량 화면이 Top-N 끼리 비교 — 라우트가 서버 compareScans 결과(compare)를 싣는다(화면 쪽은 web dirUsageRows.test.js).
 *  B2-06 대상 경로를 같은 id 로 바꾼 뒤 첫 비교가 옛 경로와 — 같은 루트·엣지일 때만 기준선(스케줄러·/scan/:id·미리보기).
 *
 * 실행: cd server && node --test --experimental-sqlite test/audit2767b.test.js
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2767b-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = 'T'.repeat(40);
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.GUESTDISK_DB_PATH = path.join(CFG, 'gd.db');
process.env.DIRUSAGE_DB_PATH = path.join(CFG, 'dirusage.db');
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-a', name: 'A', host: 'https://10.0.0.1', collectMode: 'site', location: { region: 'APAC' } },
  { id: 'vc-b', name: 'B', host: 'https://10.0.0.2', collectMode: 'site', location: { region: 'EMEA' } },
  // 콜론이 든 id — 'vc-c' 의 확장 'vc-c:x' 가 따로 있다(최장 프리픽스 판정이 필요한 꼴)
  { id: 'vc-c', name: 'C', host: 'https://10.0.0.3', collectMode: 'site', location: { region: 'APAC' } },
  { id: 'vc-c:x', name: 'CX', host: 'https://10.0.0.4', collectMode: 'site', location: { region: 'EMEA' } },
] }));
fs.writeFileSync(path.join(CFG, 'dirusage.json'), JSON.stringify({
  enabled: false,
  targets: [{ id: 't1', agent: 'corpA', path: '/mnt/a', topN: 5, intervalHours: 24, enabled: true }],
  mail: { enabled: false },
}));
after(() => { try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const express = (await import('express')).default;

async function listen(app) {
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

// ───────────────────────────── B2-02 ─────────────────────────────
test('B2-02 vmOwnerByPrefix·splitVmsByOwner — 최장 프리픽스(콜론 id), 네임스페이스 밖은 foreign', async () => {
  const { vmOwnerByPrefix, splitVmsByOwner } = await import('../src/guestdisk/analyze.js');
  assert.equal(vmOwnerByPrefix('vc-c:x:vm-1', ['vc-c', 'vc-c:x']), 'vc-c:x');
  assert.equal(vmOwnerByPrefix('vc-c:vm-1', ['vc-c', 'vc-c:x']), 'vc-c');
  assert.equal(vmOwnerByPrefix('vc-z:vm-1', ['vc-c']), null);
  const known = ['vc-a', 'vc-b', 'vc-c', 'vc-c:x'];
  const r = splitVmsByOwner([{ vmId: 'vc-a:vm-1' }, { vmId: 'vc-b:vm-1' }, { vmId: 'vm-9' }, { vmId: 'vc-a' }], 'vc-a', known);
  assert.deepEqual(r.kept.map((v) => v.vmId), ['vc-a:vm-1']);
  assert.equal(r.foreign, 3);
  const c = splitVmsByOwner([{ vmId: 'vc-c:vm-1' }, { vmId: 'vc-c:x:vm-2' }], 'vc-c', known);
  assert.deepEqual(c.kept.map((v) => v.vmId), ['vc-c:vm-1'], "'vc-c' 엣지가 'vc-c:x' 의 VM 을 쓸 수 없다");
});

test('B2-02 실제 central+api 라우터 — 남의 vCenter VM id push 는 드롭(dropped.notOwned), 범위 계정은 그 VM 을 읽지 못한다', async () => {
  const { centralRouter } = await import('../src/routes/central.js');
  const { api } = await import('../src/routes/api.js');
  const db = await import('../src/guestdisk/db.js');
  const { store } = await import('../src/store.js');
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  if (!(await db.getDb())) { console.warn('node:sqlite 없음 — skip'); return; }
  store.snapshot = { ...store.snapshot, vcenters: [{ id: 'vc-a', location: { region: 'APAC' } }, { id: 'vc-b', location: { region: 'EMEA' } }, { id: 'vc-c' }, { id: 'vc-c:x' }], vms: [] };
  const t0 = Date.now() - 5 * 86_400_000;
  await db.commitCollection('vc-b', 'B', [{ vmId: 'vc-b:vm-1', vmName: 'b-secret-db', allocGB: 500, usedGB: 300, partCount: 1, parts: [{ path: '/secret/payroll', capGB: 500, usedGB: 300 }] }], { ts: t0 });

  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  app.use((req, _r, n) => { req.user = { username: 'kr-admin', role: 'admin', scope: { vcenters: ['vc-a'] } }; n(); });
  app.use('/api', api);
  const s = await listen(app);
  try {
    const tokA = issueAgentToken('edgeA').token;
    const push = (vcenterId, vms) => fetch(`${s.base}/api/central/guest-disk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tokA }, body: JSON.stringify({ vcenterId, vcenterName: vcenterId, vms }) });
    const r = await push('vc-a', [
      { vmId: 'vc-b:vm-1', vmName: 'b-secret-db', allocGB: 1, usedGB: 1, parts: [{ path: '/x', capGB: 1, usedGB: 1 }] },
      { vmId: 'vc-a:vm-7', vmName: 'a7', allocGB: 10, usedGB: 2, parts: [{ path: '/', capGB: 10, usedGB: 2 }] },
    ]);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.vms, 1, '자기 vCenter VM 1대만 적재');
    assert.equal(body.dropped?.notOwned, 1, '남의 vCenter VM 은 드롭하고 dropped 로 밝힌다');
    // vc-b VM 의 행은 그대로 vc-b 소유(덮이지 않음)
    const rowsB = await db.listLatest(['vc-b']);
    assert.deepEqual(rowsB.map((x) => [x.vmId, x.vcenterId, x.allocGB]), [['vc-b:vm-1', 'vc-b', 500]]);
    const g = await fetch(`${s.base}/api/tools/guest-disk/vm/${encodeURIComponent('vc-b:vm-1')}`);
    assert.equal(g.status, 404, 'vc-a 범위 계정은 vc-b VM 이력을 읽지 못한다');
    const ok = await fetch(`${s.base}/api/tools/guest-disk/vm/${encodeURIComponent('vc-a:vm-7')}`);
    assert.equal(ok.status, 200, '자기 범위 VM 은 그대로 보인다');

    // 수신 차단 이전에 덮인 행(레거시)이 DB 에 남아 있어도 — vmDetail 판정 이중화(id 접두) + 목록 필터.
    await db.commitCollection('vc-a', 'A', [{ vmId: 'vc-b:vm-1', vmName: 'b-secret-db', allocGB: 9999, usedGB: 1, partCount: 1, parts: [{ path: '/x', capGB: 9999, usedGB: 1 }] },
      { vmId: 'vc-a:vm-7', vmName: 'a7', allocGB: 10, usedGB: 2, partCount: 1, parts: [{ path: '/', capGB: 10, usedGB: 2 }] }], { ts: Date.now() });
    const legacy = await fetch(`${s.base}/api/tools/guest-disk/vm/${encodeURIComponent('vc-b:vm-1')}`);
    assert.equal(legacy.status, 404, 'DB vcenterId 가 vc-a 여도 id 접두가 vc-b 면 404');
    const list = await (await fetch(`${s.base}/api/tools/guest-disk?minReclaimGB=0`)).json();
    assert.ok(!(list.rows || []).some((x) => x.vmId === 'vc-b:vm-1'), '범위 목록에도 싣지 않는다');
    assert.ok((list.rows || []).some((x) => x.vmId === 'vc-a:vm-7'));
    // 스냅샷 판정: 스냅샷이 그 VM 을 vc-b 로 알면 404(형제 /vms/:id/partitions 와 같은 기준)
    store.snapshot = { ...store.snapshot, vms: [{ id: 'vc-a:vm-7', vcenterId: 'vc-b' }] };
    const snapDeny = await fetch(`${s.base}/api/tools/guest-disk/vm/${encodeURIComponent('vc-a:vm-7')}`);
    assert.equal(snapDeny.status, 404);
    store.snapshot = { ...store.snapshot, vms: [] };

    // 콜론 id: 'vc-c' 를 쓰는 엣지가 'vc-c:x' 의 VM 을 보내면 드롭(단순 startsWith 만으로는 통과하는 꼴)
    const tokC = issueAgentToken('edgeC').token;
    const rc = await fetch(`${s.base}/api/central/guest-disk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': tokC }, body: JSON.stringify({ vcenterId: 'vc-c', vcenterName: 'C', vms: [{ vmId: 'vc-c:x:vm-1', allocGB: 1, usedGB: 1, parts: [{ path: '/', capGB: 1, usedGB: 1 }] }] }) });
    const bc = await rc.json();
    assert.equal(rc.status, 200);
    assert.equal(bc.vms, 0);
    assert.equal(bc.dropped?.notOwned, 1);
  } finally { await s.close(); }
});

test('B2-02 guestDiskVmInScope — 전체 범위는 통과, 범위 계정은 DB·접두·스냅샷 셋 다 맞아야', async () => {
  const { guestDiskVmInScope } = await import('../src/routes/api/toolsGuestDisk.js');
  const snap = { vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }, { id: 'vc-c' }, { id: 'vc-c:x' }], vms: [] };
  const A = new Set(['vc-a']);
  assert.equal(guestDiskVmInScope('vc-b:vm-1', 'vc-b', snap, null), true);
  assert.equal(guestDiskVmInScope('vc-a:vm-1', 'vc-a', snap, A), true);
  assert.equal(guestDiskVmInScope('vc-b:vm-1', 'vc-a', snap, A), false);
  assert.equal(guestDiskVmInScope('vc-c:x:vm-1', 'vc-c', snap, new Set(['vc-c'])), false, '최장 프리픽스 소유는 vc-c:x');
  assert.equal(guestDiskVmInScope('vc-a:vm-1', 'vc-a', { ...snap, vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-b' }] }, A), false);
});

// ───────────────────────────── B2-01 ─────────────────────────────
const DU_OK = '1000\t/mnt/a/hong\n3000\t/mnt/a/kim\n1000\t/mnt/a/lee\n5000\t/mnt/a\n';
test('B2-01 judgeDuResult — exit 1 은 루트 합계 행이 있을 때만 성공(+경고 수), 잘린 출력·시간 초과는 실패', async () => {
  const { judgeDuResult, countDuWarnings } = await import('../src/dirusage/scan.js');
  const err = 'du: cannot read directory \'/mnt/a/hong/private\': Permission denied\ndu: cannot read directory \'/mnt/a/kim/x\': Permission denied\n';
  assert.equal(countDuWarnings(err), 2);
  const e1 = judgeDuResult({ ok: false, exitCode: 1, reason: '종료 코드 1', stdout: DU_OK, stderr: err }, '/mnt/a');
  assert.equal(e1.ok, true);
  assert.equal(e1.warnings, 2);
  assert.equal(e1.parsed.totalBytes, 5000);
  assert.equal(e1.parsed.entries.length, 3);
  const noRoot = judgeDuResult({ ok: false, exitCode: 1, stdout: '1000\t/mnt/a/hong\n', stderr: err }, '/mnt/a');
  assert.equal(noRoot.ok, false, '루트 합계 행이 없으면 부분 목록 — 버린다');
  assert.equal(judgeDuResult({ ok: false, exitCode: 2, stdout: DU_OK }, '/mnt/a').ok, false, 'exit 2 는 실패');
  assert.equal(judgeDuResult({ ok: false, exitCode: 1, signal: 'SIGTERM', stdout: DU_OK }, '/mnt/a').ok, false);
  assert.equal(judgeDuResult({ ok: false, exitCode: 1, timedOut: true, stdout: DU_OK }, '/mnt/a').ok, false);
  assert.equal(judgeDuResult({ ok: true, exitCode: 0, truncated: true, stdout: '1\t/mnt/a/x\n' }, '/mnt/a').ok, false, '잘린 출력(중앙 상한 포함)은 실패');
  assert.equal(judgeDuResult({ ok: true, exitCode: 0, clipped: true, stdout: '1\t/mnt/a/x\n' }, '/mnt/a').ok, false, '줄 상한으로 잘린 출력은 실패');
  const ok = judgeDuResult({ ok: true, exitCode: 0, stdout: DU_OK, stderr: '' }, '/mnt/a');
  assert.equal(ok.ok, true); assert.equal(ok.warnings, 0);
});

test('B2-01 du-top 전용 출력 상한 — buildCommand 가 프리셋에서 싣고 runCommand 가 공용 상한(256KB)보다 크게 쓴다', async () => {
  const { buildCommand, DU_TOP_MAX_OUTPUT } = await import('../src/rma/commands.js');
  const { runCommand, DEFAULT_MAX_OUTPUT } = await import('../src/rma/exec.js');
  const b = buildCommand('du-top', { path: '/mnt/a' });
  assert.equal(b.ok, true);
  assert.equal(b.maxOutput, DU_TOP_MAX_OUTPUT);
  assert.ok(DU_TOP_MAX_OUTPUT >= 20_001 * 200, 'MAX_ENTRIES(2만) × 경로 약 200바이트');
  assert.equal(b.maxLines, 20_001, '2만 + 루트 합계 1줄');
  assert.equal(buildCommand('df', {}).maxOutput, undefined, '다른 프리셋은 공용 상한');
  // 실제 spawn: 300KB 출력 — 공용 상한이면 truncated, 프리셋 상한이면 끝까지
  const argv = [process.execPath, '-e', "process.stdout.write('x'.repeat(300000))"];
  const small = await runCommand({ argv, timeoutMs: 20_000 }, { maxOutput: DEFAULT_MAX_OUTPUT });
  assert.equal(small.truncated, DEFAULT_MAX_OUTPUT < 300_000);
  const big = await runCommand({ argv, timeoutMs: 20_000, maxOutput: DU_TOP_MAX_OUTPUT }, { maxOutput: DEFAULT_MAX_OUTPUT });
  assert.equal(big.truncated, false);
  assert.equal(big.ok, true);
  assert.equal(big.stdout.length, 300_000);
  // 프리셋 상한이 공용보다 작으면 줄이지 않는다
  const notSmaller = await runCommand({ argv, timeoutMs: 20_000, maxOutput: 10 }, { maxOutput: 400_000 });
  assert.equal(notSmaller.truncated, false);
});

test('B2-01·B2-06 실제 스케줄러 — exit 1 결과를 받아 저장(warn_count), 경로를 같은 id 로 바꾼 뒤 첫 수집은 옛 경로와 비교하지 않는다', async () => {
  const J = await import('../src/rma/jobs.js');
  const S = await import('../src/dirusage/scheduler.js');
  const D = await import('../src/dirusage/db.js');
  const db = await D.getDb();
  if (!db) { console.warn('node:sqlite 없음 — skip'); return; }
  J.noteHeartbeat('corpA', 'i1', {});
  const err = "du: cannot read directory '/mnt/a/hong/private': Permission denied\n";
  const r1 = await S.runNow('t1');
  assert.equal(r1.ok, true);
  const req1 = r1.queued[0].reqId;
  assert.ok(req1, JSON.stringify(r1));
  J.setJobResult(req1, { ok: false, exitCode: 1, reason: '종료 코드 1', stdout: DU_OK, stderr: err });
  await new Promise((r) => setTimeout(r, 5));
  // 수거는 다음 runNow/틱에서 — 같은 가드
  const r2 = await S.runNow('t1');
  const last = db.last('t1');
  assert.ok(last, '예전에는 exit 1 이라 저장되지 않았다');
  assert.equal(last.total_bytes, 5000);
  assert.equal(last.warn_count, 1);
  assert.equal(last.root, '/mnt/a');
  // 같은 id 로 경로 변경 → 다음 결과는 /mnt/b
  const SET = await import('../src/dirusage/settings.js');
  SET.save({ targets: [{ ...SET.load().targets[0], path: '/mnt/b' }] });   // 화면과 같이 제자리 수정(id 유지)
  assert.equal(SET.load().targets[0].id, 't1');
  const tick = () => new Promise((r) => setTimeout(r, 5));   // 회차 ts 가 같은 ms 로 겹치지 않게
  // r2 가 건 잡(경로 /mnt/a)은 /mnt/a 결과로 마무리하고, 경로 변경 뒤 새 잡에 /mnt/b 결과를 준다
  const req2 = r2.queued[0].reqId;
  J.setJobResult(req2, { ok: true, exitCode: 0, stdout: DU_OK, stderr: '' });
  await tick();
  const r3 = await S.runNow('t1');
  const req3 = r3.queued[0].reqId;
  J.setJobResult(req3, { ok: true, exitCode: 0, stdout: '7000\t/mnt/b/proj1\n1000\t/mnt/b/hong\n8000\t/mnt/b\n', stderr: '' });
  await tick();
  await S.runNow('t1');
  const all = db.list('t1', 10);
  assert.equal(all[0].root, '/mnt/b');
  const { comparableBase } = await import('../src/dirusage/scan.js');
  const base = comparableBase(db.get(all[0].id), db.prev('t1', all[0].ts));
  assert.equal(base.prev, null, '다른 루트와 비교하지 않는다');
  assert.equal(base.baseChanged, true);
  assert.equal(comparableBase({ root: '/mnt/a', agent: 'x' }, { root: '/mnt/a', agent: 'x' }).prev?.root, '/mnt/a');
  assert.equal(comparableBase({ root: '/mnt/a', agent: 'x' }, { root: '/mnt/a', agent: 'y' }).prev, null, '엣지가 바뀌어도 비교하지 않는다');
});

// ───────────────────────── B2-05·B2-06 라우트 ─────────────────────────
test('B2-05·B2-06 /admin/dir-usage/scan/:id — 서버 compareScans 결과(compare)를 싣고, 루트가 다르면 prev 없이 baseChanged', async () => {
  const { registerDirUsage } = await import('../src/routes/admin/dirUsage.js');
  const D = await import('../src/dirusage/db.js');
  const { buildScanRecord, parseDuOutput } = await import('../src/dirusage/scan.js');
  const db = await D.getDb();
  if (!db) { console.warn('node:sqlite 없음 — skip'); return; }
  const base = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 10 * 3_600_000;
  const rec = (root, ts, lines) => buildScanRecord({ targetId: 'tr', root, agent: 'corpA', ts, topN: 2, parsed: parseDuOutput(lines, root) });
  // 재현 입력: topN=2, a300·b200·c100 → a300·b50·c250
  db.insertScan(rec('/mnt/s', base, '300\t/mnt/s/a\n200\t/mnt/s/b\n100\t/mnt/s/c\n600\t/mnt/s\n'));
  const id2 = db.insertScan(rec('/mnt/s', base + 3_600_000, '300\t/mnt/s/a\n50\t/mnt/s/b\n250\t/mnt/s/c\n600\t/mnt/s\n'));
  const id3 = db.insertScan(rec('/mnt/t', base + 7_200_000, '900\t/mnt/t/z\n900\t/mnt/t\n'));
  const router = express.Router();
  registerDirUsage(router);
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => { req.user = { username: 'root-admin', role: 'admin' }; n(); });
  app.use('/api/admin', router);
  const s = await listen(app);
  try {
    const j2 = await (await fetch(`${s.base}/api/admin/dir-usage/scan/${id2}`)).json();
    assert.equal(j2.ok, true);
    assert.equal(j2.compare.delta.c.entered, true, "c 는 '신규' 가 아니라 순위 진입");
    assert.equal(j2.compare.delta.c.isNew, false);
    assert.deepEqual(j2.compare.rankedOut.map((r) => [r.name, r.confirmed]), [['b', true]], 'b 는 순위 밖(지금도 있음)');
    assert.equal(j2.compare.removed.length, 0);
    assert.equal(j2.baseChanged, undefined);
    assert.equal(j2.scan.name_set, undefined, '지문 집합은 응답에 싣지 않는다');
    const j3 = await (await fetch(`${s.base}/api/admin/dir-usage/scan/${id3}`)).json();
    assert.equal(j3.prev, null, '루트가 다른 직전 기록은 기준선이 아니다');
    assert.equal(j3.baseChanged, true);
    assert.equal(j3.compare.hasPrev, false);
    assert.ok(Object.values(j3.compare.delta).every((d) => d.deltaBytes == null && !d.isNew));
    const pv = await (await fetch(`${s.base}/api/admin/dir-usage/preview/${id3}`)).json();
    assert.match(pv.text, /바뀐 뒤 첫 수집/);
    assert.doesNotMatch(pv.text, /사라진 폴더/);
  } finally { await s.close(); }
});

// ───────────────────────────── B2-04 ─────────────────────────────
test('B2-04 parseDuOutput — 끝 슬래시 제거가 선형이고 의미가 같다', async () => {
  const { parseDuOutput } = await import('../src/dirusage/scan.js');
  assert.deepEqual(parseDuOutput('5\t/mnt/a/x///\n9\t/mnt/a//\n', '/mnt/a/').entries, [{ name: 'x', bytes: 5 }]);
  assert.equal(parseDuOutput('5\t/mnt/a/x///\n9\t/mnt/a//\n', '/mnt/a/').totalBytes, 9);
  assert.equal(parseDuOutput('5\t///\n', '/mnt/a').skipped, 1, "'///' 은 예전처럼 빈 경로 → skipped");
  const OLD = (p) => (p.length > 1 && p.endsWith('/') ? p.replace(/\/+$/, '') : p);
  const line = (n) => `1\t${'/'.repeat(n)}x/\n`;
  const time = (n) => { const s = line(n); const t = process.hrtime.bigint(); parseDuOutput(s, '/mnt/a'); return Number(process.hrtime.bigint() - t) / 1e6; };
  time(1000);
  const t20 = time(20_000); const t80 = time(80_000);
  // 비율로 본다(선형 약 4배 · 제곱 약 16배). 잡음 바닥은 예전 재현값(80k 5.7초)과 확실히 갈리는 1초.
  assert.ok(t80 < t20 * 8 || t80 < 1000, `선형이어야 한다(20k ${t20.toFixed(1)}ms · 80k ${t80.toFixed(1)}ms)`);
  // 옛 함수와 같은 입력(8k)에서 비교 — 비율로
  const s8 = line(8000); const p8 = '/'.repeat(8000) + 'x/';
  const tm = (fn) => { let b = Infinity; for (let k = 0; k < 3; k++) { const t0 = process.hrtime.bigint(); fn(); b = Math.min(b, Number(process.hrtime.bigint() - t0) / 1e6); } return b; };
  const tOld = tm(() => OLD(p8)); const tNew = tm(() => parseDuOutput(s8, '/mnt/a'));
  assert.ok(tOld > tNew * 5 || tOld < 5, `새 구현이 훨씬 빨라야 한다(old ${tOld.toFixed(1)}ms · new ${tNew.toFixed(2)}ms)`);
});

// ───────────────────────────── B2-03 ─────────────────────────────
// 바꾸기 전 정규식(감사 기준 v2.766.0 catalog.js·rules.js 원문 그대로) — 바꾼 29개 규칙.
const OLD_RE = {
  "gpu-guest-guest-login": "✗ (.+?): .*(?:게스트 로그인 실패|InvalidGuestLogin|Failed to authenticate with the guest)",
  "gpu-guest-tools-unavailable": "✗ (.+?): .*(?:VMware Tools 미실행/구버전|[Gg]uest operations agent)",
  "gpu-guest-vm-powered-off": "✗ (.+?): .*VM 전원 꺼짐",
  "gpu-guest-guestop-timeout": "✗ (.+?): .*게스트 작업 타임아웃",
  "gpu-guest-nvsmi-stderr": "✗ (.+?): .*게스트 오류: ",
  "gpu-guest-retrieve-404": "✗ (.+?): .*회수 실패\\(\\.out/\\.err 모두 HTTP404",
  "gpu-guest-download-unreachable": "✗ (.+?): .*파일 다운로드 실패\\(size=",
  "gpu-guest-nvsmi-driver": "✗ (.+?): .*nvidia-smi 가 GPU 값 대신 다음을 출력함",
  "gpu-guest-nvsmi-empty": "✗ (.+?): .*nvidia-smi (?:출력이 비어 있음|출력 없음|결과 없음)",
  "gpu-guest-nvsmi-parse": "✗ (.+?): .*nvidia-smi 출력 파싱 실패: ",
  "gpu-guest-no-guest-ip": "✗ (.+?): .*게스트 IP 없음\\(VMware Tools가 IP 미보고\\)",
  "gpu-guest-ssh-unreachable": "✗ (.+?): .*SSH 경로 없음\\(망 분리\\)",
  "gpu-guest-ssh-deadline": "✗ (.+?): .*SSH 수집 시간 초과\\((\\d+)초\\)",
  "gpu-guest-guestops-manager": "✗ (.+?): .*GuestOperationsManager 사용 불가",
  "collect-vc-auth": "(\\S+) \\((.*?)\\) 연결 실패: .* — 인증 실패 — 계정/비밀번호",
  "collect-vc-dns": "(\\S+) \\((.*?)\\) 연결 실패: .* — DNS 조회 실패",
  "collect-vc-refused": "(\\S+) \\((.*?)\\) 연결 실패: .* — 연결 거부 — ",
  "collect-vc-timeout": "(\\S+) \\((.*?)\\) 연결 실패: .* — 연결 시간 초과",
  "collect-vc-cert": "(\\S+) \\((.*?)\\) 연결 실패: .* — 인증서 오류",
  "collect-vc-network": "(\\S+) \\((.*?)\\) 연결 실패: .* — (?:연결이 재설정됨|호스트/네트워크에 도달할 수 없음)",
  "collect-vc-deadline": "(\\S+) \\((.*?)\\) 연결 실패: vCenter 수집 데드라인 초과\\((\\d+)초\\)",
  "collect-vc-fail": "(\\S+) \\((.*?)\\) 연결 실패: ",
  "vmseries-vc-auth": "(\\S+) \\((.*?)\\) 수집 실패: .* — 인증 실패 — ",
  "vmseries-vc-fail": "(\\S+) \\((.*?)\\) 수집 실패: ",
  "bmusage-os-auth-stop": "([^\\]\\s][^\\]]*?): 인증 실패로 주기 수집 정지\\((\\d+)회\\)",
  "bmusage-idrac-auth-stop": "([^\\]\\s][^\\]]*?): iDRAC 인증 실패로 대체 수집 정지\\((\\d+)회\\)",
  "gpu-guest-ssh-auth": "^\\[gpu-guest\\]\\s+✗ (.+?): .*SSH 인증 실패",
  "gpu-guest-ssh-refused": "^\\[gpu-guest\\]\\s+✗ (.+?): .*SSH 연결 거부",
  "gpu-guest-ssh-timeout": "^\\[gpu-guest\\]\\s+✗ (.+?): .*SSH 타임아웃",
};

test('B2-03 바꾼 규칙 — 예전 정규식과 캡처가 같다(표본 + 결정적 난수 대조)', async () => {
  const { CATALOG_RULES } = await import('../src/loganalysis/catalog.js');
  const { CORE_RULES } = await import('../src/loganalysis/rules.js');
  const all = [...CATALOG_RULES, ...(CORE_RULES || [])];
  assert.equal(Object.keys(OLD_RE).length, 29);
  const sig = (re, s) => { const m = re.exec(s); return m ? JSON.stringify(m.slice(1)) : null; };
  let seed = 23;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const parts = ['✗', '✗ ', ' ', 'a', 'vm-1', ': ', ':', '\n', '\r', ' ', ' (', '(', ')', ') 연결 실패: ', ') 수집 실패: ', ' — ', ' — 인증 실패 — ',
    ' — 인증 실패 — 계정/비밀번호', ' — DNS 조회 실패', ' — 연결이 재설정됨', 'vCenter 수집 데드라인 초과(', '12', '초)', 'VM 전원 꺼짐', '게스트 오류: ', 'SSH 수집 시간 초과(',
    'SSH 인증 실패', 'SSH 연결 거부', 'SSH 타임아웃', '[gpu-guest] ', '[gpu-guest]   ', '[collect] ', '\t', 'x y', ']', '] ', ': 인증 실패로 주기 수집 정지(', ': iDRAC 인증 실패로 대체 수집 정지(', '3회)', 'host-1'];
  let compared = 0;
  for (const r of all) {
    const o = OLD_RE[r.id];
    if (!o) continue;
    const OR = new RegExp(o); const NR = r.re instanceof RegExp ? r.re : new RegExp(r.re);
    assert.notEqual(OR.source, NR.source, `${r.id} 는 새 꼴이어야 한다`);
    compared++;
    if (r.sample) assert.equal(sig(NR, r.sample), sig(OR, r.sample), `${r.id} 표본`);
    for (let i = 0; i < 4000; i++) {
      let s = ''; const n = 1 + Math.floor(rnd() * 14);
      for (let j = 0; j < n; j++) s += parts[Math.floor(rnd() * parts.length)];
      assert.equal(sig(NR, s), sig(OR, s), `${r.id} ${JSON.stringify(s)}`);
    }
  }
  assert.equal(compared, 29, '카탈로그 24 + bmusage 2 + 코어 3 = 29 규칙을 대조');
});

test('B2-03 전 규칙 × 적대 입력 — 길이에 선형(2,000자 대 8,000자 비율) + 예전 규칙은 재현', async () => {
  const { activeRules } = await import('../src/loganalysis/index.js');
  const fill = (u, L) => u.repeat(Math.ceil(L / u.length)).slice(0, L);
  const units = ['✗ a: ', 'k: v ', '✗ 10.0.0.1: timeout / ', 'a (b) 연결 실패: ', 'a (', ') 연결 실패: ', ') 연결 실패: vCenter 수집 데드라인 초과(1',
    'x ', ':', '/', '실패 ', 'a (b) 수집 실패: ', 'ab', '  ', 'a ', '(', ')', '] ', 'a: ', '\n', 'a\n'];
  const pres = ['', '[gpu-guest]   ', '[collect] '];
  const best = (re, s) => { let b = Infinity; for (let k = 0; k < 3; k++) { const t = process.hrtime.bigint(); re.exec(s); b = Math.min(b, Number(process.hrtime.bigint() - t) / 1e6); } return b; };
  const bad = [];
  for (const r of activeRules()) {
    for (const u of units) for (const p of pres) {
      const t2 = best(r.re, p + fill(u, 2000));
      const t8 = best(r.re, p + fill(u, 8000));
      // 선형이면 약 4배, 제곱이면 약 16배. 아주 짧은 시간은 잡음이라 1ms 미만은 보지 않는다.
      if (t8 > 1 && t8 > t2 * 9) bad.push(`${r.id} ${JSON.stringify(p + u)} 2k=${t2.toFixed(2)}ms 8k=${t8.toFixed(2)}ms`);
    }
  }
  assert.deepEqual(bad, [], '길이에 제곱인 규칙이 없어야 한다');
  // 재현 고정: 예전 ✗ 정규식은 같은 입력에서 훨씬 느렸다(비율로 — 절대 시간은 CPU 에 따라 다르다)
  const OLD = new RegExp(OLD_RE['gpu-guest-ssh-deadline']);
  const NEW = activeRules().find((r) => r.id === 'gpu-guest-ssh-deadline').re;
  const s = fill('✗ a: ', 2000);
  best(OLD, s); best(NEW, s);
  const tOld = best(OLD, s); const tNew = best(NEW, s);
  assert.ok(tOld > tNew * 5 || tOld < 5, `새 정규식이 훨씬 빨라야 한다(old ${tOld.toFixed(1)}ms · new ${tNew.toFixed(2)}ms)`);
});

test('B2-03 엔진 경로 — 2,000자 적대 줄 addItem 이 정지하지 않고 규칙 판정은 그대로', async () => {
  const { activeRules } = await import('../src/loganalysis/index.js');
  const { newState, addItem, indexRules } = await import('../src/loganalysis/engine.js');
  const idx = indexRules(activeRules());
  const fill = (u, L) => u.repeat(Math.ceil(L / u.length)).slice(0, L);
  const lineOf = (L) => ('[gpu-guest]   ' + fill('✗ a: ', L)).slice(0, L);
  const msg = lineOf(2000);
  const st = newState();
  addItem(st, { msg, level: 'unknown', ts: Date.now() }, idx);
  // 시간은 비율로(루트 CLAUDE.md 'ReDoS 회귀는 비율로') — 500자 대 2,000자. 선형이면 약 4배, 예전(제곱)은 약 16배(2,000자 1.7초).
  const tAdd = (L) => { let b = Infinity; for (let k = 0; k < 3; k++) { const s0 = newState(); const t0 = process.hrtime.bigint(); addItem(s0, { msg: lineOf(L), level: 'unknown', ts: Date.now() }, idx); b = Math.min(b, Number(process.hrtime.bigint() - t0) / 1e6); } return b; };
  tAdd(500);
  const t500 = tAdd(500); const t2k = tAdd(2000);
  assert.ok(t2k < t500 * 10 || t2k < 1000, `길이에 선형이어야 한다(500자 ${t500.toFixed(2)}ms · 2,000자 ${t2k.toFixed(2)}ms — 예전 2,000자 1.7초)`);
  assert.deepEqual(Object.keys(st.rules), ['gpu-guest-fail-other'], '분류 결과는 예전과 같다(일반 ✗ 규칙)');
  const st2 = newState();
  addItem(st2, { msg: '[gpu-guest]   ✗ gpu-vm-04: 게스트작업: StartProgramInGuest SOAP 실패: 게스트 작업 타임아웃 | raw: x', level: 'unknown', ts: Date.now() }, idx);
  assert.deepEqual(Object.keys(st2.rules), ['gpu-guest-guestop-timeout']);
  assert.deepEqual(st2.rules['gpu-guest-guestop-timeout'].ent, { 'gpu-vm-04': 1 });
});

test('B2-01 후속 — 중앙 RMA 결과 보관 상한: du-top 은 엣지 상한(4MB)까지 보관하고 다른 명령은 공용 상한 그대로', async () => {
  const J = await import('../src/rma/jobs.js');
  const { DU_TOP_MAX_OUTPUT } = await import('../src/rma/commands.js');
  J._resetRma();
  J.noteHeartbeat('corpDu', 'i1', {});
  const big = 'x'.repeat(1024 * 1024) + '\n123\t/data\n';   // 1MB + 루트 합계 행(공용 상한 512K 자를 넘는다)
  const du = J.enqueueJob('corpDu', { cmd: 'du-top', args: { path: '/data' } }, { timeoutMs: 60_000 });
  const other = J.enqueueJob('corpDu', { cmd: 'ping', args: { host: '10.0.0.1' } }, { timeoutMs: 60_000 });
  J.takeJobs('corpDu', 'i1'); J.setJobResult(du.reqId, { ok: true, exitCode: 0, stdout: big });
  J.takeJobs('corpDu', 'i1'); J.setJobResult(other.reqId, { ok: true, exitCode: 0, stdout: big });
  const a = J.getJob(du.reqId).result; const b = J.getJob(other.reqId).result;
  assert.equal(a.truncated, false); assert.ok(a.stdout.endsWith('/data\n'), 'du-top 은 루트 합계 행까지 보관');
  assert.equal(b.truncated, true); assert.ok(b.stdout.length < big.length, '다른 명령은 공용 상한에서 자른다');
  assert.ok(DU_TOP_MAX_OUTPUT >= 4 * 1024 * 1024);
  J._resetRma();
});
