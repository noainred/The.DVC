/**
 * sweep2932Issues.test.js — v2.932 최근 변경 점검(축 2) 확정분 B1-01 ~ B1-08(이슈 · 위키 · 알림함) 회귀.
 *  B1-01 위키 댓글 '고치기 전 원문'(prev)이 문서 조회 · 고치기 · 해결 표시 응답에 실리지 않는다(저장은 그대로 — docs/rules/web.md '옛 본문 5개 보관')
 *  B1-02 깨진 링크 · 역링크는 볼 수 있는 문서로만 풀고 · 제목 바꾸기 링크 갱신은 그 링크가 든 문서의 독자 기준(같은 스페이스 · 공용만)
 *  B1-03 깜빡이는 알람 — 다시 발생에도 유예 · 재발/해소 댓글 시간 창 묶음 · 자동 댓글은 사람 몫(200)과 따로 센다
 *  B1-04 알림함 사람 수 상한 — 기한 지난/빈 사람부터 치우고 그래도 모자라면 가장 오래 쉰 사람을 내보낸다
 *  B1-05 알림함 읽기 판정 — 범위 계정은 공용 줄도 보지 않는다
 *  B1-06 @멘션 관찰자 · 위키 댓글 → 이슈 — 전체 범위 쓰기 계정이 아니면 이름 해석 후보를 자동완성과 같게 · 뺀 사람은 수만
 *  B1-07 이슈 템플릿 목록 — 관리할 수 없는 계정에게 createdBy · updatedBy 를 싣지 않는다
 *  B1-08 메일 · 알림함이 둘 다 켜져도 범위 밖 수신자를 한 번만 센다
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
// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨린다(docs/rules/common.md)
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

function run(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2932i-'));
  const imp = (p) => JSON.stringify(path.join(SRC, p));
  const script = `
    const fs = await import('node:fs');
    const express = (await import('express')).default;
    const { api } = await import(${imp('routes/api.js')});
    const st = await import(${imp('issues/store.js')});
    const wk = await import(${imp('wiki/store.js')});
    const ai = await import(${imp('issues/alertIssues.js')});
    const ib = await import(${imp('issues/inbox.js')});
    const nt = await import(${imp('issues/notify.js')});
    const auth = await import(${imp('auth/auth.js')});
    const BASE = ${BASE};
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
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const out = {};
    try {
      ${body}
    } finally {
      st.flushIssuesNow(); wk.flushWikiNow(); ib.flushInboxNow();
      srv.close();
    }
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000, maxBuffer: 64 * 1024 * 1024,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('@@'));
  if (!line) throw new Error(`스크립트 실패(code ${r.status}): ${(r.stderr || '').slice(-3000)}`);
  return JSON.parse(line.slice(2));
}

test('B1-01 위키 댓글 고치기 전 원문(prev) — 문서 조회 · 고치기 · 해결 표시 응답에 없다 · 이슈 고치기 응답도 같다', () => {
  const out = run(`
    const ALICE = { username: 'alice', role: 'operator', scope: { vcenters: ['vc-a'] } };
    const BOB = { username: 'bob', role: 'viewer', scope: { vcenters: ['vc-a'] } };
    as(ALICE);
    const pg = (await call('POST', '/wiki/pages', { spaceId: 'vc-a', title: 'A 문서', body: 'hello' })).j.page;
    const cm = (await call('POST', '/wiki/pages/' + pg.id + '/comments', { body: '접속 비밀번호는 P@ssw0rd-123 입니다' })).j.comment;
    const ed = await call('PUT', '/wiki/pages/' + pg.id + '/comments/' + cm.id, { body: '(지움)' });
    out.editResp = { s: ed.s, keys: Object.keys(ed.j.comment).sort(), hasSecret: JSON.stringify(ed.j).includes('P@ssw0rd') };
    as(BOB);
    const g = await call('GET', '/wiki/pages/' + pg.id);
    const c0 = g.j.page.comments.find((x) => x.id === cm.id);
    out.view = { body: c0.body, edits: c0.edits, prev: 'prev' in c0, hasSecret: JSON.stringify(g.j).includes('P@ssw0rd') };
    as(ADM);
    const rs = await call('POST', '/wiki/pages/' + pg.id + '/comments/' + cm.id + '/resolve', { on: true });
    out.resolve = { s: rs.s, resolved: rs.j.comment.resolved, prev: 'prev' in rs.j.comment, hasSecret: JSON.stringify(rs.j).includes('P@ssw0rd') };
    // 저장은 그대로(문서화된 '옛 본문 5개 보관') — 응답에만 싣지 않는다
    wk.flushWikiNow();
    const file = JSON.parse(fs.readFileSync(wk.wikiFile(), 'utf8'));
    out.storedPrev = file.pages.find((p) => p.id === pg.id).comments[0].prev?.length || 0;
    // 이슈 — 고치기 응답도 viewIssue 와 같은 모양(prev 없음)
    const key = (await call('POST', '/issues', { title: 't', vcenterId: 'vc-a' })).j.issue.key;
    const ic = (await call('POST', '/issues/' + key + '/comments', { body: '토큰 abc-SECRET-1' })).j.comment;
    const ie = await call('PUT', '/issues/' + key + '/comments/' + ic.id, { body: '고침' });
    out.issueEdit = { s: ie.s, prev: 'prev' in ie.j.comment, hasSecret: JSON.stringify(ie.j).includes('SECRET'), edits: ie.j.comment.edits };
  `);
  assert.equal(out.editResp.s, 200);
  assert.equal(out.editResp.hasSecret, false, '고친 사람의 응답에도 원문이 없다');
  assert.ok(!out.editResp.keys.includes('prev'), JSON.stringify(out.editResp.keys));
  assert.deepEqual(out.view, { body: '(지움)', edits: 1, prev: false, hasSecret: false }, '다른 사람(viewer)이 받는 댓글에 원문이 없다');
  assert.deepEqual(out.resolve, { s: 200, resolved: true, prev: false, hasSecret: false });
  assert.equal(out.storedPrev, 1, '저장된 prev 는 남긴다(응답에만 싣지 않는다)');
  assert.deepEqual(out.issueEdit, { s: 200, prev: false, hasSecret: false, edits: 1 });
});

test('B1-02 깨진 링크 · 역링크는 볼 수 있는 문서로만 · 제목 바꾸기 링크 갱신은 독자 기준', () => {
  const out = run(`
    const A = { read: new Set(['vcA']), write: new Set(['vcA']) };
    const AC = { read: new Set(['vcA', 'vcC']), write: new Set(['vcA', 'vcC']) };
    const B = { read: new Set(['vcB']), write: new Set(['vcB']) };
    // ① 깨진 링크 — 다른 법인 문서 제목이 있어도 범위 계정에게는 깨진 링크다(존재 판정이 되지 않게)
    const zeta = wk.createPage({ spaceId: 'vcB', title: 'B 비밀 프로젝트 Zeta', body: 'x' }, 'carol', { access: B });
    const pA = wk.createPage({ spaceId: 'vcA', title: 'A 문서', body: '[[B 비밀 프로젝트 Zeta]] [[없는 제목 123]]' }, 'alice', { access: A });
    out.brokenA = wk.brokenLinks({ access: A }).rows.map((r) => r.ref).sort();
    out.brokenFull = wk.brokenLinks({}).rows.map((r) => r.ref);
    // ② 역링크 — 같은 제목이 보이지 않는 스페이스에 먼저 있어도, 보이는 문서로 풀어 이 문서를 가리키면 역링크다
    wk.createPage({ spaceId: 'vcB', title: '공통 런북', body: 'b' }, 'carol', { access: B });
    const tA = wk.createPage({ spaceId: 'vcA', title: '공통 런북', body: 'a' }, 'alice', { access: A });
    const cDoc = wk.createPage({ spaceId: 'vcC', title: 'C 문서', body: '보기 [[공통 런북]]' }, 'alice', { access: AC });
    out.backAC = wk.backlinks(tA.id, AC).map((m) => m.id);
    out.cDoc = cDoc.id;
    // ③ 전체 범위 관리자가 B 문서 제목을 바꾼다 — A 문서(다른 법인)는 고치지 않고 센다 · 같은 스페이스 · 공용 문서는 고친다
    const pubDoc = wk.createPage({ spaceId: 'pub', title: '공용 색인', body: '[[B 비밀 프로젝트 Zeta]]' }, 'adm');
    const bDoc = wk.createPage({ spaceId: 'vcB', title: 'B 색인', body: '[[B 비밀 프로젝트 Zeta]]' }, 'carol', { access: B });
    const z = wk.getPage(zeta.id, 'adm');
    const r = wk.updatePage(zeta.id, { baseVersion: z.version, title: 'B 인수 대상 Omega 사(2027-Q1)', body: z.body }, 'adm');
    out.linkFix = r.linkFix;
    out.aBody = wk.getPage(pA.id, 'alice', A).body;
    out.aNote = wk.getPage(pA.id, 'alice', A).versions[0].note;
    out.pubBody = wk.getPage(pubDoc.id, 'adm').body;
    out.bBody = wk.getPage(bDoc.id, 'carol', B).body;
    // ④ 범위 계정이 자기 문서 제목을 바꿀 때 — 볼 수 없는 문서(vcB)의 링크는 고치지도 세지도 않는다
    const alpha = wk.createPage({ spaceId: 'vcA', title: 'Alpha 절차', body: 'x' }, 'alice', { access: A });
    const hid = wk.createPage({ spaceId: 'vcB', title: 'B 가 가리킴', body: '[[Alpha 절차]]' }, 'carol', { access: B });
    const r2 = wk.updatePage(alpha.id, { baseVersion: 1, title: 'Alpha 절차 v2' }, 'alice', { access: A });
    out.linkFixScoped = r2.linkFix;
    out.hidBody = wk.getPage(hid.id, 'carol', B).body;
  `);
  assert.deepEqual(out.brokenA, ['B 비밀 프로젝트 Zeta', '없는 제목 123'], '범위 계정: 볼 수 없는 문서로 풀리는 링크도 깨진 링크');
  assert.deepEqual(out.brokenFull, ['없는 제목 123'], '전체 범위 결과는 그대로');
  assert.deepEqual(out.backAC, [out.cDoc], '보이는 문서로 풀어 역링크를 찾는다');
  assert.deepEqual(out.linkFix, { fixed: 2, skipped: 0, crossSpace: 1 });
  assert.equal(out.aBody, '[[B 비밀 프로젝트 Zeta]] [[없는 제목 123]]', 'A 범위 계정이 읽는 A 문서에 B 의 새 제목이 들어가지 않는다');
  assert.doesNotMatch(out.aNote, /Omega/);
  assert.equal(out.pubBody, '[[B 인수 대상 Omega 사(2027-Q1)]]', '공용 문서의 독자는 전체 범위뿐 — 고친다');
  assert.equal(out.bBody, '[[B 인수 대상 Omega 사(2027-Q1)]]', '같은 스페이스 문서는 고친다');
  assert.deepEqual(out.linkFixScoped, { fixed: 0, skipped: 0 }, '볼 수 없는 문서는 세지 않는다(셈이 존재를 알려 준다)');
  assert.equal(out.hidBody, '[[Alpha 절차]]');
});

test('B1-03 깜빡이는 알람 — 유예 · 시간 창 묶음 · 자동 댓글 따로 세기 · 사람 댓글은 막히지 않는다', () => {
  const out = run(`
    auth.createUser({ username: 'kim', role: 'operator' }, { trusted: true });
    nt.startIssueNotify(); // 자동 댓글 · 상태 변경이 담당자 알림함으로 가는지(폭주가 줄었는지) 본다
    const flap = (delayMin, key, rounds) => {
      ai.saveAlertAuto({ enabled: true, delayMin, kinds: { host: true } });
      const alert = { key, vcenterId: '', severity: 'warning', title: '호스트 연결 끊김: ' + key };
      let now = BASE;
      ai.applyAlertState({ firing: [{ key, alert, since: now - (delayMin + 1) * 60_000 }], resolved: [] }, { now });
      const ik = st.findByOrigin((o) => o.alertKey === key)[0].key;
      st.assignIssue(ik, 'kim', 'adm');
      for (let i = 0; i < rounds; i += 1) {
        now += 60_000; ai.applyAlertState({ firing: [], resolved: [{ key, alert }] }, { now });
        now += 60_000; ai.applyAlertState({ firing: [{ key, alert, since: now }], resolved: [] }, { now });
      }
      return { ik, now, alert };
    };
    // ① 유예 10분 · 2분마다 깜빡임 4시간 — 다시 발생으로 치지 않는다(첫 해소 댓글 하나)
    const f1 = flap(10, 'host:h-1', 120);
    const i1 = st.getIssue(f1.ik, 'kim');
    out.delay = { comments: i1.comments.length, reopen: i1.origin.reopen };
    try { st.addComment(f1.ik, { body: '원인: 업링크 포트 플래핑' }, 'kim'); out.delayHuman = 'ok'; } catch (e) { out.delayHuman = e.status; }
    // ② 유예 0분 — 재발 수는 다 세고, 댓글은 이슈마다 창(30분)에 한 번
    const f2 = flap(0, 'host:h-2', 120);
    const i2 = st.getIssue(f2.ik, 'kim');
    out.window = { comments: i2.comments.length, reopen: i2.origin.reopen, last: i2.comments.at(-1).body };
    try { st.addComment(f2.ik, { body: '사람 댓글' }, 'kim'); out.windowHuman = 'ok'; } catch (e) { out.windowHuman = e.status; }
    out.kimInbox = ib.listInbox('kim', { limit: 100 }).items.filter((x) => x.key === f2.ik).length;
    out.status = ai.alertIssuesStatus();
    // 알람 자동 등록이 단 댓글은 저장에 자동 표지(auto:true) · 사람 댓글은 auto:false — 사람 몫 판정의 근거
    st.flushIssuesNow();
    const saved2 = JSON.parse(fs.readFileSync(st.issuesFile(), 'utf8')).issues.find((x) => x.key === f2.ik).comments;
    out.flags = { auto: saved2.filter((c) => c.author === 'alert-auto').every((c) => c.auto === true), human: saved2.filter((c) => c.author === 'kim').map((c) => c.auto) };
    // ③ 묶어 둔 변화가 남은 채 조용해지면 창이 지난 뒤 요약 한 줄 + 해소 상태면 '검토'
    ai.saveAlertAuto({ enabled: true, delayMin: 0, kinds: { host: true }, onResolve: 'review' });
    const k3 = 'host:h-3'; const al3 = { key: k3, vcenterId: '', title: '호스트 h-3' };
    let t = BASE + 10 * 3_600_000;
    ai.applyAlertState({ firing: [{ key: k3, alert: al3, since: t - 60_000 }], resolved: [] }, { now: t });
    const ik3 = st.findByOrigin((o) => o.alertKey === k3)[0].key;
    t += 60_000; ai.applyAlertState({ firing: [], resolved: [{ key: k3, alert: al3 }] }, { now: t }); // 첫 해소 — 댓글 + 검토
    st.setStatus(ik3, 'todo', 'kim'); // 사람이 검토에서 되돌린다
    t += 60_000; ai.applyAlertState({ firing: [{ key: k3, alert: al3, since: t }], resolved: [] }, { now: t }); // 창 안 — 묶음
    t += 60_000; ai.applyAlertState({ firing: [], resolved: [{ key: k3, alert: al3 }] }, { now: t }); // 창 안 — 묶음
    t += 10 * 60_000; ai.applyAlertState({ firing: [], resolved: [] }, { now: t });
    out.quietMid = { comments: st.getIssue(ik3, 'kim').comments.length, status: st.getIssue(ik3, 'kim').status };
    t += 30 * 60_000; ai.applyAlertState({ firing: [], resolved: [] }, { now: t });
    const i3 = st.getIssue(ik3, 'kim');
    out.summary = { comments: i3.comments.length, last: i3.comments.at(-1).body, status: i3.status };
    t += 60 * 60_000; ai.applyAlertState({ firing: [], resolved: [] }, { now: t });
    out.summaryOnce = st.getIssue(ik3, 'kim').comments.length;
    // ④ 자동 댓글 상한은 따로 — 사람 몫은 사람 댓글만 센다
    const k4 = st.createIssue({ title: '자동 상한', type: 'incident' }, 'alert-auto').key;
    let autoOk = 0; let autoErr = null;
    for (let i = 0; i < st.LIMITS.autoCommentMax + 1; i += 1) { try { st.addComment(k4, { body: 'auto ' + i }, 'alert-auto', { auto: true }); autoOk += 1; } catch (e) { autoErr = { s: e.status, code: e.extra?.code }; } }
    let humanOk = 0; let humanErr = null;
    for (let i = 0; i < st.LIMITS.commentMax + 1; i += 1) { try { st.addComment(k4, { body: 'h ' + i }, 'kim'); humanOk += 1; } catch (e) { humanErr = e.status; } }
    out.caps = { autoOk, autoErr, humanOk, humanErr };
    // ⑤ 표지가 생기기 전(v2.908~v2.926)에 자동 등록이 단 댓글 200개로 찬 이슈 — 사람이 다시 댓글을 단다
    const k5 = st.createIssue({ title: '옛 이슈', type: 'incident' }, 'adm').key;
    st.flushIssuesNow();
    const j = JSON.parse(fs.readFileSync(st.issuesFile(), 'utf8'));
    const x5 = j.issues.find((x) => x.key === k5);
    x5.comments = Array.from({ length: 200 }, (_, i) => ({ id: 'legacy' + String(i).padStart(4, '0'), author: i % 2 ? 'alert-auto' : 'partfault', body: '다시 발생했습니다(' + i + '회째)', createdAt: BASE - 1000 + i }));
    fs.writeFileSync(st.issuesFile(), JSON.stringify(j));
    st._resetIssuesCache();
    try { st.addComment(k5, { body: '담당자 댓글' }, 'kim'); out.legacyHuman = 'ok'; } catch (e) { out.legacyHuman = e.status; }
    try { st.addComment(k5, { body: 'auto' }, 'alert-auto', { auto: true }); out.legacyAuto = 'ok'; } catch (e) { out.legacyAuto = e.extra?.code || e.status; }
  `);
  assert.deepEqual(out.delay, { comments: 1, reopen: 0 }, '유예보다 짧게 다시 난 것은 재발로 치지 않는다(첫 해소 댓글만)');
  assert.equal(out.delayHuman, 'ok');
  assert.equal(out.window.reopen, 120, '재발 횟수는 계속 센다');
  assert.ok(out.window.comments >= 2 && out.window.comments <= 10, `4시간 깜빡임 댓글 ${out.window.comments}개 — 30분 창마다 한 번`);
  assert.match(out.window.last, /앞서 묶어 둔 변화: 다시 발생 \d+회 · 해소 \d+회/);
  assert.equal(out.windowHuman, 'ok', '사람 댓글은 409 가 아니다');
  assert.ok(out.kimInbox <= 12, `담당자 알림함 줄 ${out.kimInbox} — 묶은 만큼 줄어든다`);
  assert.deepEqual(out.flags, { auto: true, human: [false] }, '자동 댓글은 auto:true 로 저장된다(사람 몫을 쓰지 않는다)');
  assert.ok(out.status.quiet > 200, JSON.stringify(out.status));
  assert.equal(out.status.errors, 0, JSON.stringify(out.status));
  assert.deepEqual(out.quietMid, { comments: 1, status: 'todo' }, '창 안에서는 댓글도 상태 바꾸기도 묶는다');
  assert.equal(out.summary.comments, 2);
  assert.match(out.summary.last, /지금: 해소/); assert.match(out.summary.last, /다시 발생 1회 · 해소 1회/);
  assert.equal(out.summary.status, 'review', '요약 때 해소 상태면 검토로');
  assert.equal(out.summaryOnce, 2, '요약은 한 번 — 묶음을 비운다');
  assert.deepEqual(out.caps, { autoOk: 100, autoErr: { s: 409, code: 'auto-comments-full' }, humanOk: 200, humanErr: 409 }, '자동 100 · 사람 200 따로');
  assert.equal(out.legacyHuman, 'ok', '옛 자동 댓글(표지 없음 · 자동 등록 계정)은 사람 몫에서 빠진다');
  assert.equal(out.legacyAuto, 'auto-comments-full', '옛 자동 댓글이 자동 몫을 이미 넘었다');
});

test('B1-04 알림함 사람 수 상한 — 기한 지난 사람부터 · 그다음 가장 오래 쉰 사람 · 알림함을 연 사람은 지킨다', () => {
  const out = run(`
    const MAX = ib.INBOX_LIMITS.users;
    const ghosts = (n, at, tag) => { for (let k = 0; k < n; k += 1) ib.addInbox(tag + k, { kind: 'status', text: 'ISS-1 상태 변경', key: 'ISS-1' }, { now: at }); };
    // ① 가득 찬 뒤 1시간 — 새 사람이 들어오고 가장 오래 쉰 사람 하나가 나간다
    ib.addInbox('reader', { kind: 'assigned', text: 'ISS-9 담당', key: 'ISS-9' }, { now: BASE - 3_600_000 });
    ghosts(MAX - 1, BASE, 'ghost');
    out.full = ib.inboxStatus().users;
    ib.listInbox('reader', { now: BASE + 2 * 3_600_000 }); // 알림함을 연 사람 — 마지막 줄은 가장 오래됐지만 쉬지 않았다
    out.kim = ib.addInbox('kim', { kind: 'assigned', text: 'ISS-2 담당', key: 'ISS-2' }, { now: BASE + 3 * 3_600_000 });
    out.kimList = ib.listInbox('kim', { now: BASE + 3 * 3_600_000 }).total;
    out.readerKept = ib.listInbox('reader', { now: BASE + 3 * 3_600_000 }).total;
    out.ghost0 = ib.listInbox('ghost0').total;
    const s1 = ib.inboxStatus();
    out.s1 = { users: s1.users, evicted: s1.evicted, usersFull: s1.usersFull };
    // ② 31일 뒤 — 기한 지난 사람을 한꺼번에 치운다
    out.lee = ib.addInbox('lee', { kind: 'assigned', text: 'ISS-3 담당', key: 'ISS-3' }, { now: BASE + 31 * 86_400_000 });
    const s2 = ib.inboxStatus();
    out.s2 = { users: s2.users, pruned: s2.pruned, usersFull: s2.usersFull };
    // ③ 다시 읽을 때 기한 지난 줄 · 빈 사람은 자리를 차지하지 않는다 · 연 시각은 파일에 남는다
    ib._resetInboxForTest();
    const inboxFile = process.env.CONFIG_DIR + '/issue-inbox.json';
    fs.rmSync(inboxFile, { force: true }); // ① · ② 의 디바운스 쓰기가 남긴 파일과 섞이지 않게
    ib.addInbox('old', { kind: 'status', text: '옛 줄', key: 'ISS-4' }, { now: BASE - 40 * 86_400_000 });
    ib.addInbox('fresh', { kind: 'status', text: '새 줄', key: 'ISS-5' }, { now: BASE });
    ib.listInbox('fresh', { now: BASE + 60_000 });
    ib.markInboxRead('fresh', null, { now: BASE + 120_000 });
    ib.flushInboxNow();
    out.seenSaved = JSON.parse(fs.readFileSync(inboxFile, 'utf8')).seen?.fresh === BASE + 120_000;
    ib._resetInboxForTest();
    out.reload = { users: ib.inboxStatus().users, old: ib.listInbox('old').total, fresh: ib.listInbox('fresh').total };
  `);
  assert.equal(out.full, 2000);
  assert.equal(out.kim, true, '가득 차도 새 사람이 받는다');
  assert.equal(out.kimList, 1);
  assert.equal(out.readerKept, 1, '알림함을 연 사람은 마지막 줄이 가장 오래됐어도 내보내지 않는다');
  assert.equal(out.ghost0, 0, '가장 오래 쉰 사람(ghost0)이 나갔다');
  assert.deepEqual(out.s1, { users: 2000, evicted: 1, usersFull: 0 });
  assert.equal(out.lee, true);
  assert.deepEqual(out.s2, { users: 1, pruned: 2000, usersFull: 0 }, '모든 줄이 기한(30일)을 넘은 2,000명을 한꺼번에 치우고 lee 가 들어온다');
  assert.deepEqual(out.reload, { users: 1, old: 0, fresh: 1 }, '다시 읽을 때 기한 지난 줄만 있던 사람은 자리를 차지하지 않는다');
  assert.equal(out.seenSaved, true, '알림함을 연(읽음 표시한) 시각은 파일에 남는다');
});

test('B1-05 · B1-06 · B1-07 · B1-08 라우트 — 알림함 공용 줄 · 멘션 해석 후보 · 템플릿 작성자 · 범위 밖 한 번', () => {
  const out = run(`
    auth.createUser({ username: 'kim.lee', role: 'operator' }, { trusted: true });
    auth.createUser({ username: 'park.x', role: 'operator' }, { trusted: true }); // 어디에도 나오지 않는 전체 범위 계정(범위 계정의 후보 밖)
    auth.createUser({ username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } }, { trusted: true });
    auth.createUser({ username: 'opb', role: 'operator', scope: { vcenters: ['vc-b'] } }, { trusted: true });
    const OPA = { username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    // B1-05 — 공용 줄 · 범위 밖 줄은 범위 계정에게 보이지 않는다(전체 범위는 둘 다)
    ib.addInbox('kim', { kind: 'status', text: '공용 이슈 제목', key: 'ISS-1', vcenterId: '' });
    ib.addInbox('kim', { kind: 'status', text: 'A 이슈', key: 'ISS-2', vcenterId: 'vc-a' });
    as({ username: 'kim', role: 'operator', scope: { vcenters: ['vc-a'] } });
    const ka = (await call('GET', '/issues/inbox')).j;
    out.inboxScoped = { keys: ka.items.map((x) => x.key), unread: ka.unread };
    as({ username: 'kim', role: 'operator', scope: null });
    out.inboxFull = (await call('GET', '/issues/inbox')).j.items.map((x) => x.key).sort();
    // B1-06 — 범위 운영자(opa) 의 watchMentions: 자동완성 후보 밖 이름(kim.lee · ghost)은 해석하지 않는다 · 뺀 사람은 수만
    as(ADM);
    const k1 = (await call('POST', '/issues', { title: 'A 장애', vcenterId: 'vc-a' })).j.issue.key;
    await call('POST', '/issues', { title: 'A 다른 일', vcenterId: 'vc-a', watchers: ['opb'] }); // opb 는 opa 가 볼 수 있는 이슈에 나온 이름(그 법인은 못 본다)
    as(OPA);
    const w1 = await call('POST', '/issues/' + k1 + '/comments', { body: '@kim.lee @ghost.x @opb @adm 보세요', watchMentions: true });
    out.watchScoped = { s: w1.s, watch: w1.j.watch };
    as(ADM);
    const w2 = await call('POST', '/issues/' + k1 + '/comments', { body: '@kim.lee @opb 보세요', watchMentions: true });
    out.watchFull = w2.j.watch;
    // 위키 댓글 → 이슈: 후보 밖 이름 · 없는 이름은 같은 문구(계정 존재 판정이 되지 않게)
    const pg = (await call('POST', '/wiki/pages', { spaceId: 'vc-a', title: '런북', body: 'x' })).j.page;
    as(OPA);
    const e1 = await call('POST', '/wiki/pages/' + pg.id + '/comments', { body: '@park.x 봐 주세요', issue: {} });
    const e2 = await call('POST', '/wiki/pages/' + pg.id + '/comments', { body: '@nobody.here 봐 주세요', issue: {} });
    out.wikiDeny = { s1: e1.s, s2: e2.s, same: e1.j.reason === e2.j.reason, r: e1.j.reason };
    const ok = await call('POST', '/wiki/pages/' + pg.id + '/comments', { body: '@adm 확인 @opb 참고', issue: {} });
    out.wikiIssue = { s: ok.s, assignee: ok.j.issue?.assignee, watchers: ok.j.issue?.watchers, skipped: ok.j.issue?.skipped, skippedN: ok.j.issue?.skippedN };
    // B1-07 — 관리자 템플릿의 작성자 이름은 관리할 수 있는 사람에게만
    as(ADM);
    await call('POST', '/issues/templates', { name: '장애 보고', type: 'incident', body: '본문' });
    const tAdm = (await call('GET', '/issues/templates')).j;
    out.tplAdm = tAdm.items.filter((x) => x.createdBy).map((x) => x.createdBy + '/' + x.updatedBy);
    as(OPA);
    const tOp = (await call('GET', '/issues/templates')).j;
    out.tplOp = { canManage: tOp.canManage, names: tOp.items.map((x) => x.name), authors: tOp.items.filter((x) => 'createdBy' in x || 'updatedBy' in x).length };
    // B1-08 — 메일 · 알림함 둘 다 켜짐: 범위 밖 수신자(opb — vc-a 이슈 관찰자) 한 명은 한 번만 센다
    as(ADM);
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [] }, inbox: { enabled: true } });
    const before = nt.issueNotifyStatus().outOfScope;
    nt.queueIssueEvent({ type: 'status', actor: 'adm', issue: { key: k1, title: 'A 장애', assignee: 'kim.lee', reporter: 'adm', watchers: ['opb'], vcenterId: 'vc-a' }, from: 'todo', to: 'progress' });
    out.outOfScope = nt.issueNotifyStatus().outOfScope - before;
    out.kimLeeInbox = ib.listInbox('kim.lee').items.filter((x) => x.key === k1).length;
    nt._resetIssueNotifyForTest();
  `);
  assert.deepEqual(out.inboxScoped, { keys: ['ISS-2'], unread: 1 }, '범위 계정은 공용 줄을 보지 않는다');
  assert.deepEqual(out.inboxFull, ['ISS-1', 'ISS-2']);
  assert.equal(out.watchScoped.s, 200);
  assert.deepEqual(out.watchScoped.watch, { added: ['adm'], skippedN: 1 }, '후보 밖 이름은 해석하지 않고 · 뺀 사람 이름은 싣지 않는다');
  assert.deepEqual(out.watchFull, { added: ['kim.lee'], skipped: [{ name: 'opb', why: 'out-of-scope' }], skippedN: 1 }, '전체 범위 쓰기 계정은 그대로(이름 포함)');
  assert.equal(out.wikiDeny.s1, 400); assert.equal(out.wikiDeny.s2, 400);
  assert.equal(out.wikiDeny.same, true, `후보 밖 이름과 없는 이름이 같은 문구: ${out.wikiDeny.r}`);
  assert.doesNotMatch(out.wikiDeny.r, /볼 수 없어/);
  assert.deepEqual(out.wikiIssue, { s: 200, assignee: 'adm', watchers: [], skippedN: 1 }, '범위 계정 응답 — 뺀 사람은 수만(skipped 이름 없음)');
  assert.deepEqual(out.tplAdm, ['adm/adm']);
  assert.equal(out.tplOp.canManage, false);
  assert.ok(out.tplOp.names.includes('장애 보고'), '템플릿 자체는 보인다');
  assert.equal(out.tplOp.authors, 0, '관리자 계정명(createdBy · updatedBy)은 싣지 않는다');
  assert.equal(out.outOfScope, 1, '범위 밖 한 명은 한 번만 센다');
  assert.equal(out.kimLeeInbox, 1, '알림함은 그대로 쌓인다');
});
