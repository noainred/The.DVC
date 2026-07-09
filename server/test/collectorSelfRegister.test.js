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

// 대소문자 중복 방지 — 'GM1' 수동 등록 후 엣지가 'gm1'로 자기등록해도 새 항목이 생기지 않고
// 기존 'GM1'을 갱신한다(수집서버가 2개씩 뜨던 버그 방지).
test('upsertCollectorFromAgent: 대소문자만 다른 이름은 기존 항목 갱신(중복 미생성)', () => {
  reg.addCollector({ id: 'GM1', name: 'GM1', url: 'http://192.168.60.221:4000', token: 't1', datacenter: 'GM1', vcenterId: 'vc-gm1' });
  const r = reg.upsertCollectorFromAgent({ name: 'gm1', url: 'http://192.168.60.221:4000', token: 't2' });
  assert.equal(r.ok, true);
  const gm = reg.loadCollectors().filter((c) => String(c.id).toLowerCase() === 'gm1');
  assert.equal(gm.length, 1);          // 2개가 아니라 1개
  assert.equal(gm[0].id, 'GM1');       // 기존 id 보존
  assert.equal(gm[0].vcenterId, 'vc-gm1'); // 관리자 매핑 보존
  assert.equal(gm[0].token, 't2');     // 토큰 갱신
});

// ★ 회귀: 관리자 수동 수정(managed) 항목은 엣지 자기등록이 URL/토큰을 덮어쓰지 않는다
// (저장한 값이 다음 자기등록 주기에 원복되던 버그).
test('upsertCollectorFromAgent: 관리자 고정(managed) 항목은 URL/토큰 원복 안 함', () => {
  // 관리자 UI 등록 경로 = managed:true
  reg.addCollector({ id: 'WA-IRS', name: 'WA-IRS', url: 'http://192.168.40.221:4068', token: 'ADMIN-SET' }, { managed: true });
  // 엣지가 자기등록(다른 URL/토큰으로) 시도 — 덮어쓰면 안 된다.
  const r = reg.upsertCollectorFromAgent({ name: 'WA-IRS', url: 'http://192.168.40.221:4000', token: 'EDGE-REPORTED' });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'managed', '자기등록이 관리자 고정 항목을 건너뜀');
  const c = reg.loadCollectors().find((x) => x.id === 'WA-IRS');
  assert.equal(c.url, 'http://192.168.40.221:4068', '관리자 URL 보존(원복 안 됨)');
  assert.equal(c.token, 'ADMIN-SET', '관리자 토큰 보존(원복 안 됨)');
});

test('updateCollector: 관리자 수정(managed:true)이 고정 플래그를 세팅하고, 이후 자기등록이 차단됨', () => {
  // 자기등록으로 먼저 생성(managed:false)
  reg.upsertCollectorFromAgent({ name: 'AZ', url: 'http://10.0.0.1:4000', token: 'auto1' });
  let c = reg.loadCollectors().find((x) => x.id === 'AZ');
  assert.equal(Boolean(c.managed), false, '자기등록 항목은 미고정');
  // 관리자가 UI에서 URL/토큰 수정(managed:true)
  reg.updateCollector('AZ', { url: 'http://forward.example:4090', token: 'ADMIN2' }, { managed: true });
  // 이제 자기등록이 와도 덮어쓰지 않음
  reg.upsertCollectorFromAgent({ name: 'AZ', url: 'http://10.0.0.1:4000', token: 'auto2' });
  c = reg.loadCollectors().find((x) => x.id === 'AZ');
  assert.equal(c.url, 'http://forward.example:4090', '관리자 URL 유지');
  assert.equal(c.token, 'ADMIN2', '관리자 토큰 유지');
  assert.equal(c.managed, true, '고정 플래그 유지');
});

test('addCollector: 대소문자만 다른 id 중복 등록 거부', () => {
  reg.addCollector({ id: 'HD', name: 'HD', url: 'http://192.168.79.221:4000', token: 'x' });
  const r = reg.addCollector({ id: 'hd', name: 'hd', url: 'http://192.168.79.221:4000', token: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /이미 존재/);
});

test('loadCollectors: 기존 대소문자 중복(수동+자기등록 잔재)을 로드 시 1개로 병합', () => {
  // collectors.json에 대소문자 중복이 이미 있는 상태를 직접 만든 뒤 로드 시 자동 정리 확인.
  const FILE = path.join(tmp, 'collectors.json');
  const dupes = { collectors: [
    { id: 'HM', name: 'HM', url: 'http://192.168.80.221:4000', token: 'a', datacenter: 'HM', vcenterId: 'vc-hm', enabled: true },
    { id: 'hm', name: 'HM', url: 'http://192.168.80.221:4000', token: 'a', datacenter: 'HM', enabled: true },
    { id: 'ST', name: 'ST', url: 'http://192.168.84.221:4000', token: 'b', enabled: true },
  ] };
  fs.writeFileSync(FILE, JSON.stringify(dupes), { mode: 0o600 });
  const loaded = reg.loadCollectors();
  const hm = loaded.filter((c) => String(c.id).toLowerCase() === 'hm');
  assert.equal(hm.length, 1);           // HM/hm → 1개
  assert.equal(hm[0].vcenterId, 'vc-hm'); // vcenterId 있는 쪽이 생존
  const st = loaded.filter((c) => String(c.id).toLowerCase() === 'st');
  assert.equal(st.length, 1);           // 중복 없던 것은 그대로
});
