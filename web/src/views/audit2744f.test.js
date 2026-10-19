// v2.744 3회차 GF — 웹 문구(읽지 못한 vCenter · 직접 수집 대상 아님) 회귀. 서버 키 집합과 대조한다(번들 경계 — 두 벌).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_READ_WHY_TEXT, notReadNote, notReadKpiSub, notReadCell } from './bizreport/notReadText.js';
import { SKIP_REASON_TEXT, skipNote, skipCell, skippedList } from './vcAuthStopText.js';
import { coverageNote, ADDON_BOUND_NOTE } from './corelicense/coreLicenseText.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/src');

describe('VC-03 읽지 못한 vCenter 문구', () => {
  it('비활성만 빠졌으면 하한이라 말하지 않는다 · 읽지 못한 것이 있으면 하한', () => {
    expect(notReadKpiSub([])).toBe('');
    expect(notReadKpiSub([{ vcenterId: 'o', why: 'disabled' }])).toBe('');
    expect(notReadKpiSub([{ vcenterId: 'u', why: 'unreachable' }, { vcenterId: 'o', why: 'disabled' }])).toBe('읽지 못한 vCenter 1곳 제외 — 하한');
    const n = notReadNote([{ vcenterId: 'u', name: 'VC-U', why: 'unreachable' }, { vcenterId: 'p', name: 'VC-P', why: 'pending' }, { vcenterId: 'o', why: 'disabled' }]);
    expect(n).toContain('읽지 못한 vCenter 2곳');
    expect(n).toContain('하한');
    expect(n).toContain('VC-U');
    expect(n).toContain('비활성 1곳');
    expect(notReadNote(null)).toBe('');
    expect(notReadCell('pending').text).toBe('미수집');
  });
  it('사유 키는 서버(unreadVcenterReasons + 첫 수집 중·비활성)와 1:1', () => {
    const src = fs.readFileSync(path.join(SRC, 'metrics/unreadVcenters.js'), 'utf8');
    for (const k of ['maintenance', 'unreachable', 'stale']) expect(src).toContain(`'${k}'`);
    expect(Object.keys(NOT_READ_WHY_TEXT).sort()).toEqual(['disabled', 'maintenance', 'pending', 'stale', 'unreachable']);
  });
  it('코어 라이선스 안내: 부분 합이면 하한을 먼저 말하고 호스트·데이터스토어 사유 문장을 덧붙이지 않는다', () => {
    const t = coverageNote({ notRead: 2, notReadDisabled: 1, partial: true, vsanAddonBound: 'unknown' });
    expect(t.startsWith('읽지 못한 vCenter 2곳')).toBe(true);
    expect(t).toContain('비활성 vCenter 1곳');
    expect(t).not.toContain(ADDON_BOUND_NOTE.unknown);
    expect(coverageNote({ vsanAddonBound: 'unknown' })).toContain(ADDON_BOUND_NOTE.unknown);
  });
  it('문구에 백틱·별표 두 개가 없다', () => {
    const all = [notReadNote([{ vcenterId: 'u', why: 'stale' }]), notReadKpiSub([{ why: 'pending' }]), notReadCell('x').title, ...Object.values(NOT_READ_WHY_TEXT)];
    for (const s of all) { expect(s).not.toMatch(/`/); expect(s).not.toMatch(/\*\*/); }
  });
});

describe('VC-04 직접 수집 대상 아님(skipReason)', () => {
  it('키는 서버 authStopGate.js DIRECT_SKIP_TEXT 와 1:1', () => {
    const src = fs.readFileSync(path.join(SRC, 'vcenter/authStopGate.js'), 'utf8');
    const block = src.slice(src.indexOf('DIRECT_SKIP_TEXT = Object.freeze({'), src.indexOf('});', src.indexOf('DIRECT_SKIP_TEXT = Object.freeze({')));
    const keys = [...block.matchAll(/^\s+([a-z]+):/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(Object.keys(SKIP_REASON_TEXT).sort());
  });
  it('각주·칸은 인증 정지라고 말하지 않는다', () => {
    expect(skipNote({})).toBe('');
    const n = skipNote({ 'vc-s': { skipReason: 'site' }, 'vc-m': { skipReason: 'maintenance' } });
    expect(n).toContain('2곳');
    expect(n).toContain('엣지 위임');
    expect(n).not.toContain('인증 실패');
    expect(skipCell({ skipReason: 'maintenance', reason: '점검중 vCenter' }).text).toBe('점검중');
    expect(skippedList([])).toEqual([]);
  });
});
