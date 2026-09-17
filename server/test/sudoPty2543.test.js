/**
 * sudoPty2543.test.js — Unity SSH 수집이 `[sudo] password for root:` 에서 멈추던 결함(v2.543).
 *
 * ── 무엇이 일어났나(사용자가 직접 재현해 확정) ────────────────────────────────
 * 장비 상세에 세 명령이 **전부** 같은 값으로 실패해 있었다:
 *   `config: 명령 출력이 끊겼습니다(시한 초과 · 자동응답 0회 · 45초 · 26B 수신)`
 * 26 바이트는 `[sudo] password for root: ` 의 길이와 **정확히** 같다.
 *
 * 사용자 단말 실측(같은 계정 `service`·같은 명령·같은 호스트, 차이는 `-tt` 뿐):
 *   ssh    host 'uemcli /stor/config/pool show -detail'  → 정상 출력, 3.737초
 *   ssh -tt host 'uemcli /stor/config/pool show -detail'  → [sudo] password for root: → 정지(Ctrl-C)
 * 즉 **PTY 를 요청하면** 그 계정의 로그인 환경이 sudo 를 부르고, `uemcli` 는 실행조차 되지 않는다.
 * v2.530 이 넣은 `WIDE_PTY`(1000칸)는 **PTY 가 만든 줄바꿈을 PTY 로 막으려던 것**이었다.
 *
 * ── 이 테스트가 고정하는 것 ────────────────────────────────────────────────────
 *  ① sudo 프롬프트를 만나면 **답하지 않고 즉시 끝낸다**(시한 45초를 버리지 않는다)
 *     ⚠ 비밀번호를 자동으로 보내지 않는다 — 장비는 **root** 비밀번호를 묻는데 포탈은 service
 *       계정 것만 갖고 있고, 틀린 값을 반복하면 계정이 잠긴다.
 *  ② 스토리지 CLI 경로는 **PTY 를 요청하지 않는다**(`pty:false`)
 *  ③ 끊긴 명령(`truncated`/`timedOut`/`aborted`)은 **실패**다 — 성공으로 세지도, 그 출력을
 *     명령의 정상 출력으로 저장하지도 않는다(26B 가 저장돼 파서가 '형식 탓' 을 했다)
 *  ④ 중단 사유가 화면(스냅샷 섹션)까지 도달한다
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ABORT_PROMPTS, execAnswered } from '../src/proxy/sshExec.js';
import { commandCut } from '../src/storage/collectors/cliSsh.js';
import { SPECS, buildSnapshot, applyCutInfo } from '../src/storage/collectors/unitySsh.js';

// ⚠ execAnswered 의 시한 타이머는 `unref()` 라 활성 핸들이 없으면 **울리지 않고 프로세스가 먼저
//   끝난다**(CLAUDE.md v2.506 실측). 위 두 테스트가 변이로 멈추면 파일 전체가 '취소' 로 끝나
//   다른 회귀를 가린다 — 파일이 도는 동안만 핸들 하나를 살려 둔다.
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

/** 실장비가 보낸 그 26 바이트(사용자 캡처). 뒤 공백까지 그대로다. */
const SUDO_26 = '[sudo] password for root: ';

// ── ① 프롬프트 판정 ───────────────────────────────────────────────────────────

test('★ sudo 프롬프트를 알아본다 — 26 바이트가 정확히 그 길이다', () => {
  assert.equal(Buffer.byteLength(SUDO_26), 26, '사용자 화면의 `26B 수신` 과 같아야 한다');
  assert.ok(ABORT_PROMPTS.sudoPassword.re.test(SUDO_26));
});

test('계정 이름이 달라도 잡는다 — root 만 하드코딩하지 않는다', () => {
  for (const s of ['[sudo] password for service: ', '[sudo] password for admin:', '[sudo]  password for oper : ']) {
    assert.ok(ABORT_PROMPTS.sudoPassword.re.test(s), `놓쳤다: ${JSON.stringify(s)}`);
  }
});

test('★ 정상 출력·다른 프롬프트를 sudo 로 오인하지 않는다 — 오탐은 수집을 통째로 죽인다', () => {
  const negatives = [
    'Storage system port: 443',               // uemcli 접속 배너
    'Password:',                              // 로그인 프롬프트(SSH 계층이 처리한다)
    '1:    ID = pool_1',                      // uemcli 데이터 줄
    'Please input your selection (The default selection is [1]): ',
    'Enter new password for root:',           // 비밀번호 변경 안내 — sudo 가 아니다
    'The [sudo] password for root is managed by the vault.', // 문장 중간(꼬리가 아니다)
    '--More--',
  ];
  for (const s of negatives) {
    assert.ok(!ABORT_PROMPTS.sudoPassword.re.test(s), `오탐: ${JSON.stringify(s)}`);
  }
});

test('중단 사유가 무엇을·왜 를 말한다(사용자가 조치를 알 수 있어야 한다)', () => {
  const r = ABORT_PROMPTS.sudoPassword.reason;
  assert.match(r, /sudo/);
  assert.match(r, /잠기|잠금/, '계정 잠금 위험을 밝혀야 한다');
  assert.match(r, /응답하지 않습니다|답하지 않습니다/, '자동 응답하지 않는다는 사실을 밝혀야 한다');
});

// ── ② execAnswered 의 실제 동작 ───────────────────────────────────────────────

/** ssh2 conn 흉내 — `exec(cmd, opts, cb)` 로 스트림을 주고, 준 옵션을 기록한다. */
function fakeConn(script) {
  const rec = { opts: null, written: [], killed: false };
  const conn = {
    exec(command, opts, cb) {
      rec.opts = opts;
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.write = (s) => { rec.written.push(String(s)); return true; };
      stream.close = () => { rec.killed = true; };
      stream.destroy = () => { rec.killed = true; };
      cb(null, stream);
      setImmediate(() => script(stream));
    },
  };
  return { conn, rec };
}

test('★ sudo 프롬프트를 만나면 즉시 중단한다 — 시한까지 매달리지 않는다', { timeout: 10_000 }, async () => {
  const { conn, rec } = fakeConn((st) => st.emit('data', Buffer.from(SUDO_26)));
  const t0 = Date.now();
  const r = await execAnswered(conn, 'uemcli /stor/config/pool show -detail', {
    timeoutMs: 45_000, pty: false, rules: ['certAccept', 'pager'],
  });
  const ms = Date.now() - t0;
  assert.equal(r.aborted, 'sudoPassword');
  assert.equal(r.truncated, true, '끊긴 결과로 표시해야 한다');
  assert.ok(!r.timedOut, '시한 초과가 아니다 — 조치가 다르므로 구분해야 한다');
  assert.ok(r.abortReason && r.abortReason.length > 10, '사유를 실어야 한다');
  assert.ok(ms < 3_000, `즉시 끝나야 한다(실제 ${ms}ms) — 45초를 버리면 예산이 통째로 날아간다`);
  assert.ok(rec.killed, '세션 채널을 닫아야 한다(남겨 두면 다음 주기가 두 번째 세션을 연다)');
});

test('★★ sudo 프롬프트에 **아무것도 쓰지 않는다** — 비밀번호 반복 시도는 계정을 잠근다', { timeout: 10_000 }, async () => {
  const { conn, rec } = fakeConn((st) => st.emit('data', Buffer.from(SUDO_26)));
  await execAnswered(conn, 'uemcli x', { timeoutMs: 5_000, pty: false, rules: ['certAccept', 'pager'] });
  assert.deepEqual(rec.written, [], `스트림에 쓴 것이 있다: ${JSON.stringify(rec.written)}`);
});

test('인증서 프롬프트는 그대로 자동 응답한다 — sudo 중단이 다른 규칙을 죽이지 않았다', async () => {
  const { conn, rec } = fakeConn((st) => {
    st.emit('data', Buffer.from('Please input your selection (The default selection is [1]): '));
    setImmediate(() => { st.emit('data', Buffer.from('\n1:  ID = pool_1\n')); st.emit('close', 0); });
  });
  const r = await execAnswered(conn, 'uemcli x', { timeoutMs: 5_000, pty: false, rules: ['certAccept', 'pager'] });
  assert.equal(r.aborted, undefined);
  assert.deepEqual(rec.written, ['1\n'], '이 세션에만 허용하는 [1] 로 답해야 한다(절대 [3] 이 아니다)');
});

test('★ pty:false 가 ssh2 에 그대로 전달된다 — PTY 를 요청하면 그 계정이 sudo 를 부른다', async () => {
  const { conn, rec } = fakeConn((st) => { st.emit('data', Buffer.from('ok\n')); st.emit('close', 0); });
  await execAnswered(conn, 'uemcli x', { timeoutMs: 5_000, pty: false });
  assert.deepEqual(rec.opts, { pty: false }, `ssh2 에 넘긴 옵션: ${JSON.stringify(rec.opts)}`);
});

// ── ③ 끊긴 명령은 실패다 ──────────────────────────────────────────────────────

test('★ commandCut — 시한 초과·응답 상한·중단은 전부 그 후보의 실패다', () => {
  assert.equal(commandCut({ aborted: 'sudoPassword', stdout: SUDO_26 }), true);
  assert.equal(commandCut({ timedOut: true }), true);
  assert.equal(commandCut({ truncated: true }), true);
  assert.equal(commandCut({ stdout: '1:  ID = pool_1' }), false);
  assert.equal(commandCut({}), false);
  assert.equal(commandCut(null), false);
});

test('★★ 끊긴 결과를 성공으로 세지도, 정상 출력으로 저장하지도 않는다(소스 계약)', () => {
  const s = src('storage/collectors/cliSsh.js');
  assert.match(s, /const cut = commandCut\(r\);/, '끊김 판정을 순수 함수로 해야 한다');
  assert.match(s, /const looksError = cut \|\| cliLooksError\(/,
    '끊김이 오류 판정에 들어가야 한다 — 빠지면 26B 가 `✓ 성공` 이 된다');
  // `out[spec.key] = stdout` 이 `if (looksError) { … continue; }` **뒤**에 있어야 한다.
  const iErr = s.indexOf('if (looksError) {');
  const iOut = s.indexOf('out[spec.key] = stdout;');
  assert.ok(iErr > 0 && iOut > iErr,
    '오류 분기보다 뒤에서 저장해야 한다 — 앞이면 sudo 26B 가 명령 출력으로 저장된다');
});

test('★ 스토리지 CLI 경로는 PTY 를 요청하지 않는다 — v2.530 WIDE_PTY 로 되돌리지 말 것', () => {
  const s = src('storage/collectors/cliSsh.js');
  assert.match(s, /execAnswered\(cmd, \{[^}]*pty: false/, 'pty:false 로 호출해야 한다');
  assert.ok(!/pty:\s*true/.test(s), '이 경로에 pty:true 가 있으면 안 된다');
});

// ── ④ 화면까지 도달 ───────────────────────────────────────────────────────────

const DEV = { id: 'u1', name: 'OC2-unity-03', host: '10.0.0.1', type: 'unity' };
const REASON = ABORT_PROMPTS.sudoPassword.reason;
/** 세 명령이 모두 sudo 프롬프트에서 중단된 실제 상황. */
function cutAll() {
  const t = {};
  for (const sp of SPECS) {
    t[sp.key] = { cmd: sp.cmds[0], ms: 1200, timedOut: false, answers: 0, bytes: 26, aborted: 'sudoPassword', abortReason: REASON };
  }
  return t;
}

test('★★ 머리말이 원인을 말한다 — `출력을 읽지 못했습니다` 라는 형식 탓을 남기지 않는다', () => {
  const snap = applyCutInfo(buildSnapshot(DEV, {}, { errors: {}, usedCmds: {} }), cutAll());
  assert.equal(snap.error, REASON, `머리말: ${snap.error}`);
  assert.ok(!/출력을 읽지 못했습니다/.test(snap.error),
    '형식 탓 문구가 맨 위에 남으면 CLI 원문을 펼치기 전에는 원인을 알 수 없다(네 번 헛수정한 원인)');
});

test('★ 섹션 문구는 짧다 — 같은 긴 문단이 화면에 6번 반복되지 않게', () => {
  const snap = applyCutInfo(buildSnapshot(DEV, {}, { errors: {}, usedCmds: {} }), cutAll());
  for (const [k, v] of Object.entries(snap.sections)) {
    if (!/오류/.test(String(v))) continue;
    assert.ok(String(v).length <= 90, `${k} 섹션 문구가 ${String(v).length}자다: ${v}`);
    assert.ok(!String(v).includes(REASON), `${k} 섹션에 긴 사유가 통째로 들어갔다`);
  }
});

test('★ 중단과 시한 초과는 다른 말을 한다 — 조치가 다르다', () => {
  const key = SPECS[0].key; const sect = SPECS[0].section;
  const timed = applyCutInfo(buildSnapshot(DEV, {}, { errors: {}, usedCmds: {} }),
    { [key]: { cmd: 'x', ms: 45000, timedOut: true, answers: 0, bytes: 26 } });
  assert.match(timed.sections[sect], /시한 초과/);
  assert.ok(!/중단/.test(timed.sections[sect]));
  assert.ok(!timed.error || !timed.error.includes(REASON), '시한 초과에 sudo 사유를 붙이지 않는다');

  const abortedSnap = applyCutInfo(buildSnapshot(DEV, {}, { errors: {}, usedCmds: {} }), cutAll());
  assert.match(abortedSnap.sections[sect], /중단/);
  assert.ok(!/시한 초과|자동응답 상한/.test(abortedSnap.sections[sect]));
});

test('★ 파생 섹션(config)이 다른 원인을 말하지 않는다 — 한 화면에서 두 가지 이유가 뜨면 안 된다', () => {
  const snap = applyCutInfo(buildSnapshot(DEV, {}, { errors: {}, usedCmds: {} }), cutAll());
  assert.equal(snap.sections.config, snap.sections.pools,
    `config=${snap.sections.config} / pools=${snap.sections.pools}`);
  assert.ok(!/읽지 못했습니다/.test(snap.sections.config), 'config 에 형식 탓이 남으면 안 된다');
});

test('성공한 섹션은 덮어쓰지 않는다 — 부분 성공을 실패로 만들지 않는다', () => {
  const snap = buildSnapshot(DEV, {}, { errors: {}, usedCmds: {} });
  const sect = SPECS[0].section;
  snap.sections[sect] = 'ok';
  applyCutInfo(snap, cutAll());
  assert.equal(snap.sections[sect], 'ok');
});

test('명령 3개 모두 answered 경로다 — 하나라도 빠지면 그 명령만 PTY 규약 밖이 된다', () => {
  for (const sp of SPECS) assert.ok(sp.answered, `${sp.key}: answered 가 아니다`);
});
