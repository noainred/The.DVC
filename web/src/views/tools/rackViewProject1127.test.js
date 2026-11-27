// 랙 실장도 — 칸 목록 투영(2026-11-27)에 맞춘 화면 판정: 미배치 목록 · 연결된 서버 이름 줄 · 보이지 않는 칸만 바뀐 변경 · 가림 집계.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as V from './rackView.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const TOOL = strip(fs.readFileSync(path.join(here, 'RackTool.jsx'), 'utf8'));
const CENSUS = strip(fs.readFileSync(path.join(here, 'RackMaskCensus.jsx'), 'utf8'));

describe('미배치 서버 패널 — 목록은 관리자 응답에만 실린다', () => {
  it('unplacedListed 가 false 면 대수만(count) · 그 밖(옛 서버 포함)은 목록', () => {
    expect(V.unplacedMode({ unplaced: [], unplacedListed: false, unplacedTotal: 12 })).toBe('count');
    expect(V.unplacedMode({ unplaced: [{ serverId: 'a' }], unplacedListed: true, unplacedTotal: 1 })).toBe('list');
    expect(V.unplacedMode({ unplaced: [] })).toBe('list');      // 표식이 없는 응답(옛 서버) — 예전처럼 목록
    expect(V.unplacedMode(null)).toBe('list');
  });
  it('전산실 요약의 미배치 대수는 목록 길이가 아니라 서버가 센 수', () => {
    expect(V.roomSummary({ racks: [], places: [], unplaced: [], unplacedListed: false, unplacedTotal: 12 }).unplaced).toBe(12);
  });
  it('배선: 패널은 unplacedMode 로 갈라 그리고, 대수만일 때는 "받다 말았다" 안내를 그리지 않는다', () => {
    const i = TOOL.indexOf("unplacedMode(view) === 'list' ? (<>");
    const j = TOOL.indexOf('view.unplacedTotal > (view.unplaced || []).length');
    const k = TOOL.indexOf('미배치 서버의 목록은 원장을 편집할 수 있는 관리자에게만 보입니다');
    expect(i).toBeGreaterThan(0); expect(j).toBeGreaterThan(i); expect(k).toBeGreaterThan(j);
  });
});

describe('연결된 서버의 이름 줄 — 등록부 이름 · 호스트 이름은 관리자 응답에만', () => {
  it('두 키가 모두 없으면 줄을 그리지 않는다(null) · 키는 있는데 비었으면 —', () => {
    expect(V.linkNameText({ serverId: 'masked-x', model: 'R760' })).toBe(null);
    expect(V.linkNameText(null)).toBe(null);
    expect(V.linkNameText({ name: '', hostname: '' })).toBe('—');
    expect(V.linkNameText({ name: 'kr-esx-01', hostname: '' })).toBe('kr-esx-01');
    expect(V.linkNameText({ name: 'kr-esx-01', hostname: 'os-host' })).toBe('os-host');
  });
  it('배선: 상세 패널이 linkNameText 로 그린다(옛 식 `l.hostname || l.name` 을 직접 쓰지 않는다)', () => {
    expect(TOOL).toContain('linkNameText(l) != null');
    expect(TOOL).not.toContain("l.hostname || l.name || '—'");
  });
});

describe('판 차이 — 이 계정에 보이지 않는 칸만 바뀐 변경', () => {
  it('바뀐 칸 이름이 비어 오면 그 사실을 말한다(빈 글로 두지 않는다)', () => {
    expect(V.fieldsText([])).toBe('이 계정에 보이지 않는 칸');
    expect(V.fieldsText(undefined)).toBe('이 계정에 보이지 않는 칸');
    expect(V.fieldsText(['label', 'note'])).toBe('이름 · 메모');
  });
});

describe('메모 — 관리자 전용 표시', () => {
  it('배선: 고치기 창과 상세 패널이 메모가 관리자에게만 보인다고 밝힌다', () => {
    expect(TOOL).toContain('메모(관리자에게만 보입니다');
    expect(TOOL).toContain('메모(관리자 전용)');
  });
});

describe('가림 집계', () => {
  const resp = {
    fields: { label: { total: 10, addr: 2, tag: 1, firstLabel: 3, altIp: 0 }, model: { total: 4, addr: 0, tag: 0, firstLabel: 0, altIp: 1 } },
    sum: { total: 14, addr: 2, tag: 1, firstLabel: 3, altIp: 1 }, notes: 5,
  };
  it('censusRows: 칸마다 한 행 · 합계 · 타일 값', () => {
    const c = V.censusRows(resp);
    expect(c.rows.map((r) => r.field)).toEqual(Object.keys(V.CENSUS_FIELD_LABEL));
    expect(c.rows[0]).toMatchObject({ field: 'label', label: '표시 이름', total: 10, addr: 2, tag: 1, firstLabel: 3, altIp: 0 });
    expect(c.sum.total).toBe(14); expect(c.hidden).toBe(3); expect(c.wider).toBe(4); expect(c.notes).toBe(5);
  });
  it('못 읽은 값은 0 이 아니다 — 응답에 없는 칸 · 수가 아닌 값은 null', () => {
    const c = V.censusRows({ fields: { label: { total: '7', addr: null } }, sum: { total: 3, addr: 1 } });
    expect(c.rows[0].total).toBe(null); expect(c.rows[0].addr).toBe(null);
    expect(c.rows.find((r) => r.field === 'rackName').total).toBe(null);
    expect(c.hidden).toBe(null); expect(c.wider).toBe(null); expect(c.notes).toBe(null);
    expect(V.censusRows(null).sum.total).toBe(null);
  });
  it('걸린 종류 글', () => {
    expect(V.censusHitsText(['addr', 'firstLabel'])).toBe('주소 · 등록 주소의 첫 마디');
    expect(V.censusHitsText(['new-kind'])).toBe('new-kind'); expect(V.censusHitsText(null)).toBe('');
  });
  it('배선: 집계 창은 열 때 한 번만 부르고(폴링 없음) 늦은 응답을 버리며, 값이 없으면 — 로 그린다', () => {
    expect(CENSUS).toContain("fetchJson('/tools/rack/mask-census')");
    expect(CENSUS).not.toMatch(/setInterval|usePolling/);
    expect(CENSUS).toContain('my === seq.current');
    expect(CENSUS).toContain("v == null ? '—'");
    expect(CENSUS).toContain('<STable');
    expect(TOOL).toContain("tree.canEditTypes ? <button type=\"button\" style={btn} onClick={() => setModal({ kind: 'census' })}>가림 집계</button>");
  });
});
