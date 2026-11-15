/**
 * 베어메탈 사용률 점검 반복 3회차(기준판 5c6d87a6b) — 알림 · 정비 창 · 전력 확정 결함을 재현한 입력으로 고정한다(실제 api 라우터 · 실제 저장소 · 실제 판정기).
 *   D1 이름 · 사유만 고치기는 재확인이 아니다 — 운영자가 만료된 12h 창 둘(00:00 · 12:00)의 이름만 PUT 해 24시간 상시 억제(336/336 칸)를 되살리던 경로 ·
 *      목록 canConfirm = 재확인 라우트와 같은 판정(합 규칙 포함 — 예전: 버튼은 열리고 누르면 403)
 *   D3 ‘창 끝 뒤 억제’ 점검은 창마다 그 창의 시작 · 끝으로 — 12h 반복 + 10h 일회가 겹치면 거짓 over-cap(예전 leak 1) · 진짜 끝 뒤 억제는 그대로 잡는다(호출처 3곳 실제 경로)
 *   I1 중앙 정제가 엣지 발송 기록의 모르는 규칙 id 를 'use' 로 바꾸던 것 — 'unknown' · 이슈 없음
 *   D2(엣지 history 배포)는 두 문맥 시험이라 bmUsageLoop3Edge.test.js.
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 T0(창 파일은 실제 시각으로 판정된다 — common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmloop3-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
const all7 = [0, 1, 2, 3, 4, 5, 6];
const S = await import('../src/bmusage/maint/schedule.js');
const ST = await import('../src/bmusage/maint/store.js');
const R = await import('../src/bmusage/maint/runtime.js');
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
const hhmm = (ms) => S.fmtLocal('Asia/Seoul', ms).slice(11, 16);
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
  const { api } = await import('../src/routes/api.js');
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
const srvWin = (key, name, schedule, scopes = { alerts: true, hold: true, focus: true }) => ({ name, reason: '상시', tz: 'Asia/Seoul', target: { kind: 'server', keys: [key] }, vcenterId: 'vcA', schedule, scopes });
/** 앞으로 7일 30분 칸 중 ② 보류가 덮인 칸 수(실제 판정기 — 저장소를 다시 읽는다). */
async function coveredSlots(key) {
  ST._resetMaintStoreForTest();
  const now = Date.now();
  const J = await R.maintJudge({ now });
  let n = 0;
  for (let ts = now; ts < now + 7 * DAY; ts += 30 * MIN) if (J.stateFor({ key, vcenterId: 'vcA' }, ts).scopes.hold) n += 1;
  return n;
}

test('D1 — 이름 · 사유만 고치기는 재확인이 아니다(만료 그대로 · 덮인 칸 0) · 목록 canConfirm = 재확인 라우트 판정', async (t) => {
  resetAll();
  const { call } = await setup(t);
  // 규칙 전에 만든 운영자 창 둘(매일 00:00 · 12:00 각 12시간 — 93일 전 확인 → 둘 다 만료)
  const A = await ST.addWindow(srvWin('MTAGA1', '옛 오전', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }), { by: 'opa', now: T0 - 93 * DAY });
  const B = await ST.addWindow(srvWin('MTAGA1', '옛 오후', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }), { by: 'opa', now: T0 - 93 * DAY });
  assert.equal(await coveredSlots('MTAGA1'), 0, '둘 다 만료 — 억제 없음');
  // 목록 — 재확인 버튼은 재확인 라우트와 같은 판정(합 규칙: 두 창 합 24시간)
  const l0 = await call('opA', 'GET', '');
  assert.equal(l0.status, 200);
  const row = (l, id) => l.body.windows.find((w) => w.id === id);
  for (const id of [A.id, B.id]) { assert.equal(row(l0, id).status, 'expired'); assert.equal(row(l0, id).canConfirm, false, '재현 r3 — 예전 true(누르면 403)'); assert.equal(row(l0, id).confirmOwner, 'combined'); }
  const cf = await call('opA', 'POST', `/${A.id}/confirm`, { rev: A.rev });
  assert.equal(cf.status, 403); assert.equal(cf.body.code, 'owner-required');
  // 재현 — 운영자 이름만 PUT · 사유만 PUT → 200(고치기는 된다) · 그러나 재확인이 아니다
  const e1 = await call('opA', 'PUT', `/${A.id}`, { rev: A.rev, name: '옛 오전(이름 고침)' });
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  const e2 = await call('opA', 'PUT', `/${B.id}`, { rev: B.rev, reason: '사유 고침' });
  assert.equal(e2.status, 200, JSON.stringify(e2.body));
  ST._resetMaintStoreForTest();
  assert.equal(ST.getWindow(A.id).confirmedAt, T0 - 93 * DAY, 'confirmedAt 그대로(예전: 지금으로 — 92일 연장)');
  assert.equal(ST.getWindow(B.id).confirmedAt, T0 - 93 * DAY);
  assert.equal(await coveredSlots('MTAGA1'), 0, '재현 r3 — 예전 336/336(24시간 상시 억제)');
  const l1 = await call('opA', 'GET', '');
  assert.deepEqual([row(l1, A.id).status, row(l1, B.id).status], ['expired', 'expired'], '만료 그대로');
  // 소유자는 재확인할 수 있다(소유자 등급은 합을 세지 않는다 — 라우트 그대로)
  const lo = await call('own', 'GET', '');
  assert.equal(row(lo, A.id).canConfirm, true);
  assert.equal((await call('own', 'POST', `/${A.id}/confirm`, { rev: ST.getWindow(A.id).rev })).status, 200);
  assert.equal(await coveredSlots('MTAGA1'), 7 * 24, '소유자가 A 만 재확인 — 하루 12시간');
  // A 가 살아난 뒤 B — 운영자 목록 canConfirm false · 재확인 403(같은 판정) · 이름만 고쳐도 살아나지 않는다
  const l2 = await call('opA', 'GET', '');
  assert.equal(row(l2, B.id).canConfirm, false); assert.equal(row(l2, B.id).confirmOwner, 'combined');
  assert.equal((await call('opA', 'POST', `/${B.id}/confirm`, { rev: ST.getWindow(B.id).rev })).status, 403);
  assert.equal((await call('opA', 'PUT', `/${B.id}`, { rev: ST.getWindow(B.id).rev, name: '옛 오후(또 고침)' })).status, 200);
  assert.equal(await coveredSlots('MTAGA1'), 7 * 24, 'B 는 만료 그대로 — 24시간이 되지 않는다');
  // 혼자인 만료 창은 운영자가 재확인한다 — 목록 canConfirm true = 라우트 200(같은 판정의 반대쪽)
  const Cw = await ST.addWindow(srvWin('MTAGA2', '혼자', { kind: 'weekly', days: all7, time: '02:00', durMin: 240 }), { by: 'opa', now: T0 - 100 * DAY });
  const l3 = await call('opA', 'GET', '');
  assert.equal(row(l3, Cw.id).canConfirm, true); assert.equal(row(l3, Cw.id).confirmOwner, undefined);
  assert.equal((await call('opA', 'POST', `/${Cw.id}/confirm`, { rev: Cw.rev })).status, 200);
  // 일회 창은 재확인이 없다(그대로)
  const once = await ST.addWindow(srvWin('MTAGA2', '일회', { kind: 'once', start: loc(T0 + 2 * DAY), end: loc(T0 + 2 * DAY + HOUR) }), { by: 'opa', now: T0 });
  assert.equal(row(await call('opA', 'GET', ''), once.id).canConfirm, false);
});

test('D1 · R1 · R2 — 합 규칙(coverNeedsOwner)의 빠른 길 · 메모 · 같은 묶음 건너뛰기 · 비동기 단계는 정확한 계산과 같은 답(무작위 · DST 둘레 · 법인 창 · 여러 키)', async () => {
  // 시드 고정 난수(재현 가능) — 창 꼴 · 대상(서버 키 묶음 · 법인) · 시간대 · 요일 · 길이 · 재확인을 섞는다. 정확 경로(exact)는 기준점마다 다시 세는 예전 계산 + R2 후보.
  let seed = 20261115;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const TZS = ['Asia/Seoul', 'Europe/Warsaw', 'America/New_York', 'Australia/Lord_Howe', 'Antarctica/Troll'];
  const NOWS = [T0, Date.UTC(2027, 2, 24, 13), Date.UTC(2027, 9, 27, 22), Date.UTC(2027, 2, 12, 3), Date.UTC(2027, 3, 1, 9)];
  const KEYSETS = [['P1'], ['P2'], ['P1', 'P2'], ['P1', 'P2', 'P3'], ['P3']];
  const mk = (i, now) => {
    const tz = pick(TZS); const kind = pick(['weekly', 'weekly', 'weekly', 'monthly', 'once']);
    const time = `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${pick(['00', '30'])}`;
    let schedule;
    if (kind === 'once') { const st = now + Math.floor((rnd() * 40 - 2) * 24) * HOUR; const len = (1 + Math.floor(rnd() * 24)) * HOUR; schedule = { kind, start: S.fmtLocal(tz, st).replace(' ', 'T'), end: S.fmtLocal(tz, st + len).replace(' ', 'T') }; }
    else if (kind === 'weekly') schedule = { kind, days: all7.filter(() => rnd() < 0.5).concat([Math.floor(rnd() * 7)]), time, durMin: 30 * (1 + Math.floor(rnd() * 24)) };
    else schedule = { kind, nth: 1 + Math.floor(rnd() * 5), weekday: Math.floor(rnd() * 7), time, durMin: 30 * (1 + Math.floor(rnd() * 24)) };
    const target = rnd() < 0.15 ? { kind: 'corp' } : { kind: 'server', keys: pick(KEYSETS) };
    return ST.normalizeWindow({ id: `mw-prop${String(i).padStart(6, '0')}`, name: 'p', reason: 'p', tz, vcenterId: 'vcA', target, schedule, scopes: { hold: true },
      at: now - 10 * DAY, confirmedAt: now - Math.floor(rnd() * 100) * DAY });
  };
  let n = 0; let trues = 0;
  for (let c = 0; c < 150; c += 1) {
    const now = NOWS[c % NOWS.length];
    const group = Array.from({ length: 2 + Math.floor(rnd() * 5) }, (_, i) => mk(c * 10 + i, now)).filter(Boolean);
    const memo = ST.coverMemo(now);   // 목록처럼 한 요청 메모를 후보끼리 나눈다
    for (const w of group.filter((x) => x.target.kind === 'server').slice(0, 3)) {
      const cand = { ...w, confirmedAt: now };
      const exact = ST.coverNeedsOwner(cand, group, now, { exact: true });
      const tag = `사례 ${c}: ${JSON.stringify(group.map((x) => [x.tz, x.target, x.schedule]))}`;
      assert.equal(ST.coverNeedsOwner(cand, group, now), exact, `빠른 길 · ${tag}`);
      assert.equal(ST.coverNeedsOwner(cand, group, now, { memo }), exact, `메모 · ${tag}`);
      assert.equal(await ST.coverNeedsOwnerAsync(cand, group, now, { memo, yieldFn: async () => {} }), exact, `비동기 · ${tag}`);
      n += 1; if (exact) trues += 1;
    }
  }
  assert.ok(n >= 200 && trues >= 20 && n - trues >= 20, `참 · 거짓 둘 다 충분히(${trues}/${n})`);
});

test('R2(3회차 재확인) — 이미 넓게 덮인 구간 한가운데의 드문 창도 합 규칙이 본다(실제 라우터 · 예전 200)', async (t) => {
  resetAll();
  const { call } = await setup(t);
  // 소유자가 매일 00:00 12h · 12:00 12h 로 상시 덮은 서버
  assert.equal((await call('own', 'POST', '', srvWin('MTAGA2', '소유자 오전', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }))).status, 200);
  assert.equal((await call('own', 'POST', '', srvWin('MTAGA2', '소유자 오후', { kind: 'weekly', days: all7, time: '12:00', durMin: 720 }))).status, 200);
  for (const time of ['00:00', '12:00']) {
    const r = await call('opA', 'POST', '', srvWin('MTAGA2', `수요일 ${time}`, { kind: 'weekly', days: [3], time, durMin: 720 }));
    assert.equal(r.status, 403, `재현 r3 재확인 — 예전 200(수요일 ${time} 12h)`); assert.equal(r.body.code, 'owner-required');
  }
  assert.equal((await call('opA', 'POST', '', srvWin('MTAGA2', '매일 12h', { kind: 'weekly', days: all7, time: '00:00', durMin: 720 }))).status, 403, '대조 — 예전에도 403');
  // 직접 — 후보 매월 마지막 월 10h · 법인 매주 12h 창들로 후보 둘레가 하루 넘게 이어져 덮임
  const now = T0;
  const corp = Array.from({ length: 14 }, (_, i) => ST.normalizeWindow({ id: `mw-corp${String(i).padStart(5, '0')}`, name: 'c', reason: 'r', tz: 'Asia/Seoul', vcenterId: 'vcA', target: { kind: 'corp' },
    schedule: { kind: 'weekly', days: [i % 7], time: i < 7 ? '00:00' : '12:00', durMin: 720 }, scopes: { hold: true }, at: now, confirmedAt: now }));
  const cand = ST.normalizeWindow({ id: 'mw-candmon01', name: 'm', reason: 'r', tz: 'Asia/Seoul', vcenterId: 'vcA', target: { kind: 'server', keys: ['Z1'] },
    schedule: { kind: 'monthly', nth: 5, weekday: 1, time: '06:00', durMin: 600 }, scopes: { hold: true }, at: now, confirmedAt: now });
  assert.equal(ST.coverNeedsOwner(cand, corp, now, { exact: true }), true, '정확 경로(예전 false)');
  assert.equal(ST.coverNeedsOwner(cand, corp, now), true, '빠른 경로(예전 false)');
});

test('R1(3회차 재확인) — 비소유자 정비 창 목록 비용: 소유자 목록 대비 비율 · 루프 정지 · 답은 정확 경로와 같다(창 200 — 법인 5 · 서버 20대 창 50 · 서버 1대 창 145)', async () => {
  resetAll();
  const now0 = Date.now();
  const hh = (h) => `${String(h % 24).padStart(2, '0')}:00`;
  const keys20 = Array.from({ length: 20 }, (_, i) => `K${i + 1}`);
  const items = [];
  const put = (i, name, target, schedule, ageDays) => items.push({ id: `mw-r1${String(i).padStart(6, '0')}`, name, reason: 'r', tz: 'Asia/Seoul', vcenterId: 'vcA', target, schedule,
    scopes: { alerts: true, hold: true }, by: 'op', at: now0 - ageDays * DAY, rev: 1, approvedBy: '', confirmedAt: now0 - ageDays * DAY, edits: [] });
  for (let i = 0; i < 5; i += 1) put(i, `corp${i}`, { kind: 'corp' }, { kind: 'monthly', nth: i + 1, weekday: i % 7, time: hh(i * 3), durMin: 240 }, i * 10);
  for (let i = 0; i < 50; i += 1) put(100 + i, `s20-${i}`, { kind: 'server', keys: keys20, names: keys20 }, { kind: 'weekly', days: all7, time: hh(i), durMin: 120 }, (i % 9) * 9);
  for (let i = 0; i < 145; i += 1) put(200 + i, `s1-${i}`, { kind: 'server', keys: ['K1'], names: ['K1'] }, { kind: 'weekly', days: [i % 7], time: hh(i), durMin: 60 }, (i % 9) * 9);
  fs.writeFileSync(path.join(DIR, 'maintenance-windows.json'), JSON.stringify({ v: 1, seq: 400, items }));
  ST._resetMaintStoreForTest();
  const { bmMaintList } = await import('../src/routes/api/bmMaint.js');
  const { createYielder } = await import('../src/util/timeSlice.js');
  let yields = 0;
  const run = async (owner) => {
    yields = 0;
    let maxGap = 0; let last = performance.now();
    const iv = setInterval(() => { const x = performance.now(); maxGap = Math.max(maxGap, x - last); last = x; }, 2);
    await new Promise((r) => setTimeout(r, 10)); last = performance.now(); maxGap = 0;
    const t0 = performance.now();
    const r = await bmMaintList({ user: { username: 'opa', role: 'operator', scope: null }, query: {} }, { vcenters: [{ id: 'vcA' }] },
      { currentTargets: async () => ({ targets: [] }), listEdgeBmUsage: async () => [], ownerTier: async () => owner, minEdgeVersion: async () => '0',
        yielder: () => { const y = createYielder(15); return async () => { yields += 1; return y(); }; } });
    const ms = performance.now() - t0; clearInterval(iv);
    return { r, ms, maxGap, yields };
  };
  await run(true);   // 모듈 · 캐시 데우기
  const best = async (owner) => { const a = await run(owner); const b = await run(owner); return a.ms <= b.ms ? a : b; };
  const own = await best(true);
  const op = await best(false);
  assert.equal(op.r.windows.length, 200);
  // 재현 r3 재확인: 예전(4b69a1079) 비소유자 20~32초 · 정지 0.27~0.64초(소유자 0.2초 — 비율 100배 넘음). 실측 판(이 컨테이너): 비소유자 0.36~0.43초 · 정지 32~48ms.
  assert.ok(op.ms <= 6 * own.ms + 100, `비소유자 ${Math.round(op.ms)}ms · 소유자 ${Math.round(own.ms)}ms(비율 6배 이하)`);
  assert.ok(op.maxGap <= Math.max(150, 3 * own.maxGap), `루프 최대 정지 ${Math.round(op.maxGap)}ms(소유자 ${Math.round(own.maxGap)}ms)`);
  assert.ok(op.yields > op.r.windows.length + 50, `합 규칙 단계 사이에도 양보 기회(${op.yields} — 행 사이만이면 ${op.r.windows.length})`);
  // 답 — 행의 canConfirm · confirmOwner 가 정확 경로(메모 없음)와 같다(행 표본 — 정확 경로는 느리다)
  const tagsOf = await R.tagsReader();
  const gate = ST.listWindows();
  const now = op.r.now;
  for (const row of op.r.windows.filter((_, i) => i % 13 === 0)) {
    const w = gate.find((x) => x.id === row.id);
    const need = ST.needsOwnerTier(w) ? 'window' : (ST.coverNeedsOwner({ ...w, confirmedAt: now }, gate, now, { tagsOf, exact: true }) ? 'combined' : null);
    assert.equal(row.canConfirm, !need, `${row.name}`); assert.equal(row.confirmOwner ?? null, need === 'combined' ? 'combined' : null, `${row.name}`);
  }
  // 같은 동료 묶음(법인 · 같은 키 묶음) — 서버 20대를 같이 덮는 같은 꼴 창 40개(합 12시간 이하라 끝까지 센다): 키마다 다시 세지 않는다(예전 31.6초 · 묶음 건너뛰기 없이 약 20배)
  fs.writeFileSync(path.join(DIR, 'maintenance-windows.json'), JSON.stringify({ v: 1, seq: 500, items: Array.from({ length: 40 }, (_, i) => ({ id: `mw-dup${String(i).padStart(6, '0')}`, name: `dup${i}`, reason: 'r',
    tz: 'Asia/Seoul', vcenterId: 'vcA', target: { kind: 'server', keys: keys20, names: keys20 }, schedule: { kind: 'weekly', days: all7, time: '02:00', durMin: 120 }, scopes: { alerts: true },
    by: 'op', at: now0 - (i % 9) * DAY, rev: 1, approvedBy: '', confirmedAt: now0 - (i % 9) * DAY, edits: [] })) }));
  ST._resetMaintStoreForTest();
  await run(true);
  const own2 = await best(true); const op2 = await best(false);
  assert.equal(op2.r.windows.filter((w) => w.canConfirm).length, 40, '합 12시간 이하 — 모두 재확인 가능');
  assert.ok(op2.ms <= 15 * own2.ms + 100, `같은 묶음 — 비소유자 ${Math.round(op2.ms)}ms · 소유자 ${Math.round(own2.ms)}ms(실측 약 6배 · 예전 700배)`);
});

/** 성능 알림 규칙 한 주기(실제 runPerfAlerts — 판정기는 주입하거나 저장소에서) → 주기 끝 점검. */
async function perfCycle(now, { judge = null } = {}) {
  const A = await import('../src/bmusage/perfAlerts.js');
  A._resetPerfAlertsForTest();
  const deps = { alertConfig: async () => ({ channels: { email: { enabled: true } } }), notify: async () => ['email:ok'], outcome: async () => 'delivered', retryDelay: async () => null,
    applyIssues: async () => ({ byId: {} }), startFocus: async () => ({ ok: true }), isMock: async () => false, clock: () => Date.now(), ...(judge ? { maintJudge: async () => judge } : {}) };
  const rules = { rules: { use: { on: true, cond: 'sat-err', sustain: 1, repeatMin: 0, channels: ['email'], issue: false, autoFocus: false, corpsOff: [] } }, daily: { alerts: 50, issues: 20, autoFocus: 10 }, focus: { autoCorps: [] } };
  const item = { key: 'K3', name: 'bm-k3', vcenterId: 'vcA', target: { key: 'K3', vcenterId: 'vcA' }, entry: { verdict: 'saturated', line: 'disk' } };
  const r = await A.runPerfAlerts([item], { rules, now, deps });
  await A._drainPerfAlertsForTest();
  return { r, audit: await R.auditCycle({ now }) };
}
const rec = (o = {}) => ({ name: '반복 12h', reason: 'r', tz: 'Asia/Seoul', target: { kind: 'server', keys: ['K3'] }, vcenterId: 'vcA', scopes: { alerts: true, hold: true },
  schedule: { kind: 'weekly', days: all7, time: hhmm(T0 - 10 * HOUR), durMin: 720 }, ...o });
const once10 = (o = {}) => ({ name: '일회 10h', reason: 'r', tz: 'Asia/Seoul', target: { kind: 'server', keys: ['K3'] }, vcenterId: 'vcA', scopes: { alerts: true, hold: true },
  schedule: { kind: 'once', start: loc(T0 - HOUR), end: loc(T0 + 9 * HOUR) }, ...o });

test('D3 — 한 서버를 덮는 창 둘이 겹쳐도 점검은 창마다(거짓 over-cap 없음) · 창 하나씩도 0 · 진짜 끝 뒤 억제는 잡는다', async () => {
  const now = T0 + 5 * MIN;
  // 겹침 — 12h 반복(10시간 전 시작) + 10h 일회(1시간 전 시작): 시작 최소 ~ 끝 최대 = 19시간 > 반복 상한 12시간
  resetAll();
  const wr = await ST.addWindow(rec(), { by: 'own', now: T0 });
  const wo = await ST.addWindow(once10(), { by: 'own', now: T0 });
  const ms = (await R.maintJudge({ now })).stateFor({ key: 'K3', vcenterId: 'vcA' }, now);
  assert.deepEqual(ms.windows.map((w) => w.id).sort(), [wr.id, wo.id].sort(), '둘 다 진행 중');
  // ① 성능 알림 규칙(perfAlerts.dispatch)
  const p = await perfCycle(now);
  assert.equal(p.r.maintenance, 1);
  assert.deepEqual(p.audit, { checked: 1, leak: 0, unverified: 0, reasons: {} }, '재현 r3 — 예전 { leak 1, over-cap 1 }');
  assert.deepEqual(R.scopeOccOf(ms, 'alerts').map((o) => (o.until - o.since) / HOUR).sort((a, b) => a - b), [10, 12], '창마다 그 창의 길이(판정 코어 하나 — 호출처가 같은 함수)');
  // ② 파트 장애 보류(partfaultHold) · ⑤ 임계 초과 알림(notify — 판정은 실제 시각)
  const PH = await import('../src/bmusage/maint/partfaultHold.js');
  const h = await PH.partfaultMaintHold([{ agent: '', deviceId: 'idrac-k3', deviceKey: 'K3TAG', scope: 'idrac' }], { now, deps: { targets: [{ agent: '', key: 'K3', serviceTag: 'K3TAG', vcenterId: 'vcA', regId: '' }] } });
  assert.deepEqual([...h.hold], ['|idrac-k3']); assert.deepEqual(h.audit, { checked: 1, leak: 0 }, '보류 — 예전 leak 1');
  const N = await import('../src/bmusage/notify.js');
  const nr = await N.runBmUsageAlerts([{ key: 'K3', name: 'bm-k3', vcenterId: 'vcA', cpu_pct: 99 }],
    { alertEnabled: true, alertPct: 90, alertSustainMin: 0, alertRepeatHours: 6, intervalMs: 300_000, maintJudge: await R.maintJudge({ now: Date.now() }), targetOf: () => ({ key: 'K3', vcenterId: 'vcA' }) });
  assert.equal(nr.maint.held, 1);
  const na = await R.auditCycle({ now: Date.now() });
  assert.equal(na.checked, 1); assert.equal(na.leak, 0, '임계 초과 알림 — 예전 leak 1');
  // 창 하나씩 — 0(두 경우 모두)
  for (const only of [rec, once10]) {
    resetAll();
    await ST.addWindow(only(), { by: 'own', now: T0 });
    const q = await perfCycle(now);
    assert.equal(q.r.maintenance, 1); assert.equal(q.audit.leak, 0, only === rec ? '반복 하나' : '일회 하나');
  }
  // 진짜 창 끝 뒤 억제는 그대로 잡는다 — 판정기를 만든 뒤 반복 창의 이 발생을 지금 끝냈는데 낡은 판정기로 억제(창마다 그 창의 시작으로 ‘끝냄’ 을 맞춘다)
  resetAll();
  const w1 = await ST.addWindow(rec(), { by: 'own', now: T0 });
  await ST.addWindow(once10(), { by: 'own', now: T0 });
  // 낡은 판정기 = 그때의 사본(저장소 캐시 객체를 같이 쥐면 끝내기가 판정기에도 비친다 — 사본으로 ‘이미 만든 주기 판정기’ 를 흉내 낸다)
  const snapW = JSON.parse(JSON.stringify(ST.windowsForJudge(now).windows));
  const stale = await R.maintJudge({ now, windowsOf: () => ({ windows: snapW, deployed: null }) });
  await ST.endWindowNow(w1.id, { by: 'own', rev: w1.rev, now });
  const z = await perfCycle(now + MIN, { judge: stale });
  assert.equal(z.audit.leak, 1); assert.deepEqual(z.audit.reasons, { ended: 1 }, '끝낸 창으로 억제 — ended(창마다 그 창 발생의 시작으로 맞춘다)');
  // 적용 시각이 억제 끝 뒤 — after-end(창마다 기록이어도)
  R._resetMaintRuntimeForTest({ unlink: false });
  R.noteApplied('alerts', 'K3', now, [w1.id], now + MIN, { occ: [{ id: w1.id, since: now - HOUR, until: now }] });
  assert.deepEqual((await R.auditCycle({ now })).reasons, { 'after-end': 1 });
  // 창 하나의 발생이 그 꼴의 상한을 넘으면 over-cap(창마다 — 반복 12시간)
  R.noteApplied('alerts', 'K3', now + HOUR, [w1.id], now, { occ: [{ id: w1.id, since: now - 13 * HOUR, until: now + HOUR }] });
  assert.deepEqual((await R.auditCycle({ now })).reasons, { 'over-cap': 1 });
});

test('I1 — 모르는 규칙 id 는 unknown(USE 판정 변화로 바꾸지 않는다) · 이슈를 만들지 않는다 · 아는 규칙은 그대로', async () => {
  const OP = await import('../src/central/bmPerfOpsPull.js');
  const now = T0;
  const sent = OP.sanitizeAlertSent([
    { id: 'a1', at: now, rule: 'diskSmart', key: 'db01', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent', issue: 'pending-central' },
    { id: 'a2', at: now, rule: 'use', key: 'db01', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent', issue: 'pending-central' },
    { id: 'a3', at: now, rule: '__proto__', key: 'db01', name: 'x', vcenterId: 'vcA', title: 't', channels: [], result: 'sent', issue: 'pending-central' },
  ], now);
  assert.deepEqual(sent.map((x) => x.rule), ['unknown', 'use', 'unknown'], '재현 r3 — 예전 use');
  assert.deepEqual(sent.map((x) => x.issue), ['skipped', 'pending-central', 'skipped'], '모르는 규칙의 ‘중앙에서 판단’ 은 안 만듦');
  const snap = { perfAlertSent: sent, targets: [{ key: 'db01', name: 'db01', vcenterId: 'vcA', serviceTag: '' }] };
  const resolveVc = async () => ({ id: 'vcA', name: 'A' });
  const c = await OP.centralizeEdgeSent('edge-a', snap, { resolveVc });
  assert.equal(c.list.find((x) => x.id === 'a1').title, 'db01 — 알 수 없는 규칙(수집 노드 edge-a)', '예전 ‘USE 판정 변화’');
  assert.equal(c.list.find((x) => x.id === 'a2').title, 'db01 — USE 판정 변화(수집 노드 edge-a)');
  // 이슈 — 중앙 use 규칙 issue 켬이어도 모르는 규칙 건은 만들지 않는다(예전 1건) · 아는 규칙은 만든다
  const applied = [];
  const r = await OP.ingestEdgeAlertIssues('edge-a', snap, { resolveVc, rules: async () => ({ rules: { use: { on: true, issue: true, corpsOff: [] } }, daily: { issues: 20 } }),
    apply: async (fires) => { applied.push(...fires); return { byId: Object.fromEntries(fires.map((f) => [f.id, 'created'])) }; } });
  assert.deepEqual(applied.map((f) => f.id), ['edge-a:a2']); assert.equal(r.created, 1);
  // 정제 전 원문(옛 봉투가 남은 경우)이 와도 아는 규칙만
  const raw = { ...snap, perfAlertSent: [{ id: 'b1', at: now, rule: 'diskSmart', key: 'db01', issue: 'pending-central' }] };
  applied.length = 0;
  await OP.ingestEdgeAlertIssues('edge-a', raw, { resolveVc, rules: async () => ({ rules: { diskSmart: { on: true, issue: true }, use: { on: true, issue: true } }, daily: { issues: 20 } }),
    apply: async (fires) => { applied.push(...fires); return { byId: {} }; } });
  assert.deepEqual(applied, [], '규칙 목록(RULE_IDS)에 없는 id 는 설정에 같은 이름이 있어도 이슈를 만들지 않는다');
});
