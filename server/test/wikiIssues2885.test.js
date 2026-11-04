/**
 * wikiIssues2885.test.js — v2.885 C-2 · C-3: 위키 즐겨찾기 · 최근 본 · 많이 본(조회 수) · 이슈 CSV · 작업 기록 · 예상 · 수정/영향 버전 · SLA 시계 · SLA 알림
 * + **이슈 쓰기 응답의 범위 누수 정정**(v2.882 · v2.883 이 쓰기 응답에서 범위를 넘기지 않아 연결 · 에픽이 범위 밖까지 보였다).
 *
 * ① 순수 SLA — 응답(상태 · 보고자 아닌 댓글) · 보류 구간을 뺀 시간 · 초과/임박/멈춤/늦음/지킴 · 대상 아님 · 이력 넘침 표시 · 설정 검사.
 * ② 실제 api 라우터(자식 프로세스): 위키 개인화 — 사람 · 날마다 한 번 · 범위로 다시 거르기 · 지운 문서 정리 · 범위 밖 즐겨찾기 404.
 * ③ 이슈 CSV — 범위 · 검색식 · 수식 주입 가드 · BOM.
 * ④ 쓰기 응답 범위 — 범위 계정이 고친 이슈의 응답에 범위 밖 연결 · 공용 에픽이 실리지 않는다(정정 회귀).
 * ⑤ 작업 기록 · 예상 · 버전 · 검색식(fixversion · sla).
 * ⑥ SLA 알림 — 단계마다 한 번 · 보낸 뒤 기록 · 완료하면 기록을 지운다 · 꺼져 있으면 보내지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slaOf, normalizeSla, defaultSla, usedMin } from '../src/issues/sla.js';
import { parseQuery } from '../src/issues/query.js';
import { issuesCsv } from '../src/issues/exportCsv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const M = 60_000;

test('① SLA 시계 — 이력에서 계산 · 보류 중 멈춤 · 단계 상태', () => {
  const on = { ...defaultSla(), enabled: true }; // p0: 응답 15분 · 해결 240분, 대상 장애 · 요청
  const T = 1_800_000_000_000;
  const base = { type: 'incident', priority: 'p0', reporter: 'rep', createdAt: T, status: 'todo', history: [], comments: [] };
  assert.equal(slaOf(base, defaultSla(), T + M), null, '꺼져 있으면 null');
  assert.equal(slaOf({ ...base, type: 'task' }, on, T + M), null, '대상 유형이 아니면 null');
  assert.equal(slaOf({ ...base, type: 'epic' }, { ...on, types: ['epic'] }, T + M), null, '에픽은 대상이 아니다');
  let s = slaOf(base, on, T + 5 * M);
  assert.deepEqual([s.respond.state, s.respond.usedMin, s.resolve.state, s.state], ['running', 5, 'running', 'running']);
  assert.equal(s.respond.dueAt, T + 15 * M);
  assert.equal(slaOf(base, on, T + 13 * M).respond.state, 'warning', '80% 이상은 임박');
  s = slaOf(base, on, T + 20 * M);
  assert.deepEqual([s.respond.state, s.state], ['breached', 'breached']);
  // 응답 — 진행 중으로 옮김(10분) / 보고자 댓글은 응답이 아니다 / 다른 사람 댓글(8분)이 더 이르다
  const moved = { ...base, status: 'progress', history: [{ at: T + 10 * M, field: 'status', from: 'todo', to: 'progress' }], comments: [{ id: 'c1', author: 'rep', createdAt: T + 2 * M }] };
  assert.deepEqual([slaOf(moved, on, T + 60 * M).respond.state, slaOf(moved, on, T + 60 * M).respond.at], ['met', T + 10 * M]);
  const commented = { ...moved, comments: [...moved.comments, { id: 'c2', author: 'ops', createdAt: T + 8 * M }] };
  assert.equal(slaOf(commented, on, T + 60 * M).respond.at, T + 8 * M);
  const late = { ...base, status: 'progress', history: [{ at: T + 30 * M, field: 'status', from: 'todo', to: 'progress' }] };
  s = slaOf(late, on, T + 60 * M);
  assert.deepEqual([s.respond.state, s.anyLate, s.state], ['late', true, 'running'], '응답이 늦었어도 지금 볼 것은 해결 단계');
  // 보류 — 5분 ~ 25분 멈춤 → 30분 시점 흐른 시간 10분(응답 15분 안)
  const held = { ...base, history: [{ at: T + 5 * M, field: 'blocked', from: '', to: '부품 대기' }, { at: T + 25 * M, field: 'blocked', from: '부품 대기', to: '' }] };
  assert.equal(slaOf(held, on, T + 30 * M).respond.usedMin, 10);
  assert.equal(slaOf(held, on, T + 30 * M).respond.state, 'running');
  // 지금 보류 중 — 멈춤 · 끝나는 시각을 말하지 않는다
  const holding = { ...base, blocked: { reason: 'x', at: T + 5 * M, by: 'a' }, history: [{ at: T + 5 * M, field: 'blocked', from: '', to: 'x' }] };
  s = slaOf(holding, on, T + 60 * M);
  assert.deepEqual([s.respond.state, s.respond.usedMin, s.respond.dueAt, s.paused], ['paused', 5, null, true]);
  // 해결 — 완료 시각 · 다시 열면 이어진다
  const done = { ...base, status: 'done', closedAt: T + 100 * M, history: [{ at: T + 10 * M, field: 'status', to: 'progress' }, { at: T + 100 * M, field: 'status', to: 'done' }] };
  s = slaOf(done, on, T + 999 * M);
  assert.deepEqual([s.resolve.state, s.resolve.usedMin, s.state], ['met', 100, 'met']);
  // 처음부터 진행 중으로 만든 이슈(상태 줄 없음) — 만든 시각이 응답
  assert.equal(slaOf({ ...base, status: 'progress' }, on, T + 60 * M).respond.at, T);
  // 이력이 넘쳐 지워졌으면 partial
  assert.equal(slaOf({ ...base, historyDropped: 3 }, on, T + M).partial, true);
  // 목표 0 = 보지 않음
  assert.equal(slaOf(base, { ...on, targets: { ...on.targets, p0: { respondMin: 0, resolveMin: 240 } } }, T + 60 * M).respond.state, 'off');
  assert.equal(usedMin(T, T + 10 * M, [[T + 2 * M, null]]), 2, '열린 보류 구간은 t 까지');
  // 설정 검사
  assert.throws(() => normalizeSla({ targets: { p0: { respondMin: -1 } } }), /0~/);
  assert.throws(() => normalizeSla({ types: ['epic'] }), /알 수 없는 유형/);
  assert.throws(() => normalizeSla({ warnPct: 20 }), /50~99/);
  assert.deepEqual(normalizeSla({ targets: { p0: { respondMin: -1 } } }, { strict: false }).targets.p0.respondMin, 15, '파일 읽기는 기본값으로');
  // 검색식 필드
  assert.equal(parseQuery('sla = 초과 AND fixversion = 2.885.0').errors.length, 0);
  assert.match(parseQuery('sla = breachd').errors[0].hint, /breached/);
  assert.match(parseQuery('sla > ok').errors[0].msg, /쓸 수 없|연산자/);
});

test('① CSV — 수식 주입 가드 · BOM · 빈 값은 빈 칸', () => {
  const csv = issuesCsv([{ key: 'ISS-1', type: 'incident', title: '=HYPERLINK("x")', status: 'todo', priority: 'p0', vcenterId: '', labels: ['a', 'b'], progress: null, createdAt: 1_800_000_000_000, estimateMin: 90, spentMin: 0, worklogCount: 0 }]);
  assert.ok(csv.startsWith('﻿'), 'BOM');
  const [head, row] = csv.slice(1).split('\r\n');
  assert.match(head, /^키,유형,제목/);
  assert.match(row, /,"'=HYPERLINK\(""x""\)",/, '= 로 시작하는 제목은 작은따옴표 · 따옴표 두 번');
  assert.match(row, /,공용,/);
  const cells = row.split(',');
  assert.equal(cells[cells.length - 5], '90', '예상은 분 숫자');
  assert.equal(cells[cells.length - 4], '', '기록이 없으면 0 이 아니라 빈 칸');
});

function run(body, { pre, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2885-'));
  if (pre) pre(dir);
  const script = `
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const st = await import(${JSON.stringify(path.join(SRC, 'issues/store.js'))});
    const wk = await import(${JSON.stringify(path.join(SRC, 'wiki/store.js'))});
    const wu = await import(${JSON.stringify(path.join(SRC, 'wiki/userState.js'))});
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
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { s: r.status, j, t: j ? '' : t, type: r.headers.get('content-type') || '' };
    };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const SA = { username: 'sa', role: 'operator', scope: { vcenters: ['vc-a'] } };
    const out = {};
    ${body}
    st.flushIssuesNow(); wk.flushWikiNow(); wu.flushWikiUserNow();
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

test('② 위키 즐겨찾기 · 최근 본 · 많이 본 — 사람 · 날마다 한 번 · 지금 범위로 다시 거른다 · 지운 문서 정리', () => {
  const { out, dir } = run(`
    const pa = (await call('POST', '/wiki/pages', { title: 'A 런북', spaceId: 'vc-a', body: 'a' })).j.page;
    const pb = (await call('POST', '/wiki/pages', { title: 'B 런북', spaceId: 'vc-b', body: 'b' })).j.page;
    const pp = (await call('POST', '/wiki/pages', { title: '공용 안내', spaceId: 'pub', body: 'p' })).j.page;
    const pz = (await call('POST', '/wiki/pages', { title: '지울 문서', spaceId: 'vc-a', body: 'z' })).j.page;
    for (const id of [pa.id, pa.id, pb.id, pp.id, pz.id]) await call('GET', '/wiki/pages/' + id);
    await call('POST', '/wiki/pages/' + pa.id + '/fav', { on: true });
    await call('POST', '/wiki/pages/' + pb.id + '/fav', { on: true });
    await call('POST', '/wiki/pages/' + pp.id + '/fav', { on: true });
    out.favAgain = await call('POST', '/wiki/pages/' + pp.id + '/fav', { on: true });
    out.pageFav = (await call('GET', '/wiki/pages/' + pp.id + '?nv=1')).j.page.fav;
    as(SA);
    await call('GET', '/wiki/pages/' + pa.id);
    await call('GET', '/wiki/pages/' + pa.id);
    out.saFavPub = await call('POST', '/wiki/pages/' + pp.id + '/fav', { on: true });
    out.saFavA = await call('POST', '/wiki/pages/' + pz.id + '/fav', { on: true });
    out.saHome = (await call('GET', '/wiki/home?space=vc-a')).j;
    // 같은 이름 'adm' 이 범위 계정이 되면(범위가 줄면) 즐겨찾기 · 최근에서 범위 밖이 빠진다
    as({ username: 'adm', role: 'admin', scope: { vcenters: ['vc-a'] } });
    out.narrowHome = (await call('GET', '/wiki/home?space=vc-a')).j;
    as(ADM);
    out.del = await call('DELETE', '/wiki/pages/' + pz.id);
    as(SA);
    out.saAfterDel = (await call('GET', '/wiki/home?space=vc-a')).j.mine;
    as({ username: 'vw', role: 'viewer', scope: null });
    out.viewerFav = await call('POST', '/wiki/pages/' + pa.id + '/fav', { on: true });
    as(ADM);
    out.admHome = (await call('GET', '/wiki/home?space=vc-a')).j;
    out.ids = { pa: pa.id, pb: pb.id, pp: pp.id, pz: pz.id };
  `);
  const { pa, pb, pp, pz } = out.ids;
  assert.equal(out.favAgain.s, 200); assert.equal(out.pageFav, true);
  assert.equal(out.saFavPub.s, 404, '범위 밖(공용) 문서는 즐겨찾기도 404');
  assert.equal(out.saFavA.s, 200);
  const pop = Object.fromEntries(out.saHome.popular.map((p) => [p.id, p.views]));
  assert.equal(pop[pa], 2, 'adm 이 두 번 · sa 가 두 번 열어도 사람마다 하루 1 → 2');
  assert.equal(out.saHome.popular.every((p) => p.spaceId === 'vc-a'), true, '많이 본 문서는 그 스페이스만');
  assert.deepEqual(out.saHome.mine.recent.map((p) => p.id), [pa], 'sa 의 최근 본 문서');
  assert.ok(out.saHome.mine.recent[0].viewedAt > 0);
  assert.deepEqual(out.narrowHome.mine.fav.map((p) => p.id), [pa], '범위가 줄면 범위 밖 즐겨찾기(vc-b · 공용)는 빠진다');
  assert.ok(out.narrowHome.mine.recent.every((p) => p.spaceId === 'vc-a'), '최근 본 문서도 범위로 다시 거른다');
  assert.equal(out.del.s, 200);
  assert.deepEqual(out.saAfterDel.fav, [], '지운 문서는 즐겨찾기에서 빠진다');
  assert.equal(out.viewerFav.s, 200, 'viewer 도 요청 권한(issues.request)이 있으면 즐겨찾기를 쓴다(지켜보기와 같은 문지기)');
  assert.deepEqual(out.admHome.mine.fav.map((p) => p.id), [pp, pb, pa], '즐겨찾기는 최근에 단 것부터');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'wiki-user.json'), 'utf8'));
  assert.equal(saved.views[pz], undefined, '지운 문서의 조회 수도 지운다');
  assert.ok(saved.users.adm.today.ids.length >= 3, '그날 중복 기록');
});

test('③ 이슈 CSV · ④ 쓰기 응답 범위(정정) · ⑤ 작업 기록 · 예상 · 버전', () => {
  const { out } = run(`
    auth.createUser({ username: 'op2', role: 'operator', password: 'Strong-Passw0rd!2885', scope: null }, { trusted: true });
    const epic = (await call('POST', '/issues', { title: '공용 에픽', type: 'epic' })).j.issue;
    const a = (await call('POST', '/issues', { title: '=cmd|A 장애', vcenterId: 'vc-a', type: 'incident', parentKey: epic.key })).j.issue;
    const b = (await call('POST', '/issues', { title: 'B 비밀 제목', vcenterId: 'vc-b', type: 'incident' })).j.issue;
    await call('POST', '/issues/' + b.key + '/links', { type: 'blocks', key: a.key });
    out.admCsv = await call('GET', '/issues/export.csv?done=all');
    as({ username: 'sadm', role: 'admin', scope: { vcenters: ['vc-a'] } });
    out.saCsv = await call('GET', '/issues/export.csv?done=all');
    out.saQueryCsv = await call('GET', '/issues/export.csv?done=all&query=' + encodeURIComponent('title ~ 없는제목'));
    as(SA);
    out.opCsv = await call('GET', '/issues/export.csv?done=all');
    out.saPut = (await call('PUT', '/issues/' + a.key, { title: 'A 장애' })).j.issue;
    out.saBlock = (await call('POST', '/issues/' + a.key + '/block', { on: true, reason: '부품 대기' })).j.issue;
    out.saWatch = (await call('POST', '/issues/' + a.key + '/watch', { on: true })).j.issue;
    out.saGet = (await call('GET', '/issues/' + a.key)).j.issue;
    // ⑤ 작업 기록 · 예상 · 버전
    out.est = await call('PUT', '/issues/' + a.key, { estimateMin: 240, fixVersion: '2.885.0', affectsVersion: '2.884.0' });
    out.badVer = await call('PUT', '/issues/' + a.key, { fixVersion: '-1;drop' });
    out.badEst = await call('PUT', '/issues/' + a.key, { estimateMin: 1.5 });
    out.w1 = await call('POST', '/issues/' + a.key + '/worklog', { minutes: 90, note: '현장 확인' });
    out.wFuture = await call('POST', '/issues/' + a.key + '/worklog', { minutes: 30, on: '2999-01-01' });
    out.wZero = await call('POST', '/issues/' + a.key + '/worklog', { minutes: 0 });
    out.wBadDay = await call('POST', '/issues/' + a.key + '/worklog', { minutes: 10, on: '2026-02-30' });
    out.wOutOfScope = await call('POST', '/issues/' + b.key + '/worklog', { minutes: 10 });
    as(ADM);
    out.w2 = await call('POST', '/issues/' + a.key + '/worklog', { minutes: 30 });
    as({ username: 'op2', role: 'operator', scope: null });
    out.wOtherRemove = await call('POST', '/issues/' + a.key + '/worklog/remove', { id: out.w1.j.issue.worklog[0].id });
    as(SA);
    out.wOwnRemove = await call('POST', '/issues/' + a.key + '/worklog/remove', { id: out.w1.j.issue.worklog[0].id });
    as(ADM);
    out.q = (await call('GET', '/issues?done=all&query=' + encodeURIComponent('fixversion = 2.885.0'))).j;
    out.meta = (await call('GET', '/issues/meta')).j;
  `);
  // ③
  assert.equal(out.admCsv.s, 200); assert.match(out.admCsv.type, /text\/csv/);
  assert.match(out.admCsv.t, /B 비밀 제목/); assert.match(out.admCsv.t, /"'=cmd\|A 장애"|'=cmd\|A 장애/, '수식 주입 가드');
  assert.doesNotMatch(out.saCsv.t, /B 비밀 제목/, '범위 계정의 CSV 에 범위 밖 이슈가 없다');
  assert.doesNotMatch(out.saCsv.t, /공용 에픽/, '공용 이슈도 범위 계정에 없다');
  assert.match(out.saCsv.t, /A 장애/);
  assert.equal(out.saQueryCsv.t.trim().split('\r\n').length, 1, '검색식도 같이 건다(머리글만)');
  assert.equal(out.opCsv.s, 403, 'CSV 는 포탈 규약대로 권한 키 data.csv(관리자) — 운영자는 403');
  // ④ 정정 회귀 — 쓰기 응답(PUT · 보류 · 지켜보기)에도 범위가 걸린다
  for (const [name, x] of Object.entries({ put: out.saPut, block: out.saBlock, watch: out.saWatch, get: out.saGet })) {
    assert.deepEqual(x.links, [], `${name}: 범위 밖(vc-b) 연결이 실리지 않는다`);
    assert.equal(x.epicKey, '', `${name}: 볼 수 없는 공용 에픽 키를 싣지 않는다`);
    assert.equal(x.epic, null, `${name}: 공용 에픽 제목을 싣지 않는다`);
    assert.equal(x.blockedOpen, 0, `${name}: 볼 수 없는 차단은 세지 않는다`);
  }
  // ⑤
  assert.equal(out.est.s, 200);
  assert.deepEqual([out.est.j.issue.estimateMin, out.est.j.issue.fixVersion, out.est.j.issue.affectsVersion], [240, '2.885.0', '2.884.0']);
  assert.ok(out.est.j.issue.history.some((h) => h.field === 'estimate' && h.to === '4h'));
  assert.equal(out.badVer.s, 400); assert.equal(out.badEst.s, 400);
  assert.equal(out.w1.s, 200); assert.equal(out.w1.j.issue.spentMin, 90);
  assert.ok(out.w1.j.issue.history.some((h) => h.field === 'worklog' && h.to === '+1h 30m'));
  assert.equal(out.wFuture.s, 400); assert.equal(out.wZero.s, 400); assert.equal(out.wBadDay.s, 400, '없는 날짜(2월 30일)');
  assert.equal(out.wOutOfScope.s, 404, '조회 밖 이슈는 404');
  assert.equal(out.w2.j.issue.spentMin, 120);
  assert.equal(out.wOtherRemove.s, 403, '남의 작업 기록은 적은 사람이나 관리자만');
  assert.equal(out.wOwnRemove.s, 200); assert.equal(out.wOwnRemove.j.issue.spentMin, 30);
  assert.deepEqual(out.q.rows.map((r) => r.title), ['A 장애'], '검색식 fixversion');
  assert.match(out.meta.portalVersion, /^\d+\.\d+\.\d+/);
  assert.equal(out.meta.sla.enabled, false, 'SLA 기본은 꺼짐');
});

test('⑥ SLA 알림 — 단계마다 한 번 · 보낸 뒤 기록 · 완료하면 기록을 지운다 · 꺼져 있으면 보내지 않는다', () => {
  const { out } = run(`
    const mails = [];
    nt._setIssueNotifySendersForTest({ mail: async (o) => { mails.push(o); return { ok: true }; }, chat: async () => [] });
    await call('PUT', '/issues/settings', { notify: { enabled: true, mail: true, chat: false, people: [{ username: 'adm', email: 'adm@example.com' }, { username: 'kim', email: 'kim@example.com' }] } });
    const x = (await call('POST', '/issues', { title: '긴급 장애', type: 'incident', priority: 'p0', assignee: 'kim' })).j.issue;
    const t = (await call('POST', '/issues', { title: '작업', type: 'task', priority: 'p0', assignee: 'kim' })).j.issue;
    const now = Date.now();
    out.off = nt.scanSla(now + 20 * 60000);
    const s1 = await call('GET', '/issues/settings');
    out.keptSla = s1.j.settings.sla.enabled;
    await call('PUT', '/issues/settings', { ...s1.j.settings, sla: { ...s1.j.settings.sla, enabled: true } });
    out.keepOnNotifySave = await call('PUT', '/issues/settings', { notify: s1.j.settings.notify, autoAssign: s1.j.settings.autoAssign });
    out.first = nt.scanSla(now + 20 * 60000);
    await nt.flushIssueNotify();
    out.mails = mails.map((m) => ({ to: m.to[0], text: m.text }));
    out.again = nt.scanSla(now + 25 * 60000);
    out.resolve = nt.scanSla(now + 300 * 60000);
    await nt.flushIssueNotify();
    out.mails2 = mails.length;
    out.listSla = (await call('GET', '/issues?query=' + encodeURIComponent('sla = 초과'))).j.rows.map((r) => r.key);
    out.card = (await call('GET', '/issues/' + x.key)).j.issue.sla;
    await call('POST', '/issues/' + x.key + '/status', { status: 'done' });
    nt.scanSla(now + 400 * 60000);
    const fsx = await import('node:fs');
    out.state = JSON.parse(fsx.readFileSync(process.env.CONFIG_DIR + '/issue-notify-state.json', 'utf8')).sent;
    out.keys = { x: x.key, t: t.key };
  `);
  assert.equal(out.off, 0, 'SLA 가 꺼져 있으면 보내지 않는다');
  assert.equal(out.keptSla, false);
  assert.equal(out.keepOnNotifySave.j.settings.sla.enabled, true, 'sla 칸 없는 저장(옛 화면)은 SLA 설정을 그대로 둔다');
  assert.equal(out.first, 1, '응답 15분을 넘은 장애 하나(작업 유형은 대상 아님)');
  assert.deepEqual(out.mails.map((m) => m.to).sort(), ['adm@example.com', 'kim@example.com'], '담당자 · 보고자에게');
  for (const m of out.mails) assert.match(m.text, /SLA 응답 목표\(15m\)를 넘었습니다/);
  assert.equal(out.again, 0, '같은 단계는 한 번만');
  assert.equal(out.resolve, 1, '해결 240분을 넘으면 해결 단계 한 번');
  assert.deepEqual(out.listSla, [], '지금 시각 기준 검색식 sla = 초과 — 아직 넘지 않았다');
  assert.equal(out.card.state, 'running');
  assert.equal(Object.keys(out.state).filter((k) => k.startsWith('sla:')).length, 0, '완료하면 SLA 기록을 지운다(다시 열려 넘으면 다시 알린다)');
});
