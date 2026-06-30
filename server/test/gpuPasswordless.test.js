import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpupwless-'));
const { saveGpuGuestSettings, loadGpuGuestSettings, resolveVmCreds, redactGpuGuestSettings } = await import('../src/gpu/settings.js');

test('passwordless: 저장 시 빈 비번 + 플래그, resolve는 빈 비번 반환', () => {
  saveGpuGuestSettings({ vcenters: { vc1: { enabled: true, vms: { 'vc1:vm-1': { username: 'svc', passwordless: true } } } } });
  const s = loadGpuGuestSettings();
  const cred = s.vcenters.vc1.vms['vc1:vm-1'];
  assert.equal(cred.username, 'svc');
  assert.equal(cred.password, '');
  assert.equal(cred.passwordless, true);

  const r = resolveVmCreds(s, 'vc1', 'vc1:vm-1', false);
  assert.equal(r.username, 'svc');
  assert.equal(r.password, '');     // 빈 비번으로 인증(저장값 폴백 없음)
  assert.equal(r.source, 'vm');
});

test('passwordless: redact가 passwordless 플래그 노출(비번은 가림)', () => {
  const red = redactGpuGuestSettings(loadGpuGuestSettings());
  const c = red.vcenters.vc1.vms['vc1:vm-1'];
  assert.equal(c.passwordless, true);
  assert.equal(c.hasPassword, false);
  assert.ok(!('password' in c));
});

test('passwordless → 일반 비번으로 전환 시 플래그 해제', () => {
  saveGpuGuestSettings({ vcenters: { vc1: { vms: { 'vc1:vm-1': { username: 'svc', password: 'P@ss!' } } } } });
  const cred = loadGpuGuestSettings().vcenters.vc1.vms['vc1:vm-1'];
  assert.equal(cred.password, 'P@ss!');
  assert.ok(!cred.passwordless);
});

test('일반 별도 계정: 빈 비번 저장은 이전 비번 유지(passwordless 아님)', () => {
  saveGpuGuestSettings({ vcenters: { vc1: { vms: { 'vc1:vm-2': { username: 'root', password: 'secret' } } } } });
  saveGpuGuestSettings({ vcenters: { vc1: { vms: { 'vc1:vm-2': { username: 'root' } } } } }); // 비번 빈칸 재저장
  const cred = loadGpuGuestSettings().vcenters.vc1.vms['vc1:vm-2'];
  assert.equal(cred.password, 'secret'); // 폴백 유지
  assert.ok(!cred.passwordless);
});
