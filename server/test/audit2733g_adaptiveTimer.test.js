/**
 * v2.733 그룹 g — C4-03: `util/adaptiveTimer.js` 가 폴러(fn)의 오류를 **로그 없이** 삼키지 않는다.
 *
 * 예전: `try { await fn(); } catch { }` — 스토리지 폴러가 스냅샷 쓰기 ENOSPC 로 매 주기 던져도 콘솔에 한 줄도 남지 않았다(재현: 콘솔 0줄).
 * 고정하는 것: ① 던지면 타이머 이름과 사유가 콘솔에 남는다 ② 같은 사유가 반복되면 다시 적지 않는다(사유가 바뀌면 적는다)
 *   ③ 타이머 동작은 그대로 — 실패해도 다음 주기로 재무장해 계속 돈다.
 * 실제 타이머로 본다(하한 1초 — 3회 실행 ≈ 2초).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');

test('① fn 오류는 콘솔에 남고 ② 같은 사유 반복은 한 번 · 사유가 바뀌면 다시 ③ 타이머는 계속 돈다', async () => {
  const lines = [];
  const w = console.warn; const l = console.log;
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  console.log = () => {};
  let calls = 0;
  let t;
  try {
    t = startAdaptiveTimer(() => 1_000, async () => {
      calls += 1;
      if (calls <= 2) throw new Error('ENOSPC: no space left on device (테스트 A)');
      if (calls === 3) throw new Error('EIO: i/o error (테스트 B)');
    }, { firstDelayMs: 0, name: 'g2733-timer' });
    const t0 = Date.now();
    while (calls < 3 && Date.now() - t0 < 8_000) await new Promise((r) => { setTimeout(r, 50); });
    await new Promise((r) => { setTimeout(r, 50); });
  } finally { t?.stop(); console.warn = w; console.log = l; }
  assert.ok(calls >= 3, `실패해도 다음 주기로 재무장해 계속 돈다(실행 ${calls}회)`);
  const fails = lines.filter((m) => /g2733-timer/.test(m) && /실행 실패/.test(m));
  assert.equal(fails.filter((m) => /테스트 A/.test(m)).length, 1, `같은 사유는 한 번만:\n${lines.join('\n')}`);
  assert.equal(fails.filter((m) => /테스트 B/.test(m)).length, 1, `사유가 바뀌면 다시 적는다:\n${lines.join('\n')}`);
});

test('④ 정상 실행은 아무것도 적지 않는다', async () => {
  const lines = [];
  const w = console.warn;
  console.warn = (...a) => lines.push(a.map(String).join(' '));
  let calls = 0;
  let t;
  try {
    t = startAdaptiveTimer(() => 1_000, async () => { calls += 1; }, { firstDelayMs: 0, name: 'g2733-ok' });
    const t0 = Date.now();
    while (calls < 1 && Date.now() - t0 < 5_000) await new Promise((r) => { setTimeout(r, 50); });
  } finally { t?.stop(); console.warn = w; }
  assert.equal(calls, 1);
  assert.equal(lines.filter((m) => /g2733-ok/.test(m)).length, 0, lines.join('\n'));
});
