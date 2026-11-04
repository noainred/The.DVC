/**
 * test/bareosFinishDigest2872.test.js — v2.872 Bareos 복원 · 검증 점검(5축 + 반증 1인) 확정분 중 끝맺음(vmclone) · 일일 요약 메일.
 *  ① B3-04(재현): 장치 목록을 못 읽거나(빈 XML) 모르는 NIC 종류가 있으면 '끊었음' 으로 보지 않고 켜지 않는다(fail-closed) — 재구성도 하지 않는다
 *  ② B2-02(재현): vCenter 줄에 선(대기 · 실행) Bareos 마무리는 자동 업그레이드가 기다리는 목록에 있다 · 끝나면 빠진다
 *  ③ B3-05 · B3-07: 끄기 전 전원 상태 실측 · 로그인 실패는 사유를 남긴다(던지지 않는다)
 *  ④ B4-04(재현): 요약 창은 끝난 시각으로 — 요약 시각에 진행 중이던 검증이 다음 메일에 실린다 · 진행 중은 따로 센다
 *  ⑤ B4-06 · B4-10 · B4-11: 모름 법인 실패 행 표지 · 기동 뒤 첫 폴러 조회 전에는 미룬다(상한) · 엣지 판정은 service.js 하나
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2872fd-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const vs = await import('../src/vmclone/vsphere.js');
const ex = await import('../src/vmclone/execOp.js');
const DG = await import('../src/bareos/digest.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const NIC = (type, connected) => `<VirtualDevice xsi:type="${type}"><key>4000</key><deviceInfo><label>Network adapter 1</label></deviceInfo><macAddress>00:50:56:aa:bb:cc</macAddress><connectable><startConnected>${connected}</startConnected><allowGuestControl>true</allowGuestControl><connected>${connected}</connected></connectable><controllerKey>100</controllerKey></VirtualDevice>`;
const DISK = '<VirtualDevice xsi:type="VirtualDisk"><key>2000</key><controllerKey>1000</controllerKey></VirtualDevice>';

test('① B3-04 장치 목록을 믿을 수 없으면 끊었음으로 보지 않는다 · 켜지 않는다', async () => {
  assert.match(vs.deviceListIssue(''), /읽지 못했습니다/);
  assert.equal(vs.allNicsDisconnected(''), true, '(옛 판정) 빈 목록은 NIC 0개로 통과했다 — 그래서 앞에서 막는다');
  assert.equal(vs.deviceListIssue(DISK + NIC('VirtualVmxnet3', 'true')), '');
  assert.equal(vs.deviceListIssue(DISK), '', 'NIC 없는 VM 은 정상');
  assert.match(vs.deviceListIssue(DISK + NIC('VirtualFutureNic', 'true')), /모르는 네트워크 카드 종류\(VirtualFutureNic\)/);
  const calls = [];
  const fake = (xml) => ({ retrieveObjectProps: async () => [{ props: { name: 'v', 'runtime.powerState': 'poweredOff', 'config.hardware.device': xml } }], callRaw: async (b) => { calls.push(b); return ''; } });
  await assert.rejects(vs.disconnectAllNics(fake(''), 'vm-1'), /장치 목록을 읽지 못했습니다 — 안전을 위해 이 VM 을 켜지 않습니다/);
  await assert.rejects(vs.disconnectAllNics(fake(DISK + NIC('VirtualFutureNic', 'true')), 'vm-1'), /모르는 네트워크 카드 종류\(VirtualFutureNic\)라 끊었는지 확인할 수 없습니다 — 안전을 위해/);
  assert.equal(calls.length, 0, '재구성(ReconfigVM)을 보내지 않았다');
  assert.equal(await vs.disconnectAllNics(fake(DISK + NIC('VirtualVmxnet3', 'false')), 'vm-1'), 1, '이미 끊긴 VM 은 확인만');
  // 확인을 위해 다시 읽은 장치 목록이 비면(읽기 실패) '끊었음' 으로 보지 않는다(이미 끊겨 재구성 없이 확인만 하는 길)
  let n = 0;
  const flaky = { retrieveObjectProps: async () => [{ props: { name: 'v', 'runtime.powerState': 'poweredOff', 'config.hardware.device': n++ === 0 ? DISK + NIC('VirtualVmxnet3', 'false') : '' } }], callRaw: async () => '' };
  await assert.rejects(vs.disconnectAllNics(flaky, 'vm-1'), /네트워크 카드 연결을 끊었는지 확인하지 못했습니다/);
});

test('② B2-02 vCenter 줄의 Bareos 마무리는 업그레이드가 기다린다', async () => {
  assert.deepEqual(ex.runningBareosFinishes(), []);
  const p1 = ex.executeOp({ id: 'vco-n1', kind: 'bareos-nic', vcenterId: 'vc-a', spec: { name: 'web-01-r' }, by: 't' });
  const p2 = ex.executeOp({ id: 'vco-n2', kind: 'bareos-nic', vcenterId: 'vc-a', spec: { name: 'web-02-r' }, by: 't' });   // 같은 vCenter — 줄에서 기다린다
  const keys = ex.runningBareosFinishes().map((x) => x.key);
  assert.deepEqual(keys, ['bareos-finish:vco-n1', 'bareos-finish:vco-n2'], '도는 것 · 기다리는 것 모두');
  assert.ok(ex.runningBareosFinishes().every((x) => x.kind === 'bareos' && x.resumable === false && /web-0\d-r/.test(x.label)));
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual([r1.ok, r2.ok], [true, true]);
  assert.deepEqual(ex.runningBareosFinishes(), [], '끝나면 빠진다');
  assert.match(src('../src/upgrade/manager.js'), /function bareosWork\(\) \{[\s\S]{0,200}runningBareosFinishes\(\)[\s\S]{0,200}return \[\.\.\.a, \.\.\.b\];/, '대기 목록(bareosWork)에 들어간다');
});

test('③ B3-05 · B3-07 끄기 전 전원 실측 · 로그인 실패는 사유를 남긴다', () => {
  const s = src('../src/vmclone/vsOps.js');
  assert.doesNotMatch(s, /\n\s*await onDemandLogin\(c, vc\);\n\s*try \{\n\s*ph\.step\('VM 찾기'\);\n\s*const refs = await findVmsByName\(c, vmName\);\n\s*if \(!refs\.length\) return fin\(false, `vCenter 에서 '\$\{vmName\}' VM 을/, '끊기: 로그인이 try 밖에서 던지지 않는다');
  assert.match(s, /try \{ await onDemandLogin\(c, vc\); \} catch \(e\) \{ return fin\(false, `vCenter 로그인 실패[^`]*네트워크를 끊지 못했습니다/);
  assert.match(s, /try \{ await onDemandLogin\(c, vc\); \} catch \(e\) \{ return fin\(false, `vCenter 로그인 실패[^`]*검증하지 않았습니다/);
  assert.match(s, /const cur = await vmStateOf\(c, ref\);\n\s*if \(cur\.powerState !== 'poweredOff'\) await powerOffVm\(c, ref\);/);
});

const SET = { directors: [{ id: 'D1', name: '한국' }, { id: 'D2', name: '폴란드' }] };
test('④ B4-04 요약 창은 끝난 시각으로 · 진행 중 검증은 따로', () => {
  const now = Date.UTC(2026, 10, 8, 0, 0);
  const H = 3600_000;
  const job = (id, dir, restores) => ({ id, directorId: dir, vcenterId: 'vc-a', vmName: id, enabled: true, lastRun: { state: 'ok', endedAt: now - H }, restores });
  const d = DG.digestData([
    job('a', 'D1', [
      { verify: true, jobid: 1, at: now - 30 * H, state: 'ok', finish: { verify: 'ok', at: now - 2 * H } },   // 어제 요약 때 진행 중 → 오늘 실린다
      { verify: true, jobid: 2, at: now - 50 * H, state: 'ok', finish: { verify: 'failed', nic: 'failed', at: now - 40 * H } },   // 창 밖
      { verify: true, jobid: 3, at: now - 3 * H, state: 'running' },   // 진행 중
      { jobid: 4, at: now - 30 * H, endedAt: now - 20 * H, state: 'error' },   // 일반 복원 — 끝난 시각이 창 안
    ]),
  ], SET, { D1: { ok: true } }, now);
  const c = d.rows.find((x) => x.id === 'D1');
  assert.deepEqual([c.verifyOk, c.verifyFail, c.verifyPending, c.restores, c.restoreFail], [1, 0, 1, 1, 1]);
  assert.match(DG.renderDigest(d, now).html, /성공 1 · 실패 0 · 진행 중 1/);
});

test('⑤ B4-06 모름 법인 실패 표지 · B4-10 첫 폴러 조회 전 미룸(상한) · B4-11 엣지 판정 하나', () => {
  const now = Date.now();
  const d = DG.digestData([
    { id: 'p', directorId: 'D2', vcenterId: 'vc-p', vmName: 'pl-01', enabled: true, lastRun: { state: 'error', endedAt: now - 1000, jobid: 9 }, restores: [] },
    { id: 'k', directorId: 'D1', vcenterId: 'vc-k', vmName: 'kr-01', enabled: true, lastRun: { state: 'error', endedAt: now - 1000, jobid: 8 }, restores: [] },
  ], SET, { D1: { ok: true }, D2: { ok: false, code: 'timeout' } }, now);
  assert.equal(d.total.fail, 1, '제목 합은 아는 법인만');
  const html = DG.renderDigest(d, now).html;
  assert.match(html, /폴란드 \(결과 모름 법인 — 마지막으로 읽은 값 · 제목 합에 없음\)/);
  assert.doesNotMatch(html, /한국 \(결과 모름 법인/);
  DG.setDigestPoller(() => ({ at: null, directors: {} }));
  assert.equal(DG.firstPollPending(now), true, '기동 뒤 폴러가 아직 돌지 않았다');
  assert.equal(DG.firstPollPending(now + DG.FIRST_POLL_WAIT_MS + 60_000), false, '상한을 넘으면 보낸다');
  DG.setDigestPoller(() => ({ at: now - 5000, directors: {} }));
  assert.equal(DG.firstPollPending(now), false);
  DG.setDigestPoller(null);
  for (const f of ['../src/bareos/rehearsal.js', '../src/bareos/digest.js']) {
    assert.doesNotMatch(src(f), /centralUrl && config\.agent\?\.centralToken/, `${f}: 엣지 판정을 따로 두지 않는다`);
    assert.match(src(f), /isEdgeNode\(\)/);
  }
});

test('⑥ B2-03 끝난 복원을 늦게 온 옛 행이 되돌리지 않는다 · B2-06 같은 jobid 를 기다리는 항목이 둘이어도 둘 다 갱신', async () => {
  const registry = await import('../src/bareos/registry.js');
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs: [
    { id: 'r1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', directorId: 'D1', bareosJob: 'pv-r1', enabled: true, restores: [{ jobid: 7, status: 'T', state: 'ok', at: Date.now() }] },
  ], retired: [] }));
  registry._resetForTest();
  assert.equal(registry.applyRestoreRow('r1', { jobid: 7, status: 'R', type: 'R' }), null, '끝난 뒤의 끝나지 않은 행은 받지 않는다');
  const r = registry.getJob('r1').restores[0];
  assert.deepEqual([r.status, r.state, registry.restoreOpen(r)], ['T', 'ok', false]);
  assert.ok(registry.applyRestoreRow('r1', { jobid: 7, status: 'W', type: 'R' }), '끝난 상태끼리는 반영(경고로 정정)');
  const ps = src('../src/bareos/poller.js');
  assert.doesNotMatch(ps, /new Map\(slice\.map\(\(w\) => \[w\.jobid, w\]\)\)/, 'jobid 하나에 항목 하나로 접지 않는다');
  assert.match(ps, /for \(const w of byJobid\.get\(jobid\) \|\| \[\]\)/);
});

test('⑦ B2-04 마무리(NIC 끊기 · 검증) 중인 복원은 재설치 다시 묶기에 남고 삭제를 막는다(시한 24시간)', async () => {
  const registry = await import('../src/bareos/registry.js');
  const now = Date.now();
  const fin = { jobid: 11, status: 'T', state: 'ok', nic: 'disconnect', at: now - 60_000, endedAt: now - 30_000 };
  assert.equal(registry.restoreFinishing(fin, now), true, '끝났고 마무리 없음');
  assert.equal(registry.restoreFinishing({ ...fin, finish: { nic: 'pending', at: now } }, now), true);
  assert.equal(registry.restoreFinishing({ ...fin, finish: { nic: 'ok', at: now } }, now), false);
  assert.equal(registry.restoreFinishing({ ...fin, nic: 'keep' }, now), false, '끊기를 고르지 않은 복원은 마무리가 없다');
  assert.equal(registry.restoreFinishing({ ...fin, endedAt: now - registry.RESTORE_FINISH_HOLD_MS - 1, at: now - registry.RESTORE_FINISH_HOLD_MS - 2 }, now), false, '시한이 지나면 놓는다');
  const s = src('../src/routes/api/bareosBackup.js');
  assert.match(s, /some\(\(r\) => restoreHeld\(r\) \|\| restoreFinishing\(r\)\)\) return res\.status\(409\)/, '삭제 409');
  const rs = src('../src/bareos/registry.js');
  assert.match(rs, /filter\(\(r\) => restoreOpen\(r\) \|\| restoreFinishing\(r\) \|\| restoreUnknownHeld\(r\)\)/, '다시 묶기에 남긴다');
});
