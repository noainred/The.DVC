/**
 * v2.743 감사 그룹 GH — adaptiveTimer 첫 실행 전 재무장(TIMING-01).
 *
 *  TIMING-01  첫 실행 전에 주기 변경 알림이 오면 adaptiveTimer 가 firstDelayMs 를 버리고 '주기 − 경과(생성 기준)' 로 재무장했다.
 *             엣지 재시작(자동 업그레이드)마다 설정 pull(첫 실행 10~20초)이 중앙 주기를 적용하며 알려, 스토리지 첫 수집이 15초가 아니라
 *             약 1시간 뒤, PDU 첫 수집이 45초가 아니라 약 5분 뒤가 됐다. 함께 storage·pdu 의 '같은 실효 주기' 재적용이 리스너를 불렀다
 *             (_override·_central 이 메모리에만 있어 재시작 직후 첫 pull 은 언제나 '바뀜' 이었다).
 *
 * 시각은 node:test 가짜 타이머(setTimeout·Date)로 잰다 — 절대 시간 상한 없이 순서·정확한 가짜 시각으로 단언한다.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743h-'));
process.env.CONFIG_DIR = TMP;
for (const k of ['STORAGE_POLL_MS', 'STORAGE_PUSH_MS', 'STORAGE_CONFIG_PULL_MS', 'STORAGE_AREAS_MS', 'STORAGE_INTERVALS_LOCAL',
  'PDU_POLL_MS', 'PDU_PUSH_MS', 'PDU_CONFIG_PULL_MS', 'PDU_INTERVALS_LOCAL']) delete process.env[k];

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** 가짜 타이머 안에서 fn 을 돌리고 정리한다. 구독자 목록(cbs)으로 알림을 흉내 낸다. */
async function withClock(body) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const log = mock.method(console, 'log', () => {});
  const warn = mock.method(console, 'warn', () => {});
  try { await body({ log, t0: 1_000_000 }); } finally { mock.timers.reset(); log.mock.restore(); warn.mock.restore(); }
}

test('TIMING-01 adaptiveTimer — firstDelay 1.5초 · 주기 60초 · 1초에 알림이 와도 첫 실행은 1.5초다(예전: 생성 + 60초)', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  await withClock(async ({ log, t0 }) => {
    const cbs = [];
    const starts = [];
    const t = startAdaptiveTimer(() => 60_000, async () => { starts.push(Date.now() - t0); }, {
      firstDelayMs: 1500, name: 'g2743h', subscribe: (cb) => { cbs.push(cb); return () => {}; } });
    try {
      mock.timers.tick(1000); await flush();
      cbs.forEach((c) => c());                     // 설정 pull 이 중앙 주기를 적용하며 알림
      mock.timers.tick(499); await flush();
      assert.equal(starts.length, 0, '1.499초 — 아직');
      mock.timers.tick(1); await flush();
      assert.deepEqual(starts, [1500], '첫 실행은 firstDelay(1.5초) 그대로다');
      assert.equal(log.mock.calls.filter((c) => /재무장/.test(String(c.arguments[0]))).length, 0, '같은 시각이면 재무장도 로그도 없다');
      // 첫 실행이 끝난 뒤의 규칙은 그대로 — 종료 + 주기(60초). 같은 값 알림은 타이머를 건드리지 않는다(v2.741 TIMING-05)
      mock.timers.tick(10_000); await flush();
      cbs.forEach((c) => c());
      mock.timers.tick(49_999); await flush();
      assert.equal(starts.length, 1);
      mock.timers.tick(1); await flush();
      assert.deepEqual(starts, [1500, 61_500], '두 번째 실행은 첫 실행 종료 + 60초');
    } finally { t.stop(); }
  });
});

test('TIMING-01 adaptiveTimer — 첫 실행 전 새 주기가 firstDelay 보다 짧으면 당기고, 다시 길어지면 firstDelay 로 돌아간다', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  await withClock(async ({ t0 }) => {
    const cbs = [];
    const starts = [];
    let ms = 60_000;
    const t = startAdaptiveTimer(() => ms, async () => { starts.push(Date.now() - t0); }, {
      firstDelayMs: 10_000, subscribe: (cb) => { cbs.push(cb); return () => {}; } });
    try {
      mock.timers.tick(1000); await flush();
      ms = 3000; cbs.forEach((c) => c());          // 생성 + 3초 < firstDelay 10초 → 3초로 당긴다(min)
      mock.timers.tick(1000); await flush();
      ms = 60_000; cbs.forEach((c) => c());        // 다시 길어짐 → min(10초, 60초) = firstDelay
      mock.timers.tick(1500); await flush();
      assert.equal(starts.length, 0, '3초 시각에 돌지 않는다(다시 firstDelay 로)');
      mock.timers.tick(6500); await flush();
      assert.deepEqual(starts, [10_000]);
    } finally { t.stop(); }
  });
  await withClock(async ({ t0 }) => {
    const cbs = [];
    const starts = [];
    let ms = 60_000;
    const t = startAdaptiveTimer(() => ms, async () => { starts.push(Date.now() - t0); }, {
      firstDelayMs: 10_000, subscribe: (cb) => { cbs.push(cb); return () => {}; } });
    try {
      mock.timers.tick(1000); await flush();
      ms = 3000; cbs.forEach((c) => c());
      mock.timers.tick(1999); await flush();
      assert.equal(starts.length, 0);
      mock.timers.tick(1); await flush();
      assert.deepEqual(starts, [3000], '짧아진 주기는 생성 시각 기준으로 당긴다(예전과 같은 기준)');
    } finally { t.stop(); }
  });
});

test('TIMING-01 adaptiveTimer — 하한(1초) 안에 울릴 첫 실행은 알림이 와도 밀리지 않고, 주기를 못 읽어도 firstDelay 를 지킨다', async () => {
  const { startAdaptiveTimer } = await import('../src/util/adaptiveTimer.js');
  await withClock(async ({ t0 }) => {
    const cbs = [];
    const starts = [];
    let ms = 1;
    const t = startAdaptiveTimer(() => ms, async () => { starts.push(Date.now() - t0); }, {
      firstDelayMs: 5000, subscribe: (cb) => { cbs.push(cb); return () => {}; } });
    try {
      mock.timers.tick(4500); await flush();
      cbs.forEach((c) => c());                     // 생성 + 1초는 이미 지났다 — 그래도 0.5초 뒤 울릴 타이머를 1초 뒤로 밀지 않는다
      cbs.forEach((c) => c());
      mock.timers.tick(500); await flush();
      assert.deepEqual(starts, [5000]);
    } finally { t.stop(); }
  });
  await withClock(async ({ t0 }) => {
    const cbs = [];
    const starts = [];
    let boom = true;
    const t = startAdaptiveTimer(() => { if (boom) throw new Error('설정 파일 손상'); return 60_000; }, async () => { starts.push(Date.now() - t0); }, {
      firstDelayMs: 1500, subscribe: (cb) => { cbs.push(cb); return () => {}; } });
    try {
      mock.timers.tick(1000); await flush();
      cbs.forEach((c) => c());                     // 주기를 못 읽음 → 첫 실행을 60초로 미루지 않는다
      mock.timers.tick(500); await flush();
      assert.deepEqual(starts, [1500]);
      boom = false;
    } finally { t.stop(); }
  });
});

test('TIMING-01 storage/intervals — 재시작 직후 설정 pull 이 중앙 주기를 적용해도 장비 수집은 firstDelay 에 돈다(재현 축척)', async () => {
  const si = await import('../src/storage/intervals.js');
  si._resetForTest();
  await withClock(async ({ t0 }) => {
    const starts = [];
    // storage/poller.js 와 같은 모양(firstDelay 15초의 1/10)
    const t = si.startAdaptiveTimer(() => si.runtimeIntervals().pollMs, async () => { starts.push(Date.now() - t0); }, { firstDelayMs: 1500, name: 'g2743h-poll' });
    try {
      mock.timers.tick(1000); await flush();
      const r = si.applyCentralIntervals({ pollMs: 600_000, areasMs: 7_200_000 });   // 실효 주기가 실제로 바뀌는 지정
      assert.equal(r.applied, true);
      assert.equal(r.effectiveChanged, true);
      mock.timers.tick(500); await flush();
      assert.deepEqual(starts, [1500], '예전: 생성 + 600초(재현 3599초) 뒤');
      mock.timers.tick(600_000); await flush();
      assert.deepEqual(starts, [1500, 601_500], '그 뒤로는 새 주기(종료 + 600초)');
    } finally { t.stop(); si._resetForTest(); }
  });
});

test('TIMING-01 storage/intervals — 실효 주기가 같은 지정은 리스너를 부르지 않는다(출처 표시만 중앙으로)', async () => {
  const si = await import('../src/storage/intervals.js');
  si._resetForTest();
  const log = mock.method(console, 'log', () => {});
  let fired = 0;
  const off = si.onIntervalsChange(() => { fired++; });
  try {
    const POLL_DEF = si.INTERVAL_SPEC.find((x) => x.key === 'pollMs').def;
    const r = si.applyCentralIntervals({ pollMs: POLL_DEF });   // 재시작 직후 _override={} — 기본값과 같은 중앙 값
    assert.equal(r.applied, true, '중앙 지정 값은 적용한다(출처 표시)');
    assert.equal(r.effectiveChanged, false);
    assert.equal(fired, 0, '실효 주기가 그대로면 타이머를 다시 잡지 않는다');
    assert.equal(si.runtimeIntervalSource().find((x) => x.key === 'pollMs').from, 'central');
    assert.ok(log.mock.calls.some((c) => /실효 주기는 그대로/.test(String(c.arguments[0]))), '그 사실을 로그가 말한다');
    si.applyCentralIntervals({ pollMs: 120_000 });
    assert.equal(fired, 1, '실제로 바뀌면 알린다');
    si.applyCentralIntervals({});                               // 지정 해제 → 기본으로 돌아감(실효 변화) → 알린다
    assert.equal(fired, 2);
  } finally { off(); log.mock.restore(); si._resetForTest(); }
});

test('TIMING-01 pdu/intervals — 같은 실효 주기의 재적용·재저장은 알리지 않고, PDU 수집도 firstDelay 에 돈다', async () => {
  const pi = await import('../src/pdu/intervals.js');
  pi._resetForTest();
  const log = mock.method(console, 'log', () => {});
  let fired = 0;
  const off = pi.onIntervalsChange(() => { fired++; });
  try {
    const POLL_DEF = pi.INTERVAL_SPEC.find((x) => x.key === 'pollMs').def;
    assert.equal(pi.applyCentralIntervals({ pollMs: POLL_DEF }), true, '반환값(중앙 지정 값이 바뀌었는가)은 예전 뜻 그대로');
    assert.equal(fired, 0, '재시작 직후(_central=null) 기본값과 같은 중앙 값 — 알리지 않는다');
    assert.equal(pi.applyCentralIntervals({ pollMs: 900_000 }), true);
    assert.equal(fired, 1);
    assert.equal(pi.applyCentralIntervals({ pollMs: 900_000 }), false);
    assert.equal(fired, 1);
    // 중앙 저장: 같은 값 다시 저장은 알리지 않는다(중앙 노드 — 파일이 곧 중앙 지정값)
    pi._resetForTest();
    const off2 = pi.onIntervalsChange(() => { fired++; });
    fired = 0;
    pi.saveIntervals({ pollMs: 600_000 });
    assert.equal(fired, 1);
    pi.saveIntervals({ pollMs: 600_000 });
    assert.equal(fired, 1, '같은 값 저장 — 타이머를 다시 잡지 않는다');
    pi.saveIntervals({ pollMs: '' });
    assert.equal(fired, 2, '지정 해제는 실효 변화 — 알린다');
    off2();
  } finally { off(); log.mock.restore(); pi._resetForTest(); }

  pi._resetForTest();
  await withClock(async ({ t0 }) => {
    const starts = [];
    // pdu/poller.js 와 같은 모양(firstDelay 45초의 1/10)
    const t = pi.startAdaptiveTimer(pi.pollMs, async () => { starts.push(Date.now() - t0); }, { firstDelayMs: 4500, name: 'g2743h-pdu' });
    try {
      mock.timers.tick(1000); await flush();
      pi.applyCentralIntervals({ pollMs: 900_000 });   // 설정 pull(20초의 1/10 쯤)이 실제로 다른 주기를 적용
      mock.timers.tick(3499); await flush();
      assert.equal(starts.length, 0);
      mock.timers.tick(1); await flush();
      assert.deepEqual(starts, [4500], '예전: 생성 + 900초 뒤');
    } finally { t.stop(); pi._resetForTest(); }
  });
});

test('정리', () => { fs.rmSync(TMP, { recursive: true, force: true }); });
