/**
 * 리눅스 성능 8a단계 반증 회귀 — 정비 창 **실제 api 라우터**.
 *   ① F5  ‘12시간 초과는 소유자’ 를 같은 서버를 덮는 창들(소유자 창 · 법인 · 태그 창 포함 — 재확인 G1 · G2)의 **합**으로(어느 24시간이든) — 창 2개로 넘기지 못한다 · 재확인 · 고치기도 같은 규칙 ·
 *         ② 보류를 켠 비소유자 창만으로는 하루 12시간 넘게 덮지 못한다(파트 장애가 영영 안 열리는 경로 차단 — 판정기로 7일 검사)
 *   ② F1  서버 창의 대상은 (법인, 키) — 같은 키가 여러 법인에 보이면 법인을 고르게 한다(400) · 고르면 그 법인 서버로 저장
 *   ③ F6  창 200 · 엣지 28 — 목록 · 배포 현황 · 엣지 인출 응답 · 만들기가 이벤트 루프를 길게 막지 않는다(시간 기준 양보 · 상태 한 번)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8afixroute-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const S = await import('../src/bmusage/maint/schedule.js');
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
const NOW = Date.now();
const all7 = [0, 1, 2, 3, 4, 5, 6];

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
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = { opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, adm: { username: 'adm', role: 'admin', scope: null }, own: { username: 'own', role: 'admin', scope: null } };
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
const w = (key, name, schedule, scopes = { alerts: true, hold: true, focus: true }) => ({ name, reason: '상시', tz: 'Asia/Seoul', target: { kind: 'server', keys: [key] }, schedule, scopes });
const P = '/maintenance';

test('① F5 — 12시간 소유자 규칙은 같은 서버를 덮는 창들의 합(창 2개 · 일회 이어 붙이기 · 고치기 · 재확인 · 이름만 고치기는 예외) · ② 보류가 하루 12시간을 넘지 못한다', async (t) => {
  const { call } = await setup(t);
  // 반증 r4 재현 — 반복 12h × 2 = 매일 24시간
  const a = await call('opA', 'POST', P, w('MTAGA1', '오전', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await call('opA', 'POST', P, w('MTAGA1', '오후', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }));
  assert.equal(b.status, 403); assert.equal(b.body.code, 'owner-required', '반증 r4 — 예전 200');
  assert.equal((await call('opA', 'POST', P, w('MTAGA1', '저녁', { kind: 'weekly', days: all7, time: '13:00', durMin: 600 }))).status, 403, '12 + 10 시간');
  assert.equal((await call('opA', 'POST', P, w('MTAGA1', '한 시간', { kind: 'weekly', days: all7, time: '18:00', durMin: 60 }))).status, 403, '12 + 1 시간');
  assert.equal((await call('opA', 'POST', P, w('MTAGA1', '겹침', { kind: 'weekly', days: all7, time: '03:00', durMin: 120 }))).status, 200, '겹치는 창(합집합 12시간 그대로)은 된다');
  // 재확인 — 혼자면 된다(합 12시간)
  assert.equal((await call('opA', 'POST', `${P}/${a.body.id}/confirm`, { rev: a.body.rev })).status, 200);
  // ② — 비소유자 창만으로 7일을 30분 간격 검사: 덮이지 않는 순간이 하루 절반 이상(반증 r4: 0)
  const R = await import('../src/bmusage/maint/runtime.js');
  const J = await R.maintJudge({ now: NOW });
  let uncovered = 0;
  for (let ts = NOW; ts < NOW + 7 * DAY; ts += 30 * MIN) if (!J.stateFor({ key: 'MTAGA1', vcenterId: 'vcA' }, ts).scopes.hold) uncovered += 1;
  assert.ok(uncovered >= 7 * 24, `덮이지 않는 30분 칸 ${uncovered}/336 — 창 끝 뒤 첫 주기에 파트 장애가 열린다`);
  // 소유자는 합을 넘겨 만들 수 있다(소유자 창은 approvedBy — 합에서 빠진다)
  const ob = await call('own', 'POST', P, w('MTAGA1', '오후(소유자)', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }));
  assert.equal(ob.status, 200, JSON.stringify(ob.body));
  // 비소유자가 소유자 창의 일정을 고치면(덮임이 바뀜) 합 규칙 — 24시간이므로 403 · 이름만 고치는 것은 억제를 늘리지 않아 된다(approvedBy 는 기록 — 비워진다)
  const e = await call('opA', 'PUT', `${P}/${ob.body.id}`, { rev: ob.body.rev, schedule: { kind: 'weekly', days: all7, time: '12:00', durMin: 700 } });
  assert.equal(e.status, 403); assert.equal(e.body.code, 'owner-required');
  const rn = await call('opA', 'PUT', `${P}/${ob.body.id}`, { rev: ob.body.rev, name: '오후 바꿈' });
  assert.equal(rn.status, 200, JSON.stringify(rn.body));
  // 일회 12h 두 개 이어 붙이기(다른 서버)
  const s0 = NOW + HOUR;
  assert.equal((await call('opA', 'POST', P, w('MTAGA2', '전반', { kind: 'once', start: loc(s0), end: loc(s0 + 12 * HOUR) }))).status, 200);
  assert.equal((await call('opA', 'POST', P, w('MTAGA2', '후반', { kind: 'once', start: loc(s0 + 12 * HOUR), end: loc(s0 + 24 * HOUR) }))).status, 403);
  const list = await call('opA', 'GET', P);
  assert.equal(list.status, 200);
  const S1 = await import('../src/bmusage/maint/store.js');
  const mine = S1.listWindows().filter((x) => !x.deleted && x.target.keys.includes('MTAGA1') && !x.approvedBy);
  assert.equal(mine.length, 3, 'approvedBy 없는 창 — 오전 · 겹침 · 운영자가 이름을 고친 소유자 창(기록일 뿐 — 합에는 모두 든다)');
  assert.equal(S1.listWindows().find((x) => x.id === ob.body.id).approvedBy, '', '비소유자가 고쳤다 — 소유자 승인 기록을 지운다(합 판정에는 쓰지 않는다)');
  // 재확인도 합 규칙 — 이 규칙 전에 만들어진 비소유자 창 둘(합 24시간)은 비소유자가 재확인하지 못한다(92일마다 혼자 연장 → 파트 장애가 영영 안 열림을 막는다)
  const legacy1 = await S1.addWindow({ ...w('MTAGA2', '옛 오전', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }), vcenterId: 'vcA' }, { by: 'opa', now: NOW });
  await S1.addWindow({ ...w('MTAGA2', '옛 오후', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }), vcenterId: 'vcA' }, { by: 'opa', now: NOW });
  const cf = await call('opA', 'POST', `${P}/${legacy1.id}/confirm`, { rev: legacy1.rev });
  assert.equal(cf.status, 403); assert.equal(cf.body.code, 'owner-required');
  assert.equal((await call('own', 'POST', `${P}/${legacy1.id}/confirm`, { rev: legacy1.rev })).status, 200, '소유자는 재확인한다');
});

test('① F5 재확인 G1 · G2 — 소유자 창도 합에 든다(소유자 12h 옆 운영자 12h 금지) · approvedBy 는 기록일 뿐(소유자가 운영자 창 이름만 고쳐도 합에 남는다)', async (t) => {
  const { call } = await setup(t);
  const S1 = await import('../src/bmusage/maint/store.js');
  for (const x of S1.listWindows().filter((y) => !y.deleted)) await S1.deleteWindow(x.id, { by: 'own', rev: x.rev, now: NOW });
  // G1(반증 r12 ①) — 소유자 매일 00:00 12h + 운영자 매일 12:00 12h → 예전 200(24시간 상시 · ② 보류 포함)
  const A = await call('own', 'POST', P, w('MTAGA2', 'A 소유자', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }));
  assert.equal(A.status, 200); assert.equal(S1.getWindow(A.body.id).approvedBy, 'own', 'approvedBy 는 기록으로 남는다');
  const B = await call('opA', 'POST', P, w('MTAGA2', 'B 운영자', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }));
  assert.equal(B.status, 403); assert.equal(B.body.code, 'owner-required');
  assert.equal((await call('opA', 'POST', P, w('MTAGA2', '겹침', { kind: 'weekly', days: all7, time: '03:00', durMin: 120 }))).status, 200, '소유자 창 안에 겹치는 창(합집합 12시간 그대로)은 된다');
  const R = await import('../src/bmusage/maint/runtime.js');
  const J = await R.maintJudge({ now: NOW });
  let uncovered = 0;
  for (let ts = NOW; ts < NOW + 7 * DAY; ts += 30 * MIN) if (!J.stateFor({ key: 'MTAGA2', vcenterId: 'vcA' }, ts).scopes.hold) uncovered += 1;
  assert.ok(uncovered >= 7 * 24, `덮이지 않는 30분 칸 ${uncovered}/336(반증 r12: 0)`);
  // G1 재확인 — 이 규칙 전에 만들어진 운영자 12:00 12h(소유자 창 옆)는 운영자 혼자 재확인하지 못한다
  const legacyB = await S1.addWindow({ ...w('MTAGA2', '옛 운영자 오후', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }), vcenterId: 'vcA' }, { by: 'opa', now: NOW });
  const cf = await call('opA', 'POST', `${P}/${legacyB.id}/confirm`, { rev: legacyB.rev });
  assert.equal(cf.status, 403, '반증 r12 ② — 예전 200'); assert.equal(cf.body.code, 'owner-required');
  for (const x of S1.listWindows().filter((y) => !y.deleted)) await S1.deleteWindow(x.id, { by: 'own', rev: x.rev, now: NOW });
  // G2(반증 r12 ③) — 소유자가 운영자 창 이름만 고쳐 approvedBy 가 붙어도 그 창은 합에 남는다
  const B1 = await call('opA', 'POST', P, w('MTAGA2', 'B1 운영자', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }));
  assert.equal(B1.status, 200);
  const rn = await call('own', 'PUT', `${P}/${B1.body.id}`, { rev: B1.body.rev, name: 'B1 오타 수정' });
  assert.equal(rn.status, 200); assert.equal(S1.getWindow(B1.body.id).approvedBy, 'own');
  const B2 = await call('opA', 'POST', P, w('MTAGA2', 'B2 운영자', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }));
  assert.equal(B2.status, 403, '예전: B1 이 합에서 빠져 200');
  // 소유자 자신의 저장은 그대로 허용
  assert.equal((await call('own', 'POST', P, w('MTAGA2', '소유자 오후', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }))).status, 200);
});

test('② F1 — 같은 키가 여러 법인에 보이면 법인을 고르게 한다(400) · 고르면 그 법인 서버로 저장 · 범위 계정은 보이는 법인만', async (t) => {
  const { call } = await setup(t);
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('Edge-B', { ok: true, snap: { targets: [{ key: 'MTAGA1', name: 'b-dup', serviceTag: 'MTAGA1', vcenterId: 'vcB' }], maintVer: 1 } });
  const body = w('MTAGA1', '패치', { kind: 'once', start: loc(NOW + HOUR), end: loc(NOW + 2 * HOUR) }, { alerts: true });
  const amb = await call('adm', 'POST', P, body);
  assert.equal(amb.status, 400); assert.equal(amb.body.code, 'ambiguous-key');
  const vb = await call('adm', 'POST', P, { ...body, vcenterId: 'vcB' });
  assert.equal(vb.status, 200, JSON.stringify(vb.body));
  const ST = await import('../src/bmusage/maint/store.js');
  assert.equal(ST.getWindow(vb.body.id).vcenterId, 'vcB');
  const va = await call('opA', 'POST', P, body);   // 범위 계정 — vcA 만 보인다(모호하지 않다)
  assert.equal(va.status, 200, JSON.stringify(va.body)); assert.equal(ST.getWindow(va.body.id).vcenterId, 'vcA');
  assert.equal((await call('opA', 'POST', P, { ...body, vcenterId: 'vcB' })).status, 404, '조회 밖 법인은 404');
  // 음영 — 그 법인 서버의 창만(같은 키 다른 법인 창이 섞이지 않는다)
  const occ = await call('opA', 'GET', `${P}/occurrences?key=MTAGA1&from=${NOW}&to=${NOW + 3 * HOUR}`);
  assert.equal(occ.status, 200);
  const ids = new Set(occ.body.merged.flatMap((x) => x.ids));
  assert.ok(ids.has(va.body.id)); assert.ok(!ids.has(vb.body.id), '다른 법인(같은 키) 창은 음영에 없다');
  assert.ok([...ids].every((id) => ST.getWindow(id).vcenterId === 'vcA'));
  E._resetForTest();
});

test('③ F6 — 창 200 · 엣지 28: 목록 · 배포 현황 · 엣지 인출 응답 · 만들기가 루프를 길게 막지 않는다', async () => {
  const ST = await import('../src/bmusage/maint/store.js');
  const DP = await import('../src/bmusage/maint/deploy.js');
  const E = await import('../src/central/bmUsageEdgePull.js');
  const { bmMaintList } = await import('../src/routes/api/bmMaint.js');
  for (const f of ['maintenance-windows.json']) { try { fs.unlinkSync(path.join(DIR, f)); } catch { /* */ } }
  ST._resetMaintStoreForTest();
  const vcs = Array.from({ length: 28 }, (_, i) => `vc${i}`);
  for (let i = 0; i < 200; i += 1) {
    await ST.addWindow({ name: `w${i}`, reason: 'r', target: { kind: 'corp' }, vcenterId: vcs[i % 28], tz: i % 3 ? 'Asia/Seoul' : 'Europe/Warsaw',
      schedule: { kind: 'weekly', days: all7, time: '02:00', durMin: 120 }, scopes: { alerts: true } }, { by: 'o', now: NOW });
  }
  for (let e = 0; e < 28; e += 1) E.putEdgeBmUsage(`Edge-${e}`, { ok: true, snap: { targets: Array.from({ length: 30 }, (_, k) => ({ key: `E${e}-${k}`, vcenterId: vcs[e % 28] })), maintVer: 1 } });
  const gapOf = async (fn) => {
    let maxGap = 0; let last = performance.now();
    const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 2);
    await new Promise((r) => setTimeout(r, 10)); last = performance.now(); maxGap = 0;
    const t0 = performance.now(); const r = await fn(); const ms = performance.now() - t0;
    await new Promise((r2) => setTimeout(r2, 10)); clearInterval(iv);
    return { r, ms, maxGap };
  };
  const req = { user: { username: 'adm', role: 'admin', scope: null }, query: {} };
  let yields = 0;
  const { createYielder } = await import('../src/util/timeSlice.js');
  const counting = () => { const y = createYielder(15); return async () => { yields += 1; return y(); }; };
  const list = await gapOf(() => bmMaintList(req, { vcenters: vcs.map((id) => ({ id })) }, { currentTargets: async () => ({ targets: [] }), ownerTier: async () => true, minEdgeVersion: async () => '0', yielder: counting }));
  assert.ok(yields >= 200, `목록 행마다 양보 기회(${yields})`);
  assert.equal(list.r.windows.length, 200); assert.equal(list.r.deploy.edges.length, 28);
  const pull = await gapOf(() => DP.deployFor('Edge-0', { verified: true, now: NOW }));
  assert.ok(pull.r.windows.length > 0);
  const add = await gapOf(() => ST.addWindow({ name: 'x', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vc0', tz: 'Asia/Seoul', schedule: { kind: 'weekly', days: [1], time: '02:00', durMin: 60 }, scopes: { alerts: true } }, { by: 'o', now: NOW }));
  const note = `목록 ${Math.round(list.ms)}ms(최장 정지 ${Math.round(list.maxGap)}ms) · 인출 ${Math.round(pull.ms)}ms(${Math.round(pull.maxGap)}ms) · 만들기 ${Math.round(add.ms)}ms(${Math.round(add.maxGap)}ms)`;
  // 반증 실측(창 200 · 엣지 28): 목록 37,716ms 한 덩어리 · 인출 1,313ms · 만들기 1,262ms. 시험 상한은 CI 변동을 넉넉히 둔다(실측은 보고서).
  assert.ok(list.maxGap < 150, note); assert.ok(pull.maxGap < 150, note); assert.ok(add.maxGap < 150, note);
  // 양보가 실제로 나눈다 — 최장 정지가 전체의 절반 아래(기계 속도와 무관한 비율)
  assert.ok(list.maxGap < Math.max(60, list.ms * 0.5), note);
  console.log(`[F6] ${note}`);
});
