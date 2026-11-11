import { describe, it, expect } from 'vitest';
import { presetKeys, selectionSummary, hwExportQuery, summaryLine, stateFromPrefs, corpCount, screenCorpIds } from './fleetHwExportText.js';

// 서버 catalogForClient 모양(값 이름은 서버가 준다).
const catalog = [
  { key: 'id', name: '기본 식별', sum: [{ key: 'id.sum.corp', locked: true }, { key: 'id.sum.name', locked: true }, { key: 'id.sum.model', basic: true }], det: [] },
  { key: 'cpu', name: 'CPU', sheet: 'CPU', sum: [{ key: 'cpu.sum.cores', basic: true }], det: [{ key: 'cpu.det.socket' }] },
  { key: 'nic', name: '네트워크 인터페이스', sheet: 'NIC', sum: [{ key: 'nic.sum.ports' }], det: [{ key: 'nic.det.speedMbps' }] },
  { key: 'fw', name: '펌웨어', sheet: '펌웨어', sum: [], det: [{ key: 'fw.det.version' }] },
];
const basicKeys = ['id.sum.corp', 'id.sum.name', 'id.sum.model', 'cpu.sum.cores', 'nic.det.mac'];
const corps = [{ id: 'a', name: 'vc-a', bm: 2, vh: 3 }, { id: 'b', name: 'vc-b', bm: 1, vh: 0 }, { id: '__none__', name: '미지정', bm: 1, vh: 0 }];

describe('fleetHwExportText', () => {
  it('묶음 — 잠긴 값은 늘 · 서버가 주지 않은 key(관리자 전용 등)는 넣지 않는다', () => {
    expect([...presetKeys('basic', catalog, basicKeys)].sort()).toEqual(['cpu.sum.cores', 'id.sum.corp', 'id.sum.model', 'id.sum.name']);
    expect([...presetKeys('none', catalog, basicKeys)].sort()).toEqual(['id.sum.corp', 'id.sum.name']);
    expect(presetKeys('net', catalog, basicKeys).has('nic.det.speedMbps')).toBe(true);
    expect(presetKeys('net', catalog, basicKeys).has('fw.det.version')).toBe(true);
    expect(presetKeys('all', catalog, basicKeys).size).toBe(8);
  });

  it('대수 · 요약 — 대상별 · 고른 법인만 · CSV 표가 여럿이면 zip · 사양서는 엑셀만', () => {
    expect(corpCount(corps[0], 'both')).toBe(5);
    const sel = new Set(['id.sum.corp', 'id.sum.name', 'cpu.sum.cores', 'nic.det.speedMbps']);
    const x = selectionSummary({ catalog, sel, format: 'xlsx', band: 'band', spec: true, corps, kind: 'bm', corpSel: null });
    expect([x.servers, x.cols, x.detGroups, x.tables, x.sheets, x.ext]).toEqual([4, 3, 1, 2, 2 + 1 + 5, 'xlsx']);
    const c = selectionSummary({ catalog, sel, format: 'csv', band: 'sheet', spec: true, corps, kind: 'bm', corpSel: new Set(['a', 'b']) });
    expect([c.servers, c.tables, c.ext, c.sheets]).toEqual([3, 3, 'zip', 0]);
    const one = selectionSummary({ catalog, sel: new Set(['id.sum.corp']), format: 'csv', band: 'band', spec: false, corps, kind: 'vh', corpSel: null });
    expect([one.servers, one.ext]).toEqual([3, 'csv']);
    expect(summaryLine(one, 'csv')).toBe('서버 3대 · 요약 열 1개 · 상세 0종 · CSV 1개');
    expect(summaryLine({ picked: 0 }, 'xlsx')).toMatch(/법인을 고르면/);
  });

  it('쿼리 — 모든 법인이면 corps 를 싣지 않고, CSV 에는 spec 을 싣지 않고, 값은 카탈로그 순서', () => {
    const sel = new Set(['nic.det.speedMbps', 'id.sum.corp', 'cpu.sum.cores']);
    const q = new URLSearchParams(hwExportQuery({ format: 'xlsx', kind: 'both', band: 'col', spec: true, corpSel: null, sel, catalog }).slice(1));
    expect(q.get('corps')).toBe(null);
    expect(q.get('spec')).toBe('1');
    expect(q.get('fields')).toBe('id.sum.corp,cpu.sum.cores,nic.det.speedMbps');
    const q2 = new URLSearchParams(hwExportQuery({ format: 'csv', kind: 'zzz', band: 'x', spec: true, corpSel: new Set(['a', '__none__']), sel, catalog }).slice(1));
    expect([q2.get('format'), q2.get('kind'), q2.get('band'), q2.get('spec'), q2.get('corps')]).toEqual(['csv', 'bm', 'band', null, 'a,__none__']);
  });

  it('저장값 → 창 상태 — 없으면 기본안(엑셀 · 띠 · 기본 묶음 · 사양서 끔), 모르는 값은 버림', () => {
    const d = stateFromPrefs(null, catalog, basicKeys);
    expect([d.format, d.band, d.spec, d.sel.size]).toEqual(['xlsx', 'band', false, 4]);
    const p = stateFromPrefs({ fmt: 'csv', band: 'sheet', spec: true, cols: ['fw.det.version', 'gone.key'] }, catalog, basicKeys);
    expect([p.format, p.band, p.spec]).toEqual(['csv', 'sheet', true]);
    expect([...p.sel].sort()).toEqual(['fw.det.version', 'id.sum.corp', 'id.sum.name']);
  });

  it('화면 필터대로 — vCenter 필터를 법인으로 옮기고, 대응을 모르면 모든 법인(null)', () => {
    const vcCorp = { 'vc-az': 'a', 'vc-az-irs': 'a', 'vc-x': 'gone' };
    expect([...screenCorpIds('vc-az-irs', vcCorp, corps)]).toEqual(['a']);
    expect([...screenCorpIds('__none__', vcCorp, corps)]).toEqual(['__none__']);
    expect(screenCorpIds('', vcCorp, corps)).toBe(null);
    expect(screenCorpIds('vc-x', vcCorp, corps)).toBe(null);
    expect(screenCorpIds('vc-unknown', vcCorp, corps)).toBe(null);
    expect(screenCorpIds('vc-az', null, corps)).toBe(null);
  });
});
