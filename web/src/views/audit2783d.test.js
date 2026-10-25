import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityBadge, anomalyKpi, anomalyFamilyBadge, incidentKindText } from './insightsBadges.js';
import { stripComments } from '../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = stripComments(fs.readFileSync(path.join(HERE, 'Insights.jsx'), 'utf8'));

describe('v2.783 점검 Q4 P-B2 — 보안 자세 미확인은 정상(녹색)이 아니다', () => {
  it('unknown 은 회색 미확인 · 사유를 title 로', () => {
    expect(securityBadge('unknown', '빌드 미상')).toEqual({ cls: 'gray', text: '미확인', title: '빌드 미상' });
    expect(securityBadge('critical').cls).toBe('red');
    expect(securityBadge('warning').cls).toBe('amber');
    expect(securityBadge('ok')).toEqual({ cls: 'green', text: '정상', title: undefined });
  });
  it('모르는 값(없음·이상한 문자열)도 정상으로 그리지 않는다', () => {
    expect(securityBadge(undefined).text).toBe('미확인');
    expect(securityBadge('bogus').cls).toBe('gray');
  });
  it('화면이 미확인 KPI 와 badge 함수를 쓴다', () => {
    expect(SRC).toMatch(/label="미확인"/);
    expect(SRC).toMatch(/securityBadge\(/);
  });
});

describe('v2.783 점검 Q4 P-I1 — 이상 탐지 평가 못 함', () => {
  const fam = (o) => ({ metric: 'm', label: 'L', count: 0, items: [], evaluated: 0, insufficient: 0, error: null, ...o });
  it('계열 오류 · 평가 0 은 회색 평가 못 함, 평가했고 0 이면 초록', () => {
    expect(anomalyFamilyBadge(fam({ error: '조회 실패' }))).toMatchObject({ cls: 'gray', text: '평가 못 함' });
    expect(anomalyFamilyBadge(fam({ insufficient: 3 }))).toMatchObject({ cls: 'gray', text: '평가 못 함' });
    expect(anomalyFamilyBadge(fam({ insufficient: 3 })).title).toMatch(/3/);
    expect(anomalyFamilyBadge(fam({ evaluated: 5 }))).toMatchObject({ cls: 'green', text: '0건' });
    expect(anomalyFamilyBadge(fam({ evaluated: 5, count: 2 }))).toMatchObject({ cls: 'red', text: '2건' });
  });
  it('구버전 응답(evaluated 없음)은 예전처럼 건수만', () => {
    expect(anomalyFamilyBadge({ count: 0 })).toMatchObject({ cls: 'green', text: '0건' });
  });
  it('KPI — 아무것도 평가 못 했으면 초록 0 이 아니라 평가 못 함 N', () => {
    const k = anomalyKpi({ total: 0, families: [fam({}), fam({ error: '조회 실패' })] });
    expect(k.value).toBe('평가 못 함 2');
    expect(k.color).not.toBe('#34d399');
    const part = anomalyKpi({ total: 0, families: [fam({ evaluated: 4 }), fam({})] });
    expect(part.value).toBe(0);
    expect(part.color).not.toBe('#34d399');
    expect(part.sub).toMatch(/평가 못 함 1/);
    expect(anomalyKpi({ total: 0, families: [fam({ evaluated: 4 })] }).color).toBe('#34d399');
    expect(anomalyKpi({ total: 3, families: [fam({ evaluated: 4, count: 3 })] }).color).toBe('#f87171');
  });
  it('화면이 함수를 쓴다(예전 직접 녹색 판정 제거)', () => {
    expect(SRC).toMatch(/anomalyKpi\(/);
    expect(SRC).toMatch(/anomalyFamilyBadge\(/);
    expect(SRC).not.toMatch(/fam\.count \? 'red' : 'green'/);
  });
});

describe('v2.783 점검 Q4 P-B1 — 인시던트 재발송은 발생이 아니다', () => {
  it('kind 표기', () => {
    expect(incidentKindText('resolved')).toBe('해소');
    expect(incidentKindText('notify')).toBe('재발송');
    expect(incidentKindText('fired')).toBe('발생');
  });
  it('타임라인이 함수를 쓴다', () => {
    expect(SRC).toMatch(/incidentKindText\(e\.kind\)/);
  });
});
