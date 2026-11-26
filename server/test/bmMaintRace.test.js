/**
 * bmMaintRace.test.js — 정비 창 쓰기의 동시 요청(2026-11-26 시험 위생 점검 3회차가 코드에서 본 것 · 이 시험으로 재현).
 *
 * 합 규칙 판정(ownerGate — coverNeedsOwnerAsync 가 단계 사이에 양보한다)과 저장 사이에 창끼리 묶는 잠금이 없어, 운영자 요청 두 개가 판정 도중
 * 서로를 보지 못하고 **둘 다 통과**했다 — 같은 서버에 매일 1시간 창이 있을 때 6시간 창 둘(00:00 · 06:00)을 동시에 만들면 각자는 7시간이라 통과하지만
 * 합치면 13시간인데 소유자 없이 200 · 200(수정 전 코드에서 재현). 이제 억제를 늘리는 쓰기(만들기 · 고치기 · 재확인)는 한 줄로 선다(`bmMaint.js gateSerial`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmrace-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const all7 = [0, 1, 2, 3, 4, 5, 6];
const HOUR = 3_600_000; const DAY = 86_400_000;
const ST = await import('../src/bmusage/maint/store.js');
const R = await import('../src/bmusage/maint/runtime.js');
function resetAll() {
  ST._resetMaintStoreForTest(); R._resetMaintRuntimeForTest();
  for (const f of ['maintenance-windows.json', 'maintenance-windows-deployed.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
}

async function setup(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-a2', name: 'bm-a2', host: '127.0.0.2', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'MTAGA1', vcenterId: 'vcA' },
    { serverId: 's-a2', name: 'bm-a2', serviceTag: 'MTAGA2', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }] });
  const express = (await import('express')).default;
  // 실제 정비 창 라우터 — 양보 함수만 '매 단계 양보' 로 바꿔 두 요청이 판정 도중에 서로 끼어들게 한다(운영 기본은 15ms 마다 — 큰 창 목록이면 같은 일이 생긴다).
  const { registerBmMaint } = await import('../src/routes/api/bmMaint.js');
  const api = express.Router();
  registerBmMaint(api, { yielder: () => async () => { await new Promise((r) => { setImmediate(r); }); return true; } });
  const USERS = { opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, own: { username: 'own', role: 'admin', scope: null } };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage/maintenance`;
  const call = async (u, method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  return { call };
}
const srvWin = (key, name, schedule) => ({ name, reason: '정비', tz: 'Asia/Seoul', target: { kind: 'server', keys: [key] }, vcenterId: 'vcA', schedule, scopes: { alerts: true, hold: true, focus: true } });

test('동시에 만든 운영자 창 둘(각자는 12시간 이하 · 합치면 13시간)은 하나만 통과한다 — 판정 도중 끼어들어 둘 다 200 이던 것', async (t) => {
  resetAll();
  const { call } = await setup(t);
  // 같은 서버에 이미 있는 창(소유자 · 매일 23:00 1시간) — 동료가 있어야 합 규칙 계산이 단계마다 양보한다(동료가 없으면 바로 끝나 끼어들 틈이 없다)
  const base = await call('own', 'POST', '', srvWin('MTAGA1', '기존', { kind: 'weekly', days: all7, time: '23:00', durMin: 60 }));
  assert.equal(base.status, 200, JSON.stringify(base.body));
  // 각자: 기존 + 00:00 6시간 = 7시간 · 기존 + 06:00 6시간 = 7시간(통과) — 둘 다: 23:00 ~ 12:00 = 13시간(소유자 필요)
  const am = srvWin('MTAGA1', '새벽', { kind: 'weekly', days: all7, time: '00:00', durMin: 360 });
  const pm = srvWin('MTAGA1', '오전', { kind: 'weekly', days: all7, time: '06:00', durMin: 360 });
  const [r1, r2] = await Promise.all([call('opA', 'POST', '', am), call('opA', 'POST', '', pm)]);
  const st = [r1.status, r2.status].sort();
  assert.deepEqual(st, [200, 403], `하나는 소유자 필요여야 한다: ${JSON.stringify([r1.body, r2.body])}`);
  const denied = r1.status === 403 ? r1 : r2;
  assert.equal(denied.body.code, 'owner-required');
  ST._resetMaintStoreForTest();
  assert.equal(ST.listWindows().filter((w) => !w.deleted).length, 2, '저장된 창은 기존 + 하나');
});

test('한 줄로 서도 서로 무관한 쓰기는 모두 통과한다(다른 서버 · 차례대로 끝난다)', async (t) => {
  resetAll();
  const { call } = await setup(t);
  const a = srvWin('MTAGA1', '가', { kind: 'weekly', days: all7, time: '00:00', durMin: 600 });
  const b = srvWin('MTAGA2', '나', { kind: 'weekly', days: all7, time: '00:00', durMin: 600 });
  const rs = await Promise.all([call('opA', 'POST', '', a), call('opA', 'POST', '', b), call('opA', 'POST', '', { ...a, name: '가2', schedule: { kind: 'weekly', days: all7, time: '12:00', durMin: 60 } })]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], JSON.stringify(rs.map((r) => r.body)));
});

test('줄 안에서 거절(403)돼도 줄이 막히지 않는다 · 줄 앞 실패(400)도 그대로', async (t) => {
  resetAll();
  const { call } = await setup(t);
  const base = await call('own', 'POST', '', srvWin('MTAGA1', '기존', { kind: 'weekly', days: all7, time: '23:00', durMin: 60 }));
  assert.equal(base.status, 200, JSON.stringify(base.body));
  // 창 하나는 12시간(반복 상한 안 · 줄 앞 검사 통과) — 기존과 합치면 13시간이라 줄 안의 합 규칙에서 403
  const long = srvWin('MTAGA1', '긺', { kind: 'weekly', days: all7, time: '00:00', durMin: 12 * 60 });
  const ok = srvWin('MTAGA2', '맞음', { kind: 'weekly', days: all7, time: '00:00', durMin: 60 });
  const bad = { ...ok, name: '틀림', tz: 'Mars/Base' };
  const [r1, r2, r3] = await Promise.all([call('opA', 'POST', '', long), call('opA', 'POST', '', ok), call('opA', 'POST', '', bad)]);
  assert.deepEqual([r1.status, r2.status, r3.status], [403, 200, 400], JSON.stringify([r1.body, r2.body, r3.body]));
  const r4 = await call('opA', 'POST', '', { ...ok, name: '맞음2', schedule: { kind: 'weekly', days: all7, time: '02:00', durMin: 60 } });
  assert.equal(r4.status, 200, JSON.stringify(r4.body));
});

test('고치기도 같은 줄 — 동시에 늘리는 둘 중 하나만 통과한다(재확인은 같은 gateSerial 을 지난다)', async (t) => {
  resetAll();
  const { call } = await setup(t);
  // 같은 서버에 운영자 창 셋(23:00 1시간 · 00:00 1시간 · 06:00 1시간 = 3시간) — 두 창을 동시에 6시간으로 늘리면 각자 8시간 · 합치면 13시간
  const mk = async (name, time) => { const r = await call('opA', 'POST', '', srvWin('MTAGA1', name, { kind: 'weekly', days: all7, time, durMin: 60 })); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  await mk('기존', '23:00'); const a = await mk('새벽', '00:00'); const b = await mk('오전', '06:00');
  const [e1, e2] = await Promise.all([
    call('opA', 'PUT', `/${a.id}`, { rev: a.rev, schedule: { kind: 'weekly', days: all7, time: '00:00', durMin: 360 } }),
    call('opA', 'PUT', `/${b.id}`, { rev: b.rev, schedule: { kind: 'weekly', days: all7, time: '06:00', durMin: 360 } }),
  ]);
  assert.deepEqual([e1.status, e2.status].sort(), [200, 403], JSON.stringify([e1.body, e2.body]));
});

test('재확인도 같은 줄 — 오래전 만료된 이어 붙은 12시간 창 둘을 동시에 재확인하면 하나만 통과한다(4회차 결함 2 — 재확인 경로를 지키는 시험이 없었다)', async (t) => {
  resetAll();
  const { call } = await setup(t);
  // 100일 전 확인 → 8일 전 만료(지난 발생은 합 규칙의 하루 창 밖) — 하나만 되살리면 12시간 · 둘 다면 24시간 상시 억제
  const mk = (name, time) => ST.addWindow(srvWin('MTAGA1', name, { kind: 'weekly', days: all7, time, durMin: 720 }), { by: 'opa', now: Date.now() - 100 * DAY });
  const A = await mk('가', '00:00'); const B = await mk('나', '12:00');
  const [ra, rb] = await Promise.all([call('opA', 'POST', `/${A.id}/confirm`, { rev: A.rev }), call('opA', 'POST', `/${B.id}/confirm`, { rev: B.rev })]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 403], JSON.stringify([ra.body, rb.body]));
  assert.equal((ra.status === 403 ? ra : rb).body.code, 'owner-required');
});

test('판정에 쓴 판으로만 저장한다 — 재확인과 함께 보낸 고치기가 다음 rev 를 미리 넣어도 409(4회차 결함 1 — 재확인 전 수명으로 판정 · 92일 수명에 저장되던 것)', async (t) => {
  resetAll();
  const { call } = await setup(t);
  const now = Date.now();
  const kstDay0 = Math.floor((now + 9 * HOUR) / DAY) * DAY - 9 * HOUR;
  const loc = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 16);   // KST 벽시계 'YYYY-MM-DDTHH:MM'
  // 동료 P — 소유자 일회 창(20일 뒤 KST 00:00~12:00) · 운영자 W — 매일 06:00 1시간(P 안쪽) · 85일 전 확인(7일 뒤 만료)
  const P = await ST.addWindow({ ...srvWin('MTAGA1', 'P', null), schedule: { kind: 'once', start: loc(kstDay0 + 20 * DAY), end: loc(kstDay0 + 20 * DAY + 12 * HOUR) } }, { by: 'own', approvedBy: 'own', now });
  assert.ok(P.id);
  const W = await ST.addWindow(srvWin('MTAGA1', 'W', { kind: 'weekly', days: all7, time: '06:00', durMin: 60 }), { by: 'opa', now: now - 85 * DAY });
  const longer = { kind: 'weekly', days: all7, time: '12:00', durMin: 720 };   // P 와 이어 붙음 — 재확인 뒤 수명이면 20일 뒤 24시간(소유자 필요)
  const pc = call('opA', 'POST', `/${W.id}/confirm`, { rev: W.rev });
  await new Promise((r) => { setTimeout(r, 5); });   // 재확인이 먼저 줄에 서게
  const pe = call('opA', 'PUT', `/${W.id}`, { rev: W.rev + 1, schedule: longer });   // 다음 판을 미리 넣는다
  const [rc, re] = await Promise.all([pc, pe]);
  assert.equal(rc.status, 200, JSON.stringify(rc.body));
  assert.equal(re.status, 409, `예전: 200(재확인 전 수명으로 판정) — ${JSON.stringify(re.body)}`);
  assert.equal(re.body.code, 'rev-changed');
  ST._resetMaintStoreForTest();
  const w = ST.getWindow(W.id);
  assert.equal(w.schedule.time, '06:00'); assert.equal(w.schedule.durMin, 60);
  // 차례대로(재확인 뒤 판으로) 고치면 지금 수명으로 판정해 403
  const re2 = await call('opA', 'PUT', `/${W.id}`, { rev: rc.body.rev, schedule: longer });
  assert.equal(re2.status, 403, JSON.stringify(re2.body)); assert.equal(re2.body.code, 'owner-required');
});
