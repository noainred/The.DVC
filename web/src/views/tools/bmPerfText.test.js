/**
 * v2.920 — 리눅스 베어메탈 통합 성능 2단계 화면의 문구·표시 규약(bmPerfText.js) + 보드·상세 렌더 스모크.
 * ⚠ 판정은 서버(useJudge.js) — 여기서는 서버 code 를 문장·색·각주로 바꾸는 것만 고정한다.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as T from './bmPerfText.js';
import BmPerfBoard from './BmPerfBoard.jsx';
import BmPerfDetail from './BmPerfDetail.jsx';

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;   // 정시 경계로 떨어뜨린 기준 시각(docs/rules/common.md)
const TH = { utilWarn: 80, utilBad: 90, runqWarn: 1, runqBad: 2, queueWarn: 2, queueBad: 4, psiFullWarn: 5, psiFullBad: 20, psiCpuSomeWarn: 20, psiCpuSomeBad: 50, swapOutWarn: 1, swapOutBad: 100, retransWarn: 1, retransBad: 5, errRepeatBad: 3, cpuMismatchPct: 15, inletWarnC: 27, inletBadC: 35, powerCapWarnPct: 90, powerCapBadPct: 98, minJudgedPct: 50 };
const codes = (fill = 'ok', over = {}) => Object.fromEntries(T.RES_ORDER.map((r) => [r, { U: fill, S: fill, E: fill, ...(over[r] || {}) }]));
const entry = (o = {}) => ({
  key: 'K1', ts: NOW, coverage: 'both', osAt: NOW, idracAt: NOW, verdict: 'ok', focus: null, line: '정상 · 읽은 칸 15/15', bottleneckCount: 0,
  read: { judged: 15, applicable: 15 }, rowStale: false, counts: {}, codes: codes(), perResource: { cpu: 'ok', mem: 'ok', disk: 'ok', net: 'ok', hw: 'ok' },
  cross: [{ id: 1, state: 'inactive', code: '' }, { id: 2, state: 'inactive', code: '' }, { id: 3, state: 'inactive', code: '' }, { id: 4, state: 'inactive', code: '' }],
  mismatch: null, firstSample: false, psiAbsent: false, ...o,
});
const item = (key, e, tg = {}, extra = {}) => ({ key, name: key, vcenterId: 'vc-a', target: { key, name: key, paths: ['os', 'idrac'], ...tg }, row: { key, cpu_pct: 50, mem_pct: 40, disk_busy_pct: 10, net_pct: 5 }, entry: e, agent: '', snapAt: null, th: TH, ...extra });

describe('칸 code → 표시(서버 code 를 바꾸기만)', () => {
  it('판정 칸은 색과 낱말 · U 값이 있으면 숫자', () => {
    expect(T.cellView('bad')).toMatchObject({ text: '초과', tone: 'bad', judged: true, mark: '' });
    expect(T.cellView('warn').text).toBe('주의');
    expect(T.cellView('ok', { value: 62.04, unit: '%' }).text).toBe('62%');
    expect(T.cellView('bad', { value: 412.4, unit: '' }).text).toBe('412');
    // 정렬: 초과 > 주의 > 정상(같은 등급은 값)
    expect(T.cellView('bad', { value: 1 }).sort).toBeGreaterThan(T.cellView('warn', { value: 99 }).sort);
  });
  it('못 읽음 · 그 커널에 없음 · 경로 없음 · 오래됨은 모두 ‘—’ 지만 각주 기호가 다르다 — 정렬 값은 빈 값(늘 뒤)', () => {
    const marks = ['missing', 'none', 'nopath', 'stale'].map((c) => T.cellView(c));
    for (const m of marks) { expect(m.text).toBe('—'); expect(m.sort).toBe(''); expect(m.judged).toBe(false); expect(m.tone).toBe('idle'); }
    expect(new Set(marks.map((m) => m.mark)).size).toBe(4);
    expect(new Set(marks.map((m) => m.title)).size).toBe(4);
    expect(T.cellView('nopath').title).toBe('경로 없음');
    expect(T.cellView('missing').title).toBe('못 읽음');
  });
  it('모르는 code 는 ‘못 읽음’ — 지어내지 않는다 · 비판정 칸은 값을 줘도 숫자를 그리지 않는다', () => {
    expect(T.cellView('weird')).toMatchObject({ text: '—', title: '못 읽음' });
    expect(T.cellView('stale', { value: 97, unit: '%' }).text).toBe('—');
  });
  it('각주는 표에 나온 비판정 code 만, 정해진 순서로 — 경로 없음과 못 읽음은 다른 문장', () => {
    expect(T.cellFootnotes(['ok', 'bad'])).toEqual([]);
    const f = T.cellFootnotes(['stale', 'nopath', 'missing', 'ok']);
    expect(f).toHaveLength(3);
    expect(f[0]).toContain('못 읽음'); expect(f[1]).toContain('경로 없음'); expect(f[2]).toContain('오래됨');
    expect(T.CELL_FOOTNOTE.nopath).not.toBe(T.CELL_FOOTNOTE.missing);
    expect(T.codesUsed([entry({ codes: codes('ok', { hw: { U: 'nopath' } }) })]).sort()).toEqual(['nopath', 'ok']);
  });
});

describe('판정 · 커버리지 · 경로', () => {
  it('서버 verdict 8종을 모두 배지로 — 판정 보류 셋은 회색', () => {
    for (const v of ['bottleneck', 'saturated', 'errors', 'warn', 'ok', 'partial', 'stale', 'unknown']) expect(T.verdictView(v).label).toBeTruthy();
    expect(T.verdictView('partial').label).toBe('대부분 못 읽음');
    expect(T.verdictView('partial').tone).toBe('idle');
    expect(T.verdictView('nonsense').label).toBe('판정 불가');
    expect(T.verdictView('bottleneck').rank).toBeGreaterThan(T.verdictView('saturated').rank);
  });
  it('커버리지 4등급', () => {
    expect(T.coverageView('both').label).toBe('OS + iDRAC');
    expect(T.coverageView('os').short).toBe('OS 만');
    expect(T.coverageView('idrac').short).toBe('iDRAC 만');
    expect(T.coverageView('x').short).toBe('없음');
  });
  it('경로 상태 — 읽힘 · 등록은 있는데 못 읽음 · 등록 없음(경로 없음)을 구분한다', () => {
    expect(T.pathState('both', [], 'os')).toBe('read');
    expect(T.pathState('idrac', ['os', 'idrac'], 'os')).toBe('unread');
    expect(T.pathState('idrac', ['idrac'], 'os')).toBe('nopath');
    expect(T.pathState('os', ['os'], 'idrac')).toBe('nopath');
  });
});

describe('상태 9종(설계 §5 ④) — 보드 칩과 상세 머리 문구', () => {
  const st = (e, tg, o) => T.rowStates(e, { key: 'K1', ...tg }, { now: NOW, ...o });
  it('꺼짐 · 권한 부족 문구는 고정돼 있다(권한 부족은 4단계 스냅샷 상태 — 2단계 행에서는 나오지 않는다)', () => {
    expect(T.STATE_TEXT.off.title).toContain('꺼져');
    expect(T.STATE_TEXT.perm.body).toContain('sudo');
    expect(st(entry(), { paths: ['os', 'idrac'] })).not.toContain('perm');
  });
  it('첫 주기 · PSI 없음 · 오래됨 · 인증 정지 · 불일치 · 대부분 못 읽음', () => {
    expect(st(entry({ firstSample: true }), { paths: ['os'] })).toContain('first');
    expect(st(entry({ psiAbsent: true }), { paths: ['os'] })).toContain('psiAbsent');
    expect(st(entry({ rowStale: true, verdict: 'stale' }), { paths: ['os'] })).toContain('stale');
    expect(st(entry(), { paths: ['os'] }, { authStops: [{ key: 'K1', path: 'os' }] })[0]).toBe('auth');
    expect(st(entry({ mismatch: { cpu: { os: 62, idrac: 31, diffPp: 31, flag: true } } }), {})).toContain('mismatch');
    expect(st(entry({ mismatch: { cpu: { os: 62, idrac: 60, diffPp: 2, flag: false } } }), {})).not.toContain('mismatch');
    expect(st(entry({ verdict: 'partial' }), {})).toContain('partial');
  });
  it('OS 만 · iDRAC 만 — 등록이 없으면 ‘경로 없음’, 등록은 있는데 못 읽으면 ‘못 읽음’(다른 상태)', () => {
    expect(st(entry({ coverage: 'os' }), { paths: ['os'] })).toContain('osOnly');
    expect(st(entry({ coverage: 'os' }), { paths: ['os', 'idrac'] })).toContain('osOnlyUnread');
    expect(st(entry({ coverage: 'idrac' }), { paths: ['idrac'] })).toContain('idracOnly');
    expect(st(entry({ coverage: 'idrac' }), { paths: ['os', 'idrac'] })).toContain('idracOnlyUnread');
    expect(st(entry({ coverage: 'none' }), { paths: [] })).toContain('noPath');
    expect(st(entry({ coverage: 'none' }), { paths: ['os'] })).toContain('noneRead');
    expect(T.STATE_TEXT.osOnly.title).not.toBe(T.STATE_TEXT.osOnlyUnread.title);
    expect(T.STATE_TEXT.noPath.title).not.toBe(T.STATE_TEXT.noneRead.title);
  });
  it('엣지 보관분 오래됨은 API 의 staleMs 로만(숫자를 박지 않는다)', () => {
    expect(st(entry(), {}, { snapAt: NOW - 10 * 60_000, staleMs: 5 * 60_000 })).toContain('edgeStale');
    expect(st(entry(), {}, { snapAt: NOW - 10 * 60_000, staleMs: 20 * 60_000 })).not.toContain('edgeStale');
    expect(st(entry(), {}, { snapAt: NOW - 10 * 60_000, staleMs: null })).not.toContain('edgeStale');
  });
  it('항목이 없으면 인증 정지만 본다', () => {
    expect(T.rowStates(null, { key: 'K1' }, { authStops: [{ key: 'K1' }] })).toEqual(['auth']);
    expect(T.rowStates(null, { key: 'K1' })).toEqual([]);
  });
  it('불일치 문장 — 두 값 · 차이 · 기준(API 값) · 단정하지 않음', () => {
    const s = T.mismatchText({ cpu: { os: 62, idrac: 31, diffPp: 31, flag: true } }, { cpuMismatchPct: 12 });
    expect(s).toContain('OS 62%'); expect(s).toContain('iDRAC 31%'); expect(s).toContain('기준 12%p'); expect(s).toContain('단정하지 않습니다');
    expect(T.mismatchText({ cpu: { os: 62, idrac: 60, diffPp: 2, flag: false } }, TH)).toBe('');
  });
});

describe('교차 판정 ①~④ — ‘후보’ 로만', () => {
  it('후보 · 다른 후보는 결론 문장, 해당 없음 · 못 읽음 · 경로 없음은 이유', () => {
    const c = T.crossView({ id: 2, title: '디스크 대기 증가가 고장 전조인가', state: 'clear', code: 'io-volume', evidence: ['SMART 예측 장애 0'] });
    expect(c.no).toBe('②'); expect(c.stateLabel).toBe('다른 후보'); expect(c.conclusion).toContain('I/O 양');
    expect(T.crossView({ id: 1, state: 'nopath' }).conclusion).toContain('두 경로');
    expect(T.crossView({ id: 4, state: 'missing' }).conclusion).toContain('단정하지 않습니다');
    const d = T.crossView({ id: 3, state: 'candidate', code: 'dimm-slot', devices: ['DIMM.A4'] });
    expect(d.conclusion).toContain('‘DIMM.A4’');
    expect(T.crossView({ id: 3, state: 'inactive', devices: ['DIMM.A4'] }).conclusion).not.toContain('DIMM.A4');
    expect(T.crossView({ id: 3, state: 'inactive' }).conclusion).toContain('DIMM 이상이 보이지 않아');
    expect(T.crossView({ id: 1, state: 'inactive' }).conclusion).toContain('OS 쪽 조건');
  });
  it('판정 띠 요약은 후보·다른 후보만', () => {
    expect(T.crossBandText([{ id: 1, state: 'inactive' }, { id: 2, state: 'clear', code: 'io-volume' }, { id: 4, state: 'missing' }])).toHaveLength(1);
    expect(T.crossBandText(null)).toEqual([]);
  });
});

describe('기준값 · 근거 — 보여 주기만(숫자는 API 값)', () => {
  it('기준값은 API 값에서 — 값이 바뀌면 문구가 바뀐다', () => {
    expect(T.thresholdText('cpu_pct', TH)).toBe('주의 80% · 초과 90%');
    expect(T.thresholdText('cpu_pct', { ...TH, utilWarn: 70, utilBad: 85 })).toBe('주의 70% · 초과 85%');
    expect(T.thresholdText('net_drop_delta', { ...TH, errRepeatBad: 5 })).toBe('증가 → 주의 · 5주기 연속 → 초과');
    expect(T.thresholdText('sel_critical', TH)).toBe('');
    expect(T.thresholdText('cpu_pct', null)).toBe('');
  });
  it('근거 한 줄 — 장치 · 값 · 못 읽은 이유', () => {
    expect(T.basisText({ label: '평균 대기열', value: 9.2, unit: '', code: 'bad', device: 'nvme0n1' })).toBe('nvme0n1 평균 대기열 9.2');
    expect(T.basisText({ label: 'ECC 정정', value: null, code: 'missing' })).toBe('ECC 정정 —(못 읽음)');
    expect(T.basisText({ label: 'PSI io full', value: null, code: 'none' })).toBe('PSI io full —(그 커널에 없음)');
  });
  it('근거 열은 API perfCols 의 judged:false · 그 자원만 · 못 읽은 값은 ‘—’', () => {
    const cols = [{ col: 'load1', res: 'cpu', use: 'S', judged: false, unit: '', label: 'load 1분' }, { col: 'runq_per_core', res: 'cpu', use: 'S', judged: true, unit: '', label: '런큐' }, { col: 'swap_in_ps', res: 'mem', use: 'S', judged: false, unit: 'pages/s', label: '스왑 인' }];
    expect(T.evidenceRows(cols, { load1: 9.8 }, 'cpu')).toEqual([{ col: 'load1', label: 'load 1분', use: 'S', text: '9.8' }]);
    expect(T.evidenceRows(cols, {}, 'mem')[0].text).toBe('—');
  });
});

describe('보드 — 항목 합치기 · 신뢰 띠 · KPI · 병목 Top', () => {
  it('이 노드 대상 + 엣지 보관분(받은 적 없는 엣지는 뺀다 · 같은 키는 이 노드 것)', () => {
    const data = { targets: [{ key: 'A', name: 'a' }], rows: [{ key: 'A', cpu_pct: 1 }], perf: [entry({ key: 'A' })], perfThresholds: TH };
    const edges = { rows: [
      { agent: 'E1', snapAt: NOW, targets: [{ key: 'B', name: 'b' }, { key: 'A', name: 'dup' }], rows: [], perf: [entry({ key: 'B' })], perfThresholds: { ...TH, utilBad: 95 } },
      { agent: 'E2', snapAt: null, targets: [{ key: 'C', name: 'c' }], rows: [], perf: [] },
    ] };
    const items = T.boardItems(data, edges);
    expect(items.map((x) => x.key)).toEqual(['A', 'B']);
    expect(items[0]).toMatchObject({ agent: '', name: 'a' });
    expect(items[0].row.cpu_pct).toBe(1);
    expect(items[1]).toMatchObject({ agent: 'E1', snapAt: NOW });
    expect(items[1].th.utilBad).toBe(95);
    expect(T.boardItems({}, null)).toEqual([]);
  });
  it('신뢰 띠 — 경로 분포는 늘, 0 인 칸은 빼고, 못 읽음은 OS·iDRAC 따로 · PSI 없음은 못 읽음이 아니라고 말한다', () => {
    const items = [
      item('A', entry()),
      item('B', entry({ coverage: 'idrac', firstSample: false }), { paths: ['os', 'idrac'] }),
      item('C', entry({ coverage: 'os', psiAbsent: true, firstSample: true }), { paths: ['os'] }),
      item('D', null),
    ];
    const c = T.trustCounts(items, { now: NOW });
    expect(c).toMatchObject({ total: 4, both: 1, idrac: 1, os: 1, none: 0, noEntry: 1, read: 3, first: 1, unreadOs: 1, unreadIdrac: 0, psiAbsent: 1 });
    const parts = T.trustBandParts(c, { intervalMs: 300_000 });
    expect(parts[0]).toContain('없음 **1**');
    expect(parts.join(' ')).toContain('주기 5분');
    expect(parts.join(' ')).toContain('OS(SSH) **1** · iDRAC **0**');
    expect(parts.join(' ')).toContain('못 읽음 아님');
    expect(parts.join(' ')).not.toContain('인증 정지');
    expect(T.trustBandParts(T.trustCounts([], {}), {}).join(' ')).not.toContain('주기');
    expect(T.trustBandParts({ unreadOs: 0, unreadIdrac: 2 }).join(' ')).toContain('OS(SSH) **0** · iDRAC **2**');
  });
  it('KPI 는 서버 verdict 를 센다 — 판정 보류(대부분 못 읽음 · 오래됨 · 판정 불가 · 항목 없음)는 정상에 넣지 않는다', () => {
    const items = [
      item('A', entry({ verdict: 'bottleneck', codes: codes('ok', { disk: { U: 'bad', S: 'bad' } }) })),
      item('B', entry({ verdict: 'saturated', codes: codes('ok', { cpu: { S: 'bad' } }) })),
      item('C', entry({ verdict: 'errors', codes: codes('ok', { hw: { E: 'bad' } }) })),
      item('D', entry({ verdict: 'partial' })), item('E', entry({ verdict: 'stale' })), item('F', null), item('G', entry()),
    ];
    const k = T.kpiCounts(items);
    expect(k).toMatchObject({ total: 7, bottleneck: 1, saturated: 1, errors: 1, ok: 1, held: 3, both: 6 });
    expect(T.byResText(k.satByRes)).toBe('CPU 1 · 디스크 1');
    expect(T.byResText(k.errByRes)).toBe('하드웨어 1');
  });
  it('병목 Top — 등급 순 · 정상과 판정 보류는 넣지 않는다 · 상한', () => {
    const items = [item('w', entry({ verdict: 'warn' })), item('b', entry({ verdict: 'bottleneck' })), item('ok', entry()), item('p', entry({ verdict: 'partial' })), item('s', entry({ verdict: 'saturated' }))];
    expect(T.topBottlenecks(items, 5).map((x) => x.key)).toEqual(['b', 's', 'w']);
    expect(T.topBottlenecks(items, 1).map((x) => x.key)).toEqual(['b']);
    expect(T.severityOrder(items).map((x) => x.key)).toEqual(['b', 's', 'w', 'ok', 'p']);
  });
});

describe('서버 상세 — 안내 · 경로 시각 · 하드웨어 사실', () => {
  it('엣지 보관분 · 보관분에 없음 · 표본 없음 · 상세 생략 · 엣지 기준값을 각각 말한다', () => {
    expect(T.detailNotes({ via: 'edge', agent: 'KR', snapAt: NOW - 120_000 }, { now: NOW })[0]).toContain('다시 판정하지 않습니다');
    expect(T.detailNotes({ via: 'edge-none', agent: 'KR' })[0]).toContain('지금 가져오기');
    expect(T.detailNotes({ via: 'local', reason: 'no-sample' })[0]).toContain('표본이 아직 없습니다');
    expect(T.detailNotes({ detailOmitted: true, perfTruncated: { reason: 'size' } })[0]).toContain('‘size’');
    expect(T.detailNotes({ edgeThresholds: true })[0]).toContain('그 엣지의 설정');
    expect(T.detailNotes(null)).toEqual([]);
  });
  it('두 경로 읽은 시각 — 경로 없음과 읽은 적 없음을 구분', () => {
    expect(T.pathAtText({ osAt: NOW - 60_000, idracAt: null, coverage: 'os' }, ['os'], { now: NOW })).toContain('iDRAC(Redfish) 경로 없음');
    expect(T.pathAtText({ osAt: null, idracAt: null, coverage: 'none' }, ['os', 'idrac'], { now: NOW })).toBe('OS(SSH) 읽은 적 없음 · iDRAC(Redfish) 읽은 적 없음');
    expect(T.pathAtText({ osAt: null, idracAt: null, coverage: 'idrac' }, ['idrac'], { now: NOW })).toContain('읽힘(센서·인벤토리)');
  });
  it('하드웨어 사실 — 받지 않는 값은 따로 밝히고 못 읽은 값은 ‘—’', () => {
    const rows = T.hwFactRows({ power: { watts: 386, capWatts: null, capPct: null }, inletC: 22.6, sensorAt: NOW, cpuPct: 33, dimmBad: [], dimmWarn: ['A4'], diskPredicted: null, selCritical: 0, faultCount: 1, inventoryAt: NOW, throttle: null, eccCorrectable: null, smartRealloc: null, nicCrc: null }, { now: NOW });
    const m = Object.fromEntries(rows.map((r) => [r.label, r.text]));
    expect(m['전력']).toContain('cap 정보 없음');
    expect(m['DIMM 이상']).toContain('‘A4’');
    expect(m['SMART 예측 장애']).toBe('—(못 읽음)');
    expect(m['받지 않는 값']).toContain('NIC CRC');
    expect(T.hwFactRows(null)).toEqual([]);
    expect(T.hwEmptyText(['osOnly'])).toBe(T.STATE_TEXT.osOnly.body);
    expect(T.hwEmptyText(['osOnlyUnread'])).toBe(T.STATE_TEXT.osOnlyUnread.body);
  });
  it('404 는 ‘없거나 범위 밖’ — 둘을 구분하지 않는다', () => {
    expect(T.detailErrorText({ status: 404, message: 'x' })).toContain('범위 밖');
    expect(T.detailErrorText(new Error('boom'))).toContain('boom');
  });
  it('탭은 지금 데이터가 있는 것만 — 장애 기록 · 튜닝 · 용도 · 스냅샷 · 추이는 없다', () => {
    expect(T.DETAIL_TABS.map((x) => x.id)).toEqual(['summary', 'res', 'hw']);
    expect(T.DETAIL_TABS.map((x) => x.label).join(' ')).not.toMatch(/튜닝|스냅샷|추이|장애 기록|용도/);
  });
});

describe('문구 규약 — 소스 스윕', () => {
  const allStrings = () => {
    const out = [];
    const walk = (v) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk([T.STATE_TEXT, T.CELL_FOOTNOTE, T.CROSS_CODE_TEXT, T.CROSS_STATE_INFO, T.VERDICT_INFO, T.COVERAGE_INFO, T.CODE_INFO]);
    return out;
  };
  it('문구에 백틱이 없다(BoldText 는 **강조** 만 해석)', () => {
    for (const s of allStrings()) expect(s.includes('`')).toBe(false);
  });
  it('화면 파일에 text-transform 이 없고 · 폴링(setInterval)이 없다', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    for (const f of ['BmPerfBoard.jsx', 'BmPerfDetail.jsx', 'bmPerfText.js']) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src).not.toMatch(/text-?transform/i);
      expect(src).not.toMatch(/setInterval\(/);
    }
  });
  it('문구 모듈은 판정하지 않는다 — 기준값 키와 비교 연산을 함께 쓰지 않는다(값 표시만)', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'bmPerfText.js'), 'utf8');
    expect(src).not.toMatch(/(utilBad|utilWarn|runqBad|queueBad|psiFullBad|inletBadC|powerCapBadPct|cpuMismatchPct)\s*[<>]=?|[<>]=?\s*(th|T)\.(util|runq|queue|psi|inlet|powerCap|cpuMismatch)/);
  });
});

describe('렌더 스모크(SSR)', () => {
  const h = React.createElement;
  it('보드 — 신뢰 띠 · KPI · 매트릭스 · 각주 · 병목 Top, **강조** 가 별표로 새지 않는다', () => {
    const items = [
      item('A', entry({ verdict: 'bottleneck', focus: 'disk', line: '디스크 병목 — nvme0n1 평균 대기열 9.2 · 읽은 칸 13/15', codes: codes('ok', { disk: { U: 'bad', S: 'bad' }, hw: { U: 'missing' } }), cross: [{ id: 2, state: 'clear', code: 'io-volume' }] })),
      item('B', entry({ coverage: 'os', codes: codes('ok', { hw: { U: 'nopath', S: 'nopath', E: 'nopath' } }) }), { paths: ['os'] }),
      item('C', null),
    ];
    const html = renderToStaticMarkup(h(BmPerfBoard, { items, th: TH, intervalMs: 300_000 }));
    expect(html).toContain('USE 매트릭스');
    expect(html).toContain('두 경로 다 읽힘');
    expect(html).toContain('병목 Top');
    expect(html).toContain('디스크 병목 — nvme0n1');
    expect(html).toContain('I/O 양');
    expect(html).toContain('경로 없음');
    expect(html).toContain('판정 항목 없음');
    expect(html).toContain('주의 80% · 초과 90%');
    expect(html).not.toMatch(/\*\*/);
    expect(html).not.toContain('`');
  });
  it('보드 — 빈 목록(범위 계정에 보이는 서버 없음)', () => {
    const html = renderToStaticMarkup(h(BmPerfBoard, { items: [], th: null }));
    expect(html).toContain('표시할 서버가 없습니다');
    expect(html).toContain('병목·포화·오류·주의로 판정된 서버가 없습니다');
  });
  it('상세 — 키가 없으면 그리지 않고, 있으면 첫 렌더는 불러오는 중(조회는 effect 에서 1회)', () => {
    expect(renderToStaticMarkup(h(BmPerfDetail, { itemKey: '' }))).toBe('');
    const html = renderToStaticMarkup(h(BmPerfDetail, { itemKey: 'A', item: item('A', entry({ coverage: 'os' }), { paths: ['os'] }) }));
    expect(html).toContain('불러오는 중');
    expect(html).toContain('하드웨어 면이 비어 있습니다');
    expect(html).not.toMatch(/\*\*/);
  });
});
