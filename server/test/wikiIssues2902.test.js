/**
 * wikiIssues2902.test.js — v2.902 위키 · 이슈 · 첨부 점검(2026-11-05 · 3축 분석 + 메인 재현) 확정분 회귀.
 *
 * P-1 isMod 가 쓰기 범위(writeVcenters)를 보지 않았다 — 위키 남의 댓글 삭제 · 해결 · 남의 공유 필터 삭제가 쓰기 범위 밖에서 열렸다.
 * P-2 범위 계정의 이슈 상세 history · 활동 피드에 범위 밖 법인 id · 이슈 키가 원문으로 실렸다.
 * P-3 GET /wiki/templates(관리 목록)에 데모 계정 차단이 없었다.
 * P-5 첨부 올리기가 본문(8MB)을 다 받은 뒤 주인 · 범위를 봤다.
 * S-1 체크 토글은 판을 만들지 않아 편집 시작 뒤의 토글이 다음 저장에 409 없이 덮였다.
 * S-2 이슈 삭제가 남의 links 의 죽은 연결을 남겨 연결 상한(30)을 차지했다.
 * S-3 주간 필터 메일 맥락에 docs 가 없어 'doc' 조건이 화면과 달랐다.
 * S-4 자동 등록 '해소' — 댓글 상한에서 던지면 '검토' 전이가 영영 빠졌다.
 * S-5 문서/이슈 삭제가 디스크에 닿기 전에 첨부 본체를 지웠다(비정상 종료 시 문서만 되살아남).
 * S-6 팀 채팅의 할당 해제가 '담당자로 지정됐습니다' 로 찍혔다.  S-9 '@kim님' 멘션의 메일 문구가 '새 댓글' 이었다.
 * S-7 timeField 가 '20261105' 를 1970 epoch ms 로 · 없는 날짜를 다음 달로 받았다.  S-8 issueKeys 색인 50개에서 조용히 잘렸다.
 * S-10 estimateField · SLA 목표가 Number(' ')===0 으로 0 을 받았다.
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

function run(body, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2902-'));
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

test('P-1 · P-3 — 쓰기 범위 관리자는 남의 위키 댓글 · 공유 필터를 못 건드린다 · 데모 계정은 템플릿 관리 목록 403', () => {
  const { out } = run(`
    as(ADM);
    const pg = await call('POST', '/wiki/pages', { spaceId: 'pub', title: '공용 문서', body: '본문' });
    const cm = await call('POST', '/wiki/pages/' + pg.j.page.id + '/comments', { body: 'adm 의 댓글', quote: '본문' });
    const cm2 = await call('POST', '/wiki/pages/' + pg.j.page.id + '/comments', { body: 'adm 의 댓글 2' });
    const f = await call('POST', '/issues/filters', { name: '공유', query: 'status != done', shared: true });
    await call('POST', '/wiki/templates', { name: '관리자 템플릿', body: '# 절차' });
    as(WA);
    out.waSave = (await call('PUT', '/wiki/pages/' + pg.j.page.id, { baseVersion: 1, body: '고침' })).s;
    out.waResolve = (await call('POST', '/wiki/pages/' + pg.j.page.id + '/comments/' + cm.j.comment.id + '/resolve', { on: true })).s;
    out.waDelete = (await call('DELETE', '/wiki/pages/' + pg.j.page.id + '/comments/' + cm2.j.comment.id)).s;
    out.waDelFilter = (await call('DELETE', '/issues/filters/' + f.j.filter.id)).s;
    out.waMetaIssues = (await call('GET', '/issues/meta')).j.isMod;
    out.waMetaWiki = (await call('GET', '/wiki/meta')).j.isMod;
    as(ADM);
    out.admDelete = (await call('DELETE', '/wiki/pages/' + pg.j.page.id + '/comments/' + cm2.j.comment.id)).s;
    out.admMeta = (await call('GET', '/issues/meta')).j.isMod;
    as(DEMO);
    out.demoTemplates = (await call('GET', '/wiki/templates')).s;
    as(ADM);
    out.admTemplates = (await call('GET', '/wiki/templates')).s;
  `);
  assert.equal(out.waSave, 403, '전제: 공용 문서 저장은 쓰기 범위 밖');
  assert.equal(out.waResolve, 403, '남의 인라인 댓글 해결 표시 — 쓰기 범위 밖');
  assert.equal(out.waDelete, 403, '남의 댓글 삭제 — 쓰기 범위 밖');
  assert.equal(out.waDelFilter, 403, '남의 공유 필터 삭제');
  assert.equal(out.waMetaIssues, false); assert.equal(out.waMetaWiki, false);
  assert.equal(out.admDelete, 200, '전체 범위 관리자는 그대로');
  assert.equal(out.admMeta, true);
  assert.equal(out.demoTemplates, 403, 'P-3 데모 계정');
  assert.equal(out.admTemplates, 200);
});

test('P-2 — 범위 계정 응답의 이력 · 활동 피드에서 범위 밖 법인 id · 볼 수 없는 이슈 키를 가린다(전체 범위는 원문)', () => {
  const { out } = run(`
    as(ADM);
    const epic = await call('POST', '/issues', { title: '공용 에픽', type: 'epic', vcenterId: '' });
    const other = await call('POST', '/issues', { title: 'vc-b 의 이슈', vcenterId: 'vc-b' });
    const iss = await call('POST', '/issues', { title: '옮겨질 이슈', vcenterId: 'vc-b' });
    await call('PUT', '/issues/' + iss.j.issue.key, { vcenterId: 'vc-a' });
    await call('PUT', '/issues/' + iss.j.issue.key, { parentKey: epic.j.issue.key });
    await call('POST', '/issues/' + iss.j.issue.key + '/links', { type: 'blocks', key: other.j.issue.key });
    out.keys = [epic.j.issue.key, other.j.issue.key, iss.j.issue.key];
    out.admHistory = (await call('GET', '/issues/' + iss.j.issue.key)).j.issue.history.map((h) => h.field + ':' + h.from + '>' + h.to);
    as(SA);
    out.saHistory = (await call('GET', '/issues/' + iss.j.issue.key)).j.issue.history.map((h) => h.field + ':' + h.from + '>' + h.to);
    out.saActivity = (await call('GET', '/issues/activity')).j.items.filter((i) => i.key === iss.j.issue.key).map((i) => i.field + ':' + i.from + '>' + i.to);
  `);
  const [epicKey, otherKey] = out.keys;
  const sa = out.saHistory.join(' | ');
  assert.ok(!sa.includes('vc-b'), `범위 밖 법인 id 가 샌다: ${sa}`);
  assert.ok(!sa.includes(epicKey) && !sa.includes(otherKey), `볼 수 없는 이슈 키가 샌다: ${sa}`);
  assert.ok(sa.includes('(볼 수 없는 법인)') && sa.includes('(볼 수 없는 이슈)'), sa);
  assert.ok(sa.includes('vc-a'), '볼 수 있는 법인은 그대로');
  const act = out.saActivity.join(' | ');
  assert.ok(!act.includes(epicKey), `활동 피드: ${act}`);
  const adm = out.admHistory.join(' | ');
  assert.ok(adm.includes('vc-b') && adm.includes(epicKey) && adm.includes(otherKey), '전체 범위는 원문(감사 기록)');
});

test('P-5 · S-5 — 첨부는 범위 밖 주인에 본문 전에 거절 · 주인 삭제는 저장된 뒤에 첨부를 지운다', () => {
  const { out, dir } = run(`
    as(ADM);
    const pg = await call('POST', '/wiki/pages', { spaceId: 'vc-b', title: 'vc-b 문서', body: 'x' });
    const a = await up('/attach/wiki/' + pg.j.page.id, 'note.txt', Buffer.from('hello'));
    out.addS = a.s; out.attId = a.j.item.id;
    as(SA);
    out.saUpload = (await up('/attach/wiki/' + pg.j.page.id, 'x.txt', Buffer.alloc(1024 * 1024, 1))).s;
    out.saNoOwner = (await up('/attach/wiki/W999', 'x.txt', Buffer.from('a'))).s;
    as(ADM);
    const del = await call('DELETE', '/wiki/pages/' + pg.j.page.id);
    out.delS = del.s; out.delPersist = del.j.persist.state;
    await new Promise((r) => setTimeout(r, 50));
    out.listedAfter = (await import(${JSON.stringify(path.join(SRC, 'attach/store.js'))})).getItem(out.attId) ? 1 : 0;
  `);
  assert.equal(out.addS, 200);
  assert.equal(out.saUpload, 404, '조회 밖 주인 — 존재 은닉 404(본문 전에)');
  assert.equal(out.saNoOwner, 404);
  assert.equal(out.delS, 200);
  assert.equal(out.delPersist, 'saved');
  assert.equal(out.listedAfter, 0, '삭제가 저장된 뒤에는 첨부도 지운다');
  assert.equal(fs.existsSync(path.join(dir, 'attachments', out.attId)), false);
});

test('S-5 — removeOwnerAfterPersist: 저장 전이면 기다렸다가 저장됐을 때만 지운다 · 저장 실패면 남긴다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2902s5-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const at = await import(${JSON.stringify(path.join(SRC, 'attach/store.js'))});
    at.addAttachment('issue', 'ISS-1', 'a.txt', Buffer.from('a'), 'u');
    at.addAttachment('issue', 'ISS-2', 'b.txt', Buffer.from('b'), 'u');
    const quiet = { warn: () => {} };
    const r1 = at.removeOwnerAfterPersist('issue', 'ISS-1', { seq: 5, state: 'pending', wait: async () => ({ state: 'saved' }), log: quiet });
    const r2 = at.removeOwnerAfterPersist('issue', 'ISS-2', { seq: 6, state: 'pending', wait: async () => ({ state: 'failed' }), log: quiet });
    await new Promise((res) => setTimeout(res, 30));
    console.log('@@' + JSON.stringify({ r1, r2, one: at.listFor('issue', 'ISS-1').length, two: at.listFor('issue', 'ISS-2').length }));
  `], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.deepEqual(o, { r1: 'deferred', r2: 'deferred', one: 0, two: 1 });
});

test('S-1 — 편집 시작 뒤 체크 토글이 있으면 baseCheckRev 로 409 · 순번을 맞추면 저장', () => {
  const { out } = run(`
    as(ADM);
    const pg = await call('POST', '/wiki/pages', { spaceId: 'pub', title: '런북', body: '- [ ] 작업1\\n- [ ] 작업2' });
    const id = pg.j.page.id;
    const v0 = (await call('GET', '/wiki/pages/' + id)).j.page;
    out.rev0 = v0.checkRev;
    await call('POST', '/wiki/pages/' + id + '/check', { baseVersion: v0.version, line: 0, checked: true });
    const stale = await call('PUT', '/wiki/pages/' + id, { baseVersion: v0.version, baseCheckRev: v0.checkRev, title: '런북 2', body: v0.body });
    out.staleS = stale.s; out.staleKind = stale.j.kind; out.staleRev = stale.j.current?.checkRev;
    out.bodyAfterStale = (await call('GET', '/wiki/pages/' + id)).j.page.body;
    const ok = await call('PUT', '/wiki/pages/' + id, { baseVersion: v0.version, baseCheckRev: stale.j.current.checkRev, title: '런북 2', body: '- [x] 작업1\\n- [ ] 작업2' });
    out.okS = ok.s;
    const legacy = await call('PUT', '/wiki/pages/' + id, { baseVersion: ok.j.page.version, title: '런북 3' });
    out.legacyS = legacy.s;
  `);
  assert.equal(out.rev0, 0);
  assert.equal(out.staleS, 409); assert.equal(out.staleKind, 'check'); assert.equal(out.staleRev, 1);
  assert.match(out.bodyAfterStale, /- \[x\] 작업1/, '체크는 덮이지 않는다');
  assert.equal(out.okS, 200);
  assert.equal(out.legacyS, 200, 'baseCheckRev 를 싣지 않는 호출(API 스크립트)은 예전처럼 판만');
});

test('S-2 · S-7 · S-10 · S-8 — 죽은 연결 정리 · 날짜 해석 · 0 둔갑 · 색인 넘친 수', () => {
  const { out } = run(`
    as(ADM);
    const a = await call('POST', '/issues', { title: 'A' });
    const ks = [];
    for (let i = 0; i < 30; i += 1) { const t = await call('POST', '/issues', { title: 't' + i }); ks.push(t.j.issue.key); await call('POST', '/issues/' + a.j.issue.key + '/links', { type: 'relates', key: t.j.issue.key }); }
    for (const k of ks) await call('DELETE', '/issues/' + k);
    const z = await call('POST', '/issues', { title: 'Z' });
    out.linksAfter = (await call('GET', '/issues/' + a.j.issue.key)).j.issue.links.length;
    out.addLink = (await call('POST', '/issues/' + a.j.issue.key + '/links', { type: 'relates', key: z.j.issue.key })).s;
    out.due8 = (await call('POST', '/issues', { title: 'd', dueAt: '20261105' })).s;
    out.dueBad = (await call('POST', '/issues', { title: 'd', dueAt: '2026-02-30' })).s;
    out.dueOk = (await call('POST', '/issues', { title: 'd', dueAt: '2026-11-05' })).s;
    out.dueMs = (await call('POST', '/issues', { title: 'd', dueAt: 1793836800000 })).s;
    const e1 = await call('POST', '/issues', { title: 'e', estimateMin: ' ' });
    out.estSpace = e1.s === 200 ? e1.j.issue.estimateMin : 'status ' + e1.s;
    out.estArr = (await call('POST', '/issues', { title: 'e', estimateMin: [] })).s;
    out.estTrue = (await call('POST', '/issues', { title: 'e', estimateMin: true })).s;
    const body = Array.from({ length: 230 }, (_, i) => 'ISS-' + (i + 1)).join(' ');
    const pg = await call('POST', '/wiki/pages', { spaceId: 'pub', title: '키 많은 문서', body });
    out.keyCount = pg.j.page.issueKeys.length; out.keyDropped = pg.j.page.issueKeysDropped;
  `);
  assert.equal(out.linksAfter, 0);
  assert.equal(out.addLink, 200, 'S-2 죽은 연결이 상한을 차지하지 않는다');
  assert.equal(out.due8, 400, 'S-7 8자리 숫자는 epoch ms 가 아니다');
  assert.equal(out.dueBad, 400, 'S-7 없는 날짜');
  assert.equal(out.dueOk, 200); assert.equal(out.dueMs, 200);
  assert.equal(out.estSpace, null, "S-10 공백은 '없음'(0 이 아니다)");
  assert.equal(out.estArr, 400); assert.equal(out.estTrue, 400);
  assert.equal(out.keyCount, 200); assert.equal(out.keyDropped, 30, 'S-8 넘친 수를 싣는다');
});

test('S-10 · S-7(검색식) — SLA 목표 공백은 기본값 · 없는 날짜는 검색식 오류', async () => {
  const { normalizeSla, defaultSla } = await import('../src/issues/sla.js');
  const r = normalizeSla({ targets: { p0: { respondMin: ' ', resolveMin: '120' } } });
  assert.equal(r.targets.p0.respondMin, defaultSla().targets.p0.respondMin, '공백 → 기본값(0 = 끔 이 아니다)');
  assert.equal(r.targets.p0.resolveMin, 120);
  assert.throws(() => normalizeSla({ targets: { p0: { respondMin: [] } } }), /정수/);
  const { dateValue } = await import('../src/issues/query.js');
  assert.equal(dateValue('2026-02-30', 0), null);
  assert.equal(dateValue('2026-02-28', 0), Math.floor(Date.UTC(2026, 1, 28) / 86_400_000));
});

test('S-6 · S-9 — 팀 채팅 할당 해제 문구 · 조사가 붙은 멘션의 메일 문구', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2902n-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const n = await import(${JSON.stringify(path.join(SRC, 'issues/notify.js'))});
    const issue = { key: 'ISS-1', title: 't', assignee: '', reporter: 'alice', watchers: [], vcenterId: '' };
    console.log('@@' + JSON.stringify({
      chatUnassign: n.lineOf({ type: 'assigned', actor: 'alice', issue, from: 'bob', to: '' }, ''),
      kimMention: n.lineOf({ type: 'comment', actor: 'alice', issue, mentions: ['kim님', 'kim2'], excerpt: '@kim님 확인' }, 'kim'),
      kim2Mention: n.lineOf({ type: 'comment', actor: 'alice', issue, mentions: ['kim님', 'kim2'], excerpt: 'x' }, 'kim2'),
      leeNot: n.lineOf({ type: 'comment', actor: 'alice', issue, mentions: ['kim님'], excerpt: 'x' }, 'lee'),
    }));
  `], { env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('@@')).slice(2));
  assert.match(o.chatUnassign, /bob → 미할당/, o.chatUnassign);
  assert.match(o.kimMention, /댓글에서 언급했습니다/);
  assert.match(o.kim2Mention, /댓글에서 언급했습니다/);
  assert.match(o.leeNot, /새 댓글/);
});
