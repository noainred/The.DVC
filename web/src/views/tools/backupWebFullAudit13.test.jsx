/**
 * 전체 소스 점검 13회차(백업 화면) 확정분.
 *  W-10 그룹 파일을 못 읽으면 정책 KPI 의 그룹 예약은 '—(그룹 파일을 읽지 못함)' · 합계를 Director 수만으로 만들지 않는다 · 경고 줄
 *  W-11 회차 중단 요약은 '그 밖 실행' 의 실패 · 모름 수를 함께(서버 감사 줄과 같은 꼴)
 *  W-12 bareos-detail 만 허용된 계정도 Bareos 탭(법인별 화면)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { canceledText } from './bareosCancelText.js';
import { visibleTabs } from './VeeamHeader.jsx';

const HERE = path.dirname(new URL(import.meta.url).pathname);

describe('W-11 회차 중단 요약', () => {
  it('그 밖 실행의 실패 · 모름 수를 함께 보인다', () => {
    const t = canceledText({ at: 1, effective: true, extra: { canceled: 0, failed: 2, unknown: 0, busy: 0 } });
    expect(t).toContain('그 밖 실행 취소 0(실패·모름 2)');
    expect(canceledText({ at: 1, effective: true, extra: { canceled: 3, failed: 0, unknown: 0, busy: 0 } })).toContain('그 밖 실행 취소 3');
    expect(canceledText({ at: 1, effective: true, extra: { canceled: 3, failed: 0, unknown: 0, busy: 0 } })).not.toContain('실패·모름');
  });
});

describe('W-12 Bareos 탭', () => {
  it('bareos-detail 만 있으면 법인별 화면으로 가는 탭', () => {
    const t = visibleTabs({ bareosDetailOk: true }).find(([k]) => k === 'bareos');
    expect(t?.[2]).toBe('#/tools/bareos-detail');
  });
  it('통합 현황 권한이 있으면 그쪽이 먼저 · 둘 다 없고 관리 도구도 없으면 탭 없음', () => {
    expect(visibleTabs({ bareosViewOk: true, bareosDetailOk: true }).find(([k]) => k === 'bareos')?.[2]).toBe('#/tools/bareos-summary');
    expect(visibleTabs({}).find(([k]) => k === 'bareos')).toBeUndefined();
  });
});

describe('W-10 정책 KPI(소스)', () => {
  it('그룹 수가 null 이면 모름 · 경고 줄', () => {
    const src = fs.readFileSync(path.join(HERE, 'BareosPolicyTab.jsx'), 'utf8');
    expect(src).toMatch(/k\.schedules\?\.group == null \? '—\(그룹 파일을 읽지 못함\)'/);
    expect(src).toMatch(/\{data\.groupsUnreadable && <div role="alert"/);
    expect(src).not.toMatch(/fmtNum\(\(k\.schedules\.director \|\| 0\) \+ \(k\.schedules\.group \|\| 0\)\)/);
  });
});
