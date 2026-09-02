/**
 * v2.409 회귀 테스트 — 중앙에서 엣지의 스토리지 수집 주기를 설정하는 기능.
 *
 * 고정하는 것(틀리면 운영에서 조용히 잘못 도는 것들):
 *  1) '미지정 = 배포하지 않음' 계약 — 중앙이 지정한 키만 내려가야 한다. 전 키를 채워 보내면
 *     각 법인이 portal.env 로 잡아 둔 현장 설정을 통째로 덮어쓴다.
 *  2) 하한 강제와 '빈 값은 하한으로 승격하지 않고 버린다' — 0/빈칸이 60초로 승격되면
 *     28개 vCenter·고RTT 환경에서 의도치 않은 최소 주기 폭주가 된다.
 *  3) 주기가 **상수가 아니라 매번 조회**되는지 — 예전 구조(모듈 로드 시 const)로 되돌아가면
 *     중앙에서 아무리 바꿔도 엣지 재시작 전엔 반영되지 않는다(이 기능이 통째로 죽는다).
 *  4) 값이 바뀌면 이미 무장된 타이머가 **즉시 재무장**되는지 — 안 그러면 60분 주기에서
 *     '설정했는데 최대 1시간 뒤에야 적용'이 된다.
 *  5) STORAGE_INTERVALS_LOCAL=1(현장 고정)이 중앙 값을 무시하는지.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'stor-intervals-'));
process.env.CONFIG_DIR = CFG;
delete process.env.STORAGE_POLL_MS;
delete process.env.STORAGE_PUSH_MS;
delete process.env.STORAGE_CONFIG_PULL_MS;
delete process.env.STORAGE_AREAS_MS;
delete process.env.STORAGE_INTERVALS_LOCAL;

const load = () => import('../src/storage/intervals.js');

// ── 1) 정규화: 하한/상한/미지정 ────────────────────────────────────────────────
test('normalizeIntervals: 하한 미만은 하한으로 올리고 사유를 남긴다', async () => {
  const { normalizeIntervals } = await load();
  const r = normalizeIntervals({ pollMs: 5_000, areasMs: 60_000 });
  assert.equal(r.values.pollMs, 60_000);          // 수집/push/pull 하한 60초
  assert.equal(r.values.areasMs, 10 * 60_000);    // 영역 전수 수집 하한 10분
  assert.equal(r.issues.length, 2);
});

test('normalizeIntervals: 빈 값/0/문자는 하한으로 승격하지 않고 키를 버린다', async () => {
  const { normalizeIntervals } = await load();
  const r = normalizeIntervals({ pollMs: '', pushMs: 0, configPullMs: 'abc', areasMs: null });
  assert.deepEqual(r.values, {}); // ← 하나라도 60_000 이 되면 미입력이 최소주기로 둔갑한다
});

test('normalizeIntervals: 모르는 키는 무시(파일이 유령 키로 붇지 않게)', async () => {
  const { normalizeIntervals } = await load();
  const r = normalizeIntervals({ pollMs: 300_000, nope: 1 });
  assert.deepEqual(r.values, { pollMs: 300_000 });
  assert.ok(r.issues.some((s) => s.includes('nope')));
});

test('normalizeIntervals: 상한 24시간', async () => {
  const { normalizeIntervals } = await load();
  assert.equal(normalizeIntervals({ pollMs: 99 * 3_600_000 }).values.pollMs, 24 * 3_600_000);
});

// ── 2) 저장/배포: 전역 + 엣지별 병합, 지정한 키만 ──────────────────────────────
test('intervalsForAgent: 전역 위에 엣지별을 덮되 **지정한 키만** 내려간다', async () => {
  const { saveIntervalConfig, intervalsForAgent, _resetForTest } = await load();
  _resetForTest();
  saveIntervalConfig({ global: { pollMs: 300_000 }, agents: { 'agent-MI': { pollMs: 60_000, pushMs: 60_000 } } });
  assert.deepEqual(intervalsForAgent('agent-MI'), { pollMs: 60_000, pushMs: 60_000 });
  // 지정하지 않은 엣지는 전역만 — configPullMs/areasMs 는 **없다**(엣지 로컬 유지 계약).
  assert.deepEqual(intervalsForAgent('agent-WA'), { pollMs: 300_000 });
});

test('saveIntervalConfig: 빈 엣지 항목은 저장하지 않는다', async () => {
  const { saveIntervalConfig, loadIntervalConfig, _resetForTest } = await load();
  _resetForTest();
  const r = saveIntervalConfig({ global: {}, agents: { 'agent-Empty': {}, 'agent-X': { pollMs: 600_000 } } });
  assert.deepEqual(Object.keys(r.config.agents), ['agent-X']);
  assert.deepEqual(loadIntervalConfig().global, {});
});

test('저장 내용이 파일로 남아 재기동 후에도 유지된다', async () => {
  const { saveIntervalConfig, _resetForTest, loadIntervalConfig } = await load();
  _resetForTest();
  saveIntervalConfig({ global: { pushMs: 120_000 }, agents: {} });
  const raw = JSON.parse(fs.readFileSync(path.join(CFG, 'storage-intervals.json'), 'utf8'));
  assert.equal(raw.global.pushMs, 120_000);
  _resetForTest();                        // 메모리 캐시 비우고 파일에서 재로드
  assert.equal(loadIntervalConfig().global.pushMs, 120_000);
});

// ── 3) 런타임 적용 ────────────────────────────────────────────────────────────
test('applyCentralIntervals: 실효값이 바뀌고, 지정 안 한 키는 env/기본값을 유지한다', async () => {
  const m = await load();
  m._resetForTest();
  assert.equal(m.runtimeIntervals().pollMs, 10 * 60_000);   // 기본 10분
  m.applyCentralIntervals({ pollMs: 120_000 });
  assert.equal(m.runtimeIntervals().pollMs, 120_000);
  assert.equal(m.runtimeIntervals().pushMs, 5 * 60_000);    // 미지정 → 기본 유지
  m.applyCentralIntervals({});                              // 중앙이 지정 해제 → 로컬로 복귀
  assert.equal(m.runtimeIntervals().pollMs, 10 * 60_000);
  m._resetForTest();
});

test('applyCentralIntervals: 변경 시 리스너에 알린다(타이머 즉시 재무장의 근거)', async () => {
  const m = await load();
  m._resetForTest();
  let fired = 0;
  const off = m.onIntervalsChange(() => { fired++; });
  m.applyCentralIntervals({ pollMs: 180_000 });
  assert.equal(fired, 1);
  m.applyCentralIntervals({ pollMs: 180_000 });   // 같은 값 → 알림 없음(불필요한 재무장 방지)
  assert.equal(fired, 1);
  off();
  m._resetForTest();
});

test('STORAGE_INTERVALS_LOCAL=1: 현장 고정 — 중앙 값을 무시한다', async () => {
  const m = await load();
  m._resetForTest();
  process.env.STORAGE_INTERVALS_LOCAL = '1';
  const r = m.applyCentralIntervals({ pollMs: 60_000 });
  assert.equal(r.applied, false);
  assert.equal(m.runtimeIntervals().pollMs, 10 * 60_000);
  delete process.env.STORAGE_INTERVALS_LOCAL;
  m._resetForTest();
});

test('runtimeIntervalSource: 값의 출처(central/env/default)를 정직하게 표시', async () => {
  const m = await load();
  m._resetForTest();
  process.env.STORAGE_PUSH_MS = '120000';
  m.applyCentralIntervals({ pollMs: 60_000 });
  const by = Object.fromEntries(m.runtimeIntervalSource().map((s) => [s.key, s]));
  assert.equal(by.pollMs.from, 'central');
  assert.equal(by.pushMs.from, 'env');
  assert.equal(by.pushMs.ms, 120_000);
  assert.equal(by.areasMs.from, 'default');
  delete process.env.STORAGE_PUSH_MS;
  m._resetForTest();
});

// ── 4) 적응형 타이머: 주기가 상수로 굳지 않는지 + 변경 시 즉시 재무장 ──────────
// ⚠ startAdaptiveTimer 는 폭주 방지로 **최소 1초** 바닥을 둔다(0/음수 주기로 이벤트 루프를
//   태우지 않게). 아래 두 테스트의 대기 시간은 그 바닥을 전제로 잡았다.
test('startAdaptiveTimer: 매 회 현재 주기를 다시 읽는다(상수 고정 회귀 방지)', async () => {
  const m = await load();
  let ms = 1_000;
  let runs = 0;
  // 1초 주기로 돌다가 2회째에 60초로 늘린다. 주기를 '생성 시 상수'로 굳혀 두면(예전 구조)
  // 2.4초 안에 3회 돌아 실패한다 — 그게 이 테스트가 막는 회귀다.
  const h = m.startAdaptiveTimer(() => ms, () => { runs++; if (runs === 2) ms = 60_000; }, { firstDelayMs: 1 });
  await new Promise((r) => setTimeout(r, 2_400));
  h.stop();
  assert.equal(runs, 2, `runs=${runs} — 주기 변경이 반영되지 않으면 3회 이상 돈다`);
});

test('startAdaptiveTimer: 주기가 바뀌면 무장된 타이머를 즉시 재무장한다', async () => {
  const m = await load();
  m._resetForTest();
  let runs = 0;
  // 첫 무장을 10초로 길게 잡아 둔 뒤 주기를 바꾼다. 재무장이 없으면 10초를 그대로 기다리므로
  // 1.4초 안에 한 번도 돌지 않는다.
  let ms = 10_000;
  const h = m.startAdaptiveTimer(() => ms, () => { runs++; }, { firstDelayMs: 10_000 });
  ms = 1;
  m.applyCentralIntervals({ pollMs: 120_000 }); // 값 변경 → 리스너 → 재무장(바닥 1초)
  await new Promise((r) => setTimeout(r, 1_400));
  h.stop();
  m._resetForTest();
  assert.ok(runs >= 1, '주기 변경 후에도 재무장되지 않으면 10초 뒤에나 돈다(설정이 늦게 먹는 원인)');
});

// ── 5) 폴러/푸셔가 상수를 쓰지 않는지(소스 회귀 고정) ─────────────────────────
test('poller/push/configPull 에 모듈 로드 시점 INTERVAL_MS 상수가 없어야 한다', () => {
  const files = ['src/storage/poller.js', 'src/storage/push.js', 'src/agent/storageConfigPull.js'];
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.ok(!/const\s+INTERVAL_MS\s*=/.test(src), `${f}: 주기를 상수로 굳히면 중앙 배포가 먹지 않는다`);
    assert.ok(src.includes('runtimeIntervals'), `${f}: runtimeIntervals() 로 매번 조회해야 한다`);
  }
});

test('storagePollerStatus 가 현재 주기와 출처를 함께 보고한다(화면 확인 창구)', async () => {
  const { storagePollerStatus } = await import('../src/storage/poller.js');
  const s = storagePollerStatus();
  assert.equal(typeof s.intervalMs, 'number');
  assert.ok(Array.isArray(s.intervals));
});
