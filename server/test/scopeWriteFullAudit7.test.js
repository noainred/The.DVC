/**
 * scopeWriteFullAudit7.test.js — 전체 소스 점검 7회차(2회차 반증 R-1 · R-2 · R-3): 쓰기 메서드인데 조회 범위만 보던 라우트 전수.
 *  조회 무제한 + 쓰기 vcA(wadm) · 조회 vcA(sadm) · 전체(adm) 세 계정으로 '조회 밖 404 → 쓰기 밖 403' 을 고정한다.
 *  ① 사용자 관리: 쓰기 제한 관리자는 자기 · 남의 범위를 넓히거나(전체로) 전체 범위 관리자를 만들 · 고칠 수 없다(R-1 — 권한 상승)
 *  ② vCenter 등록: 쓰기 범위 밖 수정 · 삭제 · 저장 항목 시험은 403(조회 범위 계정은 404 그대로)(R-2)
 *  ③ Ping 대상 · 일괄 · 중계 서버 · 데이터 삭제 · 설정 저장 병합 · OS 스캔 실행(R-3)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scopewrite7-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
fs.writeFileSync(path.join(DIR, 'users.json'), JSON.stringify({ users: [
  { username: 'full', role: 'admin', passwordHash: 'x' },
  { username: 'wadm', role: 'admin', passwordHash: 'x', scope: { vcenters: [], writeVcenters: ['vcA'] } },
  { username: 'opA', role: 'operator', passwordHash: 'x', scope: { vcenters: ['vcA'] } },
  { username: 'opB', role: 'operator', passwordHash: 'x', scope: { vcenters: ['vcB'] } },
] }));

const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }], vms: [], hosts: [] };
const U = {
  adm: { username: 'adm', role: 'admin', scope: null },
  wadm: { username: 'wadm', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vcA'] } },
};
let srv;
const base = async () => {
  if (srv) return `http://127.0.0.1:${srv.address().port}`;
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const { api } = await import('../src/routes/api.js');
  const { pingRouter } = await import('../src/routes/ping.js');
  const { remoteRouter } = await import('../src/routes/remote.js');
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = U[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', adminRouter); app.use('/api/ping', pingRouter); app.use('/api/remote', remoteRouter); app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return `http://127.0.0.1:${srv.address().port}`;
};
test.after(() => srv?.close());
const call = async (who, method, p, body) => {
  const r = await fetch(`${await base()}${p}`, { method, headers: { 'content-type': 'application/json', 'x-u': who }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, body: j };
};

test('① 사용자 관리 — 쓰기 제한 관리자는 범위를 넓히지 못한다(자기 · 새 계정 · 전체 범위 계정)', async () => {
  // 자기 범위를 전체(null)로
  assert.equal((await call('wadm', 'PATCH', '/api/admin/users/wadm', { scope: null })).status, 403, '자기 범위 해제 금지');
  // 쓰기 범위 밖을 더하기
  assert.equal((await call('wadm', 'PATCH', '/api/admin/users/wadm', { scope: { vcenters: [], writeVcenters: ['vcA', 'vcB'] } })).status, 403);
  // 전체 범위 관리자 만들기
  assert.equal((await call('wadm', 'POST', '/api/admin/users', { username: 'evil', role: 'admin', password: 'Passw0rd!Passw0rd!', scope: null })).status, 403);
  // 전체 범위 계정 고치기 · 지우기 — 목록에 보이는 계정이라 403(존재 은닉 아님)
  assert.equal((await call('wadm', 'PATCH', '/api/admin/users/full', { name: 'x' })).status, 403);
  assert.equal((await call('wadm', 'DELETE', '/api/admin/users/full')).status, 403);
  assert.equal((await call('wadm', 'PATCH', '/api/admin/users/opB', { name: 'x' })).status, 403, '쓰기 범위 밖(vcB) 계정');
  // 자기 쓰기 범위 안 계정은 그대로 다룬다
  const okA = await call('wadm', 'PATCH', '/api/admin/users/opA', { name: '운영 A' });
  assert.equal(okA.status, 200, JSON.stringify(okA.body));
  // 조회 범위 계정은 범위 밖 계정을 모른다(404 그대로)
  assert.equal((await call('sadm', 'PATCH', '/api/admin/users/opB', { name: 'x' })).status, 404);
  // 전체 범위 관리자는 예전 그대로
  assert.equal((await call('adm', 'PATCH', '/api/admin/users/opB', { name: '운영 B' })).status, 200);
});

test('② vCenter 등록 — 쓰기 범위 밖 수정 · 삭제 · 저장 항목 시험 403 · 조회 범위 밖 404', async () => {
  assert.equal((await call('wadm', 'PUT', '/api/admin/vcenters/vcB', { name: 'x' })).status, 403);
  assert.equal((await call('wadm', 'DELETE', '/api/admin/vcenters/vcB')).status, 403);
  assert.equal((await call('wadm', 'POST', '/api/admin/vcenters/test', { id: 'vcB' })).status, 403);
  assert.equal((await call('sadm', 'DELETE', '/api/admin/vcenters/vcB')).status, 404);
  const all = await call('wadm', 'POST', '/api/admin/vcenters/test-all', {});
  assert.equal(all.status, 200); assert.equal(all.body.scoped, true, '쓰기 범위 안만 시험한다');
});

test('③ Ping 대상 · 일괄 — 쓰기 범위 밖 403 · 조회 범위 밖 404 · 일괄은 조회 ∧ 쓰기 전체만', async () => {
  const t = { name: 'pb', host: '10.1.2.3', vcenterId: 'vcB', source: 'manual' };
  assert.equal((await call('wadm', 'POST', '/api/ping/targets', t)).status, 403);
  assert.equal((await call('sadm', 'POST', '/api/ping/targets', t)).status, 404);
  const okA = await call('wadm', 'POST', '/api/ping/targets', { ...t, name: 'pa', vcenterId: 'vcA' });
  assert.notEqual(okA.status, 403); assert.notEqual(okA.status, 404);
  for (const p of ['/api/ping/seed-vcenters', '/api/ping/poll-now']) assert.equal((await call('wadm', 'POST', p, {})).status, 403, p);
});

test('③ 중계 서버 · 데이터 삭제 · OS 스캔 실행', async () => {
  assert.equal((await call('wadm', 'POST', '/api/remote/proxies', { id: 'default', name: 'x', host: '10.0.0.9' })).status, 403, '기본 중계 서버는 전 법인 공용');
  assert.equal((await call('wadm', 'DELETE', '/api/tools/vmseries/data?vcenterId=vcB')).status, 403);
  assert.equal((await call('wadm', 'DELETE', '/api/tools/waste/settings/data?vcenterId=vcB')).status, 403);
  assert.equal((await call('wadm', 'DELETE', '/api/tools/waste/settings/data?all=1')).status, 403, '전체 합계');
  assert.equal((await call('wadm', 'POST', '/api/admin/os-scan/run', { vcenterId: 'vcB' })).status, 403);
  assert.equal((await call('sadm', 'POST', '/api/admin/os-scan/run', { vcenterId: 'vcB' })).status, 404);
});

test('③ 설정 저장 — 쓰기 제한 관리자의 전역 필드 · 범위 밖 키는 적용하지 않고 밝힌다', async () => {
  const off = await call('wadm', 'PUT', '/api/tools/waste/off-check/settings', { enabled: true, intervalHours: 1 });
  assert.equal(off.status, 200); assert.ok((off.body.ignoredGlobal || []).length > 0, '전역 필드는 버린다');
  const gd = await call('wadm', 'PUT', '/api/tools/guest-disk/settings', { enabled: true });
  assert.equal(gd.status, 200); assert.ok((gd.body.ignoredGlobal || []).length > 0);
  const an = await call('wadm', 'PUT', '/api/admin/anomaly', { perVcenter: { vcB: { threshold: 9 } } });
  assert.equal(an.status, 200); assert.equal(an.body.ignoredOutOfScope, 1, '쓰기 범위 밖 키는 무시');
  // 전체 범위 관리자는 예전 그대로 저장
  const offAdm = await call('adm', 'PUT', '/api/tools/waste/off-check/settings', { enabled: false });
  assert.equal(offAdm.status, 200); assert.equal(offAdm.body.ignoredGlobal, undefined);
});
