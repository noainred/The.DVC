import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePortalUnit } from '../src/agent/deploy.js';

// 다중 인스턴스/NAT 진단 회귀 방지 — :4001 같은 별도 포트 수집 서버에 대해 기본 인스턴스만
// 고치고 '성공'으로 오판하던 버그(토큰 강제 동기화 무효 동작)의 재현 케이스들.

const fake = (answers) => async (cmd) => {
  for (const [re, out] of answers) if (re.test(cmd)) return { stdout: out, stderr: '', code: 0 };
  return { stdout: '', stderr: '', code: 0 };
};

test('resolvePortalUnit: 포트 불명이면 기본 인스턴스', async () => {
  const r = await resolvePortalUnit(fake([]), undefined);
  assert.equal(r.unit, 'vmware-portal');
  assert.equal(r.envFile, '/etc/vmware-portal/portal.env');
});

test('resolvePortalUnit: 기본 유닛이 리슨 중이면 기본 인스턴스', async () => {
  const r = await resolvePortalUnit(fake([
    [/ss -ltnp/, 'LISTEN 0 511 0.0.0.0:4000 0.0.0.0:* users:(("node",pid=1234,fd=20))'],
    [/ps -o unit=/, 'vmware-portal.service'],
  ]), 4000);
  assert.equal(r.unit, 'vmware-portal');
  assert.equal(r.error, undefined);
});

test('resolvePortalUnit: 별도 유닛(:4001)이면 그 유닛·EnvironmentFile로 결정', async () => {
  const r = await resolvePortalUnit(fake([
    [/ss -ltnp/, 'LISTEN 0 511 *:4001 *:* users:(("node",pid=999,fd=21))'],
    [/ps -o unit=/, 'vmware-portal-irs.service'],
    [/systemctl show vmware-portal-irs/, 'EnvironmentFiles=/etc/vmware-portal-irs/portal.env (ignore_errors=no)'],
  ]), 4001);
  assert.equal(r.unit, 'vmware-portal-irs');
  assert.equal(r.envFile, '/etc/vmware-portal-irs/portal.env');
  assert.match(r.note, /별도 인스턴스/);
});

test('resolvePortalUnit: 리슨 없음 + 기본 PORT 불일치 → NAT/다른 장비 진단으로 실패', async () => {
  const r = await resolvePortalUnit(fake([
    [/ss -ltnp/, ''],
    [/grep -E '\^PORT='/, 'PORT=4000'],
  ]), 4001);
  assert.ok(r.error);
  assert.match(r.error, /포트포워딩|별도 인스턴스/);
});

test('resolvePortalUnit: 리슨 없음 + 기본 PORT 일치 → 서비스 중지로 보고 기본에 적용', async () => {
  const r = await resolvePortalUnit(fake([
    [/ss -ltnp/, ''],
    [/grep -E '\^PORT='/, 'PORT=4001'],
  ]), 4001);
  assert.equal(r.unit, 'vmware-portal');
  assert.match(r.note, /리슨 프로세스 없음/);
});

test('resolvePortalUnit: systemd 유닛이 아닌 프로세스(docker 등) → 실패', async () => {
  const r = await resolvePortalUnit(fake([
    [/ss -ltnp/, 'LISTEN 0 511 0.0.0.0:4001 0.0.0.0:* users:(("node",pid=77,fd=3))'],
    [/ps -o unit=/, '-'],
  ]), 4001);
  assert.ok(r.error);
  assert.match(r.error, /systemd 서비스가 아닌/);
});
