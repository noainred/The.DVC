/**
 * unityCapacityPlan.test.js — Unity 용량 산정(v2.540) 회귀 고정.
 *
 * 숫자는 **사용자가 제공한 실장비 출력**(Unity OC2-41.237, pool_1)이다. 화면 표기와 나란히 둔다:
 *   Total space        117544396521472 (106.9T)
 *   Current allocation  29973250195456 (27.2T)
 *   Preallocated            2400305152 (2.2G)
 *   Remaining space     87568746020864 (79.6T)
 *   Subscription        55491782770688 (50.4T)  · Subscription percent 47% · Alert threshold 70%
 *   Drives `38 x 3.8T SAS Flash 4` · RAID 5 · Stripe 9
 */
import { describe, it, expect } from 'vitest';
import {
  posNum, parseDrives, rawCapacity, verifyIdentity, headroom, fitCount, trendPerDay, runway,
  planInput, tb, sizeText, daysText,
} from './unityCapacityPlan.js';

const TIB = 1024 ** 4;
const REAL = {
  totalBytes: 117544396521472,
  usedBytes: 29973250195456,
  freeBytes: 87568746020864,
  preallocatedBytes: 2400305152,
  subscribedBytes: 55491782770688,
  alertThresholdPct: 70,
  drives: '38 x 3.8T SAS Flash 4',
  raid: '5',
  stripeLength: 9,
};

describe('posNum — 0·null·음수는 null(Number(null)===0 함정)', () => {
  it('유한 양수만 통과한다', () => {
    expect(posNum(5)).toBe(5);
    expect(posNum('5')).toBe(5);
    expect(posNum(0)).toBe(null);      // 0 을 '값 있음' 으로 쓰면 나눗셈이 Infinity 가 된다
    expect(posNum(null)).toBe(null);
    expect(posNum(undefined)).toBe(null);
    expect(posNum(-3)).toBe(null);
    expect(posNum('x')).toBe(null);
  });
});

describe('항등식 — 할당 + 잔여 + 선할당 = 전체(실측 오차 0)', () => {
  it('실장비 값은 통과한다', () => {
    const r = verifyIdentity(REAL);
    expect(r.ok).toBe(true);
    expect(Math.abs(r.diffBytes)).toBe(0);
  });
  it('필드를 잘못 읽으면(구독을 사용량으로) 어긋난 사실을 말한다', () => {
    const r = verifyIdentity({ ...REAL, usedBytes: REAL.subscribedBytes });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('필드를 잘못 읽었을 수 있어');
  });
  it('검사할 값이 없으면 통과시킨다(모르는 것을 틀렸다고 하지 않는다)', () => {
    expect(verifyIdentity({ totalBytes: 100 }).ok).toBe(true);
    expect(verifyIdentity({ totalBytes: 100 }).text).toBe(null);
  });
});

describe('① 할당 가능량 — 기준마다 답이 다르고, 가장 작은 것이 실질 한도', () => {
  const h = headroom(REAL);
  it('세 기준을 전부 낸다', () => {
    expect(h.bases.map((b) => b.key)).toEqual(['physical', 'alert', 'subscription']);
  });
  it('물리 잔여 = 79.6 TB(장비 보고와 일치)', () => {
    expect(tb(h.bases[0].availBytes)).toBe('79.6 TB');
  });
  it('경고 임계(70%)까지 = 전체×0.7 − 할당 = 47.6 TB', () => {
    const want = REAL.totalBytes * 0.7 - REAL.usedBytes;
    expect(h.bases[1].availBytes).toBeCloseTo(want, 0);
    expect(tb(h.bases[1].availBytes)).toBe('47.6 TB');
  });
  it('구독이 다 채워지면 = 전체 − 구독 = 56.4 TB', () => {
    expect(tb(h.bases[2].availBytes)).toBe('56.4 TB');
  });
  it('★ 실질 한도는 가장 작은 기준(여기서는 경고 임계) — 물리 잔여만 보면 79.6 TB 로 과대평가한다', () => {
    expect(h.limiting.key).toBe('alert');
    expect(tb(h.limiting.availBytes)).toBe('47.6 TB');
  });
  it('오버프로비저닝이면 구독 기준이 음수가 될 수 있고 그것을 사실대로 말한다', () => {
    const over = headroom({ ...REAL, subscribedBytes: REAL.totalBytes * 1.5 });
    const sub = over.bases.find((b) => b.key === 'subscription');
    expect(sub.availBytes).toBeLessThan(0);
    expect(sub.note).toContain('오버프로비저닝');
    expect(over.limiting.key).toBe('subscription');
  });
  it('임계값·구독을 모르면 그 기준을 만들지 않는다(지어내지 않는다)', () => {
    const h2 = headroom({ totalBytes: REAL.totalBytes, usedBytes: REAL.usedBytes, freeBytes: REAL.freeBytes });
    expect(h2.bases.map((b) => b.key)).toEqual(['physical']);
  });
  it('용량을 못 읽었으면 null', () => {
    expect(headroom({ totalBytes: 0, usedBytes: 1 })).toBe(null);
    expect(headroom({ totalBytes: REAL.totalBytes, usedBytes: null })).toBe(null);
  });
});

describe('③ 수용 개수 — 실질 한도 기준으로 센다', () => {
  const h = headroom(REAL);
  it('200GB 짜리는 243개(47.6 TiB ÷ 200 GiB)', () => {
    const f = fitCount(h, 200 * 1024 ** 3);
    expect(f.count).toBe(Math.floor(h.limiting.availBytes / (200 * 1024 ** 3)));
    expect(f.count).toBe(243);
    expect(f.basisKey).toBe('alert');          // 물리 잔여(407개)가 아니라 실질 한도로 센다
  });
  it('물리 잔여로 세면 더 많다 — 기준을 밝히지 않으면 거짓이 된다', () => {
    const byPhysical = Math.floor(REAL.freeBytes / (200 * 1024 ** 3));
    expect(byPhysical).toBeGreaterThan(243);
  });
  it('단위가 없거나 0 이면 null', () => {
    expect(fitCount(h, 0)).toBe(null);
    expect(fitCount(h, null)).toBe(null);
    expect(fitCount(null, 100)).toBe(null);
  });
});

describe('④ 원시·유효 용량 — 추정이라고 말한다', () => {
  const r = rawCapacity({ ...REAL, deviceUsableBytes: REAL.totalBytes });
  it('드라이브 문자열을 읽는다', () => {
    expect(r.drives.count).toBe(38);
    expect(r.drives.model).toBe('SAS Flash 4');
  });
  it('RAID5 stripe 9 → 패리티 제외 8/9', () => {
    expect(r.parityShare).toBeCloseTo(8 / 9, 6);
  });
  it('★ 원시 추정은 범위이고 exact:false — 장비 보고(106.9 TB)와 맞지 않는다', () => {
    expect(r.exact).toBe(false);
    expect(r.rawLow).toBeLessThan(r.rawHigh);
    // 10진 해석 131.3 TiB · TiB 해석 144.4 TiB — 둘 다 장비 보고 106.9 보다 크다
    expect(tb(r.rawLow)).toBe('131.3 TB');
    expect(tb(r.rawHigh)).toBe('144.4 TB');
    expect(r.deviceUsableBytes).toBe(REAL.totalBytes);
    expect(r.usableShareLow).toBeLessThan(r.usableShareHigh);   // 74.0% ~ 81.4%
    expect(r.note).toContain('추정');
    expect(r.note).toContain('장비가 보고한 전체 용량');
  });
  it('RAID 수준을 모르면 패리티 비율을 계산하지 않는다', () => {
    expect(rawCapacity({ drives: REAL.drives, raid: 'X', stripeLength: 9 }).parityShare).toBe(null);
    expect(rawCapacity({ drives: REAL.drives, raid: '6', stripeLength: 9 }).parityShare).toBeCloseTo(7 / 9, 6);
  });
  it('드라이브 문자열이 없거나 형식이 다르면 null(패널이 그리지 않는다)', () => {
    expect(rawCapacity({ drives: '' })).toBe(null);
    expect(rawCapacity({ drives: 'unknown drives' })).toBe(null);
    expect(parseDrives('38 x 3.8T')).toMatchObject({ count: 38, model: null });
  });
});

describe('② 추세·소진 예상 — 증가 중일 때만, 근거 기간과 함께', () => {
  const day = 86_400_000;
  const now = 1_700_000_000_000;
  const rising = Array.from({ length: 8 }, (_, i) => ({ ts: now - (7 - i) * day, used_bytes: REAL.usedBytes + i * 0.5 * TIB }));

  it('하루 0.5 TB 증가를 읽는다', () => {
    const t = trendPerDay(rising);
    expect(t.samples).toBe(8);
    expect(t.spanDays).toBe(7);
    expect(t.perDayBytes).toBeCloseTo(0.5 * TIB, -6);
    expect(t.weak).toBe(false);
    expect(t.r2).toBe(1);
  });
  it('★ 임계·소진 도달일을 낸다 — 근거 기간을 함께', () => {
    const w = runway({ ...REAL, trend: trendPerDay(rising), now });
    expect(w.toAlert.thresholdPct).toBe(70);
    // 임계까지 47.6 TiB · 하루 0.5 TiB → 약 95일
    expect(Math.round(w.toAlert.days)).toBe(95);
    // 100% 까지 79.6 TiB → 약 159일
    expect(Math.round(w.toFull.days)).toBe(159);
    expect(w.basis).toContain('최근 7일');
    expect(w.basis).toContain('관측 8점');
  });
  it('★ 감소 추세면 소진 시점을 내지 않는다(외삽 금지)', () => {
    const falling = rising.map((p, i) => ({ ...p, used_bytes: REAL.usedBytes - i * 0.2 * TIB }));
    const w = runway({ ...REAL, trend: trendPerDay(falling), now });
    expect(w.toFull).toBe(null);
    expect(w.reason).toContain('줄고 있어');
  });
  it('★ 표본이 적으면 추세를 냈더라도 weak 로 밝힌다', () => {
    const few = [{ ts: now - day, used_bytes: REAL.usedBytes }, { ts: now, used_bytes: REAL.usedBytes + TIB }];
    const t = trendPerDay(few);
    expect(t.weak).toBe(true);
    expect(t.reason).toContain('부족합니다');
    expect(runway({ ...REAL, trend: t, now }).weak).toBe(true);
  });
  it('표본이 없으면 사유를 말한다(0 으로 채우지 않는다)', () => {
    expect(trendPerDay([])).toBe(null);
    expect(trendPerDay(null)).toBe(null);
    const w = runway({ ...REAL, trend: null });
    expect(w.toFull).toBe(null);
    expect(w.reason).toContain('표본이 없어');
  });
  it('이미 임계를 넘었으면 passed 로 말한다', () => {
    const w = runway({ ...REAL, usedBytes: REAL.totalBytes * 0.8, trend: trendPerDay(rising), now });
    expect(w.toAlert.passed).toBe(true);
    expect(w.toFull.passed).toBe(false);
  });
});

describe('planInput — 스냅샷에서 뽑기', () => {
  const snap = {
    capacity: { totalBytes: REAL.totalBytes, usedBytes: REAL.usedBytes },
    pools: [{ name: 'pool_1', freeBytes: REAL.freeBytes, alertThresholdPct: 70, drives: REAL.drives, raid: '5', stripeLength: 9 }],
    extra: { subscribedBytes: REAL.subscribedBytes, preallocatedBytes: REAL.preallocatedBytes },
  };
  it('단일 풀이면 임계·RAID·드라이브를 쓴다', () => {
    const i = planInput(snap);
    expect(i.alertThresholdPct).toBe(70);
    expect(i.drives).toBe(REAL.drives);
    expect(i.multiPool).toBe(false);
    expect(verifyIdentity(i).ok).toBe(true);
  });
  it('★ 풀이 여러 개면 임계·RAID 를 만들지 않는다(대표값은 거짓이 된다)', () => {
    const i = planInput({ ...snap, pools: [snap.pools[0], { name: 'pool_2', freeBytes: 1e12, alertThresholdPct: 85, raid: '6' }] });
    expect(i.multiPool).toBe(true);
    expect(i.poolCount).toBe(2);
    expect(i.alertThresholdPct).toBe(null);
    expect(i.raid).toBe(null);
    expect(i.drives).toBe(null);
    // 그래도 물리 잔여 기준은 낼 수 있다
    expect(headroom(i).bases.map((b) => b.key)).toEqual(['physical', 'subscription']);
  });
  it('용량이 없으면 totalBytes 가 null 이라 패널이 그리지 않는다', () => {
    expect(planInput({ capacity: { totalBytes: 0, usedBytes: 0 }, pools: [] }).totalBytes).toBe(null);
    expect(planInput(null)).toBe(null);
  });
});

describe('표기', () => {
  it('TB 는 TiB 기준(장비 표기와 같게)', () => {
    expect(tb(REAL.totalBytes)).toBe('106.9 TB');   // 장비 화면의 (106.9T) 와 일치
    expect(tb(REAL.usedBytes)).toBe('27.3 TB');     // 장비 반올림 27.2T ↔ 소수 1자리 27.3 — 같은 값
    expect(tb(null)).toBe('—');
  });
  it('★ 크기는 단위를 자동으로 고른다 — 200GB 를 `0.20 TB` 로 쓰지 않는다(v2.540 Chromium 판독)', () => {
    expect(sizeText(200 * 1024 ** 3)).toBe('200 GB');
    expect(sizeText(1024 ** 3)).toBe('1.0 GB');
    expect(sizeText(2 * TIB)).toBe('2.00 TB');
    expect(sizeText(REAL.totalBytes)).toBe('106.9 TB');
    expect(sizeText(500 * 1024 ** 2)).toBe('500 MB');
    expect(sizeText(null)).toBe('—');            // Number(null)===0 함정
    expect(sizeText(0)).toBe('0 B');
  });

  it('기간은 사람 말로', () => {
    expect(daysText(3.5)).toBe('3.5일');
    expect(daysText(95)).toBe('3.1개월');
    expect(daysText(400)).toBe('1.1년');
    expect(daysText(99999)).toBe('10년 이상');
    expect(daysText(null)).toBe('—');
  });
});
