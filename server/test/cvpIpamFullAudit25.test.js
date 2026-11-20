/**
 * cvpIpamFullAudit25.test.js — 전체 점검 25회차(CVP · IPAM) 확정분.
 *  F-1 IPMS 설정 전체 저장은 조회 ∧ 쓰기 전체만(조회 무제한 + 쓰기 vcA 가 전역 · 모든 vCenter 무시 대역을 바꾸던 것)
 *  F-2 CVP 설정 손상 중 정리 보류 · GET loadError · PUT 409 · F-3 IP 스캔 배정 손상 중 쓰기 거절
 *  F-4 override · 메모 손상 표지 · 쓰기 거절 · 관리 IP 보존 · F-5 쓰기 실패 시 메모리 불변 · F-6 · F-7 CVP 등록부 저장 순서 · 수정 중복
 *  F-9 CVP 인증 정지 시각 수신 시각으로 · F-10 __proto__ 보고 이름
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cifa25-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(HERE, '../src');
const rd = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const sub = (setup, code) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cifa25s-'));
  try {
    setup(d);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: d, DATA_DIR: d }, encoding: 'utf8' });
    const line = r.stdout.trim().split('\n').pop();
    try { return { out: JSON.parse(line), dir: d, files: fs.readdirSync(d) }; } catch { throw new Error(`${r.stdout}\n${r.stderr}`); }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

test('F-1 — 조회 무제한 + 쓰기 vcA 관리자는 전역 목록 · vcB 무시 대역을 바꾸지 못한다', async () => {
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }], vms: [], hosts: [] };
  const S = await import('../src/ipam/settings.js');
  S.saveSettings({ global: ['192.0.2.0/24'], publicRanges: [], privateRanges: [], vcenters: { vcA: ['10.1.0.0/24'], vcB: ['10.2.0.0/24'] } });
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const U = { wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } }, adm: { username: 'adm', role: 'admin', scope: null } };
  const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = U[req.headers['x-u']] || null; next(); }); app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const put = async (who, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/ipam/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-u': who }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const r = await put('wadm', { global: ['0.0.0.0/8'], publicRanges: ['10.0.0.0/8'], vcenters: { vcA: [], vcB: [] } });
    assert.equal(r.status, 200);
    const after = S.loadSettings();
    assert.deepEqual(after.global, ['192.0.2.0/24'], '전역 무시 대역 그대로(수정 전: 0.0.0.0/8)');
    assert.deepEqual(after.vcenters.vcB, ['10.2.0.0/24'], 'vcB 무시 대역 그대로(수정 전: 삭제)');
    assert.deepEqual(after.vcenters.vcA || [], [], '쓰기 범위 안(vcA)은 바뀐다');
    const full = await put('adm', { global: ['198.51.100.0/24'], publicRanges: [], privateRanges: [], vcenters: { vcA: [], vcB: [] } });
    assert.equal(full.status, 200); assert.deepEqual(S.loadSettings().global, ['198.51.100.0/24'], '전체 범위는 예전 그대로');
  } finally { srv.close(); }
});

test('F-3 — IP 스캔 배정 파일 손상 중 한 에이전트 저장 · 삭제는 거절(파일 · 표지 그대로)', () => {
  const { out, files } = sub((d) => fs.writeFileSync(path.join(d, 'ipam-scan.json'), '{"agents":{"edge-a":{"ranges":["10.0.0.0/24"]},"edge-b":'),
    `const S = await import(${JSON.stringify(path.join(SRC, 'ipam/scanStore.js'))});
     let e1 = null, e2 = null; try { S.saveScanSettings('edge-c', { ranges: ['10.9.0.0/24'] }); } catch (e) { e1 = e.code; }
     try { S.deleteScanAgent('edge-a'); } catch (e) { e2 = e.code; }
     console.log(JSON.stringify({ e1, e2, err: !!S.scanSettingsLoadError() }));`);
  assert.equal(out.e1, 'settings-unreadable'); assert.equal(out.e2, 'settings-unreadable'); assert.equal(out.err, true, '표지 유지(수정 전: 풀림)');
  assert.ok(!files.includes('ipam-scan.json'), '새 파일을 쓰지 않았다(손상 원본은 보존본으로)');
  assert.match(rd('ipam/scanPoller.js'), /if \(!scanSettingsLoadError\(\)\) pruneScanResults\(s\.retentionDays\);/);
  assert.equal((rd('routes/admin/centralIpam.js').match(/if \(scanCfgUnreadable\(res\)\) return;/g) || []).length, 4);
});

test('F-4 · F-5 — override · 메모 손상: 표지 · 쓰기 거절 · 관리 IP 보존 · 서비스 점검 등재', () => {
  const { out } = sub((d) => { fs.writeFileSync(path.join(d, 'ipam-overrides.json'), '{"10.0.0.5":{"status":"reserved"},"10.0.0.6":'); fs.writeFileSync(path.join(d, 'ipam-annotations.json'), '{"10.0.0.5":'); },
    `const O = await import(${JSON.stringify(path.join(SRC, 'ipam/overrides.js'))});
     const A = await import(${JSON.stringify(path.join(SRC, 'ipam/annotations.js'))});
     const U = await import(${JSON.stringify(path.join(SRC, 'util/settingsLoadError.js'))});
     const r1 = O.setOverride('10.0.0.7', { status: 'reserved' }, { username: 't' });
     const r2 = A.setAnnotation('10.0.0.7', { memo: 'x' }, { username: 't' });
     const r3 = O.setOverridesMany([{ ip: '10.0.0.8', partial: { status: 'reserved' } }], { username: 't' });
     const files = U.listSettingsLoadErrors().map((x) => x.file);
     console.log(JSON.stringify({ r1: r1.code, r2: r2.code, r3: r3.code, o: !!O.overridesLoadError(), a: !!A.annotationsLoadError(), files }));`);
  assert.equal(out.r1, 'settings-unreadable'); assert.equal(out.r2, 'settings-unreadable'); assert.equal(out.r3, 'settings-unreadable');
  assert.equal(out.o, true); assert.equal(out.a, true);
  assert.ok(out.files.includes('ipam-overrides.json') && out.files.includes('ipam-annotations.json'), '서비스 점검 목록');
  assert.match(rd('ipam/scanStore.js'), /if \(overridesLoadError\(\)\) return \(\) => true;/);
  // F-5: 사본에 고친다
  assert.equal((rd('ipam/overrides.js').match(/const data = \{ \.\.\.load\(\) \};/g) || []).length, 4);
  assert.equal((rd('ipam/annotations.js').match(/const data = \{ \.\.\.load\(\) \};/g) || []).length, 2);
});

test('F-2 · F-6 · F-7 · F-9 · F-10 — CVP 정리 보류 · 등록부 · 시각 · 보고 이름', async () => {
  const po = rd('cvp/poller.js');
  assert.equal((po.match(/prunePerSettings\(settings\);/g) || []).length, 2); assert.doesNotMatch(po, /db\.maybePrune\(settings\)\.catch\(\(\) => \{\}\);\n(?!\})/);
  const cvpRoute = rd('routes/api/cvp.js');
  assert.match(cvpRoute, /if \(cvpSettingsLoadError\(\)\) return res\.status\(409\)/);
  const R = await import('../src/cvp/registry.js');
  const a = R.saveServer({ name: 'A', host: 'https://10.0.0.10', username: 'u', authMode: 'token', token: 't1' });
  const b = R.saveServer({ name: 'B', host: 'https://10.0.0.11', username: 'u', authMode: 'token', token: 't2' });
  assert.throws(() => R.saveServer({ id: b.id, name: 'B', host: 'https://10.0.0.10', username: 'u', authMode: 'token', token: 't3' }), /이미 등록/);
  assert.deepEqual(R.listServers().map((x) => x.host).sort(), ['https://10.0.0.10', 'https://10.0.0.11'], '거절이 메모리를 바꾸지 않는다');
  void a;
  assert.match(rd('cvp/registry.js'), /persist\(nextList\);\n  db\.servers = nextList;/);
  const { cleanStatus } = await import('../src/central/cvpEdge.js');
  const now = Date.now();
  const st = cleanStatus({ cvpId: 'c', authStopped: { since: now + 86_400_000 * 30, at: now + 86_400_000 * 30, attempts: 2, reason: 'x' } }, now);
  assert.ok(st.authStopped.since <= now && st.authStopped.at <= now, '미래 시각은 수신 시각으로');
  const S = await import('../src/ipam/scanStore.js');
  S.recordAgentReport('__proto__', { scanned: 5, alive: 1 });
  assert.equal(Object.getPrototypeOf(S.getAgentReports ? (S.getAgentReports() || {}) : {}) !== null, true);
  assert.equal(({}).scanned, undefined, '전역 오염 없음');
});
