/**
 * 결정 반영(2026-11-19 · 사용자 결정 3건 — 모두 권장안 · 기준판 266a350dc) — 실제 라우터 · 실제 판정 코어로 고정한다.
 *   ① 설정 소유자 등급의 **조회(GET · HEAD)도** 조회 ∧ 쓰기 전체 범위(requireSettingsOwner — isFullReadWriteScope · 던지면 거부).
 *      재현(기준판): 쓰기 범위가 일부 법인인 소유자 wown 이 소유자 GET(백업 상태 · 비밀 정책 · 세션 보안 · 중앙 토큰 …)과 비밀 포함 CSV 를 200 으로 받았다.
 *      등급 질의(isOwnerTier — 8a 정비 창 · 7b 묶음 행)는 바꾸지 않는다 · /auth/me settingsOwnerTier = 그 GET 의 실제 판정.
 *   ② 새 반복 정비 창은 **만든 시각 이후만** 지난 구간(coverIntervals — ⑤ 분모 제외 · 용량 · 저활용 · 베이스라인 · 음영 · 변경 묶음)에 든다.
 *      재현(기준판): 지금 만든 매일 창이 지난 31일 전부(31구간 이상)를 덮었다 · 만든 시각에 걸친 발생은 그 발생의 시작부터 덮었다.
 *      지금 판정(activeOccurrence · 억제)은 그대로다. 엣지 대조는 bmUsageLoop3Edge ①(W4 — 만든 시각에 걸친 창).
 *   ③ 베어메탈 사용률 설정 PUT 의 보존 **줄이기**는 설정 소유자 등급만(늘리기 · 같음은 그대로) · 403 이면 아무것도 저장하지 않는다.
 *      재현(기준판): 소유자가 아닌 전체 범위 관리자가 원시 보존 90 → 7 · 롤업 1825 → 30 · store.rawDays 30 → 7 을 200 으로 저장했다.
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 T0(루트 CLAUDE.md — 창 · 설정은 실제 시각으로 판정되는 경로가 있어 고정 epoch 는 깨진다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdecga-'));
Object.assign(process.env, {
  CONFIG_DIR: DIR, DATA_DIR: DIR, AUTH_ENABLED: 'true', AUTH_SECRET: 'z'.repeat(48), OTP_ROLE_ENFORCE: 'false', DATA_SOURCE: 'live',
  SETTINGS_OWNERS: 'own,wown,sown', SSRF_ALLOW_LOOPBACK: 'true',
});
delete process.env.CENTRAL_URL;
delete process.env.BMUSAGE_ENABLED;
const MIN = 60_000; const HOUR = 3_600_000; const DAY = 86_400_000;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: false, corps: { vcA: true } }));

const auth = await import('../src/auth/auth.js');
const SH = await import('../src/routes/admin/shared.js');
const S = await import('../src/bmusage/settings.js');
const { store } = await import('../src/store.js');
store.snapshot = { ...store.get(), vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] };
const PW = 'Passw0rd!long1';
const mk = (u) => auth.createUser({ password: PW, role: 'admin', ...u }, { trusted: true });
mk({ username: 'own' });                                                          // 소유자 · 전체 범위
mk({ username: 'wown', scope: { vcenters: [], writeVcenters: ['vcA'] } });       // 소유자 · 조회 무제한 + 쓰기 vcA
mk({ username: 'sown', scope: { vcenters: ['vcA'] } });                          // 소유자 · 조회 vcA
mk({ username: 'adm' });                                                          // 전체 범위 관리자(소유자 아님)
const TOK = Object.fromEntries(['own', 'wown', 'sown', 'adm'].map((name) => {
  const u = auth.getUser(name); const sid = `sid-${name}`; const exp = Math.floor(Date.now() / 1000) + 3600;
  const t = auth.signToken({ sub: name, role: u.role, name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
  auth.noteIssuedSession({ sub: name, sid, exp });
  return [name, t];
}));

const express = (await import('express')).default;
const { authRouter } = await import('../src/routes/auth.js');
const { adminRouter } = await import('../src/routes/admin.js');
const { api } = await import('../src/routes/api.js');
const app = express(); app.use(express.json());
app.use('/api/auth', authRouter);
app.use('/api/admin', auth.authMiddleware, auth.requireEnrolled, adminRouter);
app.use('/api', auth.authMiddleware, auth.requireEnrolled, api);
app.use((err, _req, res, _n) => res.status(500).json({ err: String(err?.message || err) }));
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
test.after(() => { try { srv.closeAllConnections?.(); srv.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });
const base = `http://127.0.0.1:${srv.address().port}`;
const call = async (who, method, p, body) => {
  const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${TOK[who]}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch { /* CSV · 빈 본문 */ }
  return { s: r.status, j, txt };
};

/** 실제 라우터에서 requireSettingsOwner 가 스택에 있는 GET 라우트 전부(하위 라우터까지 — 새 소유자 GET 도 자동으로 든다). */
async function ownerGetRoutes() {
  const { routesOf, mountPathOf } = await import('../src/portalcheck/archScan.js');
  const out = [];
  const walk = (name, router, mount) => {
    for (const L of router?.stack || []) {
      if (!L.route && Array.isArray(L.handle?.stack)) { const sub = mountPathOf(L); walk(name, L.handle, mount + (sub && sub !== '/' ? sub : '')); }
    }
    // 게이트 태그(kind 'settingsOwner' — requireSettingsOwner.gate)로 찾는다: wrapAsyncRouter 가 처리기를 감싸 함수 동일성으로는 못 찾는다(태그는 아키텍처 점검과 같은 표지)
    for (const r of routesOf({ name, mount, router })) if (r.method === 'GET' && r.gates.some((g) => g?.kind === 'settingsOwner')) out.push(r.full);
  };
  walk('admin', adminRouter, '/api/admin'); walk('api', api, '/api'); walk('auth', authRouter, '/api/auth');
  return [...new Set(out)].sort();
}
/** 소유자 GET 중 비밀을 싣는 **안쪽 호출**(쿼리로 켜는 비밀 포함 내보내기 — 라우트 스택에는 없고 처리기가 requireSettingsOwner 를 부른다). */
const INLINE_OWNER_GETS = [
  '/api/admin/idrac/scan-ranges/export.csv?secrets=1', '/api/admin/agent-deploy/targets/export.csv?secrets=1', '/api/admin/agent-deploy/targets/export.txt?secrets=1',
  '/api/admin/collectors/export.csv?tokens=1', '/api/tools/cvp/bulk/servers/export.csv?secrets=1', '/api/tools/storage/devices/export.csv?passwords=1',
  '/api/tools/pdu/csv/export?passwords=1', '/api/tools/bm-storage/export.csv?secrets=1',
];

/* ── ① ─────────────────────────────────────────────────────────────────── */
test('① 소유자 GET 전수 — 쓰기 일부 소유자는 403(쓰기 범위 사유) · 조회 범위 소유자 · 비소유자도 403 · 전체 범위 소유자는 통과', async () => {
  const routes = await ownerGetRoutes();
  for (const must of ['/api/admin/backup/status', '/api/admin/backup/download/:name', '/api/admin/secrets/policy', '/api/admin/security/session', '/api/admin/central-token',
    '/api/admin/settings/status', '/api/admin/host-access', '/api/admin/usage/report', '/api/settings/ssh-access', '/api/tools/bm-storage/auth-choices']) {
    assert.ok(routes.includes(must), `소유자 GET 목록에 ${must} 가 없다 — ${routes.join(', ')}`);
  }
  assert.ok(routes.length >= 17, `소유자 GET ${routes.length}개(기준판 17)`);
  for (const p0 of [...routes.map((r) => r.replace(/:[A-Za-z]+/g, 'nope')), ...INLINE_OWNER_GETS]) {
    const w = await call('wown', 'GET', p0);
    // 재현(기준판): wown 은 게이트를 지나 처리기 응답(200 · 404 · 400 …)을 받았다
    assert.equal(w.s, 403, `wown GET ${p0}: ${w.txt.slice(0, 160)}`);
    assert.equal(w.j.reason, SH.SETTINGS_OWNER_WRITE_SCOPE_REASON, `wown GET ${p0} 사유 — 쓰기 범위 때문인 것을 말한다`);
    assert.equal(w.j.writeScope, 'partial'); assert.equal(w.j.requiredOwner, undefined, '이미 소유자인 계정에 소유자 등록 안내를 하지 않는다');
  }
  // 대표 라우트 — 계정 넷 × GET · HEAD
  for (const p of ['/api/admin/backup/status', '/api/admin/secrets/policy', '/api/admin/security/session', '/api/admin/central-token', '/api/admin/usage/settings']) {
    assert.equal((await call('own', 'GET', p)).s, 200, `own GET ${p}`);
    const so = await call('sown', 'GET', p); assert.equal(so.s, 403); assert.equal(so.j.reason, SH.SETTINGS_OWNER_FULL_SCOPE_REASON, '조회 범위 소유자 사유는 그대로');
    const a = await call('adm', 'GET', p); assert.equal(a.s, 403); assert.equal(a.j.requiredOwner, true, '비소유자는 소유자 안내 그대로');
  }
  assert.equal((await call('wown', 'HEAD', '/api/admin/backup/status')).s, 403, 'HEAD 도 같다');
  assert.equal((await call('own', 'HEAD', '/api/admin/backup/status')).s, 200);
  // 비밀이 없는 같은 내보내기는 그대로(조회 범위 게이트만) — 바뀐 것은 비밀이 든 조회뿐
  const plain = await call('wown', 'GET', '/api/tools/bm-storage/export.csv');
  assert.equal(plain.s, 200, plain.txt.slice(0, 160));
  const sec = await call('own', 'GET', '/api/tools/bm-storage/export.csv?secrets=1');
  assert.equal(sec.s, 200, sec.txt.slice(0, 160));
});

test('① /auth/me settingsOwnerTier = 소유자 GET 의 실제 판정(계정 넷) · 등급 질의(isOwnerTier)는 쓰기 범위를 보지 않는다 · 판정이 던지면 거부', async () => {
  for (const [who, owner, tier] of [['own', true, true], ['wown', true, false], ['sown', true, false], ['adm', false, false]]) {
    const me = await call(who, 'GET', '/api/auth/me');
    assert.equal(me.s, 200, `${who} /auth/me ${me.s}`);
    assert.equal(me.j.user.isSettingsOwner, owner, `${who} isSettingsOwner(설정 메뉴 노출)`);
    assert.equal(me.j.user.settingsOwnerTier, tier, `${who} settingsOwnerTier`);
    assert.equal((await call(who, 'GET', '/api/admin/backup/status')).s === 200, tier, `${who}: 화면 표지와 서버 GET 게이트가 같다`);
  }
  const { isOwnerTier } = await import('../src/routes/api/bmOnboard.js');
  assert.equal(await isOwnerTier({ method: 'GET', user: { username: 'wown', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } } }), true,
    '법인마다 쓰기 범위를 따로 보는 라우트 안 등급은 그대로(bmMaint8aRoute 가 vcA 법인 창 200 을 고정)');
  const boom = { username: 'own', role: 'admin', scope: { vcenters: [], get writeVcenters() { throw new Error('boom'); } } };
  let got = null; const res = { status: (s) => ({ json: (b) => { got = { s, b }; } }) };
  SH.requireSettingsOwner({ method: 'GET', user: boom }, res, () => { got = 'next'; });
  assert.equal(got?.s, 403, 'GET 이어도 판정이 던지면 거부(기본값 false)');
});

test('① 재확인 N2 — 세션 보안 소유자 경고가 게이트와 같은 판정(쓰기 일부 소유자도 경고 · 쓰기 범위 사유) · 판정이 던지면 경고', async () => {
  const ops = await import('../src/routes/admin/opsSettings.js');
  const w = ops.scopedOwnerWarnings(['own', 'wown', 'sown', 'adm', 'nobody']);
  const by = Object.fromEntries(w.map((x) => [x.username, x]));
  assert.deepEqual(Object.keys(by).sort(), ['sown', 'wown'], JSON.stringify(w));
  assert.equal(by.wown.reason, SH.SETTINGS_OWNER_WRITE_SCOPE_REASON, '쓰기 일부 — 게이트(requireSettingsOwner)가 내는 사유와 같다');
  assert.equal(by.wown.writeScope, 'partial');
  assert.equal(by.sown.reason, SH.SETTINGS_OWNER_FULL_SCOPE_REASON, '조회 범위 — 예전 사유 그대로');
  // 경고 ⟺ 실제 게이트: 경고된 계정은 소유자 GET 403 · 경고 없는 소유자는 200
  for (const who of ['own', 'wown', 'sown']) {
    assert.equal((await call(who, 'GET', '/api/admin/backup/status')).s === 200, !by[who], `${who}: 경고 ⟺ 403`);
  }
});

/* ── ② ─────────────────────────────────────────────────────────────────── */
const J = await import('../src/bmusage/maint/judge.js');
const SC = await import('../src/bmusage/maint/schedule.js');
const ST = await import('../src/bmusage/maint/store.js');
const R = await import('../src/bmusage/maint/runtime.js');
const TARGET = { key: 'K1', vcenterId: 'vcA' };
const hhmm = (ms) => SC.fmtLocal('Asia/Seoul', ms).slice(11, 16);
const ymdhm = (ms) => SC.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const daily = (at, extra = {}) => ({ id: `w-${at}`, name: 'd', reason: 'r', vcenterId: 'vcA', tz: 'Asia/Seoul', target: { kind: 'server', keys: ['K1'] },
  scopes: { exclude: true, alerts: true }, schedule: { kind: 'weekly', days: ALL_DAYS, time: hhmm(T0 - HOUR), durMin: 180 }, rev: 1, at, confirmedAt: at, ...extra });

test('② 순수 — 지금 만든 매일 창은 지난 31일을 덮지 않는다 · 만든 시각에 걸친 발생은 그 시각부터 · 지금 판정은 그대로', () => {
  const w = daily(T0);   // 매일 (T0 − 1h) 부터 3시간 — 오늘 발생 [T0 − 1h, T0 + 2h) 가 만든 시각 T0 에 걸친다
  const past = J.coverIntervals([w], TARGET, T0 - 31 * DAY, T0, { scope: 'exclude' });
  assert.deepEqual(past, [], `재현(기준판): 지난 31일 ${past.length}구간을 덮었다(예전 31구간 이상)`);
  const iv = J.coverIntervals([w], TARGET, T0 - 31 * DAY, T0 + 3 * HOUR, { scope: 'exclude' });
  assert.deepEqual(iv.map((x) => [x.from, x.to]), [[T0, T0 + 2 * HOUR]], '만든 시각에 걸친 발생은 만든 시각부터(예전 T0 − 1h)');
  const occ = J.effectiveOccurrences(w, T0 - 31 * DAY, T0 + 3 * HOUR, { history: true });
  assert.deepEqual(occ, [{ start: T0, end: T0 + 2 * HOUR, born: true }]);
  // 지금 판정 — 원래 발생 그대로(만들자마자 진행 중인 발생의 억제는 예전처럼)
  const ms = J.maintStateFor([w], TARGET, T0 + 30 * MIN);
  assert.equal(ms.active, true); assert.equal(ms.windows[0].start, T0 - HOUR, '지금 판정의 발생 시작은 일정 그대로');
  assert.deepEqual(J.effectiveOccurrences(w, T0 - DAY, T0 + 3 * HOUR).map((o) => o.start).at(-1), T0 - HOUR, 'history 가 아니면 자르지 않는다(합 규칙 · 상태 · 다음 발생)');
  // 열흘 전에 만든 창 — 그 뒤 발생만(만든 시각에 걸친 것 1 + 9일 + 오늘 = 11구간 · 예전 32) · 첫 구간은 만든 시각부터
  const w10 = daily(T0 - 10 * DAY);
  const iv10 = J.coverIntervals([w10], TARGET, T0 - 31 * DAY, T0, { scope: 'exclude' });
  assert.equal(iv10.length, 11, JSON.stringify(iv10.map((x) => [x.from - T0, x.to - T0])));
  assert.equal(iv10[0].from, T0 - 10 * DAY);
  // 만든 시각을 모르면(형식 밖 · 옛 꼴) 자르지 않는다(0 으로 읽지 않는다 — 예전 그대로)
  const wn = daily(null, { confirmedAt: T0 });   // 재확인 시각은 있다(만료 판정은 그대로)
  assert.equal(J.coverIntervals([wn], TARGET, T0 - 31 * DAY, T0, { scope: 'exclude' }).length, 32);
  // 재확인 S3: at 키가 **없는** 옛 꼴(undefined) — Number(undefined)=NaN 으로 읽으면 지난 구간이 통째로 사라진다(null 만 넣으면 Number(null)=0 이 같은 답이라 못 잡는다)
  const wu = daily(T0); delete wu.at;
  assert.equal(J.coverIntervals([wu], TARGET, T0 - 31 * DAY, T0, { scope: 'exclude' }).length, 32, 'at 이 없으면 자르지 않는다(사라지지 않는다)');
  // 일회 창(시작이 지난 일회 창 — 만들 때 끝이 지금 뒤면 받는다)도 같은 규칙
  const once = { ...daily(T0), id: 'once', schedule: { kind: 'once', start: ymdhm(T0 - 2 * HOUR), end: ymdhm(T0 + HOUR) } };
  assert.deepEqual(J.coverIntervals([once], TARGET, T0 - DAY, T0 + DAY).map((x) => [x.from, x.to]), [[T0, T0 + HOUR]]);
  // 묘비와 대칭 — 닷새 전에 만들고 이틀 전에 지운 창은 그 사이만
  const tomb = daily(T0 - 5 * DAY, { id: 'tomb', deleted: { at: T0 - 2 * DAY, by: 'op' } });
  const ivt = J.coverIntervals([tomb], TARGET, T0 - 31 * DAY, T0, { scope: 'exclude' });
  assert.equal(ivt.length, 4, JSON.stringify(ivt.map((x) => [x.from - T0, x.to - T0])));
  assert.equal(ivt[0].from, T0 - 5 * DAY, '만든 시각부터'); assert.equal(ivt.at(-1).to, T0 - 2 * DAY, '지운 시각까지');
});

test('② 실제 저장 · 판정기(⑤ 소비처 경로) — 만든 시각 이후만 · 고치기는 만든 시각을 유지한다', async () => {
  ST._resetMaintStoreForTest();
  const now = Date.now();
  const T1 = Math.floor(now / HOUR) * HOUR;   // 이 시험의 정시(만든 시각 now 는 [T1, T1 + 1h) 안 — 매일 (T1 − 1h) 발생이 만든 시각에 걸친다)
  const body = { name: 'n1', reason: 'r', vcenterId: 'vcA', tz: 'Asia/Seoul', target: { kind: 'server', keys: ['K1'] }, scopes: { exclude: true },
    schedule: { kind: 'weekly', days: ALL_DAYS, time: hhmm(T1 - HOUR), durMin: 180 } };
  const w = await ST.addWindow(body, { by: 'op', now });
  assert.equal(w.at, now, '만든 시각');
  ST._resetMaintStoreForTest();
  let MJ = await R.maintJudge({ now });
  let cov = MJ.cover(TARGET, now - 31 * DAY, now + 3 * HOUR, 'exclude');
  // 재현(기준판): 판정기 cover 가 지난 31일 매일(32구간)을 덮었다
  assert.deepEqual(cov.map((x) => [x.from, x.to]), [[now, T1 + 2 * HOUR]], JSON.stringify(cov.map((x) => [x.from - now, x.to - now])));
  // 고치기(이름 · 일정)는 만든 시각을 바꾸지 않는다(store.editWindow at: cur.at) — 지난 구간도 그대로 만든 시각부터
  const e = await ST.editWindow(w.id, { ...body, name: 'n2', schedule: { ...body.schedule, durMin: 120 } }, { by: 'op', rev: w.rev, now: now + 1 });
  assert.equal(e.at, now);
  ST._resetMaintStoreForTest();
  MJ = await R.maintJudge({ now: now + 2 });
  cov = MJ.cover(TARGET, now - 31 * DAY, now + 3 * HOUR, 'exclude');
  assert.deepEqual(cov.map((x) => [x.from, x.to]), [[now, T1 + HOUR]]);
  // 배포본 꼴(엣지가 받는 창)도 만든 시각을 들고 간다 — normalizeWindow 가 at 을 지키고 같은 판정 코어가 같은 답(엣지 왕복 대조는 bmUsageLoop3Edge ①)
  const n = ST.normalizeWindow(JSON.parse(JSON.stringify({ ...e, origin: undefined })));
  assert.equal(n.at, now);
  assert.deepEqual(J.coverIntervals([{ ...n, origin: 'central', history: true }], TARGET, now - 31 * DAY, now + 3 * HOUR), J.coverIntervals([e], TARGET, now - 31 * DAY, now + 3 * HOUR));
  await ST.deleteWindow(w.id, { by: 'op', rev: e.rev, now: now + 3 });
  ST._resetMaintStoreForTest();
});

/* ── ③ ─────────────────────────────────────────────────────────────────── */
const settingsNow = () => { S._resetForTest(); return S.loadLocalBmUsageSettings(); };
const put = (who, body) => call(who, 'PUT', '/api/tools/bm-usage/settings', body);

test('③ 보존 줄이기 — 비소유자 전체 범위 관리자 403(아무것도 저장하지 않음) · 소유자 200 · 늘리기 · 같음은 둘 다 200', async () => {
  const s0 = settingsNow();
  assert.equal(s0.rawRetentionDays, 90); assert.equal(s0.dailyRetentionDays, 1825); assert.equal(s0.store.rawDays, 30);
  // 재현(기준판 200): 비소유자 관리자가 원시 90 → 7(같은 요청의 법인 칸 변경도 함께 거절 — 아무것도 저장하지 않는다)
  const r1 = await put('adm', { rawRetentionDays: 7, corps: { vcA: true, vcB: true } });
  assert.equal(r1.s, 403, r1.txt); assert.equal(r1.j.code, 'retention-owner'); assert.deepEqual(r1.j.fields, ['rawRetentionDays']);
  assert.equal(r1.j.requiredOwner, true, '화면이 소유자 안내로 그린다(AccessDenied owner)'); assert.match(r1.j.reason, /설정 소유 계정만/);
  let s = settingsNow(); assert.equal(s.rawRetentionDays, 90); assert.equal(!!s.corps.vcB, false, '403 이면 법인 칸도 저장하지 않는다');
  for (const [b, f] of [[{ dailyRetentionDays: 30 }, 'dailyRetentionDays'], [{ store: { rawDays: 7 } }, 'store.rawDays'], [{ store: { hourlyDays: 30 } }, 'store.hourlyDays'],
    [{ store: { devRawDays: 1 } }, 'store.devRawDays'], [{ store: { devHourlyDays: 7 } }, 'store.devHourlyDays']]) {
    const r = await put('adm', b);
    assert.equal(r.s, 403, `${f}: ${r.txt.slice(0, 160)}`); assert.deepEqual(r.j.fields, [f]);
  }
  s = settingsNow(); assert.deepEqual([s.dailyRetentionDays, s.store.rawDays, s.store.hourlyDays, s.store.devRawDays, s.store.devHourlyDays], [1825, 30, 365, 14, 90], '하나도 저장하지 않았다');
  // 늘리기 · 같음 — 비소유자도 그대로 200(예전과 같다)
  assert.equal((await put('adm', { rawRetentionDays: 120, dailyRetentionDays: 2000, store: { rawDays: 60 } })).s, 200);
  s = settingsNow(); assert.deepEqual([s.rawRetentionDays, s.dailyRetentionDays, s.store.rawDays], [120, 2000, 60]);
  assert.equal((await put('adm', { rawRetentionDays: 120, dailyRetentionDays: 2000, store: { rawDays: 60 }, intervalMs: 10 * MIN })).s, 200, '같은 값 + 다른 칸');
  // 빈 칸 · 0 은 미지정(줄이기가 아니다 — 저장도 하지 않는다 · v2.583 #36)
  const blank = await put('adm', { rawRetentionDays: '', dailyRetentionDays: 0 });
  assert.equal(blank.s, 200, blank.txt); assert.deepEqual(blank.j.ignoredBlank?.sort(), ['dailyRetentionDays', 'rawRetentionDays']);
  // 소유자(전체 범위) — 줄이기 200
  assert.equal((await put('own', { rawRetentionDays: 60, dailyRetentionDays: 365, store: { rawDays: 14, hourlyDays: 90 } })).s, 200);
  s = settingsNow(); assert.deepEqual([s.rawRetentionDays, s.dailyRetentionDays, s.store.rawDays, s.store.hourlyDays], [60, 365, 14, 90]);
  assert.equal((await put('own', { rawRetentionDays: 90, dailyRetentionDays: 1825, store: { rawDays: 30, hourlyDays: 365 } })).s, 200, '소유자 늘리기');
  assert.equal((await put('own', { rawRetentionDays: 90 })).s, 200, '소유자 같음');
  // 쓰기 일부 소유자 — 전역 값은 예전처럼 버리고 밝힌다(403 이 아니다 — 보존 칸이 저장되지 않으므로 줄이기도 아니다)
  const wo = await put('wown', { rawRetentionDays: 7 });
  assert.equal(wo.s, 200, wo.txt); assert.ok(wo.j.ignoredGlobal?.includes('rawRetentionDays'));
  assert.equal(settingsNow().rawRetentionDays, 90);
});

test('③ 다른 경로 — 못 읽은 동안의 확정 저장 · 서비스 점검 확정은 소유자만 · 중앙 배포 중인 엣지는 배포 키를 저장하지 않아 줄이기가 아니다', async () => {
  const F = path.join(DIR, 'bmusage-settings.json');
  const keep = fs.readFileSync(F, 'utf8');
  // 손상 — 확정 저장은 지금 값을 몰라 줄어듦으로 본다(거부 쪽)
  fs.writeFileSync(F, '{ corrupt'); S._resetForTest();
  const c1 = await put('adm', { confirmDefaults: true, corps: { vcA: true } });
  assert.equal(c1.s, 403, c1.txt); assert.deepEqual(c1.j.fields, ['unknown']); assert.match(c1.j.reason, /지금 값을 모릅니다/);
  assert.ok(S.bmUsageLocalLoadError(), '손상 표지 그대로(보존 정리는 상한으로만 — 저장하지 않았다)');
  const c2 = await put('adm', { corps: { vcA: true } });
  assert.equal(c2.s, 409, '확정이 아니면 예전처럼 409(저장하지 않는다)');
  const listed = (await import('../src/util/settingsLoadError.js')).listSettingsLoadErrors().find((x) => x.file === 'bmusage-settings.json');
  assert.equal(listed?.ownerOnly, true, '서비스 점검 목록이 확정 등급을 말한다');
  const cf = await call('adm', 'POST', '/api/tools/service-check/settings-files/confirm', { file: 'bmusage-settings.json' });
  assert.equal(cf.s, 403, `서비스 점검 확정도 소유자 — ${cf.txt.slice(0, 160)}`);
  assert.ok(S.bmUsageLocalLoadError());
  const ok = await put('own', { confirmDefaults: true, corps: { vcA: true } });
  assert.equal(ok.s, 200, ok.txt);
  for (const f of fs.readdirSync(DIR).filter((n) => n.startsWith('bmusage-settings.json.corrupt.'))) fs.rmSync(path.join(DIR, f));
  fs.writeFileSync(F, keep); S._resetForTest();
  // 엣지(중앙 배포 사본) — 배포 키(원시 · 롤업 보존)는 저장하지 않는다(ignoredCentralManaged) → 줄이기가 아니다. store 보존은 이 노드 값이라 그대로 판정한다.
  fs.writeFileSync(path.join(DIR, 'bmusage-central.json'), JSON.stringify({ managed: true, at: Date.now(), sig: 'x', settings: { enabled: true, corps: { vcA: true }, rawRetentionDays: 90, dailyRetentionDays: 1825 } }));
  S._resetForTest();
  const e1 = await put('adm', { rawRetentionDays: 7 });
  assert.equal(e1.s, 200, e1.txt);
  assert.equal(settingsNow().rawRetentionDays, 90, '배포 키는 저장하지 않았다');
  assert.equal((await put('adm', { store: { rawDays: 7 } })).s, 403, 'store 보존은 배포 키가 아니다 — 같은 판정');
  fs.rmSync(path.join(DIR, 'bmusage-central.json')); S._resetForTest();
});

test('③ 재확인 N1 — 엣지 배포 켜기 · 끄기 · 제외 · 중앙 켜기 · 해제 · 배포 파일 확정은 설정 소유자만 · 화면 표지 canEdit 은 같은 판정', async () => {
  const DF = path.join(DIR, 'bmusage-distribute.json');
  const distNow = () => S.loadDistribution();
  assert.equal(distNow().enabled, false);
  // 재현(기준판): 소유자가 아닌 전체 범위 관리자의 배포 켜기가 200 이었다 → 엣지 실효 보존이 중앙 값으로 바뀌어 다음 정리 틱이 이력을 지웠다
  for (const body of [{ enabled: true }, { excluded: { e1: true } }]) {
    const r = await call('adm', 'PUT', '/api/tools/bm-usage/distribute', body);
    assert.equal(r.s, 403, `adm ${JSON.stringify(body)} ${r.txt.slice(0, 160)}`);
    assert.equal(r.j.code, 'distribute-owner'); assert.equal(r.j.requiredOwner, true);
  }
  assert.equal(distNow().enabled, false, '아무것도 저장하지 않았다');
  assert.equal(Object.keys(distNow().excluded || {}).length, 0);
  for (const on of [true, false]) {
    const r = await call('adm', 'PUT', '/api/tools/bm-usage/distribute/edge', { agent: 'e1', on });
    assert.equal(r.s, 403, `adm 중앙 켜기 ${on} ${r.txt.slice(0, 160)}`); assert.equal(r.j.code, 'distribute-owner');
  }
  // 쓰기 일부 소유자는 전체 범위 게이트(fleetOnly)가 먼저 막는다(사유가 다르다)
  const w = await call('wown', 'PUT', '/api/tools/bm-usage/distribute', { enabled: true });
  assert.equal(w.s, 403); assert.notEqual(w.j.code, 'distribute-owner');
  // 화면 표지 = 게이트 판정
  const ga = await call('adm', 'GET', '/api/tools/bm-usage');
  assert.equal(ga.s, 200, ga.txt.slice(0, 160)); assert.equal(ga.j.distribution?.canEdit, false, '비소유자 — 현황만');
  const go = await call('own', 'GET', '/api/tools/bm-usage');
  assert.equal(go.j.distribution?.canEdit, true);
  // 소유자는 그대로(켜기 · 끄기)
  const o1 = await call('own', 'PUT', '/api/tools/bm-usage/distribute', { enabled: true });
  assert.equal(o1.s, 200, o1.txt.slice(0, 160)); assert.equal(o1.j.distribution.enabled, true); assert.equal(o1.j.distribution.canEdit, true);
  assert.equal((await call('own', 'PUT', '/api/tools/bm-usage/distribute', { enabled: false })).s, 200);
  assert.equal(distNow().enabled, false);
  // 배포 파일 '기본값으로 확정'(서비스 점검)은 배포를 모두 끈다 = 끄기와 같은 결과 → 같은 등급
  fs.writeFileSync(DF, '{ corrupt'); S._resetForTest(); S.loadDistribution();
  const listed = (await import('../src/util/settingsLoadError.js')).listSettingsLoadErrors().find((x) => x.file === 'bmusage-distribute.json');
  assert.equal(listed?.ownerOnly, true, JSON.stringify(listed));
  const cf = await call('adm', 'POST', '/api/tools/service-check/settings-files/confirm', { file: 'bmusage-distribute.json' });
  assert.equal(cf.s, 403, `배포 파일 확정도 소유자 — ${cf.txt.slice(0, 160)}`);
  const co = await call('own', 'POST', '/api/tools/service-check/settings-files/confirm', { file: 'bmusage-distribute.json' });
  assert.equal(co.s, 200, co.txt.slice(0, 160));
  for (const f of fs.readdirSync(DIR).filter((n) => n.startsWith('bmusage-distribute.json'))) fs.rmSync(path.join(DIR, f));
  S._resetForTest();
});

test('③ 판정 입력(retentionShrink) — 저장과 같은 정규화(범위 자름 · 빈 값 · store 키 단위 겹침)', () => {
  S._resetForTest();
  assert.deepEqual(S.retentionShrink({ rawRetentionDays: 3 }), { shrink: ['rawRetentionDays'], unknown: false }, '하한 7 로 잘려도 90 보다 작다');
  assert.deepEqual(S.retentionShrink({ rawRetentionDays: 9999 }).shrink, [], '상한으로 잘린 늘리기');
  assert.deepEqual(S.retentionShrink({ store: { deviceMax: 8 } }).shrink, [], '보존이 아닌 store 칸');
  assert.deepEqual(S.retentionShrink({ store: { rawDays: '' } }).shrink, [], '빈 store 칸은 기본값(30 — 지금과 같다)');
  assert.deepEqual(S.retentionShrink({ corps: { vcA: false }, enabled: true }).shrink, []);
});
