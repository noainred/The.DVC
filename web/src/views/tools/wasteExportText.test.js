// v2.497 — 낭비 리소스 엑셀 내보내기 버튼 문구·예상치 회귀 고정(node 환경 — 순수 함수만).
import { describe, it, expect } from 'vitest';
import { reportCount, estimateSeconds, exportLabel, exportTitle, progressNote, exportErrText } from './wasteExportText.js';

const data = {
  overAllocated: {
    cpuTop: [{ id: 'a', name: 'web-1' }, { id: 'b', name: 'db-1' }],
    memTop: [{ id: 'a', name: 'web-1' }, { id: 'c', name: 'app-1' }], // a 는 CPU 와 겹침
  },
};

describe('reportCount', () => {
  it('CPU ∪ 메모리 상위를 id 로 중복 제거해 센다', () => {
    expect(reportCount(data)).toBe(3);
  });
  it('이름 검색이 걸리면 화면과 같이 걸러 센다', () => {
    expect(reportCount(data, { nameFilter: 'db' })).toBe(1);
    expect(reportCount(data, { nameFilter: '1' })).toBe(3);
    expect(reportCount(data, { nameFilter: 'none' })).toBe(0);
  });
  it('데이터·과할당이 없으면 0(구버전 서버 응답 포함)', () => {
    expect(reportCount(null)).toBe(0);
    expect(reportCount({})).toBe(0);
    expect(reportCount({ overAllocated: {} })).toBe(0);
  });
});

describe('estimateSeconds', () => {
  it('0건이면 0, 왕복 수에 비례해 커지고 vCenter 동시성으로 나뉜다', () => {
    expect(estimateSeconds(0)).toEqual([0, 0]);
    const [lo1, hi1] = estimateSeconds(8, 1);
    expect(hi1).toBeGreaterThan(lo1);
    // 같은 VM 수를 vCenter 여러 곳에 나누면(동시 4) 벽시계는 줄거나 같다
    const [, hi28] = estimateSeconds(100, 28);
    const [, hi1b] = estimateSeconds(100, 1);
    expect(hi28).toBeGreaterThanOrEqual(hi1b - 1); // 28곳은 7웨이브라 오히려 커질 수 있다(정직한 상한)
    expect(hi1b).toBeGreaterThan(0);
  });
  it('VM 이 늘면 예상도 단조 증가', () => {
    expect(estimateSeconds(200, 4)[1]).toBeGreaterThan(estimateSeconds(8, 4)[1]);
  });
});

describe('exportLabel / exportTitle / progressNote', () => {
  it('진행 중에는 경과 초를 보여 멈춘 것으로 오해하지 않게 한다', () => {
    expect(exportLabel({ busy: false })).toContain('엑셀(ZIP)');
    expect(exportLabel({ busy: true, elapsedSec: 12.6 })).toBe('⏳ 내보내는 중… 13초');
  });
  it('title 에 담기는 내용·리포트 건수·기간·ZIP 해제 안내가 들어간다', () => {
    const t = exportTitle({ reportVms: 3, vcenters: 2, days: 30 });
    expect(t).toContain('3대');
    expect(t).toContain('최근 30일');
    expect(t).toContain('ZIP 을 풀고');
    expect(exportTitle({ reportVms: 0 })).toContain('표만 내보냅니다');
  });
  it('이름 검색이 걸리면 그 사실을 title 에 밝힌다', () => {
    expect(exportTitle({ reportVms: 1, nameFilter: 'db' })).toContain("'db'");
  });
  it('예상보다 오래 걸리면 추가 안내를 붙인다', () => {
    const short = progressNote({ reportVms: 3, vcenters: 1, days: 30, elapsedSec: 1 });
    expect(short).toContain('경과 1초');
    expect(short).not.toContain('오래 걸리고');
    expect(progressNote({ reportVms: 3, vcenters: 1, days: 30, elapsedSec: 9999 })).toContain('오래 걸리고');
  });
});

describe('exportErrText', () => {
  it('409 는 동시 실행 제한임을 밝힌다', () => {
    const e = Object.assign(new Error('다른 내보내기가 진행 중입니다'), { status: 409 });
    expect(exportErrText(e)).toContain('한 번에 1건');
  });
  it('403 은 문구를 바꾸지 않는다(ErrorBox/AccessDenied 경로 보존)', () => {
    const e = Object.assign(new Error('forbidden'), { status: 403 });
    expect(exportErrText(e)).toBe('forbidden');
  });
  it('그 외는 실패로 표기', () => {
    expect(exportErrText(new Error('boom'))).toBe('내보내기 실패: boom');
    expect(exportErrText(null)).toContain('알 수 없는 오류');
  });
});
