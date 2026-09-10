// 시계열 용량 감축(v2.451) — 변화분만 저장(dead-band) + 원본/롤업 보존 분리.
//
// 배경: 온도가 "27, 27, 27..." 로 거의 그대로인데 1분마다 전량 저장돼 host-temp.db 34.3GB,
// idrac-power.db 26.9GB(운영 실측). 아래 테스트가 감축 규칙과 **정확도 보장**을 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldStore, splitByDeadband, policyKeyFor, policyFromEnv, DEFAULT_POLICY } from '../src/metrics/deadband.js';

const MIN = 60_000;
const P = DEFAULT_POLICY.temp;   // eps 0.5, maxGap 30분

test('임계 이내 변화는 저장하지 않는다(온도 27도가 이어질 때)', () => {
  const t0 = Date.now();
  assert.equal(shouldStore(null, { v: 27, ts: t0 }, P), true, '첫 샘플은 기준선이라 항상 저장');
  const prev = { v: 27, ts: t0 };
  assert.equal(shouldStore(prev, { v: 27, ts: t0 + MIN }, P), false);
  assert.equal(shouldStore(prev, { v: 27.2, ts: t0 + MIN }, P), false, '0.2도 변화는 생략');
  assert.equal(shouldStore(prev, { v: 27.5, ts: t0 + MIN }, P), true, '임계(0.5) 이상은 저장');
  assert.equal(shouldStore(prev, { v: 26.4, ts: t0 + MIN }, P), true, '하강도 대칭으로 판정');
});

test('값이 그대로여도 최대 간격이 지나면 저장한다(수집 중단과 구분)', () => {
  const t0 = Date.now();
  const prev = { v: 27, ts: t0 };
  assert.equal(shouldStore(prev, { v: 27, ts: t0 + 29 * MIN }, P), false);
  assert.equal(shouldStore(prev, { v: 27, ts: t0 + 30 * MIN }, P), true, '30분 경과 → 살아있음을 남긴다');
});

test('임계 0 이면 기능이 꺼진다(전량 저장)', () => {
  const off = { eps: 0, maxGapMs: 30 * MIN };
  const t0 = Date.now();
  assert.equal(shouldStore({ v: 27, ts: t0 }, { v: 27, ts: t0 + MIN }, off), true);
  assert.equal(shouldStore({ v: 27, ts: t0 }, { v: 27, ts: t0 + MIN }, null), true);
});

test('이상값(NaN/undefined)은 판정하지 않고 그대로 저장한다', () => {
  const t0 = Date.now();
  assert.equal(shouldStore({ v: 27, ts: t0 }, { v: NaN, ts: t0 + MIN }, P), true);
  assert.equal(shouldStore({ v: NaN, ts: t0 }, { v: 27, ts: t0 + MIN }, P), true);
});

test('계열 매핑 — 온도·전력만 대상이고 나머지는 전량 저장', () => {
  assert.equal(policyKeyFor('temp_host'), 'temp');
  assert.equal(policyKeyFor('temp_cluster'), 'temp');
  assert.equal(policyKeyFor('roomtemp_inlet_avg'), 'temp');
  assert.equal(policyKeyFor('power'), 'power');
  assert.equal(policyKeyFor('power_total'), 'power');
  // 사용률·용량 계열은 매핑에 없다 — 잘못 생략하면 분석이 틀어진다(오탐 방지).
  for (const m of ['gpu_util', 'ds_usedgb', 'vm_cpu_used_mhz', 'mem_rss']) {
    assert.equal(policyKeyFor(m), null, `${m} 은 dead-band 대상이 아니어야 한다`);
  }
});

test('splitByDeadband — 생략은 원본만, 롤업 갱신용 원본 배열은 그대로', () => {
  const t0 = Date.now();
  const last = new Map();
  const rows = [
    { metric: 'temp_host', k: 'h1', v: 27 },
    { metric: 'temp_host', k: 'h2', v: 30 },
    { metric: 'gpu_util', k: 'h1', v: 40 },      // 대상 아님 → 항상 저장
  ];
  let r = splitByDeadband(rows, t0, last);
  assert.equal(r.store.length, 3, '첫 회는 전부 저장');
  assert.equal(r.skipped, 0);

  // 1분 뒤 온도는 그대로, GPU 만 변함
  r = splitByDeadband([
    { metric: 'temp_host', k: 'h1', v: 27 },
    { metric: 'temp_host', k: 'h2', v: 30.1 },
    { metric: 'gpu_util', k: 'h1', v: 55 },
  ], t0 + MIN, last);
  assert.deepEqual(r.store.map((x) => `${x.metric}/${x.k}`), ['gpu_util/h1'], '온도 2건 생략');
  assert.equal(r.skipped, 2);

  // h1 이 임계 이상 오르면 다시 저장되고 기준선이 갱신된다
  r = splitByDeadband([{ metric: 'temp_host', k: 'h1', v: 27.6 }], t0 + 2 * MIN, last);
  assert.equal(r.store.length, 1);
  assert.equal(last.get('temp_host h1').v, 27.6);
});

test('감축 효과 — 27도가 이어지는 1시간(0~59분, 60샘플)에서 원본은 2행만 남는다', () => {
  const t0 = Date.now();
  const last = new Map();
  let stored = 0;
  for (let i = 0; i < 60; i++) {
    const r = splitByDeadband([{ metric: 'temp_host', k: 'h1', v: 27 }], t0 + i * MIN, last);
    stored += r.store.length;
  }
  // 0분(기준선) + 30분(최대 간격 보장) = 2행. 나머지 58행 생략 → **96.7% 감소**.
  assert.equal(stored, 2, `60샘플 중 ${stored}행 저장`);
  // 2시간(121샘플)이면 0·30·60·90·120분 = 5행.
  const last2 = new Map();
  let s2 = 0;
  for (let i = 0; i <= 120; i++) s2 += splitByDeadband([{ metric: 'temp_host', k: 'h', v: 27 }], t0 + i * MIN, last2).store.length;
  assert.equal(s2, 5, `121샘플 중 ${s2}행 저장`);
});

test('policyFromEnv — 값이 없거나 이상하면 기본값, 0 이면 비활성', () => {
  assert.deepEqual(policyFromEnv({}), {
    temp: { eps: 0.5, maxGapMs: 30 * MIN },
    power: { eps: 3, maxGapMs: 30 * MIN },
  });
  assert.equal(policyFromEnv({ METRICS_DEADBAND_TEMP_C: '1.5' }).temp.eps, 1.5);
  assert.equal(policyFromEnv({ METRICS_DEADBAND_TEMP_C: '0' }).temp.eps, 0, '0 = 그 계열 비활성');
  assert.equal(policyFromEnv({ METRICS_DEADBAND_POWER_W: 'abc' }).power.eps, 3, '이상값은 기본값 유지');
  // 최대 간격은 1분 미만으로 낮출 수 없다(샘플 주기보다 짧으면 의미가 없다).
  assert.equal(policyFromEnv({ METRICS_DEADBAND_MAX_GAP_MS: '1000' }).temp.maxGapMs, 60_000);
});

test('설정 기본값 — 원본 90일 / 롤업 5년(온도), 전력은 기존 90일 유지', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config.temp.retentionDays, 1830, '롤업(시간당 평균·최소·최대)은 5년');
  assert.equal(config.temp.rawRetentionDays, 90, '원본(분 단위)은 90일');
  assert.equal(config.idrac.retentionDays, 90);
  assert.equal(config.idrac.rawRetentionDays, 0, '0 = 기존 동작(원본도 90일)');
});
