import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-gg-'));
process.env.CONFIG_DIR = tmp;

let store, settings;
before(async () => {
  settings = await import('../src/gpu/settings.js');
  store = await import('../src/central/agentGpuGuestConfig.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('mergeGpuGuestSettings: 부분 병합 + 빈 비번 보존 + vmIps 삭제', () => {
  const { mergeGpuGuestSettings } = settings;
  const a = mergeGpuGuestSettings({}, { enabled: true, vcenters: { OC2: { username: 'root', password: 'p1', vms: { 'OC2:vm1': { username: 'u', password: 'x' } }, vmIps: { 'OC2:vm1': '10.0.0.5' } } } });
  assert.equal(a.vcenters.OC2.username, 'root');
  assert.equal(a.vcenters.OC2.password, 'p1');
  assert.equal(a.vcenters.OC2.vms['OC2:vm1'].password, 'x');
  assert.equal(a.vcenters.OC2.vmIps['OC2:vm1'], '10.0.0.5');
  // 빈 비번 → 기존 유지, 빈 vmIp → 삭제
  const b = mergeGpuGuestSettings(a, { vcenters: { OC2: { password: '', vmIps: { 'OC2:vm1': '' } } } });
  assert.equal(b.vcenters.OC2.password, 'p1', '빈 비번은 기존 유지');
  assert.equal(b.vcenters.OC2.vmIps['OC2:vm1'], undefined, '빈 IP는 자동으로 복귀(삭제)');
});

test('agentGpuGuestConfig: agent별 저장/조회/목록/redact', () => {
  const s = store.setAssignedGpuGuest('GM1', { enabled: true, vcenters: { OC2: { username: 'root', password: 'secret', winUsername: 'administrator', winPassword: 'winsec' } } });
  assert.equal(s.enabled, true);
  // 조회(비번 포함 — 엣지 pull이 사용)
  const raw = store.getAssignedGpuGuest('GM1');
  assert.equal(raw.vcenters.OC2.password, 'secret');
  assert.equal(raw.vcenters.OC2.winPassword, 'winsec');
  // 목록
  const list = store.listAssignedGpuGuestAgents();
  assert.ok(list.find((a) => a.agent === 'GM1'));
  // redact(비번 가림)
  const red = store.redactAssignedGpuGuest('GM1');
  assert.equal(red.assigned, true);
  assert.equal(red.settings.vcenters.OC2.hasPassword, true);
  assert.equal(red.settings.vcenters.OC2.password, undefined, '비번 평문 미노출');
  // 미지정 agent
  assert.equal(store.getAssignedGpuGuest('NOPE'), null);
  assert.equal(store.redactAssignedGpuGuest('NOPE').assigned, false);
});

test('agentGpuGuestConfig: 병합 저장(2차 저장이 이전 값 보존)', () => {
  store.setAssignedGpuGuest('GM2', { vcenters: { OC3: { username: 'root', password: 'p' } } });
  store.setAssignedGpuGuest('GM2', { vcenters: { OC3: { vms: { 'OC3:vmA': { username: 'a', password: 'b' } } } } });
  const raw = store.getAssignedGpuGuest('GM2');
  assert.equal(raw.vcenters.OC3.username, 'root', '1차 공용계정 보존');
  assert.equal(raw.vcenters.OC3.vms['OC3:vmA'].username, 'a', '2차 VM계정 병합');
});
