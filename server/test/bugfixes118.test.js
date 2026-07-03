import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.118.0 버그 수정 회귀 테스트 모음.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix118-'));
process.env.CONFIG_DIR = tmp;
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

// ── IPAM expandRange: 큰 CIDR도 상한 전 전체 배열을 만들지 않고 상한까지만 생성 ──
test('ipam expandRange: /8은 slice 전 전체(1670만) 할당 없이 RANGE_CAP까지만', async () => {
  const { expandRange, RANGE_CAP } = await import('../src/ipam/scan.js');
  const out = expandRange('10.0.0.0/8');
  assert.equal(out.length, RANGE_CAP);
  assert.equal(out[0], '10.0.0.1'); // 네트워크 주소 제외, 첫 호스트부터
});
test('ipam expandRange: /24는 254개(정상 대역 변화 없음)', async () => {
  const { expandRange } = await import('../src/ipam/scan.js');
  assert.equal(expandRange('192.168.1.0/24').length, 254);
});

// ── logs settings: 부분 수정 시 보관기간/용량이 NaN으로 소실되지 않음 ──
test('logs settings: retentionDays 미포함 부분수정에도 기존 유한값 유지(NaN 소실 방지)', async () => {
  const s = await import('../src/logs/settings.js');
  s.saveLogSettings({ retentionDays: 30, maxSizeMB: 500 });
  const after1 = s.saveLogSettings({ enabled: true }); // retentionDays/maxSizeMB 미포함
  assert.equal(after1.retentionDays, 30);
  assert.equal(after1.maxSizeMB, 500);
  assert.ok(Number.isFinite(after1.retentionDays) && Number.isFinite(after1.maxSizeMB));
});

// ── proxy addMapping: 대상 호스트 형식 검증(HAProxy 설정 주입 차단) ──
test('proxy addMapping: 개행/공백 포함 targetHost 거부(설정 인젝션 차단)', async () => {
  const reg = await import('../src/proxy/registry.js');
  const bad = reg.addMapping({ protocol: 'ssh', targetHost: '1.2.3.4\n  bind *:9999', targetPort: 22 });
  assert.equal(bad.ok, false);
  const bad2 = reg.addMapping({ protocol: 'ssh', targetHost: 'host with space', targetPort: 22 });
  assert.equal(bad2.ok, false);
});
test('proxy addMapping: 정상 IP/호스트명은 허용', async () => {
  const reg = await import('../src/proxy/registry.js');
  const ok = reg.addMapping({ protocol: 'ssh', targetHost: '10.20.30.40', targetPort: 22 });
  assert.equal(ok.ok, true);
  if (ok.ok) reg.removeMapping(ok.mapping.id);
});

// ── idracScanJobs: 같은 대상이라도 비밀번호가 다르면 대기 잡을 새 값으로 갱신 ──
test('idracScanJobs: 동일 대역 재요청 시 바뀐 비밀번호가 반영됨(옛 비번 재사용 방지)', async () => {
  const j = await import('../src/central/idracScanJobs.js');
  const rid1 = j.enqueueIdracScan('agent-x', { ips: '10.0.0.0/30', username: 'root', password: 'old', datacenterId: 'dc1', noRegister: false });
  const rid2 = j.enqueueIdracScan('agent-x', { ips: '10.0.0.0/30', username: 'root', password: 'new', datacenterId: 'dc1', noRegister: true });
  assert.equal(rid1, rid2); // 같은 잡으로 병합(중복 방지 유지)
  const taken = j.takeIdracScanJobs('agent-x'); // 배열 반환
  const t = taken.find((x) => x.reqId === rid1);
  assert.ok(t, '인출된 잡이 있어야 함');
  assert.equal(t.password, 'new');   // 바뀐 비밀번호 반영
  assert.equal(t.noRegister, true);  // 바뀐 등록 플래그 반영
});
