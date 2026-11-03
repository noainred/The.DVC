/**
 * issues2864.test.js — 이슈 트래커(v2.864) 회귀.
 *
 * 실제 `api` 라우터를 express 에 마운트하고 역할을 바꿔 가며 상태코드를 본다(소스 grep 이 아니다 — v2.536 규약).
 * 고정하는 것: ① viewer 는 조회만(쓰기 403) · operator 가 만든 이슈는 ISS-1 부터 ② 전이 규칙 — 담당자 없이 '진행 중' 400, 완료는 closedAt,
 * 보류는 사유 필수 ③ 담당자 변경은 이력·응답에 남고 일괄 할당은 키마다 결과를 밝힌다 ④ 댓글 삭제·이슈 삭제는 본인 또는 전체 범위 관리자
 * (범위 관리자 403 + 사유) ⑤ 상한·형식 400/409 ⑥ 목록 필터·통계·담당자 후보 ⑦ 손상 파일은 보존하고 빈 목록으로 시작한다
 * ⑧ 쓰기 응답의 persist 는 저장 뒤 saved 이고 파일에 실제로 있다.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issues2864-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
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
    st.flushIssuesNow();
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

test('① viewer 는 조회만 · operator 가 만든 이슈는 ISS-1 부터 · ② 전이 규칙(담당자 없이 진행 중 400 · 완료 closedAt · 보류 사유 필수)', () => {
  const { out } = run(`
    as({ username: 'op', role: 'operator', scope: { vcenters: ['vc-1'] } });
    out.create = await call('POST', '/issues', { title: '첫 이슈', body: '내용', type: 'incident', priority: 'p0', labels: ['VCenter', 'vcenter', ' 수집 '] });
    const key = out.create.j.issue.key;
    out.create2 = await call('POST', '/issues', { title: '둘째', assignee: 'lee', status: 'progress', dueAt: Date.now() + 86400000 });
    out.noAssigneeProgress = await call('POST', '/issues', { title: '셋째', status: 'progress' });
    out.toProgress = await call('POST', '/issues/' + key + '/status', { status: 'progress' });
    out.assign = await call('POST', '/issues/' + key + '/assign', { assignee: 'kim', reason: 'vCenter 담당' });
    out.toProgress2 = await call('POST', '/issues/' + key + '/status', { status: 'progress' });
    out.toDone = await call('POST', '/issues/' + key + '/status', { status: 'done' });
    out.reopen = await call('POST', '/issues/' + key + '/status', { status: 'review' });
    out.blockNoReason = await call('POST', '/issues/' + key + '/block', { on: true, reason: '  ' });
    out.block = await call('POST', '/issues/' + key + '/block', { on: true, reason: 'ISS-2 대기' });
    out.unblock = await call('POST', '/issues/' + key + '/block', { on: false });
    out.badStatus = await call('POST', '/issues/' + key + '/status', { status: 'closed' });
    out.badKey = await call('GET', '/issues/ISS-x');
    out.missing = await call('GET', '/issues/ISS-999');
    as({ username: 'v', role: 'viewer', scope: null });
    out.vList = await call('GET', '/issues');
    out.vGet = await call('GET', '/issues/' + key);
    out.vMeta = await call('GET', '/issues/meta');
    out.vCreate = await call('POST', '/issues', { title: 'v' });
    out.vAssign = await call('POST', '/issues/' + key + '/assign', { assignee: 'v' });
    out.vComment = await call('POST', '/issues/' + key + '/comments', { body: 'v' });
  `);
  assert.equal(out.create.s, 200, '범위 계정 operator 도 이슈를 만든다(vCenter 축이 없다)');
  assert.equal(out.create.j.issue.key, 'ISS-1');
  assert.equal(out.create.j.issue.status, 'backlog');
  assert.equal(out.create.j.issue.reporter, 'op');
  assert.deepEqual(out.create.j.issue.labels, ['vcenter', '수집'], '라벨은 소문자·공백 정리·중복 제거');
  assert.equal(out.create.j.persist.state, 'saved', '쓰기 응답은 저장 결과를 기다린다');
  assert.equal(out.create2.s, 200);
  assert.equal(out.create2.j.issue.key, 'ISS-2');
  assert.equal(out.create2.j.issue.status, 'progress', '담당자가 있으면 생성과 함께 진행 중');
  assert.equal(out.noAssigneeProgress.s, 400);
  assert.equal(out.noAssigneeProgress.j.field, 'status');
  assert.equal(out.toProgress.s, 400, '담당자 없이 진행 중으로 옮길 수 없다');
  assert.equal(out.assign.s, 200);
  assert.equal(out.assign.j.issue.assignee, 'kim');
  const h = out.assign.j.issue.history;
  assert.equal(h[h.length - 1].field, 'assignee');
  assert.equal(h[h.length - 1].to, 'kim');
  assert.equal(h[h.length - 1].note, 'vCenter 담당', '재할당 사유가 이력에 남는다');
  assert.equal(out.toProgress2.s, 200);
  assert.equal(out.toDone.j.issue.status, 'done');
  assert.ok(out.toDone.j.issue.closedAt > 0, '완료는 closedAt 을 적는다');
  assert.equal(out.reopen.j.issue.closedAt, null, '완료에서 나오면 closedAt 을 지운다');
  assert.equal(out.blockNoReason.s, 400, '보류는 사유가 있어야 한다');
  assert.equal(out.block.j.issue.blocked.reason, 'ISS-2 대기');
  assert.equal(out.unblock.j.issue.blocked, null);
  assert.equal(out.badStatus.s, 400);
  assert.equal(out.badKey.s, 404);
  assert.equal(out.missing.s, 404);
  assert.equal(out.vList.s, 200);
  assert.equal(out.vList.j.canWrite, false);
  assert.equal(out.vList.j.rows.length, 2, 'viewer 도 같은 목록을 본다(열린 이슈 2건)');
  assert.equal(out.vGet.s, 200);
  assert.deepEqual(out.vMeta.j.people, [], 'viewer 에게는 담당자 후보를 주지 않는다');
  assert.equal(out.vCreate.s, 403);
  assert.equal(out.vAssign.s, 403);
  assert.equal(out.vComment.s, 403);
});

test('③ 일괄 할당은 키마다 결과 · ④ 삭제 경계(본인·전체 범위 관리자 — 범위 관리자 403 + 사유) · ⑤ 상한·형식', () => {
  const { out } = run(`
    as({ username: 'op', role: 'operator', scope: null });
    const a = (await call('POST', '/issues', { title: 'A' })).j.issue.key;
    const b = (await call('POST', '/issues', { title: 'B' })).j.issue.key;
    out.bulk = await call('POST', '/issues/bulk/assign', { keys: [a, b, 'ISS-999', 'nope'], assignee: 'park' });
    out.bulkBad = await call('POST', '/issues/bulk/assign', { keys: 'x', assignee: 'park' });
    out.c1 = await call('POST', '/issues/' + a + '/comments', { body: '첫 댓글' });
    out.tooLong = await call('POST', '/issues', { title: 't', body: 'x'.repeat(10001) });
    out.noTitle = await call('POST', '/issues', { title: '   ' });
    out.badPrio = await call('POST', '/issues', { title: 't', priority: 'urgent' });
    out.badDue = await call('POST', '/issues', { title: 't', dueAt: 'tomorrow-ish' });
    out.manyLabels = await call('POST', '/issues', { title: 't', labels: Array.from({ length: 11 }, (_, i) => 'l' + i) });
    out.badAssignee = await call('POST', '/issues/' + a + '/assign', { assignee: 'kim lee' });
    out.watch = await call('POST', '/issues/' + a + '/watch', { on: true });
    out.watchAgain = await call('POST', '/issues/' + a + '/watch', { on: true });
    as({ username: 'op2', role: 'operator', scope: null });
    out.otherEdit = await call('PUT', '/issues/' + a, { title: '남이 고친 제목', priority: 'p1' });
    out.otherDelComment = await call('DELETE', '/issues/' + a + '/comments/' + out.c1.j.comment.id);
    out.otherDelIssue = await call('DELETE', '/issues/' + a);
    as({ username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } });
    out.scopedDelComment = await call('DELETE', '/issues/' + a + '/comments/' + out.c1.j.comment.id);
    out.scopedDelIssue = await call('DELETE', '/issues/' + a);
    out.scopedGet = await call('GET', '/issues/' + a);
    as({ username: 'adm', role: 'admin', scope: null });
    out.admDelComment = await call('DELETE', '/issues/' + a + '/comments/' + out.c1.j.comment.id);
    out.admGet = await call('GET', '/issues/' + a);
    as({ username: 'op', role: 'operator', scope: null });
    out.ownDel = await call('DELETE', '/issues/' + b);
    as({ username: 'adm', role: 'admin', scope: null });
    out.admDel = await call('DELETE', '/issues/' + a);
    out.gone = await call('GET', '/issues/' + a);
    out.next = await call('POST', '/issues', { title: 'C' });
  `);
  assert.equal(out.bulk.s, 200);
  assert.equal(out.bulk.j.done, 2);
  assert.equal(out.bulk.j.failed, 2);
  assert.deepEqual(out.bulk.j.results.map((r) => r.ok), [true, true, false, false], '없는 키·형식 오류는 사유와 함께 밝힌다');
  assert.equal(out.bulkBad.s, 400);
  assert.equal(out.c1.s, 200);
  assert.equal(out.tooLong.s, 400);
  assert.equal(out.noTitle.s, 400);
  assert.equal(out.badPrio.s, 400);
  assert.equal(out.badDue.s, 400);
  assert.equal(out.manyLabels.s, 400);
  assert.equal(out.badAssignee.s, 400, '공백이 든 계정명은 거부');
  assert.equal(out.watch.j.issue.watching, true);
  assert.equal(out.watchAgain.s, 200, '같은 상태 재전송은 그대로 200');
  assert.equal(out.otherEdit.s, 200, '쓰기 계정은 남의 이슈도 고친다(협업 도구)');
  assert.equal(out.otherEdit.j.issue.title, '남이 고친 제목');
  assert.equal(out.otherDelComment.s, 403, '남의 댓글은 지우지 못한다');
  assert.equal(out.otherDelIssue.s, 403, '남이 만든 이슈는 지우지 못한다');
  assert.equal(out.scopedDelComment.s, 403, '범위 관리자는 관리자가 아니다');
  assert.match(out.scopedDelComment.j.reason, /범위 관리자/);
  assert.equal(out.scopedDelIssue.s, 403);
  assert.equal(out.scopedGet.s, 200, '범위 관리자도 조회는 된다');
  assert.equal(out.admDelComment.s, 200);
  assert.equal(out.admGet.j.issue.comments.length, 0);
  assert.equal(out.ownDel.s, 200, '보고자 본인은 지운다');
  assert.equal(out.admDel.s, 200);
  assert.equal(out.gone.s, 404);
  assert.equal(out.next.j.issue.key, 'ISS-3', '지운 번호는 다시 쓰지 않는다');
});

test('⑥ 목록 필터·통계·담당자 후보 · ⑧ persist 는 저장 뒤 saved 이고 파일에 있다', () => {
  const { out, dir } = run(`
    as({ username: 'op', role: 'operator', scope: null });
    const now = Date.now();
    await call('POST', '/issues', { title: '늦음', assignee: 'kim', status: 'progress', dueAt: now - 86400000, priority: 'p1' });
    await call('POST', '/issues', { title: '곧', assignee: 'kim', dueAt: now + 3600000, priority: 'p2', type: 'request', labels: ['storage'] });
    await call('POST', '/issues', { title: '미할당', priority: 'p0' });
    const d = (await call('POST', '/issues', { title: '끝남', assignee: 'lee' })).j.issue.key;
    await call('POST', '/issues/' + d + '/status', { status: 'done' });
    out.open = await call('GET', '/issues');
    out.recent = await call('GET', '/issues?done=recent');
    out.kim = await call('GET', '/issues?assignee=kim');
    out.unassigned = await call('GET', '/issues?assignee=');
    out.p0 = await call('GET', '/issues?priority=p0');
    out.q = await call('GET', '/issues?q=' + encodeURIComponent('곧'));
    out.label = await call('GET', '/issues?label=storage');
    out.stats = await call('GET', '/issues/stats');
    out.meta = await call('GET', '/issues/meta');
    await st.waitIssuesPersist(st.issuesSeq(), { maxMs: 3000 });
    out.persist = st.issuesPersist({ admin: true });
    out.file = JSON.parse(require('node:fs').readFileSync(process.env.CONFIG_DIR + '/issues.json', 'utf8'));
  `.replace("require('node:fs')", "(await import('node:fs')).default"));
  assert.equal(out.open.j.rows.length, 3, '기본은 열린 이슈만');
  assert.deepEqual(out.open.j.rows.map((r) => r.priority), ['p0', 'p1', 'p2'], '우선순위 순');
  assert.equal(out.recent.j.rows.length, 4, 'recent 는 최근 완료를 포함한다');
  assert.equal(out.kim.j.rows.length, 2);
  assert.equal(out.unassigned.j.rows.length, 1, 'assignee= 는 미할당');
  assert.equal(out.p0.j.rows.length, 1);
  assert.equal(out.q.j.rows.length, 1);
  assert.equal(out.label.j.rows.length, 1);
  const s = out.stats.j;
  assert.equal(s.open, 3);
  assert.equal(s.unassigned, 1);
  assert.equal(s.overdue, 1);
  assert.equal(s.dueSoon, 1);
  assert.equal(s.doneLast7d, 1);
  assert.deepEqual(s.byAssignee.map((a) => [a.assignee, a.open, a.progress, a.overdue]), [['kim', 2, 1, 1]]);
  assert.ok(out.meta.j.people.some((p) => p.username === 'kim'), '이슈에 보이는 이름은 담당자 후보에 있다');
  assert.ok(!out.meta.j.people.some((p) => p.username === 'thedvcdemp'), '데모 계정은 할당 후보가 아니다');
  assert.equal(out.persist.state, 'saved');
  assert.equal(out.file.issues.length, 4);
  assert.equal(out.file.nextSeq, 5);
  assert.ok(fs.existsSync(path.join(dir, 'issues.json')));
});

test('⑦ 손상 파일은 보존하고 빈 목록으로 시작한다 — 덮어쓰지 않는다', () => {
  const { out, dir } = run(`
    out.list = await call('GET', '/issues');
    out.create = await call('POST', '/issues', { title: '새 이슈' });
  `, { pre: (dir) => fs.writeFileSync(path.join(dir, 'issues.json'), '{"issues": [{"id":"deadbeef'), });
  assert.equal(out.list.j.rows.length, 0);
  assert.equal(out.create.j.issue.key, 'ISS-1');
  const kept = fs.readdirSync(dir).filter((n) => n.startsWith('issues.json.corrupt'));
  assert.equal(kept.length, 1, '손상본이 옆에 보존된다');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'issues.json'), 'utf8')).issues.length, 1);
});

test('v2.870 감사 A2-05 — 진행 중 이슈의 담당자는 비울 수 없다(단건 400 · 일괄은 그 키만 실패) · 다른 상태는 해제 가능', () => {
  const { out } = run(`
    as({ username: 'op', role: 'operator', scope: null });
    const a = (await call('POST', '/issues', { title: 'A', assignee: 'park' })).j.issue.key;
    const b = (await call('POST', '/issues', { title: 'B', assignee: 'park' })).j.issue.key;
    out.prog = await call('POST', '/issues/' + a + '/status', { status: 'progress' });
    out.unassign = await call('POST', '/issues/' + a + '/assign', { assignee: '' });
    out.bulk = await call('POST', '/issues/bulk/assign', { keys: [a, b], assignee: '' });
    out.after = await call('GET', '/issues/' + a);
  `);
  assert.equal(out.prog.s, 200, JSON.stringify(out.prog.j));
  assert.equal(out.unassign.s, 400);
  assert.match(out.unassign.j.reason || out.unassign.j.error || JSON.stringify(out.unassign.j), /진행 중 이슈의 담당자는 비울 수 없습니다/);
  assert.deepEqual(out.bulk.j.results.map((r) => r.ok), [false, true]);
  assert.equal(out.after.j.issue.assignee, 'park');
});
