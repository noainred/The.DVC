// v2.783(점검 Q1 J-I1): 사용률 분포 패널이 비었을 때 원인을 바로 말한다 — '구동 VM 없음' 과 '다른 패널 선택과의 교집합 0' 을 가르고,
//   막대가 사라진 패널에서도 자기 구간 선택을 풀 버튼을 준다(순수 판정 — vmDistText.js).
import { describe, it, expect } from 'vitest';
import {
  panelState, EMPTY_PANEL_TEXT, otherSelections, panelClearButton, EMPTY_FACETS,
} from './vmDistText.js';

const bins = (m = {}) => Array.from({ length: 20 }, (_, i) => m[i] || 0);
const panel = (o = {}) => ({ bins: bins(o.bins), na: o.na || 0, off: o.off || 0, over100: 0 });

describe('J-I1 panelState — 교집합 0 과 구동 VM 0 을 가른다', () => {
  it('다른 선택이 없으면 예전처럼 none(구동 VM 없음)', () => {
    expect(panelState(panel({ off: 5 }))).toBe('none');
    expect(panelState(panel({ off: 5 }), { others: false })).toBe('none');
    expect(EMPTY_PANEL_TEXT.none).toBe('구동 중인 VM 이 없어 분포가 없습니다');
  });
  it('다른 패널 선택이 있고 구동 VM 이 0 이면 filtered — 문구는 다른 선택을 원인으로 말한다', () => {
    expect(panelState(panel({ off: 5 }), { others: true })).toBe('filtered');
    expect(EMPTY_PANEL_TEXT.filtered).toContain('다른 패널에서 고른 조건과 겹치는 구동 VM 이 없습니다');
    expect(EMPTY_PANEL_TEXT.filtered).not.toContain('`');
    expect(EMPTY_PANEL_TEXT.filtered).not.toContain('**');
  });
  it('값이 있으면 others 와 무관하게 ok·unread·missing 그대로', () => {
    expect(panelState(panel({ bins: { 3: 2 } }), { others: true })).toBe('ok');
    expect(panelState(panel({ na: 4 }), { others: true })).toBe('unread');
    expect(panelState(null, { others: true })).toBe('missing');
  });
});

describe('J-I1 otherSelections — 자기 키를 뺀 선택만 센다', () => {
  it('자기 선택만 있으면 false', () => {
    expect(otherSelections('cpuBin', { ...EMPTY_FACETS, cpuBin: '18-19' }, {})).toBe(false);
    expect(otherSelections('cpuBin', EMPTY_FACETS, { gpuOnly: false, gpuType: '' })).toBe(false);
    expect(otherSelections('cpuBin', null, null)).toBe(false);
  });
  it('다른 패널(메모리 칸·전원·OS)·GPU 선택은 true', () => {
    expect(otherSelections('cpuBin', { ...EMPTY_FACETS, memBin: '19-19' }, {})).toBe(true);
    expect(otherSelections('memBin', { ...EMPTY_FACETS, cpuBin: '0-0' }, {})).toBe(true);
    expect(otherSelections('cpuBin', { ...EMPTY_FACETS, power: 'off' }, {})).toBe(true);
    expect(otherSelections('cpuBin', { ...EMPTY_FACETS, osName: 'Windows Server 2019' }, {})).toBe(true);
    expect(otherSelections('cpuBin', EMPTY_FACETS, { gpuOnly: true, gpuType: '' })).toBe(true);
    expect(otherSelections('cpuBin', EMPTY_FACETS, { gpuOnly: false, gpuType: 'vgpu' })).toBe(true);
  });
  it('형식이 틀린 값(서버에 안 보내는 값)은 선택으로 치지 않는다', () => {
    expect(otherSelections('cpuBin', { ...EMPTY_FACETS, memBin: 'x-y', power: 'bogus' }, { gpuType: 'nope' })).toBe(false);
  });
  it('재현(j_probe2): 메모리 칸 19 + OS 선택으로 교집합 0 → CPU 패널은 filtered 문구', () => {
    const facets = { ...EMPTY_FACETS, memBin: '19-19', osName: 'Windows Server 2019' };
    const st = panelState(panel({ off: 3 }), { others: otherSelections('cpuBin', facets, {}) });
    expect(st).toBe('filtered');
    expect(EMPTY_PANEL_TEXT[st]).not.toBe(EMPTY_PANEL_TEXT.none);
  });
});

describe('J-I1 panelClearButton — 막대가 사라진 패널에서도 자기 선택을 푼다', () => {
  it('ok 상태(막대·90%↑ 버튼이 있음)에서는 따로 두지 않는다', () => {
    expect(panelClearButton('CPU', '18-19', 'ok')).toBe(null);
  });
  it('filtered·none·unread·missing 에서 구간 선택이 있으면 해제 버튼', () => {
    for (const st of ['filtered', 'none', 'unread', 'missing']) {
      const b = panelClearButton('CPU', '18-19', st);
      expect(b).not.toBe(null);
      expect(b.label).toBe('CPU 90~100% 선택 해제');
      expect(b.text).toBe('90~100% 선택 해제');
    }
    expect(panelClearButton('메모리', '7-7', 'filtered').label).toBe('메모리 35~40% 선택 해제');
  });
  it('선택이 없거나 na(미수집 버튼이 이미 남음)·형식 오류면 null', () => {
    expect(panelClearButton('CPU', '', 'filtered')).toBe(null);
    expect(panelClearButton('CPU', 'na', 'filtered')).toBe(null);
    expect(panelClearButton('CPU', '5-2', 'filtered')).toBe(null);
    expect(panelClearButton('CPU', undefined, 'none')).toBe(null);
  });
});
