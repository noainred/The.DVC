/**
 * issues2882.test.js — 이슈 확장 v2.882(시안 docs/design/wiki-issues ⑥⑦⑧): 에픽 › 이슈 › 하위 작업 · 스프린트 · 검색식 · 저장 필터 · 일괄 편집.
 *
 * ① 순수 — 검색식 파서(정상 · 오류 위치 · 제안 · 상한 · 퍼징 — 던지지 않고 선형) · 판정(in · not in · ~ · is empty · 우선순위 크기 · 상대 날짜 · me() · ORDER BY).
 * ② 실제 api 라우터(자식 프로세스): 계층 규칙 · 범위(공용 에픽은 범위 계정에 키를 지운다) · 진행률 자동 · 남은 하위가 있을 때 완료 · 지우기.
 * ③ 스프린트 — 만들기는 전체 범위 쓰기 계정만 · 넣기/빼기 · 보드 · 번다운(이력에서) · 끝내기(미완료 옮기기 · 이력) · 끝난 스프린트에 넣기 거부.
 * ④ 검색식 라우트 — 범위가 식보다 먼저 · 틀린 식 400(오류 위치) · 저장 필터(공유 권한 · 남의 필터) · 손상 파일 보존.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseQuery, compileQuery, orderComparator, QUERY_LIMITS, dateValue } from '../src/issues/query.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

test('① 검색식 — 해석 · 칩 구간 · 오류 위치와 제안 · 상한', () => {
  const q = 'assignee = me() AND status in (progress, review) AND vcenter = "vc-ap" AND updated >= -7d ORDER BY priority ASC, due DESC';
  const r = parseQuery(q);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.clauses.map((c) => [c.field, c.op, c.values.join('|')]), [['assignee', '=', 'me()'], ['status', 'in', 'progress|review'], ['vcenter', '=', 'vc-ap'], ['updated', '>=', '-7d']]);
  assert.equal(q.slice(r.clauses[1].start, r.clauses[1].end), 'status in (progress, review)', '칩 구간은 원문 그대로(지우면 그 구간을 잘라낸다)');
  assert.deepEqual(r.order, [{ field: 'priority', dir: 'asc' }, { field: 'due', dir: 'desc' }]);
  const bad = parseQuery('status = runnig');
  assert.equal(bad.errors[0].hint, 'progress 를 뜻했나요?', '시안의 예 — 별칭 running 을 거쳐 progress');
  assert.equal(q.length > 0 && bad.errors[0].start, 9);
  assert.match(parseQuery('statu = done').errors[0].hint, /status/);
  assert.match(parseQuery('assignee = kim status = done').errors[0].msg, /AND · OR/);
  assert.match(parseQuery('title ~ "열림').errors[0].msg, /따옴표/);
  assert.match(parseQuery('progress > 150').errors[0].msg, /0~100/);
  assert.match(parseQuery('assignee = now()').errors[0].msg, /now\(\)/);
  assert.equal(parseQuery('x'.repeat(QUERY_LIMITS.length + 1)).errors.length, 1, '500자 상한');
  const many = Array.from({ length: QUERY_LIMITS.clauses + 1 }, (_, i) => `label = l${i}`).join(' AND ');
  assert.match(parseQuery(many).errors.map((e) => e.msg).join(' '), /20개/);
  assert.deepEqual(parseQuery('(type = 장애 OR priority <= p1) AND sprint = active()').errors, []);
  assert.equal(parseQuery('(type = 장애 OR priority <= p1) AND sprint = active()').clauses.length, 2, '맨 위 AND 의 칸마다 칩(괄호 묶음은 한 칩)');
  assert.equal(dateValue('-7d', 100), 93); assert.equal(dateValue('+2w', 100), 114); assert.equal(dateValue('2026-11-01', 0), Date.UTC(2026, 10, 1) / 864e5);
});

test('① 검색식 퍼징 — 아무 글자나 넣어도 던지지 않고, 2배 입력에 시간도 대략 2배', () => {
  const alphabet = ['(', ')', ',', '=', '!=', '>=', '<', '~', '"', "'", ' ', 'AND', 'OR', 'not', 'in', 'is', 'empty', 'ORDER', 'BY', 'status', 'me()', 'ISS-1', '-7d', 'x', '\\', '가', '\n'];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 3000; i += 1) {
    let s = '';
    const n = Math.floor(rnd() * 40);
    for (let j = 0; j < n; j += 1) s += alphabet[Math.floor(rnd() * alphabet.length)] + (rnd() < 0.5 ? ' ' : '');
    const r = parseQuery(s);
    assert.ok(Array.isArray(r.errors) && Array.isArray(r.clauses), s);
    if (!r.errors.length) compileQuery(r.ast, { me: 'a', today: 0, dayOf: () => 0 })({ key: 'ISS-1', status: 'todo', watchers: [], labels: [], docs: [] });
  }
  const time = (s) => { let best = Infinity; for (let k = 0; k < 3; k += 1) { const t0 = performance.now(); parseQuery(s); best = Math.min(best, performance.now() - t0); } return best; };
  for (const gen of [(n) => '('.repeat(n), (n) => '"'.repeat(n), (n) => 'a = b AND '.repeat(n / 10), (n) => 'status in ('.repeat(n / 11)]) {
    const a = Math.max(0.2, time(gen(240))); const b = time(gen(480));
    assert.ok(b < Math.max(a * 4, 30), `${a.toFixed(2)} → ${b.toFixed(2)}ms`);
  }
});

test('① 판정 — in · not in · ~ · is empty · 우선순위 크기 · 상대 날짜 · me() · ORDER BY(값 없음은 뒤)', () => {
  const day = 20_000; const ms = (d) => d * 864e5 + 1000;
  const rows = [
    { key: 'ISS-1', num: 1, title: 'PL-WAW 타임아웃', text: 'PL-WAW 타임아웃 본문', type: 'incident', status: 'progress', priority: 'p0', assignee: 'kim', watchers: ['lee'], labels: ['pl'], vcenterId: 'vc-a', epicKey: 'ISS-9', sprintId: 'S1', progress: 50, dueAt: ms(day), updatedAt: ms(day - 1) },
    { key: 'ISS-2', num: 2, title: '보고서', text: '보고서', type: 'task', status: 'review', priority: 'p2', assignee: '', watchers: [], labels: [], vcenterId: '', epicKey: '', sprintId: '', progress: null, dueAt: null, updatedAt: ms(day - 30) },
    { key: 'ISS-3', num: 3, title: 'x', text: 'x', type: 'task', status: 'done', priority: 'p1', assignee: 'kim', watchers: [], labels: ['pl'], vcenterId: 'vc-a', epicKey: 'ISS-9', sprintId: 'S2', progress: 100, dueAt: ms(day + 3), updatedAt: ms(day) },
  ];
  const ctx = { me: 'kim', today: day, dayOf: (t) => Math.floor(t / 864e5), activeSprints: new Set(['S1']), sprintId: (r) => ({ '2026-11 ②': 'S1' })[r] || null, vcenterId: (r) => r };
  const keys = (q) => { const p = parseQuery(q); assert.deepEqual(p.errors, [], q); const f = compileQuery(p.ast, ctx); const out = rows.filter(f); const c = orderComparator(p.order, ctx); if (c) out.sort(c); return out.map((r) => r.key); };
  assert.deepEqual(keys('assignee = me()'), ['ISS-1', 'ISS-3']);
  assert.deepEqual(keys('status in (progress, review)'), ['ISS-1', 'ISS-2']);
  assert.deepEqual(keys('status not in (done)'), ['ISS-1', 'ISS-2']);
  assert.deepEqual(keys('status = 진행 중'.replace('진행 중', '"진행 중"')), ['ISS-1'], '한글 값');
  assert.deepEqual(keys('priority <= p1'), ['ISS-1', 'ISS-3'], 'p0 이 가장 높다');
  assert.deepEqual(keys('text ~ 타임아웃'), ['ISS-1']);
  assert.deepEqual(keys('assignee is empty'), ['ISS-2']);
  assert.deepEqual(keys('epic is not empty AND label = pl'), ['ISS-1', 'ISS-3']);
  assert.deepEqual(keys('sprint = active()'), ['ISS-1']);
  assert.deepEqual(keys('sprint = "2026-11 ②"'), ['ISS-1']);
  assert.deepEqual(keys('sprint is empty'), ['ISS-2']);
  assert.deepEqual(keys('updated >= -7d'), ['ISS-1', 'ISS-3']);
  assert.deepEqual(keys('due < now()'), [], '오늘 기한은 now() 보다 앞이 아니다(날짜 비교)');
  assert.deepEqual(keys('due <= now()'), ['ISS-1']);
  assert.deepEqual(keys('watcher = lee OR priority = p2'), ['ISS-1', 'ISS-2']);
  assert.deepEqual(keys('vcenter is empty'), ['ISS-2'], '공용 = 법인 없음');
  assert.deepEqual(keys('progress < 60'), ['ISS-1'], '보고 없음(null)은 크기 비교에서 빠진다');
  assert.deepEqual(keys('ORDER BY due DESC'), ['ISS-3', 'ISS-1', 'ISS-2'], '값 없음은 방향과 무관하게 뒤');
  assert.deepEqual(keys('ORDER BY key DESC'), ['ISS-3', 'ISS-2', 'ISS-1']);
});

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issues2882-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const app = express();
    app.use(express.json({ limit: '1mb' }));
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
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const SA = { username: 'sa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    const out = {};
    ${body}
    st.flushIssuesNow();
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir };
}

test('② 계층 — 에픽 › 이슈 › 하위 작업 · 층 · 법인 규칙 · 진행률 자동 · 남은 하위 · 지우기 · 범위', () => {
  const { out } = run(`
    const epic = (await call('POST', '/issues', { title: '고RTT 수집 안정화', type: 'epic' })).j.issue.key;         // 공용 에픽
    const epicA = (await call('POST', '/issues', { title: 'A 법인 에픽', type: 'epic', vcenterId: 'vc-a' })).j.issue.key;
    const iss = (await call('POST', '/issues', { title: 'PL-WAW 타임아웃', vcenterId: 'vc-a', parentKey: epic })).j.issue;
    const s1 = (await call('POST', '/issues', { title: '시한 분리', vcenterId: 'vc-a', parentKey: iss.key })).j.issue.key;
    const s2 = (await call('POST', '/issues', { title: '결과 확인', vcenterId: 'vc-a', parentKey: iss.key, assignee: 'kim', status: 'progress' })).j.issue.key;
    out.subOfSub = await call('POST', '/issues', { title: '세 단계', vcenterId: 'vc-a', parentKey: s1 });
    out.epicParent = await call('POST', '/issues', { title: '에픽 위 에픽', type: 'epic', parentKey: epic });
    out.otherCorpSub = await call('POST', '/issues', { title: '다른 법인 하위', vcenterId: 'vc-b', parentKey: iss.key });
    out.otherCorpEpic = await call('POST', '/issues', { title: '다른 법인 → A 에픽', vcenterId: 'vc-b', parentKey: epicA });
    out.self = await call('PUT', '/issues/' + iss.key, { parentKey: iss.key });
    out.parentWithKids = await call('PUT', '/issues/' + iss.key, { parentKey: epicA });   // 하위가 있는 이슈 → 에픽 아래로는 된다
    await call('PUT', '/issues/' + iss.key, { parentKey: epic });
    out.becomeSub = await call('PUT', '/issues/' + iss.key, { parentKey: (await call('POST', '/issues', { title: '남', vcenterId: 'vc-a' })).j.issue.key });
    out.epicToTask = await call('PUT', '/issues/' + epic, { type: 'task' });
    await call('POST', '/issues/' + s1 + '/status', { status: 'done' });
    out.detail = (await call('GET', '/issues/' + iss.key)).j.issue;
    out.manualPct = await call('POST', '/issues/' + iss.key + '/progress', { progress: 10 });
    out.noteOnly = await call('POST', '/issues/' + iss.key + '/progress', { note: '관찰 2일째' });
    out.epicView = (await call('GET', '/issues/' + epic)).j.issue;
    out.doneWithOpen = await call('POST', '/issues/' + iss.key + '/status', { status: 'done' });
    out.delWithKids = await call('DELETE', '/issues/' + iss.key);
    as(SA);
    out.scopedView = (await call('GET', '/issues/' + iss.key)).j.issue;
    out.scopedList = (await call('GET', '/issues?done=all')).j.rows.map((r) => [r.key, r.epicKey, r.parentKey]);
    out.scopedToPub = await call('POST', '/issues', { title: '범위 → 공용 에픽', vcenterId: 'vc-a', parentKey: epic });
    out.scopedEpicQ = (await call('GET', '/issues?query=' + encodeURIComponent('epic = ' + epic))).j.rows.length;
    out.scopedEpicEmpty = (await call('GET', '/issues?query=' + encodeURIComponent('epic is empty AND key = ' + iss.key))).j.rows.length;
    out.scopedDone = await call('POST', '/issues/' + iss.key + '/status', { status: 'done', closeChildren: true });
    as(ADM);
    out.after = (await call('GET', '/issues/' + iss.key)).j.issue;
    out.s2hist = (await call('GET', '/issues/' + s2)).j.issue.history.map((h) => [h.field, h.to, h.note || '']);
    out.keys = { epic, epicA, iss: iss.key, s1, s2 };
  `);
  const k = out.keys;
  assert.equal(out.subOfSub.s, 400, '하위 작업 아래에는 없다'); assert.match(out.subOfSub.j.reason, /두 단계/);
  assert.equal(out.epicParent.s, 400, '에픽은 상위가 없다');
  assert.equal(out.otherCorpSub.s, 400, '하위 작업은 같은 법인');
  assert.equal(out.otherCorpEpic.s, 400, '법인 에픽은 같은 법인 이슈만');
  assert.equal(out.self.s, 400);
  assert.equal(out.parentWithKids.s, 200, '하위가 있는 이슈도 에픽 아래로는 들어간다');
  assert.equal(out.becomeSub.s, 400, '하위가 있는 이슈는 하위 작업이 될 수 없다');
  assert.equal(out.epicToTask.s, 400, '이슈가 담긴 에픽은 유형을 바꾸지 못한다');
  assert.equal(out.detail.progress, 50); assert.equal(out.detail.progressAuto, true); assert.equal(out.detail.childCount, 2); assert.equal(out.detail.childDone, 1);
  assert.equal(out.detail.level, 'issue'); assert.equal(out.detail.epic.key, k.epic); assert.equal(out.detail.children.length, 2);
  assert.equal(out.manualPct.s, 409, '자식이 있으면 진행률 직접 입력은 잠긴다'); assert.equal(out.manualPct.j.code, 'progress-auto');
  assert.equal(out.noteOnly.s, 200, '메모는 쓸 수 있다');
  assert.equal(out.epicView.childCount, 1); assert.equal(out.epicView.progress, 0, '에픽 진행률 = 소속 이슈 완료 비율');
  assert.equal(out.doneWithOpen.s, 409); assert.equal(out.doneWithOpen.j.code, 'open-children'); assert.deepEqual(out.doneWithOpen.j.children.map((c) => c.key), [k.s2]);
  assert.equal(out.delWithKids.s, 400, '하위가 있으면 지우지 않는다');
  // 범위 계정 — 공용 에픽은 못 보므로 키 · 상세를 비운다(이슈 · 하위는 같은 법인이라 보인다)
  assert.equal(out.scopedView.epicKey, ''); assert.equal(out.scopedView.epic, null); assert.equal(out.scopedView.children.length, 2);
  assert.ok(out.scopedList.every(([, ek]) => ek !== k.epic), '범위 계정 목록에 공용 에픽 키가 새지 않는다');
  assert.equal(out.scopedToPub.s, 400, '보이지 않는 상위는 없는 이슈'); assert.match(out.scopedToPub.j.reason, /없는 이슈/);
  assert.equal(out.scopedEpicQ, 0, '검색식으로도 볼 수 없는 공용 에픽의 묶음을 알아내지 못한다(summary 와 같은 판정)');
  assert.equal(out.scopedEpicEmpty, 1, '범위 계정에게 그 이슈의 에픽은 비어 있다');
  assert.equal(out.scopedDone.s, 200, '한꺼번에 완료(자식마다 쓰기 범위 검사)');
  assert.equal(out.after.status, 'done'); assert.equal(out.after.children.every((c) => c.status === 'done'), true);
  assert.ok(out.s2hist.some(([f, to, note]) => f === 'status' && to === 'done' && /상위 .* 완료와 함께/.test(note)), '자식 완료 이력에 사유');
});

test('③ 스프린트 — 권한 · 넣기/빼기 · 보드 · 번다운 · 끝내기(미완료 옮기기) · 끝난 스프린트', () => {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10); // 포탈 날짜(KST 기본)
  const plus = (n) => new Date(Date.parse(today) + n * 864e5).toISOString().slice(0, 10);
  const { out } = run(`
    as(SA);
    out.scopedCreate = await call('POST', '/issues/sprints', { name: '범위', startDay: '${today}', endDay: '${plus(9)}' });
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewerCreate = await call('POST', '/issues/sprints', { name: '뷰어', startDay: '${today}', endDay: '${plus(9)}' });
    as(ADM);
    out.badDates = await call('POST', '/issues/sprints', { name: '거꾸로', startDay: '${plus(3)}', endDay: '${today}' });
    out.tooLong = await call('POST', '/issues/sprints', { name: '길게', startDay: '${today}', endDay: '${plus(80)}' });
    const sp = (await call('POST', '/issues/sprints', { name: '2026-11 ②', goal: '고RTT 1차', startDay: '${plus(-2)}', endDay: '${plus(9)}', state: 'active' })).j.sprint;
    const sp2 = (await call('POST', '/issues/sprints', { name: '2026-11 ③', startDay: '${plus(10)}', endDay: '${plus(19)}' })).j.sprint;
    const a = (await call('POST', '/issues', { title: 'A', vcenterId: 'vc-a', sprintId: sp.id, assignee: 'kim' })).j.issue.key;
    const b = (await call('POST', '/issues', { title: 'B', vcenterId: 'vc-a' })).j.issue.key;
    const c = (await call('POST', '/issues', { title: 'C', vcenterId: 'vc-b' })).j.issue.key;
    out.bulk = (await call('POST', '/issues/bulk/edit', { keys: [b, c, 'ISS-999', 'bad'], set: { sprintId: sp.id, addLabels: ['rtt'] } })).j;
    await call('POST', '/issues/' + a + '/status', { status: 'done' });
    out.board = (await call('GET', '/issues/sprints/' + sp.id + '/board')).j;
    out.query = (await call('GET', '/issues?query=' + encodeURIComponent('sprint = active() AND label = rtt'))).j.rows.map((r) => r.key).sort();
    out.queryName = (await call('GET', '/issues?query=' + encodeURIComponent('sprint = "2026-11 ②"'))).j.rows.length;
    as(SA);
    out.scopedBoard = (await call('GET', '/issues/sprints/' + sp.id + '/board')).j.rows.map((r) => r.key).sort();
    out.scopedClose = await call('POST', '/issues/sprints/' + sp.id + '/close', { to: '' });
    out.scopedUnsprint = await call('PUT', '/issues/' + c, { sprintId: '' });
    as(ADM);
    out.close = await call('POST', '/issues/sprints/' + sp.id + '/close', { to: sp2.id });
    out.closeAgain = await call('POST', '/issues/sprints/' + sp.id + '/close', { to: '' });
    out.toClosed = await call('PUT', '/issues/' + b, { sprintId: sp.id });
    out.editClosed = await call('PUT', '/issues/sprints/' + sp.id, { goal: 'x' });
    out.bAfter = (await call('GET', '/issues/' + b)).j.issue;
    out.aAfter = (await call('GET', '/issues/' + a)).j.issue;
    out.list = (await call('GET', '/issues/sprints')).j.sprints.map((s) => [s.name, s.state]);
    out.keys = { a, b, c, sp: sp.id, sp2: sp2.id };
  `);
  assert.equal(out.scopedCreate.s, 403, '범위 계정은 스프린트를 만들지 못한다');
  assert.equal(out.viewerCreate.s, 403);
  assert.equal(out.badDates.s, 400); assert.equal(out.tooLong.s, 400);
  assert.equal(out.bulk.done, 2); assert.equal(out.bulk.failed, 2, '없는 키 · 형식 오류는 사유와 함께 실패로 센다');
  assert.equal(out.board.total, 3); assert.equal(out.board.counts.done, 1);
  assert.deepEqual(out.board.people, [], 'kim 의 이슈는 완료 · 나머지는 미할당'); assert.equal(out.board.unassigned, 2);
  const bd = out.board.burndown.days;
  assert.equal(bd.length, 12); assert.equal(bd[0].remaining, 0, '시작일에는 아직 아무것도 넣지 않았다(이력)');
  assert.equal(bd[2].remaining, 2, '오늘 — 셋 중 하나 완료'); assert.equal(bd[3].remaining, null, '내일부터는 비운다(지어내지 않는다)');
  assert.equal(out.board.burndown.approximate, false);
  assert.deepEqual(out.query, [out.keys.b, out.keys.c].sort());
  assert.equal(out.queryName, 3);
  assert.deepEqual(out.scopedBoard, [out.keys.a, out.keys.b].sort(), '범위 계정 보드는 자기 법인 이슈만');
  assert.equal(out.scopedClose.s, 403);
  assert.equal(out.scopedUnsprint.s, 404, '조회 밖 이슈는 없는 이슈');
  assert.equal(out.close.s, 200); assert.equal(out.close.j.moved.moved, 2); assert.equal(out.close.j.moved.done, 1);
  assert.equal(out.closeAgain.s, 409);
  assert.equal(out.toClosed.s, 400, '끝난 스프린트에는 넣지 않는다');
  assert.equal(out.editClosed.s, 409, '끝난 스프린트는 회고 기록');
  assert.equal(out.bAfter.sprintId, out.keys.sp2, '미완료는 다음 스프린트로');
  assert.ok(out.bAfter.history.some((h) => h.field === 'sprint' && /스프린트 끝내기/.test(h.note || '')));
  assert.equal(out.aAfter.sprintId, out.keys.sp, '완료는 끝난 스프린트에 남는다(회고)');
  assert.deepEqual(out.list.map(([, s]) => s).sort(), ['closed', 'planned']);
});

test('④ 검색식 라우트 · 저장 필터 — 범위가 식보다 먼저 · 틀린 식 400 · 공유 권한 · 손상 파일', () => {
  const { out, dir } = run(`
    await call('POST', '/issues', { title: '서울 장애', vcenterId: 'vc-a', type: 'incident', priority: 'p0' });
    await call('POST', '/issues', { title: '부산 장애', vcenterId: 'vc-b', type: 'incident', priority: 'p1' });
    out.all = (await call('GET', '/issues?query=' + encodeURIComponent('type = incident ORDER BY priority DESC'))).j;
    out.bad = await call('GET', '/issues?query=' + encodeURIComponent('status = runnig'));
    as(SA);
    out.scoped = (await call('GET', '/issues?query=' + encodeURIComponent('vcenter = vc-b OR vcenter = vc-a'))).j.rows.map((r) => r.vcenterId);
    out.scopedShare = await call('POST', '/issues/filters', { name: '내 법인', query: 'vcenter = vc-a', shared: true });
    out.scopedMine = await call('POST', '/issues/filters', { name: '내 법인', query: 'vcenter = vc-a' });
    as(ADM);
    out.badFilter = await call('POST', '/issues/filters', { name: '틀림', query: 'statu = done' });
    out.shared = (await call('POST', '/issues/filters', { name: '장애 미해결', query: 'type = incident AND status != done', shared: true })).j.filter;
    as(SA);
    out.saList = (await call('GET', '/issues/filters')).j.filters.map((f) => [f.name, f.mine, f.shared]);
    out.saEditShared = await call('PUT', '/issues/filters/' + out.shared.id, { name: '바꿈' });
    out.saDelShared = await call('DELETE', '/issues/filters/' + out.shared.id);
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewerSave = await call('POST', '/issues/filters', { name: 'v', query: 'type = task' });
    out.viewerList = (await call('GET', '/issues/filters')).j.filters.map((f) => f.name);
    as(ADM);
    out.admList = (await call('GET', '/issues/filters')).j.filters.map((f) => f.name);
    out.admDel = await call('DELETE', '/issues/filters/' + out.shared.id);
  `);
  assert.deepEqual(out.all.rows.map((r) => r.priority), ['p1', 'p0'], 'ORDER BY priority DESC');
  assert.ok(out.all.query.clauses.length === 1);
  assert.equal(out.bad.s, 400); assert.equal(out.bad.j.code, 'query'); assert.equal(out.bad.j.errors[0].start, 9); assert.match(out.bad.j.errors[0].hint, /progress/);
  assert.deepEqual(out.scoped, ['vc-a'], '식에 다른 법인을 적어도 범위 밖은 보이지 않는다');
  assert.equal(out.scopedShare.s, 403, '공유는 전체 범위 쓰기 계정만'); assert.equal(out.scopedMine.s, 200);
  assert.equal(out.badFilter.s, 400); assert.equal(out.badFilter.j.code, 'query');
  assert.deepEqual(out.saList.sort(), [['내 법인', true, false], ['장애 미해결', false, true]].sort());
  assert.equal(out.saEditShared.s, 403); assert.equal(out.saDelShared.s, 403);
  assert.equal(out.viewerSave.s, 403, 'viewer 는 필터를 저장하지 않는다(상태변경은 쓰기 역할)');
  assert.deepEqual(out.viewerList, ['장애 미해결'], 'viewer 도 공유 필터는 본다');
  assert.ok(!out.admList.includes('내 법인'), '남의 개인 필터는 보이지 않는다');
  assert.equal(out.admDel.s, 200, '공유 필터는 전체 범위 관리자가 정리한다');
  // 손상 파일 — 보존하고 빈 목록으로
  fs.writeFileSync(path.join(dir, 'issue-sprints.json'), '{깨짐');
  fs.writeFileSync(path.join(dir, 'issue-filters.json'), '{깨짐');
  const again = run(`
    out.sprints = (await call('GET', '/issues/sprints')).j;
    out.filters = (await call('GET', '/issues/filters')).j;
  `, { pre: (d) => { fs.copyFileSync(path.join(dir, 'issue-sprints.json'), path.join(d, 'issue-sprints.json')); fs.copyFileSync(path.join(dir, 'issue-filters.json'), path.join(d, 'issue-filters.json')); } });
  assert.deepEqual(again.out.sprints.sprints, []); assert.ok(again.out.sprints.loadError, '관리자에게 손상을 알린다');
  assert.deepEqual(again.out.filters.filters, []); assert.ok(again.out.filters.loadError);
  const kept = fs.readdirSync(again.dir).filter((n) => /^issue-(sprints|filters)\.json\.corrupt\./.test(n));
  assert.equal(kept.length, 2, '손상 원본은 지우지 않고 보존');
});
