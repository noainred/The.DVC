/**
 * issues2871.test.js — 이슈 트래커 v2.871: 법인(vCenter) 축 · 담당자 후보 축소(감사 A3-02) · viewer 요청 등록 · 자동 할당 · 알림.
 *
 * 실제 `api` 라우터를 express 에 마운트하고 역할·범위를 바꿔 가며 상태코드를 본다(v2.536 규약 — 소스 grep 이 아니다).
 * 알림은 발송 함수를 바꿔 끼워(_setIssueNotifySendersForTest) **실제로 나간 메일**을 본다(push 진입 함수는 실제로 호출한다 — common.md).
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

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issues2871-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const nt = await import(${JSON.stringify(path.join(SRC, 'issues/notify.js'))});
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
    const ADM = { username: 'adm', role: 'admin', scope: null };
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

test('① 법인 축 — 범위 계정은 자기 법인 이슈만 · 공용 이슈는 보지 않는다 · 조회 밖 404 → 쓰기 밖 403', () => {
  const { out } = run(`
    const pub = (await call('POST', '/issues', { title: '공용 이슈' })).j.issue.key;
    const a = (await call('POST', '/issues', { title: '법인 A', vcenterId: 'vc-a' })).j.issue.key;
    const b = (await call('POST', '/issues', { title: '법인 B', vcenterId: 'vc-b' })).j.issue.key;
    out.badVc = await call('POST', '/issues', { title: 'x', vcenterId: 'has space' });
    const opA = { username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    as(opA);
    out.listA = await call('GET', '/issues');
    out.statsA = await call('GET', '/issues/stats');
    out.getPub = await call('GET', '/issues/' + pub);
    out.getB = await call('GET', '/issues/' + b);
    out.assignB = await call('POST', '/issues/' + b + '/assign', { assignee: 'x' });
    out.getA = await call('GET', '/issues/' + a);
    out.assignA = await call('POST', '/issues/' + a + '/assign', { assignee: 'opa' });
    out.noVc = await call('POST', '/issues', { title: '법인 없음' });
    out.otherVc = await call('POST', '/issues', { title: '남의 법인', vcenterId: 'vc-b' });
    out.ownVc = await call('POST', '/issues', { title: '내 법인', vcenterId: 'vc-a' });
    out.moveOut = await call('PUT', '/issues/' + a, { vcenterId: 'vc-b' });
    out.bulk = await call('POST', '/issues/bulk/assign', { keys: [a, b, pub], assignee: 'opa' });
    out.filter = await call('GET', '/issues?vcenterId=vc-b');
    // 조회는 A·B, 쓰기는 A 만
    as({ username: 'opab', role: 'operator', scope: { vcenters: ['vc-a', 'vc-b'], writeVcenters: ['vc-a'] } });
    out.roGet = await call('GET', '/issues/' + b);
    out.roAssign = await call('POST', '/issues/' + b + '/assign', { assignee: 'x' });
    out.roComment = await call('POST', '/issues/' + b + '/comments', { body: 'x' });
    out.roCreate = await call('POST', '/issues', { title: 'ro', vcenterId: 'vc-b' });
    out.roWatch = await call('POST', '/issues/' + b + '/watch', { on: true });
    out.meta = await call('GET', '/issues/meta');
  `);
  assert.equal(out.badVc.s, 400);
  assert.deepEqual(out.listA.j.rows.map((r) => r.title).sort(), ['법인 A'], '범위 계정은 자기 법인 이슈만 · 공용은 보지 않는다');
  assert.equal(out.statsA.j.open, 1, '통계도 범위 안만 센다');
  assert.equal(out.getPub.s, 404, '공용 이슈는 존재를 숨긴다');
  assert.equal(out.getB.s, 404, '남의 법인 이슈는 존재를 숨긴다');
  assert.equal(out.assignB.s, 404);
  assert.equal(out.getA.s, 200);
  assert.equal(out.getA.j.issue.writable, true);
  assert.equal(out.assignA.s, 200);
  assert.equal(out.noVc.s, 400, '범위 계정은 법인을 골라야 한다');
  assert.equal(out.noVc.j.field, 'vcenterId');
  assert.equal(out.otherVc.s, 400, '조회 밖 법인은 존재를 흘리지 않는다(400 — 403 이 아니다)');
  assert.equal(out.ownVc.s, 200);
  assert.equal(out.ownVc.j.issue.vcenterId, 'vc-a');
  assert.equal(out.moveOut.s, 400, '조회 밖 법인으로 옮기지 못한다');
  assert.deepEqual(out.bulk.j.results.map((r) => r.ok), [true, false, false], '일괄 할당도 키마다 범위를 본다');
  assert.equal(out.filter.j.rows.length, 0, '요청 필터로 범위를 넘지 못한다');
  assert.equal(out.roGet.s, 200, '조회 범위면 본다');
  assert.equal(out.roGet.j.issue.writable, false, '화면이 버튼을 잠그게 writable:false');
  assert.equal(out.roAssign.s, 403, '조회는 되지만 쓰기 밖은 403');
  assert.equal(out.roComment.s, 403);
  assert.equal(out.roCreate.s, 403);
  assert.equal(out.roWatch.s, 200, '관찰은 본인 표지라 조회 범위면 된다');
  assert.deepEqual(out.meta.j.vcenters.map((v) => [v.id, v.writable]).filter(([id]) => ['vc-a', 'vc-b'].includes(id)), [], '스냅샷에 없는 vCenter 는 선택지에 없다(목 스냅샷 기준)');
  assert.equal(out.meta.j.scoped, true);
});

test('② 감사 A3-02 — 담당자 후보: 전체 범위는 전 계정 · 범위 계정은 보이는 이슈의 이름 + 자기 자신 · viewer 는 빈 목록', () => {
  const { out } = run(`
    await call('POST', '/issues', { title: 'A', vcenterId: 'vc-a', assignee: 'alice' });
    await call('POST', '/issues', { title: 'B', vcenterId: 'vc-b', assignee: 'bob' });
    as({ username: 'opfull', role: 'operator', scope: null });
    out.full = await call('GET', '/issues/meta');
    as({ username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } });
    out.scoped = await call('GET', '/issues/meta');
    as({ username: 'v', role: 'viewer', scope: null });
    out.viewer = await call('GET', '/issues/meta');
  `);
  const names = (r) => r.j.people.map((p) => p.username);
  assert.ok(names(out.full).includes('bob') && names(out.full).includes('alice'));
  assert.ok(names(out.full).includes('admin'), '전체 범위 쓰기 계정은 로컬 계정을 받는다');
  assert.deepEqual(names(out.scoped).sort(), ['adm', 'alice', 'opa'].sort(), '범위 계정은 보이는 이슈의 이름 + 자기 자신만(로컬 계정 목록·남의 법인 이름 없음)');
  assert.deepEqual(out.viewer.j.people, []);
});

test('③ viewer 요청 등록 — 요청 유형·백로그만 · 담당자·상태는 무시 · 권한 키를 끄면 403', () => {
  const { out } = run(`
    as({ username: 'v', role: 'viewer', scope: null });
    out.req = await call('POST', '/issues', { title: '권한 요청', type: 'incident', status: 'progress', assignee: 'kim', watchers: ['x'] });
    out.assign = await call('POST', '/issues/' + out.req.j.issue.key + '/assign', { assignee: 'v' });
    out.meta = await call('GET', '/issues/meta');
    as({ username: 'vs', role: 'viewer', scope: { vcenters: ['vc-a'] } });
    out.scopedNoVc = await call('POST', '/issues', { title: 'x' });
    out.scopedVc = await call('POST', '/issues', { title: 'x', vcenterId: 'vc-a' });
  `);
  assert.equal(out.req.s, 200);
  assert.equal(out.req.j.issue.type, 'request');
  assert.equal(out.req.j.issue.status, 'backlog');
  assert.equal(out.req.j.issue.assignee, '', '요청자는 담당자를 정하지 않는다');
  assert.deepEqual(out.req.j.issue.watcherNames, []);
  assert.equal(out.req.j.issue.history[0].note, '요청 등록');
  assert.equal(out.assign.s, 403, '요청 권한은 생성뿐이다');
  assert.equal(out.meta.j.canRequest, true);
  assert.equal(out.meta.j.canWrite, false);
  assert.equal(out.scopedNoVc.s, 400, '범위 viewer 도 법인을 고른다');
  assert.equal(out.scopedVc.s, 200);

  const off = run(`
    as({ username: 'v', role: 'viewer', scope: null });
    out.req = await call('POST', '/issues', { title: 'x' });
    out.meta = await call('GET', '/issues/meta');
  `, { pre: (dir) => fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 4, matrix: { operator: ['dashboard', 'issues.request'], viewer: ['dashboard'] } })) });
  assert.equal(off.out.req.s, 403, '관리자가 viewer 행에서 issues.request 를 끄면 막힌다');
  assert.equal(off.out.meta.j.canRequest, false);

  const old = run(`
    as({ username: 'v', role: 'viewer', scope: null });
    out.req = await call('POST', '/issues', { title: 'x' });
  `, { pre: (dir) => fs.writeFileSync(path.join(dir, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { operator: ['dashboard'], viewer: ['dashboard'] } })) });
  assert.equal(old.out.req.s, 200, '이 키가 생기기 전(스키마 3) 파일에는 기본값으로 가산된다(KEYS_ADDED_IN 4)');

  // 인증을 끈 설치 + 대체 역할 viewer — authMiddleware 가 req.user 를 그 역할로 채운다. 인증 여부로 가르지 않으므로 요청 전용 제한이 그대로다.
  const anon = run(`
    as({ username: 'anonymous', role: 'viewer', name: 'Anonymous' });
    out.req = await call('POST', '/issues', { title: 'x', type: 'incident', assignee: 'kim', status: 'progress' });
    out.assign = await call('POST', '/issues/' + out.req.j.issue.key + '/assign', { assignee: 'kim' });
  `, { env: { AUTH_ENABLED: 'false', AUTH_DISABLED_ROLE: 'viewer' } });
  assert.equal(anon.out.req.s, 200);
  assert.equal(anon.out.req.j.requestOnly, true, '대체 역할 viewer 는 요청 유형만');
  assert.equal(anon.out.req.j.issue.assignee, '');
  assert.equal(anon.out.assign.s, 403);
});

test('④ 자동 할당 — 설정은 전체 범위 관리자만 · 컴포넌트 기본 담당자 → 부하 최소 · 이력에 근거', () => {
  const { out } = run(`
    as({ username: 'op', role: 'operator', scope: null });
    out.opGet = await call('GET', '/issues/settings');
    out.opPut = await call('PUT', '/issues/settings', {});
    as({ username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } });
    out.scopedPut = await call('PUT', '/issues/settings', {});
    as(ADM);
    out.bad = await call('PUT', '/issues/settings', { autoAssign: { enabled: true, pool: ['has space'] } });
    out.put = await call('PUT', '/issues/settings', { autoAssign: { enabled: true, components: [{ name: 'vCenter 수집기', assignee: 'kim' }], pool: ['lee', 'park'] } });
    await call('POST', '/issues', { title: '선점', assignee: 'lee' });
    out.byComp = await call('POST', '/issues', { title: 'c', component: 'VCENTER 수집기' });
    out.byLoad = await call('POST', '/issues', { title: 'l' });
    out.explicit = await call('POST', '/issues', { title: 'e', assignee: 'choi' });
    out.suggest = await call('GET', '/issues/suggest?component=' + encodeURIComponent('vCenter 수집기'));
    await call('PUT', '/issues/settings', { autoAssign: { enabled: false, components: [{ name: 'vCenter 수집기', assignee: 'kim' }], pool: [] } });
    out.offCreate = await call('POST', '/issues', { title: 'off', component: 'vCenter 수집기' });
    out.offSuggest = await call('GET', '/issues/suggest?component=' + encodeURIComponent('vCenter 수집기'));
  `);
  assert.equal(out.opGet.s, 403);
  assert.equal(out.opPut.s, 403);
  assert.equal(out.scopedPut.s, 403, '전 법인 공용 설정은 범위 관리자가 바꾸지 못한다');
  assert.equal(out.bad.s, 400);
  assert.equal(out.put.s, 200);
  assert.equal(out.byComp.j.issue.assignee, 'kim', '컴포넌트 기본 담당자(대소문자 무시)');
  assert.match(out.byComp.j.issue.history.find((h) => h.field === 'assignee').note, /자동 할당: 컴포넌트/);
  assert.equal(out.byLoad.j.issue.assignee, 'park', '후보 중 열린 이슈가 적은 사람(lee 1건 · park 0건)');
  assert.equal(out.explicit.j.issue.assignee, 'choi', '사람이 정한 담당자를 덮지 않는다');
  assert.equal(out.suggest.j.suggestion.assignee, 'kim');
  assert.equal(out.offCreate.j.issue.assignee, '', '꺼져 있으면 자동으로 정하지 않는다');
  assert.equal(out.offSuggest.j.suggestion.assignee, 'kim', '꺼져 있어도 제안은 한다');
  assert.equal(out.offSuggest.j.autoAssign, false);
});

test('⑤ 알림 — 받는 사람마다 묶어 한 통 · 본인 제외 · @멘션 · 주소 없는 사람은 센다 · 기한은 하루 한 번', () => {
  const { out } = run(`
    const mails = []; const chats = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async (t) => { chats.push(t); return ['slack:200']; } });
    nt.startIssueNotify();
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, chat: true, people: [{ username: 'kim', email: 'kim@example.com' }, { username: 'lee', email: 'lee@example.com' }] } });
    as({ username: 'lee', role: 'operator', scope: null });
    const k1 = (await call('POST', '/issues', { title: '첫째', assignee: 'kim' })).j.issue.key;
    const k2 = (await call('POST', '/issues', { title: '둘째' })).j.issue.key;
    await call('POST', '/issues/bulk/assign', { keys: [k2], assignee: 'kim' });
    await call('POST', '/issues/' + k1 + '/comments', { body: '확인 부탁드립니다 @park 그리고 @kim' });
    as({ username: 'kim', role: 'operator', scope: null });
    await call('POST', '/issues/' + k1 + '/status', { status: 'progress' });
    out.flush = await nt.flushIssueNotify();
    out.mails = mails.map((m) => ({ to: m.to, kind: m.kind, n: (m.text.match(/\\n· /g) || []).length, text: m.text }));
    out.chats = chats.length;
    out.status = nt.issueNotifyStatus();
    // 기한 — 지난 기한 1건
    as({ username: 'lee', role: 'operator', scope: null });
    await call('POST', '/issues', { title: '늦음', assignee: 'kim', dueAt: Date.now() - 3 * 86400000 });
    await nt.flushIssueNotify(); mails.length = 0;
    out.due1 = nt.scanDue();
    out.due2 = nt.scanDue();
    await nt.flushIssueNotify();
    out.dueMails = mails.map((m) => m.text);
  `);
  const byTo = Object.fromEntries(out.mails.map((m) => [m.to[0], m]));
  assert.equal(out.mails.length, 2, `kim·lee 각 한 통(묶음) — ${JSON.stringify(out.mails.map((m) => m.to))}`);
  assert.ok(out.mails.every((m) => m.kind === 'issues'));
  assert.equal(byTo['kim@example.com'].n, 3, 'kim: 할당 2 · 댓글 멘션 1(본인이 바꾼 상태는 빠진다)');
  assert.match(byTo['kim@example.com'].text, /댓글에서 언급했습니다/);
  assert.ok(!/상태 할 일/.test(byTo['kim@example.com'].text) && !/상태 백로그 → 진행 중/.test(byTo['kim@example.com'].text), '본인이 바꾼 상태는 본인에게 보내지 않는다');
  assert.match(byTo['lee@example.com'].text, /상태 백로그 → 진행 중/, '보고자 lee 는 kim 이 바꾼 상태를 받는다');
  assert.equal(out.status.noEmail, 0, '모르는 이름(@park — 계정·주소 표·참여자 어디에도 없음)은 수신자 자리를 차지하지 않는다(v2.871 감사 A5-02)');
  assert.equal(out.chats, 1, '팀 채팅은 묶어 한 통');
  assert.equal(out.due1, 1);
  assert.equal(out.due2, 0, '같은 날 두 번 알리지 않는다');
  assert.equal(out.dueMails.length, 1);
  assert.match(out.dueMails[0], /기한이 지났습니다/);
});

test('⑥ 알림 설정 저장소 — 손상 파일은 보존하고 기본값(꺼짐)으로 · 화면이 loadError 로 말한다', () => {
  const { out, dir } = run(`
    out.get = await call('GET', '/issues/settings');
  `, { pre: (dir) => fs.writeFileSync(path.join(dir, 'issue-settings.json'), '{"autoAssign": {') });
  assert.equal(out.get.s, 200);
  assert.equal(out.get.j.settings.autoAssign.enabled, false);
  assert.equal(out.get.j.settings.notify.enabled, false);
  assert.ok(out.get.j.loadError, 'loadError 를 싣는다');
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('issue-settings.json.corrupt')).length, 1);
});

test('⑦ 진행률·활동 피드 — 0~100 정수만 · 쓰기 범위 · 이력·알림 · 피드는 볼 수 있는 이슈만', () => {
  const { out } = run(`
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    nt.startIssueNotify();
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [{ username: 'lee', email: 'lee@example.com' }] } });
    const a = (await call('POST', '/issues', { title: '법인 A 작업', vcenterId: 'vc-a', assignee: 'kim' })).j.issue.key;
    const b = (await call('POST', '/issues', { title: '법인 B 작업', vcenterId: 'vc-b' })).j.issue.key;
    await call('POST', '/issues/' + b + '/comments', { body: 'B 비밀 메모' });
    out.bad1 = await call('POST', '/issues/' + a + '/progress', { progress: 101 });
    out.bad2 = await call('POST', '/issues/' + a + '/progress', { progress: 12.5 });
    out.bad3 = await call('POST', '/issues/' + a + '/progress', { progress: '-1' });
    as({ username: 'lee', role: 'operator', scope: null });
    out.ok = await call('POST', '/issues/' + a + '/progress', { progress: 40, note: 'ESXi 3대 중 1대 완료' });
    out.same = await call('POST', '/issues/' + a + '/progress', { progress: 40, note: 'ESXi 3대 중 1대 완료' });
    out.clear = await call('POST', '/issues/' + a + '/progress', { progress: null });
    out.set2 = await call('POST', '/issues/' + a + '/progress', { progress: '70' });
    out.list = await call('GET', '/issues');
    // 조회 A·B 쓰기 A
    as({ username: 'ro', role: 'operator', scope: { vcenters: ['vc-a', 'vc-b'], writeVcenters: ['vc-a'] } });
    out.roB = await call('POST', '/issues/' + b + '/progress', { progress: 10 });
    as({ username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } });
    out.outB = await call('POST', '/issues/' + b + '/progress', { progress: 10 });
    out.feedA = await call('GET', '/issues/activity');
    out.feedSince = await call('GET', '/issues/activity?since=' + (Date.now() + 60000));
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewer = await call('POST', '/issues/' + a + '/progress', { progress: 90 });
    out.feedV = await call('GET', '/issues/activity?limit=2');
    as({ username: 'kim', role: 'operator', scope: null });
    out.flush = await nt.flushIssueNotify();
    out.mails = mails.map((m) => ({ to: m.to, text: m.text }));
  `);
  assert.equal(out.bad1.s, 400); assert.equal(out.bad2.s, 400); assert.equal(out.bad3.s, 400);
  assert.equal(out.ok.s, 200);
  assert.equal(out.ok.j.issue.progress, 40);
  assert.equal(out.ok.j.issue.progressBy, 'lee');
  const hist = out.set2.j.issue.history.filter((h) => h.field === 'progress');
  assert.deepEqual(hist.map((h) => [h.from, h.to]), [['', '40'], ['40', ''], ['', '70']], '값이 같은 저장은 이력을 남기지 않는다');
  assert.equal(out.set2.j.issue.progress, 70);
  const row = out.list.j.rows.find((r) => r.title === '법인 A 작업');
  assert.equal(row.progress, 70, '목록 요약에 진행률이 실린다');
  assert.equal(out.roB.s, 403, '조회는 되지만 쓰기 밖 → 403');
  assert.equal(out.outB.s, 404, '조회 밖 → 404');
  assert.equal(out.viewer.s, 403, 'viewer 는 진행률을 바꾸지 못한다');
  const keysA = new Set(out.feedA.j.items.map((i) => i.title));
  assert.ok(keysA.has('법인 A 작업'));
  assert.ok(!keysA.has('법인 B 작업'), '범위 밖 이슈의 활동은 피드에 없다');
  assert.ok(!out.feedA.j.items.some((i) => /B 비밀/.test(i.to)), '범위 밖 댓글 발췌도 없다');
  assert.ok(out.feedA.j.items.some((i) => i.field === 'progress'));
  const ats = out.feedA.j.items.map((i) => i.at);
  assert.deepEqual(ats, [...ats].sort((x, y) => y - x), '최신순');
  assert.equal(out.feedSince.j.items.length, 0);
  assert.equal(out.feedV.s, 200, 'viewer 도 피드를 본다(조회)');
  assert.equal(out.feedV.j.items.length, 2);
  assert.equal(out.feedV.j.truncated, true);
  const kimMail = out.mails.find((m) => m.to[0] === 'kim@example.com');
  assert.equal(kimMail, undefined, 'kim 은 주소가 없다');
  assert.ok(!out.mails.some((m) => m.to[0] === 'lee@example.com' && /진행률/.test(m.text)), '본인(lee)이 바꾼 진행률은 본인에게 보내지 않는다');
});

/* ───────────── v2.871 5축 점검 + 반증 확정분(scratchpad 감사 A1~A5 · VERIFY) ───────────── */

test('감사 A3-01·A2-06·A5-02 — 알림은 그 법인을 볼 수 있는 사람만 · 멘션은 알려진 이름의 가장 긴 접두 · 모르는 이름은 자리를 차지하지 않는다', () => {
  const { out } = run(`
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    auth.createUser({ username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } }, { trusted: true });
    auth.createUser({ username: 'opb', role: 'operator', scope: { vcenters: ['vc-b'] } }, { trusted: true });
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    nt.startIssueNotify();
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [
      { username: 'opa', email: 'opa@example.com' }, { username: 'opb', email: 'opb@example.com' }, { username: 'kim', email: 'kim@example.com' } ] } });
    const b = (await call('POST', '/issues', { title: '법인B 비밀 장애 제목', vcenterId: 'vc-b', watchers: ['opa'] })).j.issue.key;
    await call('POST', '/issues/' + b + '/comments', { body: '@opa 확인 @opb님 @kim. 그리고 @ghost1 @ghost2' });
    out.flush = await nt.flushIssueNotify();
    out.to = mails.map((m) => m.to[0]).sort();
    out.text = mails.map((m) => m.text).join('\\n');
    out.status = nt.issueNotifyStatus();
    out.resolve = nt.resolveMentions(['kim님', 'park.', 'parker', 'kim.lee', 'DOMAIN\\\\lee,'], new Set(['kim', 'park', 'kim.lee', 'DOMAIN\\\\lee']));
  `);
  assert.ok(!out.to.includes('opa@example.com'), `범위 밖(vc-a) 계정 opa 는 관찰자·멘션이어도 법인 B 이슈 메일을 받지 않는다 — ${out.to}`);
  assert.ok(out.to.includes('opb@example.com'), '법인 B 를 보는 opb 는 멘션(@opb님 — 조사 붙음)으로 받는다');
  assert.ok(out.to.includes('kim@example.com'), '로컬 계정이 아닌 이름(AD — 범위 축 없음)은 받는다(@kim. — 문장 끝 마침표)');
  assert.ok(out.status.outOfScope >= 1, '범위 밖으로 뺀 수를 센다');
  assert.equal(out.status.noEmail, 0, '@ghost1·@ghost2(어디에도 없는 이름)는 수신자가 아니다');
  assert.deepEqual(out.resolve, ['kim', 'park', 'kim.lee', 'DOMAIN\\lee'], "'parker' 는 'park' 이 아니다 · 'kim.lee' 는 더 긴 이름");
});

test('감사 A2-03·A3-03·A4-05·A2-05·A5-03 — 채팅은 개인 수신자와 따로 · 제어 표기 무력화 · 채널 일부 실패를 센다 · 끈 뒤에는 보내지 않는다 · flush 는 겹치지 않는다', () => {
  const { out } = run(`
    const chats = []; const mails = []; let inFlight = 0; let maxIn = 0;
    nt._setIssueNotifySendersForTest({
      mail: async (o) => { inFlight++; maxIn = Math.max(maxIn, inFlight); await new Promise((r) => setTimeout(r, 30)); inFlight--; mails.push(o); return { ok: true }; },
      chat: async (t) => { chats.push(t); return ['slack:200', 'teams:500']; },
    });
    nt.startIssueNotify();
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, chat: true, people: [{ username: 'kim', email: 'kim@example.com' }] } });
    as({ username: 'vw', role: 'viewer', scope: null });
    await call('POST', '/issues', { title: '<!channel> 긴급 [여기](http://evil.example) 확인' });
    as(ADM);
    out.f1 = await nt.flushIssueNotify();
    out.chats = chats.slice();
    out.status1 = nt.issueNotifyStatus();
    // 겹친 flush — 같은 사람 메일이 동시에 두 번 나가지 않는다
    await call('POST', '/issues', { title: '둘', assignee: 'kim' });
    const p1 = nt.flushIssueNotify(); const p2 = nt.flushIssueNotify();
    await Promise.all([p1, p2]);
    out.maxIn = maxIn; out.mailN = mails.length;
    // 쌓인 뒤 알림을 끄면 보내지 않는다
    await call('POST', '/issues', { title: '셋', assignee: 'kim' });
    await call('PUT', '/issues/settings', { notify: { enabled: false, people: [{ username: 'kim', email: 'kim@example.com' }] } });
    const before = mails.length;
    out.f3 = await nt.flushIssueNotify();
    out.afterOff = mails.length - before;
  `);
  assert.equal(out.chats.length, 1, '담당자 없는 새 요청도 팀 채팅에는 간다(A2-03)');
  assert.ok(!/<!channel>/.test(out.chats[0]) && !/\[여기\]\(http/.test(out.chats[0]), `채팅 제어 표기가 그대로 실리지 않는다(A3-03): ${out.chats[0]}`);
  assert.match(out.chats[0], /‹!channel›/);
  assert.equal(out.status1.chat, 1);
  assert.equal(out.status1.chatFail, 1, '채널 하나(teams:500)가 실패하면 실패로도 센다(A4-05)');
  assert.match(out.status1.lastError, /teams:500/);
  assert.equal(out.maxIn, 1, '겹친 flush 가 동시에 보내지 않는다(A5-03)');
  assert.equal(out.mailN, 1);
  assert.equal(out.afterOff, 0, '알림을 끈 뒤의 flush 는 보내지 않는다(A2-05)');
});

test('감사 A2-02·A5-04·A2-07·A4-03 — 기한 기록은 보낸 뒤에 · 재기동 뒤 다시 보낸다 · 메일 날짜는 포탈 날짜 · 서버와 화면의 기한 판정이 같다', async () => {
  const { out } = run(`
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [{ username: 'kim', email: 'kim@example.com' }] } });
    // KST 08:00 기한(= UTC 전날 23:00) — 오늘 이전 날짜로 지난 것
    const { dayKey } = await import(${JSON.stringify(path.join(SRC, 'util/dayKey.js'))});
    const now = Date.now();
    const kst8 = Date.parse(dayKey(now - 2 * 86400000) + 'T08:00:00+09:00');
    await call('POST', '/issues', { title: '늦음', assignee: 'kim', dueAt: kst8 });
    out.scan1 = nt.scanDue();
    // flush 전에 '재기동' — 메모리 묶음을 잃는다
    nt._resetIssueNotifyForTest();
    out.stateAfterCrash = fs.existsSync(path.join(process.env.CONFIG_DIR, 'issue-notify-state.json')) ? JSON.parse(fs.readFileSync(path.join(process.env.CONFIG_DIR, 'issue-notify-state.json'), 'utf8')) : null;
    out.scan2 = nt.scanDue();
    await nt.flushIssueNotify();
    out.scan3 = nt.scanDue();
    out.mails = mails.map((m) => m.text);
    out.expectDay = dayKey(kst8);
    // 오늘 00:01(포탈 날짜) 기한 — 시각으로는 지났지만 날짜로는 '오늘'(화면 dueInfo 와 같은 판정 · 감사 A4-03)
    const today0001 = Date.parse(dayKey(Date.now()) + 'T00:01:00+09:00');
    if (Date.now() - today0001 > 60_000) await call('POST', '/issues', { title: '오늘', assignee: 'lee', dueAt: today0001 });
    out.hasToday = Date.now() - today0001 > 60_000;
    out.stats = (await call('GET', '/issues/stats')).j;
  `, { pre: () => {} });
  assert.equal(out.scan1, 1);
  assert.ok(!out.stateAfterCrash || !Object.keys(out.stateAfterCrash.sent || {}).length, '보내기 전에는 기록을 쓰지 않는다');
  assert.equal(out.scan2, 1, '재기동 뒤 검사가 다시 보낸다');
  assert.equal(out.scan3, 0, '보낸 뒤에는 같은 날 다시 보내지 않는다');
  assert.equal(out.mails.length, 1);
  assert.ok(out.mails[0].includes(out.expectDay), `메일 날짜는 포탈 날짜(${out.expectDay}) — ${out.mails[0]}`);
  assert.match(out.mails[0], /기한이 지났습니다/);
  assert.equal(out.stats.overdue, 1, '오늘이 기한인 이슈는 초과가 아니다(날짜 기준)');
  if (out.hasToday) assert.ok(out.stats.dueSoon >= 1, '오늘 기한은 곧(soon)으로 센다');
});

test('감사 A4-03 — 서버 dueDays 와 화면 dueInfo 가 같은 입력에서 같은 판정(한국 시각)', async () => {
  process.env.TZ = 'Asia/Seoul';
  const { dueDays, DUE_SOON_DAYS } = await import('../src/issues/store.js');
  const { dueInfo } = await import('../../web/src/views/issues/issueText.js');
  const HOUR = 3600_000;
  const base = Math.floor(Date.now() / HOUR) * HOUR;
  for (let h = -80; h <= 80; h += 1) {
    for (const nowOff of [0, 3, 9, 15, 23]) {
      const now = base + nowOff * HOUR; const due = now + h * HOUR;
      const d = dueDays(due, now); const w = dueInfo(due, { now });
      const server = d < 0 ? 'over' : d <= DUE_SOON_DAYS ? 'soon' : '';
      assert.equal(server, w.tone, `now+${nowOff}h due${h}h: 서버 ${server} · 화면 ${w.tone}`);
    }
  }
});

test('감사 A3-02·A3-04·A3-05·A1-01·A1-02·A1-05·N1 — 요청 상한 · 제안 이름 가림 · 쓰기 제한 관리자 설정 403 · meta.writeScoped · 행 writable · 그대로인 법인은 재검사 안 함 · 담당자 후보', () => {
  const { out } = run(`
    await call('PUT', '/issues/settings', { autoAssign: { enabled: false, components: [{ name: '스토리지', assignee: 'storage.admin' }] } });
    // A3-02: 한 사람 열린 요청 상한
    as({ username: 'vw', role: 'viewer', scope: null });
    let last = null;
    for (let i = 0; i < 21; i++) last = await call('POST', '/issues', { title: '요청 ' + i });
    out.req21 = last;
    // A3-04: 요청 계정에게 제안 이름을 주지 않는다
    out.vwSuggest = await call('GET', '/issues/suggest?component=' + encodeURIComponent('스토리지'));
    as(ADM);
    out.admSuggest = await call('GET', '/issues/suggest?component=' + encodeURIComponent('스토리지'));
    // A1-02 · A1-01 · A3-05 · N1: 조회 무제한 + 쓰기 vc-a
    const a = (await call('POST', '/issues', { title: 'A', vcenterId: 'vc-a' })).j.issue.key;
    await call('POST', '/issues', { title: 'B', vcenterId: 'vc-b' });
    const W = { username: 'wa', role: 'admin', scope: { writeVcenters: ['vc-a'] } };
    as(W);
    out.meta = (await call('GET', '/issues/meta')).j;
    out.rows = (await call('GET', '/issues?limit=100')).j.rows.map((r) => [r.title, r.writable]);
    out.putSettings = await call('PUT', '/issues/settings', { notify: { enabled: false } });
    out.pub = await call('POST', '/issues', { title: '공용 시도' });
    // A1-05: 등록에서 빠진 법인 — 값 그대로 보내면 수정 저장된다
    as(ADM);
    const snap = (await import(${JSON.stringify(path.join(SRC, 'store.js'))})).store;
    snap.snapshot = { ...snap.snapshot, vcenters: [{ id: 'vc-b', name: 'B' }] }; // vc-a 가 등록에서 빠진 상황
    out.keepVc = await call('PUT', '/issues/' + a, { title: 'A 수정', vcenterId: 'vc-a' });
    out.moveVc = await call('PUT', '/issues/' + a, { vcenterId: 'vc-zz' });
  `);
  assert.equal(out.req21.s, 409, `열린 요청 21번째는 거부 — ${JSON.stringify(out.req21.j)}`);
  assert.match(out.req21.j.reason, /한 사람당 20건/);
  assert.equal(out.vwSuggest.j.suggestion, null, '요청 계정에게 계정명을 알려 주지 않는다');
  assert.equal(out.vwSuggest.j.hidden, true);
  assert.equal(out.admSuggest.j.suggestion.assignee, 'storage.admin', '전체 범위 쓰기 계정은 제안을 본다');
  assert.equal(out.meta.writeScoped, true);
  assert.equal(out.meta.scoped, false);
  assert.equal(out.meta.canSettings, false, '쓰기 제한 관리자에게 설정 탭을 열지 않는다');
  assert.deepEqual(out.meta.people.map((p) => p.username).filter((n) => n === 'noainred'), [], 'N1: 쓰기 제한 계정에게 로컬 계정 전체 목록을 주지 않는다');
  const rw = Object.fromEntries(out.rows);
  assert.equal(rw.A, true); assert.equal(rw.B, false, '쓰기 범위 밖 행은 writable:false');
  assert.equal(out.putSettings.s, 403, 'A3-05: 쓰기 범위가 지정된 관리자는 전 법인 공용 설정을 바꾸지 못한다');
  assert.equal(out.pub.s, 400, '쓰기 제한 계정은 공용 이슈를 만들 수 없다(화면이 공용 선택지를 숨긴다 — A1-01)');
  assert.equal(out.keepVc.s, 200, `값이 그대로면 재검사하지 않는다(A1-05) — ${JSON.stringify(out.keepVc.j)}`);
  assert.equal(out.moveVc.s, 400, '바꿀 때는 검사한다');
});

test('감사 A2-04 — 손상 설정은 재기동 뒤에도 loadError 를 말한다(보존본만 남은 경우)', () => {
  const { out } = run(`
    out.first = (await call('GET', '/issues/settings')).j.loadError;
  `, { pre: (dir) => fs.writeFileSync(path.join(dir, 'issue-settings.json'), '{"autoAssign":') });
  assert.ok(out.first);
  // 같은 폴더로 다시 기동 — 원본은 보존본으로 옮겨졌다
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'issues2871-c-'));
  fs.writeFileSync(path.join(dir2, 'issue-settings.json.corrupt.1700000000000'), '{"autoAssign":');
  const r2 = run(`out.second = (await call('GET', '/issues/settings')).j.loadError;`, { pre: (dir) => { for (const n of fs.readdirSync(dir2)) fs.copyFileSync(path.join(dir2, n), path.join(dir, n)); } });
  assert.ok(r2.out.second, '재기동 뒤에도 못 읽음을 말한다');
});

test('감사 A5-01 — 이슈 메일은 메일 설정 시간당 한도의 절반까지 · 넘는 것은 버리지 않고 미룬다', () => {
  const { out } = run(`
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    nt.startIssueNotify();
    const people = Array.from({ length: 6 }, (_, i) => ({ username: 'u' + i, email: 'u' + i + '@example.com' }));
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people } });
    const ms = await import(${JSON.stringify(path.join(SRC, 'mail/settings.js'))});
    out.budgetDefault = nt.issueMailBudget();
    for (let i = 0; i < 6; i++) await call('POST', '/issues', { title: 't' + i, assignee: 'u' + i });
    out.f = await nt.flushIssueNotify();
    out.n = mails.length;
    out.status = nt.issueNotifyStatus();
  `, { pre: (dir) => fs.writeFileSync(path.join(dir, 'mail.json'), JSON.stringify({ rateLimitPerHour: 8 })) });
  assert.equal(out.budgetDefault, 4, '메일 설정 한도 8 의 절반');
  assert.equal(out.n, 4, '한도의 절반(4통)까지만');
  assert.equal(out.f.deferred, 2);
  assert.equal(out.status.mailDeferred, 2);
  assert.equal(out.status.pendingRecipients, 2, '미룬 사람은 묶음에 남는다(버리지 않는다)');
});
