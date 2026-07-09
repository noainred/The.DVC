import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'deploytgt-'));

let reg;
before(async () => { reg = await import('../src/agent/deployRegistry.js'); });

test('saveTarget/listTargets: gpuGuest 보존 + 비밀번호 redact(값 대신 has* 플래그)', () => {
  const s = reg.saveTarget({ host: '10.0.0.9', agentName: 'NJ', collectorDatacenter: 'NJ',
    gpuGuest: { enabled: true, vcenterId: 'vc-nj', vcenterHost: '192.168.52.200', vcenterUser: 'administrator@vsphere.local', vcenterPass: 'secret1', guestUser: 'root', guestPass: 'secret2' } });
  assert.equal(s.ok, true);
  const t = reg.listTargets().find((x) => x.agentName === 'NJ');
  assert.equal(t.gpuGuest.enabled, true);
  assert.equal(t.gpuGuest.vcenterId, 'vc-nj');
  assert.equal(t.gpuGuest.vcenterHost, '192.168.52.200');
  assert.equal(t.gpuGuest.guestUser, 'root');
  assert.equal(t.gpuGuest.vcenterPass, '', '비밀번호는 응답에 노출 안 됨');
  assert.equal(t.gpuGuest.hasVcenterPass, true, '저장 여부는 플래그로');
  assert.equal(t.gpuGuest.hasGuestPass, true);
});

test('saveTarget: 편집 시 빈 비밀번호 재전송해도 기존 gpuGuest 비밀번호 보존', () => {
  const t = reg.listTargets().find((x) => x.agentName === 'NJ');
  reg.saveTarget({ id: t.id, host: '10.0.0.9', agentName: 'NJ',
    gpuGuest: { enabled: true, vcenterId: 'vc-nj', vcenterHost: '192.168.52.200', vcenterUser: 'administrator@vsphere.local', vcenterPass: '', guestUser: 'root', guestPass: '' } });
  const raw = reg.getTargetRaw(t.id);
  assert.equal(raw.gpuGuest.vcenterPass, 'secret1', '빈 값 재전송 시 기존 비번 유지');
  assert.equal(raw.gpuGuest.guestPass, 'secret2');
});

test('findTargetByHost: host+port+username 매칭(배포 upsert 중복 방지)', () => {
  const t = reg.listTargets().find((x) => x.agentName === 'NJ');
  const found = reg.findTargetByHost('10.0.0.9', 22, undefined);
  assert.ok(found, '같은 호스트 대상 발견');
  assert.equal(found.id, t.id);
  assert.equal(reg.findTargetByHost('10.9.9.9', 22, undefined), null, '없는 호스트는 null');
});

test('배포 upsert 시나리오: id 없이 같은 호스트 저장은 중복 없이 기존 대상 갱신', () => {
  const before = reg.listTargets().filter((x) => x.host === '10.0.0.9').length;
  const id = reg.findTargetByHost('10.0.0.9', 22, undefined)?.id;
  reg.saveTarget({ id, host: '10.0.0.9', agentName: 'NJ',
    gpuGuest: { enabled: true, vcenterId: 'vc-nj-2', vcenterHost: '192.168.52.201', vcenterUser: 'admin', guestUser: 'root' } });
  const after = reg.listTargets().filter((x) => x.host === '10.0.0.9');
  assert.equal(after.length, before, '중복 생성 없음(1개 유지)');
  assert.equal(after[0].gpuGuest.vcenterId, 'vc-nj-2', '기존 대상이 갱신됨');
});
