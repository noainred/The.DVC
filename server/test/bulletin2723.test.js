/**
 * bulletin2723.test.js — 게시판 답글(대댓글)·공감(v2.723) 회귀.
 *
 * 실제 `api` 라우터를 express 에 마운트하고 역할을 바꿔 가며 본다(소스 grep 이 아니다 — v2.536 규약).
 * 고정하는 것: ① 답글은 한 단계 — 답글에 단 답글은 최상위 댓글 아래로 옮기고 replyTo 를 남긴다
 * ② 없는·지운 댓글에 답글 404, 형식이 틀린 parentId 400 ③ 답글이 달린 댓글을 지우면 자리를 남기고, 마지막 답글이 지워지면 자리도 치운다
 * ④ 공감은 상태를 명시한다 — 같은 요청을 두 번 보내도 한 번만 센다 · 취소 · 형식 오류 400 · viewer 403 · 지운 댓글 404
 * ⑤ 목록은 공감 수·삭제 자리를 뺀 댓글 수를 싣고, 공감한 사람 전체 목록(likes 배열)을 응답에 싣지 않는다
 * ⑥ 공감·답글 필드가 없는 옛 board.json 을 그대로 읽는다.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulletin2723-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    let who = { username: 'op', role: 'operator', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = typeof u === 'string' ? { username: u, role: 'operator', scope: null } : u; };
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

test('① 답글은 한 단계 · ② 없는 댓글·형식 오류 · ③ 삭제 자리', () => {
  const { out } = run(`
    const p = (await call('POST', '/board/posts', { title: '글', body: '본문' })).j.post;
    const c1 = (await call('POST', '/board/posts/' + p.id + '/comments', { body: '첫 댓글' })).j.comment;
    as('op2');
    out.r1 = await call('POST', '/board/posts/' + p.id + '/comments', { body: '답글', parentId: c1.id });
    as('op3');
    out.r2 = await call('POST', '/board/posts/' + p.id + '/comments', { body: '답글의 답글', parentId: out.r1.j.comment.id });
    out.missing = await call('POST', '/board/posts/' + p.id + '/comments', { body: 'x', parentId: 'aaaaaaaaaaaaaaaa' });
    out.badFmt = await call('POST', '/board/posts/' + p.id + '/comments', { body: 'x', parentId: '../x' });
    out.badType = await call('POST', '/board/posts/' + p.id + '/comments', { body: 'x', parentId: 5 });
    out.list1 = await call('GET', '/board/posts');
    // 답글이 달린 첫 댓글을 작성자가 지운다 → 자리를 남긴다.
    as('op');
    out.delParent = await call('DELETE', '/board/posts/' + p.id + '/comments/' + c1.id);
    out.afterParent = await call('GET', '/board/posts/' + p.id);
    out.replyToDeleted = await call('POST', '/board/posts/' + p.id + '/comments', { body: 'x', parentId: c1.id });
    out.likeDeleted = await call('POST', '/board/posts/' + p.id + '/comments/' + c1.id + '/like', { on: true });
    out.delAgain = await call('DELETE', '/board/posts/' + p.id + '/comments/' + c1.id);
    out.list2 = await call('GET', '/board/posts');
    // 답글 둘을 지우면 자리도 사라진다.
    as('op2'); await call('DELETE', '/board/posts/' + p.id + '/comments/' + out.r1.j.comment.id);
    out.mid = await call('GET', '/board/posts/' + p.id);
    as('op3'); await call('DELETE', '/board/posts/' + p.id + '/comments/' + out.r2.j.comment.id);
    out.end = await call('GET', '/board/posts/' + p.id);
    out.c1 = c1;
  `);
  assert.equal(out.r1.s, 200);
  assert.equal(out.r1.j.comment.parentId, out.c1.id);
  assert.equal(out.r1.j.comment.replyTo, null, '최상위 댓글에 단 답글은 replyTo 가 없다');
  assert.equal(out.r2.s, 200);
  assert.equal(out.r2.j.comment.parentId, out.c1.id, '답글에 단 답글은 최상위 댓글 아래로 옮긴다');
  assert.equal(out.r2.j.comment.replyTo, 'op2');
  assert.equal(out.missing.s, 404);
  assert.equal(out.badFmt.s, 400);
  assert.equal(out.badType.s, 400);
  assert.equal(out.list1.j.rows[0].comments, 3);
  assert.equal(out.delParent.s, 200);
  assert.equal(out.delParent.j.kept, true);
  const ph = out.afterParent.j.post.comments.find((c) => c.id === out.c1.id);
  assert.equal(ph.deleted, true);
  assert.equal(ph.body, '', '삭제 자리는 내용을 지운다');
  assert.equal(ph.author, '', '삭제 자리는 작성자도 지운다');
  assert.equal(out.afterParent.j.post.commentCount, 2, '삭제 자리는 세지 않는다');
  assert.equal(out.replyToDeleted.s, 404, '삭제 자리에는 답글을 달지 않는다');
  assert.equal(out.likeDeleted.s, 404, '삭제 자리에는 공감하지 않는다');
  assert.equal(out.delAgain.s, 404);
  assert.equal(out.list2.j.rows[0].comments, 2);
  assert.ok(out.mid.j.post.comments.some((c) => c.id === out.c1.id), '답글이 남아 있으면 자리도 남는다');
  assert.deepEqual(out.end.j.post.comments, [], '마지막 답글이 지워지면 자리도 치운다');
});

test('④ 공감은 상태 명시 · 한 번만 센다 · 권한 · ⑤ 응답 모양', () => {
  const { out } = run(`
    const p = (await call('POST', '/board/posts', { title: '글', body: '본문' })).j.post;
    const c = (await call('POST', '/board/posts/' + p.id + '/comments', { body: '댓글' })).j.comment;
    as('op2');
    out.l1 = await call('POST', '/board/posts/' + p.id + '/like', { on: true });
    out.l1again = await call('POST', '/board/posts/' + p.id + '/like', { on: true });
    as('op3');
    out.l2 = await call('POST', '/board/posts/' + p.id + '/like', { on: true });
    out.cl = await call('POST', '/board/posts/' + p.id + '/comments/' + c.id + '/like', { on: true });
    out.badOn = await call('POST', '/board/posts/' + p.id + '/like', { on: 'yes' });
    out.noOn = await call('POST', '/board/posts/' + p.id + '/like', {});
    out.badCid = await call('POST', '/board/posts/' + p.id + '/comments/zzzz/like', { on: true });
    out.missingPost = await call('POST', '/board/posts/aaaaaaaaaaaaaaaa/like', { on: true });
    as({ username: 'v', role: 'viewer', scope: null });
    out.viewer = await call('POST', '/board/posts/' + p.id + '/like', { on: true });
    out.viewGet = await call('GET', '/board/posts/' + p.id);
    as('op2');
    out.off = await call('POST', '/board/posts/' + p.id + '/like', { on: false });
    out.offAgain = await call('POST', '/board/posts/' + p.id + '/like', { on: false });
    out.mine = await call('GET', '/board/posts/' + p.id);
    out.list = await call('GET', '/board/posts');
  `);
  assert.equal(out.l1.s, 200);
  assert.deepEqual([out.l1.j.likeCount, out.l1.j.liked, out.l1.j.changed], [1, true, true]);
  assert.deepEqual([out.l1again.j.likeCount, out.l1again.j.changed], [1, false], '같은 요청을 두 번 보내도 한 번만 센다');
  assert.equal(out.l2.j.likeCount, 2);
  assert.deepEqual(out.l2.j.likers, ['op3', 'op2'], '최근에 누른 사람부터');
  assert.equal(out.cl.j.likeCount, 1);
  assert.equal(out.badOn.s, 400);
  assert.equal(out.noOn.s, 400);
  assert.equal(out.badCid.s, 404);
  assert.equal(out.missingPost.s, 404);
  assert.equal(out.viewer.s, 403, 'viewer 는 공감할 수 없다(상태 변경 = admin·operator)');
  assert.equal(out.viewGet.j.post.likeCount, 2);
  assert.equal(out.viewGet.j.post.liked, false);
  assert.equal(out.viewGet.j.post.likes, undefined, '공감한 사람 전체 목록을 싣지 않는다');
  assert.equal(out.viewGet.j.post.comments[0].likes, undefined);
  assert.equal(out.viewGet.j.post.comments[0].likeCount, 1);
  assert.deepEqual([out.off.j.likeCount, out.off.j.liked, out.off.j.changed], [1, false, true]);
  assert.equal(out.offAgain.j.changed, false);
  assert.equal(out.mine.j.post.liked, false);
  assert.equal(out.list.j.rows[0].likes, 1, '목록은 공감 수를 싣는다');
});

test('⑥ 옛 board.json(공감·답글 필드 없음)을 그대로 읽는다', () => {
  const old = { posts: [{ id: 'aaaaaaaaaaaaaaaa', title: '옛 글', body: '본문', author: 'op', createdAt: 1, updatedAt: 1, pinned: false,
    comments: [{ id: 'bbbbbbbbbbbbbbbb', author: 'op2', body: '옛 댓글', createdAt: 2 }] }] };
  const { out } = run(`
    out.get = await call('GET', '/board/posts/aaaaaaaaaaaaaaaa');
    out.list = await call('GET', '/board/posts');
    out.reply = await call('POST', '/board/posts/aaaaaaaaaaaaaaaa/comments', { body: '답글', parentId: 'bbbbbbbbbbbbbbbb' });
    out.like = await call('POST', '/board/posts/aaaaaaaaaaaaaaaa/comments/bbbbbbbbbbbbbbbb/like', { on: true });
  `, { pre: (d) => fs.writeFileSync(path.join(d, 'board.json'), JSON.stringify(old)) });
  assert.equal(out.get.s, 200);
  assert.equal(out.get.j.post.likeCount, 0);
  assert.equal(out.get.j.post.comments[0].parentId, null);
  assert.equal(out.list.j.rows[0].likes, 0);
  assert.equal(out.reply.s, 200);
  assert.equal(out.like.j.likeCount, 1);
});
