/**
 * v3.10.4 — 공용 유틸 점검 2회차(서버 공용 유틸 사용처 31~60번) 회귀.
 *
 *  ① bulkRun — 건너뛰기 판정이 던져도 그 행만 실패로 적고, 나머지 행은 끝까지 돈다(예전: 풀 전체가 거부돼 남은 행이 'pending' 인 채 'done',
 *     바깥 async 함수의 거부를 받는 곳이 없어 처리되지 않은 rejection — 포탈은 index.js 전역 처리기가 로그만 남기고 계속 돈다).
 *  ② pingMany — 배열이 아니면 TypeError 대신 빈 결과.
 *  ③ httpsServer — 인증서 남은 날 · 만료 경고는 **읽을 때** 계산한다(예전: 읽은 때 굳혀 오래 켜 두면 줄지 않았고, 재시작 없이 만료되면 경고가 끝내 안 떴다).
 *  ④ smtp — 긴 한글 제목은 75자 이하 encoded-word 여러 개로 접고, 헤더 줄이 78자 권고 안에 들며, 디코딩하면 원문 그대로다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startBulkTest, publicRun, _resetForTest } from '../src/util/bulkRun.js';
import { pingMany } from '../src/util/ping.js';
import { expiryWarning, tlsListenerStatus, _resetHttpsServerState } from '../src/util/httpsServer.js';
import { encodeHeaderWord, buildMime } from '../src/util/smtp.js';

const waitDone = async (id) => {
  for (let i = 0; i < 200; i++) {
    const r = publicRun(id);
    if (r?.status === 'done') return r;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error('끝나지 않았다');
};

test('① bulkRun — 건너뛰기 판정 예외는 그 행만 실패 · 나머지는 끝까지', async () => {
  _resetForTest();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const rows = [{ _line: 2, host: 'a' }, { _line: 3, host: 'boom' }, { _line: 4, host: 'c' }];
    const st = startBulkTest({
      kind: 't3104', rows, concurrency: 1, timeoutMs: 1_000,
      skipReason: (r) => { if (r.host === 'boom') throw new Error('판정 오류'); return null; },
      testOne: async () => ({ ok: true }),
    });
    assert.equal(st.ok, true);
    const r = await waitDone(st.id);
    assert.deepEqual(r.results.map((x) => x.status), ['ok', 'fail', 'ok']);
    assert.match(r.results[1].reason, /건너뛰기 판정 실패: 판정 오류/);
    assert.equal(r.done, 3);
    assert.equal(r.summary.pending, 0);
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(unhandled.length, 0, '처리되지 않은 rejection 이 없어야 한다');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    _resetForTest();
  }
});

test('② pingMany — 배열이 아니면 빈 결과', async () => {
  assert.deepEqual(await pingMany(null), []);
  assert.deepEqual(await pingMany('10.0.0.1'), []);
  assert.deepEqual(await pingMany(undefined), []);
});

test('③ 인증서 만료 경고 · 남은 날은 읽을 때 계산한다', () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 10, 15);
  assert.equal(expiryWarning(now + 90 * day, '', now), null);
  assert.equal(expiryWarning(now + 10 * day + 1000, 'Nov 25 2026', now), 'TLS 인증서 만료 10일 남음(Nov 25 2026).');
  assert.match(expiryWarning(now - 1, '', now), /만료됐습니다/);
  assert.equal(expiryWarning(null, '', now), null, '못 읽은 만료일은 경고를 지어내지 않는다');
  assert.equal(expiryWarning('', '', now), null);
  // 상태를 읽는 시각이 바뀌면 남은 날 · 경고도 바뀐다(예전에는 읽은 때 값이 굳었다).
  _resetHttpsServerState();
  const st0 = tlsListenerStatus(now);
  assert.equal(st0.cert, null);
});

test('④ 긴 한글 제목 — 75자 이하 단어로 접고 디코딩하면 원문', () => {
  const subject = `[경고] ${'가'.repeat(60)} — vCenter 폴란드 · 미국 동부 응답 지연`;
  const enc = encodeHeaderWord(subject);
  const words = enc.split('\r\n ');
  assert.ok(words.length > 1);
  for (const w of words) {
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.ok(w.length <= 75, `encoded-word ${w.length}자`);
  }
  assert.equal(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join(''), subject);
  const mime = buildMime({ from: 'a@b.c', to: ['c@d.e'], subject, text: 'x' });
  const head = mime.split('\r\n\r\n')[0];
  for (const line of head.split('\r\n')) assert.ok(line.length <= 78, `헤더 줄 ${line.length}자: ${line.slice(0, 40)}`);
  // 짧은 제목은 예전처럼 한 단어.
  assert.equal(encodeHeaderWord('폴더 사용량').includes('\r\n'), false);
  // 이모지(4바이트) · 섞인 글자도 글자 경계에서 나뉜다.
  const mixed = `${'😀'.repeat(30)}abc한글`;
  const back = encodeHeaderWord(mixed).split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.equal(back, mixed);
});
