// v2.702(A7·A8) — VM 이동·구성 변경 문구. 서버 판정(analyze.js)의 종류 키와 1:1 인지 대조한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { analyzeMoves, analyzeChanges } from '../../../../server/src/vmchanges/analyze.js';
import { MOVE_KIND_LABEL, CHANGE_KIND_LABEL, routeText, coverageNote, truncNote, noDetailNote, changeText, fmtTs } from './vmChangesText.js';

const NOW = Date.UTC(2026, 9, 5, 3, 30);

describe('vmChangesText', () => {
  it('이동·변경 종류 키가 서버 판정과 1:1', () => {
    expect(Object.keys(MOVE_KIND_LABEL).sort()).toEqual(Object.keys(analyzeMoves([], { now: NOW }).byKind).sort());
    expect(Object.keys(CHANGE_KIND_LABEL).sort()).toEqual(Object.keys(analyzeChanges([]).byKind).sort());
  });
  it('경로 문구 — 모르는 쪽은 ?, 둘 다 모르면 —', () => {
    expect(routeText('a', 'b')).toBe('a → b');
    expect(routeText(null, 'b')).toBe('? → b');
    expect(routeText(null, null)).toBe('—');
    expect(routeText('a', 'a')).toContain('같은 호스트');
  });
  it('수집 범위 — 이벤트를 받은 적 없는 vCenter 를 이동 없음이라 말하지 않는다 · 수집 꺼짐을 먼저 말한다', () => {
    expect(coverageNote({ logs: { enabled: false }, vcenters: [] })).toContain('꺼져');
    const n = coverageNote({ logs: { enabled: true, minSeverity: 'info' }, vcenters: [{ name: 'A', lastTs: null }, { name: 'B', lastTs: NOW }] }, NOW);
    expect(n).toContain('1곳'); expect(n).toContain("'이동 없음' 이 아닙니다");
    expect(coverageNote({ logs: { enabled: true, minSeverity: 'warning' }, vcenters: [{ name: 'B', lastTs: NOW }] }, NOW)).toContain('warning');
    expect(coverageNote({ logs: { enabled: true, minSeverity: 'info' }, vcenters: [{ name: 'B', lastTs: NOW }] }, NOW)).toBeNull();
    expect(coverageNote({ logs: { enabled: true }, vcenters: [{ name: 'B', lastTs: NOW - 3 * 86_400_000 }] }, NOW)).toContain('이틀');
  });
  it('잘림·상세 없음 문구', () => {
    expect(truncNote({ truncated: true, readMax: 20000 })).toContain('20,000');
    expect(truncNote({ truncated: false })).toBeNull();
    expect(noDetailNote(0, 5)).toBeNull();
    expect(noDetailNote(3, 10)).toContain('3건');
  });
  it('변경 문구 — 원문(변경 전/후)이 먼저, 없으면 바뀐 값, 상세 없으면 그 사실', () => {
    expect(changeText({ kind: 'reconfig', lines: [{ k: 'modified', text: 'cpu 4 -> 8' }] })).toBe('변경: cpu 4 -> 8');
    expect(changeText({ kind: 'reconfig', lines: [], numCpu: 8, memoryMB: 16384, devices: ['add VirtualDisk'] })).toBe('vCPU 8 · 메모리 16 GB · 장치 add VirtualDisk');
    expect(changeText({ kind: 'reconfig', lines: [], fields: ['annotation'] })).toContain('annotation');
    expect(changeText({ kind: 'reconfig', lines: [], hasDetail: false })).toContain('모름');
    expect(changeText({ kind: 'permission', principal: 'CORP\\x', group: true, role: 'Admin', propagate: true })).toBe('CORP\\x(그룹) · 역할 Admin · 하위 전파');
    expect(changeText({ kind: 'role' })).toBe('—');
  });
  it('시각 — 숫자가 아니면 —(1970년을 지어내지 않는다)', () => {
    expect(fmtTs(null)).toBe('—');
    expect(fmtTs(NOW)).not.toBe('—');
  });
  it('문구·화면에 백틱 없음', () => {
    for (const f of ['src/views/vmchanges/vmChangesText.js', 'src/views/tools/VmChangesTool.jsx']) {
      const s = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(s.includes('\\`')).toBe(false);
    }
  });
});
