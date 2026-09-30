import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  unitLabel, readingText, thresholdText, tempText, cpuCell, detailStateText, filterRows, filterCounts, FILTERS,
  groupSensors, collectionNote, STATE_TEXT, STATE_BADGE, GPU_NOTE, CPU_NOTE, ROLE_NOTE,
} from './sensorDetailText.js';

describe('센서 상세 문구(v2.659)', () => {
  it('값이 없으면 단위를 붙이지 않는다 — ℃·% 는 붙이고 V·RPM 은 띄운다', () => {
    expect(unitLabel('Cel')).toBe('℃');
    expect(readingText({ reading: 49.34, unit: 'Cel' })).toBe('49.3℃');
    expect(readingText({ reading: null, unit: 'Cel' })).toBe('—');
    expect(readingText({ reading: '', unit: 'V' })).toBe('—');
    expect(readingText({ reading: 230, unit: 'V' })).toBe('230 V');
    expect(readingText({ reading: 5400, unit: 'RPM' })).toBe('5,400 RPM');
    expect(thresholdText(null, 'Cel')).toBe('—');
    expect(thresholdText(-7, 'Cel')).toBe('-7℃');
    expect(tempText(undefined)).toBe('—');
  });

  it('판정 불가·빈 슬롯은 정상 색이 아니다', () => {
    expect(STATE_BADGE.unknown).toBe('gray');
    expect(STATE_BADGE.absent).toBe('gray');
    expect(STATE_TEXT.unknown).toBe('판정 불가');
  });

  it('CPU 사용률 — 출처를 밝히고, 꺼짐과 값 없음을 구분하고, 오래된 값은 표시한다', () => {
    expect(cpuCell({ pct: 15, src: 'bmusage', state: 'ok' })).toMatchObject({ text: '15%', sub: '베어메탈 사용률' });
    expect(cpuCell({ pct: 15, src: 'telemetry', state: 'stale' })).toMatchObject({ sub: '오래됨', stale: true });
    expect(cpuCell({ pct: null, state: 'off' }).sub).toBe('수집 꺼짐');
    expect(cpuCell({ pct: null, state: 'none' }).text).toBe('—');
    expect(cpuCell(null).text).toBe('—');
  });

  it('상세 상태 — 수집 전·오래됨을 정상으로 말하지 않는다', () => {
    expect(detailStateText({ detailState: 'none' }).badge).toBe('gray');
    expect(detailStateText({ detailState: 'stale' }).text).toBe('오래됨');
    expect(detailStateText({ detailState: 'ok', summary: { worst: 'crit', counts: { crit: 2, warn: 1 } } })).toMatchObject({ text: '위험 2', badge: 'red' });
    expect(detailStateText({ detailState: 'ok', summary: { worst: 'unknown', counts: {} } }).badge).toBe('gray');
  });

  it('필터 — 경고는 신선한 상세만, 검색은 대소문자 무시, 칩 개수는 필터별', () => {
    const rows = [
      { id: 'a', name: 'ESX-A', detailState: 'ok', summary: { counts: { warn: 1, crit: 0 }, gpuTempCount: 2 }, cpu: { pct: 10 } },
      { id: 'b', name: 'db-b', dcLabel: 'SN', detailState: 'stale', summary: { counts: { warn: 3 } }, cpu: { pct: null } },
      { id: 'c', name: 'c', detailState: 'none', cpu: null },
    ];
    expect(filterRows(rows, { filter: 'alert' }).map((r) => r.id)).toEqual(['a']);
    expect(filterRows(rows, { filter: 'gpu' }).map((r) => r.id)).toEqual(['a']);
    expect(filterRows(rows, { filter: 'nodetail' }).map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterRows(rows, { filter: 'nocpu' }).map((r) => r.id)).toEqual(['b', 'c']);
    expect(filterRows(rows, { q: 'SN' }).map((r) => r.id)).toEqual(['b']);
    const c = filterCounts(rows);
    expect(Object.keys(c)).toEqual(FILTERS.map(([k]) => k));
    expect(c.all).toBe(3);
  });

  it('상세 묶음 — 정해진 종류 순서, 묶음 안은 나쁜 상태 먼저', () => {
    const g = groupSensors([
      { kind: 'fan', name: 'Fan1', state: 'ok' },
      { kind: 'temperature', name: 'B', state: 'ok' }, { kind: 'temperature', name: 'A', state: 'crit' },
      { kind: 'weird', name: 'x', state: 'unknown' }, null,
    ]);
    expect(g.map((x) => x.kind)).toEqual(['temperature', 'fan', 'other']);
    expect(g[0].rows.map((r) => r.name)).toEqual(['A', 'B']);
  });

  it('수집 경로 설명 — 실패·못 읽은 개수·생략 개수를 밝힌다', () => {
    expect(collectionNote({ collection: null })[0]).toMatch(/Thermal/);
    const n = collectionNote({ collection: { ok: false, error: 'timeout', notRead: 3 }, omitted: 2 });
    expect(n.join(' ')).toMatch(/timeout/);
    expect(n.join(' ')).toMatch(/3개/);
    expect(n.join(' ')).toMatch(/2개를 생략/);
  });

  it('GPU 온도는 사용률이 아니라고 말하고, 문구에 백틱·별표가 없다', () => {
    expect(GPU_NOTE).toMatch(/사용률이 아닙니다/);
    const src = fs.readFileSync(new URL('./sensorDetailText.js', import.meta.url), 'utf8');
    const strings = src.match(/'[^'\n]*'/g) || [];
    for (const s of strings) { expect(s.includes('`')).toBe(false); expect(s.includes('**')).toBe(false); }
    expect([CPU_NOTE, ROLE_NOTE].every((t) => t.length > 10)).toBe(true);
  });
});
