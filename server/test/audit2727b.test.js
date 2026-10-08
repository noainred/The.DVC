/**
 * audit2727b.test.js — v2.727 감사 그룹 2(게시판·공지·로그인 정책 파일) 회귀.
 *
 * 고정하는 것:
 *  ① B-01/F-02 게시판 쓰기는 디바운스·비동기 — 공감 100회 연타에 실제 파일 쓰기는 1~2회이고, 끝난 뒤 파일 내용은 캐시와 같다(들여쓰기 없음).
 *     flushBulletinNow() 는 대기분을 즉시 동기로 쓴다 · 종료 flush 가 exitFlush 레지스트리에 등록돼 있다 · 쓰기 실패는 상태에 남는다.
 *  ② B-01 합계 상한 — 넘기는 글 작성·댓글은 409 `board-full`(bytes·max 동봉)이고 저장되지 않는다. 공감·삭제는 막지 않는다.
 *     env BOARD_MAX_BYTES 는 빈 값·0 이면 기본값, 하한 64KB.
 *  ③ B-04 공지 응답의 작성·수정자 계정명은 admin 에게만 · B-06 데모 계정은 isAdmin·canWrite·canEdit 가 false.
 *  ④ B-07 board.json·notices.json 은 변경 감시 지문에서 빠지고(글마다 change 백업 금지) 백업 번들에는 들어가며 archScan 분류 목록에 있다.
 *  ⑤ B-08 setFileLoginPolicy 는 같은 줄의 인라인 주석을 보존한다.
 * ①②⑤ 는 자식 프로세스(config.js 싱글턴이라 CONFIG_DIR 을 다시 못 가리킨다) · ③ 은 실제 api 라우터(v2.536 규약) · ④ 는 순수 함수.
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

/** 자식 프로세스에서 모듈 코드를 돌리고 `@@` 줄의 JSON 을 돌려준다. */
function child(body, { env = {}, pre } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2727b-'));
  if (pre) pre(dir);
  const script = `
    const fs = (await import('node:fs')).default;
    const { performance } = await import('node:perf_hooks');
    const out = {};
    ${body}
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'true', BOARD_MAX_BYTES: '', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  return { out: JSON.parse(line.slice(2)), dir, stderr: r.stderr };
}

/** 실제 api 라우터 하니스(bulletin2722 과 같은 모양). */
function runApi(body, { env = {} } = {}) {
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
    const call = async (m, p, b) => {
      const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      let j = null; try { j = await r.json(); } catch {}
      return { s: r.status, j };
    };
    ${body}
    srv.close();
  `, { env });
}

test('① 공감 100회 연타 = 실제 파일 쓰기 1~2회 · flush 뒤 파일 = 캐시(들여쓰기 없음) · 종료 flush 등록 · 실패는 상태에 남는다', () => {
  const { out, dir } = child(`
    const st = await import(${JSON.stringify(STORE)});
    const { exitFlushNames } = await import(${JSON.stringify(path.join(SRC, 'util/exitFlush.js'))});
    out.exitRegistered = exitFlushNames().includes('bulletin/store');
    const p = st.createPost({ title: '글', body: '본문' }, 'op');
    await st.bulletinIdle();
    const w0 = st.bulletinStoreStatus().files['board.json'].writes;
    out.writesAfterCreate = w0;
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) st.setLike(p.id, null, 'u' + i, true);
    out.likeMs = performance.now() - t0;
    out.pendingRightAfter = st.bulletinStoreStatus().files['board.json'].pending;
    out.idle = await st.bulletinIdle();
    const s1 = st.bulletinStoreStatus();
    out.writesDelta = s1.files['board.json'].writes - w0;
    out.pendingAfterIdle = s1.files['board.json'].pending;
    out.lastWriteError = s1.lastWriteError;
    const raw = fs.readFileSync(process.env.CONFIG_DIR + '/board.json', 'utf8');
    out.compact = !raw.includes('\\n ');
    out.fileLikes = JSON.parse(raw).posts[0].likes.length;
    out.bytesMatches = s1.files['board.json'].bytes === Buffer.byteLength(raw, 'utf8');
    // flushBulletinNow: 대기분을 기다리지 않고 지금 쓴다
    st.setLike(p.id, null, 'late', true);
    out.flushed = st.flushBulletinNow().flushed;
    out.fileLikesAfterFlush = JSON.parse(fs.readFileSync(process.env.CONFIG_DIR + '/board.json', 'utf8')).posts[0].likes.length;
    out.pendingAfterFlush = st.bulletinStoreStatus().files['board.json'].pending;
    // 쓰기 실패 — 파일 자리를 디렉터리로 막아 rename 이 실패하게 한다(무음 실패 금지 · 캐시는 그대로 · 다음 변경 때 다시 쓴다)
    const file = process.env.CONFIG_DIR + '/board.json';
    fs.rmSync(file); fs.mkdirSync(file);
    st.setLike(p.id, null, 'fail1', true);
    await st.bulletinIdle();
    const s2 = st.bulletinStoreStatus();
    out.failRecorded = !!(s2.lastWriteError && s2.lastWriteError.file === 'board.json' && s2.lastWriteError.message);
    out.failPending = s2.files['board.json'].pending;
    out.cacheKept = st.getPost(p.id, 'op').likeCount;
    fs.rmdirSync(file);
    st.setLike(p.id, null, 'fail2', true);          // 다음 변경이 다시 쓴다
    await st.bulletinIdle();
    const s3 = st.bulletinStoreStatus();
    out.recovered = s3.lastWriteError == null && JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].likes.length;
  `);
  void dir;
  assert.equal(out.exitRegistered, true, 'util/exitFlush.js 에 등록돼 종료 때 대기분을 동기로 쓴다(v2.582 규약)');
  assert.ok(out.writesAfterCreate >= 1, '첫 글은 실제로 쓰였다');
  assert.equal(out.pendingRightAfter, true, '연타 직후에는 대기 중이다(즉시 쓰지 않는다)');
  assert.equal(out.idle, true);
  assert.ok(out.writesDelta >= 1 && out.writesDelta <= 2, `공감 100회에 실제 쓰기는 1~2회여야 한다(실제 ${out.writesDelta})`);
  assert.ok(out.likeMs < 200, `공감 100회가 ${out.likeMs.toFixed(1)}ms — 요청 경로에서 파일을 쓰고 있다`);
  assert.equal(out.pendingAfterIdle, false);
  assert.equal(out.lastWriteError, null);
  assert.equal(out.compact, true, 'JSON.stringify 들여쓰기를 쓰지 않는다(크기 약 30%)');
  assert.equal(out.fileLikes, 100, 'flush 뒤 파일 내용 = 캐시');
  assert.equal(out.bytesMatches, true, '실제 쓰기 뒤 추정 크기는 파일 크기로 다시 맞춘다');
  assert.equal(out.flushed, 1);
  assert.equal(out.fileLikesAfterFlush, 101, 'flushBulletinNow 는 대기분을 즉시 쓴다');
  assert.equal(out.pendingAfterFlush, false);
  assert.equal(out.failRecorded, true, '쓰기 실패는 bulletinStoreStatus().lastWriteError 에 남는다(무음 실패 금지)');
  assert.equal(out.failPending, true, '실패한 변경은 대기분으로 남는다(캐시를 잃지 않는다)');
  assert.equal(out.cacheKept, 102, '실패해도 캐시(응답)는 그대로다');
  assert.equal(out.recovered, 103, '다음 변경 때 다시 쓰고 실패 표식을 지운다');
});

test('② 합계 상한 — 넘기는 글·댓글은 409 board-full(bytes·max)이고 저장되지 않는다 · 공감·삭제는 막지 않는다 · env 규칙', () => {
  const { out } = runApi(`
    as({ username: 'op', role: 'operator', scope: null });
    const big = 'x'.repeat(9000);
    let full = null; let n = 0;
    for (; n < 40; n++) {
      const r = await call('POST', '/board/posts', { title: '글 ' + n, body: big });
      if (r.s !== 200) { full = r; break; }
    }
    out.postsBeforeFull = n; out.full = full;
    const list = (await call('GET', '/board/posts')).j;
    out.listCount = list.all;
    const first = list.rows[list.rows.length - 1].id;
    out.commentFull = await call('POST', '/board/posts/' + first + '/comments', { body: 'y'.repeat(1500) });
    out.likeOk = await call('POST', '/board/posts/' + first + '/like', { on: true });
    out.pinOk = (await (async () => { as({ username: 'adm', role: 'admin', scope: null }); const r = await call('PUT', '/board/posts/' + first, { pinned: true }); as({ username: 'op', role: 'operator', scope: null }); return r; })());
    out.shrinkOk = await call('PUT', '/board/posts/' + first, { body: '짧게' });
    out.delOk = await call('DELETE', '/board/posts/' + list.rows[0].id);
    out.afterDel = await call('POST', '/board/posts', { title: '다시', body: 'small' });
    const st = await import(${JSON.stringify(STORE)});
    await st.bulletinIdle();
    out.listAfter = (await call('GET', '/board/posts')).j.all;
    out.fileCount = JSON.parse(fs.readFileSync(process.env.CONFIG_DIR + '/board.json', 'utf8')).posts.length;
    out.max = st.boardMaxBytes();
    process.env.BOARD_MAX_BYTES = ''; out.envEmpty = st.boardMaxBytes();
    process.env.BOARD_MAX_BYTES = '0'; out.envZero = st.boardMaxBytes();
    process.env.BOARD_MAX_BYTES = '100'; out.envTiny = st.boardMaxBytes();
    process.env.BOARD_MAX_BYTES = 'abc'; out.envBad = st.boardMaxBytes();
    process.env.BOARD_MAX_BYTES = '33554432'; out.env32 = st.boardMaxBytes();
  `, { env: { BOARD_MAX_BYTES: '65536' } });
  assert.equal(out.max, 65536);
  assert.ok(out.postsBeforeFull >= 5 && out.postsBeforeFull <= 7, `64KB 상한에 9KB 글은 5~7개 들어간다(실제 ${out.postsBeforeFull})`);
  assert.equal(out.full.s, 409);
  assert.equal(out.full.j.reason, 'board-full', '사유 코드 — 문장은 웹이 만든다');
  assert.equal(out.full.j.max, 65536);
  assert.ok(Number.isFinite(out.full.j.bytes) && out.full.j.bytes > 0 && out.full.j.bytes <= 65536, `bytes 는 지금 추정 크기(${out.full.j.bytes})`);
  assert.equal(out.listCount, out.postsBeforeFull, '거부된 글은 저장되지 않았다');
  assert.equal(out.commentFull.s, 409, '댓글도 상한을 본다');
  assert.equal(out.commentFull.j.reason, 'board-full');
  assert.equal(out.likeOk.s, 200, '공감은 상한과 무관');
  assert.equal(out.pinOk.s, 200, '고정은 상한과 무관');
  assert.equal(out.shrinkOk.s, 200, '줄이는 수정은 막지 않는다');
  assert.equal(out.delOk.s, 200, '삭제는 상한과 무관');
  assert.equal(out.afterDel.s, 200, '지운 뒤에는 다시 쓸 수 있다');
  assert.equal(out.listAfter, out.postsBeforeFull, '지운 1 + 새 글 1');
  assert.equal(out.fileCount, out.listAfter, '파일 = 캐시');
  assert.equal(out.envEmpty, 16 * 1024 * 1024, 'BOARD_MAX_BYTES= 빈 값은 미지정(v2.618 BUG-1 규약)');
  assert.equal(out.envZero, 16 * 1024 * 1024, '0 은 상한 없음이 아니라 기본값');
  assert.equal(out.envTiny, 65536, '하한 64KB');
  assert.equal(out.envBad, 16 * 1024 * 1024);
  assert.equal(out.env32, 33554432);
});

test('③ B-04 작성·수정자 계정명은 admin 에게만 · B-06 데모 계정은 isAdmin·canWrite·canEdit 가 false', () => {
  const { out } = runApi(`
    out.create = await call('POST', '/notices', { title: '점검', body: 'b', level: 'warn' });
    out.admList = await call('GET', '/notices');
    out.admActive = await call('GET', '/notices/active');
    as({ username: 'v', role: 'viewer', scope: null });
    out.vList = await call('GET', '/notices');
    out.vActive = await call('GET', '/notices/active');
    as({ username: 'op', role: 'operator', scope: null });
    out.opList = await call('GET', '/notices');
    out.opBoard = await call('GET', '/board/posts');
    as({ username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true });
    out.demoList = await call('GET', '/notices');
    out.demoActive = await call('GET', '/notices/active');
    out.demoBoard = await call('GET', '/board/posts');
    as({ username: 'adm', role: 'admin', scope: null });
    out.admBoard = await call('GET', '/board/posts');
  `);
  assert.equal(out.create.s, 200);
  const keys = (n) => Object.keys(n).sort();
  assert.ok(keys(out.admList.j.notices[0]).includes('createdBy') && keys(out.admList.j.notices[0]).includes('updatedBy'), 'admin 은 작성·수정자를 본다');
  assert.equal(out.admActive.j.notices[0].by, 'adm');
  assert.equal(out.admList.j.canEdit, true);
  for (const [name, r] of [['viewer', out.vList], ['operator', out.opList], ['demo', out.demoList]]) {
    assert.equal(r.s, 200, `${name} 도 목록은 본다(게시판 › 공지 탭)`);
    assert.equal(r.j.notices.length, 1);
    assert.ok(!('createdBy' in r.j.notices[0]) && !('updatedBy' in r.j.notices[0]), `${name} 응답에 관리자 계정명이 없다: ${keys(r.j.notices[0])}`);
    assert.equal(r.j.notices[0].title, '점검', '제목·본문은 그대로');
    assert.equal(r.j.canEdit, false);
  }
  assert.equal(out.vActive.j.notices[0].by, '', 'viewer 팝업에는 게시자 계정명이 없다');
  assert.equal(out.demoActive.j.notices[0].by, '');
  assert.equal(out.opBoard.j.canWrite, true, 'operator 는 글을 쓴다(그대로)');
  assert.equal(out.opBoard.j.isAdmin, false);
  assert.equal(out.demoBoard.j.canWrite, false, 'B-06: 데모 계정은 쓰기 버튼을 보지 않는다(서버가 403 할 것을 화면이 먼저 안다)');
  assert.equal(out.demoBoard.j.isAdmin, false);
  assert.equal(out.admBoard.j.isAdmin, true);
});

test('④ B-07 board.json·notices.json — 변경 감시 지문에서 빠지고 · 백업 번들에는 들어가며 · archScan 분류 목록에 있다', async () => {
  const svc = await import('../src/backup/service.js');
  const A = await import('../src/portalcheck/archScan.js');
  const base = { 'vcenters.json': '[{"id":"a"}]', 'board.json': '{"posts":[]}', 'notices.json': '{"notices":[]}' };
  const fp1 = svc.settingsFingerprint(base);
  const fp2 = svc.settingsFingerprint({ ...base, 'board.json': '{"posts":[{"id":"x"}]}', 'notices.json': '{"notices":[{"id":"n"}]}' });
  const fp3 = svc.settingsFingerprint({ ...base, 'vcenters.json': '[{"id":"b"}]' });
  assert.equal(fp1, fp2, '글·공지가 바뀌어도 설정 지문은 같다 — change 백업이 생기지 않는다');
  assert.notEqual(fp1, fp3, '설정이 바뀌면 지문이 바뀐다(예전 그대로)');
  for (const n of ['board.json', 'notices.json']) {
    assert.equal(svc.isChangeWatchExcluded(n), true);
    assert.equal(svc.isRuntimeStateFile(n), false, `${n} 은 상태 파일이 아니다 — 백업 번들·엣지 설정 push 대상에서 빼지 않는다`);
    assert.ok(typeof A.KNOWN_CONFIG_FILES[n] === 'string' && A.KNOWN_CONFIG_FILES[n].length > 5, `archScan KNOWN_CONFIG_FILES 에 ${n} 등재`);
  }
  assert.equal(svc.isChangeWatchExcluded('vcenters.json'), false);
  // 번들에는 들어간다 — collectConfigDir 가 두 파일을 싣는다
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2727b-bundle-'));
  fs.writeFileSync(path.join(dir, 'board.json'), '{"posts":[]}');
  fs.writeFileSync(path.join(dir, 'notices.json'), '{"notices":[]}');
  const got = svc.collectConfigDir(dir);
  assert.ok('board.json' in got && 'notices.json' in got, '백업 번들에 두 파일이 들어간다(사용자 데이터 — 복원 대상)');
});

test('⑤ B-08 setFileLoginPolicy 는 같은 줄의 인라인 주석을 보존한다(다른 줄·독립 주석·빈 줄도 그대로)', () => {
  const { out } = child(`
    const sec = await import(${JSON.stringify(path.join(SRC, 'security/securitySettings.js'))});
    const f = process.env.CONFIG_DIR + '/login-policy-users.txt';
    fs.writeFileSync(f, '# 머리 주석\\nalice=otp # 담당자 메모\\n\\nbob = both\\n');
    out.r1 = sec.setFileLoginPolicy('alice', 'password');
    out.text1 = fs.readFileSync(f, 'utf8');
    out.eff1 = sec.loginPolicyOverrideOf('alice').file;
    out.r2 = sec.setFileLoginPolicy('bob', 'otp');
    out.text2 = fs.readFileSync(f, 'utf8');
    out.r3 = sec.setFileLoginPolicy('alice', null);
    out.text3 = fs.readFileSync(f, 'utf8');
  `);
  assert.equal(out.r1.ok, true);
  assert.equal(out.text1, '# 머리 주석\nalice=password_only # 담당자 메모\n\nbob = both\n', '인라인 주석 보존 · 다른 줄 불변');
  assert.equal(out.eff1, 'password_only', '주석이 붙어도 읽힌다');
  assert.equal(out.text2, '# 머리 주석\nalice=password_only # 담당자 메모\n\nbob=otp_only\n', '주석 없는 줄은 예전처럼');
  assert.equal(out.text3, '# 머리 주석\n\nbob=otp_only\n', '재정의 삭제는 그 줄만(주석째) 지운다');
});
