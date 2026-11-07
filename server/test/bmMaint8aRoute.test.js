/**
 * 리눅스 성능 8a단계 — 정비 창 **실제 api 라우터**(security-api.md 8a 항목). 고정하는 규약:
 *   ① 쓰기 operator 이상 · 조회 밖 404 → 쓰기 밖 403(서버 · 법인 · 태그 같은 함수) · 서버 창은 한 법인(법인 간 대상 400)
 *   ② 승인 등급: 법인 전체 · 태그 · 12시간 초과는 설정 소유자 등급(소유자 ∧ 전체 범위) — 소유자 아닌 관리자 · 범위 소유자 403 ·
 *      고치기는 전 · 후 중 하나라도 소유자 등급이면 소유자 등급(법인 창을 서버 창으로 쥐거나 서버 창을 늘려 넓히지 못한다) · 재확인도 같은 등급 ·
 *      억제를 줄이는 동작(지금 끝내기 · 지우기)은 쓰기 범위면 된다
 *   ③ 읽기는 법인이 조회 범위 안인 창만 · rev 409 · 미리보기(다음 5회 · DST 표지) · 추이 음영 구간 · 감사
 * 기준 시각: 실제 시각(창은 실제 시각으로 판정된다 — 정시로 떨어뜨린 기준 사용).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8aroute-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own,sown';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const S = await import('../src/bmusage/maint/schedule.js');
const loc = (ms, tz = 'Asia/Seoul') => S.fmtLocal(tz, ms).replace(' ', 'T');
const T0 = Date.now();

async function setup(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-a2', name: 'bm-a2', host: '127.0.0.2', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b1', name: 'bm-b1', host: '127.0.0.3', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'MTAGA1', vcenterId: 'vcA' },
    { serverId: 's-a2', name: 'bm-a2', serviceTag: 'MTAGA2', vcenterId: 'vcA' },
    { serverId: 's-b1', name: 'bm-b1', serviceTag: 'MTAGB1', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
    rw: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
    adm: { username: 'adm', role: 'admin', scope: null },
    own: { username: 'own', role: 'admin', scope: null },
    sown: { username: 'sown', role: 'admin', scope: { vcenters: ['vcA'] } },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  const call = async (u, method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  return { call };
}
const win = (o = {}) => ({ name: '디스크 교체', reason: '/data1 소진 대응', tz: 'Asia/Seoul', target: { kind: 'server', keys: ['MTAGA1'] },
  schedule: { kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 90 * MIN) }, scopes: { alerts: true, hold: true }, ...o });

test('① ② 실제 라우터 — 권한 · 범위 · 승인 등급 · 고치기 전후 · 줄이는 동작 · 재확인 · rev · 감사', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  const P = '/maintenance';
  assert.equal((await call('viewer', 'POST', P, win())).status, 403, 'viewer 403');
  const c1 = await call('opA', 'POST', P, win());
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal((await call('opA', 'POST', P, win({ target: { kind: 'server', keys: ['MTAGB1'] } }))).status, 404, '조회 밖 404');
  assert.equal((await call('rw', 'POST', P, win({ target: { kind: 'server', keys: ['MTAGB1'] } }))).status, 403, '조회 무제한 + 쓰기 vcA 만 → vcB 403');
  const cross = await call('adm', 'POST', P, win({ target: { kind: 'server', keys: ['MTAGA1', 'MTAGB1'] } }));
  assert.equal(cross.status, 400); assert.equal(cross.body.code, 'cross-corp');
  assert.equal((await call('opA', 'POST', P, win({ target: { kind: 'corp' }, vcenterId: 'vcB' }))).status, 404, '법인 — 조회 밖 404');
  assert.equal((await call('rw', 'POST', P, win({ target: { kind: 'corp' }, vcenterId: 'vcB' }))).status, 403, '법인 — 쓰기 밖 403');
  // 승인 등급 — 법인 전체
  for (const u of ['opA', 'adm', 'sown', 'rw']) {
    const r = await call(u, 'POST', P, win({ target: { kind: 'corp' }, vcenterId: 'vcA' }));
    assert.equal(r.status, 403, `${u} 법인 창`); assert.equal(r.body.code, 'owner-required', u);
  }
  const corp = await call('own', 'POST', P, win({ name: '월간 패치', target: { kind: 'corp' }, vcenterId: 'vcA', schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], time: S.fmtLocal('Asia/Seoul', T0 - 20 * MIN).slice(11), durMin: 120 } }));
  assert.equal(corp.status, 200, JSON.stringify(corp.body));
  // 태그
  assert.equal((await call('opA', 'POST', P, win({ target: { kind: 'tag', tag: 'role:web' }, vcenterId: 'vcA' }))).body.code, 'owner-required');
  const tag = await call('own', 'POST', P, win({ target: { kind: 'tag', tag: 'Role:Web' }, vcenterId: 'vcA' }));
  assert.equal(tag.status, 200, JSON.stringify(tag.body));
  // 12시간 초과(일회 14시간)
  const long = win({ schedule: { kind: 'once', start: loc(T0 + HOUR), end: loc(T0 + 15 * HOUR) } });
  assert.equal((await call('opA', 'POST', P, long)).body.code, 'owner-required');
  assert.equal((await call('own', 'POST', P, long)).status, 200);
  // 고치기 — 서버 창을 14시간으로 늘리면 소유자 등급 · 법인 창(소유자 등급)을 서버 창으로 바꿔 쥐는 것도 소유자 등급
  const e1 = await call('opA', 'PUT', `${P}/${c1.body.id}`, { rev: 1, schedule: long.schedule });
  assert.equal(e1.status, 403); assert.equal(e1.body.code, 'owner-required');
  const e2 = await call('opA', 'PUT', `${P}/${corp.body.id}`, { rev: 1, target: { kind: 'server', keys: ['MTAGA1'] } });
  assert.equal(e2.status, 403, '법인 창 → 서버 창도 소유자 등급(고치기 전이 소유자 등급)');
  const ok1 = await call('opA', 'PUT', `${P}/${c1.body.id}`, { rev: 1, name: '디스크 교체 2' });
  assert.equal(ok1.status, 200); assert.equal(ok1.body.rev, 2);
  assert.equal((await call('opA', 'PUT', `${P}/${c1.body.id}`, { rev: 1, name: 'x' })).status, 409, 'rev 409');
  // 재확인(반복 창 — 억제를 늘린다) = 만들 때 등급
  assert.equal((await call('opA', 'POST', `${P}/${corp.body.id}/confirm`, { rev: 1 })).body.code, 'owner-required');
  assert.equal((await call('own', 'POST', `${P}/${corp.body.id}/confirm`, { rev: 1 })).status, 200);
  // 줄이는 동작 — 쓰기 범위면 된다(법인 창이라도) · 쓰기 밖은 403
  assert.equal((await call('opA', 'POST', `${P}/${corp.body.id}/end`, {})).status, 200, '지금 끝내기');
  assert.equal((await call('opA', 'POST', `${P}/${corp.body.id}/end`, {})).status, 409, '이미 끝남');
  // 읽기 — 범위
  const lA = await call('opA', 'GET', P);
  assert.equal(lA.status, 200);
  assert.ok(lA.body.windows.every((w) => w.vcenterId === 'vcA'));
  const mine = lA.body.windows.find((w) => w.id === c1.body.id);
  assert.equal(mine.status, 'active'); assert.equal(mine.canEdit, true); assert.equal(mine.needOwner, false);
  assert.ok(mine.current.startLocal && mine.remainingMs > 0);
  const corpRow = lA.body.windows.find((w) => w.id === corp.body.id);
  assert.equal(corpRow.canEdit, false, '소유자 등급 창은 운영자에게 고치기 잠김'); assert.equal(corpRow.needOwner, true);
  assert.equal(lA.body.ownerTier, false); assert.equal((await call('own', 'GET', P)).body.ownerTier, true);
  // 지우기 — 운영자 쓰기 범위
  assert.equal((await call('opA', 'DELETE', `${P}/${tag.body.id}`)).status, 200);
  assert.equal((await call('opA', 'DELETE', `${P}/${tag.body.id}`)).status, 404);
  const audit = await import('../src/audit.js');
  const acts = audit.auditEntriesWithAction('bm-perf.maintenance');
  const ops = acts.map((a) => JSON.parse(a.detail).op);
  for (const op of ['create', 'edit', 'confirm', 'end', 'delete']) assert.ok(ops.includes(op), `감사 ${op}`);
  assert.ok(acts.every((a) => JSON.parse(a.detail).reason.length <= 120));
});

test('③ 미리보기(다음 5회 · DST 표지) · 추이 음영 구간 · 형식 400', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  const pv = await call('opA', 'POST', '/maintenance/preview', { tz: 'Asia/Seoul', schedule: { kind: 'monthly', nth: 2, weekday: 6, time: '02:00', durMin: 240 } });
  assert.equal(pv.status, 200); assert.equal(pv.body.next.length, 5);
  assert.ok(pv.body.next.every((o) => o.startLocal.endsWith('02:00') && o.dstShift === false));
  // Warsaw 3월 마지막 일요일 02:30(없는 시각) — 그 발생은 dstShift(03:30)
  const ws = await call('opA', 'POST', '/maintenance/preview', { tz: 'Europe/Warsaw', schedule: { kind: 'monthly', nth: 5, weekday: 0, time: '02:30', durMin: 60 } });
  assert.equal(ws.status, 200);
  const march = ws.body.next.find((o) => o.startLocal.includes('-03-'));
  if (march) { assert.equal(march.dstShift, true); assert.ok(march.startLocal.endsWith('03:30')); }
  assert.equal((await call('opA', 'POST', '/maintenance/preview', { tz: 'Asia/Seoul', schedule: { kind: 'weekly', days: [], time: '02:00', durMin: 60 } })).status, 400);
  assert.equal((await call('viewer', 'POST', '/maintenance/preview', { tz: 'Asia/Seoul', schedule: { kind: 'weekly', days: [1], time: '02:00', durMin: 60 } })).status, 403);
  // 추이 음영 — 그 서버를 덮는 창
  const c = await call('opA', 'POST', '/maintenance', win({ target: { kind: 'server', keys: ['MTAGA2'] }, scopes: { exclude: true } }));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const oc = await call('opA', 'GET', `/maintenance/occurrences?key=MTAGA2&from=${T0 - 6 * HOUR}&to=${T0 + 6 * HOUR}`);
  assert.equal(oc.status, 200);
  assert.ok(oc.body.items.some((x) => x.id === c.body.id && x.scopes.includes('exclude')));
  assert.equal(oc.body.merged.length >= 1, true);
  assert.equal((await call('opA', 'GET', `/maintenance/occurrences?key=MTAGB1&from=${T0 - HOUR}&to=${T0}`)).status, 404, '범위 밖 서버');
});
