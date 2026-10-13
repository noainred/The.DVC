/**
 * partFaultIncidents2734.test.js — 파트 장애 '장애별'·'종류별' 문구(v2.734).
 * 묶기·집계는 서버(`server/src/partfault/incidents.js`)가 한다 — 여기서는 문구·필터·서버 계약 대조를 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  INCIDENT_END_TEXT, INCIDENT_PERIODS, periodLabel, durationText, incidentStateText, incidentStartText, incidentEndText,
  incidentStateRank, incidentSummaryText, incidentScanNote, KINDS_NOTE, kindChips, openKindCounts, filterIncidents, incidentRespFor,
} from './partFaultText.js';
import { INCIDENT_END } from '../../../../server/src/partfault/incidents.js';

const labels = { state: { fault: '이상', warn: '주의' }, kind: { disk: '디스크', dimm: '메모리(DIMM)', nic: 'NIC' } };

describe('서버 계약 대조', () => {
  it('종료 사유 키가 서버 INCIDENT_END 와 1:1 이다', () => {
    expect(Object.keys(INCIDENT_END_TEXT).sort()).toEqual(Object.values(INCIDENT_END).sort());
  });
  it('기간 선택지의 0 은 전체(서버 parseDays 와 같은 뜻)', () => {
    expect(INCIDENT_PERIODS).toContain(0);
    expect(periodLabel(0)).toBe('전체(보존 기간)');
    expect(periodLabel(30)).toBe('최근 30일');
  });
});

describe('durationText — 값이 없으면 —(0 으로 보이지 않는다)', () => {
  it('결측', () => {
    expect(durationText(null)).toBe('—');
    expect(durationText(undefined)).toBe('—');
    expect(durationText('')).toBe('—');
  });
  it('단위', () => {
    expect(durationText(0)).toBe('1분 미만');
    expect(durationText(45 * 60_000)).toBe('45분');
    expect(durationText(3 * 3_600_000)).toBe('3시간');
    expect(durationText(3 * 3_600_000 + 12 * 60_000)).toBe('3시간 12분');
    expect(durationText(2 * 86_400_000 + 4 * 3_600_000)).toBe('2일 4시간');
    expect(durationText(5 * 86_400_000)).toBe('5일');
  });
});

describe('상태·시작·종료 칸', () => {
  it('진행 중은 지금 상태, 끝난 것은 종료 사유 — 정상 복귀가 아닌 종료를 해소로 뭉개지 않는다', () => {
    expect(incidentStateText({ ongoing: true, state: 'fault' }, labels)).toMatchObject({ text: '진행 중 — 이상', tone: 'red' });
    expect(incidentStateText({ ongoing: true, state: 'warn' }, labels)).toMatchObject({ text: '진행 중 — 주의', tone: 'amber' });
    expect(incidentStateText({ ongoing: false, endReason: 'ok' }, labels).text).toBe('끝남 — 정상 복귀');
    expect(incidentStateText({ ongoing: false, endReason: 'manual' }, labels).text).toBe('끝남 — 수동 닫음');
    expect(incidentStateText({ ongoing: false, endReason: 'manual' }, labels).title).toMatch(/고쳐졌다는 뜻이 아닙니다/);
    expect(incidentStateText({ ongoing: false, endReason: 'removed' }, labels).text).toBe('끝남 — 부품 제거');
    expect(incidentStateText({ ongoing: false, endReason: 'zzz' }, labels).text).toBe('끝남 — 종료 기록 없음');
  });
  it('시작을 모르면 모른다고 말한다 · 기간 이전 시작은 표시', () => {
    expect(incidentStartText({ openedAt: null }).text).toBe('시작 시각 모름');
    expect(incidentStartText({ openedAt: 1_700_000_000_000, startedBefore: true }).note).toBe('기간 이전에 시작');
    expect(incidentStartText({ openedAt: 1_700_000_000_000, startedBefore: false }).note).toBe('');
  });
  it('종료 칸', () => {
    expect(incidentEndText({ ongoing: true })).toBe('진행 중');
    expect(incidentEndText({ ongoing: false, closedAt: null })).toBe('모름');
  });
  it('정렬 순위 — 진행 중 이상 < 진행 중 주의 < 끝남', () => {
    const r = [{ ongoing: false }, { ongoing: true, state: 'warn' }, { ongoing: true, state: 'fault' }].map(incidentStateRank);
    expect(r).toEqual([3, 1, 0]);
  });
});

describe('요약·읽은 범위 안내 — 조용한 상한 금지', () => {
  it('요약에 기간·건수·진행 중·상한 절단을 말한다', () => {
    const t = incidentSummaryText({ days: 30, totals: { incidents: 12, ongoing: 3, devices: 5, kinds: 4 }, total: 12, omitted: 0 });
    expect(t).toContain('최근 30일 장애 **12건**');
    expect(t).toContain('진행 중 3건');
    const cut = incidentSummaryText({ days: 0, totals: { incidents: 2500, ongoing: 0, devices: 9, kinds: 2 }, total: 2500, omitted: 500, limit: 2000 });
    expect(cut).toContain('전체(보존 기간)');
    expect(cut).toContain('500건은 싣지 않았습니다');
  });
  it('읽기 상한·조회 상한·종료 기록 없음·합침을 각각 밝힌다', () => {
    const t = incidentScanNote({ truncated: true, read: 100000, coveredSince: 1_700_000_000_000, lookupCapped: 4, endUnknown: 2, merged: 1 });
    expect(t).toMatch(/최근 100,000건만 읽었습니다/);
    expect(t).toMatch(/조회 상한/);
    expect(t).toMatch(/종료 기록 없음/);
    expect(t).toMatch(/한 건으로 합쳤습니다/);
    expect(incidentScanNote({ truncated: false, read: 10 })).toBe('');
  });
  it('종류별 안내는 표에 없는 종류를 0건으로 읽지 말라고 말한다', () => {
    expect(KINDS_NOTE).toMatch(/0건이라는 뜻이 아닙니다/);
  });
});

describe('종류 칩·필터', () => {
  it('전체 칩 + 개수 있는 종류(많은 순) — 0건 종류는 칩을 만들지 않는다', () => {
    const c = kindChips([{ kind: 'nic', incidents: 1 }, { kind: 'disk', incidents: 5 }, { kind: 'gpu', incidents: 0 }], labels);
    expect(c.map((x) => x.kind)).toEqual(['', 'disk', 'nic']);
    expect(c[0]).toMatchObject({ label: '전체', n: 6 });
    expect(c[1].label).toBe('디스크');
  });
  it('열린 장애의 종류별 개수', () => {
    expect(openKindCounts([{ kind: 'disk' }, { kind: 'disk' }, { kind: 'psu' }, {}]).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toEqual([{ kind: 'disk', n: 2 }, { kind: 'other', n: 1 }, { kind: 'psu', n: 1 }]);
  });
  it('검색은 낱말 전부 · 반복 부품만', () => {
    const list = [
      { deviceName: 'srv-a', label: 'Disk 1', kind: 'disk', occurrences: 3, agent: 'edge-a', rawState: 'Critical' },
      { deviceName: 'srv-b', label: 'DIMM A1', kind: 'dimm', occurrences: 1, agent: '', rawState: 'Warning' },
    ];
    expect(filterIncidents(list, 'srv-a critical')).toHaveLength(1);
    expect(filterIncidents(list, '')).toHaveLength(2);
    expect(filterIncidents(list, '', { repeatOnly: true }).map((i) => i.deviceName)).toEqual(['srv-a']);
    expect(filterIncidents(null)).toEqual([]);
  });
  it('늦게 온 이전 선택의 응답은 그리지 않는다', () => {
    const r = { days: 30, kind: 'disk', incidents: [] };
    expect(incidentRespFor(r, { days: 30, kind: 'disk' })).toBe(r);
    expect(incidentRespFor(r, { days: 7, kind: 'disk' })).toBe(null);
    expect(incidentRespFor(r, { days: 30, kind: '' })).toBe(null);
    expect(incidentRespFor({ days: 0, kind: null }, { days: 0, kind: '' })).toEqual({ days: 0, kind: null });
    expect(incidentRespFor({ error: 'x' }, { days: 30 })).toEqual({ error: 'x' });
  });
});

describe('화면 소스', () => {
  const src = fs.readFileSync(path.join(__dirname, 'PartFaults.jsx'), 'utf8');
  it('탭 넷이 해시 valid 에 있다(주소로 바로 열린다)', () => {
    expect(src).toMatch(/valid: \['open', 'incidents', 'kinds', 'events'\]/);
  });
  it('장애별 표는 정렬 뒤 자른다(DataTable limit) — 호출부에서 먼저 자르지 않는다', () => {
    expect(src).toMatch(/<DataTable className="pf-inc-table"[^>]*limit=\{500\}/);
    expect(src).not.toMatch(/incRows\.slice\(/);
  });
});
