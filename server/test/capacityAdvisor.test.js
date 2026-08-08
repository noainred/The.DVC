/**
 * Capacity Advisor — 시계열 저장(원본/롤업 이원)·창 통계·판정 규칙 검증.
 *
 * 핵심 계약:
 *  - 표본 부족이면 판정하지 않는다(measuring) — 데이터 없는 단정 금지.
 *  - 판정은 p95 기준(scale_up ≥ bad, watch ≥ warn), 감축은 '1달 창 + max < warn/2' 일 때만.
 *  - 장기 창(원본 보존 밖)은 시간당 롤업으로 근사하고 approx:true 를 표기한다.
 *  - 중앙 수신 경로와 로컬 샘플러가 같은 insertSnapshot 을 쓴다(스키마 단일).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-adv-'));

const { getCapacityDb } = await import('../src/capacity/db.js');
const { evaluateHost, summarizeHosts, WINDOWS } = await import('../src/capacity/evaluate.js');
const { collectorMeta, registerCollector, collectors } = await import('../src/capacity/collectors.js');
const { collectSnapshot } = await import('../src/capacity/sampler.js');

const db = await getCapacityDb();
const NOW = Date.now();
const HOUR = 3600_000;

/** 합성 시계열 적재 — 시간당 1개(장기 창은 롤업 경로), 최근 3시간은 10분 간격(원본 경로 표본 확보). */
function seed(k, metric, valueOf) {
  for (let h = 30 * 24; h >= 3; h -= 1) {
    const ts = NOW - h * HOUR;
    db.insertSnapshot(k, [{ metric, v: valueOf(ts) }], ts, { hostname: k, cores: 8 });
  }
  for (let m = 3 * 6; m >= 0; m -= 1) {
    const ts = NOW - m * 10 * 60_000;
    db.insertSnapshot(k, [{ metric, v: valueOf(ts) }], ts, { hostname: k, cores: 8 });
  }
}

test('C1 창 통계: 원본 창은 정확 통계(approx=false), 1달 창은 롤업 근사(approx=true)', () => {
  seed('h-stat', 'cpu_system', () => 50);
  const day = db.windowStats('cpu_system', 'h-stat', NOW - 24 * HOUR, NOW);
  assert.ok(day.n >= 20, `1일 창 표본 ${day.n}`);
  // 창 시작이 원본 보존(72h) 안이므로 원본 경로.
  assert.equal(day.approx, false);
  assert.equal(day.p95, 50);
  const month = db.windowStats('cpu_system', 'h-stat', NOW - 30 * 24 * HOUR, NOW);
  assert.equal(month.approx, true);        // 원본 보존 밖 — 시간당 롤업 근사
  assert.equal(month.max, 50);
});

test('C2 판정: p95 ≥ bad → scale_up (증설 필요, 근거 문장에 임계·실측 포함)', async () => {
  seed('h-hot', 'cpu_system', () => 92);   // bad=85 초과 상시
  const r = await evaluateHost('h-hot');
  const m = r.windows.month.metrics.cpu_system;
  assert.equal(m.verdict, 'scale_up');
  assert.match(m.reason, /p95/);
  assert.match(m.reason, /85/);            // 임계가 문장에 드러난다
  const cpuAdvice = r.advice.find((a) => a.group === 'cpu');
  assert.equal(cpuAdvice.level, 'scale_up');
});

test('C3 판정: 1달 max 가 warn 절반 미만 → scale_down (감축은 1달 창에서만)', async () => {
  seed('h-idle', 'cpu_system', () => 10);  // warn=70 의 절반(35) 미만 상시
  const r = await evaluateHost('h-idle');
  assert.equal(r.windows.month.metrics.cpu_system.verdict, 'scale_down');
  // 1일 창은 같은 값이어도 scale_down 을 내지 않는다(짧은 한가함으로 감축 권고 금지).
  assert.equal(r.windows.day.metrics.cpu_system.verdict, 'ok');
});

test('C4 판정: 표본 부족이면 measuring — 단정하지 않는다', async () => {
  db.insertSnapshot('h-new', [{ metric: 'cpu_system', v: 99 }], NOW, { hostname: 'h-new' });
  const r = await evaluateHost('h-new');
  assert.equal(r.windows.day.metrics.cpu_system.verdict, 'measuring');
  assert.match(r.windows.day.metrics.cpu_system.reason, /표본 1개/);
});

test('C5 급성 악화: 1달은 ok 인데 1일 p95 ≥ bad 면 1일 우선 경보', async () => {
  // 한 달 내내 낮다가 최근 24h 급등.
  seed('h-spike', 'cpu_system', (ts) => (NOW - ts < 24 * HOUR ? 95 : 40));
  const r = await evaluateHost('h-spike');
  assert.equal(r.windows.day.metrics.cpu_system.verdict, 'scale_up');
  const cpuAdvice = r.advice.find((a) => a.group === 'cpu');
  assert.equal(cpuAdvice.level, 'scale_up');
  assert.match(cpuAdvice.text, /1일|급성/);
});

test('C6 요약: 호스트 목록에 신선도(fresh)·축 종합이 실린다', async () => {
  const rows = await summarizeHosts();
  const hot = rows.find((h) => h.k === 'h-hot');
  assert.ok(hot);
  assert.equal(hot.groups.cpu, 'scale_up');
  assert.equal(hot.fresh, true);
});

test('C7 수집기 레지스트리: 신규 등록이 meta·평가에 자동 편입(확장 지점)', async () => {
  registerCollector({
    key: 'test_custom', label: '테스트 지표', unit: 'pct', group: 'runtime',
    warn: 50, bad: 80, scaleHint: '테스트 증설', sample: () => 1,
  });
  assert.ok(collectorMeta().some((m) => m.key === 'test_custom'));
  seed('h-hot', 'test_custom', () => 90);
  const r = await evaluateHost('h-hot');
  assert.equal(r.windows.month.metrics.test_custom.verdict, 'scale_up');
});

test('C8 collectSnapshot: 등록 수집기를 돌려 유한값만 낸다(실패 수집기가 전체를 막지 않음)', () => {
  registerCollector({ key: 'test_boom', label: '폭발', unit: 'pct', group: 'runtime', sample: () => { throw new Error('boom'); } });
  const first = collectSnapshot();          // 첫 호출 — 델타 기준선
  const second = collectSnapshot();
  assert.ok(second.rows.every((r) => Number.isFinite(r.v)));
  assert.ok(!second.rows.some((r) => r.metric === 'test_boom'));
  // mem_system 은 델타 없이 즉시 측정된다.
  assert.ok(first.rows.some((r) => r.metric === 'mem_system'));
});

test('C9 WINDOWS 정의: 1일/1주/1달 세 창(사용자 요구 그대로)', () => {
  assert.deepEqual(WINDOWS.map((w) => w.key), ['day', 'week', 'month']);
});

test('C10 prune: 원본은 보존시간 밖을 지우고 롤업은 남긴다(장기 창 유지)', () => {
  seed('h-prune', 'cpu_system', () => 33);
  db.prune(NOW);
  const month = db.windowStats('cpu_system', 'h-prune', NOW - 30 * 24 * HOUR, NOW);
  assert.ok(month && month.n > 0, '롤업 경로가 살아 있어야 한다');
  assert.equal(month.approx, true);
});
