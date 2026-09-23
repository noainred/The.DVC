/**
 * storageGrowthText.test.js — 스토리지 증가량 화면의 문구·서식 회귀(v2.531).
 * 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트 렌더는 못 본다 — 판정·문구를 여기서 고정한다.
 */
import { describe, it, expect } from 'vitest';
import {
  GROWTH_UNITS, bytesAuto, bytesIn, growthCell, totalCell,
  fullEtaText, headline, missingNote, heat, maxAbsFor,
  growthPct, growthPctText, aggregateGrowth, historyResetNote } from './storageGrowthText.js';

const TB = 1024 ** 4;
const GB = 1024 ** 3;

describe('단위 전환(사용자 요청 "1기가 단위/1TB 단위로 구분")', () => {
  it('GB/TB 를 고르면 **전 칸이 같은 단위**여서 세로 비교가 된다', () => {
    expect(bytesIn(5 * TB, 'gb')).toBe('5120.0 GB');
    expect(bytesIn(5 * TB, 'tb')).toBe('5.00 TB');
    expect(bytesIn(300 * GB, 'tb')).toBe('0.29 TB');   // 자동이었으면 'GB' 로 바뀌어 비교가 끊긴다
  });

  it('자동은 크기에 맞춰 축약한다', () => {
    expect(bytesAuto(5 * TB)).toBe('5.0 TB');
    expect(bytesAuto(300 * GB)).toBe('300.0 GB');
  });

  it('★ null 은 0 이 아니다 — 문자열 "0"이 아니라 null 을 돌려준다', () => {
    // ⚠ Number(null) === 0 이므로 `v == null` 을 먼저 봐야 한다(v2.525 에서 실제로 잡힌 결함).
    expect(bytesIn(null, 'tb')).toBeNull();
    expect(bytesAuto(null)).toBeNull();
    expect(bytesIn(0, 'tb')).toBe('0.00 TB');           // 0 은 값이다 — null 과 다르다
  });

  it('단위 표는 화면 토글의 단일 소스다', () => {
    expect(GROWTH_UNITS.map((u) => u.key)).toEqual(['auto', 'gb', 'tb']);
    for (const u of GROWTH_UNITS) expect(u.hint).toBeTruthy();   // 고르면 뭐가 달라지는지 말한다
  });
});

describe('증가량 칸', () => {
  it('★ 기준선이 없으면 "—" 이고 **왜** 없는지 말한다("0" 이라 쓰지 않는다)', () => {
    const c = growthCell({ bytes: null, reason: 'no-baseline' });
    expect(c.text).toBe('—');
    expect(c.tone).toBe('none');
    expect(c.title).toContain('기준선');
    expect(c.title).toContain('기다리면');
  });

  it('사유마다 다른 문구를 쓴다 — 조치가 다르기 때문이다', () => {
    expect(growthCell({ bytes: null, reason: 'no-latest-used' }).title).toContain('용량을 읽지 못');
    expect(growthCell({ bytes: null, reason: 'no-baseline-used' }).title).toContain('기준선 날짜');
  });

  it('증가는 +, 감소는 − 로 그대로 보여준다(감소를 숨기지 않는다)', () => {
    expect(growthCell({ bytes: 30 * TB, spanDays: 30, exact: true }, 'tb').text).toBe('+30.00 TB');
    expect(growthCell({ bytes: -5 * GB, spanDays: 7, exact: true }, 'gb').text).toBe('−5.0 GB');
    expect(growthCell({ bytes: -5 * GB }, 'gb').tone).toBe('down');
    expect(growthCell({ bytes: 0, spanDays: 1, exact: true }).text).toBe('0');
    expect(growthCell({ bytes: 0 }).tone).toBe('flat');
  });

  it('요청한 기간과 실제 구간이 다르면 설명에 적는다', () => {
    const c = growthCell({ bytes: TB, spanDays: 31, exact: false, baselineLabel: '2026-08-16' });
    expect(c.exact).toBe(false);
    expect(c.title).toContain('실제 구간 31일');
    expect(c.title).toContain('2026-08-16');
    expect(c.title).toContain('가장 가까운 날');
  });
});

describe('합계 칸', () => {
  it('★ 일부만 더했으면 몇 대를 더하고 몇 대를 뺐는지 말한다', () => {
    const c = totalCell({ bytes: 30 * TB, measured: 3, missing: 2, partial: true }, 'tb');
    expect(c.partial).toBe(true);
    expect(c.title).toContain('3대만 합산');
    expect(c.title).toContain('2대는');
    expect(c.title).toContain('전체 합이 아닙니다');
  });

  it('전부 더했으면 부분 표시를 하지 않는다', () => {
    expect(totalCell({ bytes: TB, measured: 5, missing: 0, partial: false }).partial).toBe(false);
  });

  it('한 대도 못 더했으면 그 사실을 말한다', () => {
    expect(totalCell({ bytes: null, measured: 0, missing: 4, partial: false }).title).toContain('4대 모두');
  });
});

describe('소진 예상', () => {
  it('★ 근거로 쓴 기간을 반드시 함께 적는다(1일 추세로 수년을 외삽하지 않게)', () => {
    const e = fullEtaText({ days: 400, basis: '30d', basisLabel: '1개월' });
    expect(e.text).toBe('약 1.1년');
    expect(e.title).toContain('1개월');
    expect(e.title).toContain('예측이 아니라');
  });

  it('값이 없으면 null 이다(0 일로 그리지 않는다)', () => {
    expect(fullEtaText(null)).toBeNull();
    expect(fullEtaText({ days: null })).toBeNull();
  });

  it('임박할수록 색이 세진다', () => {
    expect(fullEtaText({ days: 30, basisLabel: '1개월' }).tone).toBe('bad');
    expect(fullEtaText({ days: 200, basisLabel: '1개월' }).tone).toBe('warn');
    expect(fullEtaText({ days: 900, basisLabel: '1개월' }).tone).toBe('ok');
    expect(fullEtaText({ days: 0 }).text).toBe('이미 가득');
  });
});

describe('표제 문구', () => {
  it('★ DB 가 없으면 수치를 말하지 않는다 — 이력 자체가 없다', () => {
    const h = headline({ db: false, devices: [], totals: {} });
    expect(h.kind).toBe('no-db');
    expect(h.body).toContain('저장되지 않고');
  });

  it('이력이 없으면 "기다리면 되는지" 를 말한다', () => {
    const h = headline({ db: true, devices: [], totals: {} });
    expect(h.kind).toBe('empty');
    expect(h.body).toContain('기간 비교는');
  });

  it('v2.598 WEBUI-2598-05: 등록 장비가 0대면 "기다리면 쌓인다" 가 아니라 등록을 안내한다', () => {
    const h = headline({ db: true, devices: [], noHistory: [], totals: {} });
    expect(h.kind).toBe('no-devices');
    expect(h.body).toContain('스토리지 모니터링');
    expect(h.body).not.toContain('기간 비교는');
    // 등록은 됐는데 이력이 없으면 예전 대기 문구
    expect(headline({ db: true, devices: [], noHistory: [{ id: 'a' }], totals: {} }).kind).toBe('empty');
  });

  it('사용량을 읽지 못한 장비가 있으면 합계에서 뺐다고 적는다', () => {
    const h = headline({ db: true, asOfLabel: '2026-09-16', devices: [{}, {}],
      totals: { usedBytes: TB, totalBytes: 2 * TB, pct: 50, unknownUsed: 1 } });
    expect(h.body).toContain('읽지 못한 장비');
    expect(h.title).toContain('2026-09-16');
  });
});

describe('표에 없는 장비', () => {
  it('★ 조용히 빼지 않는다 — 꺼진 장비와 이력 없는 장비를 구분해 말한다', () => {
    const n = missingNote([{ id: 'a', name: 'A', enabled: true }, { id: 'b', name: 'B', enabled: false }]);
    expect(n.count).toBe(2);
    expect(n.text).toContain('1대**는 등록돼 있지만');
    expect(n.text).toContain('1대**는 등록이 꺼져');
    expect(n.names).toEqual(['A', 'B']);
  });

  it('없으면 null(빈 문단을 만들지 않는다)', () => {
    expect(missingNote([])).toBeNull();
    expect(missingNote(null)).toBeNull();
  });

  it('20대를 넘으면 생략 개수를 밝힌다', () => {
    const n = missingNote(Array.from({ length: 25 }, (_, i) => ({ id: `d${i}`, name: `D${i}`, enabled: true })));
    expect(n.names).toHaveLength(20);
    expect(n.omitted).toBe(5);
  });
});

describe('히트맵', () => {
  it('열마다 따로 정규화한다 — 1일 열과 1년 열을 같은 척도로 칠하면 1일 열이 전부 하얘진다', () => {
    const devices = [{ growth: { '1d': { bytes: 1 * GB } } }, { growth: { '1d': { bytes: 2 * GB } } }];
    expect(maxAbsFor(devices, '1d')).toBe(2 * GB);
    expect(heat(1 * GB, 2 * GB)).toBe(0.5);
    expect(heat(null, 2 * GB)).toBe(0);      // 값 없음은 칠하지 않는다
    expect(heat(5 * GB, 2 * GB)).toBe(1);    // 상한을 넘지 않는다
  });

  it('감소도 크기로 친다(절대값)', () => {
    expect(maxAbsFor([{ growth: { x: { bytes: -3 * GB } } }], 'x')).toBe(3 * GB);
  });
});

/* ══ v2.532 — 증가율(%)·집계 ═══════════════════════════════════════════════ */

describe('증가율(%) — 사용자 요청 "퍼센트와 용량으로 2줄"', () => {
  it('★ 분모는 **기준선 사용량**이다(전체 용량이 아니다)', () => {
    // 455TB 를 쓰는 장비가 30TB 늘었다 → 기준선은 425TB → 30/425 = 7.1%
    expect(growthPct({ bytes: 30 * TB }, 455 * TB)).toBe(7.1);
    // 전체 용량(500TB)을 분모로 쓰면 6.0% 가 되어 같은 증가가 작아 보인다 — 그렇게 하지 않는다.
    expect(growthPct({ bytes: 30 * TB }, 455 * TB)).not.toBe(6);
  });

  it('★ 기준선 사용량이 0 이면 null — 0 에서 늘어난 비율은 무한대다(숫자를 지어내지 않는다)', () => {
    expect(growthPct({ bytes: 5 * TB }, 5 * TB)).toBeNull();
    expect(growthPct({ bytes: 10 * TB }, 5 * TB)).toBeNull();   // 기준선이 음수가 되는 경우도
  });

  it('증가량이 없으면 null(0% 가 아니다)', () => {
    expect(growthPct({ bytes: null }, 100 * TB)).toBeNull();
    expect(growthPct(null, 100 * TB)).toBeNull();
    expect(growthPct({ bytes: 1 }, null)).toBeNull();
  });

  it('감소는 음수 %, 변화 없음은 0%', () => {
    expect(growthPct({ bytes: -10 * TB }, 90 * TB)).toBe(-10);
    expect(growthPctText(-10)).toBe('−10.0%');
    expect(growthPctText(0)).toBe('0.0%');
    expect(growthPctText(7.1)).toBe('+7.1%');
    expect(growthPctText(null)).toBeNull();
  });
});

describe('집계 — 법인별·종류별 (서버 totalsOf 와 같은 규칙)', () => {
  const per = [{ key: '30d', days: 30, label: '1개월' }];
  const dev = (used, total, bytes) => ({ usedBytes: used, totalBytes: total, growth: { '30d': { bytes } } });

  it('★ 기준선이 있는 장비만 더하고 **뺀 수를 밝힌다**', () => {
    const a = aggregateGrowth([dev(10 * TB, 20 * TB, 2 * TB), dev(5 * TB, 10 * TB, null)], per);
    expect(a.growth['30d'].bytes).toBe(2 * TB);
    expect(a.growth['30d'].measured).toBe(1);
    expect(a.growth['30d'].missing).toBe(1);
    expect(a.growth['30d'].partial).toBe(true);
  });

  it('전부 기준선이 없으면 0 이 아니라 null', () => {
    const a = aggregateGrowth([dev(10 * TB, 20 * TB, null)], per);
    expect(a.growth['30d'].bytes).toBeNull();
    expect(a.growth['30d'].partial).toBe(false);
  });

  it('★ 사용량을 못 읽은 장비는 합계에서 빼고 그 수를 밝힌다(0 으로 더하지 않는다)', () => {
    const a = aggregateGrowth([dev(10 * TB, 20 * TB, 1), dev(null, 5 * TB, 1)], per);
    expect(a.usedBytes).toBe(10 * TB);
    expect(a.totalBytes).toBe(25 * TB);
    expect(a.unknownUsed).toBe(1);
  });

  it('전부 null 이면 합계도 null — 0 은 "용량 0" 이라는 거짓', () => {
    const a = aggregateGrowth([dev(null, null, null)], per);
    expect(a.usedBytes).toBeNull();
    expect(a.totalBytes).toBeNull();
    expect(a.pct).toBeNull();
  });

  it('빈 목록도 터지지 않는다', () => {
    const a = aggregateGrowth([], per);
    expect(a.devices).toBe(0);
    expect(a.growth['30d'].bytes).toBeNull();
  });
});

describe('이력 재시작 안내(v2.534)', () => {
  it('★ 측정 기준이 바뀐 장비는 그 사실을 말한다 — 조용한 삭제 금지', () => {
    const n = historyResetNote({ at: Date.UTC(2026, 8, 16, 3), reason: 'VMAX 기준 변경', rows: 1234 });
    expect(n.badge).toBe('기준 변경');
    expect(n.title).toMatch(/2026-09-16/);
    expect(n.title).toMatch(/VMAX 기준 변경/);
    expect(n.title).toMatch(/1,234행/);
    expect(n.title).toMatch(/이어서 비교할 수 없습니다/);
  });

  it('지운 행이 0 이면 행 수를 적지 않는다(새 장비와 문구가 같아지지 않게)', () => {
    const n = historyResetNote({ at: Date.UTC(2026, 8, 16), reason: 'r', rows: 0 });
    expect(n.title).not.toMatch(/행 삭제/);
  });

  it('기록이 없으면 null — 배지를 만들지 않는다', () => {
    expect(historyResetNote(null)).toBe(null);
    expect(historyResetNote(undefined)).toBe(null);
    expect(historyResetNote({ reason: 'x' })).toBe(null);
  });
});

// ── v2.541: '기준 변경' 과 '이력 정리' 를 한 배지로 덮지 않는다 ──────────────────────
// 두 문구는 뜻이 정반대다 — 전자는 남은 값과 **이어서 비교할 수 없다**, 후자는 0 바이트 행만
// 지웠으므로 **남은 값은 그대로 유효**하다. 섞으면 멀쩡한 이력을 못 믿게 만든다.
describe('historyResetNote — 정리 종류 구분(v2.541)', () => {
  const at = Date.parse('2026-09-17T01:00:00Z');
  it('0 바이트 행 정리는 "이력 정리" 이고 남은 값이 유효하다고 말한다', () => {
    const n = historyResetNote({ at, rows: 3, kind: 'zero-rows', reason: '수집 실패 스냅샷' });
    expect(n.badge).toBe('이력 정리');
    expect(n.title).toMatch(/남아 있는 값은 그대로 유효/);
    expect(n.title).not.toMatch(/이어서 비교할 수 없/);
  });
  it('kind 가 없는 옛 기록은 기존대로 "기준 변경" 이다(하위호환)', () => {
    const n = historyResetNote({ at, rows: 12, reason: 'VMAX 기준 변경' });
    expect(n.badge).toBe('기준 변경');
    expect(n.title).toMatch(/이어서 비교할 수 없/);
  });
  it('시각이 없으면 배지를 만들지 않는다', () => {
    expect(historyResetNote(null)).toBe(null);
    expect(historyResetNote({ rows: 3 })).toBe(null);
  });
});
