/**
 * test/horizonIsiduAudit90.test.js — 전체 점검 90회차(Horizon · 현재 사용자 · 아이실론 디렉터리 사용량 2차) 확정분 회귀.
 *  F1 앱 사용 누적의 날짜별 '일부 수집' 판정이 서버 하나가 그날 한 번도 못 읽혀도(성공 횟수가 기대의 정확히 절반) 전체로 보던 것
 *  F2 앱 · 데스크톱 카탈로그 첫 조회가 전부 실패하면 성공처럼(at: now) 남아 6시간 동안 다시 읽지 않던 것
 *  F3 Horizon 실시간 사용자 · 현재 사용자 · 아이실론 설정의 **읽기 오류**(EISDIR — 운영의 EACCES · EIO)를 손상으로 보고 온전한 원본을 옮기던 것
 *     (+ Horizon · 현재 사용자 저장이 읽기 오류 중 기본값 위에 쓰던 것 — 409)
 *  F4 현재 사용자 '전체(합집합)' 가 Windows 쪽 일부 서버를 못 읽어도(값 오래됨 등) 하한 표지 없이 전체로 말하던 것
 *  F5 아이실론 종합 메일 since 가 미래(서버 시계가 뒤로 감)면 그 시각까지 기록도 없이 보내지 않던 것(대상별 정기 발송 SCHED-03 과 같은 꼴)
 *
 * ⚠ 기준 시각은 실제 시각에서 정시 경계로 떨어뜨려 고정한다(Date.now() 직접 · 고정 epoch 둘 다 깨진다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit90-'));
Object.assign(process.env, {
  CONFIG_DIR: TMP, DATA_SOURCE: 'live', AUTH_ENABLED: 'false',
  CURUSER_DB_PATH: path.join(TMP, 'curuser.db'), HZSESS_DB_PATH: path.join(TMP, 'horizon-sessions.db'),
});
delete process.env.CENTRAL_URL;
delete process.env.CENTRAL_TOKEN;
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ } });

const HOUR = 3_600_000;
const DAY = 86_400_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
const KST = 9 * HOUR;
const hhmm = (ms) => new Date(ms + KST).toISOString().slice(11, 16);
const quiet = async (fn) => { const w = console.warn; const e = console.error; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = e; } };

/* ─── F1 ─────────────────────────────────────────────────────────────── */
test('F1: 그날 시도했는데 한 번도 못 읽은 서버가 있으면 그날 사용자 수는 일부(지난 날 · 오늘 모두)', async () => {
  const { buildUsageReport, dayRange } = await import('../src/horizon/appUsageReport.js');
  const { dayKey } = await import('../src/util/dayKey.js');
  const { fromDay, toDay } = dayRange(2, BASE);
  const d0 = dayKey(BASE - DAY); const d1 = dayKey(BASE);
  const rep = buildUsageReport({
    pairs: [], userDays: [],
    daily: [{ day: d0, users: 5, services: 1 }, { day: d1, users: 3, services: 1 }],
    cover: [
      { day: d0, serverId: 'A', cycles: 288, okCycles: 288 }, { day: d0, serverId: 'B', cycles: 288, okCycles: 0 },
      { day: d1, serverId: 'A', cycles: 100, okCycles: 100 }, { day: d1, serverId: 'B', cycles: 100, okCycles: 0 },
    ],
  }, { fromDay, toDay, intervalMs: 300_000, servers: 2 });
  const [x0, x1] = rep.daily;
  assert.equal(x0.partial, true, '2대 중 1대가 하루 종일 실패 — 성공 횟수가 기대의 정확히 절반이라도 그날 값은 부분 합이다');
  assert.equal(x0.serversNoRead, 1);
  assert.equal(x1.partial, true, '오늘도 한 대를 한 번도 못 읽었으면 일부다(횟수 판정만 오늘을 뺀다)');
  assert.equal(rep.totals.daysPartial, 2);
  // 두 서버 모두 읽힌 날은 예전 그대로
  const ok = buildUsageReport({ pairs: [], userDays: [], daily: [{ day: d0, users: 5, services: 1 }],
    cover: [{ day: d0, serverId: 'A', cycles: 288, okCycles: 288 }, { day: d0, serverId: 'B', cycles: 288, okCycles: 280 }] },
  { fromDay, toDay, intervalMs: 300_000, servers: 2 });
  assert.equal(ok.daily[0].partial, false);
  assert.equal(ok.daily[0].serversNoRead, undefined);
});

/* ─── F2 ─────────────────────────────────────────────────────────────── */
test('F2: 카탈로그 첫 조회가 전부 실패하면 실패로 적어 30분 뒤 다시 읽는다(6시간 기다리지 않는다)', async () => {
  const { collectServerSessions, _resetCatalogsForTest, catalogDue, catalogInfo, CATALOG_RETRY_MS } = await import('../src/horizon/sessionCollect.js');
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const orig = globalThis.fetch;
  let catFail = true; let catCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/rest/login')) return json({ access_token: 't' });
    if (u.endsWith('/rest/logout')) return json({});
    if (u.includes('/inventory/v1/sessions')) return json([{ user_name: 'a', session_state: 'CONNECTED', application_pool_id: 'app-3' }]);
    if (/application-pools|desktop-pools|farms/.test(u)) { catCalls++; return catFail ? json({}, 503) : json([{ id: 'app-3', display_name: 'SAP GUI' }]); }
    return json({}, 404);
  };
  const SRV = { id: 'hz90', name: 'HZ', host: 'https://hz.example.com', username: 'u', password: 'p', domain: 'CORP', timeoutMs: 5_000 };
  try {
    _resetCatalogsForTest();
    const r1 = await collectServerSessions(SRV, { now: BASE });
    assert.equal(r1.ok, true, '카탈로그 실패가 세션 수집을 실패로 만들지 않는다');
    const info = catalogInfo('hz90');
    assert.equal(info.failedAt, BASE, '첫 실패도 실패로 적는다');
    assert.notEqual(info.at, BASE, '실패를 지금 읽은 성공으로 적으면 6시간(TTL) 동안 다시 읽지 않는다');
    assert.equal(catalogDue(info, BASE + CATALOG_RETRY_MS), true, '30분 뒤에는 다시 읽을 때다');
    catFail = false;
    const before = catCalls;
    const r2 = await collectServerSessions(SRV, { now: BASE + CATALOG_RETRY_MS });
    assert.ok(catCalls > before, '다시 읽었다');
    assert.equal(r2.usage.services[0].name, 'SAP GUI', '이름이 ID 로 남지 않는다');
  } finally { globalThis.fetch = orig; _resetCatalogsForTest(); }
});

/* ─── F3 ─────────────────────────────────────────────────────────────── */
const backups = (base) => fs.readdirSync(TMP).filter((x) => x.startsWith(`${base}.corrupt.`));

test('F3: Horizon 실시간 사용자 설정 — 읽기 오류는 원본을 옮기지 않고 저장 409 · 손상은 예전처럼 보존', async () => {
  const S = await import('../src/horizon/sessionSettings.js');
  const f = path.join(TMP, 'horizon-sessions.json');
  S._resetForTest();
  fs.mkdirSync(f); fs.writeFileSync(path.join(f, 'keep'), 'x');   // 읽기 단계 실패(EISDIR) — root 로 도는 시험이라 권한으로는 재현되지 않는다
  await quiet(() => {
    const s = S.load();
    assert.equal(s.enabled, false, '못 읽는 동안은 기본값(꺼짐)으로 돈다');
    assert.deepEqual(backups('horizon-sessions.json'), [], '읽기 오류는 손상이 아니다 — 원본을 옮기지 않는다');
    assert.ok(fs.existsSync(path.join(f, 'keep')), '원본 그대로');
    const e = S.horizonSessionSettingsLoadError();
    assert.equal(e?.readError, true, JSON.stringify(e));
    assert.throws(() => S.save({ enabled: true }), (err) => err.status === 409 && err.code === 'settings-unreadable', '기본값 위에 쓰지 않는다');
  });
  // 손상(파싱 실패)은 예전처럼 보존본으로 옮기고 관리자 저장이 푼다
  fs.rmSync(f, { recursive: true, force: true });
  fs.writeFileSync(f, '{ broken');
  S._resetForTest();
  await quiet(() => {
    assert.equal(S.load().enabled, false);
    assert.equal(backups('horizon-sessions.json').length, 1, '손상은 보존본으로');
    assert.equal(S.horizonSessionSettingsLoadError()?.readError, false);
    const v = S.save({ enabled: true, intervalMs: 600_000 });
    assert.equal(v.enabled, true);
    assert.equal(S.horizonSessionSettingsLoadError(), null, '관리자 저장이 손상 표지를 푼다');
  });
  S._resetForTest();
  assert.equal(S.load().intervalMs, 600_000, '저장한 값이 디스크에 있다');
});

test('F3: 현재 사용자 · 아이실론 설정 — 읽기 오류는 원본을 옮기지 않는다(현재 사용자 저장은 409)', async () => {
  const CU = await import('../src/curuser/settings.js');
  const IS = await import('../src/isidu/settings.js');
  const fc = path.join(TMP, 'curuser-settings.json');
  const fi = path.join(TMP, 'isidu-settings.json');
  for (const f of [fc, fi]) { fs.mkdirSync(f); fs.writeFileSync(path.join(f, 'keep'), 'x'); }
  CU._resetForTest(); IS._resetForTest();
  await quiet(() => {
    assert.equal(CU.load().enabled, false);
    assert.equal(CU.curUserSettingsLoadError()?.readError, true);
    assert.throws(() => CU.save({ enabled: true }), (err) => err.status === 409, '현재 사용자 저장은 읽기 오류 중 거절');
    assert.deepEqual(IS.loadSettings().targets, []);
    assert.equal(IS.isiduSettingsLoadError()?.readError, true, '아이실론 — 로드 오류(읽기)가 서므로 저장 라우트는 409 · 설정 pull 은 503');
  });
  assert.deepEqual(backups('curuser-settings.json'), [], '현재 사용자 원본을 옮기지 않는다');
  assert.deepEqual(backups('isidu-settings.json'), [], '아이실론 원본(대상 · 메일 설정)을 옮기지 않는다');
  for (const f of [fc, fi]) { assert.ok(fs.existsSync(path.join(f, 'keep'))); fs.rmSync(f, { recursive: true, force: true }); }
  // 읽기 오류가 풀리면(파일 정상) 다시 읽는다 — 캐시하지 않았다
  fs.writeFileSync(fc, JSON.stringify({ enabled: true, intervalMs: 1_200_000 }));
  fs.writeFileSync(fi, JSON.stringify({ targets: [], retentionDays: 200 }));
  assert.equal(CU.load().enabled, true, '현재 사용자 — 읽히면 바로 그 값');
  assert.equal(CU.curUserSettingsLoadError(), null);
  assert.equal(IS.isiduSettingsLoadError(), null, '아이실론 — 읽히면 오류가 풀린다');
  fs.rmSync(fc); fs.rmSync(fi); CU._resetForTest(); IS._resetForTest();
});

/* ─── F4 ─────────────────────────────────────────────────────────────── */
test('F4: 합집합 — Windows 쪽 일부 서버를 못 읽었으면(값 오래됨) 하한이고 그 사실을 비고로 말한다', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const { commitCurUser } = await import('../src/curuser/db.js');
  const now = Date.now();
  const rec = (vmId, kind, users) => ({ vmId, vcenterId: 'vc1', name: vmId, folder: '/f', ts: now, at: kind === 'ok' ? now - 60_000 : now - 5 * HOUR, kind, ok: kind === 'ok', active: users.length, disc: 0, other: 0, sessions: users.length, users: users.map((n) => ({ name: n, kind: 'active' })), error: '', guestHost: '' });
  const c = await commitCurUser({ ts: now, records: [rec('vm-1', 'ok', ['a']), rec('vm-2', 'stale', ['b', 'c']), rec('vm-3', 'no-agent', [])], series: [], replaceVcenters: ['vc1'] });
  assert.equal(c.ok, true);
  const app = express(); app.use(express.json()); app.use('/api', api);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  try {
    const j = await quiet(async () => (await fetch(`http://127.0.0.1:${srv.address().port}/api/tools/current-users/combined`)).json());
    assert.equal(j.sources.windows.state, 'ok');
    assert.equal(j.combined.union, 1);
    assert.equal(j.combined.unionLowerBound, true, '값이 오래된 서버의 사용자는 빠졌다 — 합집합은 하한');
    assert.ok(j.combined.lowerBoundSources.some((x) => x.key === 'windows'));
    assert.match(j.sources.windows.reason, /읽지 못한 서버 1대/, '발행기 없음(대상 아님)은 세지 않는다');
    assert.equal(j.sources.windows.detail.unread, 1);
  } finally { await new Promise((r) => srv.close(() => r())); }
});

/* ─── F5 ─────────────────────────────────────────────────────────────── */
test('F5: 종합 메일 since 가 미래(서버 시계가 뒤로 감)면 지금으로 잡고 다음 회차부터 보낸다(소급 없음)', async () => {
  const IS = await import('../src/isidu/settings.js');
  const D = await import('../src/isidu/digest.js');
  IS._resetForTest(); D._resetForTest();
  try { fs.rmSync(path.join(TMP, 'isidu-digest-state.json')); } catch { /* */ }
  fs.writeFileSync(path.join(TMP, 'isidu-settings.json'), JSON.stringify({
    targets: [], mail: { commonTo: [], digest: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: hhmm(BASE), since: BASE + 3 * DAY } },
  }));
  const t0 = await quiet(() => D.digestTick(BASE + 60_000));
  assert.equal(t0.action, 'none', '지금 회차는 소급해 보내지 않는다(since 를 지금으로 잡은 직후)');
  const t1 = await quiet(() => D.digestTick(BASE + DAY + 60_000));
  assert.equal(t1.action, 'send', '다음 날 회차는 보낸다 — 예전에는 미래 since(3일 뒤)까지 기록도 없이 멈췄다');
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'isidu-digest-state.json'), 'utf8'));
  assert.equal(st.sinceFrom, BASE + 3 * DAY, '설정 파일은 고치지 않고 상태에 보정을 남긴다');
  assert.equal(st.sinceCap, BASE + 60_000);
  const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'isidu-settings.json'), 'utf8'));
  assert.equal(raw.mail.digest.since, BASE + 3 * DAY, '설정 파일의 since 는 그대로');
  D._resetForTest(); IS._resetForTest();
});

/* ─── F6 ─────────────────────────────────────────────────────────────── */
test('F6: 엣지 아이실론 결과의 음수 크기 · 소요 · 개수는 받지 않는다(폴더 행과 같은 규칙 — 못 읽은 값 null)', async () => {
  const E = await import('../src/central/isiduEdge.js');
  const r = E.sanitizeIsiduScans({ scans: [{ targetId: 't1', ts: BASE, ok: true, entries: [['a', 10, 1]], total: { bytes: -5e12, res: 1 }, sumBytes: -3, sumRes: -1, durationMs: -100, skipped: -1, errLines: -2 }] }, new Set(['t1']), BASE);
  const sc = r.scans[0];
  assert.equal(sc.total, null, '음수 전체 합계는 못 읽은 값');
  for (const k of ['sumBytes', 'sumRes', 'durationMs', 'skipped', 'errLines']) assert.equal(sc[k], null, k);
  const ok = E.sanitizeIsiduScans({ scans: [{ targetId: 't1', ts: BASE, ok: true, entries: [], total: { bytes: '1024', res: 0 }, sumBytes: 0, durationMs: 1500, errLines: 0 }] }, new Set(['t1']), BASE).scans[0];
  assert.deepEqual(ok.total, { bytes: 1024, res: 1 }, '0 · 양수는 그대로(해상도는 1 이상)');
  assert.equal(ok.sumBytes, 0); assert.equal(ok.durationMs, 1500); assert.equal(ok.errLines, 0);
});
