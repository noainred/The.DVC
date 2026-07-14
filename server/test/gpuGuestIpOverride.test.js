import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guestIps } from '../src/gpu/sshCollect.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-ipovr-'));
process.env.CONFIG_DIR = tmp;

let settings;
before(async () => { settings = await import('../src/gpu/settings.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('guestIps: preferIp 지정 시 그 IP 하나만 반환(순차 폴백 안 함)', () => {
  const vm = { ipAddresses: ['10.0.0.5', '192.168.1.9'], ipAddress: '10.0.0.5' };
  // 지정 없음 → 보고된 모든 usable IP
  assert.deepEqual(guestIps(vm), ['10.0.0.5', '192.168.1.9']);
  // 지정 → 그 IP만
  assert.deepEqual(guestIps(vm, '192.168.1.9'), ['192.168.1.9']);
  // 보고 목록에 없는 IP라도 유효하면 그대로 사용(관리자 명시 선택)
  assert.deepEqual(guestIps(vm, '172.16.0.3'), ['172.16.0.3']);
  // 유효하지 않은 지정(링크로컬/빈값)은 무시하고 자동
  assert.deepEqual(guestIps(vm, '169.254.1.1'), ['10.0.0.5', '192.168.1.9']);
  assert.deepEqual(guestIps(vm, ''), ['10.0.0.5', '192.168.1.9']);
});

test('vmIps: 저장/해석/삭제 라운드트립(자격증명과 독립)', () => {
  settings.saveGpuGuestSettings({ vcenters: { OC2: { enabled: true, username: 'root', vmIps: { 'OC2:vm-1': '10.0.0.5' } } } });
  let s = settings.loadGpuGuestSettings();
  assert.equal(settings.resolveVmIp(s, 'OC2', 'OC2:vm-1'), '10.0.0.5');
  // 공용 계정 VM(vms override 없음)에도 IP 고정이 유지된다.
  assert.equal(s.vcenters.OC2.username, 'root');
  assert.equal((s.vcenters.OC2.vms || {})['OC2:vm-1'], undefined);

  // 빈 값 = 자동으로 복귀(삭제)
  settings.saveGpuGuestSettings({ vcenters: { OC2: { vmIps: { 'OC2:vm-1': '' } } } });
  s = settings.loadGpuGuestSettings();
  assert.equal(settings.resolveVmIp(s, 'OC2', 'OC2:vm-1'), '');
});

test('redactGpuGuestSettings: vmIps 포함(민감정보 아님)', () => {
  settings.saveGpuGuestSettings({ vcenters: { OC2: { vmIps: { 'OC2:vm-2': '192.168.1.9' } } } });
  const red = settings.redactGpuGuestSettings(settings.loadGpuGuestSettings());
  assert.equal(red.vcenters.OC2.vmIps['OC2:vm-2'], '192.168.1.9');
});

test('resolveCollectMethod: Windows는 ssh 단독을 게스트작업 우선(auto)으로 조정', () => {
  const { resolveCollectMethod } = settings;
  // Windows + ssh → auto(게스트작업 우선). sshd 없는 Windows에서 수집 실패 방지.
  assert.equal(resolveCollectMethod('ssh', true), 'auto');
  // Windows라도 guestops/auto는 그대로.
  assert.equal(resolveCollectMethod('guestops', true), 'guestops');
  assert.equal(resolveCollectMethod('auto', true), 'auto');
  // Linux는 관리자 설정 그대로(ssh 유지).
  assert.equal(resolveCollectMethod('ssh', false), 'ssh');
  assert.equal(resolveCollectMethod('guestops', false), 'guestops');
  // 잘못된 값은 auto로 안전 폴백.
  assert.equal(resolveCollectMethod('bogus', false), 'auto');
});
