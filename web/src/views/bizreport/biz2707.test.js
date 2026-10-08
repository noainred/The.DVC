// v2.707 — C6·C11·C7 문구. 이전 준비도 코드·비용 기준 키는 서버와 1:1(번들 경계라 두 벌 — 대조).
import { describe, it, expect } from 'vitest';
import { MIG_CODES, MIG_TEXT, LEVEL_LABEL, unknownNote, readyPctText } from './migrationText.js';
import * as smig from '../../../../server/src/migration/analyze.js';
import { GROUP_LABEL, OFF_POLICY_LABEL, STORAGE_BASIS_LABEL, moneyText, numText, ratesNote, notesText } from './costText.js';
import { GROUP_KINDS } from '../../../../server/src/cost/analyze.js';
import { OFF_POLICIES, STORAGE_BASES } from '../../../../server/src/cost/settings.js';
import { pctText, downText, allowedDownMin, coverageNote } from './availText.js';

const noTick = (o) => Object.values(o).every((t) => !/[`*]/.test(typeof t === 'string' ? t : `${t.title}${t.fix}`));

describe('migrationText', () => {
  it('코드·등급 — 서버와 같다 · 문구 키 1:1', () => {
    expect(MIG_CODES).toEqual(smig.MIG_CODES);
    expect(Object.keys(MIG_TEXT).sort()).toEqual(Object.keys(smig.MIG_CODES).sort());
    expect(Object.keys(LEVEL_LABEL).sort()).toEqual([...smig.MIG_LEVELS].sort());
    expect(noTick(MIG_TEXT)).toBe(true);
  });
  it('판정 불가 안내·준비율', () => {
    expect(unknownNote({ counts: { unknown: 0 } })).toBeNull();
    expect(unknownNote({ counts: { unknown: 3 } })).toMatch(/판정 불가/);
    expect(readyPctText(null)).toBe('—');
    expect(readyPctText(33.3)).toBe('33.3%');
  });
});

describe('costText', () => {
  it('기준 키 — 서버와 같다', () => {
    expect(Object.keys(GROUP_LABEL).sort()).toEqual([...GROUP_KINDS].sort());
    expect(Object.keys(OFF_POLICY_LABEL).sort()).toEqual([...OFF_POLICIES].sort());
    expect(Object.keys(STORAGE_BASIS_LABEL).sort()).toEqual([...STORAGE_BASES].sort());
  });
  it('값이 없으면 — 이고 단위·통화를 붙이지 않는다 · 0 은 값이다', () => {
    expect(moneyText(null, 'KRW')).toBe('—');
    expect(moneyText(0, 'KRW')).toBe('0 KRW');
    expect(numText(undefined, ' GB')).toBe('—');
    expect(numText(1.25, ' GB')).toBe('1.3 GB');
  });
  it('단가 안내 — 없음·일부·전부', () => {
    expect(ratesNote({ ratesSet: 0 })).toMatch(/할당량만/);
    expect(ratesNote({ ratesSet: 1, partialRates: true, rates: { vcpu: 1, ramGB: null, storageGB: null } })).toMatch(/메모리·스토리지/);
    expect(ratesNote({ ratesSet: 3, partialRates: false })).toBeNull();
    expect(notesText({ notes: {} })).toBeNull();
    expect(notesText({ notes: { multiTag: 2 } })).toMatch(/두 번 세지 않습니다/);
  });
});

describe('availText', () => {
  it('가동률·정지 시간 표시', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText(99.9)).toBe('99.9%');
    expect(pctText(100)).toBe('100%');
    expect(downText(0)).toBe('0분');
    expect(downText(90 * 60_000)).toBe('90분');
    expect(downText(5 * 3_600_000)).toBe('5시간');
    expect(downText(NaN)).toBe('—');
    expect(allowedDownMin(99.9, 30)).toBe(43.2);
  });
  it('측정 범위 안내 — 판정하지 않은 VM 을 100% 라 하지 않는다', () => {
    expect(coverageNote({ logs: { enabled: false } })).toMatch(/꺼져/);
    expect(coverageNote({ coverage: { noEvents: 2 } })).toMatch(/100% 가 아닙니다/);
    expect(coverageNote({ coverage: {} })).toBeNull();
  });
});

describe('v2.719 가용성 판정 보류 사유 문구', () => {
  it('끔 놓침·시계 앞섬·잘린 시점부터를 말한다', async () => {
    const { coverageNote } = await import('./availText.js');
    const n = coverageNote({ coverage: { missedOff: 2, clockSkew: 1, readCut: 3 }, truncated: true, readMax: 50000 });
    expect(n).toMatch(/언제 꺼졌는지 알 수 없어/);
    expect(n).toMatch(/앞서 측정 구간이 없는 VM 1대/);
    expect(n).toMatch(/잘린 시점부터만 쟀습니다\(VM 3대\)/);
    expect(n).not.toMatch(/빠졌을 수 있습니다/);
  });
});

// v2.721(감사 B1-01·B1-05) — 비용 배분 문구: 부분 읽기 태그·vCPU·메모리 미상 VM 을 말한다.
describe('costText v2.721', () => {
  it('B1-05 cpuUnknown 을 말한다 · B1-01 tagPartial 을 (태그 없음) 과 구분해 말한다', () => {
    expect(notesText({ notes: { cpuUnknown: 3 } })).toMatch(/vCPU·메모리를 모르는 VM 3대는 vCPU·메모리 합계·비용에서 빠졌습니다/);
    const t = notesText({ notes: { tagPartial: 2 } });
    expect(t).toMatch(/일부만 읽은 vCenter/);
    expect(t).toMatch(/2대/);
    expect(t).toMatch(/태그가 없다는 뜻이 아닙니다/);
    expect(t.includes('`')).toBe(false);
  });
});

// v2.727(감사 C-04): 부분 합 VM 을 한 줄로 말한다 — thin 여유 모름 · 할당 일부 모름.
describe('costText v2.727', () => {
  it('provisionedPartial · partialVms 를 말한다', () => {
    const t = notesText({ notes: { provisionedPartial: 2, partialVms: 3 } });
    expect(t).toMatch(/thin 여유를 모르는 VM 2대/);
    expect(t).toMatch(/할당 일부를 모르는 VM 3대/);
    expect(t).toMatch(/부분 합/);
    expect(t.includes('`')).toBe(false);
    expect(notesText({ notes: { provisionedPartial: 0, partialVms: 0 } })).toBeNull();
  });
});
