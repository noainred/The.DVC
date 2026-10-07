/**
 * demoGuest2716.test.js — mock 모드의 내장 데모 계정(v2.716): 조회 전부 + 안전한 실행만.
 *
 * 사용자 지시: "Mock 모드에서 guest/demo 계정은 설정 제외한 모든 기능 가능하게 해줘" ·
 *   선택 "조회 전부 + 안전한 실행만" · "내장 데모 계정만".
 * ① 순수 판정(demoGuestDenial) ② 실제 authMiddleware + express 로 상태코드(mock vs live) ③ WS 게이트웨이 소스.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demoGuestDenial, normApiPath } from '../src/auth/demoGuest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const J = (p) => JSON.stringify(path.join(SRC, p));

test('① 조회는 허용, 설정·계정·비밀·업그레이드 조회는 거부', () => {
  for (const p of ['/api/vms', '/api/tools/storage', '/api/admin/idrac', '/api/admin/room-temp', '/api/tools/sanswitch/perf/traffic-total?x=1'])
    assert.equal(demoGuestDenial('GET', p), null, p);
  for (const p of ['/api/admin/users', '/api/Admin/Users/', '/api/admin/audit?limit=5', '/api/admin/backup/status', '/api/upgrade/status',
    '/api/admin/host-access', '/api/tools/credentials', '/api/auth/ad-config', '/api/admin/vcenters', '/api/remote/targets'])
    assert.ok(demoGuestDenial('GET', p), p);
});

test('① 실행은 안전 목록·읽기성 POST 만', () => {
  for (const [m, p] of [['POST', '/api/tools/storage/collect-all'], ['POST', '/api/tools/storage/devices/mock-st-1/collect'],
    ['POST', '/api/tools/sanswitch/perf/collect'], ['POST', '/api/search/nl'], ['POST', '/api/tool-usage'], ['POST', '/api/auth/logout']])
    assert.equal(demoGuestDenial(m, p), null, `${m} ${p}`);
  for (const [m, p] of [['POST', '/api/tools/storage/test'], ['POST', '/api/admin/vcenters/test'], ['POST', '/api/admin/idrac/scan-ranges/scan'],
    ['POST', '/api/tools/rma/run'], ['POST', '/api/tools/link-check/run'], ['PUT', '/api/tools/pdu/thresholds'], ['DELETE', '/api/tools/storage/devices/x'],
    ['POST', '/api/upgrade/apply'], ['POST', '/api/admin/host-access/apply'], ['POST', '/api/tools/storage/devices/a/b/collect'],
    ['POST', '/api/admin/emergency-stop'], ['POST', '/api/remote/quick-connect']])
    assert.ok(demoGuestDenial(m, p), `${m} ${p}`);
  assert.equal(normApiPath('/API/Tools/?q=1'), '/api/tools');
});

function run(dataSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demoguest2716-'));
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ users: [
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true, tokenVersion: 0 },
    { username: 'plainviewer', name: 'V', role: 'viewer', tokenVersion: 0 },
  ] }));
  const script = `
    const express = (await import('express')).default;
    const { authMiddleware, requireRole, signToken, resolveTokenUser } = await import(${J('auth/auth.js')});
    const app = express();
    app.use('/api', authMiddleware);
    app.get('/api/admin/idrac', requireRole('admin'), (req, res) => res.json({ ok: true }));
    app.get('/api/admin/users', requireRole('admin'), (req, res) => res.json({ ok: true }));
    app.post('/api/tools/storage/collect-all', requireRole('admin', 'operator'), (req, res) => res.json({ ok: true }));
    app.post('/api/tools/storage/test', requireRole('admin', 'operator'), (req, res) => res.json({ ok: true }));
    const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const tok = (u) => signToken({ sub: u, role: 'viewer', name: u, src: 'local', tv: 0 });
    const out = {};
    for (const u of ['thedvcdemp', 'plainviewer']) {
      const h = { authorization: 'Bearer ' + tok(u) };
      const st = async (m, p) => (await fetch(base + p, { method: m, headers: h })).status;
      out[u] = { ctx: resolveTokenUser(tok(u)),
        idrac: await st('GET', '/api/admin/idrac'), users: await st('GET', '/api/admin/users'),
        collect: await st('POST', '/api/tools/storage/collect-all'), test: await st('POST', '/api/tools/storage/test') };
    }
    srv.close();
    console.log('@@' + JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: dataSource, AUTH_ENABLED: 'true', AUTH_SECRET: 'x'.repeat(40) },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-1500));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-600) + r.stderr.slice(-600));
  return JSON.parse(line.slice(2));
}

test('② mock 모드: 데모 계정은 admin 화면 조회·안전 실행 가능, 설정·연결 테스트 403 — 일반 viewer 는 그대로', () => {
  const o = run('mock');
  const d = o.thedvcdemp;
  assert.equal(d.ctx.role, 'admin'); assert.equal(d.ctx.demoGuest, true); assert.ok(!d.ctx.superAdmin);
  assert.equal(d.idrac, 200); assert.equal(d.collect, 200);
  assert.equal(d.users, 403); assert.equal(d.test, 403);
  const v = o.plainviewer;
  assert.equal(v.ctx.role, 'viewer'); assert.ok(!v.ctx.demoGuest);
  assert.equal(v.idrac, 403); assert.equal(v.collect, 403);
});

test('② live 모드: 데모 계정은 예전처럼 viewer', () => {
  const d = run('live').thedvcdemp;
  assert.equal(d.ctx.role, 'viewer'); assert.ok(!d.ctx.demoGuest);
  assert.equal(d.idrac, 403); assert.equal(d.collect, 403);
});

test('③ WS SSH/RDP 게이트웨이는 데모 계정을 거부한다', () => {
  for (const f of ['proxy/sshGateway.js', 'proxy/guacdTunnel.js'])
    assert.match(fs.readFileSync(path.join(SRC, f), 'utf8'), /user\.mustEnrollOtp \|\| user\.demoGuest/, f);
});
