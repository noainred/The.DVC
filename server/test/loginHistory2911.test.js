// v2.911 — 로그인 기록(설정 › 로그 › 최근 로그인 · 로그인 횟수).
// 고정하는 것:
//   ① 첫 기동(파일 없음)에는 감사 로그의 '로그인' 줄만 옮겨 온다('로그인 실패'·'로그인 차단(잠금)'·'세션 연장' 은 아니다) — 역할은 알려진 값만.
//   ② 집계: 최근 1일 · 7일 · 30일 · 사용자 정의 [from, to) · 사용자별 마지막 로그인 · 한 번도 로그인하지 않은 로컬 계정도 목록에(값 0, last null)
//      · 구간 시작이 가장 오래된 기록보다 앞이면 partial(0 회로 단정하지 않는다).
//   ③ 기간 입력 검사(배열 · 한쪽만 · 역순 · 미래 · 숫자 아님).
//   ④ 보관 기간(366일)이 지난 줄은 정리되고, 깨진 줄은 그 줄만 건너뛴다.
//   ⑤ 실제 POST /api/auth/login 성공이 한 줄을 남기고(src local · peer IP), 실패는 남기지 않는다.
//   ⑥ 라우트: 전체 범위 관리자 200 · 범위 관리자 403 · viewer 403 · 잘못된 기간 400 · 데모 계정 READ_DENY.
// 기준 시각은 실제 시각을 정시로 떨어뜨려 고정한다(docs/rules/common.md — Date.now() 직접·고정 epoch 둘 다 깨진다).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loginhist2911-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
delete process.env.TRUST_PROXY;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const FILE = path.join(tmp, 'login-history.ndjson');
const AUDIT = path.join(tmp, 'audit.ndjson');

let lh, express;
before(async () => {
  express = (await import('express')).default;
  lh = await import('../src/security/loginHistory.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const fileRows = () => { try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reset = () => { try { fs.rmSync(FILE); } catch { /* */ } lh._resetLoginHistoryForTest(); };
const iso = (ms) => new Date(ms).toISOString();

test('① 첫 기동 — 감사 로그의 로그인 성공 줄만 옮겨 온다', () => {
  reset();
  const audit = [
    { at: iso(NOW - 40 * DAY), user: 'kim', action: '로그인', detail: 'admin · 단일세션', ip: '10.0.0.1' },
    { at: iso(NOW - 3 * DAY), user: 'lee', action: '로그인 실패', detail: '', ip: '10.0.0.2' },
    { at: iso(NOW - 3 * DAY), user: 'lee', action: '로그인 차단(잠금)', detail: '60s', ip: '10.0.0.2' },
    { at: iso(NOW - 2 * DAY), user: 'kim', action: '세션 연장', detail: '', ip: '' },
    { at: iso(NOW - 2 * HOUR), user: 'park', action: '로그인', detail: '이상한값 · OTP 등록 필요(등록 전용 세션)', ip: '10.0.0.3' },
    { at: 'not-a-date', user: 'bad', action: '로그인', detail: 'viewer', ip: '' },
  ];
  fs.writeFileSync(AUDIT, audit.map((e) => JSON.stringify(e)).join('\n') + '\n{깨진 줄\n');
  const s = lh.loginHistorySummary({ now: NOW });
  assert.equal(s.backfilled, 2, '로그인 성공 2줄만(실패·잠금·연장·시각 없는 줄 제외)');
  assert.deepEqual(fileRows().map((r) => [r.user, r.role, r.src]), [['kim', 'admin', ''], ['park', '', '']], '역할은 알려진 값만 · 출처는 모름');
  assert.equal(s.coverageFrom, NOW - 40 * DAY);
  // 다시 읽어도(파일이 생겼으므로) 두 번 옮기지 않는다.
  lh._resetLoginHistoryForTest();
  assert.equal(lh.loginHistorySummary({ now: NOW }).backfilled, 0);
  assert.equal(fileRows().length, 2);
  fs.rmSync(AUDIT);
});

test('② 집계 — 1일 · 7일 · 30일 · 사용자 정의 · 마지막 로그인 · 기록 없는 계정 · partial', () => {
  reset();
  fs.writeFileSync(FILE, '');      // 빈 기록(옮겨 올 것 없음)
  const rec = (user, ago, extra = {}) => lh.recordLoginSuccessEvent({ user, ip: `10.1.0.${Math.round(ago / HOUR) % 250}`, role: 'admin', src: 'local', at: NOW - ago, ...extra });
  rec('kim', 50 * DAY);          // 30일 밖
  rec('kim', 20 * DAY);          // 30일 안
  rec('kim', 5 * DAY);           // 7일 안
  rec('kim', 2 * HOUR);          // 1일 안
  rec('kim', 1 * HOUR);          // 1일 안(마지막)
  rec('ad.user', 3 * DAY, { src: 'ad', role: 'viewer' });
  rec('gone', 10 * DAY);         // 로컬이었는데 지금 계정이 없다
  const range = { from: NOW - 21 * DAY, to: NOW - 4 * DAY };
  const s = lh.loginHistorySummary({ now: NOW, range, accounts: [{ username: 'kim', name: '김', role: 'admin' }, { username: 'never', role: 'viewer' }] });
  const by = Object.fromEntries(s.users.map((u) => [u.user, u]));
  assert.deepEqual([by.kim.d1, by.kim.d7, by.kim.d30, by.kim.range, by.kim.total], [2, 3, 4, 2, 5]);
  assert.equal(by.kim.last, NOW - HOUR);
  assert.equal(by.kim.rangeLast, NOW - 5 * DAY);
  assert.equal(by.kim.account, 'local');
  assert.equal(by.kim.name, '김');
  assert.equal(by['ad.user'].account, 'ad');
  assert.equal(by['ad.user'].role, 'viewer');
  assert.equal(by.gone.account, 'deleted');
  assert.deepEqual([by.never.last, by.never.total, by.never.d30, by.never.range], [null, 0, 0, 0], '한 번도 로그인하지 않은 로컬 계정도 목록에');
  assert.equal(s.users[0].user, 'kim', '최근 로그인 순');
  assert.equal(s.users[s.users.length - 1].user, 'never', '기록 없는 계정은 뒤');
  assert.deepEqual(s.totals, { d1: 2, d7: 4, d30: 6, range: 3 }, 'range [21일 전, 4일 전): kim 2 + gone 1 — ad.user(3일 전)는 끝 뒤');
  // 가장 오래된 기록이 50일 전 — 1·7·30일 · 사용자 정의(21일 전 시작)는 다 덮인다. 60일 전 시작이면 partial.
  assert.deepEqual(s.partial, { d1: false, d7: false, d30: false, range: false });
  const s2 = lh.loginHistorySummary({ now: NOW, range: { from: NOW - 60 * DAY, to: NOW } });
  assert.equal(s2.partial.range, true, '기록 시작보다 앞 — 그 앞은 세지 못했다');
  assert.equal(s2.totals.range, 7);
  // 사용자 정의 기간이 없으면 range 값은 null(0 이 아니다).
  const s3 = lh.loginHistorySummary({ now: NOW });
  assert.equal(s3.totals.range, null);
  assert.equal(s3.users.find((u) => u.user === 'kim').range, null);
  assert.equal(s3.recent[0].user, 'kim', '최근 이력은 최신 순');
  assert.equal(s3.recent[0].ts, NOW - HOUR);
});

test('② 기록이 아예 없으면 모든 구간이 partial(0 회로 단정하지 않는다)', () => {
  reset();
  fs.writeFileSync(FILE, '');
  const s = lh.loginHistorySummary({ now: NOW, range: { from: NOW - DAY, to: NOW } });
  assert.equal(s.coverageFrom, null);
  assert.deepEqual(s.partial, { d1: true, d7: true, d30: true, range: true });
});

test('③ 기간 입력 검사', () => {
  const p = lh.parseLoginRange;
  assert.equal(p(undefined, undefined, NOW), null);
  assert.equal(p('', '', NOW), null);
  assert.deepEqual(p(String(NOW - DAY), String(NOW), NOW), { from: NOW - DAY, to: NOW });
  for (const [f, t] of [[String(NOW - DAY), undefined], ['', String(NOW)], [['1', '2'], String(NOW)], [{ a: 1 }, '5'],
    [String(NOW), String(NOW - DAY)], [String(NOW), String(NOW)], [String(NOW + DAY), String(NOW + 2 * DAY)], ['abc', String(NOW)], ['-5', String(NOW)], ['1e12', String(NOW)]]) {
    assert.ok(p(f, t, NOW)?.error, `거부해야 한다: ${JSON.stringify([f, t])}`);
  }
});

test('④ 366일 지난 줄 정리 · 깨진 줄은 그 줄만 건너뛴다', () => {
  reset();
  const old = { ts: NOW - 400 * DAY, user: 'old', ip: '', role: '', src: 'local' };
  const keep = { ts: NOW - 10 * DAY, user: 'keep', ip: '', role: '', src: 'local' };
  fs.writeFileSync(FILE, `${JSON.stringify(old)}\n{깨진\n${JSON.stringify({ ts: 'x', user: 'nots' })}\n${JSON.stringify(keep)}\n`);
  const s = lh.loginHistorySummary({ now: NOW });
  assert.equal(s.skippedLines, 2);
  assert.equal(s.records, 2);
  lh.recordLoginSuccessEvent({ user: 'new', ip: '1.1.1.1', role: 'viewer', src: 'local', at: NOW });
  assert.deepEqual(fileRows().map((r) => r.user), ['keep', 'new'], '보관 기간이 지난 줄은 다시 쓸 때 빠진다');
});

test('⑤ 실제 로그인 성공은 한 줄을 남기고(src local · peer IP), 실패는 남기지 않는다', async () => {
  reset();
  fs.writeFileSync(FILE, '');
  const auth = await import('../src/auth/auth.js');
  const made = auth.createUser({ username: 'lh-viewer', role: 'viewer', name: 'V', password: 'Lh!2911-pass-word' }, { trusted: true });
  assert.equal(made.ok, true, JSON.stringify(made));
  const { authRouter } = await import('../src/routes/auth.js');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const login = (password) => fetch(`http://127.0.0.1:${srv.address().port}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.66.66.66' },
      body: JSON.stringify({ username: 'lh-viewer', password }),
    });
    assert.equal((await login('wrong-password')).status, 401);
    assert.equal(fileRows().length, 0, '실패는 로그인 기록에 남지 않는다');
    const ok = await login('Lh!2911-pass-word');
    assert.equal(ok.status, 200, await ok.text());
    const rows = fileRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user, 'lh-viewer');
    assert.equal(rows[0].src, 'local');
    assert.equal(rows[0].role, 'viewer');
    assert.match(rows[0].ip, /127\.0\.0\.1/, '위조 가능한 XFF 가 아니라 실제 peer');
    assert.equal(lh.loginHistorySummary({}).users.find((u) => u.user === 'lh-viewer').d1, 1);
  } finally { srv.close(); }
});

test('⑥ 라우트 — 전체 범위 관리자만 · 잘못된 기간 400 · 데모 계정 READ_DENY', async () => {
  reset();
  fs.writeFileSync(FILE, '');
  const realNow = Date.now();
  lh.recordLoginSuccessEvent({ user: 'boss', ip: '10.2.0.1', role: 'admin', src: 'local', at: realNow - 2 * HOUR });
  const { adminRouter } = await import('../src/routes/admin.js');
  const app = express();
  app.use(express.json());
  app.use((req, _r, n) => {
    const who = req.headers['x-u'];
    req.user = who === 'scoped' ? { username: 'scoped', role: 'admin', scope: { vcenters: ['vc-us-east'] } }
      : who === 'viewer' ? { username: 'v', role: 'viewer', scope: null }
        : { username: 'full', role: 'admin', scope: null };
    n();
  });
  app.use('/api/admin', adminRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const get = async (who, q = '') => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/admin/login-history${q}`, { headers: { 'x-u': who } });
    let j = null; try { j = await r.json(); } catch { /* */ }
    return { s: r.status, j };
  };
  try {
    const full = await get('full');
    assert.equal(full.s, 200);
    assert.equal(full.j.ok, true);
    assert.equal(full.j.users.find((u) => u.user === 'boss').d1, 1);
    assert.equal(typeof full.j.authEnabled, 'boolean');
    assert.equal((await get('scoped')).s, 403, '범위 관리자는 전 사용자 접속 기록을 볼 수 없다(감사 로그와 같은 기준)');
    assert.equal((await get('viewer')).s, 403);
    const ranged = await get('full', `?from=${realNow - DAY}&to=${realNow + HOUR}`);
    assert.equal(ranged.s, 200);
    assert.equal(ranged.j.totals.range, 1);
    assert.equal((await get('full', `?from=${realNow}&to=${realNow - DAY}`)).s, 400);
    assert.equal((await get('full', `?from=1&from=2&to=${realNow}`)).s, 400, '같은 이름 두 번(배열)');
    assert.equal((await get('full', `?from=${realNow - DAY}`)).s, 400, '한쪽만');
  } finally { srv.close(); }
  const { READ_DENY } = await import('../src/auth/demoGuest.js');
  assert.ok(READ_DENY.includes('/api/admin/login-history'), '데모 계정은 전 사용자 접속 기록을 보지 않는다');
});
