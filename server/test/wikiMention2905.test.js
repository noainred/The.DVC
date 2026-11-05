/**
 * wikiMention2905.test.js — v2.905 위키 댓글 @멘션 자동완성 · '계정/이름' · 언급한 사람에게 이슈 등록 + 메일(시안 docs/design/wiki-mention · 추천안 5개).
 *
 * ① 순수 — mentionCandidates(범위별 후보 · 순위 · 관리 정보는 전체 범위만) · mentionText · planCommentIssue(담당자 = 언급한 사람 · 볼 수 없는 사람 · 요청 등록).
 * ② 라우트 — 후보 API 범위(A3-02 그대로 + 참여자) · 댓글 + 이슈 한 요청 · 400 이면 댓글도 저장하지 않음 · 중복 방지 · 뒤늦은 등록 · 요청 권한 계정 ·
 *    메일 한 통(언급 + 할당) · 이슈 댓글의 관찰자 추가 · 색인('관련 이슈').
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mentionCandidates, mentionText } from '../src/issues/mentionables.js';
import { planCommentIssue, defaultIssueTitle } from '../src/issues/fromComment.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

function run(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2903-'));
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const nt = await import(${JSON.stringify(path.join(SRC, 'issues/notify.js'))});
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
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


test('① 후보 — 범위별 목록 · 순위 · 관리 정보는 전체 범위 쓰기 계정만', () => {
  const users = [
    { username: 'kim.lee', name: '김이령', role: 'operator', scope: { vcenters: [] } },
    { username: 'kim.ds', name: '김대성', role: 'admin' },
    { username: 'park.ki', name: '박기태', role: 'operator', scope: { vcenters: ['vc-kr'] } },
    { username: 'thedvcdemp', name: 'Demo', role: 'viewer', demo: true },
    { username: 'noa', name: 'noa', role: 'admin' },
  ];
  const people = [{ username: 'kim.lee', email: 'k@x.co' }, { username: 'ad.user', email: 'a@x.co' }];
  const full = mentionCandidates({ q: '@ki', me: 'noa', full: true, users, people, canSee: (n) => n !== 'park.ki' });
  assert.deepEqual(full.items.map((x) => x.username), ['kim.ds', 'kim.lee', 'park.ki'], '계정 접두 > 포함 · 같은 순위는 계정 이름순');
  const kl = full.items.find((x) => x.username === 'kim.lee');
  assert.deepEqual(kl, { username: 'kim.lee', name: '김이령', role: 'operator', scoped: false, email: true, canSee: true });
  assert.equal(full.items.find((x) => x.username === 'park.ki').canSee, false);
  assert.equal(full.items.find((x) => x.username === 'park.ki').scoped, true);
  assert.ok(!mentionCandidates({ q: 'demo', me: 'noa', full: true, users }).items.length, '데모 계정은 후보가 아니다');
  assert.equal(mentionCandidates({ q: 'ad', me: 'noa', full: true, users, people }).items[0].role, 'ad', '주소 표에만 있는 이름(AD)');
  assert.deepEqual(mentionCandidates({ q: '김', me: 'noa', full: true, users }).items.map((x) => x.username), ['kim.ds', 'kim.lee'], '이름 접두');
  // 범위 계정 · 요청 권한 계정 — 자기 + 참여자 + 이슈에 나온 이름만 · 관리 정보 없음
  const sc = mentionCandidates({ q: '', me: 'park.ki', full: false, users, people, participants: ['kim.lee'], knownNames: ['lee'] });
  assert.deepEqual(sc.items.map((x) => x.username).sort(), ['kim.lee', 'lee', 'park.ki']);
  assert.deepEqual(Object.keys(sc.items.find((x) => x.username === 'kim.lee')).sort(), ['name', 'username'], '역할 · 메일 · 범위는 싣지 않는다');
  assert.equal(mentionCandidates({ q: '', me: 'a', full: true, users: Array.from({ length: 30 }, (_, i) => ({ username: `u${i}` })) }).items.length, 8);
  assert.equal(mentionText('kim.lee', '김 이령'), '@kim.lee/김이령');
  assert.equal(mentionText('kim', 'kim'), '@kim');
  assert.equal(mentionText('kim', 'a(b)/c'), '@kim/abc');
});

test('① planCommentIssue — 담당자 = 언급한 사람 · 볼 수 없으면 400 · 나머지는 관찰자(볼 수 없는 사람은 빼고 센다) · 요청 권한은 요청만', () => {
  const page = { id: 'W7', title: 'the DVC', spaceId: 'vc-a' };
  const comment = { id: 'c1', body: '@kim.lee/김이령 확인 @park.ki 참고', author: 'noa' };
  const canSee = (n) => n !== 'park.ki';
  const p = planCommentIssue({ page, comment, mentioned: ['kim.lee', 'park.ki', 'lee'], canWrite: true, canSee });
  assert.equal(p.body.assignee, 'kim.lee'); assert.deepEqual(p.body.watchers, ['lee']); assert.deepEqual(p.skipped, ['park.ki']);
  assert.equal(p.body.vcenterId, 'vc-a'); assert.deepEqual(p.body.labels, ['wiki']); assert.equal(p.body.type, 'task'); assert.equal(p.body.priority, 'p2');
  assert.deepEqual(p.origin, { kind: 'wiki-comment', pageId: 'W7', commentId: 'c1' });
  assert.match(p.body.body, /\(#\/wiki\/vc-a\/W7\)/);
  assert.equal(planCommentIssue({ page: { ...page, spaceId: 'pub' }, comment, mentioned: ['kim.lee'], canWrite: true }).body.vcenterId, '', '공용 스페이스 → 공용 이슈');
  assert.throws(() => planCommentIssue({ page, comment, req: { assignee: 'park.ki' }, mentioned: ['kim.lee', 'park.ki'], canWrite: true, canSee }), /볼 수 없어/);
  assert.throws(() => planCommentIssue({ page, comment, req: { assignee: 'ghost' }, mentioned: ['kim.lee'], canWrite: true }), /언급한 사람 중/);
  assert.throws(() => planCommentIssue({ page, comment, mentioned: [], canWrite: true }), /언급한 사람/);
  assert.throws(() => planCommentIssue({ page, comment, req: { type: 'epic' }, mentioned: ['kim.lee'], canWrite: true }), /task/);
  assert.throws(() => planCommentIssue({ page, comment, mentioned: ['kim.lee'], canWrite: false }), /요청으로/);
  const r = planCommentIssue({ page, comment, req: { request: true }, mentioned: ['kim.lee'], canWrite: false });
  assert.equal(r.requestOnly, true); assert.equal(r.body.type, 'request'); assert.equal(r.body.assignee, undefined);
  assert.equal(defaultIssueTitle('문서', '@kim.lee/김이령 확인 부탁'), '[위키] 문서 — @kim.lee 확인 부탁');
});

test('② 라우트 — 후보 범위 · 댓글 + 이슈 · 반쪽 저장 없음 · 중복 · 뒤늦은 등록 · 메일 한 통 · 색인', () => {
  const { out } = run(`
    auth.createUser({ username: 'kim.lee', name: '김이령', role: 'operator' }, { trusted: true });
    auth.createUser({ username: 'opa', name: '에이', role: 'operator', scope: { vcenters: ['vc-a'] } }, { trusted: true });
    auth.createUser({ username: 'opb', role: 'operator', scope: { vcenters: ['vc-b'] } }, { trusted: true });
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    nt.startIssueNotify();
    as(ADM);
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [{ username: 'kim.lee', email: 'kim@example.com' }] } });
    const pg = await call('POST', '/wiki/pages', { spaceId: 'vc-a', title: '수집 런북', body: '본문' });
    const id = pg.j.page.id;
    const m1 = await call('GET', '/wiki/pages/' + id + '/mentionables?q=ki');
    out.admCand = m1.j.items.map((x) => x.username + ':' + (x.email ? 'mail' : '-') + ':' + (x.canSee ? 'see' : 'nosee'));
    out.admFull = m1.j.full;
    const mb = await call('GET', '/wiki/pages/' + id + '/mentionables?q=op');
    out.opbCanSee = mb.j.items.find((x) => x.username === 'opb')?.canSee;
    as({ username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } });
    const m2 = await call('GET', '/wiki/pages/' + id + '/mentionables?q=');
    out.opaCand = m2.j.items.map((x) => x.username).sort(); out.opaKeys = Object.keys(m2.j.items[0] || {}).sort(); out.opaFull = m2.j.full;
    as(ADM);
    // 400 — 볼 수 없는 담당자면 댓글도 저장하지 않는다
    const bad = await call('POST', '/wiki/pages/' + id + '/comments', { body: '@opb 봐 주세요', issue: { assignee: 'opb' } });
    out.badS = bad.s; out.badReason = bad.j.reason;
    out.afterBad = (await call('GET', '/wiki/pages/' + id)).j.page.comments.length;
    // 정상 — 댓글 + 이슈 한 요청
    const ok = await call('POST', '/wiki/pages/' + id + '/comments', { body: '@kim.lee/김이령 시한 90초로 @opa 참고 @opb', issue: { priority: 'p1' } });
    out.okS = ok.s; out.issue = ok.j.issue; out.cKey = ok.j.comment.issueKey;
    const it = (await call('GET', '/issues/' + ok.j.issue.key)).j.issue;
    out.iss = { assignee: it.assignee, watchers: it.watcherNames, vc: it.vcenterId, prio: it.priority, labels: it.labels, origin: it.origin, reporter: it.reporter, title: it.title };
    out.related = (await call('GET', '/wiki/pages/' + id)).j.page.issueKeys;
    // 중복 — 같은 댓글로 다시
    const again = await call('POST', '/wiki/pages/' + id + '/comments/' + ok.j.comment.id + '/issue', {});
    out.againKey = again.j.issue?.key; out.againExisting = again.j.issue?.existing;
    // 완료 뒤 다시 등록 → 새 이슈 + 관련 연결
    await call('POST', '/issues/' + ok.j.issue.key + '/status', { status: 'done' });
    const re = await call('POST', '/wiki/pages/' + id + '/comments/' + ok.j.comment.id + '/issue', {});
    out.reKey = re.j.issue?.key; out.reRelated = re.j.issue?.relatedTo;
    // 체크 없이 단 댓글 → 이슈 없음, 뒤늦은 등록
    const plain = await call('POST', '/wiki/pages/' + id + '/comments', { body: '그냥 댓글 @kim.lee' });
    out.plainIssue = plain.j.issue === undefined;
    const late = await call('POST', '/wiki/pages/' + id + '/comments/' + plain.j.comment.id + '/issue', { type: 'incident' });
    out.lateType = (await call('GET', '/issues/' + late.j.issue.key)).j.issue.type;
    // 요청 권한(viewer) — 요청만 · 남의 댓글은 못 올린다
    as({ username: 'vw', role: 'viewer', scope: null });
    const vwDeny = await call('POST', '/wiki/pages/' + id + '/comments', { body: '@kim.lee 확인', issue: { priority: 'p1' } });
    out.vwDenyS = vwDeny.s;
    const vw = await call('POST', '/wiki/pages/' + id + '/comments', { body: '@kim.lee 확인 요청', issue: { request: true } });
    out.vwS = vw.s; out.vwType = vw.j.issue?.requestOnly; out.vwAssignee = vw.j.issue?.assignee;
    out.vwOther = (await call('POST', '/wiki/pages/' + id + '/comments/' + plain.j.comment.id + '/issue', { request: true })).s;
    as(ADM);
    out.flush = await nt.flushIssueNotify();
    out.kimMails = mails.filter((m) => m.to[0] === 'kim@example.com').map((m) => m.text);
    // 이슈 댓글 — 언급한 사람을 관찰자로(선택)
    const i2 = (await call('POST', '/issues', { title: 'x', vcenterId: 'vc-a' })).j.issue.key;
    const cw = await call('POST', '/issues/' + i2 + '/comments', { body: '@opa @opb @kim.lee 보세요', watchMentions: true });
    out.watch = cw.j.watch;
    out.i2Watchers = (await call('GET', '/issues/' + i2)).j.issue.watcherNames;
    const im = await call('GET', '/issues/' + i2 + '/mentionables?q=op');
    out.issueCand = im.j.items.map((x) => x.username);
  `);
  assert.deepEqual(out.admCand, ['kim.lee:mail:see'], '관리자: 로컬 계정 + 메일 · 보기 여부');
  assert.equal(out.admFull, true);
  assert.equal(out.opbCanSee, false, 'vc-b 범위 계정은 vc-a 문서 이슈를 볼 수 없다');
  assert.equal(out.opaFull, false);
  assert.deepEqual(out.opaCand, ['adm', 'opa'], '범위 계정: 자기 + 참여자만(전 계정 목록 없음)');
  assert.deepEqual(out.opaKeys, ['name', 'username']);
  assert.equal(out.badS, 400); assert.match(out.badReason, /볼 수 없어/);
  assert.equal(out.afterBad, 0, '400 이면 댓글도 저장하지 않는다');
  assert.equal(out.okS, 200);
  assert.equal(out.issue.assignee, 'kim.lee'); assert.deepEqual(out.issue.watchers, ['opa']); assert.deepEqual(out.issue.skipped, ['opb']);
  assert.equal(out.issue.notifyOn, true); assert.deepEqual(out.issue.noEmail, ['opa']);
  assert.equal(out.cKey, out.issue.key);
  assert.deepEqual(out.iss.watchers, ['opa']); assert.equal(out.iss.vc, 'vc-a'); assert.equal(out.iss.prio, 'p1'); assert.deepEqual(out.iss.labels, ['wiki']);
  assert.equal(out.iss.origin.kind, 'wiki-comment'); assert.equal(out.iss.reporter, 'adm');
  assert.match(out.iss.title, /^\[위키\] 수집 런북 — @kim.lee 시한 90초로/);
  assert.ok(out.related.includes(out.issue.key), '문서의 관련 이슈 색인에 들어간다');
  assert.equal(out.againKey, out.issue.key); assert.equal(out.againExisting, true, '같은 댓글의 열린 이슈는 다시 만들지 않는다');
  assert.notEqual(out.reKey, out.issue.key); assert.equal(out.reRelated, out.issue.key, '완료 뒤 다시 등록 → 새 이슈 + 관련');
  assert.equal(out.plainIssue, true); assert.equal(out.lateType, 'incident');
  assert.equal(out.vwDenyS, 400, '요청 권한 계정은 담당자 지정 이슈를 못 만든다(댓글도 저장 안 함)');
  assert.equal(out.vwS, 200); assert.equal(out.vwType, true); assert.equal(out.vwAssignee, '');
  assert.equal(out.vwOther, 403, '남의 댓글은 쓴 사람 · 운영자만');
  const joined = out.kimMails.join('\n---\n');
  assert.match(joined, /언급했습니다/); assert.match(joined, /할당/);
  assert.equal(out.kimMails.length, 1, '언급 + 할당이 한 통');
  assert.deepEqual(out.watch.added, ['opa', 'kim.lee']); assert.deepEqual(out.watch.skipped, [{ name: 'opb', why: 'out-of-scope' }]);
  assert.deepEqual(out.i2Watchers, ['opa', 'kim.lee']);
  assert.deepEqual(out.issueCand.sort(), ['opa', 'opb']);
});
