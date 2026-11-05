/**
 * wikiIssues2907.test.js — v2.907 기능 추천 1~5(사용자 '모두 적용' — 기존 화면 틀대로).
 *  1 댓글 고치기(위키 · 이슈 — 쓴 사람만 · 옛 본문 보관 · 새로 언급한 사람에게만 알림)
 *  2 문서 휴지통(30일 · 되살리기 · 영구 삭제 권한 · 기한 지나면 정리 · 첨부는 영구 삭제 때)
 *  3 역링크 · 제목 바꿀 때 [[옛 제목]] 갱신(이 문서로 풀리던 것만 · 쓰기 범위 밖은 건너뜀) · 깨진 링크
 *  4 다른 스페이스로 옮기기(하위 문서 함께 · 두 스페이스 쓰기 범위)
 *  5 이슈 템플릿(내장 3 + 관리자 30 · 전체 범위 관리자만 쓰기)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pageRefsOf, resolveRef } from '../src/wiki/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function run(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2907-'));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    app.use((err, _req, res, _next) => { res.status(err.status || err.statusCode || 500).json({ ok: false, reason: String(err.message || err).slice(0, 200) }); });
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const up = async (p, name, buf) => {
      const r = await fetch(base + p + '?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const WA = { username: 'wa', role: 'admin', scope: { writeVcenters: ['vc-a'] } };
    const SA = { username: 'sa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    const DEMO = { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true };
    const out = {};
    ${body}
    st.flushIssuesNow(); wk.flushWikiNow();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}


test('순수 — 문서 링크 읽기 · 찾기(화면 파서와 같은 규칙)', () => {
  const r = pageRefsOf('앞 [[런북 A]] 와 [[W12|여기]] 그리고 [[toc]] [[ ]] [[a\nb]] 끝');
  assert.deepEqual(r.map((x) => [x.ref, x.label]), [['런북 A', ''], ['W12', '여기']]);
  const pages = [{ id: 'W1', title: '런북 A', spaceId: 'vc-a' }, { id: 'W2', title: '런북 a', spaceId: 'pub' }, { id: 'W12', title: 'x', spaceId: 'pub' }];
  assert.equal(resolveRef('런북 A', pages, 'pub').id, 'W2', '같은 스페이스 우선 · 대소문자 무시');
  assert.equal(resolveRef('런북 A', pages, 'vc-z').id, 'W1');
  assert.equal(resolveRef('W12', pages).id, 'W12');
  assert.equal(resolveRef('없음', pages), null);
});

test('1 · 2 · 3 · 4 — 댓글 고치기 · 휴지통 · 링크 · 옮기기', () => {
  const { out } = run(`
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    const nt = await import(${JSON.stringify(path.join(SRC, 'issues/notify.js'))});
    auth.createUser({ username: 'kim', role: 'operator' }, { trusted: true });
    auth.createUser({ username: 'lee', role: 'operator' }, { trusted: true });
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    nt.startIssueNotify();
    as(ADM);
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [{ username: 'kim', email: 'kim@x.co' }, { username: 'lee', email: 'lee@x.co' }] } });
    // 1 댓글 고치기 — 위키
    const a = (await call('POST', '/wiki/pages', { spaceId: 'pub', title: '런북 A', body: '본문' })).j.page;
    const cm = (await call('POST', '/wiki/pages/' + a.id + '/comments', { body: '확인 @kim' })).j.comment;
    await nt.flushIssueNotify(); mails.length = 0;
    const e1 = await call('PUT', '/wiki/pages/' + a.id + '/comments/' + cm.id, { body: '확인 @kim 그리고 @lee' });
    out.edit = { s: e1.s, edits: e1.j.comment?.edits, prev: e1.j.comment?.prev?.length };
    await nt.flushIssueNotify();
    out.editMails = mails.map((m) => m.to[0]).sort();
    as({ username: 'lee', role: 'operator', scope: null });
    out.editOther = (await call('PUT', '/wiki/pages/' + a.id + '/comments/' + cm.id, { body: '남의 댓글' })).s;
    as(ADM);
    // 1 댓글 고치기 — 이슈
    const iss = (await call('POST', '/issues', { title: 't', assignee: 'kim' })).j.issue.key;
    const ic = (await call('POST', '/issues/' + iss + '/comments', { body: '첫 글' })).j.comment;
    const ie = await call('PUT', '/issues/' + iss + '/comments/' + ic.id, { body: '고친 글' });
    out.issueEdit = { s: ie.s, body: (await call('GET', '/issues/' + iss)).j.issue.comments[0].body, edited: !!(await call('GET', '/issues/' + iss)).j.issue.comments[0].editedAt };
    // 3 링크 · 제목 바꾸기
    const b = (await call('POST', '/wiki/pages', { spaceId: 'pub', title: '가리키는 문서', body: '보기: [[런북 A]] · [[런북 A|여기]] · [[W999]]' })).j.page;
    out.back = (await call('GET', '/wiki/pages/' + a.id + '/backlinks')).j.items.map((x) => x.id);
    out.broken = (await call('GET', '/wiki/broken-links')).j.rows.map((x) => x.ref);
    const ren = await call('PUT', '/wiki/pages/' + a.id, { baseVersion: 1, title: '런북 B' });
    out.linkFix = ren.j.linkFix;
    const b2 = (await call('GET', '/wiki/pages/' + b.id)).j.page;
    out.bBody = b2.body; out.bVersion = b2.version; out.bNote = b2.versions[0].note;
    out.backAfter = (await call('GET', '/wiki/pages/' + a.id + '/backlinks')).j.items.map((x) => x.id);
    // 4 옮기기(하위 함께)
    const child = (await call('POST', '/wiki/pages', { spaceId: 'pub', title: '하위', body: 'x', parentId: b.id })).j.page;
    const mv = await call('POST', '/wiki/pages/' + b.id + '/move', { spaceId: 'vc-a' });
    out.move = { s: mv.s, moved: mv.j.moved };
    out.moved = [(await call('GET', '/wiki/pages/' + b.id)).j.page.spaceId, (await call('GET', '/wiki/pages/' + child.id)).j.page.spaceId, (await call('GET', '/wiki/pages/' + child.id)).j.page.parentId];
    as({ username: 'op', role: 'operator', scope: { vcenters: ['vc-a'] } });
    out.moveScoped = (await call('POST', '/wiki/pages/' + b.id + '/move', { spaceId: 'vc-b' })).s;
    as(ADM);
    // 2 휴지통
    const d = (await call('POST', '/wiki/pages', { spaceId: 'pub', title: '지울 문서', body: 'x' })).j.page;
    const del = await call('DELETE', '/wiki/pages/' + d.id);
    out.del = { s: del.s, trashed: del.j.trashed };
    out.getDeleted = (await call('GET', '/wiki/pages/' + d.id)).s;
    out.trash = (await call('GET', '/wiki/trash')).j.items.map((x) => x.id);
    as({ username: 'lee', role: 'operator', scope: null });
    out.purgeOther = (await call('DELETE', '/wiki/trash/' + d.id)).s;
    as(ADM);
    const rs = await call('POST', '/wiki/trash/' + d.id + '/restore');
    out.restore = { s: rs.s, title: rs.j.page?.title };
    out.trashAfter = (await call('GET', '/wiki/trash')).j.items.length;
    await call('DELETE', '/wiki/pages/' + d.id);
    out.purge = (await call('DELETE', '/wiki/trash/' + d.id)).s;
    out.trashFinal = (await call('GET', '/wiki/trash')).j.items.length;
    out.restoreGone = (await call('POST', '/wiki/trash/' + d.id + '/restore')).s;
    // 기한 지난 항목 정리
    const e = (await call('POST', '/wiki/pages', { spaceId: 'pub', title: '오래된 휴지통', body: 'x' })).j.page;
    await call('DELETE', '/wiki/pages/' + e.id);
    out.expired = wk.purgeExpiredTrash(Date.now() + 31 * 86400000);
  `);
  assert.deepEqual(out.edit, { s: 200, edits: 1, prev: 1 });
  assert.deepEqual(out.editMails, ['lee@x.co'], '고친 댓글은 새로 언급한 사람에게만');
  assert.equal(out.editOther, 403);
  assert.deepEqual(out.issueEdit, { s: 200, body: '고친 글', edited: true });
  assert.ok(out.back.length === 1);
  assert.deepEqual(out.broken, ['W999']);
  assert.deepEqual(out.linkFix, { fixed: 1, skipped: 0 });
  assert.equal(out.bBody, '보기: [[런북 B]] · [[런북 B|여기]] · [[W999]]');
  assert.equal(out.bVersion, 2); assert.match(out.bNote, /링크 갱신/);
  assert.equal(out.backAfter.length, 1, '제목이 바뀌어도 역링크가 이어진다');
  assert.deepEqual(out.move, { s: 200, moved: 2 });
  assert.deepEqual(out.moved, ['vc-a', 'vc-a', out.moved[2]]);
  assert.notEqual(out.moved[2], '', '하위 문서는 계층을 유지');
  assert.ok([400, 403].includes(out.moveScoped), '범위 계정은 범위 밖 스페이스로 못 옮긴다');
  assert.deepEqual(out.del, { s: 200, trashed: true });
  assert.equal(out.getDeleted, 404);
  assert.equal(out.trash.length, 1);
  assert.equal(out.purgeOther, 403, '영구 삭제는 지운 사람 · 만든 사람 · 전체 범위 관리자');
  assert.deepEqual(out.restore, { s: 200, title: '지울 문서' });
  assert.equal(out.trashAfter, 0);
  assert.equal(out.purge, 200); assert.equal(out.trashFinal, 0); assert.equal(out.restoreGone, 404);
  assert.equal(out.expired.length, 1, '기한(30일)이 지나면 정리');
});

test('5 — 이슈 템플릿: 내장 3 · 관리자 추가 · 전체 범위 관리자만 쓰기 · 내장은 못 고침', () => {
  const { out } = run(`
    as(ADM);
    out.list0 = (await call('GET', '/issues/templates')).j.items.map((x) => x.id);
    const t = await call('POST', '/issues/templates', { name: '변경 요청', type: 'request', priority: 'p1', labels: 'change, 승인', body: '## 변경' });
    out.create = { s: t.s, labels: t.j.template?.labels, id: /^t[a-f0-9]{10}$/.test(t.j.template?.id || '') };
    out.editBuiltin = (await call('PUT', '/issues/templates/incident', { name: 'x', body: 'y' })).s;
    out.badType = (await call('POST', '/issues/templates', { name: 'x', type: 'epic', body: 'y' })).s;
    as({ username: 'wa', role: 'admin', scope: { writeVcenters: ['vc-a'] } });
    out.scopedWrite = (await call('POST', '/issues/templates', { name: 'x', body: 'y' })).s;
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewerList = (await call('GET', '/issues/templates')).j.items.length;
    as({ username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true });
    out.demoWrite = (await call('POST', '/issues/templates', { name: 'x', body: 'y' })).s;
    as(ADM);
    out.del = (await call('DELETE', '/issues/templates/' + t.j.template.id)).s;
    out.list1 = (await call('GET', '/issues/templates')).j.items.length;
    out.issueKeyRoute = (await call('GET', '/issues/ISS-999')).s;
  `);
  assert.deepEqual(out.list0, ['incident', 'task', 'request']);
  assert.deepEqual(out.create, { s: 200, labels: ['change', '승인'], id: true });
  assert.equal(out.editBuiltin, 400); assert.equal(out.badType, 400);
  assert.equal(out.scopedWrite, 403, '쓰기 범위가 지정된 관리자는 전 법인 공용 템플릿을 못 바꾼다');
  assert.equal(out.viewerList, 4, '요청 권한 계정도 고를 수는 있다');
  assert.equal(out.demoWrite, 403);
  assert.equal(out.del, 200); assert.equal(out.list1, 3);
  assert.equal(out.issueKeyRoute, 404, '템플릿 라우트가 이슈 키 라우트를 가리지 않는다');
});
