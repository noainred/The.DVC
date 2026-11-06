/**
 * featureUsage2913.test.js — v2.913 설정 › 사용자 › 기능 사용 현황(사용자별 기능 사용 추적) 서버 회귀.
 * 설계 docs/design/feature-usage. 고정하는 것:
 *  ① 키 등록부 — 웹 App.jsx TABS · Settings.jsx SUB · console PAGES · usageTracker TOOL_SEGS 와 서버 usage/keys.js 가 같다(소스 대조)
 *  ② 설정 — 기본 켜짐(사용자 결정 '기본값 켜기') · 데모 계정 기본 제외 · 형식 400 · 켜고 끈 기록 · 손상 파일은 보존하고 꺼짐(fail-closed) + loadError
 *  ③ 수신 — 꺼짐이면 세지 않는다 · 계정은 req.user 만(본문 user 무시) · 데모/제외/모르는 키 버림 · 2초 안 같은 열람 1회 ·
 *     머문 조각 45초 상한 + 계정당 벽시계 상한 · 분당 상한
 *  ④ 집계 — 저장 전 메모리 분 포함 · 기록 꺼진 날은 'off'(0 아님) · 직전 기간 기록 없으면 비교 null · 미접속 계정 · 계정 출처
 *  ⑤ 라우트 — 수신은 viewer 도 200 · 조회 · 설정은 설정 소유자(소유자 ∧ 전체 범위)만 · 지우기는 OTP 재인증 · 감사 줄에 무엇이 어떻게(detail)
 *  ⑥ 미인증 /auth/config 는 문구 하나만(계정 · 수치 없음) · AUDIT_SKIP 등재 · 등록부(DB 목록 · 설명 · 설정 파일 분류)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu2913-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const WEB = path.join(HERE, '..', '..', 'web', 'src');
const read = (p) => fs.readFileSync(p, 'utf8');

const keys = await import('../src/usage/keys.js');
const settings = await import('../src/usage/settings.js');
const store = await import('../src/usage/store.js');
const db = await import('../src/usage/db.js');
const { DAY_MS, dayKey } = await import('../src/util/dayKey.js');

// 기준 시각 — 실제 시각에서 KST 정오로 떨어뜨려 고정(날 경계 근처에서 깨지지 않게 — docs/rules/common.md)
const NOW = (() => { const d = Math.floor((Date.now() + 9 * 3_600_000) / DAY_MS) * DAY_MS - 9 * 3_600_000; return d + 12 * 3_600_000; })();

function resetAll() {
  store._resetUsageStore();
  db._closeUsageDb();
  for (const f of fs.readdirSync(tmp)) if (/^usage/.test(f)) fs.rmSync(path.join(tmp, f), { force: true });
  settings._resetUsageSettingsCache();
}

test('① 키 등록부 — 웹 목록과 서버 목록이 같다', () => {
  const app = read(path.join(WEB, 'App.jsx'));
  const tabsSrc = app.slice(app.indexOf('const TABS = ['), app.indexOf('];', app.indexOf('const TABS = [')));
  const webTabs = [...tabsSrc.matchAll(/\{ id: '([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(webTabs, [...keys.TAB_KEYS].sort(), 'App.jsx TABS ↔ usage/keys.js TAB_KEYS');
  const st = read(path.join(WEB, 'views', 'Settings.jsx'));
  const subSrc = st.slice(st.indexOf('const SUB = ['), st.indexOf('\n];', st.indexOf('const SUB = [')));
  const webSubs = [...subSrc.matchAll(/\{ k: '([a-z0-9-]+)'/g)].map((m) => m[1]).sort();
  assert.ok(webSubs.includes('feature-usage'), '설정 하위에 기능 사용 현황이 있다');
  assert.deepEqual(webSubs, [...keys.SETTINGS_KEYS].sort(), 'Settings.jsx SUB ↔ usage/keys.js SETTINGS_KEYS');
  const con = read(path.join(WEB, 'console', 'DvcConsole.jsx'));
  const pages = (con.match(/const PAGES = \{([^}]*)\}/) || [])[1] || '';
  assert.deepEqual([...pages.matchAll(/(\w+):/g)].map((m) => m[1]).sort(), [...keys.CONSOLE_KEYS].sort(), 'console PAGES ↔ CONSOLE_KEYS');
  const tr = read(path.join(WEB, 'usageTracker.js'));
  assert.match(tr, /TOOL_SEGS = Object\.freeze\(\{ serveranalysis: \['baremetal'\] \}\)/, '웹 추적기 TOOL_SEGS 가 서버와 같다');
  assert.deepEqual(keys.TOOL_SEGS, { serveranalysis: ['baremetal'] });

  const ok = ['tab:vms', 'tab:overview', 'tool:vmfinder', 'tool:serveranalysis/baremetal', 'settings:audit', 'settings:feature-usage', 'console:compute'];
  for (const k of ok) assert.equal(keys.validUsageKey(k), true, k);
  const bad = ['', 'vms', 'tab:', 'tab:nope', 'tool:nope', 'tool:vmfinder/x', 'tool:serveranalysis/baremetal/x', 'settings:nope', 'console:nope',
    'x:y', 'tab:VMS', `tool:${'a'.repeat(100)}`, null, 42, { toString: () => 'tab:vms' }, 'constructor:x', 'tab:__proto__'];
  for (const k of bad) assert.equal(keys.validUsageKey(k), false, String(k));
});

test('② 설정 — 기본 켜짐 · 데모 제외 · 형식 400 · 켜고 끈 기록 · 손상은 꺼짐 + loadError', () => {
  resetAll();
  const d = settings.loadUsageSettings();
  assert.equal(d.enabled, true, '기본 켜짐(2026-11-06 사용자 결정)');
  assert.deepEqual(d.toggles, [], '켠 기록 없음 — 시작 시각은 집계가 가장 오래된 기록 날로 잡는다');
  assert.deepEqual(d.excluded, ['thedvcdemp']);
  assert.equal(settings.usageSettingsLoadError(), null);
  assert.throws(() => settings.saveUsageSettings({ idleMin: 0 }, 'o'), (e) => e.status === 400 && e.field === 'idleMin');
  assert.throws(() => settings.saveUsageSettings({ keepDays: 30 }, 'o'), (e) => e.status === 400 && e.field === 'keepDays');
  assert.throws(() => settings.saveUsageSettings({ excluded: ['a b'] }, 'o'), (e) => e.status === 400);
  assert.throws(() => settings.saveUsageSettings({ notice: 'x\u0001' }, 'o'), (e) => e.status === 400);
  const r = settings.saveUsageSettings({ enabled: false, idleMin: '10', keepDays: 365, toggles: [{ at: 1, on: true, by: 'evil' }] }, 'own', NOW - 1000);
  assert.equal(r.settings.enabled, false);
  assert.equal(r.settings.idleMin, 10);
  assert.deepEqual(r.settings.toggles, [{ at: NOW - 1000, on: false, by: 'own' }], '본문의 toggles 는 무시 · 끔 한 줄');
  assert.ok(r.changes.some((c) => /enabled true→false/.test(c)) && r.changes.some((c) => /idleMin 5→10/.test(c)));
  settings.saveUsageSettings({ enabled: true }, 'own', NOW - 500);
  const again = settings.saveUsageSettings({ enabled: true }, 'own', NOW);
  assert.equal(again.settings.toggles.length, 2, '같은 값이면 기록을 더하지 않는다');
  assert.deepEqual(again.changes, []);
  assert.match(settings.noticeText(), /365일 뒤 지워집니다/, '기본 문구는 보관 일수를 따른다');
  // 켜짐 구간
  assert.deepEqual(settings.onIntervals({ enabled: true, toggles: [{ at: 10, on: true }, { at: 20, on: false }, { at: 30, on: true }] }), [{ from: 10, to: 20 }, { from: 30, to: Infinity }]);
  assert.deepEqual(settings.onIntervals({ enabled: false, toggles: [] }), []);
  assert.deepEqual(settings.onIntervals({ enabled: true, toggles: [] }), [{ from: -Infinity, to: Infinity }], '시작을 모르면 지어내지 않는다');
  // 손상 → 보존 + 꺼짐
  fs.writeFileSync(path.join(tmp, 'usage-settings.json'), '{"enabled":true,');
  settings._resetUsageSettingsCache();
  assert.equal(settings.loadUsageSettings().enabled, false, '못 읽으면 꺼짐(fail-closed)');
  assert.ok(settings.usageSettingsLoadError(), 'loadError 가 선다');
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('usage-settings.json.corrupt.')), '손상본 보존');
  settings._resetUsageSettingsCache();
  assert.ok(settings.usageSettingsLoadError(), '재기동 뒤 보존본만 남아도 못 읽음을 말한다');
  for (const f of fs.readdirSync(tmp)) if (f.startsWith('usage-settings.json.corrupt.')) fs.rmSync(path.join(tmp, f));
});

test('③ 수신 — 꺼짐 · 계정 · 버림 · 중복 열람 · 머문 시간 상한 · 분당 상한', () => {
  resetAll();
  const u = { username: 'Alice', name: '앨리스', role: 'operator' };
  settings.saveUsageSettings({ enabled: false }, 'own', NOW - 120_000);
  assert.deepEqual(store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW }), { ok: false, reason: 'disabled' }, '끄면 세지 않는다');
  settings.saveUsageSettings({ enabled: true, excluded: ['thedvcdemp', 'Svc.Report'] }, 'own', NOW - 60_000);
  assert.equal(store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW }).counted, true);
  assert.equal(store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW + 1500 }).counted, false, '2초 안 같은 열람은 한 번');
  assert.equal(store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW + 2500 }).counted, true, '2초 뒤는 다시 센다');
  assert.equal(store.recordUsage({ user: { username: 'svc.report' }, k: 'tab:vms', hit: true, now: NOW }).reason, 'excluded', '제외는 대소문자 무시');
  assert.equal(store.recordUsage({ user: { username: 'thedvcdemp', demoGuest: true }, k: 'tab:vms', hit: true, now: NOW }).reason, 'excluded');
  assert.equal(store.recordUsage({ user: { username: 'demo2', demoGuest: true }, k: 'tab:vms', hit: true, now: NOW }).reason, 'excluded', '데모 표지면 이름과 무관하게 버림');
  assert.equal(store.recordUsage({ user: u, k: 'tab:nope', hit: true, now: NOW }).reason, 'unknown-key');
  assert.equal(store.recordUsage({ user: null, k: 'tab:vms', hit: true, now: NOW }).reason, 'no-user');
  // 머문 시간: 첫 조각 45초 상한, 다음은 직전 조각 뒤 흐른 시간까지
  const b = { username: 'bob', role: 'viewer' };
  store.recordUsage({ user: b, k: 'tab:hosts', ms: 60_000, now: NOW });
  store.recordUsage({ user: b, k: 'tab:hosts', ms: 30_000, now: NOW + 4_000 });   // 창 두 개 — 4초만
  store.recordUsage({ user: b, k: 'tab:hosts', ms: -5, now: NOW + 5_000 });
  store.recordUsage({ user: b, k: 'tab:hosts', ms: 'x', now: NOW + 6_000 });
  // 분당 상한
  const c = { username: 'carol', role: 'viewer' };
  let limited = 0;
  for (let i = 0; i < store.RATE_PER_MIN + 5; i++) if (store.recordUsage({ user: c, k: 'tab:alarms', ms: 1, now: NOW + 100 + i }).reason === 'rate-limited') limited++;
  assert.equal(limited, 5, '분당 상한을 넘는 신호는 버린다');
  return store.buildUsageReport({ days: 1, now: NOW + 10_000 }).then((r) => {
    const vms = r.byKey.find((x) => x.k === 'tab:vms');
    assert.equal(vms.views, 2);
    const hosts = r.byKey.find((x) => x.k === 'tab:hosts');
    assert.equal(hosts.views, 0);
    assert.equal(hosts.ms, store.BEAT_MAX_MS + 4_000, '조각 상한(45초) + 벽시계 상한');
    const alice = r.users.find((x) => x.user === 'alice');
    assert.ok(alice, '계정 키는 소문자');
    assert.equal(alice.name, '앨리스');
    assert.ok(!r.users.some((x) => x.user === 'svc.report' || x.user === 'thedvcdemp'));
  });
});

test('④ 집계 — 저장 · 메모리 합산 · 꺼진 날은 off · 직전 기간 · 미접속 계정', async () => {
  resetAll();
  // 3일 전 켬 → 2일 전 끔 → 어제 켬
  const day0 = NOW - 3 * DAY_MS;
  settings.saveUsageSettings({ enabled: false }, 'own', day0 - 2 * 3_600_000);
  settings.saveUsageSettings({ enabled: true }, 'own', day0 - 3_600_000);
  const u = { username: 'dave', role: 'admin' };
  store.recordUsage({ user: u, k: 'tool:vmfinder', hit: true, now: day0 });
  store.recordUsage({ user: u, k: 'tool:vmfinder', ms: 8000, now: day0 + 1000 });
  await store.flushUsage(day0 + 2000);
  assert.equal(store._pendingSize(), 0, '저장하면 비운다');
  // 3일 전 23:00 에 끄고 어제 11:00 에 켬 → 2일 전은 하루 종일 꺼짐
  settings.saveUsageSettings({ enabled: false }, 'own', day0 + 11 * 3_600_000);
  settings.saveUsageSettings({ enabled: true }, 'own', NOW - DAY_MS - 3_600_000);
  store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW });   // 저장 전(메모리)
  const r = await store.buildUsageReport({ days: 4, now: NOW + 1000 });
  assert.equal(r.range.days, 4);
  assert.equal(r.range.partialToday, true);
  assert.equal(r.byKey.find((x) => x.k === 'tool:vmfinder').views, 1);
  assert.equal(r.byKey.find((x) => x.k === 'tool:vmfinder').ms, 8000);
  assert.equal(r.byKey.find((x) => x.k === 'tab:vms').views, 1, '저장 전 메모리 분도 보인다');
  const recs = r.daily.map((d) => d.rec);
  assert.deepEqual(recs, ['part', 'off', 'part', 'on'], '켠 날 · 하루 종일 꺼진 날(off — 0 이 아니다) · 다시 켠 날 · 오늘(지금까지 켜짐)');
  assert.equal(r.totals.recDays, recs.filter((x) => x !== 'off').length);
  assert.ok(r.gaps.length >= 1 && r.gaps.some((g) => g.by === 'own'), '꺼짐 구간과 누가 껐는지');
  assert.equal(r.prev.available, false, '직전 기간에 기록이 없으면 비교하지 않는다');
  assert.equal(r.byKey[0].prevViews, null);
  assert.ok(r.idle.some((x) => x.user === 'admin'), '로컬 계정 중 미접속은 idle(시드 계정 admin)');
  assert.ok(!r.idle.some((x) => x.user === 'thedvcdemp'), '데모 · 제외 계정은 미접속 목록에도 없다');
  const dave = r.users.find((x) => x.user === 'dave');
  assert.equal(dave.src, 'ad', '계정 목록에 없는 이름은 AD 로 본다');
  assert.equal(dave.days, 2);
  assert.ok(Array.isArray(r.userKeys) && r.userKeys.some(([uu, k]) => uu === 'dave' && k === 'tab:vms'));
  // 개인 상세
  const one = await store.buildUserUsage({ user: 'DAVE', days: 4, now: NOW + 1000 });
  assert.equal(one.account.user, 'dave');
  assert.equal(one.totals.views, 2);
  assert.equal(one.totals.keys, 2);
  // CSV 행
  const rows = [];
  for await (const row of store.usageCsvRows({ days: 4, now: NOW + 1000 })) rows.push(row);
  assert.ok(rows.some((x) => x[1] === 'dave' && x[4] === 'tool:vmfinder' && x[5] === 1 && x[6] === 8));
  // 기간 검증
  assert.throws(() => store.resolveRange({ days: 0 }), (e) => e.status === 400);
  assert.throws(() => store.resolveRange({ days: 400 }), (e) => e.status === 400);
  assert.throws(() => store.resolveRange({ from: '2026-01-01', to: '2027-06-01' }), (e) => e.status === 400);
  assert.throws(() => store.resolveRange({ from: 'x', to: 'y' }), (e) => e.status === 400);
  // 지우기
  const p = await store.purgeUsageRecords({ scope: 'user', user: 'Dave' });
  assert.equal(p.ok, true);
  const after = await store.buildUsageReport({ days: 4, now: NOW + 1000 });
  assert.ok(!after.users.some((x) => x.user === 'dave'), '지운 계정은 집계에서 사라진다(메모리 분 포함)');
  assert.equal(dayKey(NOW), r.range.today);
});

test('④-2 기본 켜짐(켠 기록 없음) — 가장 오래된 기록 날 앞은 기록 시작 전(0 이 아니다) · 직전 기간 비교 없음', async () => {
  resetAll();
  assert.equal(settings.loadUsageSettings().enabled, true, '파일 없음 = 기본 켜짐');
  const u = { username: 'erin', role: 'viewer' };
  store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW - 2 * DAY_MS });
  await store.flushUsage(NOW - 2 * DAY_MS + 1000);
  store.recordUsage({ user: u, k: 'tab:vms', hit: true, now: NOW });
  const r = await store.buildUsageReport({ days: 5, now: NOW + 1000 });
  assert.deepEqual(r.daily.map((d) => d.rec), ['off', 'off', 'on', 'on', 'on'], '첫 기록 날부터 켜짐 — 그 앞은 off');
  assert.equal(r.totals.recDays, 3, '하루 평균의 분모는 기록한 날만');
  assert.equal(r.prev.available, false, '직전 기간은 기록 시작 전 — 비교하지 않는다(새로 · 0% 가 아니다)');
  assert.ok(r.gaps.length === 1 && r.gaps[0].beforeStart === true && r.gaps[0].by === null, '기록 시작 전 구간으로 밝힌다');
  // 저장 전(메모리)만 있어도 오늘은 켜짐
  resetAll();
  store.recordUsage({ user: u, k: 'tab:hosts', hit: true, now: NOW });
  const r2 = await store.buildUsageReport({ days: 2, now: NOW + 1000 });
  assert.deepEqual(r2.daily.map((d) => d.rec), ['off', 'on']);
  assert.equal(r2.byKey[0].views, 1);
});

/* ── ⑤ 라우트 ─────────────────────────────────────────────────────────── */
const USERS = {
  view: { username: 'view1', name: '뷰어', role: 'viewer', scope: null },
  own: { username: 'own1', role: 'admin', scope: null },
  adm: { username: 'adm2', role: 'admin', scope: null },
  scopedOwn: { username: 'own2', role: 'admin', scope: { vcenters: ['vc-x'], regions: [] } },
};
let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { adminRouter } = await import('../src/routes/admin.js');
  const { auditMiddleware } = await import('../src/audit.js');
  const sec = await import('../src/security/securitySettings.js');
  sec.saveSessionSecurity({ settingsOwners: ['own1', 'own2'] });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api/admin', auditMiddleware, adminRouter);
  app.use('/api', auditMiddleware, api);
  app.use((err, _req, res, _next) => { res.status(500).json({ error: 'internal', msg: err.message }); }); // eslint-disable-line no-unused-vars
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { try { srv?.close(); } catch { /* */ } store._resetUsageStore(); db._closeUsageDb(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, method, p, body) {
  const r = await fetch(base + p, { method, headers: { 'x-u': u, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* */ }
  return { s: r.status, j };
}

test('⑤ 라우트 — 수신은 viewer 도 · 계정은 req.user · 조회는 설정 소유자 ∧ 전체 범위 · 지우기는 OTP', async () => {
  resetAll();
  settings.saveUsageSettings({ enabled: true }, 'own1', Date.now() - 60_000);

  const t = await call('view', 'POST', '/usage/track', { k: 'tab:vms', hit: true, user: 'own1' });
  assert.equal(t.s, 200);
  assert.equal(t.j.counted, true);
  assert.equal((await call('view', 'POST', '/usage/track', { k: 'tab:bogus', hit: true })).j.reason, 'unknown-key');
  assert.equal((await call('view', 'POST', '/usage/track', [1, 2])).j.reason, 'unknown-key', '배열 본문은 빈 본문으로');

  // 조회: viewer 403 · 소유자 아닌 admin 403 · 범위 소유자 403 · 소유자 200
  assert.equal((await call('view', 'GET', '/admin/usage/report?days=7')).s, 403);
  assert.equal((await call('adm', 'GET', '/admin/usage/report?days=7')).s, 403);
  const sc = await call('scopedOwn', 'GET', '/admin/usage/report?days=7');
  assert.equal(sc.s, 403, '범위가 지정된 소유자는 403(전 법인 사용자의 기록)');
  const ok = await call('own', 'GET', '/admin/usage/report?days=7');
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
  const v1 = ok.j.users.find((x) => x.user === 'view1');
  assert.ok(v1 && v1.views === 1, '본문 user 가 아니라 req.user(view1)로 적었다');
  assert.ok(!ok.j.users.some((x) => x.user === 'own1'), '본문 계정명은 무시');
  assert.equal((await call('own', 'GET', '/admin/usage/report?days=999')).s, 400);
  assert.equal((await call('own', 'GET', '/admin/usage/user/view1?days=7')).j.totals.views, 1);
  for (const u of ['view', 'adm', 'scopedOwn']) {
    assert.equal((await call(u, 'GET', '/admin/usage/settings')).s, 403, `${u} 설정 조회 403`);
    assert.equal((await call(u, 'PUT', '/admin/usage/settings', { enabled: false })).s, 403, `${u} 설정 저장 403`);
    assert.equal((await call(u, 'POST', '/admin/usage/purge', { scope: 'all' })).s, 403, `${u} 지우기 403`);
  }
  // 설정 저장 — 감사 줄에 무엇이 어떻게
  const put = await call('own', 'PUT', '/admin/usage/settings', { idleMin: 7 });
  assert.equal(put.s, 200);
  assert.equal((await call('own', 'PUT', '/admin/usage/settings', { idleMin: 99 })).s, 400);
  const audit = fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const line = audit.find((e) => e.action === '기능 사용 기록 설정 변경');
  assert.ok(line && /idleMin 5→7/.test(line.detail), '감사 줄 detail 에 바뀐 값');
  assert.ok(!audit.some((e) => /usage\/track/.test(e.target)), '수신 신호는 감사 로그에 남지 않는다(AUDIT_SKIP)');
  const g = await call('own', 'GET', '/admin/usage/settings');
  assert.equal(g.j.settings.idleMin, 7);
  assert.ok(g.j.status && typeof g.j.status.received === 'number');

  // 지우기 — 소유자라도 OTP 가 없는 로컬 계정이 아니면(여기 own1 은 users.json 에 없다 → OTP 없는 계정 → 설정 소유자 통과)
  assert.equal((await call('own', 'POST', '/admin/usage/purge', { scope: 'nope' })).s, 400);
  assert.equal((await call('own', 'POST', '/admin/usage/purge', { scope: 'before', before: 'x' })).s, 400);
  const pg = await call('own', 'POST', '/admin/usage/purge', { scope: 'user', user: 'view1' });
  assert.equal(pg.s, 200, JSON.stringify(pg.j));
  const audit2 = fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(audit2.some((e) => e.action === '기능 사용 기록 삭제' && /범위 user view1 · \d+행/.test(e.detail)), '삭제 감사 줄에 범위 · 행 수');
  const after2 = await call('own', 'GET', '/admin/usage/report?days=7');
  assert.ok(!after2.j.users.some((x) => x.user === 'view1'));
});

test('⑤-2 지우기는 OTP 계정이면 본인 OTP 를 요구한다(reauth 미들웨어)', () => {
  const src = read(path.join(SRC, 'routes', 'admin', 'usage.js'));
  assert.match(src, /adminRouter\.post\('\/usage\/purge', \.\.\.gate, reauth,/, 'purge 는 게이트 뒤 reauth');
  assert.match(src, /const gate = \[adminOnly, requireSettingsOwner\]/);
  for (const r of ['/usage/report', '/usage/user/:user', '/usage/export.csv', '/usage/settings']) assert.ok(src.includes(`'${r}', ...gate`), r);
});

test('⑥ 미인증 응답 · 감사 제외 · 등록부', async () => {
  const auth = read(path.join(SRC, 'routes', 'auth.js'));
  assert.match(auth, /usageNotice: noticeText\(s\)/, '/auth/config 는 문구 하나만');
  const body = auth.slice(auth.indexOf('function usageNoticeField'), auth.indexOf('function usageTrackField'));
  assert.ok(!/username|excluded|views|count/.test(body), '미인증 고지 칸에 계정 · 수치를 싣지 않는다');
  const { auditSkipped } = await import('../src/audit.js');
  assert.equal(auditSkipped('POST', '/api/usage/track'), true);
  assert.equal(auditSkipped('POST', '/api/admin/usage/purge'), false, '지우기는 감사 대상');
  const { MIGRATABLE } = await import('../src/insights/dbLocation.js');
  assert.ok(MIGRATABLE.some((m) => m.file === 'usage.db'), 'DB 저장 경로 이전 대상');
  const { guideFor } = await import('../src/insights/dbGuide.js');
  assert.ok(guideFor('usage.db') && guideFor('usage-settings.json'), 'DB 설명');
  const portalDb = read(path.join(SRC, 'insights', 'portalDb.js'));
  assert.ok(portalDb.includes("'usage.db'") && portalDb.includes("'usage-settings.json'"), '포탈 DB 목록');
});
