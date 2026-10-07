/**
 * bulletin2722.test.js — 접속 공지(팝업)·게시판(v2.722) 회귀.
 *
 * 실제 `api` 라우터를 express 에 마운트하고 역할을 바꿔 가며 상태코드를 본다(소스 grep 이 아니다 — v2.536 규약).
 * 고정하는 것: ① 공지 쓰기는 admin + 전체 범위만 ② 노출 기간 밖·꺼진 공지는 팝업 목록에 없다
 * ③ 게시판 쓰기는 admin·operator, viewer 는 읽기만 ④ 남의 글 수정·삭제는 관리자만 · 고정은 관리자만
 * ⑤ 상한 초과·빈 제목은 400 이고 저장하지 않는다 ⑥ 손상 파일은 보존하고 빈 목록으로 시작한다.
 * 자식 프로세스인 이유: config.js 싱글턴이라 이 프로세스에서 CONFIG_DIR 을 다시 못 가리킨다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function run(body, { pre } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulletin2722-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const out = {};
    ${body}
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}

test('① 공지 쓰기 = admin + 전체 범위 · ② 기간 밖·꺼짐은 팝업에 없다', () => {
  const { out } = run(`
    out.create = await call('POST', '/notices', { title: '정기 점검 안내', body: '토요일 02시', level: 'warn' });
    const id = out.create.j.notice.id;
    await call('POST', '/notices', { title: '끝난 공지', endAt: Date.now() - 1000 });
    await call('POST', '/notices', { title: '예정 공지', startAt: Date.now() + 3600000 });
    await call('POST', '/notices', { title: '꺼진 공지', enabled: false });
    out.badLevel = await call('POST', '/notices', { title: 'x', level: 'boom' });
    out.badRange = await call('POST', '/notices', { title: 'x', startAt: 2000, endAt: 1000 });
    out.empty = await call('POST', '/notices', { title: '   ' });
    as({ username: 'op', role: 'operator', scope: null });
    out.opCreate = await call('POST', '/notices', { title: 'op' });
    out.opActive = await call('GET', '/notices/active');
    as({ username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } });
    out.scopedCreate = await call('POST', '/notices', { title: 'scoped' });
    out.scopedDel = await call('DELETE', '/notices/' + id);
    as({ username: 'adm', role: 'admin', scope: null });
    out.upd = await call('PUT', '/notices/' + id, { body: '일요일 02시' });
    out.active2 = await call('GET', '/notices/active');
    out.list = await call('GET', '/notices');
    out.del = await call('DELETE', '/notices/' + id);
    out.delAgain = await call('DELETE', '/notices/' + id);
    out.badId = await call('DELETE', '/notices/../../x');
  `);
  assert.equal(out.create.s, 200);
  assert.equal(out.badLevel.s, 400);
  assert.equal(out.badRange.s, 400);
  assert.equal(out.empty.s, 400);
  assert.equal(out.opCreate.s, 403);
  assert.equal(out.scopedCreate.s, 403);
  assert.equal(out.scopedDel.s, 403);
  assert.deepEqual(out.opActive.j.notices.map((n) => n.title), ['정기 점검 안내'], '기간 밖·꺼진 공지는 팝업 목록에 없다');
  assert.equal(out.list.j.notices.length, 4, '관리 목록에는 전부 있다');
  // 고치면 rev 가 바뀌어 '다시 보지 않기' 한 사용자에게 다시 보인다.
  assert.notEqual(out.opActive.j.notices[0].rev, out.active2.j.notices[0].rev);
  assert.equal(out.active2.j.notices[0].body, '일요일 02시');
  assert.equal(out.active2.j.notices[0].title, '정기 점검 안내', '고치지 않은 칸은 유지된다');
  assert.equal(out.del.s, 200);
  assert.equal(out.delAgain.s, 404);
  assert.equal(out.badId.s, 404);
});

test('③ 게시판 쓰기 권한 · ④ 작성자·관리자 경계 · ⑤ 상한', () => {
  const { out, dir } = run(`
    as({ username: 'op', role: 'operator', scope: { vcenters: ['vc-1'] } });
    out.create = await call('POST', '/board/posts', { title: '첫 글', body: '내용', pinned: true });
    const id = out.create.j.post.id;
    out.c1 = await call('POST', '/board/posts/' + id + '/comments', { body: '댓글' });
    out.pinByOp = await call('PUT', '/board/posts/' + id, { pinned: true });
    out.tooLong = await call('POST', '/board/posts', { title: 't', body: 'x'.repeat(10001) });
    out.noTitle = await call('POST', '/board/posts', { title: '', body: 'x' });
    as({ username: 'v', role: 'viewer', scope: null });
    out.vList = await call('GET', '/board/posts');
    out.vGet = await call('GET', '/board/posts/' + id);
    out.vCreate = await call('POST', '/board/posts', { title: 'v', body: 'v' });
    out.vComment = await call('POST', '/board/posts/' + id + '/comments', { body: 'v' });
    as({ username: 'op2', role: 'operator', scope: null });
    out.otherEdit = await call('PUT', '/board/posts/' + id, { title: '남의 글' });
    out.otherDel = await call('DELETE', '/board/posts/' + id);
    out.otherDelComment = await call('DELETE', '/board/posts/' + id + '/comments/' + out.c1.j.comment.id);
    await call('POST', '/board/posts', { title: '나중 글', body: 'b' });
    out.search = await call('GET', '/board/posts?q=' + encodeURIComponent('첫'));
    as({ username: 'adm', role: 'admin', scope: null });
    out.pin = await call('PUT', '/board/posts/' + id, { pinned: true });
    out.order = await call('GET', '/board/posts');
    out.admDelComment = await call('DELETE', '/board/posts/' + id + '/comments/' + out.c1.j.comment.id);
    out.after = await call('GET', '/board/posts/' + id);
    out.admDel = await call('DELETE', '/board/posts/' + id);
    out.gone = await call('GET', '/board/posts/' + id);
  `);
  assert.equal(out.create.s, 200, '범위 계정 operator 도 게시판에 쓴다(vCenter 축이 없다)');
  assert.equal(out.create.j.post.pinned, false, 'operator 가 보낸 pinned 는 무시된다');
  assert.equal(out.c1.s, 200);
  assert.equal(out.pinByOp.s, 403);
  assert.equal(out.tooLong.s, 400);
  assert.equal(out.noTitle.s, 400);
  assert.equal(out.vList.s, 200);
  assert.equal(out.vList.j.canWrite, false);
  assert.equal(out.vGet.j.post.comments.length, 1);
  assert.equal(out.vCreate.s, 403);
  assert.equal(out.vComment.s, 403);
  assert.equal(out.otherEdit.s, 403);
  assert.equal(out.otherDel.s, 403);
  assert.equal(out.otherDelComment.s, 403);
  assert.deepEqual(out.search.j.rows.map((r) => r.title), ['첫 글']);
  assert.equal(out.pin.s, 200);
  assert.equal(out.order.j.rows[0].title, '첫 글', '고정 글이 최근 글보다 먼저');
  assert.equal(out.admDelComment.s, 200);
  assert.equal(out.after.j.post.comments.length, 0);
  assert.equal(out.admDel.s, 200);
  assert.equal(out.gone.s, 404);
  const st = fs.statSync(path.join(dir, 'board.json'));
  assert.equal(st.mode & 0o777, 0o600);
});

test('⑥ 손상 파일은 보존하고 빈 목록으로 시작한다', () => {
  const { out, dir } = run(`
    out.list = await call('GET', '/board/posts');
    out.notices = await call('GET', '/notices/active');
  `, { pre: (d) => { fs.writeFileSync(path.join(d, 'board.json'), '{깨짐'); fs.writeFileSync(path.join(d, 'notices.json'), '{"notices": 3}'); } });
  assert.equal(out.list.j.total, 0);
  assert.deepEqual(out.notices.j.notices, []);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith('board.json.corrupt.')), files.join(','));
  assert.ok(files.some((f) => f.startsWith('notices.json.corrupt.')), files.join(','));
});
