/**
 * rvD_bulletinPersist.test.js — 리뷰 I-05(그룹 D): 게시판·공지의 '수용됨' 과 '저장 완료' 를 구분한다.
 *
 * 고정하는 것(전부 실제 저장 경로 · 실제 api 라우터 · 실제 재시작 — 소스 grep 이 아니다):
 *  ① 파일 입출력 주입(ENOSPC·EACCES·rename 실패) → 변경의 상태가 'failed' 이고 상태 API·응답에 사유 코드·단계·짧은 문구가
 *     실린다 — **절대 경로·오류 원문은 없다**(콘솔 줄에도). 메모리(응답)는 그대로다.
 *  ② 자동 재시도는 **지수 backoff · 횟수 상한**이다 — 상한을 다 쓰면 멈추고 더 시도하지 않는다(무한 루프 금지).
 *  ③ 관리자 '지금 다시 저장' 은 backoff 를 초기화하고 즉시 다시 쓴다 — 복구 뒤 디스크에는 **최신 상태만** 남는다
 *     (실패 중에 지운 글은 되살아나지 않는다). 실패한 쓰기의 tmp 파일은 남지 않는다.
 *  ④ 세대 보호 — 진행 중인 비동기 rename 이 동기 flush 뒤에 커널에 닿아도 옛 본문이 새 본문을 덮지 않는다
 *     (고치기 전: 옛 본문이 남고 상태는 '저장됨' 이라 말했다 — 재현 기록은 보고서).
 *  ⑤ 재시작 — 실패가 종료까지 이어지면 그 변경은 실제로 없다(상태가 'failed' 라 말한 것이 정직했다) ·
 *     복구 후 재시작하면 남아 있다 · 묶음 창 안의 변경은 종료 flush 가 쓴다.
 *  ⑥ 라우트 계약 — 글 작성은 디스크 결과를 기다려 `persist.state` 를 싣는다(정상이면 응답 직후 파일에 있다) ·
 *     사유 코드는 관리자에게만 · `GET /board/persist` 는 로그인 사용자 전부(상세는 관리자만) ·
 *     `POST /board/persist/retry` 는 관리자 + 전체 범위(operator·범위 관리자 403).
 * 자식 프로세스인 이유: config.js 싱글턴이라 CONFIG_DIR 을 다시 못 가리킨다 · 재시작을 실제로 해 본다.
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
const STORE = path.join(SRC, 'bulletin/store.js');

/** 자식 프로세스에서 본문을 돌리고 `@@` 줄의 JSON 을 돌려준다. dir 을 주면 그 CONFIG_DIR 을 이어 쓴다(재시작). */
function child(body, { dir } = {}) {
  const d = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'rvD-bulletin-'));
  const script = `
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = await import(${JSON.stringify(STORE)});
    const DIR = process.env.CONFIG_DIR;
    const boardTitles = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'board.json'), 'utf8')).posts.map((p) => p.title); } catch (e) { return 'ERR:' + e.code; } };
    const noticeTitles = () => { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'notices.json'), 'utf8')).notices.map((p) => p.title); } catch (e) { return 'ERR:' + e.code; } };
    const fsErr = (code, syscall) => { const e = new Error(code + ': injected, ' + syscall + " '" + DIR + "/.board.json.tmp-x'"); e.code = code; e.syscall = syscall; return e; };
    const out = {};
    ${body}
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: d, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', BOARD_MAX_BYTES: '' },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `결과 줄 없음: ${r.stdout}\n${r.stderr}`);
  return { out: JSON.parse(line.slice(2)), dir: d, stderr: r.stderr };
}

test('① 쓰기 실패 주입(ENOSPC) — 상태 failed · 사유 코드만(경로 없음) · 메모리는 그대로 · ② backoff 재시도는 횟수 상한에서 멈춘다', () => {
  const { out, dir, stderr } = child(`
    const RETRY = { max: 3, baseMs: 40, capMs: 200 };
    st._setBulletinIoForTest(null, RETRY);
    st.createPost({ title: 'A', body: 'a' }, 'op');
    out.r0 = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    let attempts = 0;
    st._setBulletinIoForTest({ writeTmp: async () => { attempts++; throw fsErr('ENOSPC', 'write'); } }, RETRY);
    const b = st.createPost({ title: 'B', body: 'b' }, 'op');
    const t0 = Date.now();
    out.r1 = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    out.r1Ms = Date.now() - t0;
    out.status = st.bulletinStoreStatus();
    out.hAdmin = st.bulletinHealth({ admin: true }).board;
    out.hUser = st.bulletinHealth({ admin: false }).board;
    out.memHasB = st.getPost(b.id, 'op').title;
    out.diskAfterFail = boardTitles();
    await sleep(1500);                 // 40 + 80 + 160ms backoff — 상한 3회
    out.attempts = attempts;
    out.hExhausted = st.bulletinHealth({ admin: true }).board;
    await sleep(600);
    out.attemptsLater = attempts;      // 더 늘지 않는다
    out.diskStill = boardTitles();
  `);
  assert.equal(out.r0.state, 'saved', '정상 쓰기는 saved');
  assert.equal(out.r1.state, 'failed', '그 변경을 담은 쓰기가 실패하면 failed 로 끝난다');
  assert.ok(out.r1Ms < 1000, `실패한 쓰기를 기다리던 쪽은 시한(3초)을 다 쓰지 않고 곧바로 끝난다(실제 ${out.r1Ms}ms)`);
  assert.equal(out.memHasB, 'B', '메모리(응답)는 그대로 — 수용됨');
  assert.deepEqual(out.diskAfterFail, ['A'], '디스크에는 아직 없다');
  const f = out.status.files['board.json'];
  assert.equal(f.state, 'failed');
  assert.equal(f.pending, true);
  assert.ok(f.unsaved >= 1, '미저장 변경 수');
  assert.equal(f.lastWriteError.code, 'ENOSPC');
  assert.equal(f.lastWriteError.phase, 'write');
  assert.ok(f.lastWriteError.message && !f.lastWriteError.message.includes('/'), `짧은 문구 — 경로 없음: ${f.lastWriteError.message}`);
  assert.equal(out.status.lastWriteError.file, 'board.json');
  assert.ok(Number.isFinite(f.lastSavedAt), '마지막 저장 완료 시각');
  assert.ok(!JSON.stringify(out.status).includes(dir), '상태 어디에도 CONFIG_DIR 절대 경로가 없다');
  assert.ok(!JSON.stringify(out.hAdmin).includes(dir));
  assert.equal(out.hAdmin.lastWriteError.code, 'ENOSPC');
  assert.ok(Number.isFinite(out.hAdmin.unsavedSince), '미저장 시작 시각');
  assert.equal(out.hUser.state, 'failed');
  assert.equal(out.hUser.lastWriteError, undefined, '관리자가 아니면 사유 코드를 싣지 않는다');
  assert.equal(out.hUser.unsaved, undefined);
  assert.equal(out.attempts, 4, `실패 1회 + 자동 재시도 상한 3회 = 4회여야 한다(실제 ${out.attempts})`);
  assert.equal(out.attemptsLater, 4, '상한을 다 쓰면 더 시도하지 않는다(무한 루프 금지)');
  assert.equal(out.hExhausted.retryExhausted, true);
  assert.equal(out.hExhausted.retrying, false);
  assert.deepEqual(out.diskStill, ['A']);
  const lines = stderr.split('\n').filter((l) => l.includes('[bulletin]'));
  assert.ok(lines.length >= 1, '실패는 콘솔에도 남는다(무음 실패 금지)');
  assert.ok(lines.every((l) => !l.includes(dir)), `콘솔 줄에도 절대 경로를 싣지 않는다: ${lines[0]}`);
  assert.ok(lines.some((l) => l.includes('ENOSPC')), '콘솔 줄은 사유 코드를 싣는다');
});

test('③ 관리자 재시도 — rename 실패(EACCES)는 단계가 rename · tmp 가 남지 않는다 · 복구 뒤 최신 상태만 디스크에 남는다', () => {
  const { out } = child(`
    const RETRY = { max: 2, baseMs: 5000, capMs: 5000 };
    st._setBulletinIoForTest(null, RETRY);
    const a = st.createPost({ title: 'A', body: 'a' }, 'op');
    await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    st._setBulletinIoForTest({ writeTmp: async () => { throw fsErr('ENOSPC', 'write'); } }, RETRY);
    const b = st.createPost({ title: 'B', body: 'b' }, 'op');
    out.rb = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    // 디스크가 계속 거부하는 동안 B 를 지우고 C 를 쓴다 — 최신 상태는 A, C
    st._setBulletinIoForTest({ rename: async () => { throw fsErr('EACCES', 'rename'); } }, RETRY);
    st.deletePost(b.id, 'op');
    st.createPost({ title: 'C', body: 'c' }, 'op');
    out.retry1 = await st.retryBulletinWrites({ maxMs: 2000 });
    out.h1 = st.bulletinHealth({ admin: true }).board;
    out.tmpLeft = fs.readdirSync(DIR).filter((f) => f.includes('.tmp-'));
    out.diskDuring = boardTitles();
    st._setBulletinIoForTest(null, RETRY); // 복구
    out.retry2 = await st.retryBulletinWrites({ maxMs: 2000 });
    out.h2 = st.bulletinHealth({ admin: true }).board;
    out.diskAfter = boardTitles();
    out.retry3 = await st.retryBulletinWrites({ maxMs: 2000 }); // 저장 안 된 것이 없으면 시도하지 않는다
    void a;
  `);
  assert.equal(out.rb.state, 'failed');
  const r1 = out.retry1.find((r) => r.kind === 'board');
  assert.equal(r1.attempted, true);
  assert.equal(r1.state, 'failed');
  assert.equal(r1.code, 'EACCES');
  assert.equal(out.h1.lastWriteError.code, 'EACCES');
  assert.equal(out.h1.lastWriteError.phase, 'rename', 'rename 단계 실패를 구분한다');
  assert.equal(out.h1.failCount, 1, '관리자 재시도는 backoff 를 초기화한다(직전 실패 횟수를 이어 세지 않는다)');
  assert.ok(Number.isFinite(out.h1.nextRetryAt), '초기화 뒤 자동 재시도가 다시 예약된다');
  assert.deepEqual(out.tmpLeft, [], '실패한 쓰기의 tmp 파일이 남지 않는다');
  assert.deepEqual(out.diskDuring, ['A']);
  const r2 = out.retry2.find((r) => r.kind === 'board');
  assert.equal(r2.state, 'saved');
  assert.equal(out.h2.state, 'saved');
  assert.equal(out.h2.unsaved, 0);
  assert.equal(out.h2.lastWriteError, null, '저장되면 실패 표식을 지운다');
  assert.equal(out.h2.retrying, false, '저장되면 예약된 재시도를 지운다');
  assert.deepEqual(out.diskAfter, ['A', 'C'], '복구 뒤 디스크 = 최신 상태(실패 중에 지운 B 는 되살아나지 않는다)');
  assert.equal(out.retry3.find((r) => r.kind === 'board').attempted, false);
});

test('④ 세대 보호 — 진행 중인 비동기 rename 이 동기 flush 뒤에 닿아도 옛 본문이 새 본문을 덮지 않는다', () => {
  const { out } = child(`
    let release; const gate = new Promise((r) => { release = r; });
    let n = 0;
    st._setBulletinIoForTest({ rename: async (a, b) => { if (n++ === 0) await gate; return fs.promises.rename(a, b); } });
    st.createPost({ title: 'OLD', body: 'old' }, 'op');
    const w = st.waitBulletinPersist('board', st.bulletinSeq('board'), { maxMs: 50 }); // 묶음 창을 앞당겨 바로 쓴다
    await sleep(80);                   // 비동기 쓰기가 rename 에서 멈춰 있다
    out.waitWhileHeld = await w;
    st.createPost({ title: 'NEW', body: 'new' }, 'op');
    out.flushed = st.flushBulletinNow().flushed; // 더 새 본문(OLD, NEW)을 동기로 쓴다
    release();                         // 옛 본문의 rename 이 이제 커널에 닿는다
    await st.bulletinIdle();
    await sleep(100);
    out.disk = boardTitles();
    out.h = st.bulletinHealth({ admin: true }).board;
    out.tmpLeft = fs.readdirSync(DIR).filter((f) => f.includes('.tmp-'));
  `);
  assert.equal(out.waitWhileHeld.state, 'pending', '상한 안에 끝나지 않은 쓰기는 pending 으로 답한다(거부하지 않는다)');
  assert.equal(out.flushed, 1);
  assert.deepEqual(out.disk, ['OLD', 'NEW'], '최신 본문만 남는다 — 옛 본문의 늦은 rename 이 덮으면 NEW 가 사라진다');
  assert.equal(out.h.state, 'saved');
  assert.equal(out.h.lastWriteError, null, '대체된 비동기 쓰기의 ENOENT 를 실패로 세지 않는다');
  assert.deepEqual(out.tmpLeft, []);
});

test('⑤ 재시작 — 종료까지 실패하면 그 변경은 없다(상태가 정직했다) · 복구 후 재시작하면 남는다 · 묶음 창 변경은 종료 flush 가 쓴다', () => {
  const first = child(`
    st.createPost({ title: 'KEPT', body: 'k' }, 'op');
    out.k = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    st._setBulletinIoForTest({
      writeTmp: async () => { throw fsErr('ENOSPC', 'write'); },
      writeFileAtomicSync: () => { throw fsErr('ENOSPC', 'write'); },   // 종료 flush 도 실패한다
    }, { max: 1, baseMs: 5000, capMs: 5000 });
    st.createPost({ title: 'LOST', body: 'l' }, 'op');
    out.l = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
  `);
  assert.equal(first.out.k.state, 'saved');
  assert.equal(first.out.l.state, 'failed', '종료 전 상태가 failed 였다');
  assert.ok(first.stderr.includes('flush'), '종료 flush 실패도 콘솔에 남는다');
  const dir = first.dir;
  const second = child(`
    out.titles = st.listPosts({}).rows.map((r) => r.title);
    st._setBulletinIoForTest({ writeTmp: async () => { throw fsErr('EACCES', 'open'); } }, { max: 1, baseMs: 5000, capMs: 5000 });
    st.createPost({ title: 'RECOVERED', body: 'r' }, 'op');
    out.r = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    st._setBulletinIoForTest(null);
    out.retry = await st.retryBulletinWrites({ maxMs: 2000 });
    st.createPost({ title: 'AT-EXIT', body: 'e' }, 'op'); // 기다리지 않는다 — 묶음 창 안에서 종료(종료 flush 가 쓴다)
  `, { dir });
  assert.deepEqual(second.out.titles, ['KEPT'], '재시작 뒤 LOST 는 없다 — 상태가 failed 라 말한 그대로');
  assert.equal(second.out.r.state, 'failed');
  assert.equal(second.out.retry.find((x) => x.kind === 'board').state, 'saved');
  const third = child(`out.titles = st.listPosts({}).rows.map((r) => r.title).sort();`, { dir });
  assert.deepEqual(third.out.titles, ['AT-EXIT', 'KEPT', 'RECOVERED'], '복구 뒤 저장한 글과 종료 flush 가 쓴 글이 재시작 뒤에도 있다');
});

test('⑦ 진행 중 쓰기와 겹칠 때 — 기다리는 중요한 쓰기는 자기 결과를 곧 받고 · 관리자 재시도는 진행 중 쓰기 뒤 한 번만 더 쓴다(단일 비행)', () => {
  const { out } = child(`
    const RETRY = { max: 2, baseMs: 5000, capMs: 5000 };
    let attempts = 0; let concurrent = 0; let maxConcurrent = 0;
    const slowFail = async () => { attempts++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await sleep(150); concurrent--; throw fsErr('ENOSPC', 'write'); };
    st._setBulletinIoForTest({ writeTmp: slowFail }, RETRY);
    st.createPost({ title: 'A', body: 'a' }, 'op');
    const wa = st.waitBulletinPersist('board', st.bulletinSeq('board'));   // 쓰기 시작(150ms 뒤 실패)
    await sleep(30);
    st.createPost({ title: 'B', body: 'b' }, 'op');                          // 진행 중 쓰기가 담지 못한 변경
    const t0 = Date.now();
    out.rb = await st.waitBulletinPersist('board', st.bulletinSeq('board'));
    out.rbMs = Date.now() - t0;
    out.ra = await wa;
    out.attemptsAfterB = attempts;
    // 관리자 재시도 — 진행 중 쓰기 한가운데서 누른다
    st.createPost({ title: 'C', body: 'c' }, 'op');
    st.waitBulletinPersist('board', st.bulletinSeq('board'), { maxMs: 1 });  // 쓰기를 시작시킨다
    await sleep(30);
    const before = attempts;
    out.retry = await st.retryBulletinWrites({ maxMs: 2000 });
    out.retryAttempts = attempts - before;
    out.maxConcurrent = maxConcurrent;
  `);
  assert.equal(out.ra.state, 'failed');
  assert.equal(out.rb.state, 'failed');
  assert.ok(out.rbMs < 1000, `진행 중 쓰기가 실패해도 기다리던 중요한 쓰기는 곧 자기 시도의 결과를 받는다(시한 3초를 다 쓰지 않는다 — 실제 ${out.rbMs}ms)`);
  assert.equal(out.attemptsAfterB, 2, '진행 중 1회 + B 를 담은 1회');
  assert.equal(out.retryAttempts, 1, '재시도는 누르기 전에 시작된 쓰기가 끝난 뒤 새로 한 번만 쓴다(진행 중 쓰기의 urgent 재실행 + 재시도의 실행으로 두 번 쓰지 않는다)');
  assert.equal(out.retry.find((r) => r.kind === 'board').state, 'failed');
  assert.equal(out.maxConcurrent, 1, '같은 파일을 동시에 두 번 쓰지 않는다');
});

/** 실제 api 라우터 하니스(bulletin2722 과 같은 모양). */
function runApi(body) {
  return child(`
    const express = (await import('express')).default;
    const { api } = await import(${JSON.stringify(path.join(SRC, 'routes/api.js'))});
    const app = express();
    app.use(express.json());
    let who = { username: 'adm', role: 'admin', scope: null };
    app.use((req, _res, next) => { req.user = who; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port + '/api';
    const as = (u) => { who = u; };
    const ADM = { username: 'adm', role: 'admin', scope: null };
    const OP = { username: 'op', role: 'operator', scope: null };
    const VIEW = { username: 'v', role: 'viewer', scope: null };
    const SADM = { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-1'] } };
    const DEMO = { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true };
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
      return { s: r.status, j, t };
    };
    ${body}
    srv.close();
  `);
}

test('⑥ 라우트 계약 — 작성은 디스크 결과를 기다려 싣는다 · 사유 코드는 관리자만 · 상태 조회는 로그인 사용자 전부 · 재시도는 관리자+전체 범위', () => {
  const { out, dir } = runApi(`
    const RETRY = { max: 2, baseMs: 5000, capMs: 5000 };
    st._setBulletinIoForTest(null, RETRY);
    as(OP);
    out.ok = await call('POST', '/board/posts', { title: '정상', body: 'x' });
    out.diskRightAfter = boardTitles();                       // 기다리지 않고 바로 읽는다
    st._setBulletinIoForTest({ writeTmp: async () => { throw fsErr('ENOSPC', 'write'); } }, RETRY);
    out.opFail = await call('POST', '/board/posts', { title: '운영자 글', body: 'x' });
    const pid = out.opFail.j.post.id;
    as(ADM);
    out.admFail = await call('POST', '/board/posts', { title: '관리자 글', body: 'y' });
    as(OP);
    out.like = await call('POST', '/board/posts/' + pid + '/like', { on: true });
    out.comment = await call('POST', '/board/posts/' + pid + '/comments', { body: '댓글' });
    out.list = await call('GET', '/board/posts');
    as(VIEW); out.pView = await call('GET', '/board/persist');
    as(OP); out.pOp = await call('GET', '/board/persist');
    as(ADM); out.pAdm = await call('GET', '/board/persist');
    as(SADM); out.pSadm = await call('GET', '/board/persist');
    as(OP); out.retryOp = await call('POST', '/board/persist/retry');
    as(SADM); out.retrySadm = await call('POST', '/board/persist/retry');
    as(DEMO); out.pDemo = await call('GET', '/board/persist'); out.retryDemo = await call('POST', '/board/persist/retry');
    as(ADM); out.retryFail = await call('POST', '/board/persist/retry');
    out.noticeFail = await call('POST', '/notices', { title: '공지', body: 'n' });
    out.noticeList = await call('GET', '/notices');
    st._setBulletinIoForTest(null, RETRY);                     // 디스크 복구
    out.retryOk = await call('POST', '/board/persist/retry');
    out.pAfter = await call('GET', '/board/persist');
    out.diskAfter = boardTitles();
    out.noticesAfter = noticeTitles();
    out.delOk = await call('DELETE', '/board/posts/' + pid);
    out.diskAfterDel = boardTitles();
  `);
  assert.equal(out.ok.s, 200);
  assert.equal(out.ok.j.persist.state, 'saved', '정상이면 저장까지 확인하고 답한다');
  assert.deepEqual(out.diskRightAfter, ['정상'], '응답 직후 디스크에 있다(bounded flush 확인)');
  assert.equal(out.opFail.s, 200, '디스크 실패는 5xx 가 아니다 — 변경은 받아들여졌다');
  assert.equal(out.opFail.j.persist.state, 'failed');
  assert.equal(out.opFail.j.persist.error, undefined, '운영자에게는 사유 코드를 싣지 않는다');
  assert.equal(out.admFail.j.persist.state, 'failed');
  assert.equal(out.admFail.j.persist.error.code, 'ENOSPC');
  assert.equal(out.admFail.j.persist.error.phase, 'write');
  assert.equal(out.like.s, 200);
  assert.equal(out.like.j.persist.state, 'failed', '저장소가 실패 중이면 공감도 failed 다');
  assert.equal(out.comment.j.persist.state, 'failed');
  assert.equal(out.list.j.persist.state, 'failed', '목록 응답이 저장소 상태를 싣는다(화면 경고가 남는다)');
  for (const k of ['pView', 'pOp']) {
    assert.equal(out[k].s, 200, k);
    assert.equal(out[k].j.stores.board.state, 'failed', k);
    assert.equal(out[k].j.stores.board.lastWriteError, undefined, k + ' — 상세는 관리자만');
    assert.equal(out[k].j.stores.board.unsaved, undefined, k);
    assert.equal(out[k].j.canRetry, false, k);
  }
  assert.equal(out.pAdm.j.admin, true);
  assert.equal(out.pAdm.j.canRetry, true);
  assert.equal(out.pAdm.j.stores.board.lastWriteError.code, 'ENOSPC');
  assert.ok(out.pAdm.j.stores.board.unsaved >= 3, `미저장 변경 수(실제 ${out.pAdm.j.stores.board.unsaved})`);
  assert.ok(Number.isFinite(out.pAdm.j.stores.board.lastSavedAt));
  assert.ok(!out.pAdm.t.includes(dir), '관리자 상세에도 절대 경로가 없다');
  assert.ok(!out.admFail.t.includes(dir));
  assert.equal(out.pSadm.j.stores.board.lastWriteError.code, 'ENOSPC', '범위 관리자도 상태 상세는 본다(포탈 공용 저장소의 상태)');
  assert.equal(out.pSadm.j.canRetry, false, '범위 관리자는 다시 저장을 누를 수 없다');
  assert.equal(out.retryOp.s, 403, 'operator 는 다시 저장 403');
  assert.equal(out.retrySadm.s, 403, '범위 관리자는 다시 저장 403');
  assert.equal(out.pDemo.j.admin, false, '데모 계정(mock 의 admin 문맥)에는 관리자 상세를 싣지 않는다');
  assert.equal(out.pDemo.j.stores.board.lastWriteError, undefined);
  assert.equal(out.retryDemo.s, 403, '데모 계정은 다시 저장 403(authMiddleware 밖에서도)');
  assert.equal(out.retryFail.s, 200);
  assert.equal(out.retryFail.j.result.find((r) => r.kind === 'board').state, 'failed', '아직 실패 중이면 그대로 말한다');
  assert.equal(out.noticeFail.j.persist.state, 'failed', '공지도 같은 계약');
  assert.equal(out.noticeList.j.persist.state, 'failed');
  assert.equal(out.noticeList.j.persist.lastWriteError.code, 'ENOSPC');
  assert.equal(out.retryOk.s, 200);
  for (const r of out.retryOk.j.result) assert.equal(r.state, 'saved', `${r.kind} 복구 뒤 saved`);
  assert.equal(out.pAfter.j.stores.board.state, 'saved');
  assert.equal(out.pAfter.j.stores.notices.state, 'saved');
  assert.deepEqual(out.diskAfter, ['정상', '운영자 글', '관리자 글']);
  assert.deepEqual(out.noticesAfter, ['공지']);
  assert.equal(out.delOk.j.persist.state, 'saved');
  assert.deepEqual(out.diskAfterDel, ['정상', '관리자 글']);
});
