// v2.963 — 목록 없이 연 VM 드로어의 신호: 응답 해석(순수) · 첫 렌더는 '확인 중'(신호를 받지 않았다고 말하지 않는다) · 신호가 있으면 묻지 않는다 · 소스 스윕.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../../test/_stripComments.js';
import { signalsFromLookup } from './vmSeries.jsx';

vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: () => ({ data: null, error: null, loading: true }), toolAllowed: () => true, hasRole: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('signalsFromLookup — /vms/lookup?signals=1 응답 해석', () => {
  it('같은 VM · 배열이면 신호와 기준 일수 · 문자열만 남긴다', () => {
    expect(signalsFromLookup({ vm: { id: 'a', signals: ['overload', 'snapOld'] }, snapAgeDays: 7 }, 'a')).toEqual({ signals: ['overload', 'snapOld'], days: 7 });
    expect(signalsFromLookup({ vm: { id: 'a', signals: [] }, snapAgeDays: null }, 'a')).toEqual({ signals: [], days: null });
    expect(signalsFromLookup({ vm: { id: 'a', signals: ['overload', 3, null] }, snapAgeDays: '7' }, 'a')).toEqual({ signals: ['overload'], days: 7 });
    expect(signalsFromLookup({ vm: { id: 'a', signals: [] }, snapAgeDays: '' }, 'a').days).toBe(null);   // 못 읽은 값은 0 이 아니다
  });
  it('VM 이 없거나(지워짐 · 범위 밖) 다른 VM 이거나 신호가 없으면 missing — 신호 없음으로 말하지 않는다', () => {
    expect(signalsFromLookup({ vm: null }, 'a')).toEqual({ missing: true });
    expect(signalsFromLookup({ vm: { id: 'b', signals: [] } }, 'a')).toEqual({ missing: true });
    expect(signalsFromLookup({ vm: { id: 'a' } }, 'a')).toEqual({ missing: true });
    expect(signalsFromLookup(null, 'a')).toEqual({ missing: true });
  });
});

describe('VmDrawer — 신호 없이 열리면', () => {
  it('첫 렌더는 신호 확인 중(목록이 신호를 받지 않았다는 문구가 아니다)', async () => {
    const { default: VmDrawer } = await import('./VmDrawer.jsx');
    const vm = { id: 'vc1:vm-9', vcenterId: 'vc1', name: 'from-alarm', powerState: 'POWERED_ON', cpuUsagePct: 95, memUsagePct: 20 };
    const html = renderToStaticMarkup(React.createElement(VmDrawer, { vm, rows: [], onClose: () => {}, onMove: () => {}, days: null }));
    expect(html).toContain('신호 확인 중');
    expect(html).not.toContain('신호를 함께 받지 않았습니다');
    expect(html).toContain('신호 — — 봐야 할 것');
  });
  it('신호를 가진 항목은 그대로 쓴다(다시 묻지 않는다)', async () => {
    const { default: VmDrawer } = await import('./VmDrawer.jsx');
    const vm = { id: 'vc1:vm-8', vcenterId: 'vc1', name: 'from-list', powerState: 'POWERED_ON', cpuUsagePct: 95, memUsagePct: 20, signals: ['overload'] };
    const html = renderToStaticMarkup(React.createElement(VmDrawer, { vm, rows: [vm], onClose: () => {}, onMove: () => {}, days: 7 }));
    expect(html).not.toContain('신호 확인 중');
    expect(html).toContain('CPU·메모리 90%↑');
  });
});

describe('소스 스윕', () => {
  it('드로어는 신호가 없을 때만 lookup 을 묻고(훅은 조기 return 위) · 기준 일수는 prop 우선', () => {
    const s = read('./VmDrawer.jsx');
    expect(s).toMatch(/useVmSignals\(vm\?\.id, !!vm && !Array\.isArray\(vm\.signals\)\)/);
    expect(s.indexOf('useVmSignals(')).toBeLessThan(s.indexOf('if (!vm) return null'));
    expect(s).toMatch(/const sigDays = days \?\? fetched\.days \?\? null/);
    const h = read('./vmSeries.jsx');
    expect(h).toMatch(/fetchJson\('\/vms\/lookup', \{ id: vmId, signals: '1' \}, ac\.signal/);
    expect(h).not.toMatch(/setInterval/);   // 폴링하지 않는다(열 때 1회)
  });
});
