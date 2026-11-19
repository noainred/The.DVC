/**
 * 전체 점검 36회차(GPU · Horizon/현재 사용자 · 아이실론) 회귀.
 *  F1: GPU 게스트 테스트 — 저장 비밀(공용 · 저장된 VM 비밀번호)을 쓰는 요청은 본문에 계정 글자가 있어도 고정 IP 검사(소스 계약).
 *  F2 · F3: 물리 GPU 서버 접속처 판정은 수집 경로와 같은 하나(usableIp) — 호스트명 · 루프백 · 링크로컬 등록 거부.
 *  F4: Horizon 등록부 · GPU 게스트 설정 손상 · 읽기 오류 중 쓰기 거절(원본 보존 · 그 한 건만 남는 저장 금지).
 *  F5: 아이실론 — 폴더 상한으로 잘린 조사끼리는 신규 · 사라짐을 판정하지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-hz-isi-audit36-'));
process.env.CONFIG_DIR = path.join(TMP, 'cfg');
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const SRC = new URL('../src/', import.meta.url);

test('F1: 고정 IP 검사 생략은 본문이 비밀번호를 직접 실은 별도 계정일 때만(useShared 는 언제나 검사)', () => {
  const s = fs.readFileSync(new URL('routes/admin/gpuGuest.js', SRC), 'utf8');
  assert.match(s, /const ownSecret = !it\.useShared && !!it\.username && \(!!it\.password \|\| !!it\.passwordless\);/);
  assert.match(s, /if \(preferIp && !ownSecret\) \{/);
  assert.doesNotMatch(s, /if \(preferIp && !\(it\.username && it\.password\)\)/, '옛 판정(글자만 보던 것)으로 되돌리지 않는다');
});

test('F2 · F3: 물리 GPU 서버는 수집 경로가 쓰는 주소(정규형 IPv4 · 루프백/링크로컬 제외)만 등록', async () => {
  const reg = await import('../src/gpu/physicalRegistry.js');
  for (const h of ['gpu01.corp.example', '127.0.0.1', '169.254.169.254', '010.0.0.5']) {
    const r = reg.addPhysical({ host: h, username: 'u', password: 'p' });
    assert.equal(r.ok, false, h);
    assert.match(r.reason, /IPv4 주소로 적으세요|IP\/호스트가 필요/, h);
  }
  const ok = reg.addPhysical({ host: '10.0.0.5', username: 'u', password: 'p' });
  assert.equal(ok.ok, true);
  assert.equal(reg.updatePhysical(ok.id, { host: 'gpu01.corp.example' }).ok, false, '수정으로 호스트명으로 바꾸는 것도 거부');
  assert.equal(reg.physicalHostIssue('10.0.0.5'), null);
});

test('F4: Horizon 등록부 손상 중 등록 · 삭제 거절(409) · 원본 보존 · 읽기 오류는 옮기지 않음', async () => {
  const hz = await import('../src/horizon/horizon.js');
  const file = path.join(process.env.CONFIG_DIR, 'horizon.json');
  fs.writeFileSync(file, '{bad');
  assert.deepEqual(hz.listHorizon(), []);
  assert.ok(hz.horizonLoadError(), '손상을 기억한다');
  const r = hz.upsertHorizon({ id: 'hz3', name: 'hz3', host: 'https://10.0.0.9', username: 'u', password: 'p' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.ok(!fs.existsSync(file) || fs.readFileSync(file, 'utf8') === '{bad', '주 파일을 그 한 건으로 만들지 않는다');
  assert.equal(hz.removeHorizon('x').status, 409);
  // 읽기 오류(EISDIR) — 옮기지 않는다
  for (const f of fs.readdirSync(process.env.CONFIG_DIR)) if (f.startsWith('horizon.json')) fs.rmSync(path.join(process.env.CONFIG_DIR, f), { recursive: true, force: true });
  fs.mkdirSync(file);
  hz.listHorizon();
  assert.ok(hz.horizonLoadError()?.readError);
  assert.ok(fs.statSync(file).isDirectory());
  assert.deepEqual(fs.readdirSync(process.env.CONFIG_DIR).filter((x) => x.startsWith('horizon.json.corrupt')), []);
  fs.rmSync(file, { recursive: true, force: true });
});

test('F4: GPU 게스트 설정 손상 중 관리자 저장 거절(409)', async () => {
  const g = await import('../src/gpu/settings.js');
  const file = path.join(process.env.CONFIG_DIR, 'gpu-guest.json');
  fs.writeFileSync(file, '{bad');
  g.loadGpuGuestSettings();
  assert.ok(g.gpuGuestSettingsLoadError());
  assert.throws(() => g.saveGpuGuestSettings({ vcenters: { 'vc-a': { enabled: true, username: 'u', password: 'p' } } }), (e) => e.code === 'settings-unreadable' && e.status === 409);
  assert.ok(!fs.existsSync(file), '주 파일을 새로 만들지 않는다(원본은 보존본으로)');
  assert.ok(fs.readdirSync(process.env.CONFIG_DIR).some((x) => x.startsWith('gpu-guest.json.corrupt')));
});

test('F5: 잘린 조사끼리 비교하면 신규 · 사라짐은 null + compareLimited', () => {
  const s = fs.readFileSync(new URL('isidu/report.js', SRC), 'utf8');
  assert.match(s, /const lim7 = !!\(okScan\.truncated \|\| base7\?\.truncated\);/);
  assert.match(s, /r\.new7 = b7 && !lim7 \? !b7\.has\(r\.name\) : null;/);
  assert.match(s, /const removed7 = b7 && !lim7 \?/);
  assert.match(s, /compareLimited: !!compareLimited7/);
  assert.match(fs.readFileSync(new URL('routes/api/isilonDirUsage.js', SRC), 'utf8'), /폴더 상한으로 일부만 저장된 조사/);
});

/* ── 38회차(36회차 수정 반증) ── */
test('38회차 R1: 아이실론 개요(overviewOf)도 보고서와 같은 잘림 판정', () => {
  const s = fs.readFileSync(new URL('isidu/report.js', SRC), 'utf8');
  const ov = s.slice(s.indexOf('const top = (await db.topEntriesOf('));
  assert.match(ov, /const lim7 = !!\(okScan\.truncated \|\| base7\?\.truncated\);/);
  assert.match(ov, /new7: b7 && !lim7 \? !b7\.has\(r\.name\) : null/);
  assert.doesNotMatch(s, /new7: b7 \? !b7\.has\(r\.name\) : null/, '잘림을 보지 않는 신규 판정이 남지 않는다');
});

test('38회차 R2 · R3: GET 이 loadError 를 싣고 Horizon 설정 현황 배지는 못 읽음을 등록 없음으로 보이지 않는다', async () => {
  const g = fs.readFileSync(new URL('routes/admin/gpuGuest.js', SRC), 'utf8');
  assert.match(g, /const le = gpuGuestSettingsLoadError\(\);/);
  const { RULES } = await import('../src/settingsStatus/grade.js');
  assert.equal(RULES['horizon-admin']({ loadError: true, count: null }).grade, 'warn');
  assert.equal(RULES['horizon-admin']({ loadError: false, count: 0 }).grade, 'off');
});

test('38회차 R4: 물리 GPU 수정이 주소 검사로 거부되면 어떤 칸도 바뀌지 않는다', async () => {
  const reg = await import('../src/gpu/physicalRegistry.js');
  const r = reg.addPhysical({ host: '10.0.0.77', name: 'gpu77', username: 'u', password: 'p' });
  assert.equal(r.ok, true);
  const bad = reg.updatePhysical(r.id, { name: 'SHOULD-NOT-STICK', host: 'bad host' });
  assert.equal(bad.ok, false);
  assert.equal(reg.getPhysicalRaw(r.id).name, 'gpu77');
});

test('38회차 R7: 엣지 손상 중 중앙 배포 적용은 rebuiltFromCorrupt 로 밝힌다', async () => {
  const g = await import('../src/gpu/settings.js');
  const file = path.join(process.env.CONFIG_DIR, 'gpu-guest.json');
  for (const f of fs.readdirSync(process.env.CONFIG_DIR)) if (f.startsWith('gpu-guest.json')) fs.rmSync(path.join(process.env.CONFIG_DIR, f), { force: true });
  fs.writeFileSync(file, '{bad');
  g.loadGpuGuestSettings();
  const r = g.applyPulledGpuGuestSettings({ vcenters: { 'vc-central': { enabled: true, username: 'u', password: 'p' } } });
  assert.equal(r.rebuiltFromCorrupt, true);
  assert.equal(g.gpuGuestSettingsLoadError(), null);
});
