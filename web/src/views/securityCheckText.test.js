// v2.500 — 보안 자가진단 표시 판정·문구 회귀 고정(node 환경 — 순수 함수만).
import { describe, it, expect } from 'vitest';
import {
  statusColor, statusLabel, sortChecks, summaryText, groupChecks, snapshotNotice, resolutionLabel, STATUS_ORDER,
} from './securityCheckText.js';

describe('상태 표기', () => {
  it("risk 는 '위험' 이 아니라 '보호 꺼짐' 이다", () => {
    // 운영상 필요해 켠 스위치일 수 있다 — '위험' 으로 단정하면 장애로 오해한다.
    expect(statusLabel('risk')).toBe('보호 꺼짐');
    expect(statusColor('risk')).toBe('red');
  });
  it("unknown 은 '확인 못 함' 이고 경고색을 쓰지 않는다", () => {
    expect(statusLabel('unknown')).toBe('확인 못 함');
    expect(statusColor('unknown')).toBe('gray');
    expect(statusLabel(undefined)).toBe('확인 못 함');
  });
  it('ok·warn 표기', () => {
    expect(statusLabel('ok')).toBe('정상');
    expect(statusColor('ok')).toBe('green');
    expect(statusLabel('warn')).toBe('점검 권장');
    expect(statusColor('warn')).toBe('amber');
  });
});

describe('정렬 — 조치가 필요한 것부터, 모르는 것을 앞세우지 않는다', () => {
  it('risk → warn → unknown → ok', () => {
    expect(STATUS_ORDER.risk).toBeLessThan(STATUS_ORDER.warn);
    expect(STATUS_ORDER.warn).toBeLessThan(STATUS_ORDER.unknown);
    expect(STATUS_ORDER.unknown).toBeLessThan(STATUS_ORDER.ok);
  });
  it('같은 상태면 그룹·제목 순', () => {
    const out = sortChecks([
      { id: 'a', status: 'ok', group: '가', title: '나' },
      { id: 'b', status: 'risk', group: '다', title: '가' },
      { id: 'c', status: 'unknown', group: '가', title: '가' },
      { id: 'd', status: 'warn', group: '가', title: '가' },
      { id: 'e', status: 'ok', group: '가', title: '가' },
    ]);
    expect(out.map((x) => x.id)).toEqual(['b', 'd', 'c', 'e', 'a']);
  });
  it('원본 배열을 바꾸지 않는다', () => {
    const src = [{ id: 'a', status: 'ok' }, { id: 'b', status: 'risk' }];
    sortChecks(src);
    expect(src.map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('요약 — 점수를 만들지 않고 개수만 말한다', () => {
  it('조치 대상이 있으면 종류별 개수를 밝힌다', () => {
    const t = summaryText({ risk: 2, warn: 1, unknown: 3, ok: 4, total: 10 });
    expect(t).toContain('보호 꺼짐 2건');
    expect(t).toContain('점검 권장 1건');
    expect(t).toContain('확인 못 함 3건');
    expect(t).toContain('점검 10건');
    expect(t).not.toMatch(/점수|\d+\s*점\b|score|등급/i);   // '점검' 은 정상(그 안의 '점' 은 제외)
  });
  it("조치 대상이 없어도 '안전' 이라고 단정하지 않는다(이 화면이 보는 범위가 설정뿐)", () => {
    const t = summaryText({ risk: 0, warn: 0, unknown: 0, ok: 5, total: 5 });
    expect(t).toContain('기본 보호 상태');
    expect(t).toContain('설정·파일 권한·환경변수');
    expect(t).not.toContain('안전');
  });
  it('항목이 없으면 그렇게 말한다', () => {
    expect(summaryText(null)).toBe('점검 항목이 없습니다.');
    expect(summaryText({ total: 0 })).toBe('점검 항목이 없습니다.');
  });
});

describe('그룹화', () => {
  it('서버가 넣은 등장 순서를 유지한다', () => {
    const g = groupChecks([
      { id: '1', group: '인증·계정' }, { id: '2', group: '비밀 보관' },
      { id: '3', group: '인증·계정' }, { id: '4' },
    ]);
    expect(g.map((x) => x.group)).toEqual(['인증·계정', '비밀 보관', '기타']);
    expect(g[0].items.map((x) => x.id)).toEqual(['1', '3']);
  });
});

describe('과거 스냅샷 안내 — 오래된 보고서를 현재로 읽지 않게', () => {
  it('점검 시점을 밝히고 현재 확인 경로를 알린다', () => {
    const t = snapshotNotice('20260808', '2026-09-13T01:00:00.000Z');
    expect(t).toContain('2026-08-08');
    expect(t).toContain('현재 상태가 아닙니다');
    expect(t).toContain('2026-09-13');
    expect(t).toContain('보안 자가진단');
  });
  it('같은 날이면 오늘 안내를 덧붙이지 않는다', () => {
    const t = snapshotNotice('2026-09-13', '2026-09-13T01:00:00.000Z');
    expect(t).not.toContain('오늘(');
  });
  it('점검일을 모르면 일반 문구', () => {
    expect(snapshotNotice('')).toContain('과거 점검 시점의 기록');
  });
});

describe('처리 상태 라벨 — 확인한 것만 단정한다', () => {
  it('네 가지 상태', () => {
    expect(resolutionLabel('fixed')).toEqual({ label: '해결됨', color: 'green' });
    expect(resolutionLabel('partial')).toEqual({ label: '부분 해결', color: 'amber' });
    expect(resolutionLabel('open')).toEqual({ label: '유효', color: 'red' });
    expect(resolutionLabel('unknown')).toEqual({ label: '미확인', color: 'gray' });
  });
  it('값이 없으면 해결로 치지 않는다(미확인)', () => {
    expect(resolutionLabel(undefined).label).toBe('미확인');
    expect(resolutionLabel(null).label).toBe('미확인');
  });
  it('불리언도 받는다(구버전 데이터 호환)', () => {
    expect(resolutionLabel(true).label).toBe('해결됨');
    expect(resolutionLabel(false).label).toBe('유효');
  });
});
