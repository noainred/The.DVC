/**
 * cvpIpamFullAudit60.test.js — 전체 점검 60회차(CVP · IPAM 2차) 확정분.
 *  F1 vCenter 별 스캔 대역(ipam-vcenter-ranges.json) 손상: 표지 · 서비스 점검 등재 · 오류 중 저장 · 삭제 · 이전 거절(라우트 409) · 보존본 복구로 해제
 *     (25회차 F-4 예약 · 메모 파일의 형제 — 예전에는 빈 맵으로 넘어가 다음 저장이 그 vCenter 하나만 든 파일을 만들고 중앙 스캔이 조용히 멈췄다)
 *  F2 대역 용도(ipam-subnet-notes.json) 손상: 같은 판단(라우트 409)
 *  F3 중복 IP 바로 알림이 상한(200)을 넘어 묶음 한 건이 되는 회차에 IP 별 키를 보류로 넘긴다(예전에는 발생 중이던 IP 별 알림이 전부 '해소')
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cifa60-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_DIR = tmp;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const VC_FILE = path.join(tmp, 'ipam-vcenter-ranges.json');
const NOTE_FILE = path.join(tmp, 'ipam-subnet-notes.json');
// 손상본(절단) — 모듈이 처음 읽기 전에 놓는다
fs.writeFileSync(VC_FILE, '{"vcenters":{"vcA":{"ranges":["10.0.0.0/24"],"enabled":true},"vcB":');
fs.writeFileSync(NOTE_FILE, '{"10.1.1":{"purpose":"DB","desc":"x"},"10.1.2":');

const R = await import('../src/ipam/rangeStore.js');
const N = await import('../src/ipam/subnetNotes.js');
const M = await import('../src/ipam/vcRangeMigrate.js');
const U = await import('../src/util/settingsLoadError.js');
const express = (await import('express')).default;
const FULL = { username: 'root', role: 'admin', scope: null };

async function call(mount, method, url, body) {
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = FULL; next(); });
  mount(app);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _q, res, _n) => res.status(500).json({ error: String(err?.message || err) }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { srv.close(); }
}

test('F1 — vCenter 별 스캔 대역 파일 손상: 표지 · 저장 · 삭제 · 이전 거절(409) · 서비스 점검 · 복구로 해제', async () => {
  assert.deepEqual(R.listVcRanges(), []);
  assert.ok(R.vcRangesLoadError(), '로드 오류 표지(수정 전: null — 빈 맵을 정상처럼 썼다)');
  const r = R.saveVcRanges('vcC', { ranges: ['10.3.0.0/24'] });
  assert.equal(r.ok, false); assert.equal(r.code, 'settings-unreadable');
  assert.ok(!fs.existsSync(VC_FILE), '그 vCenter 하나만 든 새 파일을 쓰지 않았다(수정 전: vcC 만 든 파일)');
  assert.equal(R.removeVcRanges('vcA').code, 'settings-unreadable');
  assert.ok(U.listSettingsLoadErrors().some((x) => x.file === 'ipam-vcenter-ranges.json' && x.confirmable), '서비스 점검 목록 · 확정 가능');
  // 이전(v2.691): 원본을 못 읽으면 빈 목록으로 'done' 을 굳히지 않는다 · 수동 옮기기는 404 가 아니라 409
  const mig = M.runVcRangeMigration();
  assert.equal(mig.ran, false); assert.match(mig.reason, /vCenter 별 스캔 대역 파일/);
  assert.equal(M.readMigrationState(), null, '이전 상태 파일을 쓰지 않았다');
  assert.equal(M.moveVcRangeManually('vcA', 'edge-a').status, 409);
  assert.equal(M.removeVcRangeManually('vcA').status, 409);
  // 라우트 — PUT 409 · DELETE 409 · CSV 적용 409
  const { adminRouter } = await import('../src/routes/admin.js');
  const mount = (app) => app.use('/api/admin', adminRouter);
  assert.equal((await call(mount, 'PUT', '/api/admin/ipam/vc-ranges', { vcenterId: 'vcA', ranges: ['10.0.0.0/24'] })).status, 409);
  assert.equal((await call(mount, 'DELETE', '/api/admin/ipam/vc-ranges/vcA')).status, 409);
  const imp = await call(mount, 'POST', '/api/admin/ipam/vc-ranges/import', { csv: 'vcenter,ranges,enabled\nvcA,10.0.0.0/24,true\n', overwrite: true });
  assert.equal(imp.status, 409, JSON.stringify(imp.body)); assert.equal(imp.body.code, 'settings-unreadable');
  assert.ok(!fs.existsSync(VC_FILE));
  // 보존본을 되돌리면(mtime 이 바뀐다) 다시 읽고 표지가 풀린다
  fs.writeFileSync(VC_FILE, JSON.stringify({ vcenters: { vcA: { ranges: ['10.0.0.0/24'], enabled: true }, vcB: { ranges: ['10.2.0.0/24'], enabled: true } } }));
  assert.equal(R.vcRangesLoadError(), null);
  assert.deepEqual(R.listVcRanges().map((e) => e.vcenterId).sort(), ['vcA', 'vcB']);
  assert.equal(R.saveVcRanges('vcC', { ranges: ['10.3.0.0/24'] }).ok, true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(VC_FILE, 'utf8')).vcenters).sort(), ['vcA', 'vcB', 'vcC'], '복구 뒤 저장은 나머지를 지우지 않는다');
});

test('F1 — 객체가 아닌 vcenters(null · 배열)도 손상이다(예전: 그대로 캐시 → 저장이 TypeError)', async () => {
  await new Promise((r) => setTimeout(r, 20)); // mtime 이 바뀌게
  fs.writeFileSync(VC_FILE, '{"vcenters":null}');
  assert.ok(R.vcRangesLoadError());
  assert.equal(R.saveVcRanges('vcA', { ranges: ['10.0.0.0/24'] }).code, 'settings-unreadable');
  assert.ok(fs.readdirSync(tmp).filter((f) => f.startsWith('ipam-vcenter-ranges.json.corrupt.')).length >= 2, '원본은 보존본으로');
});

test('F2 — 대역 용도 파일 손상: 표지 · 저장 거절(라우트 409) · 서비스 점검', async () => {
  assert.equal(N.getSubnetNote('10.1.1'), null);
  assert.ok(N.subnetNotesLoadError(), '로드 오류 표지(수정 전: 없음)');
  const r = N.setSubnetNote('10.9.9', { purpose: 'new' }, 'u');
  assert.equal(r.ok, false); assert.equal(r.code, 'settings-unreadable');
  assert.ok(!fs.existsSync(NOTE_FILE), '그 대역 하나만 든 새 파일을 쓰지 않았다(수정 전: 10.9.9 만 든 파일)');
  assert.ok(U.listSettingsLoadErrors().some((x) => x.file === 'ipam-subnet-notes.json' && x.confirmable));
  const { registerIpamExport } = await import('../src/routes/api/ipamExport.js');
  const mount = (app) => { const rt = express.Router(); registerIpamExport(rt); app.use('/api', rt); };
  const res = await call(mount, 'PUT', '/api/tools/ipam/subnet-note', { base: '10.9.9', purpose: 'new' });
  assert.equal(res.status, 409, JSON.stringify(res.body)); assert.equal(res.body.code, 'settings-unreadable');
  // 확정(기본값 = 빈 맵) 뒤에는 저장된다 — 보존본은 남는다
  const c = U.confirmSettingsDefault('ipam-subnet-notes.json', { by: 't' });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(N.setSubnetNote('10.9.9', { purpose: 'new' }, 'u').ok, true);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('ipam-subnet-notes.json.corrupt.')));
});

test('F3 — 중복 IP 알림이 묶음 한 건이 되는 회차에 발생 중이던 IP 별 알림을 해소로 만들지 않는다', async () => {
  const { duplicateAlerts, DUP_ALERT_MAX } = await import('../src/ipam/instantAlerts.js');
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ ip: `10.9.${Math.floor(i / 250)}.${i % 250}`, duplicate: true, vcenterId: 'vc1' }));
  const firing = new Set(duplicateAlerts(rows(150)).alerts.map((a) => a.key));
  assert.equal(firing.size, 150);
  const d = duplicateAlerts(rows(DUP_ALERT_MAX + 50));
  assert.deepEqual(d.alerts.map((a) => a.key), ['ipdup:__many__']);
  // 엔진(alerts.js 해소 루프)과 같은 규칙: 이번 키 목록에도 보류에도 없는 발생 중 키는 '해소'
  const seen = new Set(d.alerts.map((a) => a.key)); const held = new Set(d.held);
  const resolved = [...firing].filter((k) => !seen.has(k) && !held.has(k));
  assert.deepEqual(resolved, [], `수정 전: ${resolved.length}건이 해소로 기록됐다(중복은 그대로)`);
  // 상한 아래로 내려오면 예전처럼 IP 별(보류 없음)
  assert.deepEqual(duplicateAlerts(rows(10)).held, []);
});
