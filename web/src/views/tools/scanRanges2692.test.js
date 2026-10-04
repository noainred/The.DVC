// v2.692: 스캔 대역·설정 서브메뉴 2개 + '/24 가져오기' 에 IPMS 무시·공인/사설 — 문구·판정(순수) + 소스 계약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CLS_LABEL, clsCounts, filterByCls, defaultChosen, ignoredText, partialIgnoreText, reportState, agentReportRows, reportKpis, rangeRowCheck, REPORT_STATE_TEXT, REPORT_STATE_TITLE, REPORT_STALE_MS } from './scanRangeImportText.js';

const NOW = 1_800_000_000_000;
const src = (f) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');

describe('가져오기 — 공인/사설 · 무시 대역', () => {
  const rows = [{ cidr: 'a', cls: 'private', kind: 'new' }, { cidr: 'b', cls: 'public', kind: 'new' }, { cidr: 'c', cls: 'mixed', kind: 'new' }, { cidr: 'd', cls: 'private', kind: 'covered' }, { cidr: 'e', cls: null, kind: 'new' }];
  it('분류 칩 개수 · 거르기', () => {
    expect(clsCounts(rows)).toEqual({ '': 5, private: 2, public: 1, mixed: 1 });
    expect(filterByCls(rows, 'public').map((r) => r.cidr)).toEqual(['b']);
    expect(filterByCls(rows, '')).toHaveLength(5);
  });
  it('기본 선택 — 공인은 체크를 풀고 이미 입력됨은 뺀다 · 섞임·분류 미상은 선택', () => {
    expect([...defaultChosen(rows)]).toEqual(['a', 'c', 'e']);
  });
  it('무시 대역 제외 문구 — 0 이면 null · 출처 이름', () => {
    expect(ignoredText({ count: 0 }, [])).toBeNull();
    const t = ignoredText({ count: 3, bySource: { global: 2, 'vc:v1': 1 } }, [{ key: 'vc:v1', label: 'vCenter AZ' }]);
    expect(t).toContain('/24 3개'); expect(t).toContain('전체(모든 vCenter) 2'); expect(t).toContain('vCenter AZ 1');
    expect(partialIgnoreText({ ignore: 'partial', ignoreBy: ['global'] }, [])).toContain('일부 걸침');
    expect(partialIgnoreText({}, [])).toBeNull();
  });
  it('분류 라벨은 서버 cls 값 셋과 1:1', () => { expect(Object.keys(CLS_LABEL).sort()).toEqual(['mixed', 'private', 'public']); });
});

describe('② 에이전트별 대역·보고 현황', () => {
  it('보고 상태 — 꺼짐·대기는 늦음이 아니다', () => {
    expect(reportState({ enabled: false, at: NOW - 999e6, ranges: 3 }, NOW)).toBe('off');
    expect(reportState({ enabled: true, at: null, ranges: 3 }, NOW)).toBe('waiting');
    expect(reportState({ enabled: true, at: null, ranges: 0 }, NOW)).toBe('none');
    expect(reportState({ enabled: true, at: NOW - REPORT_STALE_MS - 1, ranges: 1 }, NOW)).toBe('late');
    expect(reportState({ enabled: true, at: NOW - 60_000, ranges: 1 }, NOW)).toBe('ok');
    for (const k of ['ok', 'late', 'off', 'waiting', 'none']) { expect(REPORT_STATE_TEXT[k]).toBeTruthy(); expect(REPORT_STATE_TITLE[k]).toBeTruthy(); }
  });
  it('두 표를 합친다 — 대역 줄·IP 수·오류 · 보고(엣지) · 이 포탈은 lastRun', () => {
    const list = agentReportRows({
      agents: [{ name: '__local__', enabled: true }, { name: 'Edge-A', enabled: true }],
      rows: [{ agent: '__local__', valid: true, size: 256 }, { agent: '__local__', valid: false }, { agent: 'Edge-A', valid: true, size: 128, datacenterName: 'AZ' }],
      reports: { 'Edge-A': { at: NOW - 3 * REPORT_STALE_MS, scanned: 128, alive: 9 }, 'Edge-Z': { at: NOW - 1000, scanned: 1, alive: 1 } },
      localLast: { at: NOW - 1000, scanned: 256, alive: 40 }, now: NOW,
    });
    expect(list.map((x) => x.name)).toEqual(['__local__', 'Edge-A', 'Edge-Z']);
    expect(list[0]).toMatchObject({ lines: 2, invalid: 1, ips: 256, alive: 40, state: 'ok' });
    expect(list[1]).toMatchObject({ datacenterName: 'AZ', state: 'late' });
    const k = reportKpis(list);
    expect(k).toMatchObject({ total: 3, ok: 2, late: 1, alive: 50, aliveKnown: 3 });
  });
  it('① 검사 칸 우선순위 — 형식 오류 > 무시 전부 > 다른 에이전트 겹침 > 무시 일부 > 정상', () => {
    expect(rangeRowCheck({ valid: false, reason: 'x' }).tone).toBe('red');
    expect(rangeRowCheck({ valid: true, ignore: 'full', ignoreBy: ['global'], overlaps: ['A'] }).text).toContain('전부');
    expect(rangeRowCheck({ valid: true, ignore: 'partial', ignoreBy: ['global'], overlaps: ['A'] }).text).toContain('겹침');
    expect(rangeRowCheck({ valid: true, ignore: 'partial', ignoreBy: ['global'], overlaps: [] }).tone).toBe('amber');
    expect(rangeRowCheck({ valid: true, overlaps: [] }).tone).toBe('green');
  });
});

describe('소스 계약', () => {
  it('서브메뉴 키는 해시에 싣는다(#/ipam/scan/<ranges|agents>) · 예전 두 표 제목은 사라졌다', () => {
    const s = src('IpScanSettings.jsx');
    expect(s).toContain("base: ['ipam', 'scan']");
    expect(s).toContain("'ranges'"); expect(s).toContain("'agents'");
    expect(s).not.toContain('에이전트별 보고 현황</div>');
  });
  it('줄 단위 수정은 /admin/ipam/scan/ranges/line 하나 · 브라우저 confirm 을 쓰지 않는다', () => {
    const s = src('ScanRangeList.jsx');
    expect(s).toContain('/admin/ipam/scan/ranges/line');
    expect(s).not.toMatch(/window\.confirm/);
  });
});
