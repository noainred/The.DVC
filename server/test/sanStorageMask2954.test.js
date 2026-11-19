/**
 * v2.954(점검 A-3) — SAN 스토리지 성능 설정 조회의 비관리자 판본.
 *  조회 라우트(report · notify · check-settings)는 tools + 전체 범위라 전체 범위 operator(+ tools 를 받은 viewer · 데모 계정)도 부른다(카탈로그 adminOnly 는 서버 집행이 아니다).
 *  · 월간 보고서 받는 사람 메일 주소(settings.to)는 개수로만(toCount · toHidden) — 형제 아이실론 · 종합 메일과 같은 결.
 *  · 설정한 관리자 계정명(updatedBy)은 뺀다. 발송 기록 사유 · 결과 문구 안 메일 주소도 가린다.
 *  · 관리자(isAdminReq = isAdminDetailUser)는 원문.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'sanst2954-'));
process.env.CONFIG_DIR = DIR;
process.env.SANSW_PERF_ROLLUP_BACKFILL = '0';
Object.assign(process.env, { DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', IPAM_WRITE_WORKER: '0' });

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
fs.writeFileSync(path.join(DIR, 'san-storage-report.json'), JSON.stringify({ enabled: true, dayOfMonth: 1, time: '09:00', to: ['storage-lead@corp.example', 'ops@corp.example'], topN: 10, updatedAt: NOW, updatedBy: 'boss-admin' }));
fs.writeFileSync(path.join(DIR, 'san-storage-report-state.json'), JSON.stringify({ lastSlot: NOW - HOUR, lastSentAt: null,
  history: [{ at: NOW - HOUR, slot: NOW - HOUR, kind: 'auto', state: 'failed', code: 'smtp', reason: '550 5.1.1 <storage-lead@corp.example>: Recipient address rejected', to: 2 }] }));
fs.writeFileSync(path.join(DIR, 'san-storage-notify.json'), JSON.stringify({ enabled: true, minLevel: 'warn', recoveries: true, updatedAt: NOW, updatedBy: 'boss-admin' }));
fs.writeFileSync(path.join(DIR, 'san-storage-notify-state.json'), JSON.stringify({ last: {}, at: NOW, lastTick: null,
  history: [{ at: NOW - HOUR, dc: 'vcA', title: 't', severity: 'warn', result: 'email:err 550 <ops@corp.example> rejected' }] }));
fs.writeFileSync(path.join(DIR, 'storage-perf-check.json'), JSON.stringify({ v: 1, values: {}, updatedAt: NOW, updatedBy: 'boss-admin' }));

const USERS = {
  adm: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  demo: { username: 'thedvcdemo-like', role: 'admin', demoGuest: true, scope: null },   // 데모 계정(admin 문맥 + demoGuest)은 관리자 판본이 아니다
};
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { registerSanStorage } = await import('../src/routes/api/sanStorage.js');
  const router = express.Router();
  registerSanStorage(router);
  const app = express(); app.use(express.json());
  app.use((req, _r, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', router);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });
const get = async (u, p) => { const r = await fetch(base + p, { headers: { 'x-u': u } }); return { s: r.status, j: await r.json() }; };

test('A-3: 월간 보고서 — 비관리자는 받는 사람 주소 대신 개수 · updatedBy 없음 · 기록 사유의 메일 주소 가림', async () => {
  for (const u of ['op', 'demo']) {
    const r = await get(u, '/tools/san-storage/report');
    assert.equal(r.s, 200, JSON.stringify(r.j));
    const txt = JSON.stringify(r.j);
    assert.ok(!txt.includes('corp.example'), `${u}: 받는 사람 메일 주소가 나갔다 — ${txt.slice(0, 300)}`);
    assert.ok(!txt.includes('boss-admin'), `${u}: 설정한 관리자 계정명이 나갔다`);
    assert.deepEqual(r.j.settings.to, []);
    assert.equal(r.j.settings.toCount, 2);
    assert.equal(r.j.settings.toHidden, true);
    assert.equal(r.j.settings.enabled, true, '나머지 설정은 그대로');
    assert.equal(r.j.history[0].to, 2, '기록의 받는 사람 수는 그대로');
  }
  const a = await get('adm', '/tools/san-storage/report');
  assert.deepEqual(a.j.settings.to, ['storage-lead@corp.example', 'ops@corp.example']);
  assert.equal(a.j.settings.updatedBy, 'boss-admin');
  assert.ok(a.j.history[0].reason.includes('storage-lead@corp.example'));
});

test('A-3: 알림 · 점검 기준 — 비관리자는 updatedBy 없음 · 발송 결과의 메일 주소 가림 · 관리자는 원문', async () => {
  const n = await get('op', '/tools/san-storage/notify');
  assert.equal(n.s, 200, JSON.stringify(n.j));
  const nt = JSON.stringify(n.j);
  assert.ok(!nt.includes('boss-admin'), 'notify updatedBy');
  assert.ok(!nt.includes('ops@corp.example'), `발송 결과의 메일 주소: ${nt.slice(0, 400)}`);
  assert.equal(n.j.settings.enabled, true);
  const c = await get('op', '/tools/san-storage/check-settings');
  assert.equal(c.s, 200);
  assert.ok(!JSON.stringify(c.j).includes('boss-admin'), 'check-settings updatedBy');
  const na = await get('adm', '/tools/san-storage/notify');
  assert.equal(na.j.settings.updatedBy, 'boss-admin');
  assert.ok(JSON.stringify(na.j).includes('ops@corp.example'));
  const ca = await get('adm', '/tools/san-storage/check-settings');
  assert.equal(ca.j.updatedBy, 'boss-admin');
});
