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

function run(body, { pre } = {}) {
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
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
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
    await call('POST', '/issues', { title: '늦음', assignee: 'kim', dueAt: Date.now() - 3600000 });
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
  assert.ok(out.status.noEmail >= 1, 'park(주소 없음)은 메일을 받지 않고 센다');
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
