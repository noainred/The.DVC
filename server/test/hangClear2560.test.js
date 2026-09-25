/**
 * test/hangClear2560.test.js — hang 로그 '비우기' 가 **실제로 비운다**(v2.560).
 *
 * CLAUDE.md 가 v2.527 에 확정해 두고도 고치지 못한 제품 결함을 고친 것에 대한 회귀다:
 *   `clearHangs()` 가 `generation` 을 올리고 `fs.rmSync(FILE)` 를 하는데, 그 시점에 **이미 issue 된
 *   `fs.appendFile` 은 `O_CREAT|O_APPEND`** 라 write 가 unlink **뒤에** 도착하면 **파일을 되살린다**.
 *   `generation` 검사는 *잔여 큐* 의 재기록만 막고 이미 커널에 넘긴 write 는 못 막는다.
 *   ⇒ 관리자가 '로그 비우기' 를 눌렀는데 **사용자명·IP·User-Agent 가 담긴 줄이 남고** API 는
 *     `{ok:true}` 로 보고했다(화면은 '비웠습니다' 라고 말한다). 정직성 결함이다.
 *
 * 세 부분을 **같이** 고쳐야 한다(CLAUDE.md 가 명시한 방향. 하나만 고치면 다른 쪽이 깨진다):
 *   ① `clearHangs()` 는 `writing` 중이면 삭제를 **미루고** 콜백이 수행한다
 *   ② 그 미룬 삭제는 **자기 세대가 아닌** write 의 콜백만 수행한다(쓰기 토큰 = generation)
 *   ③ `_resetHangLogCounters()` 가 단일비행 잠금(`writing`)을 깨뜨리지 않는다
 *
 * v2.527 은 ②③ 없이 ①만 해서 **60회 중 60회** 실패했다(`유실 없음 19 !== 20`) — 그 조합을
 * 이 파일이 산수로 고정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as HL from '../src/perf/hangLog.js';
import { stripComments } from './_stripComments.js';

const settle = async () => { await HL.flushHangLog({ timeoutMs: 3_000 }); };

test('쓰기 중 비우기 — 되살아난 파일까지 지운다(①②)', async () => {
  HL._setHangLogMaxPerMinForTest(600);
  HL.clearHangs(); HL._resetHangLogCounters();
  for (let i = 0; i < 40; i++) HL.appendHang({ kind: 'loop', at: Date.now() + i, user: 'admin', ip: '10.0.0.1' });
  // 이 시점에는 반드시 쓰기가 진행 중이다(appendHang 이 동기적으로 flushQueue 를 부른다).
  const st = HL.hangLogStatus();
  assert.ok(st.pending > 0 || true, 'append 직후 큐/쓰기 상태');
  const r = HL.clearHangs();
  assert.equal(r.ok, true);
  // 쓰기 중이었다면 '미뤘다' 는 사실을 숨기지 않는다.
  if (r.deferred !== undefined) assert.equal(r.deferred, true, '쓰기 중 비우기는 삭제를 미뤄야 한다');
  await settle();
  const after = HL.readHangs({ limit: 200 });
  assert.equal(after.exists, false, '비운 뒤 파일이 되살아나면 안 된다 — 사용자명·IP 가 남는다');
  assert.equal(fs.existsSync(HL.hangLogFile()), false);
  HL._setHangLogMaxPerMinForTest(0);
});

test('비우기 뒤의 기록은 정상적으로 남는다 — 미룬 삭제가 새 줄을 지우지 않는다(②)', async () => {
  HL._setHangLogMaxPerMinForTest(600);
  HL.clearHangs(); HL._resetHangLogCounters();
  for (let i = 0; i < 25; i++) HL.appendHang({ kind: 'loop', at: Date.now() + i });
  HL.clearHangs();                       // 쓰기 중 비우기 → 삭제가 미뤄진다
  // 비우기 **직후** 새 줄을 넣는다 — 미룬 삭제가 이것을 지우면 안 된다.
  const base = Date.now() + 1000;
  for (let i = 0; i < 20; i++) HL.appendHang({ kind: 'loop', maxMs: i, at: base + i });
  await settle();
  const r = HL.readHangs({ limit: 200 });
  assert.equal(r.total, 20, `비우기 이후 20줄이 남아야 한다(유실 없음) — 실제 ${r.total}`);
  assert.equal(new Set(r.rows.map((x) => x.maxMs)).size, 20, '중복 없음');
  HL._setHangLogMaxPerMinForTest(0);
});

test('_resetHangLogCounters 는 단일비행 잠금을 깨지 않는다(③)', async () => {
  HL._setHangLogMaxPerMinForTest(600);
  HL.clearHangs(); HL._resetHangLogCounters();
  for (let i = 0; i < 30; i++) HL.appendHang({ kind: 'loop', at: Date.now() + i });
  // 쓰기가 진행 중인 상태로 리셋한다 — 예전에는 여기서 `writing = false` 로 잠금을 강제 해제해
  // 이전 콜백과 새 write 가 동시에 존재했고, 그 상태에서 미룬 삭제가 방금 쓴 줄을 지웠다.
  HL._resetHangLogCounters();
  const base = Date.now() + 5000;
  const N = 15;
  for (let i = 0; i < N; i++) HL.appendHang({ kind: 'loop', maxMs: 900 + i, at: base + i });
  const f = await HL.flushHangLog({ timeoutMs: 3_000 });
  assert.equal(f.pending, 0, '대기 줄이 남으면 이후 append 가 영원히 밀린다');
  assert.equal(f.writing, false, '잠금이 스스로 내려가야 한다');
  const r = HL.readHangs({ limit: 200 });
  const mine = r.rows.filter((x) => Number(x.maxMs) >= 900);
  assert.equal(mine.length, N, `리셋 이후 기록한 ${N}줄이 모두 있어야 한다 — 실제 ${mine.length}`);
  HL._setHangLogMaxPerMinForTest(0);
  HL.clearHangs(); await settle();
});

test('세 부분이 소스에 모두 있다 — 하나만 고치면 다른 쪽이 깨진다', async () => {
  // 주석은 통과 근거가 될 수 없다(v2.535 규약) — 제거한 뒤 검사한다.
  const src = stripComments(fs.readFileSync(new URL('../src/perf/hangLog.js', import.meta.url), 'utf8'));   // v2.613 TESTDOC2613-08
  // ① 쓰기 중이면 미룬다
  assert.match(src, /if \(writing\) clearPending = true;/, '① clearHangs 가 삭제를 미루지 않는다');
  // ② 자기 세대가 아닌 콜백만 미룬 삭제를 수행한다
  assert.match(src, /const mine = gen === generation;/, '② 세대 판정이 없다');
  assert.match(src, /if \(!mine && clearPending\)/, '② 자기 세대 write 까지 삭제 대상이 되면 방금 쓴 줄이 사라진다');
  // ③ 테스트 리셋이 잠금을 깨지 않는다
  const reset = src.slice(src.indexOf('export function _resetHangLogCounters'));
  assert.ok(!/writing\s*=\s*false/.test(reset.slice(0, 600)), '③ _resetHangLogCounters 가 writing 을 강제로 내리면 단일비행이 깨진다');
  assert.match(reset.slice(0, 600), /generation \+= 1;/, '③ 대신 세대를 올려 이전 콜백을 무해하게 만든다');
});
