/**
 * test/horizonUsage2684.test.js — Horizon 앱·데스크톱별 사용 집계(v2.684) 회귀 고정.
 *
 * 사용자 요청(2026-10-02): "커넥션 서버나 UAG 서버의 API 를 사용해서 어떤 사용자가 어떤 서비스를 사용하는지
 * 실시간·누적 집계" → 1단계(커넥션 서버 API).
 *
 * 이 기능의 위험:
 *  ① **어느 앱인지 모르는데 아는 척하는 것** — 팜에 앱이 여럿인데 하나를 골라 붙이면 오류 없이 틀린 값이다.
 *  ② **수집이 없던 날을 '사용자 0명' 으로 그리는 것** — 누적은 폴링 기반 하한이고, 수집 없음은 null 이다.
 *  ③ **같은 주기를 두 번 세는 것** — 같은 ts 재적재가 관측 횟수를 부풀리면 '사용 빈도' 가 거짓이 된다.
 *  ④ **카탈로그 조회가 로그인을 늘리는 것** — 세션 조회와 같은 로그인 안에서, 낡았을 때만 읽어야 한다.
 *
 * ⚠ 기준 시각은 정시 -30분으로 고정(CLAUDE.md v2.517 규칙).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const { resolveServices, usageFromSessions, normalizeCatalog, BASES, CATALOG_PATHS } = await import('../src/horizon/appUsage.js');
const { buildUsageReport, dayRange } = await import('../src/horizon/appUsageReport.js');
const { dayKey, DAY_MS } = await import('../src/util/dayKey.js');

const CAT = normalizeCatalog({
  apps: [
    { id: 'app-1', name: 'excel', display_name: 'Excel', farm_id: 'farm-A' },
    { id: 'app-2', name: 'word', display_name: 'Word', farm_id: 'farm-A' },
    { id: 'app-3', name: 'sap', display_name: 'SAP GUI', farm_id: 'farm-B' },
  ],
  desktops: [{ id: 'dp-1', name: 'win10', display_name: 'Win10 Desktop' }],
  farms: [{ id: 'farm-A', name: 'Office Farm' }, { id: 'farm-B', name: 'SAP Farm' }],
});

/* ─── ① 서비스 해석 ─────────────────────────────────────────────────────── */

test('해석: 세션의 앱 이름 필드가 있으면 그것이 먼저다', () => {
  const v = resolveServices({ application_names: ['Excel', 'Word'], farm_id: 'farm-A', session_type: 'APPLICATION' }, CAT);
  assert.deepEqual(v.map((x) => [x.kind, x.name, x.basis]), [['app', 'Excel', 'session-field'], ['app', 'Word', 'session-field']]);
});

test('해석: 앱 풀 ID → 카탈로그 표시 이름, 카탈로그에 없으면 ID 그대로(이름을 지어내지 않는다)', () => {
  assert.deepEqual(resolveServices({ application_pool_id: 'app-3' }, CAT).map((x) => [x.name, x.basis]), [['SAP GUI', 'app-pool']]);
  assert.deepEqual(resolveServices({ application_pool_id: 'app-zz' }, CAT).map((x) => [x.name, x.basis]), [['app-zz', 'app-pool-id']]);
});

test('★ 해석: 앱 세션이 팜만 알려 주면 — 앱이 하나인 팜은 그 앱, 여럿인 팜은 팜 단위(앱 미구분)', () => {
  const one = resolveServices({ farm_id: 'farm-B', session_type: 'APPLICATION' }, CAT);
  assert.deepEqual(one.map((x) => [x.kind, x.name, x.basis]), [['app', 'SAP GUI', 'farm-single-app']]);
  const many = resolveServices({ farm_id: 'farm-A', session_type: 'APPLICATION' }, CAT);
  assert.deepEqual(many.map((x) => [x.kind, x.name, x.basis]), [['farm', 'Office Farm', 'farm']],
    '앱이 둘인 팜에서 하나를 골라 붙이면 오류 없이 틀린 값이다');
  const unknownFarm = resolveServices({ farm_id: 'farm-Z', session_type: 'APPLICATION' }, CAT);
  assert.deepEqual(unknownFarm.map((x) => [x.kind, x.name, x.basis]), [['farm', 'farm-Z', 'farm-id']]);
});

test('해석: 데스크톱 풀 · 아무 근거 없음', () => {
  assert.deepEqual(resolveServices({ desktop_pool_id: 'dp-1', session_type: 'DESKTOP' }, CAT).map((x) => [x.kind, x.name]), [['desktop', 'Win10 Desktop']]);
  assert.deepEqual(resolveServices({ desktop_pool_id: 'dp-x' }, CAT).map((x) => x.basis), ['desktop-pool-id']);
  assert.deepEqual(resolveServices({}, CAT).map((x) => [x.kind, x.basis]), [['unknown', 'unknown']]);
});

test('해석: 같은 이름 앱은 팟(서버)이 달라도 같은 서비스 키다(사용자가 묻는 것은 서비스)', () => {
  const cat2 = normalizeCatalog({ apps: [{ id: 'other-pod-id', display_name: 'excel' }] });
  const a = resolveServices({ application_pool_id: 'app-1' }, CAT)[0].key;
  const b = resolveServices({ application_pool_id: 'other-pod-id' }, cat2)[0].key;
  assert.equal(a, b);
});

test('해석 근거 키 집합은 계약이다(웹 BASIS_TEXT 와 1:1 — 웹 테스트가 대조)', () => {
  assert.deepEqual([...BASES].sort(), ['app-pool', 'app-pool-id', 'desktop-pool', 'desktop-pool-id', 'farm', 'farm-id', 'farm-single-app', 'session-field', 'unknown']);
  assert.equal(CATALOG_PATHS.app[0], '/rest/inventory/v1/application-pools');
});

/* ─── ② 세션 → (사용자, 서비스) 쌍 ─────────────────────────────────────── */

test('쌍: 같은 사용자가 같은 서비스에 세션 둘이면 쌍 1개 · 서비스 사용자 1명', () => {
  const raw = [
    { user_name: 'CORP\\aaa', session_state: 'CONNECTED', application_pool_id: 'app-3' },
    { user_name: 'corp\\AAA', session_state: 'DISCONNECTED', application_pool_id: 'app-3' },
    { user_name: 'CORP\\bbb', session_state: 'DISCONNECTED', desktop_pool_id: 'dp-1' },
  ];
  const u = usageFromSessions(raw, { usedUserKey: 'user_name', usedStateKey: 'session_state', catalog: CAT });
  assert.equal(u.pairs.length, 2);
  const sap = u.services.find((s) => s.name === 'SAP GUI');
  assert.equal(sap.users, 1, '대소문자만 다른 계정은 같은 사람이다');
  assert.equal(sap.sessions, 2);
  assert.equal(sap.usersConnected, 1);
  const win = u.services.find((s) => s.name === 'Win10 Desktop');
  assert.equal(win.usersConnected, 0);
  assert.equal(u.basisCounts['app-pool'], 2);
});

test('쌍: 상태 필드를 못 읽으면 접속 중 수는 0 이 아니라 null', () => {
  const u = usageFromSessions([{ user_name: 'a', application_pool_id: 'app-1' }], { usedUserKey: 'user_name', usedStateKey: null, catalog: CAT });
  assert.equal(u.services[0].usersConnected, null);
  assert.equal(u.services[0].connectedSessions, null);
});

test('쌍: 계정 없는 세션은 쌍을 만들지 않고 개수를 밝힌다', () => {
  const u = usageFromSessions([{ application_pool_id: 'app-1', session_state: 'CONNECTED' }], { usedUserKey: 'user_name', usedStateKey: 'session_state', catalog: CAT });
  assert.equal(u.pairs.length, 0);
  assert.equal(u.sessionsNoUser, 1);
  assert.equal(u.services[0].sessions, 1);
});

/* ─── ③ DB 적재·조회·prune ────────────────────────────────────────────── */

test('★ DB: 일별 누적 — 같은 ts 재적재는 관측 횟수를 늘리지 않고, 실패 주기는 수집 횟수에만 남는다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hzusage-'));
  process.env.HZSESS_DB_PATH = path.join(dir, 'horizon-sessions.db');
  const db = await import(`../src/horizon/sessionDb.js?u=${Date.now()}`);
  try {
    const usage = usageFromSessions([
      { user_name: 'CORP\\aaa', session_state: 'CONNECTED', application_pool_id: 'app-1' },
      { user_name: 'CORP\\bbb', session_state: 'CONNECTED', desktop_pool_id: 'dp-1' },
    ], { usedUserKey: 'user_name', usedStateKey: 'session_state', catalog: CAT });
    const rec = (ts, ok = true) => ({ serverId: 'hz1', name: 'HZ', host: 'h', ok, kind: ok ? 'ok' : 'timeout', users: ok ? 2 : null, usage: ok ? usage : null, names: [], pools: [] });
    const t1 = NOW - 2 * HOUR; const t2 = NOW - HOUR;
    assert.equal((await db.commitHzSessions({ ts: t1, records: [rec(t1)] })).ok, true);
    await db.commitHzSessions({ ts: t1, records: [rec(t1)] });             // 같은 ts 재적재
    await db.commitHzSessions({ ts: t2, records: [rec(t2)] });
    await db.commitHzSessions({ ts: NOW, records: [rec(NOW, false)] });     // 실패 주기
    const day = dayKey(NOW);
    const r = await db.hzUsageRange({ fromDay: dayKey(t1), toDay: day });
    assert.equal(r.available, true);
    const aaa = r.pairs.find((p) => p.userKey === 'corp\\aaa');
    assert.equal(aaa.service, 'Excel');
    assert.equal(aaa.samples, 2, '같은 ts 를 다시 적재하면 관측 횟수가 부풀어 사용 빈도가 거짓이 된다');
    assert.equal(aaa.connectedSamples, 2);
    const cov = r.cover.filter((c) => c.serverId === 'hz1');
    assert.equal(cov.reduce((a, c) => a + c.cycles, 0), 3, '시도 3회(재적재 제외)');
    assert.equal(cov.reduce((a, c) => a + c.okCycles, 0), 2, '실패 주기는 성공 횟수에 들어가지 않는다');
    // 최신 레코드에 서비스 목록·해석 메타가 남는다(지금 접속 중 화면의 근거)
    const latest = await db.hzLatestRecords();
    assert.equal(latest[0].ok, false);
    // prune — 보존일 밖만 지운다
    const old = NOW - 50 * DAY_MS;
    await db.commitHzSessions({ ts: old, records: [rec(old)] });
    const pr = await db.pruneHzUsage(30, NOW);
    assert.equal(pr.skipped, false);
    const after = await db.hzUsageRange({ fromDay: dayKey(old), toDay: day });
    assert.ok(after.pairs.every((p) => p.firstTs >= NOW - 31 * DAY_MS), '보존일 밖 행이 남아 있다');
    assert.ok(after.pairs.length >= 2, '보존일 안의 행까지 지우면 안 된다');
    assert.equal(fs.statSync(process.env.HZSESS_DB_PATH).mode & 0o777, 0o600);
  } finally { db._resetForTest(); delete process.env.HZSESS_DB_PATH; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('DB: 예전 스키마(latest 에 services 열 없음)를 열면 열을 더하고 그대로 쓴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hzusage-old-'));
  const p = path.join(dir, 'horizon-sessions.db');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(p);
  old.exec(`CREATE TABLE latest (server_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', host TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL,
    ok INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'error', error TEXT NOT NULL DEFAULT '', users INTEGER, users_connected INTEGER,
    sessions INTEGER, connected INTEGER, disconnected INTEGER, pending INTEGER, state_unknown INTEGER, pages INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
    used_user_key TEXT NOT NULL DEFAULT '', used_state_key TEXT NOT NULL DEFAULT '', user_id_only INTEGER NOT NULL DEFAULT 0,
    users_omitted INTEGER NOT NULL DEFAULT 0, pools_omitted INTEGER NOT NULL DEFAULT 0, names TEXT NOT NULL DEFAULT '[]', pools TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER);
    INSERT INTO latest (server_id, ts) VALUES ('old', 1);`);
  old.close();
  process.env.HZSESS_DB_PATH = p;
  const db = await import(`../src/horizon/sessionDb.js?o=${Date.now()}`);
  try {
    const st = await db.hzSessionDbStatus();
    assert.equal(st.available, true, st.error);
    const rows = await db.hzLatestRecords();
    assert.deepEqual(rows[0].services, []);
    assert.deepEqual(rows[0].usageMeta, {});
  } finally { db._resetForTest(); delete process.env.HZSESS_DB_PATH; fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ─── ④ 보고서 ────────────────────────────────────────────────────────── */

test('★ 보고서: 수집이 없던 날은 0명이 아니라 null · 일부만 수집된 날은 partial', () => {
  const { fromDay, toDay } = dayRange(3, NOW);
  const d0 = dayKey(NOW - 2 * DAY_MS); const d1 = dayKey(NOW - DAY_MS); const d2 = dayKey(NOW);
  const rep = buildUsageReport({
    pairs: [
      { userKey: 'a', serviceKey: 'app:excel', user: 'A', service: 'Excel', kind: 'app', basis: 'app-pool', days: 2, firstTs: NOW - 2 * DAY_MS, lastTs: NOW },
      { userKey: 'b', serviceKey: 'app:excel', user: 'B', service: 'Excel', kind: 'app', basis: 'app-pool', days: 1, firstTs: NOW, lastTs: NOW },
      { userKey: 'a', serviceKey: 'desktop:win10', user: 'A', service: 'Win10', kind: 'desktop', basis: 'desktop-pool', days: 1, firstTs: NOW, lastTs: NOW },
    ],
    daily: [{ day: d0, users: 1, services: 1 }, { day: d2, users: 2, services: 2 }],
    userDays: [{ userKey: 'a', days: 2 }, { userKey: 'b', days: 1 }],
    cover: [{ day: d0, serverId: 'hz1', cycles: 10, okCycles: 10 }, { day: d2, serverId: 'hz1', cycles: 100, okCycles: 100 }],
  }, { fromDay, toDay, intervalMs: 300_000, servers: 1, liveServices: [{ key: 'app:excel', name: 'Excel', kind: 'app', usersConnected: 1, sessions: 1 }], liveServers: 1 });
  assert.equal(rep.daily.length, 3);
  const [x0, x1, x2] = rep.daily;
  assert.equal(x0.day, d0); assert.equal(x1.day, d1); assert.equal(x2.day, d2);
  assert.equal(x1.users, null, '수집이 없던 날을 0명으로 그리면 거짓 급락이다');
  assert.equal(x0.partial, true, '하루 288회 중 10회만 수집된 지나간 날은 일부');
  assert.equal(x2.partial, false, '오늘은 아직 끝나지 않았다');
  assert.equal(rep.totals.users, 2);
  assert.equal(rep.totals.daysNoData, 1);
  assert.equal(rep.totals.avgDailyUsers, 1, '오늘·수집 없는 날은 일평균 분모에서 뺀다');
  const ex = rep.services.find((s) => s.key === 'app:excel');
  assert.equal(ex.users, 2); assert.equal(ex.userDays, 3); assert.equal(ex.connectedUsersNow, 1);
  const a = rep.users.find((u) => u.key === 'a');
  assert.equal(a.days, 2, '사용자 사용 일수는 서비스별 일수의 합이 아니라 고유 날짜 수');
  assert.equal(a.services.length, 2);
  assert.equal(rep.lowerBound, true);
});

test('보고서: 지금만 보이는 서비스(누적에 아직 없음)도 표에 나온다', () => {
  const { fromDay, toDay } = dayRange(1, NOW);
  const rep = buildUsageReport({ pairs: [], daily: [], userDays: [], cover: [] }, { fromDay, toDay, intervalMs: 300_000, liveServices: [{ key: 'app:x', name: 'X', kind: 'app', usersConnected: null, sessions: 2 }], liveServers: 1 });
  assert.equal(rep.services.length, 1);
  assert.equal(rep.services[0].connectedUsersNow, null);
  assert.equal(rep.daily[0].users, null);
});

/* ─── ⑤ 수집: 카탈로그는 같은 로그인 안에서, 낡았을 때만 ───────────────── */

const { collectServerSessions, _resetCatalogsForTest, catalogDue, CATALOG_RETRY_MS, catalogInfo } = await import('../src/horizon/sessionCollect.js');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function stubFetch(handler) {
  const orig = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method || 'GET' }); return handler(String(url), opts); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const SRV = { id: 'hzU', name: 'HZ', host: 'https://hz.example.com', username: 'u', password: 'p', domain: 'CORP', timeoutMs: 5_000 };

test('★ 수집: 카탈로그를 세션과 같은 로그인에서 읽고(404 면 다음 경로) 서비스 이름을 붙인다 · 다음 주기는 다시 읽지 않는다', async () => {
  _resetCatalogsForTest();
  const s = stubFetch((url) => {
    if (url.endsWith('/rest/login')) return json({ access_token: 't' });
    if (url.endsWith('/rest/logout')) return json({});
    if (url.includes('/inventory/v1/sessions')) return json([{ user_name: 'CORP\\aaa', session_state: 'CONNECTED', session_type: 'APPLICATION', farm_id: 'farm-B' }]);
    if (url.includes('/inventory/v1/application-pools')) return json([{ id: 'app-3', display_name: 'SAP GUI', farm_id: 'farm-B' }]);
    if (url.includes('/inventory/v1/desktop-pools')) return json({ error: 'nope' }, 404);
    if (url.includes('/inventory/v13/desktop-pools')) return json([{ id: 'dp-1', display_name: 'Win10' }]);
    if (url.includes('/inventory/v1/farms')) return json([{ id: 'farm-B', name: 'SAP Farm' }]);
    return json({}, 404);
  });
  try {
    const r = await collectServerSessions(SRV, { now: NOW });
    assert.equal(r.ok, true);
    assert.equal(s.calls.filter((c) => c.url.endsWith('/rest/login')).length, 1, '카탈로그 때문에 로그인이 늘면 고RTT 법인 비용과 AD 감사 로그가 늘어난다');
    assert.deepEqual(r.usage.services.map((x) => [x.name, x.basis]), [['SAP GUI', 'farm-single-app']]);
    assert.equal(r.catalog.usedPaths.desktop, '/rest/inventory/v13/desktop-pools', '어느 경로로 읽었는지 보고한다');
    const before = s.calls.length;
    const r2 = await collectServerSessions(SRV, { now: NOW + 10 * 60_000 });
    const catCalls = s.calls.slice(before).filter((c) => /application-pools|desktop-pools|farms/.test(c.url));
    assert.equal(catCalls.length, 0, '카탈로그는 TTL 안에서 다시 읽지 않는다');
    assert.equal(r2.usage.services[0].name, 'SAP GUI');
  } finally { s.restore(); _resetCatalogsForTest(); }
});

test('수집: 카탈로그 조회가 실패해도 세션 결과는 쓰고, 직전 카탈로그를 지우지 않으며, 30분 뒤에만 다시 시도한다', async () => {
  _resetCatalogsForTest();
  let fail = false;
  const s = stubFetch((url) => {
    if (url.endsWith('/rest/login')) return json({ access_token: 't' });
    if (url.endsWith('/rest/logout')) return json({});
    if (url.includes('/inventory/v1/sessions')) return json([{ user_name: 'a', session_state: 'CONNECTED', application_pool_id: 'app-3' }]);
    if (/application-pools|desktop-pools|farms/.test(url)) return fail ? json({}, 500) : json([{ id: 'app-3', display_name: 'SAP GUI' }]);
    return json({}, 404);
  });
  try {
    await collectServerSessions(SRV, { now: NOW });
    fail = true;
    const late = NOW + 7 * HOUR;          // TTL(6시간) 지남 → 다시 읽다 실패
    const r = await collectServerSessions(SRV, { now: late });
    assert.equal(r.ok, true, '카탈로그 실패가 세션 수집을 실패로 만들면 안 된다');
    assert.equal(r.usage.services[0].name, 'SAP GUI', '직전 카탈로그를 지우면 그날 누적이 이름·ID 두 서비스로 갈라진다');
    assert.ok(r.catalog.errors.app, '실패 사유를 보고한다');
    assert.equal(catalogInfo('hzU').at, NOW, '실패를 새 성공으로 기록하면 화면이 낡은 목록을 방금 읽은 것처럼 말하고 6시간 동안 다시 시도하지 않는다');
    assert.equal(catalogInfo('hzU').failedAt, late);
    const prev = { at: NOW, failedAt: late };
    assert.equal(catalogDue(prev, late + CATALOG_RETRY_MS - 1), false, '실패 뒤 매 주기 같은 오류를 되풀이하지 않는다');
    assert.equal(catalogDue(prev, late + CATALOG_RETRY_MS), true);
  } finally { s.restore(); _resetCatalogsForTest(); }
});

/* ─── ⑥ 라우트 계약(소스) ──────────────────────────────────────────────── */

test('라우트: 조회는 tools + 범위 계정 거절, CSV 는 data.csv 게이트 + 감사 로그', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/horizonSessions.js', import.meta.url), 'utf8');
  assert.match(src, /api\.get\('\/tools\/horizon-sessions\/usage', requirePerm\('tools'\), async \(req, res\) => \{\s*if \(denyScoped\(req, res\)\) return;/);
  assert.match(src, /api\.get\('\/tools\/horizon-sessions\/usage\.csv', requirePerm\('data\.csv'\), async \(req, res\) => \{\s*if \(denyScoped\(req, res\)\) return;/);
  assert.match(src, /action: 'horizon\.usage\.export'/);
  assert.match(src, /USAGE_MAX_DAYS = 92/, '긴 기간은 행 수 비례 동기 집계가 된다(v2.672·v2.675)');
});
