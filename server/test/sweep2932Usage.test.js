/**
 * sweep2932Usage.test.js — v2.932 최근 변경 점검 확정분(묶음 usage-login: C1-01 ~ C1-04) 서버 회귀.
 *  C1-01 기능 사용 기록 보관 정리는 기록 켜짐 · 신호와 무관하게 돈다 — 모듈 로드 때 unref 타이머 · `(++pruneTick % N) === 0`(첫 틱 금지) ·
 *        DB 파일이 없으면 만들지 않는다 · 설정을 못 읽으면 지우지 않는다.
 *  C1-02 정리 · '이전 기록 지우기' 가 마지막 사용이 그 앞인 계정(fu_user)도 지운다 — 퇴사자가 '미사용 계정' 목록에 영구히 남지 않는다.
 *  C1-03 login-history.ndjson 이 없는 첫 기동의 첫 로그인(실제 POST /api/auth/login)이 1회로 세진다(감사 로그 backfill 이 방금 쓴 줄을 빼고 옮긴다).
 *  C1-04 범위 관리자의 로그인 기록 · 감사 로그 403 본문에 requiredOwner 가 없다(화면이 '소유자 목록에 등록' 이라는 틀린 조치를 말하지 않는다).
 * 기준 시각은 실제 시각을 정시 경계로 떨어뜨려 고정한다(docs/rules/common.md).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw2932u-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
delete process.env.TRUST_PROXY;

// C1-01: store.js 가 **모듈 로드 때** 만드는 타이머를 잡는다(신호를 하나도 보내기 전).
const realSetInterval = globalThis.setInterval;
const made = [];
globalThis.setInterval = (fn, ms, ...a) => {
  const h = realSetInterval(fn, ms, ...a);
  const rec = { fn, ms, unref: false };
  const orig = h.unref?.bind(h);
  h.unref = () => { rec.unref = true; return orig ? orig() : h; };
  made.push(rec);
  return h;
};
const settings = await import('../src/usage/settings.js');
const db = await import('../src/usage/db.js');
const store = await import('../src/usage/store.js');
globalThis.setInterval = realSetInterval;
const { DAY_MS, dayKey } = await import('../src/util/dayKey.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const SETTINGS_FILE = path.join(tmp, 'usage-settings.json');
const DB_FILE = path.join(tmp, 'usage.db');
const OLD_DAY = dayKey(NOW - 200 * DAY_MS);
const NEW_DAY = dayKey(NOW - 2 * DAY_MS);

after(() => {
  try { store._resetUsageStore(); db._closeUsageDb(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
});

function resetUsage() {
  store._resetUsageStore();
  db._closeUsageDb();
  for (const f of fs.readdirSync(tmp)) if (/^usage/.test(f)) fs.rmSync(path.join(tmp, f), { force: true });
  settings._resetUsageSettingsCache();
}
const writeSettings = (o) => { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(o)); settings._resetUsageSettingsCache(); };
const offSettings = () => writeSettings({ enabled: false, keepDays: 90, toggles: [{ at: NOW - 300 * DAY_MS, on: true, by: 'o' }, { at: NOW - 100 * DAY_MS, on: false, by: 'o' }] });
async function seedRows() {
  const oldTs = NOW - 200 * DAY_MS; const newTs = NOW - 2 * DAY_MS;
  const r = await db.writeBatch(
    [{ day: OLD_DAY, user: 'leaver', k: 'tab:vms', views: 9, ms: 5000, last: oldTs }, { day: NEW_DAY, user: 'stay', k: 'tab:hosts', views: 2, ms: 1000, last: newTs }],
    [{ user: 'leaver', name: '퇴사자', role: 'operator', scoped: false, src: 'ad', last: oldTs }, { user: 'stay', name: '재직자', role: 'viewer', scoped: false, src: 'ad', last: newTs }],
  );
  assert.equal(r.ok, true, JSON.stringify(r));
}
const users = async () => ((await db.knownUsers()) || []).map((u) => u.user).sort();
const pruneTimer = () => made.find((m) => m.ms === store.FLUSH_MS && /usagePruneTick/.test(String(m.fn)));

test('C1-01 ① 모듈 로드 때 정리 타이머(60초 · unref)가 생긴다 — 신호를 받기 전에', () => {
  const t = pruneTimer();
  assert.ok(t, `store.js 로드 때 정리 타이머가 있어야 한다(만든 간격: ${JSON.stringify(made.map((m) => m.ms))})`);
  assert.equal(t.unref, true, 'unref — 정리 타이머가 프로세스 종료를 막지 않는다');
});

test('C1-01 ② 기록 꺼짐이어도 정리 틱이 보관 기간 밖 일 집계를 지운다 · 첫 틱(59번째까지)에는 지우지 않는다', async () => {
  resetUsage();
  offSettings();
  assert.equal(settings.loadUsageSettings().enabled, false);
  await seedRows();
  assert.equal(store.recordUsage({ user: { username: 'bob', role: 'viewer' }, k: 'tab:vms', hit: true }).reason, 'disabled', '꺼짐 — 신호는 받지 않는다');
  const fire = pruneTimer().fn;   // 실제 타이머 콜백 그대로
  for (let i = 1; i < store.PRUNE_EVERY; i++) await fire();
  assert.equal((await db.dayRows(OLD_DAY)).length, 1, `${store.PRUNE_EVERY - 1}틱까지는 지우지 않는다(기동 첫 틱 금지)`);
  assert.equal((await store.usageStatus()).lastPrune, null, '정리 전에는 lastPrune 이 없다');
  await fire();
  assert.equal((await db.dayRows(OLD_DAY)).length, 0, '보관 기간(90일) 밖 일 집계를 지웠다 — 기록이 꺼져 있어도');
  assert.equal((await db.dayRows(NEW_DAY)).length, 1, '보관 기간 안은 남는다');
  const st = await store.usageStatus();
  assert.equal(st.lastPrune.ok, true);
  assert.equal(st.lastPrune.deleted, 1);
});

test('C1-01 ③ DB 파일이 없으면 정리 틱이 DB 를 새로 만들지 않는다', async () => {
  resetUsage();
  offSettings();
  assert.equal(fs.existsSync(DB_FILE), false);
  let last = null;
  for (let i = 0; i < store.PRUNE_EVERY; i++) last = await store.usagePruneTick(NOW);
  assert.equal(last.reason, 'no-db');
  assert.equal(fs.existsSync(DB_FILE), false, '켠 적 없는 노드에 빈 usage.db 를 만들지 않는다');
});

test('C1-01 ④ 설정을 못 읽었으면(손상) 지우지 않는다 — 실제 보관 일수를 모른다', async () => {
  resetUsage();
  offSettings();
  await seedRows();
  fs.writeFileSync(SETTINGS_FILE, '{ 깨진 json');
  settings._resetUsageSettingsCache();
  assert.ok(settings.usageSettingsLoadError(), '못 읽음 표지가 선다');
  let last = null;
  for (let i = 0; i < store.PRUNE_EVERY; i++) last = await store.usagePruneTick(NOW);
  assert.equal(last.reason, 'settings-unreadable');
  assert.equal((await db.dayRows(OLD_DAY)).length, 1, '못 읽은 설정(기본값 keepDays)으로 추측해 지우지 않는다');
  for (const f of fs.readdirSync(tmp)) if (/^usage-settings\.json/.test(f)) fs.rmSync(path.join(tmp, f), { force: true });
});

test('C1-02 ① 정리가 마지막 사용이 보관 기간 밖인 계정(fu_user)도 지운다 → 보고서 미사용 목록에서 빠진다', async () => {
  resetUsage();
  writeSettings({ enabled: true, keepDays: 90 });
  await seedRows();
  assert.deepEqual(await users(), ['leaver', 'stay']);
  const before = await store.buildUsageReport({ days: 30, now: NOW });
  assert.ok(before.idle.some((a) => a.user === 'leaver'), '정리 전에는 퇴사자가 미사용 목록에 있다(대조)');
  const r = await db.pruneUsage(dayKey(NOW - 90 * DAY_MS));
  assert.equal(r.deleted, 1);
  assert.equal(r.users, 1, '계정 1개(leaver)를 지웠다');
  assert.deepEqual(await users(), ['stay'], '보관 기간 안에서 쓴 계정은 남는다');
  const rep = await store.buildUsageReport({ days: 30, now: NOW });
  assert.ok(!rep.idle.some((a) => a.user === 'leaver'), '퇴사자가 이름 · 마지막 사용 시각과 함께 남지 않는다');
  assert.ok(rep.users.some((a) => a.user === 'stay' && a.name === '재직자'), '보관 기간 안에서 쓴 계정은 이름과 함께 그대로');
});

test('C1-02 ② 이전 기록 지우기(scope=before)도 그 날 앞에서 마지막으로 쓴 계정을 지운다 — 메모리에 모아 둔 계정 칸까지', async () => {
  resetUsage();
  writeSettings({ enabled: true, keepDays: 90 });
  await seedRows();
  // 아직 저장하지 않은 신호 — 마지막 사용이 20일 전(지울 날 앞)인 계정과 오늘인 계정
  assert.equal(store.recordUsage({ user: { username: 'pend-old', role: 'viewer' }, k: 'tab:vms', hit: true, now: NOW - 20 * DAY_MS }).counted, true);
  assert.equal(store.recordUsage({ user: { username: 'pend-new', role: 'viewer' }, k: 'tab:vms', hit: true, now: NOW }).counted, true);
  const p = await store.purgeUsageRecords({ scope: 'before', before: dayKey(NOW - 10 * DAY_MS) });
  assert.equal(p.ok, true);
  assert.equal(p.users, 1, 'DB 의 leaver(200일 전) 계정을 지웠다 — stay(2일 전)는 남는다');
  await store.flushUsage(NOW + 1000);
  assert.deepEqual(await users(), ['pend-new', 'stay'], '지운 날 앞의 메모리 계정 칸(pend-old)이 다음 저장에서 되살아나지 않는다');
});

/* ── C1-03 로그인 기록 — 실제 POST /api/auth/login ─────────────────────────── */

const LH_FILE = path.join(tmp, 'login-history.ndjson');
const AUDIT = path.join(tmp, 'audit.ndjson');
const lhRows = () => { try { return fs.readFileSync(LH_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

test('C1-03 login-history.ndjson 이 없는 첫 기동의 첫 로그인은 1회다(감사 로그 backfill 이 방금 쓴 그 줄을 빼고 옮긴다)', async () => {
  const express = (await import('express')).default;
  const lh = await import('../src/security/loginHistory.js');
  const auth = await import('../src/auth/auth.js');
  const made2 = auth.createUser({ username: 'sw-op', role: 'viewer', name: 'Op', password: 'Sw!2932-pass-word' }, { trusted: true });
  assert.equal(made2.ok, true, JSON.stringify(made2));
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const iso = (ms) => new Date(ms).toISOString();
  const login = async () => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sw-op', password: 'Sw!2932-pass-word' }),
    });
    assert.equal(r.status, 200, await r.text());
  };
  try {
    // ⓐ 업그레이드 직후 — 기록 파일 없음 · 감사 로그에는 다른 계정의 예전 로그인 한 줄
    fs.writeFileSync(AUDIT, JSON.stringify({ at: iso(NOW - 3 * DAY_MS), user: 'kim', action: '로그인', detail: 'admin', ip: '10.0.0.1' }) + '\n');
    try { fs.rmSync(LH_FILE); } catch { /* */ }
    lh._resetLoginHistoryForTest();
    assert.equal(fs.existsSync(LH_FILE), false);
    await login();
    let s = lh.loginHistorySummary({});
    const me = s.users.find((u) => u.user === 'sw-op');
    assert.equal(me.total, 1, '로그인 1회 → 1회(예전: 2회)');
    assert.equal(me.d1, 1);
    assert.equal(s.backfilled, 1, '감사 로그의 예전 로그인(kim)은 그대로 옮겨 온다');
    assert.deepEqual(lhRows().map((r) => [r.user, r.src]), [['kim', ''], ['sw-op', 'local']], '같은 로그인이 src \'\' · local 두 줄로 남지 않는다');

    // ⓑ 같은 계정의 예전 로그인(2일 전)은 감사 로그에서 옮겨 오고, 지금 로그인만 뺀다
    fs.writeFileSync(AUDIT, [
      { at: iso(NOW - 3 * DAY_MS), user: 'kim', action: '로그인', detail: 'admin', ip: '10.0.0.1' },
      { at: iso(NOW - 2 * DAY_MS), user: 'sw-op', action: '로그인', detail: 'viewer', ip: '127.0.0.1' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    fs.rmSync(LH_FILE);
    lh._resetLoginHistoryForTest();
    await login();
    s = lh.loginHistorySummary({});
    const me2 = s.users.find((u) => u.user === 'sw-op');
    assert.equal(me2.total, 2, '2일 전 1회 + 지금 1회');
    assert.equal(me2.d1, 1, '최근 1일은 지금 로그인 1회');
    assert.equal(s.backfilled, 2, '예전 줄 2개(kim · sw-op 2일 전)는 옮겨 온다');
  } finally { srv.close(); }
});

/* ── C1-04 범위 관리자 403 본문 ─────────────────────────────────────────── */

test('C1-04 범위 관리자의 로그인 기록 · 감사 로그 403 은 requiredOwner 없이 범위 사유만 — 화면은 범위 안내', async () => {
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const { describePermission } = await import('../../web/src/components/accessDeniedText.js');
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => {
    req.user = req.headers['x-u'] === 'scoped'
      ? { username: 'noainred2', role: 'admin', scope: { vcenters: ['vc-pl'] } }
      : { username: 'full', role: 'admin', scope: null };
    n();
  });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async (who, p) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin${p}`, { headers: { 'x-u': who } });
    let j = null; try { j = await r.json(); } catch { /* */ }
    return { s: r.status, j };
  };
  try {
    for (const p of ['/login-history', '/audit']) {
      const d = await get('scoped', p);
      assert.equal(d.s, 403, `${p} 범위 관리자 403`);
      assert.equal(d.j.error, 'forbidden');
      assert.equal(d.j.requiredOwner, undefined, `${p}: '설정 소유 계정 목록에 등록' 이라는 틀린 조치를 싣지 않는다`);
      assert.match(d.j.reason, /전체 범위/);
      assert.equal(describePermission({ requiredOwner: !!d.j.requiredOwner, body: d.j }).kind, 'scope', `${p}: 화면 안내는 범위`);
      assert.equal((await get('full', p)).s, 200, `${p} 전체 범위 관리자 200(대조)`);
    }
  } finally { srv.close(); }
  // 아키텍처 점검(archScan)이 게이트를 전체 범위로 알아보는 태그
  for (const p of ['/login-history', '/audit']) {
    const layer = adminRouter.stack.find((l) => l.route?.path === p && l.route.methods.get);
    assert.ok(layer, p);
    assert.ok(layer.route.stack.some((s) => s.handle?.gate?.kind === 'fullScope'), `${p}: fullScopeOnlyWith 게이트`);
  }
});
