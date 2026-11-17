/**
 * logSearchMailAudit73.test.js — 전체 점검 73회차(로그 분석 · 검색 · 게시 · 메일 · 개요 계열 1차) 확정분 회귀.
 *
 * F1 게시판 · 공지의 '전체 범위 관리자'(isBoardModerator · canRetryPersist)가 `!scopedVcenterIds` 만 봤다 — 조회는 전체 · 쓰기 범위
 *    (writeVcenters)만 줄인 관리자가 남의 글 수정 · 삭제 · 고정을 했고, 공지 편집(canEdit)·다시 저장(canRetry) 버튼이 열렸다(누르면 403).
 *    v2.904 위키 · 이슈 isMod 와 같은 함정 — 판정은 auth/scope.js isFullReadWriteScope 하나.
 * F2 로그 분석 상한(CAPS)에 닿은 뒤 새 키마다 Object.keys(3,000개)를 다시 만들었다 — 줄마다 다른 문장 20만 줄 붙여넣기가 58초 CPU.
 * F3 /overview/trend 의 지표별 error(원천 오류 원문)가 admin 이 아닌 계정에도 실렸다(형제 /overview/cards 는 v2.682 R3S-07 로 가림).
 * F4 메일 설정 저장이 형식이 틀린 받는 사람 주소를 조용히 버리고 200 '저장되었습니다' 였다.
 * 자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다(bulletin2722 와 같은 틀).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true }); };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function run(body, { router = 'api' } = {}) {
  const dir = tmpDir('audit73-');
  const mount = router === 'admin'
    ? `const { adminRouter } = await import(${JSON.stringify(path.join(SRC, 'routes/admin.js'))}); app.use('/api/admin', adminRouter);`
    : `const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))}); app.use('/api', api);`;
  const script = `
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    ${mount}
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const WA = { username: 'wa', role: 'admin', scope: { writeVcenters: ['vc-a'] } };
    const out = {};
    ${body}
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', SETTINGS_OWNERS: 'adm' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}

test('F1 — 쓰기 범위만 줄인 관리자는 게시판 관리 권한이 없다(남의 글 수정 · 고정 · 삭제 · 댓글 삭제 403 · 표시 플래그 false) · 자기 글은 그대로', () => {
  const { out } = run(`
    as(ADM);
    const p = await call('POST', '/board/posts', { title: '관리자 글', body: '본문' });
    const c = await call('POST', '/board/posts/' + p.j.post.id + '/comments', { body: '관리자 댓글' });
    as(WA);
    out.list = (await call('GET', '/board/posts')).j;
    out.notices = (await call('GET', '/notices')).j;
    out.persist = (await call('GET', '/board/persist')).j;
    out.edit = await call('PUT', '/board/posts/' + p.j.post.id, { body: '바꾼 본문' });
    out.pin = await call('PUT', '/board/posts/' + p.j.post.id, { pinned: true });
    out.delComment = await call('DELETE', '/board/posts/' + p.j.post.id + '/comments/' + c.j.comment.id);
    out.del = await call('DELETE', '/board/posts/' + p.j.post.id);
    out.own = await call('POST', '/board/posts', { title: '내 글', body: 'a', pinned: true });
    out.ownEdit = await call('PUT', '/board/posts/' + out.own.j.post.id, { body: 'b' });
    as(ADM);
    out.admList = (await call('GET', '/board/posts')).j;
    out.admNotices = (await call('GET', '/notices')).j;
    out.admPersist = (await call('GET', '/board/persist')).j;
    out.admEdit = await call('PUT', '/board/posts/' + out.own.j.post.id, { body: '관리자가 고침' });
  `);
  assert.equal(out.list.isAdmin, false, '게시판 관리 표시 플래그는 전체 범위(조회 ∧ 쓰기) 관리자만');
  assert.equal(out.notices.canEdit, false, '공지 편집 버튼 — 서버 게이트(fullScopeOnlyWith)가 쓰기 범위 제한 계정을 403 으로 막는다');
  assert.equal(out.persist.canRetry, false, '다시 저장 버튼 — 같은 이유');
  assert.equal(out.edit.s, 403);
  assert.match(out.edit.j.reason, /범위 관리자/, '왜 막혔는지 말한다');
  assert.equal(out.pin.s, 403);
  assert.equal(out.delComment.s, 403);
  assert.equal(out.del.s, 403);
  assert.equal(out.own.s, 200);
  assert.equal(out.own.j.post.pinned, false, '고정 요청은 무시');
  assert.equal(out.ownEdit.s, 200, '자기 글은 작성자 규칙으로 고친다');
  assert.equal(out.admList.isAdmin, true);
  assert.equal(out.admNotices.canEdit, true);
  assert.equal(out.admPersist.canRetry, true);
  assert.equal(out.admEdit.s, 200, '전체 범위 관리자는 예전처럼 중재한다');
});

test('F1 — 소스: 게시판 관리 판정은 isFullReadWriteScope 하나(`!scopedVcenterIds` 사본 금지)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/bulletin.js'), 'utf8'));
  assert.doesNotMatch(src, /scopedVcenterIds\(/, 'bulletin.js 가 조회 범위만으로 관리자 권한을 정하면 안 된다');
  assert.match(src, /isBoardModerator = \(req\) => isAdmin\(req\) && isFullReadWriteScope\(/);
  assert.match(src, /canRetryPersist = \(req\) => isAdmin\(req\) && isFullReadWriteScope\(/);
  assert.doesNotMatch(src, /role === 'admin'/, '관리자 판본 판정은 isAdminDetailUser 하나');
});

test('F2 — 로그 분석: 상한에 닿은 뒤 줄마다 Object.keys 를 다시 만들지 않는다 · 상한 · 넘친 수는 그대로', async () => {
  const { newState, addItem, indexRules, mergeState, CAPS } = await import('../src/loganalysis/engine.js');
  const { activeRules } = await import('../src/loganalysis/index.js');
  const idx = indexRules(activeRules());
  const words = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lam', 'mu'];
  const lineOf = (i) => { let x = i; const w = []; for (let k = 0; k < 5; k++) { w.push(words[x % 12]); x = Math.floor(x / 12); } return `[t] 오류 ${w.join(' ')}`; };
  const st = newState();
  const N = CAPS.tmpl + 2000;
  for (let i = 0; i < CAPS.tmpl; i++) addItem(st, { msg: lineOf(i), level: 'unknown' }, idx);
  const orig = Object.keys;
  let calls = 0;
  Object.keys = function counted(o) { calls += 1; return orig(o); };
  try { for (let i = CAPS.tmpl; i < N; i++) addItem(st, { msg: lineOf(i), level: 'unknown' }, idx); }
  finally { Object.keys = orig; }
  assert.ok(calls < 50, `상한 뒤 2,000줄에 Object.keys ${calls}회 — 줄마다 다시 세면 안 된다`);
  assert.equal(Object.keys(st.tmpl).length, CAPS.tmpl, '템플릿 상한은 그대로');
  assert.equal(st.overflow.tmpl, 2000, '넘친 줄은 센다');
  assert.equal(Object.keys(st.prob).length, CAPS.prob);

  // mergeState 가 키를 더한 객체를 addItem 이 이어 쓰면 기억한 크기가 낡아 상한을 넘기면 안 된다.
  const a = newState();
  for (let i = 0; i < CAPS.tmpl - 1; i++) addItem(a, { msg: lineOf(i), level: 'unknown' }, idx);
  const b = newState();
  for (let i = 50_000; i < 50_010; i++) addItem(b, { msg: lineOf(i), level: 'unknown' }, idx);
  mergeState(a, b);
  for (let i = 60_000; i < 60_020; i++) addItem(a, { msg: lineOf(i), level: 'unknown' }, idx);
  assert.equal(Object.keys(a.tmpl).length, CAPS.tmpl, 'mergeState 뒤에도 상한을 넘기지 않는다');
});

test('F3 — /overview/trend 지표 오류 원문은 admin + 전체 범위에게만', async () => {
  const { trendErrorsFor } = await import('../src/routes/api/overviewCards.js');
  const body = { ok: true, virtual: { series: null, error: "SQLITE_CANTOPEN: /var/lib/x/vmtrack.db" }, storage: { series: [1], delta: null }, power: { series: null, reason: 'not-requested' } };
  const hidden = trendErrorsFor(body, false);
  assert.equal(hidden.virtual.error, undefined);
  assert.equal(hidden.virtual.errorHidden, true);
  assert.deepEqual(hidden.storage, body.storage, '오류 없는 지표는 그대로');
  assert.equal(body.virtual.error, 'SQLITE_CANTOPEN: /var/lib/x/vmtrack.db', '캐시 원본은 바꾸지 않는다');
  assert.equal(trendErrorsFor(body, true), body, 'admin 은 원문');
  const src = stripComments(fs.readFileSync(path.join(SRC, 'routes/api/overviewCards.js'), 'utf8'));
  assert.match(src, /res\.json\(trendErrorsFor\(await p, allowed == null && isAdminReq\(req\)\)\)/, '라우트가 내보낼 때 가린다');
});

test('F4 — 메일 설정: 형식이 틀린 받는 사람 주소는 400(조용히 버리지 않는다) · 맞는 주소만이면 저장', () => {
  const { out, dir } = run(`
    out.badDefault = await call('PUT', '/admin/mail', { defaultTo: ['ops@corp', 'good@corp.com'] });
    out.badKind = await call('PUT', '/admin/mail', { kinds: { alert: { enabled: true, to: ['a@b.com x@y.com'], cc: [] } } });
    out.afterBad = (await call('GET', '/admin/mail')).j.settings.defaultTo;
    out.good = await call('PUT', '/admin/mail', { defaultTo: ['good@corp.com', 'ops@corp.co.kr'] });
    out.afterGood = (await call('GET', '/admin/mail')).j.settings.defaultTo;
    // 켜진 상태에서 받는 사람 검증은 저장될 값으로 — 구분자만 있는 기본 수신자는 '수신자 없음' 이다.
    out.sepOnly = await call('PUT', '/admin/mail', { enabled: true, smtp: { host: 'smtp.corp.local', port: 25, from: 'portal@corp.com' }, defaultTo: ',;', kinds: {} });
  `, { router: 'admin' });
  assert.equal(out.badDefault.s, 400);
  assert.equal(out.badDefault.j.field, 'defaultTo');
  assert.deepEqual(out.badDefault.j.bad, ['ops@corp']);
  assert.equal(out.badKind.s, 400);
  assert.equal(out.badKind.j.field, 'kinds.alert.to');
  assert.deepEqual(out.afterBad, [], '거부한 저장은 아무것도 바꾸지 않는다');
  assert.equal(out.good.s, 200);
  assert.deepEqual(out.afterGood, ['good@corp.com', 'ops@corp.co.kr']);
  assert.equal(out.sepOnly.s, 400, '구분자만 있는 기본 수신자를 수신자로 세지 않는다');
  assert.match(out.sepOnly.j.reason, /받는 사람이 없습니다/);
  assert.ok(fs.existsSync(path.join(dir, 'mail.json')));
});
