/**
 * wiki2881.test.js — 위키(v2.881 · 시안 docs/design/wiki-issues ①~⑤).
 *
 * ① 순수 — 줄 비교(lineDiff · hunks) · 이슈 키 색인.
 * ② 실제 api 라우터(자식 프로세스 — CONFIG_DIR 를 갈아 끼운다): 범위(조회 밖 404 → 쓰기 밖 403 · 범위 계정은 공용을 못 본다) · 역할 ·
 *    충돌(baseVersion) · 판 · 비교 · 되돌리기 · 트리 깊이 · 찾기 · 역참조 · 대문 · 스페이스 설정 · 알림(실제 발송 함수 대체) · 손상 파일.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lineDiff, hunks, MAX_CELLS } from '../src/wiki/diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');

test('① 줄 비교 — 같은 앞뒤를 떼고 가운데만 · 바뀐 근처만 · 너무 크면 앞뒤 비교로(밝힌다)', () => {
  const d = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  assert.deepEqual(d.ops.map((o) => `${o.op}:${o.text}`), ['same:a', 'del:b', 'add:B', 'same:c', 'same:d', 'add:e']);
  assert.equal(d.added, 2); assert.equal(d.removed, 1); assert.equal(d.truncated, false);
  assert.deepEqual(lineDiff('x', 'x').ops.map((o) => o.op), ['same']);
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const changed = [...long]; changed[20] = 'CHANGED';
  const h = hunks(lineDiff(long.join('\n'), changed.join('\n')).ops, 2);
  assert.equal(h[0].op, 'gap'); assert.equal(h[0].skipped, 18);
  assert.equal(h[h.length - 1].op, 'gap');
  const n = Math.ceil(Math.sqrt(MAX_CELLS)) + 10;
  const big = lineDiff(Array.from({ length: n }, (_, i) => `a${i}`).join('\n'), Array.from({ length: n }, (_, i) => `b${i}`).join('\n'));
  assert.equal(big.truncated, true, '표가 상한을 넘으면 LCS 를 만들지 않는다');
  assert.equal(big.added, n); assert.equal(big.removed, n);
});

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki2881-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const nt = await import(${JSON.stringify(path.join(SRC, 'issues/notify.js'))});
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
    const out = {};
    ${body}
    wk.flushWikiNow();
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

test('② 범위 · 역할 — 범위 계정은 자기 법인 스페이스만(공용 X) · 조회 밖 404 → 쓰기 밖 403 · viewer 는 읽기 + 댓글(요청 권한)', () => {
  const { out } = run(`
    const pub = (await call('POST', '/wiki/pages', { title: '공용 문서', body: '전 법인 규칙' })).j.page.id;
    const a = (await call('POST', '/wiki/pages', { title: 'A 런북', body: 'ISS-1 참고', spaceId: 'vc-a' })).j.page.id;
    const b = (await call('POST', '/wiki/pages', { title: 'B 비밀', body: 'B 법인 절차 ISS-1', spaceId: 'vc-b' })).j.page.id;
    as({ username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'] } });
    out.meta = (await call('GET', '/wiki/meta')).j;
    out.getPub = await call('GET', '/wiki/pages/' + pub);
    out.getB = await call('GET', '/wiki/pages/' + b);
    out.putB = await call('PUT', '/wiki/pages/' + b, { baseVersion: 1, body: 'x' });
    out.getA = await call('GET', '/wiki/pages/' + a);
    out.newPub = await call('POST', '/wiki/pages', { title: '공용 시도' });
    out.newB = await call('POST', '/wiki/pages', { title: '남의 법인', spaceId: 'vc-b' });
    out.search = (await call('GET', '/wiki/search?q=' + encodeURIComponent('절차'))).j;
    out.backrefs = (await call('GET', '/wiki/backrefs?key=ISS-1')).j.pages.map((p) => p.title);
    out.homePub = await call('GET', '/wiki/home?space=pub');
    as({ username: 'ro', role: 'operator', scope: { vcenters: ['vc-a', 'vc-b'], writeVcenters: ['vc-a'] } });
    out.roPut = await call('PUT', '/wiki/pages/' + b, { baseVersion: 1, body: 'x' });
    out.roComment = await call('POST', '/wiki/pages/' + b + '/comments', { body: '질문' });
    as({ username: 'vw', role: 'viewer', scope: null });
    out.vwNew = await call('POST', '/wiki/pages', { title: 'v' });
    out.vwPut = await call('PUT', '/wiki/pages/' + pub, { baseVersion: 1, body: 'x' });
    out.vwComment = await call('POST', '/wiki/pages/' + pub + '/comments', { body: '좋은 문서 @adm' });
    out.vwWatch = await call('POST', '/wiki/pages/' + pub + '/watch', { on: true });
    out.vwGet = (await call('GET', '/wiki/pages/' + pub)).j;
  `);
  assert.deepEqual(out.meta.spaces.map((s) => s.id), ['vc-a'], '범위 계정의 스페이스 목록에 공용·남의 법인이 없다');
  assert.equal(out.getPub.s, 404); assert.equal(out.getB.s, 404); assert.equal(out.putB.s, 404, '조회 밖은 404');
  assert.equal(out.getA.s, 200);
  assert.equal(out.newPub.s, 400, '범위 계정은 공용에 만들 수 없다');
  assert.equal(out.newB.s, 400, '조회 밖 법인은 존재를 흘리지 않는다(400 등록되지 않은 법인)');
  assert.ok(!out.search.rows.some((r) => /B 비밀/.test(r.title)), '찾기도 범위가 먼저');
  assert.deepEqual(out.backrefs, ['A 런북'], '역참조도 보이는 문서만');
  assert.equal(out.homePub.s, 404);
  assert.equal(out.roPut.s, 403, '조회는 되지만 쓰기 밖 → 403');
  assert.equal(out.roComment.s, 403, '쓰기 밖 법인에는 댓글도 못 단다');
  assert.equal(out.vwNew.s, 403); assert.equal(out.vwPut.s, 403);
  assert.equal(out.vwComment.s, 200, 'viewer 는 요청 권한(issues.request)으로 댓글');
  assert.equal(out.vwWatch.s, 200);
  assert.equal(out.vwGet.page.watching, true);
  assert.equal(out.vwGet.canWrite, false);
});

test('③ 충돌 · 판 · 비교 · 되돌리기 · 트리 깊이 · 지우기 · 대문 · 스페이스 설정', () => {
  const { out } = run(`
    const p = (await call('POST', '/wiki/pages', { title: '런북', body: 'a\\nb\\nc', labels: 'faq, vcenter' })).j.page;
    out.v2 = await call('PUT', '/wiki/pages/' + p.id, { baseVersion: 1, body: 'a\\nB\\nc', note: 'b 고침' });
    out.stale = await call('PUT', '/wiki/pages/' + p.id, { baseVersion: 1, body: 'a\\nX\\nc' });
    out.same = await call('PUT', '/wiki/pages/' + p.id, { baseVersion: 2, body: 'a\\nB\\nc' });
    out.diff = (await call('GET', '/wiki/pages/' + p.id + '/diff?from=1&to=2')).j;
    out.revert = await call('POST', '/wiki/pages/' + p.id + '/revert', { v: 1 });
    const c1 = (await call('POST', '/wiki/pages', { title: '하위1', parentId: p.id })).j.page.id;
    const c2 = (await call('POST', '/wiki/pages', { title: '하위2', parentId: c1 })).j.page.id;
    out.tooDeep = await call('POST', '/wiki/pages', { title: '하위3', parentId: c2 });
    out.cycle = await call('PUT', '/wiki/pages/' + p.id, { baseVersion: 3, parentId: c2 });
    out.delParent = await call('DELETE', '/wiki/pages/' + p.id);
    out.delLeaf = await call('DELETE', '/wiki/pages/' + c2);
    as({ username: 'op2', role: 'operator', scope: null });
    out.delOthers = await call('DELETE', '/wiki/pages/' + c1);
    as(ADM);
    out.home = (await call('GET', '/wiki/home?space=pub')).j;
    out.badLink = await call('PUT', '/wiki/spaces/pub', { quickLinks: [{ title: 'x', href: 'javascript:alert(1)' }] });
    out.space = await call('PUT', '/wiki/spaces/pub', { homeMd: '# 대문', notice: { md: '변경 창 공지', until: Date.now() + 3600000 }, quickLinks: [{ title: '이슈', href: '#/issues/board' }] });
    out.home2 = (await call('GET', '/wiki/home?space=pub')).j;
    as({ username: 'sa', role: 'admin', scope: { vcenters: ['vc-a'] } });
    out.scopedSpacePub = await call('PUT', '/wiki/spaces/pub', { homeMd: 'x' });
    as({ username: 'op', role: 'operator', scope: null });
    out.opSpace = await call('PUT', '/wiki/spaces/pub', { homeMd: 'x' });
    as(ADM);
    await call('PUT', '/wiki/spaces/pub', { readOnly: true });
    out.roSave = await call('POST', '/wiki/pages', { title: '읽기 전용에 새 문서' });
    out.roView = (await call('GET', '/wiki/pages/' + p.id)).j.page;
    out.roEdit = await call('PUT', '/wiki/pages/' + p.id, { baseVersion: out.roView.version, body: '읽기 전용에서 고침' });
    out.roComment = await call('POST', '/wiki/pages/' + p.id + '/comments', { body: '읽기 전용에도 댓글은 된다' });
  `);
  assert.equal(out.v2.s, 200); assert.equal(out.v2.j.page.version, 2);
  assert.equal(out.stale.s, 409, '편집 시작 판이 낡았으면 409'); assert.equal(out.stale.j.code, 'conflict'); assert.equal(out.stale.j.current.version, 2);
  assert.equal(out.same.j.page.version, 2, '바뀐 것이 없으면 판을 만들지 않는다');
  assert.equal(out.diff.added, 1); assert.equal(out.diff.removed, 1);
  assert.equal(out.revert.j.page.version, 3); assert.equal(out.revert.j.page.body, 'a\nb\nc'); assert.match(out.revert.j.page.versions[0].note, /v1 로 되돌림/);
  assert.equal(out.tooDeep.s, 400, '트리는 3단계까지');
  assert.equal(out.cycle.s, 400, '자기 하위를 상위로 둘 수 없다');
  assert.equal(out.delParent.s, 400, '하위 문서가 있으면 지울 수 없다');
  assert.equal(out.delLeaf.s, 200);
  assert.equal(out.delOthers.s, 403, '남이 만든 문서는 전체 범위 관리자만');
  assert.equal(out.home.counts.pages, 2);
  assert.deepEqual(out.home.faq.map((x) => x.title), ['런북'], '라벨 faq 가 FAQ 로 모인다');
  assert.ok(out.home.labels.some((l) => l.name === 'vcenter'));
  assert.equal(out.badLink.s, 400, 'javascript: 링크는 받지 않는다');
  assert.equal(out.space.s, 200);
  assert.equal(out.home2.space.notice.md, '변경 창 공지');
  assert.deepEqual(out.home2.space.quickLinks.map((q) => q.href), ['#/issues/board']);
  assert.equal(out.scopedSpacePub.s, 404, '범위 관리자는 공용 스페이스를 보지도 못한다');
  assert.equal(out.opSpace.s, 403, '스페이스 설정은 관리자만');
  assert.equal(out.roSave.s, 403, '읽기 전용 스페이스에는 만들 수 없다');
  // v2.881 화면 계약: writable(편집 버튼)은 읽기 전용을 보고, commentable(댓글 칸)은 쓰기 범위만 본다 — 서버 판정과 같아야 버튼이 거짓말하지 않는다
  assert.equal(out.roView.writable, false); assert.equal(out.roView.commentable, true);
  assert.equal(out.roEdit.s, 403, '읽기 전용 스페이스의 문서는 고칠 수 없다');
  assert.equal(out.roComment.s, 200, '읽기 전용 스페이스에도 댓글은 단다');
});

test('④ 알림 — 지켜보는 사람 · 언급된 사람에게 묶어서 · 본인 제외 · 그 스페이스를 볼 수 있는 사람만', () => {
  const { out } = run(`
    const auth = await import(${JSON.stringify(path.join(SRC, 'auth/auth.js'))});
    auth.createUser({ username: 'opb', role: 'operator', scope: { vcenters: ['vc-b'] } }, { trusted: true });
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    nt.startIssueNotify();
    await new Promise((r) => setTimeout(r, 50));
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, people: [{ username: 'kim', email: 'kim@example.com' }, { username: 'opb', email: 'opb@example.com' }, { username: 'adm', email: 'adm@example.com' }] } });
    const p = (await call('POST', '/wiki/pages', { title: '법인 A 런북', body: '초안', spaceId: 'vc-a' })).j.page;
    await call('PUT', '/wiki/pages/' + p.id, { baseVersion: 1, body: '검토 부탁 @kim @opb' });
    as({ username: 'kim', role: 'operator', scope: null });
    await call('POST', '/wiki/pages/' + p.id + '/comments', { body: '확인했습니다' });
    out.flush = await nt.flushIssueNotify();
    out.mails = mails.map((m) => ({ to: m.to[0], text: m.text }));
    out.status = nt.issueNotifyStatus();
  `);
  const to = out.mails.map((m) => m.to).sort();
  assert.ok(to.includes('kim@example.com'), '언급된 kim');
  assert.ok(!to.includes('opb@example.com'), '법인 B 범위 계정은 법인 A 문서 알림을 받지 않는다');
  assert.ok(to.includes('adm@example.com'), '만든 사람(지켜보는 사람)은 남의 댓글을 받는다');
  assert.match(out.mails.find((m) => m.to === 'kim@example.com').text, /\[위키\] 법인 A 런북 — v2 고침 · 본문에서 언급했습니다/);
  assert.ok(out.status.outOfScope >= 1);
});

test('⑤ 손상 파일 — 보존하고 빈 위키로 시작(덮어쓰지 않는다)', () => {
  const { out, dir } = run(`
    out.meta = (await call('GET', '/wiki/meta')).j;
    out.home = (await call('GET', '/wiki/home?space=pub')).j;
  `, { pre: (d) => fs.writeFileSync(path.join(d, 'wiki.json'), '{"pages": [') });
  assert.equal(out.home.counts.pages, 0);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('wiki.json.corrupt')).length, 1);
});
