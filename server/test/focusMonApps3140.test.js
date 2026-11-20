/**
 * test/focusMonApps3140.test.js — v3.14.0 서버 집중 모니터링 ‘앱 단위 묶음’(시안 ⑮ Apps · 사용자 "기본값대로 모두 구현해줘").
 * 컨펌 기본값: ① 서비스(systemd) 기준 · 프로그램 이름은 단추 ② 프로세스 탭은 상위 30 그대로 · 앱 단위는 단추 ③ 분마다 상위 20 · 30일 ④ 사용자 지정 묶음 없음.
 *
 *  ① 묶기 코어(rates) — 서비스 · 세션 · 커널 스레드 · 서비스 없음 · 프로그램 이름 * · 합 · 디스크 읽기(모두 · 일부 · 못 읽음) · 서비스 지도 없음 · 지도 뒤 시작한 프로세스
 *  ② 기록 — 메모리 표본에는 표본마다 · DB 묶음에는 그 분의 마지막 표본에만
 *  ③ 엣지 정제 — 아는 칸만 · 이름 규칙 · 상한 · 음수 · 글자
 *  ④ 조회(apps.js) — 끝 순간 · 평균 · 펼침(같은 열쇠) · 쌓은 영역(위 5개 이름 순 · 나머지 · 빈 칸 null)
 *  ⑤ 라우트 — 조회 문 · 사용자 이름 가림 · 기준 단추
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('focusmonapps3140-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-apps-3140';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-apps-3140-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const R = await import('../src/focusmon/rates.js');
const store = await import('../src/focusmon/store.js');
const db = await import('../src/focusmon/db.js');
const CODEC = await import('../src/focusmon/codec.js');
const A = await import('../src/focusmon/apps.js');
const Q = await import('../src/focusmon/query.js');
const edge = await import('../src/central/focusMonEdge.js');
const mock = await import('../src/focusmon/mock.js');
after(() => { try { db._resetForTest(); } catch { /* */ } });

const P = (pid, ticks, comm, o = {}) => ({ pid, ticks, thr: o.thr ?? 1, start: o.start ?? 10, rss: o.rss ?? 256, comm, ppid: o.ppid ?? 1, ut: null, st: null, ni: null, vsz: null, mf: null, bio: null, state: 'S' });

/* ── ① ── */
test('① 묶기 코어 — 서비스 · 세션 · 커널 스레드 · 서비스 없음 · 프로그램 이름 · 합 · 디스크 읽기', () => {
  assert.equal(R.appServiceKey('oracle-db.service', 1, 100), 'oracle-db.service');
  assert.equal(R.appServiceKey('session-12.scope', 1, 100), R.APP_SESSION);
  assert.equal(R.appServiceKey('docker-ab12.scope', 1, 100), 'docker-ab12.scope');
  assert.equal(R.appServiceKey(null, 2, 50), R.APP_KERNEL);
  assert.equal(R.appServiceKey(null, 0, 2), R.APP_KERNEL, 'kthreadd 자신');
  assert.equal(R.appServiceKey(null, 1, 300), R.APP_NOSVC);
  assert.equal(R.appNameOf('ora_p001_ORCL'), 'ora_p*_ORCL');
  const prev = [P(1, 100, 'systemd', { ppid: 0 }), P(2, 0, 'kthreadd', { ppid: 0 }), P(50, 0, 'kworker_0:1', { ppid: 2 }),
    P(100, 1000, 'ora_p001', { thr: 10, rss: 2560 }), P(101, 500, 'ora_p007', { thr: 5, rss: 2560 }), P(200, 10, 'bash'), P(300, 0, 'late', { start: 99_999 })];
  const cur = prev.map((p) => ({ ...p, ticks: p.ticks + ({ 100: 200, 101: 100, 200: 10 }[p.pid] || 0) }));
  cur.push(P(400, 5, 'newproc', { start: 90 })); // 앞 표본에 없던 프로세스 — CPU 는 모르지만 수 · 메모리에는 든다
  const units = new Map([[1, 'init.scope'], [100, 'oracle-db.service'], [101, 'oracle-db.service'], [200, 'session-3.scope'], [300, 'old.service']]);
  const io = new Map([[100, { r: 10 * 1048576, w: 0 }], [101, { r: 0, w: 2 * 1048576 }], [200, { r: 0, w: 0 }]]);
  const prevIo = new Map([[100, { r: 0, w: 0 }], [101, { r: 0, w: 0 }]]); // 200 은 앞 값이 없다 — 읽기 못 함
  const t = R.topProcs(prev, cur, { dt: 2, tck: 100, page: 4096, ncpu: 4, up: 1000, users: new Map([[100, 'oracle'], [101, 'oracle'], [200, 'root']]), units, io, prevIo, unitsUp: 500 });
  const sv = new Map(t.apps.sv.map((a) => [a.k, a]));
  const ora = sv.get('oracle-db.service');
  assert.deepEqual([ora.n, ora.th, ora.cpu, ora.rss, ora.rb, ora.wb, ora.io, ora.u, ora.un], [2, 15, 150, 20, 5, 1, 'all', 'oracle', 1]);
  assert.equal(sv.get(R.APP_SESSION).io, 'none'); assert.equal(sv.get(R.APP_SESSION).rb, undefined, '못 읽었으면 값이 없다(0 아님)');
  assert.equal(sv.get(R.APP_KERNEL).n, 2);
  assert.ok(!sv.has('old.service'), '서비스 지도를 읽은 뒤 시작한 프로세스(pid 재사용)에는 옛 서비스를 붙이지 않는다');
  assert.equal(sv.get(R.APP_NOSVC).n, 2, 'late(지도 뒤 시작) + newproc(지도에 없음)');
  assert.equal(t.apps.sv[0].k, 'oracle-db.service', 'CPU 순');
  const cm = new Map(t.apps.cm.map((a) => [a.k, a]));
  assert.equal(cm.get('ora_p*').n, 2); assert.equal(cm.get('newproc').cpu, 0, '앞 표본에 없던 프로세스의 CPU 는 더하지 않는다');
  // 일부만 읽음
  const io2 = new Map([[100, { r: 1048576, w: 0 }]]); const prevIo2 = new Map([[100, { r: 0, w: 0 }]]);
  const t2 = R.topProcs(prev, cur, { dt: 1, tck: 100, page: 4096, ncpu: 4, up: 1000, units, io: io2, prevIo: prevIo2 });
  const ora2 = t2.apps.sv.find((a) => a.k === 'oracle-db.service');
  assert.equal(ora2.io, 'part'); assert.equal(ora2.rb, 1);
  // 서비스 지도를 아직 못 받았다 — 서비스 기준은 null(모두 '서비스 없음' 으로 지어내지 않는다) · 프로그램 이름은 있다
  const t3 = R.topProcs(prev, cur, { dt: 2, tck: 100, page: 4096, ncpu: 4, up: 1000, units: new Map() });
  assert.equal(t3.apps.sv, null); assert.ok(t3.apps.cm.length > 0);
  // 상한
  const many = []; for (let k = 0; k < 40; k++) many.push(P(1000 + k, k, `p${String.fromCharCode(97 + (k % 26))}${k < 26 ? '' : 'x'}`));
  const t4 = R.topProcs(many, many.map((p) => ({ ...p, ticks: p.ticks + 1 })), { dt: 1, tck: 100, page: 4096, ncpu: 1, up: 10, units: new Map([[1000, 'a.service']]) });
  assert.ok(t4.apps.cm.length <= R.APP_TOP);
});

/* ── ② ── */
test('② 기록 — 메모리 표본에는 표본마다 · DB 묶음에는 그 분의 마지막 표본에만', async () => {
  store._resetForTest();
  const id = 'fm-apps-a';
  const m0 = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
  const apps = { sv: [{ k: 'x.service', n: 1, th: 1, cpu: 5, rss: 1, io: 'none', un: 0 }], cm: [{ k: 'x', n: 1, th: 1, cpu: 5, rss: 1, io: 'none', un: 0 }] };
  for (const t of [m0 + 5000, m0 + 10_000, m0 + 15_000]) {
    store.ingestSample(id, t, { cpu: { pct: 1, usr: 1, sys: 0, iow: 0, stl: 0 } }, null, t);
    store.ingestProcs(id, t, { n: 10, top: [], apps });
  }
  const mem = store.memProcs(id).get(Math.floor(m0 / 60_000));
  assert.equal(mem.filter((s) => s.apps).length, 3, '메모리 — 표본마다');
  store.ingestSample(id, m0 + 61_000, { cpu: { pct: 1, usr: 1, sys: 0, iow: 0, stl: 0 } }, null, m0 + 61_000); // 분이 닫힌다
  const p = store.drainWrites(1000).find((r) => r.kind === 'p');
  const dec = CODEC.decodeProcBlock(p.data);
  assert.deepEqual(dec.map((s) => !!s.apps), [false, false, true], 'DB — 그 분의 마지막 표본에만(프로세스 기록이 두 배가 되지 않게)');
});

/* ── ③ ── */
test('③ 엣지 정제 — 아는 칸만 · 이름 규칙 · 상한 · 음수 · 글자', () => {
  const c = edge.cleanProcs({ n: 3, top: [], apps: {
    sv: [{ k: 'oracle-db.service', n: 2, th: 3, cpu: 10, rss: 5, io: 'all', rb: 1, wb: 2, u: 'oracle', un: 1, evil: 'x' },
      { k: '../x.service', n: 1 }, { k: 'a b.service', n: 1 }, { k: R.APP_KERNEL, n: 5, cpu: -1, io: 'bogus' }, { k: 'plain', n: 1 }],
    cm: [{ k: 'ora_p*', n: 2 }, { k: 'a b', n: 1 }, { k: 'x', n: -3 }],
  } });
  assert.deepEqual(c.apps.sv.map((a) => a.k), ['oracle-db.service', R.APP_KERNEL], '서비스 기준은 .service · .scope 또는 정해진 세 이름만');
  assert.equal(c.apps.sv[0].evil, undefined);
  assert.equal(edge.cleanProcs({ n: 1, top: [], apps: { sv: [{ k: 'a.service', n: 1, u: 'bad user;rm' }], cm: [] } }).apps.sv[0].u, undefined, '계정 이름 규칙 밖은 버린다');
  assert.equal(c.apps.sv[1].cpu, null, '음수는 null'); assert.equal(c.apps.sv[1].io, 'none');
  assert.deepEqual(c.apps.cm.map((a) => a.k), ['ora_p*'], '프로그램 이름 규칙 · 수가 없으면 버린다');
  const big = { sv: Array.from({ length: 50 }, (_, k) => ({ k: `s${k}.service`, n: 1 })), cm: [] };
  assert.equal(edge.cleanProcs({ n: 1, top: [], apps: big }).apps.sv.length, R.APP_TOP);
  assert.equal(edge.cleanProcs({ n: 1, top: [] }).apps, undefined, '옛 엣지 — 칸 없음');
});

/* ── ④ ── */
test('④ 조회 — 끝 순간 · 평균 · 펼침(같은 열쇠) · 쌓은 영역(위 5개 이름 순 · 나머지 · 빈 칸)', () => {
  const s = (t, list) => ({ t, n: 50, top: [], apps: { sv: list, cm: [] } });
  const snaps = [
    s(1000, [{ k: 'b.service', n: 1, cpu: 10, rss: 100, io: 'none' }, { k: 'a.service', n: 1, cpu: 20, rss: 50, io: 'all', rb: 2, wb: 1 }]),
    s(2000, [{ k: 'b.service', n: 1, cpu: 30, rss: 100, io: 'none' }, { k: 'a.service', n: 1, cpu: 20, rss: 50, io: 'all', rb: 4, wb: 1 }]),
  ];
  assert.deepEqual(A.appTable(snaps, 'sv', 'end').map((a) => [a.k, a.cpu]), [['b.service', 30], ['a.service', 20]], '끝 순간');
  const avg = A.appTable(snaps, 'sv', 'avg');
  assert.ok(avg.find((a) => a.k === 'b.service').cpu > 10 && avg.find((a) => a.k === 'b.service').cpu <= 30);
  assert.equal(A.appTable([{ t: 1, apps: { sv: null, cm: [] } }], 'sv', 'end').length, 0, '서비스 지도 없는 표본은 서비스 기준에서 뺀다');
  // 펼침 열쇠 = 묶기 열쇠
  assert.equal(A.memberKey({ pid: 5, c: 'ora_p003', sv: 'dbora.service', pp: 1 }, 'sv'), 'dbora.service');
  assert.equal(A.memberKey({ pid: 5, c: 'ora_p003', pp: 1 }, 'cm'), 'ora_p*');
  assert.equal(A.memberKey({ pid: 7, c: 'kworker_1:0', pp: 2 }, 'sv'), R.APP_KERNEL);
  // 쌓은 영역 — 위 5개(합 큰 순)를 이름 순으로 · 나머지 · 빈 칸 null
  const many = [];
  for (let t = 0; t < 10; t++) many.push(s(t * 1000 + 500, ['f', 'e', 'd', 'c', 'b', 'a', 'z'].map((k, j) => ({ k: `${k}.service`, n: 1, cpu: 10 * (j + 1), io: 'none' }))));
  const se = A.appSeries(many, 'sv', 0, 20_000, 20);
  assert.deepEqual(se.keys, ['a.service', 'b.service', 'c.service', 'd.service', 'z.service'], 'CPU 합 위 5개를 이름 순으로(색이 순위를 따라 바뀌지 않게)');
  assert.equal(se.rest.filter((v) => v != null)[0], 10 + 20, '나머지 = 상위 20 안의 그 밖');
  assert.ok(se.vals[0].slice(10).every((v) => v == null), '표본이 없는 칸은 null(0 아님)');
});

test('④ 데모 서버 — 수집기와 같은 열쇠 · 서비스 · 프로그램 이름 둘 다', async () => {
  store._resetForTest();
  const id = mock.DEMO_TARGETS[0].id;
  const now = Date.now();
  for (let k = 0; k < 6; k++) { const t = now - 30_000 + k * 5000; store.ingestProcs(id, t, mock.demoProcs(id, t)); }
  const w = Q.normWindow({ win: 5 }, now + 1000);
  const r = await A.apps([id], w, { by: 'sv' });
  const s = r.per[0];
  assert.ok(s.apps.length > 3 && s.apps[0].k.endsWith('.service'));
  assert.ok(s.series && s.series.keys.length === 5);
  const k0 = s.apps.find((a) => (s.members[a.k] || []).length);
  assert.ok(k0, '펼침 목록이 있는 묶음');
  for (const m of s.members[k0.k]) assert.ok(m.pid > 0);
  const rc = await A.apps([id], w, { by: 'cm' });
  assert.ok(rc.per[0].apps.some((a) => a.k.includes('*')), '프로그램 이름 — 숫자 덩어리 *');
});

/* ── ⑤ ── */
test('⑤ 라우트 — 조회 문 · 사용자 이름 가림 · 기준', async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const svc = await import('../src/focusmon/service.js');
  const users = {
    admin: { username: 'a', role: 'admin', scope: null }, operator: { username: 'o', role: 'operator', scope: null },
    scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } }, demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, who = 'admin') => { const r = await fetch(base + p, { headers: { 'x-test-user': who } }); return { status: r.status, body: await r.json().catch(() => null) }; };
  try {
    const id = mock.DEMO_TARGETS[0].id;
    const now = Date.now();
    for (let k = 0; k < 4; k++) { const t = now - 20_000 + k * 5000; store.ingestProcs(id, t, mock.demoProcs(id, t)); }
    const a = await call(`/api/tools/focus-mon/apps?targets=${id}&win=5`);
    assert.equal(a.status, 200); assert.equal(a.body.by, 'sv'); assert.equal(a.body.usersMasked, false);
    assert.ok(a.body.per[0].apps.some((x) => x.u === 'oracle'), '관리자는 원문');
    const c = await call(`/api/tools/focus-mon/apps?targets=${id}&win=5&by=cm&at=avg`);
    assert.equal(c.body.by, 'cm'); assert.equal(c.body.at, 'avg');
    assert.equal((await call(`/api/tools/focus-mon/apps?targets=${id}&win=5&by=evil`)).body.by, 'sv', '모르는 기준은 서비스');
    const d = await call(`/api/tools/focus-mon/apps?targets=${id}&win=5`, 'demo');
    assert.equal(d.status, 200); assert.equal(d.body.usersMasked, true);
    assert.ok(!JSON.stringify(d.body).includes('"oracle"'), '데모 계정은 계정 이름을 가린다(묶음 · 펼침 둘 다)');
    for (const who of ['operator', 'scoped']) assert.equal((await call(`/api/tools/focus-mon/apps?targets=${id}`, who)).status, 403, who);
    assert.equal((await call('/api/tools/focus-mon/apps?targets=fm-none')).status, 404);
  } finally { svc.stopFocusMon(); srv.close(); }
});
