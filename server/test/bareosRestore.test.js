/**
 * test/bareosRestore.test.js — 복원 판정(src/bareos/restore.js) · 설정·원장 저장(settings.js·registry.js).
 *  복원(파괴적 경로 — 변이 검증 대상):
 *   - 덮어쓰기: 이름 재입력 · 인벤토리 존재 · 꺼짐 · 스냅샷 0 — 전원·스냅샷을 **못 읽으면 거부**(0 으로 보지 않는다)
 *   - 새 VM: 동명 거부(대소문자 무시) · 데이터스토어·클러스터·호스트는 같은 vCenter 인벤토리에 있어야 · 언제나 전원 off
 *   - 로컬 VMDK · 모르는 방식 거부 · 체인 계산(Full→Diff→Incr, 실패한 백업 제외) · 체인 검증
 *  저장:
 *   - 설정: 비밀번호 봉인 파일 0600 · 손상 → 보존 + 빈 설정 + 오류 표시 · 접속처 변경 시 비밀 폐기 · 사이트 검증
 *   - 원장: 손상이면 새 대상 추가 거부(보존본 덮지 않게) · 같은 실행을 덜 자세한 행으로 받아도 값 유지 · 바뀌지 않으면 파일을 쓰지 않음
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosrestore-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const { restorePlan, chainFromHistory, chainIssue } = await import('../src/bareos/restore.js');
const settings = await import('../src/bareos/settings.js');
const registry = await import('../src/bareos/registry.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const job = { vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01' };
const snap = (vm = {}) => ({
  vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_OFF', snapshotCount: 0, ...vm }, { id: 'vc-b:vm-2', vcenterId: 'vc-b', name: 'other' }],
  hosts: [{ vcenterId: 'vc-a', name: 'esx-1', cluster: 'CL-A' }, { vcenterId: 'vc-b', name: 'esx-b', cluster: 'CL-B' }],
  datastores: [{ vcenterId: 'vc-a', name: 'ds-a' }, { vcenterId: 'vc-b', name: 'ds-b' }],
});

test('덮어쓰기: 이름 재입력·꺼짐·스냅샷 0 이어야 · 못 읽은 값은 거부', () => {
  assert.match(restorePlan({ mode: 'original', job, snapshot: snap(), confirmName: 'web-1' }).issue, /다시 입력/);
  assert.match(restorePlan({ mode: 'original', job, snapshot: snap({ powerState: 'POWERED_ON' }), confirmName: 'web-01' }).issue, /켜져 있습니다/);
  assert.match(restorePlan({ mode: 'original', job, snapshot: snap({ powerState: undefined }), confirmName: 'web-01' }).issue, /전원 상태를 읽지 못했습니다/);
  assert.match(restorePlan({ mode: 'original', job, snapshot: snap({ snapshotCount: 2 }), confirmName: 'web-01' }).issue, /스냅샷이 2개/);
  assert.match(restorePlan({ mode: 'original', job, snapshot: snap({ snapshotCount: null }), confirmName: 'web-01' }).issue, /읽지 못했습니다/);
  assert.match(restorePlan({ mode: 'original', job, snapshot: snap({ snapshotCount: '' }), confirmName: 'web-01' }).issue, /읽지 못했습니다/, "'' 은 0 이 아니다");
  assert.match(restorePlan({ mode: 'original', job, snapshot: { vms: [] }, confirmName: 'web-01' }).issue, /인벤토리에 없습니다/);
  const ok = restorePlan({ mode: 'original', job, snapshot: snap(), confirmName: 'web-01' });
  assert.equal(ok.ok, true);
  assert.equal(ok.pluginOptions, 'python3:restore_powerstate=off');
});

test('새 VM: 동명 거부 · 인벤토리 검증(다른 vCenter 의 DS·클러스터는 안 됨) · 전원 off 고정', () => {
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'WEB-01' } }).issue, /이미 있습니다/);
  assert.equal(restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'other' } }).ok, true, '다른 vCenter 의 같은 이름은 상관없다');
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'r', datastore: 'ds-b' } }).issue, /인벤토리에 없습니다/);
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'r', cluster: 'CL-B' } }).issue, /인벤토리에 없습니다/);
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'r', cluster: 'CL-A', esxHost: 'esx-1' } }).issue, /하나만/);
  assert.match(restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'a:b' } }).issue, /콜론/);
  const ok = restorePlan({ mode: 'newVm', job, snapshot: snap(), newVm: { name: 'web-r', datastore: 'ds-a', esxHost: 'esx-1', powerOn: true } });
  assert.equal(ok.pluginOptions, 'python3:vmname=web-r:restore_powerstate=off:restore_datastore=ds-a:restore_esxhost=esx-1');
  assert.equal(ok.target.powerOn, false, '요청이 켜 달라고 해도 끈 채로');
});

test('로컬 VMDK · 모르는 방식', () => {
  assert.equal(restorePlan({ mode: 'localVmdk', job, snapshot: snap() }).pluginOptions, 'python3:localvmdk=yes');
  assert.match(restorePlan({ mode: 'other', job, snapshot: snap() }).issue, /방식/);
  assert.match(restorePlan({ mode: undefined, job, snapshot: snap() }).issue, /방식/);
});

const R = (jobid, level, state = 'ok', type = 'B') => ({ jobid, level, state, type });
test('체인: Full → 마지막 Diff → 그 뒤 Incr · 실패 제외 · Full 없으면 null', () => {
  const rows = [R(1, 'F'), R(2, 'I'), R(3, 'D'), R(4, 'I'), R(5, 'I', 'error'), R(6, 'I', 'warning'), R(7, 'F'), R(8, 'I')];
  assert.deepEqual(chainFromHistory(rows, 6), [1, 3, 4, 6]);
  assert.deepEqual(chainFromHistory(rows, 3), [1, 3]);
  assert.deepEqual(chainFromHistory(rows, 2), [1, 2]);
  assert.deepEqual(chainFromHistory(rows, 7), [7]);
  assert.deepEqual(chainFromHistory(rows, 8), [7, 8]);
  assert.equal(chainFromHistory(rows, 5), null, '실패한 백업은 복원 지점이 아니다');
  assert.equal(chainFromHistory([R(2, 'I'), R(4, 'I')], 4), null);
  assert.equal(chainFromHistory([R(9, 'F', 'ok', 'R')], 9), null, '복원 잡 행은 쓰지 않는다');
  assert.equal(chainIssue([1, 3, 6], 6), '');
  assert.match(chainIssue([1, 3], 6), /없습니다/);
  assert.match(chainIssue([3, 1, 6], 6), /순서/);
  assert.match(chainIssue(null, 6), /찾지 못했습니다/);
});

test('설정: 비밀번호는 봉인 저장(0600) · 응답에는 hasPassword 만 · 접속처 변경 시 폐기', () => {
  settings._resetForTest();
  const r = settings.saveSettings({ director: { host: 'bareos-dir.corp', consoleName: 'portal', password: 'pw-x' } });
  assert.equal(r.settings.director.hasPassword, true);
  assert.equal(r.settings.director.password, '');
  const file = path.join(tmp, 'bareos.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(settings.directorConn().conn.password, 'pw-x');
  assert.deepEqual(settings.saveSettings({ director: { port: 9102 } }).droppedSecrets, ['password']);
  assert.ok(settings.directorConn().missing.includes('콘솔 비밀번호'));
  assert.deepEqual(settings.saveSettings({ director: { password: 'pw-y' } }).droppedSecrets, []);
  assert.throws(() => settings.saveSettings({ director: { host: 'http://x' } }), /스킴/);
  assert.throws(() => settings.saveSettings({ sites: [{ vcenterId: 'a', vcserver: 'v', client: 'c d', storage: 's', pool: 'p', configFile: '/etc/x.ini' }] }), /FD 클라이언트/);
  assert.throws(() => settings.saveSettings({ sites: [
    { vcenterId: 'a', vcserver: 'v', client: 'c', storage: 's', pool: 'p', configFile: '/etc/x.ini' },
    { vcenterId: 'a', vcserver: 'v', client: 'c', storage: 's', pool: 'p', configFile: '/etc/x.ini' }] }), /두 번/);
});

test('설정 손상: 보존본을 남기고 빈 설정 + 오류 표시', () => {
  const file = path.join(tmp, 'bareos.json');
  fs.writeFileSync(file, '{ "director": { "password": "pw-leak');
  settings._resetForTest();
  assert.equal(settings.loadSettings().director.host, '');
  assert.ok(settings.settingsLoadError());
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('bareos.json.corrupt.')));
  assert.doesNotMatch(settings.settingsLoadError().reason, /pw-leak/);
});

test('원장: 같은 실행을 덜 자세한 행으로 받아도 값 유지 · 바뀌지 않으면 쓰지 않음 · 손상이면 추가 거부', () => {
  registry._resetForTest();
  const j = registry.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'w', dc: 'D', folder: '/', bareosJob: 'pv-1-vm-1', client: 'c', storage: 's', pool: 'p' });
  assert.throws(() => registry.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'w', dc: 'D', folder: '/', bareosJob: 'pv-1-vm-1', client: 'c', storage: 's', pool: 'p' }), /이미/);
  registry.markPending(j.id, { jobid: 7, level: 'Full', by: 'a' });
  registry.applyRunRow(j.id, { jobid: 7, status: 'T', bytes: 99, files: 3, errors: 0, startedAt: 1, endedAt: 2 });
  let g = registry.getJob(j.id);
  assert.equal(g.pending, null);
  assert.equal(g.lastRun.bytes, 99);
  const file = path.join(tmp, 'bareos-jobs.json');
  const m0 = fs.statSync(file).mtimeMs;
  registry.applyRunRow(j.id, { jobid: 7, status: 'T', bytes: null, files: null, errors: null, startedAt: null, endedAt: null });
  g = registry.getJob(j.id);
  assert.equal(g.lastRun.bytes, 99, '덜 자세한 행이 아는 값을 지우지 않는다');
  assert.equal(fs.statSync(file).mtimeMs, m0, '바뀐 것이 없으면 파일을 다시 쓰지 않는다');
  registry.applyRunRow(j.id, { jobid: 5, status: 'f' });
  assert.equal(registry.getJob(j.id).lastRun.jobid, 7, '오래된 실행이 최신 결과를 되돌리지 않는다');
  fs.writeFileSync(file, '{ broken');
  registry._resetForTest();
  assert.equal(registry.listJobs().length, 0);
  assert.ok(registry.registryLoadError());
  assert.throws(() => registry.addJob({ vcenterId: 'vc-a', vmId: 'x', vmName: 'x', dc: 'D', folder: '/', bareosJob: 'pv-2', client: 'c', storage: 's', pool: 'p' }), /읽지 못한 상태/);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('bareos-jobs.json.corrupt.')));
});
