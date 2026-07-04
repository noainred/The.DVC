import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 엣지 자기등록 upsert — 신규 추가, 재등록 시 URL/토큰 갱신 + 관리자가 설정한
// vcenterId/enabled/표시이름은 보존되는지.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreg-'));
process.env.CONFIG_DIR = tmp;

let reg;
before(async () => { reg = await import('../src/collector/registry.js'); });
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('upsertCollectorFromAgent: 신규 엣지 자동 등록', () => {
  const r = reg.upsertCollectorFromAgent({ name: 'Poland-DC1', url: 'http://10.9.1.5:4000', token: 'tok-1', datacenter: 'Poland' });
  assert.equal(r.ok, true);
  const list = reg.loadCollectors();
  const c = list.find((x) => x.id === 'Poland-DC1');
  assert.ok(c);
  assert.equal(c.url, 'http://10.9.1.5:4000');
  assert.equal(c.token, 'tok-1');
  assert.equal(c.datacenter, 'Poland');
  assert.equal(c.enabled, true);
});

test('upsertCollectorFromAgent: 재등록 시 URL/토큰 갱신 + 관리자 설정(vcenterId·enabled·이름) 보존', () => {
  // 관리자가 vCenter 매핑·표시 이름을 설정하고 비활성화해 둠
  reg.updateCollector('Poland-DC1', { vcenterId: 'vc-poland', name: '폴란드 엣지', enabled: false });
  // 엣지가 IP가 바뀌어 재등록(자기등록은 부팅마다 재알림)
  const r = reg.upsertCollectorFromAgent({ name: 'Poland-DC1', url: 'http://10.9.1.99:4000', token: 'tok-2' });
  assert.equal(r.ok, true);
  const c = reg.loadCollectors().find((x) => x.id === 'Poland-DC1');
  assert.equal(c.url, 'http://10.9.1.99:4000'); // 갱신
  assert.equal(c.token, 'tok-2');               // 갱신
  assert.equal(c.vcenterId, 'vc-poland');       // 보존
  assert.equal(c.enabled, false);               // 보존(관리자가 껐으면 계속 꺼짐)
  assert.equal(c.name, '폴란드 엣지');           // 보존
});

test('upsertCollectorFromAgent: 이름 없으면 거부', () => {
  assert.equal(reg.upsertCollectorFromAgent({ url: 'http://x:4000', token: 't' }).ok, false);
});

// 자격증명 지문 진단 — "다른 법인은 되는데 특정 법인만 인증 실패" 원인 비교용.
test('idracScanJobs: 스캔 잡에 자격증명 지문(평문 아님) 이벤트 기록 — 동일 비번=동일 지문, 잘림=다른 지문', async () => {
  const j = await import('../src/central/idracScanJobs.js');
  const fp = (rid) => j.getIdracScanJobLog(rid).events.find((e) => e.msg.includes('사용 자격증명')).msg;
  const a = j.enqueueIdracScan('dcA', { ips: '10.9.0.0/30', username: 'root', password: 'S3cret!x', datacenterId: 'dcA' });
  const b = j.enqueueIdracScan('dcB', { ips: '10.9.1.0/30', username: 'root', password: 'S3cret!x', datacenterId: 'dcB' });
  const c = j.enqueueIdracScan('dcC', { ips: '10.9.2.0/30', username: 'root', password: 'S3cret!', datacenterId: 'dcC' });
  // 평문은 절대 남지 않는다
  assert.ok(!fp(a).includes('S3cret'));
  // 동일 자격증명 → 동일 지문(계정/길이/해시)
  const strip = (s) => s.split(' (평문')[0];
  assert.equal(strip(fp(a)), strip(fp(b)));
  // 잘린 비번 → 다른 지문
  assert.notEqual(strip(fp(a)), strip(fp(c)));
  // 뒤 공백 → 경고 표기
  const d = j.enqueueIdracScan('dcD', { ips: '10.9.3.0/30', username: 'root', password: 'S3cret!x ', datacenterId: 'dcD' });
  assert.match(fp(d), /공백/);
});
