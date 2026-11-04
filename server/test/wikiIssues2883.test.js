/**
 * wikiIssues2883.test.js — v2.883 C-1: 위키 체크리스트 체크(판 없이) · 이슈 연결(차단함/관련/중복) · 저장 필터 주간 메일 구독.
 *
 * ① 순수 — 체크리스트 줄 판정이 서버(wiki/store.js)와 웹(views/wiki/markdown.js)에서 같은 입력에 같은 답(두 벌 대조) · 웹 파서의 줄 번호가 원문과 맞다.
 * ② 실제 api 라우터(자식 프로세스): 체크 — 판을 만들지 않고 지금 판 본문까지 고친다 · 낡은 판 409 · 체크리스트가 아닌 줄 409 · 권한 · 범위 · 읽기 전용.
 * ③ 연결 — 반대 방향은 읽을 때 계산 · 볼 수 없는 이슈 숨김 · 상대가 만든 연결은 상대의 쓰기 범위 · 막는 이슈가 열려 있으면 완료 전에 묻는다.
 * ④ 주간 메일 — 월요일 09:00(포탈 날짜) 뒤 한 번 · 받는 사람의 범위로 다시 거른다(실제 발송 함수 대체) · 공유를 끄면 남의 구독이 내려간다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { taskMarkAt as serverMark } from '../src/wiki/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

test('① 체크리스트 줄 판정 — 서버 · 웹이 같은 답 · 웹 파서의 줄 번호가 원문 줄이다', async () => {
  const web = await import('../../web/src/views/wiki/markdown.js');
  const lines = [
    '- [ ] a', '- [x] b', '* [X] c', '+ [ ] d', '1. [ ] e', '12) [x] f', '  - [ ] g', '> - [ ] h', '>> - [x] i', '\t- [ ] tab',
    '- [ ]', '- [] x', '-[ ] x', '- [y] x', 'text - [ ] x', '1234567890. [ ] x', '- [ ]x', '', '[ ] x', `- [ ] ${'x'.repeat(5000)}`,
  ];
  for (const l of lines) assert.equal(serverMark(l), web.taskMarkAt(l), JSON.stringify(l.slice(0, 30)));
  assert.equal(serverMark('- [ ] a'), 3); assert.equal(serverMark('text'), -1);
  const md = '# t\n\n- [ ] a\n  - [x] b\n> - [ ] q\n\n:::info\n1. [ ] c\n:::\n\n```\n- [ ] 코드 안\n```';
  const src = md.split('\n');
  const found = [];
  const walk = (bs) => { for (const b of bs) { for (const it of b.items || []) { if (it.task != null) found.push([it.line, it.task]); walk(it.children); } if (b.blocks) walk(b.blocks); } };
  walk(web.parseMarkdown(md).blocks);
  assert.deepEqual(found.map(([l]) => l), [2, 3, 4, 7], '코드 블록 안의 항목은 체크리스트가 아니다');
  for (const [l, t] of found) { const p = serverMark(src[l]); assert.ok(p > 0, src[l]); assert.equal(src[l][p] !== ' ', t); }
});

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2883-'));
  if (pre) pre(dir);
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
    st.flushIssuesNow(); wk.flushWikiNow();
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

test('② 위키 체크리스트 체크 — 판을 만들지 않는다 · 지금 판 본문도 · 낡은 판 · 아닌 줄 · 권한 · 범위 · 읽기 전용', () => {
  const { out } = run(`
    const p = (await call('POST', '/wiki/pages', { title: '런북', body: '# 런북\\r\\n\\r\\n- [ ] 확인\\r\\n- [x] 끝\\r\\n본문' })).j.page;
    out.c1 = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 1, line: 2, checked: true });
    out.again = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 1, line: 2, checked: true });
    out.notTask = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 1, line: 4, checked: true });
    out.outOfRange = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 1, line: 99, checked: true });
    out.v1 = (await call('GET', '/wiki/pages/' + p.id + '/versions/1')).j.version;
    await call('PUT', '/wiki/pages/' + p.id, { baseVersion: 1, body: '- [ ] 새 줄\\n- [x] 확인' });
    out.stale = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 1, line: 0, checked: true });
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewer = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 2, line: 0, checked: true });
    as(ADM);
    const a = (await call('POST', '/wiki/pages', { spaceId: 'vc-a', title: 'A 문서', body: '- [ ] a' })).j.page.id;
    as({ username: 'ro', role: 'operator', scope: { vcenters: ['vc-a'], writeVcenters: ['vc-b'] } });
    out.writeOut = await call('POST', '/wiki/pages/' + a + '/check', { baseVersion: 1, line: 0, checked: true });
    as(SA);
    out.readOutPub = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 2, line: 0, checked: true });
    as(ADM);
    await call('PUT', '/wiki/spaces/pub', { readOnly: true });
    out.readOnly = await call('POST', '/wiki/pages/' + p.id + '/check', { baseVersion: 2, line: 0, checked: true });
  `);
  assert.equal(out.c1.s, 200);
  assert.equal(out.c1.j.page.version, 1, '판을 만들지 않는다');
  assert.equal(out.c1.j.page.body, '# 런북\n\n- [x] 확인\n- [x] 끝\n본문', '그 줄만 바뀐다(줄 끝은 \\n 으로 맞춘다)');
  assert.equal(out.v1.body, out.c1.j.page.body, '지금 판의 본문도 같이 고친다(판 본문과 문서 본문이 어긋나지 않게)');
  assert.equal(out.c1.j.page.checkLog[0].by, 'adm'); assert.equal(out.c1.j.page.checkLog[0].checked, true);
  assert.equal(out.again.s, 200, '이미 그 상태면 그대로');
  assert.equal(out.notTask.s, 409); assert.equal(out.notTask.j.code, 'not-task');
  assert.equal(out.outOfRange.s, 400);
  assert.equal(out.stale.s, 409, '낡은 판이면 줄 번호가 달라졌을 수 있다'); assert.equal(out.stale.j.code, 'conflict');
  assert.equal(out.viewer.s, 403);
  assert.equal(out.writeOut.s, 403, '조회는 되지만 쓰기 밖');
  assert.equal(out.readOutPub.s, 404, '범위 계정에게 공용은 없는 문서');
  assert.equal(out.readOnly.s, 403, '읽기 전용 스페이스');
});

test('③ 이슈 연결 — 반대 방향 · 숨김 · 상대 쓰기 범위 · 막는 이슈가 열려 있으면 완료 전에 묻는다', () => {
  const { out } = run(`
    const a = (await call('POST', '/issues', { title: 'A', vcenterId: 'vc-a' })).j.issue.key;
    const b = (await call('POST', '/issues', { title: 'B', vcenterId: 'vc-a' })).j.issue.key;
    const z = (await call('POST', '/issues', { title: 'Z(다른 법인)', vcenterId: 'vc-b' })).j.issue.key;
    out.addBlock = await call('POST', '/issues/' + b + '/links', { type: 'blocks', key: a });       // B 가 A 를 막는다(B 에 저장)
    out.addZ = await call('POST', '/issues/' + a + '/links', { type: 'relates', key: z });
    out.dup = await call('POST', '/issues/' + a + '/links', { type: 'blockedBy', key: b });          // 같은 연결(반대 쪽에 이미 있다)
    out.self = await call('POST', '/issues/' + a + '/links', { type: 'relates', key: a });
    out.badType = await call('POST', '/issues/' + a + '/links', { type: 'owns', key: b });
    out.aView = (await call('GET', '/issues/' + a)).j.issue;
    out.list = (await call('GET', '/issues?done=all')).j.rows.find((r) => r.key === a).blockedOpen;
    out.doneBlocked = await call('POST', '/issues/' + a + '/status', { status: 'done' });
    as(SA);
    out.saView = (await call('GET', '/issues/' + a)).j.issue.links.map((l) => [l.type, l.key]);
    out.saToZ = await call('POST', '/issues/' + a + '/links', { type: 'relates', key: z });
    as({ username: 'ro', role: 'operator', scope: { vcenters: ['vc-a', 'vc-b'], writeVcenters: ['vc-b'] } });
    out.roRemoveInverse = await call('POST', '/issues/' + a + '/links/remove', { type: 'blockedBy', key: b }); // B 쪽 저장 — B 는 vc-a(쓰기 밖)
    as(ADM);
    out.force = await call('POST', '/issues/' + a + '/status', { status: 'done', ignoreBlockers: true });
    out.removeInverse = await call('POST', '/issues/' + a + '/links/remove', { type: 'blockedBy', key: b });
    out.bAfter = (await call('GET', '/issues/' + b)).j.issue;
    out.keys = { a, b, z };
  `);
  const { a, b, z } = out.keys;
  assert.equal(out.addBlock.s, 200); assert.equal(out.addZ.s, 200);
  assert.equal(out.dup.s, 200, '같은 연결은 그대로(두 번 저장하지 않는다)');
  assert.equal(out.self.s, 400); assert.equal(out.badType.s, 400);
  assert.deepEqual(out.aView.links.map((l) => [l.type, l.key, l.own]).sort(), [['blockedBy', b, false], ['relates', z, true]].sort(), '반대 방향은 읽을 때 계산(own:false)');
  assert.equal(out.aView.blockedOpen, 1); assert.equal(out.list, 1, '목록에도 차단됨 수');
  assert.equal(out.doneBlocked.s, 409); assert.equal(out.doneBlocked.j.code, 'open-blockers'); assert.deepEqual(out.doneBlocked.j.blockers.map((x) => x.key), [b]);
  assert.deepEqual(out.saView, [['blockedBy', b]], '범위 계정에게 볼 수 없는 법인 이슈와의 연결은 보이지 않는다');
  assert.equal(out.saToZ.s, 400, '볼 수 없는 이슈와는 연결하지 못한다(없는 이슈)');
  assert.equal(out.roRemoveInverse.s, 403, '상대가 만든 연결은 상대 이슈의 쓰기 범위가 있어야 지운다');
  assert.equal(out.force.s, 200, '확인하면 완료');
  assert.equal(out.removeInverse.s, 200);
  assert.equal(out.bAfter.links.length, 0, '반대 쪽에서 지우면 저장된 쪽(B)에서 빠진다');
  assert.ok(out.bAfter.history.some((h) => h.field === 'link' && h.from === `blocks ${a}` && h.to === ''), '지운 쪽 이력에 남는다');
});

test('④ 저장 필터 주간 메일 — 월요일 09:00 뒤 한 번 · 받는 사람의 범위로 다시 거른다 · 공유를 끄면 남의 구독이 내려간다', () => {
  // 기준 시각: 실제 시각에서 정시로 떨어뜨린 뒤 다음 월요일 09:30(포탈 날짜 KST 기본)으로
  const H = 3600_000;
  let t = Math.floor(Date.now() / H) * H;
  const kst = (ms) => new Date(ms + 9 * H);
  while (!(kst(t).getUTCDay() === 1 && kst(t).getUTCHours() === 9)) t += H;
  const MON = t + 30 * 60_000;
  const { out } = run(`
    auth.createUser({ username: 'sa', role: 'operator', password: 'Strong-Passw0rd!2883', scope: { vcenters: ['vc-a'] } }, { trusted: true });
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, chat: false, people: [{ username: 'adm', email: 'adm@example.com' }, { username: 'sa', email: 'sa@example.com' }] } });
    await call('POST', '/issues', { title: 'A 장애', vcenterId: 'vc-a', type: 'incident' });
    await call('POST', '/issues', { title: 'B 장애', vcenterId: 'vc-b', type: 'incident' });
    const f = (await call('POST', '/issues/filters', { name: '장애', query: 'type = incident', shared: true })).j.filter;
    out.subAdm = await call('POST', '/issues/filters/' + f.id + '/subscribe', { on: true });
    as(SA);
    out.subSa = await call('POST', '/issues/filters/' + f.id + '/subscribe', { on: true });
    as({ username: 'vw', role: 'viewer', scope: null });
    out.subViewer = await call('POST', '/issues/filters/' + f.id + '/subscribe', { on: true });
    as(ADM);
    out.notMonday = await nt.scanWeeklyFilters(${MON} - 86400000);
    out.early = await nt.scanWeeklyFilters(${MON} - 2 * 3600000);
    out.first = await nt.scanWeeklyFilters(${MON});
    out.mails = mails.map((m) => ({ to: m.to[0], subject: m.subject, text: m.text }));
    out.second = await nt.scanWeeklyFilters(${MON} + 3600000);
    await call('PUT', '/issues/filters/' + f.id, { shared: false });
    as(SA);
    out.saList = (await call('GET', '/issues/filters')).j.filters.length;
    as(ADM);
    out.admView = (await call('GET', '/issues/filters')).j.filters[0];
  `);
  assert.equal(out.subAdm.s, 200); assert.equal(out.subAdm.j.filter.subscribed, true);
  assert.equal(out.subSa.s, 200, '공유 필터는 다른 사람도 구독한다');
  assert.equal(out.subViewer.s, 403, '구독은 쓰기 역할(상태변경 예외를 늘리지 않는다)');
  assert.equal(out.notMonday.sent, 0); assert.equal(out.early.sent, 0, '월요일 09:00 전에는 보내지 않는다');
  assert.equal(out.first.sent, 2);
  const byTo = Object.fromEntries(out.mails.map((m) => [m.to, m]));
  assert.match(byTo['adm@example.com'].text, /A 장애/); assert.match(byTo['adm@example.com'].text, /B 장애/);
  assert.match(byTo['sa@example.com'].text, /A 장애/);
  assert.doesNotMatch(byTo['sa@example.com'].text, /B 장애/, '받는 사람의 범위로 다시 거른다 — 구독이 범위를 넓히지 않는다');
  assert.match(byTo['sa@example.com'].subject, /1건/);
  assert.equal(out.second.sent, 0, '같은 날 두 번 보내지 않는다');
  assert.equal(out.saList, 0, '공유를 끄면 남에게 보이지 않는다');
  assert.equal(out.admView.subscriberCount, 1, '공유를 끄면 남의 구독은 내려간다(만든 사람 것만)');
});
