/**
 * uemcliPromptLoop2539.test.js — 인증서 프롬프트 자동응답 **에코 루프** 회귀 고정(v2.539).
 *
 * 사용자 신고(2026-09-17, Unity OC2-41.237): "지금 파싱이 안되, 처음에는 됐었는데" — 화면은
 * `uemcli 출력 파싱 실패 — 출력 형식이 예상과 다릅니다` + `accounts: 예산 초과`.
 *
 * 실제 원인(실측): `PROMPT_RULES.certAccept.re` 가 우리가 쓴 응답 `1\n` 의 **pty 에코** 뒤에도, 실제 출력이
 * 400자 쌓이기 전에도 계속 매치했다 → data 이벤트마다 `1\n` 을 다시 씀 → `maxAnswers`(400) 에서 `kill()`.
 * 진짜 출력은 오지 않거나 잘렸고, 파서는 배너만 보고 **형식 탓**을 했다. 400회 × RTT 가 예산도 먹었다.
 * v2.526~2.530 의 순서 뒤집기 세 번이 전부 실패한 이유이기도 하다 — 순서가 아니라 이 루프였다.
 * `execAnswered` 를 실제로 돌리는 테스트가 없어서 못 잡았다. 여기서는 **pty 를 흉내 내는 가짜 스트림**
 * (쓰면 에코한다)으로 재현한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execAnswered, PROMPT_RULES } from '../src/proxy/sshExec.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'uemcli-pool-detail.txt'), 'utf8');
const BANNER_END = FIXTURE.indexOf('Please input your selection');
const PROMPT_LINE = FIXTURE.slice(BANNER_END, FIXTURE.indexOf('\n', BANNER_END)).replace(/\s*1$/, ''); // 캡처의 ' 1' 은 사용자가 친 값
const BANNER = FIXTURE.slice(0, BANNER_END) + PROMPT_LINE;                    // 프롬프트에서 멈춘 상태
const BODY = FIXTURE.slice(FIXTURE.indexOf('\n', BANNER_END) + 1);            // 실제 출력(첫 레코드부터)

/**
 * pty 흉내: 배너를 조각내어 보내고 프롬프트에서 멈춘다. `write()` 가 오면 **에코**를 돌려주고,
 * 첫 응답 뒤 `delayMs` 후에 실제 출력을 조각내어 보내고 닫는다. 응답 횟수를 센다.
 */
function fakeConn({ delayMs = 40, echo = true } = {}) {
  const stats = { writes: 0 };
  return {
    stats,
    exec(_cmd, _opts, cb) {
      const st = new EventEmitter();
      st.stderr = new EventEmitter();
      let answered = false;
      st.write = (data) => {
        stats.writes += 1;
        if (echo) setImmediate(() => st.emit('data', Buffer.from(String(data).replace('\n', '\r\n'))));
        if (answered) return; answered = true;
        setTimeout(() => {
          for (let i = 0; i < BODY.length; i += 90) st.emit('data', Buffer.from(BODY.slice(i, i + 90).replace(/\n/g, '\r\n')));
          st.emit('close', 0);
        }, delayMs);
      };
      st.close = () => { st.emit('close', null); };
      st.destroy = () => {};
      cb(null, st);
      // 배너를 3조각으로
      const parts = [BANNER.slice(0, 120), BANNER.slice(120, 300), BANNER.slice(300)];
      let i = 0;
      const tick = () => { if (i < parts.length) { st.emit('data', Buffer.from(parts[i++].replace(/\n/g, '\r\n'))); setImmediate(tick); } };
      setImmediate(tick);
    },
  };
}

test('★ 프롬프트에는 정확히 1번만 답한다 — 우리 응답의 에코로 다시 답하지 않는다', async () => {
  const conn = fakeConn({ delayMs: 60 });
  const r = await execAnswered(conn, 'uemcli /stor/config/pool show -detail', { rules: ['certAccept', 'pager'], timeoutMs: 5000, maxAnswers: 400 });
  assert.equal(conn.stats.writes, 1, `응답을 ${conn.stats.writes}번 썼다 — 에코 루프`);
  assert.equal(r.answers.certAccept, 1);
  assert.equal(r.truncated, false, 'kill 되면 안 된다');
  assert.ok(r.stdout.includes('Total space'), '실제 출력이 와야 한다');
  assert.ok(r.stdout.includes('Current allocation'));
});

test('★ 에코 루프가 있었으면 상한(maxAnswers)에서 죽어 실제 출력을 잃는다 — 규칙 자체는 여전히 그 위험을 가진다(실증)', () => {
  // 정규식은 바뀌지 않았다(실장비에서 프롬프트와 데이터가 같은 줄에 붙어 와 좁힐 수 없다 — v2.526).
  // 그래서 방어는 `execAnswered` 의 '마지막 응답 이후 새 출력만 보기' 다. 이 테스트는 그 전제(정규식이
  // 에코 뒤에도 매치한다)를 고정해 둔다 — 누군가 정규식을 좁혀 이 단언이 깨지면 그때 커서 로직을 재검토한다.
  const re = PROMPT_RULES.certAccept.re;
  assert.ok(re.test((BANNER + ' 1\r\n').slice(-400)), '에코 뒤에도 매치한다(전제)');
  assert.ok(re.test((BANNER + ' 1\r\n' + BODY.slice(0, 120)).slice(-400)), '실제 출력 120자 뒤에도 매치한다(전제)');
});

test('페이저처럼 프롬프트가 **새로** 반복되는 경우는 계속 답한다(커서가 과차단하지 않는다)', async () => {
  // --More-- 가 3번 나오는 스트림: 응답할 때마다 다음 페이지 + 새 프롬프트가 온다.
  const stats = { writes: 0 };
  const conn = {
    exec(_c, _o, cb) {
      const st = new EventEmitter(); st.stderr = new EventEmitter(); st.close = () => st.emit('close', null); st.destroy = () => {};
      let page = 0;
      const emitPage = () => { page += 1; st.emit('data', Buffer.from(`line ${page}\r\n` + (page < 4 ? '--More--' : ''))); if (page >= 4) st.emit('close', 0); };
      st.write = () => { stats.writes += 1; setImmediate(emitPage); };
      cb(null, st); setImmediate(emitPage);
    },
  };
  const r = await execAnswered(conn, 'errshow', { rules: ['pager'], timeoutMs: 3000, maxAnswers: 10 });
  assert.equal(stats.writes, 3, `페이저 응답 ${stats.writes}회(3회여야)`);
  assert.equal(r.pages, 3); assert.equal(r.truncated, false);
  assert.ok(r.stdout.includes('line 4'));
});

test('cliSsh 는 끊긴 명령을 원문 옆에 밝히고(ms·answers·truncated) 호출부에 목록으로 돌려준다', async () => {
  const { runCliSession } = await import('../src/storage/collectors/cliSsh.js');
  // withSsh 를 거치지 않도록 sh 를 직접 주입하는 경로가 없으면 소스 계약으로 고정한다.
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'storage', 'collectors', 'cliSsh.js'), 'utf8');
  // ⚠ 줄바꿈에 기대지 말 것 — v2.543 이 `aborted` 를 더하면서 이 객체가 여러 줄이 됐고
  //   한 줄 고정이던 예전 단언이 **서식만 바뀌었는데** 깨졌다. 키 존재로 고정한다.
  assert.match(src, /truncatedKeys\[spec\.key\] = \{/);
  for (const k of ['cmd', 'ms', 'timedOut: !!r.timedOut', 'answers: n', 'bytes:']) {
    assert.ok(src.includes(k), `끊긴 명령 기록에 ${k} 가 없다`);
  }
  assert.match(src, /return \{ out, raw, errors, skipped, truncated: truncatedKeys/);
  assert.match(src, /sample: \(stdout \|\| stderr\)\.slice\(0, RAW_LIMIT\), ms,/, '원문에 소요(ms)를 싣는다');
  assert.equal(typeof runCliSession, 'function');
  const unity = fs.readFileSync(path.join(HERE, '..', 'src', 'storage', 'collectors', 'unitySsh.js'), 'utf8');
  assert.match(unity, /명령 출력이 끊겼습니다\(/, '끊김을 형식 문제와 구분해 말한다');
  assert.match(unity, /snap\.extra\.cliTruncated = truncated/);
});
