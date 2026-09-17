/**
 * unityMultiPool2546.test.js — Unity 다중 풀 산정 회귀(v2.546).
 *
 * 사용자 질문(2026-09-17) "현재 구조에서 pool 이 2개 이상이어도 계산 가능해?" 에서 확인한
 * 한계 3건 중 **웹 쪽 둘**을 고정한다.
 *
 *  ① 다중 풀에서 **경고 임계 기준이 통째로 사라져** 실질 한도가 1.8배 느슨해지던 것
 *     (실측: 47.6 TB → 84.7 TB). 이제 풀마다 자기 임계로 계산해 **더한다** — 대표 임계를
 *     만들지 않으므로 v2.540 규약을 어기지 않는다.
 *  ② **공간은 풀 경계를 넘지 못한다.** 합산 여유를 한 덩어리로 나누면 '80 TB 짜리 1개' 같은
 *     불가능한 답이 나온다(오류 없이 틀린 값 — v2.530 규약).
 *
 * 그리고 사용자 제안("전체 용량은 정상인데 어떤 pool 사용량이 많다고 표시")을 `poolPressure`·
 * `poolPressureNote` 로 고정한다.
 *
 * ⚠ pool_1 은 실장비 수치, **pool_2 는 합성**이다(다중 풀 실장비 출력을 본 적이 없다).
 *   합성이지만 항등식(`Total = Current + Remaining + Preallocated`)은 지켰다.
 */
import { describe, it, expect } from 'vitest';
import {
  planInput, headroom, fitCount, fitCountByPool, poolPressure, poolPressureNote, verifyIdentity,
} from './unityCapacityPlan.js';

const TIB = 1024 ** 4;

const POOL1 = {
  name: 'pool_1', id: 'pool_1',
  totalBytes: 117544396521472, usedBytes: 29973250195456, usedSource: 'device',
  freeBytes: 87568746020864, preallocatedBytes: 2400305152, subscribedBytes: 55491782770688,
  alertThresholdPct: 70, drives: '38 x 3.8T SAS Flash 4', raid: '5', stripeLength: 9,
  capacityCounted: true,
};
const POOL2 = {
  name: 'pool_2', id: 'pool_2',
  totalBytes: 58772198260736, usedBytes: 53952823013376, usedSource: 'device',
  freeBytes: 4818175094784, preallocatedBytes: 1200152576, subscribedBytes: 55491782770688,
  alertThresholdPct: 70, drives: '19 x 3.8T SAS Flash 4', raid: '5', stripeLength: 9,
  capacityCounted: true,
};
const snapOf = (pools) => {
  const counted = pools.filter((p) => p.capacityCounted);
  const total = counted.reduce((a, p) => a + p.totalBytes, 0);
  const used = counted.reduce((a, p) => a + p.usedBytes, 0);
  return { pools, capacity: { totalBytes: total, usedBytes: used, pct: Math.round((used / total) * 1000) / 10 }, extra: {} };
};

describe('planInput — 합산 대상은 서버 판정(capacityCounted)을 따른다', () => {
  it('2풀을 더한다', () => {
    const inp = planInput(snapOf([POOL1, POOL2]));
    expect(inp.poolCount).toBe(2);
    expect(inp.countedPoolCount).toBe(2);
    expect(inp.excludedPoolCount).toBe(0);
    expect(inp.freeBytes).toBe(87568746020864 + 4818175094784);
    expect(verifyIdentity(inp).ok).toBe(true);
  });

  it('★ 집계에서 빠진 풀은 free·구독에서도 빠져 항등식이 유지된다', () => {
    const bad = { ...POOL2, usedBytes: null, capacityCounted: false };
    const inp = planInput(snapOf([POOL1, bad]));
    expect(inp.excludedPoolCount).toBe(1);
    expect(inp.freeBytes).toBe(87568746020864);      // pool_2 의 잔여를 더하지 않는다
    expect(verifyIdentity(inp).ok).toBe(true);        // v2.545 는 여기서 깨졌다
  });

  it('구버전 엣지(플래그 없음)는 전부 포함한다 — 산정이 통째로 사라지지 않는다', () => {
    const legacy = [{ ...POOL1, capacityCounted: undefined }, { ...POOL2, capacityCounted: undefined }];
    const inp = planInput(snapOf([POOL1, POOL2]));   // 합계는 같은 값으로 만든다
    const inp2 = planInput({ ...snapOf([POOL1, POOL2]), pools: legacy });
    expect(inp2.countedPoolCount).toBe(2);
    expect(inp2.freeBytes).toBe(inp.freeBytes);
  });
});

describe('★ 한계 1 — 다중 풀에서도 경고 임계 기준이 남는다', () => {
  it('풀 1개: 기준 3개 · 실질 한도는 경고 임계 47.6 TB (v2.540 실측 유지)', () => {
    const h = headroom(planInput(snapOf([POOL1])));
    expect(h.bases.map((b) => b.key)).toEqual(['physical', 'alert', 'subscription']);
    expect(h.limiting.key).toBe('alert');
    expect((h.limiting.availBytes / TIB).toFixed(1)).toBe('47.6');
  });

  it('풀 2개: 임계 기준이 사라지지 않고 **풀별 합**으로 남는다', () => {
    const h = headroom(planInput(snapOf([POOL1, POOL2])));
    const alert = h.bases.find((b) => b.key === 'alert');
    expect(alert).toBeTruthy();
    expect(alert.label).toBe('경고 임계까지(풀별 합)');
    // pool_1 은 47.6 TB 여유, pool_2 는 임계 초과(음수)라 0 으로 깎인다 → 47.6 TB
    expect((alert.availBytes / TIB).toFixed(1)).toBe('47.6');
    expect(h.limiting.key).toBe('alert');             // v2.545 는 'subscription'(84.7TB) 이었다
  });

  it('임계를 못 읽은 풀은 빼고 개수를 밝힌다', () => {
    const noThr = { ...POOL2, alertThresholdPct: null };
    const h = headroom(planInput(snapOf([POOL1, noThr])));
    const alert = h.bases.find((b) => b.key === 'alert');
    expect(alert.note).toMatch(/풀 1개는 \*\*빠졌습니다\*\*/);
  });

  it('풀 경계를 넘을 수 없다는 사실을 임계 합 문구가 밝힌다', () => {
    const h = headroom(planInput(snapOf([POOL1, POOL2])));
    expect(h.bases.find((b) => b.key === 'alert').note).toMatch(/한 덩어리로 쓸 수 있는 공간이 아닙니다/);
  });
});

describe('poolPressure — 전체는 여유인데 한 풀만 꽉 찬 경우(사용자 제안)', () => {
  it('풀마다 자기 임계로 판정한다', () => {
    const rows = poolPressure([POOL1, POOL2]);
    expect(rows.map((r) => r.state)).toEqual(['ok', 'over']);
    expect(rows[1].pct).toBe(91.8);
    expect(rows[1].thresholdPct).toBe(70);
  });

  it('임계 근접은 임계의 90% 지점부터다', () => {
    const near = { ...POOL1, usedBytes: Math.round(POOL1.totalBytes * 0.65) };  // 65% (임계 70 × 0.9 = 63)
    expect(poolPressure([near])[0].state).toBe('near');
  });

  it('★ 사용량·임계를 못 읽은 풀은 ok 가 아니라 unknown 이다', () => {
    expect(poolPressure([{ ...POOL1, usedBytes: null }])[0].state).toBe('unknown');
    expect(poolPressure([{ ...POOL1, alertThresholdPct: null }])[0].state).toBe('unknown');
  });

  it('전체 사용률과 함께 어느 풀이 문제인지 말한다', () => {
    const note = poolPressureNote(poolPressure([POOL1, POOL2]), 47.6);
    expect(note.kind).toBe('over');
    expect(note.text).toContain('전체는 47.6% 이지만');
    expect(note.text).toContain('pool_2');
    expect(note.text).toContain('pool_1');            // 여유가 있는 풀을 알려준다
  });

  it('풀이 1개면 문구를 만들지 않는다(전체 = 그 풀이다)', () => {
    expect(poolPressureNote(poolPressure([POOL1]), 25.5)).toBe(null);
  });

  it('전부 판정 불가면 이상 없음이라 말하지 않는다', () => {
    const rows = poolPressure([{ ...POOL1, usedBytes: null }, { ...POOL2, usedBytes: null }]);
    expect(poolPressureNote(rows, null).kind).toBe('unknown-only');
    expect(poolPressureNote(rows, null).text).toContain("'이상 없음' 이라는 뜻이 아닙니다");
  });
});

describe('★ 한계 2 — 공간은 풀 경계를 넘지 못한다', () => {
  it('풀 1개면 fitCount 와 개수가 같다(회귀 없음)', () => {
    const inp = planInput(snapOf([POOL1]));
    const h = headroom(inp);
    const unit = 200 * 1024 ** 3;
    expect(fitCount(h, unit).count).toBe(243);
    expect(fitCountByPool(h, inp.pools, unit).count).toBe(243);
  });

  it('작은 단위는 풀별 합과 합산 계산이 비슷하다', () => {
    const inp = planInput(snapOf([POOL1, POOL2]));
    const h = headroom(inp);
    const r = fitCountByPool(h, inp.pools, 200 * 1024 ** 3);
    expect(r.byPool.map((b) => b.name)).toEqual(['pool_1', 'pool_2']);
    expect(r.byPool[1].count).toBe(0);               // 임계를 넘은 풀에는 못 넣는다
    expect(r.count).toBe(243);
  });

  it('★ 합산 여유보다 큰 단위는 "어느 풀에도 안 들어간다" 고 말한다', () => {
    const inp = planInput(snapOf([POOL1, POOL2]));
    const h = headroom(inp);
    const unit = 60 * TIB;                            // 임계 합 47.6TB 보다 큼
    expect(fitCountByPool(h, inp.pools, unit).fitsSingle).toBe(false);
    expect((fitCountByPool(h, inp.pools, unit).maxSingleBytes / TIB).toFixed(1)).toBe('47.6');
  });

  it('물리 잔여 기준에서도 풀 경계가 지켜진다 — 합계 79.6+4.4 로 80TB 를 만들 수 없다', () => {
    const inp = planInput(snapOf([POOL1, POOL2]));
    const h = headroom(inp);
    const phys = { ...h, limiting: h.bases.find((b) => b.key === 'physical') };
    const unit = 80 * TIB;
    // 합산(84.0TB)으로는 1개가 들어가지만, 풀 경계를 지키면 0개다.
    expect(fitCount(phys, unit).count).toBe(1);
    expect(fitCountByPool(phys, inp.pools, unit).count).toBe(0);
    expect(fitCountByPool(phys, inp.pools, unit).fitsSingle).toBe(false);
  });

  it('그 기준으로 계산할 수 없는 풀은 개수를 밝힌다', () => {
    const inp = planInput({ ...snapOf([POOL1, POOL2]), pools: [POOL1, { ...POOL2, alertThresholdPct: null }] });
    const h = headroom(inp);
    const r = fitCountByPool(h, inp.pools, 200 * 1024 ** 3);
    expect(r.skippedPools).toBe(1);
  });
});
