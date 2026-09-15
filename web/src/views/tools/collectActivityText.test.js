// v2.516 — 수집 작업 로그 패널의 문구·판정 회귀(node 환경 — 순수 함수만).
//
// 사용자 요구: "실패일때 클릭하면 구체적인 로그 보여주는 기능" + "화면 하단에 진행상태와 로그".
// 여기서 고정하는 것은 정직성이다 — 잘린 로그를 전문이라 말하지 않기, 없는 값을 0 으로
// 그리지 않기, 주기 숫자를 지어내지 않기.
import { describe, it, expect } from 'vitest';
import {
  ERROR_MAX, resultBadge, sourceLabel, hasDetail, detailLines,
  durationText, errorBlock, inFlightText, intervalText, countFailures,
} from './collectActivityText.js';

const EVT = {
  at: new Date('2026-09-15T06:30:00Z').getTime(),
  deviceId: 'sw1', name: 'WA-SAN-01', host: '10.30.0.11', source: 'agent-WA',
  ok: false, durationMs: 1234, error: 'SSH 수집 실패: SSH exec 타임아웃(60s): ir); i.status',
};

describe('결과·출처 배지', () => {
  it('성공/실패', () => {
    expect(resultBadge(true)).toEqual({ text: '정상', cls: 'green' });
    expect(resultBadge(false)).toEqual({ text: '실패', cls: 'red' });
  });
  it("'central' 은 중앙 직접 수집, 그 외는 엣지 이름", () => {
    expect(sourceLabel('central')).toEqual({ text: '중앙', edge: false });
    expect(sourceLabel('')).toEqual({ text: '중앙', edge: false });
    expect(sourceLabel('agent-WA')).toEqual({ text: 'agent-WA', edge: true });
  });
});

describe('실패 클릭 — 오류를 툴팁에만 두지 않는다', () => {
  it('펼칠 내용이 있으면 hasDetail 이 참(없는데 버튼으로 그리면 눌러도 무반응)', () => {
    expect(hasDetail(EVT)).toBe(true);
    expect(hasDetail({ ok: true, name: 'x', deviceId: 'd' })).toBe(true);
    expect(hasDetail(null)).toBe(false);
    expect(hasDetail({})).toBe(false);
  });
  it('상세 줄은 **있는 것만** 넣는다(없는 값을 — 로 채워 줄을 늘리지 않는다)', () => {
    const lines = detailLines(EVT);
    const labels = lines.map((l) => l.label);
    expect(labels).toContain('장비');
    expect(labels).toContain('주소');
    expect(labels).toContain('소요');
    const bare = detailLines({ name: 'only-name' });
    expect(bare.map((l) => l.label)).toEqual(['장비', '출처']);   // host·시각·소요 없음
  });
  it('도메인 수치는 주입받는다(스토리지=노드·용량, 스위치=포트·사용률)', () => {
    const lines = detailLines(EVT, { metrics: [{ label: '포트', value: '20/48' }] });
    expect(lines.find((l) => l.label === '포트')?.value).toBe('20/48');
  });
});

describe('잘린 로그를 전문이라 말하지 않는다', () => {
  it('300자 미만은 잘림 안내가 없다', () => {
    const b = errorBlock('짧은 사유');
    expect(b.truncated).toBe(false);
    expect(b.note).toBe('');
  });
  it('상한에 닿으면 잘렸다고 밝히고 어디서 원문을 보는지 말한다', () => {
    const b = errorBlock('x'.repeat(ERROR_MAX));
    expect(b.truncated).toBe(true);
    expect(b.note).toMatch(/잘렸/);
    expect(b.note).toMatch(/섹션별 수집 상태|서버 로그/);
  });
  it('오류가 없으면 빈 문자열(null 을 문자로 그리지 않는다)', () => {
    expect(errorBlock(null).text).toBe('');
    expect(errorBlock(undefined).text).toBe('');
  });
});

describe('소요·주기 — 없는 값을 지어내지 않는다', () => {
  it('소요는 초/분, 없으면 null', () => {
    expect(durationText(1234)).toBe('1.2s');
    expect(durationText(95_000)).toBe('1분 35초');
    expect(durationText(null)).toBeNull();
    expect(durationText(undefined)).toBeNull();
    expect(durationText(NaN)).toBeNull();
  });
  it('주기는 API 값만 쓰고 없으면 — (기본값을 하드코딩하지 않는다)', () => {
    expect(intervalText(600_000)).toBe('10분');
    expect(intervalText(30_000)).toBe('30초');
    expect(intervalText(0)).toBe('—');
    expect(intervalText(null)).toBe('—');
  });
});

describe('진행중 구획', () => {
  it('0건과 N건의 말이 다르다', () => {
    expect(inFlightText(0)).toBe('진행 중인 수집 없음');
    expect(inFlightText(3)).toBe('수집 중 3건');
  });
  it('실패 건수 — 0이면 호출부가 필터 버튼을 숨긴다', () => {
    expect(countFailures([{ ok: true }, { ok: false }, { ok: false }])).toBe(2);
    expect(countFailures([])).toBe(0);
    expect(countFailures(null)).toBe(0);
  });
});
