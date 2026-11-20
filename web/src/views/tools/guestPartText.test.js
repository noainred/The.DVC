import { describe, it, expect } from 'vitest';
import {
  levelOf, gbText, pctText, growthText, etaText, osLabel, timeText, daysLabel, splitEmails, isWinPattern, isLnxPattern,
  overviewParams, sortRows, historyLine, collectNote, agoText, vmPartNote, vmSumText, unknownVmsText,
} from './guestPartText.js';

// v2.749 — 게스트 파티션 사용률 화면 판정(순수). 패턴 검사는 서버 guestpart/rules.js 와 같은 입력·같은 결과(서버 테스트가 같은 표를 쓴다).

describe('색 단계·값 표기', () => {
  it('95 위험 · 90 경고 · 임계 주의 · 그 밖 정상 · 모르면 표지 없음', () => {
    expect(levelOf(95, 80).tag).toBe('위험');
    expect(levelOf(90, 80).tag).toBe('경고');
    expect(levelOf(85, 80).tag).toBe('주의');
    expect(levelOf(79.9, 80).tag).toBe('');
    expect(levelOf(86, 85).tag).toBe('주의');
    expect(levelOf(null, 80).tone).toBe('none');
    expect(levelOf('', 80).tone).toBe('none');
  });
  it('값이 없으면 단위 없이 — · 0 은 0', () => {
    expect(gbText(null)).toBe('—');
    expect(gbText(0)).toBe('0.0 GB');
    expect(gbText(2048)).toBe('2.0 TB');
    expect(pctText(null)).toBe('—');
    expect(pctText(80)).toBe('80.0%');
    expect(growthText(null)).toBe('—');
    expect(growthText(0)).toBe('증가 없음');
    expect(growthText(3)).toBe('+3.0 GB');
    expect(etaText(null)).toBe('—');
    expect(etaText(0.4)).toBe('1일 안');
    expect(etaText(12.4)).toBe('12일 뒤');
    expect(etaText(400)).toBe('1년 이상');
    expect(osLabel('win')).toBe('Windows');
    expect(osLabel('zzz')).toBe('기타');
  });
  it('시각은 서버 오프셋(한국) 기준', () => {
    expect(timeText(Date.UTC(2026, 9, 20, 15, 0), 540)).toBe('10-21 00:00');
    expect(timeText(null)).toBe('—');
  });
});

describe('입력 보조', () => {
  it('요일 표기', () => {
    expect(daysLabel([1, 2, 3, 4, 5])).toBe('평일');
    expect(daysLabel([0, 1, 2, 3, 4, 5, 6])).toBe('매일');
    expect(daysLabel([1, 3])).toBe('월·수');
    expect(daysLabel([])).toBe('요일 없음');
  });
  it('주소 목록 나누기(형식 판정은 서버)', () => {
    expect(splitEmails('a@x.co, b@x.co;c@x.co\nd@x.co  a@x.co')).toEqual(['a@x.co', 'b@x.co', 'c@x.co', 'd@x.co']);
    expect(splitEmails('')).toEqual([]);
  });
  it('패턴 검사 — 서버와 같은 표', () => {
    const win = [['C:\\ClusterStorage\\*', true], ['e:\\Backup', true], ['\\\\?\\Volume*', true], ['/data', false], ['Backup', false]];
    for (const [s, ok] of win) expect(isWinPattern(s)).toBe(ok);
    const lnx = [['/opt/backup/*', true], ['/data', true], ['data', false], ['/a b', false], ['C:\\x', false]];
    for (const [s, ok] of lnx) expect(isLnxPattern(s)).toBe(ok);
  });
});

describe('조회 조건·정렬·문구', () => {
  it('기본 임계는 보내지 않고(서버가 vCenter 별 임계를 쓰게) 고른 값만 보낸다', () => {
    expect(overviewParams({ thr: null, mode: null, os: 'all', q: ' ' })).toEqual({});
    expect(overviewParams({ thr: 90, mode: 'vm', os: 'win', q: 'db' })).toEqual({ thr: '90', mode: 'vm', os: 'win', q: 'db' });
  });
  it('정렬 — 값 없는 행은 항상 뒤로', () => {
    const rows = [{ pct: 85, freeGB: 5, etaDays: null }, { pct: 95, freeGB: null, etaDays: 3 }, { pct: 90, freeGB: 1, etaDays: 10 }];
    expect(sortRows(rows, 'pct').map((r) => r.pct)).toEqual([95, 90, 85]);
    expect(sortRows(rows, 'free').map((r) => r.freeGB)).toEqual([1, 5, null]);
    expect(sortRows(rows, 'eta').map((r) => r.etaDays)).toEqual([3, 10, null]);
  });
  it('메일 기록 한 줄 — 주소 없이 개수만', () => {
    expect(historyLine({ kind: 'schedule', scope: '전체 법인', count: 12, recipients: 3 })).toBe('정기 · 전체 법인 · 대상 12개 · 3명');
    expect(historyLine({ kind: 'scan', scope: 'vc-1', reason: '받는 사람이 없습니다' }, () => 'VC-SEOUL')).toBe('수집 직후 · VC-SEOUL — 받는 사람이 없습니다');
  });
  it('수집 안내 — 값이 없는 이유를 아는 만큼만', () => {
    expect(collectNote({ dbAvailable: false })).toMatch(/DB/);
    expect(collectNote({ dbAvailable: true, empty: true, enabled: false })).toMatch(/꺼져/);
    expect(collectNote({ dbAvailable: true, empty: true, enabled: true })).toMatch(/첫 수집 전/);
    expect(collectNote({ dbAvailable: true, empty: false, enabled: true })).toBe('');
  });
});

describe('v2.750 VM 상세 파티션 안내', () => {
  const NOW = Date.UTC(2026, 9, 21, 9, 0);
  it('경과 문구', () => {
    expect(agoText(null, NOW)).toBe('');
    expect(agoText(NOW + 5000, NOW)).toBe('방금');
    expect(agoText(NOW - 5 * 60_000, NOW)).toBe('5분 전');
    expect(agoText(NOW - 3 * 3_600_000, NOW)).toBe('3시간 전');
    expect(agoText(NOW - 3 * 86_400_000, NOW)).toBe('3일 전');
  });
  it('값이 없는 이유 — 아는 것만', () => {
    expect(vmPartNote({ dbAvailable: false }, NOW).empty).toMatch(/DB/);
    expect(vmPartNote({ dbAvailable: true, collectedAt: null, vcenterLastTs: NOW - 3_600_000, offsetMin: 540, collect: { enabled: true } }, NOW).empty).toMatch(/Tools/);
    expect(vmPartNote({ dbAvailable: true, collectedAt: null, vcenterLastTs: null, collect: { enabled: false } }, NOW).empty).toMatch(/꺼져/);
    expect(vmPartNote({ dbAvailable: true, collectedAt: null, vcenterLastTs: null, collect: { enabled: true } }, NOW).empty).toMatch(/아직/);
  });
  it('오래된 값 — 주기의 두 배를 넘으면 · 수집 꺼짐은 마지막 값', () => {
    const base = { dbAvailable: true, collect: { enabled: true, intervalHours: 12 } };
    expect(vmPartNote({ ...base, collectedAt: NOW - 10 * 3_600_000 }, NOW)).toEqual({ empty: '', stale: '' });
    expect(vmPartNote({ ...base, collectedAt: NOW - 25 * 3_600_000 }, NOW).stale).toMatch(/12시간/);
    expect(vmPartNote({ ...base, collect: { enabled: false }, collectedAt: NOW }, NOW).stale).toMatch(/마지막/);
  });
});

// 결정(56~75 남긴 것) 68 D1 — 판정 단위 'vm' 에서 값 모름 파티션이 있는 VM 은 합계로 판정하지 않는다(서버 pct null · unknownParts).
describe('68 D1 — VM 합계 판정 보류 문구', () => {
  it("'vm' 단위: 값 모름이 있으면 '판정 안 함' · 없으면 합계 · 'part' 단위는 최고", () => {
    expect(vmSumText({ pct: null, unknownParts: 1 }, 'vm')).toBe('값 모름 1개 — 판정 안 함');
    expect(vmSumText({ pct: 85.2, unknownParts: 0 }, 'vm')).toBe('합계 85.2%');
    expect(vmSumText({ pct: null }, 'vm')).toBe('합계 —');
    expect(vmSumText({ maxPct: 91, unknownParts: 3 }, 'part')).toBe('최고 91.0%');
  });
  it("KPI 보조 줄: 'vm' 이고 1 이상일 때만 · 파티션 단위(null) · 0 은 빈 글자", () => {
    expect(unknownVmsText({ unknownVms: 2 }, 'vm')).toContain('값 모름으로 판정 안 한 게스트 2');
    expect(unknownVmsText({ unknownVms: 0 }, 'vm')).toBe('');
    expect(unknownVmsText({ unknownVms: null }, 'part')).toBe('');
    expect(unknownVmsText({ unknownVms: 5 }, 'part')).toBe('');
    expect(vmSumText({ unknownParts: 2 }, 'vm')).not.toContain('`');
  });
});
