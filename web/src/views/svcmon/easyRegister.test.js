import { describe, it, expect } from 'vitest';
import { idsByFolder, folderCheck, toggleIds, selectionInfo, corpPlan, pickedPlan, trialHeadline } from './easyRegister.js';

const T = (id, path, o = {}) => ({ id, path, name: id, tests: [{ id: `${id}-1` }, { id: `${id}-2` }], ...o });

describe('v2.960 쉬운 등록 — 트리 선택', () => {
  const targets = [T('a', 'X\\Y'), T('b', 'X\\Y\\Z', { enabled: false, agent: 'e1' }), T('c', 'X'), T('d', 'Q', { enabled: false })];
  const m = idsByFolder(targets);
  it('폴더 → 하위 포함 대상 id(Root 는 전체)', () => {
    expect(m.get('')).toEqual(['a', 'b', 'c', 'd']);
    expect(m.get('X')).toEqual(['a', 'b', 'c']);
    expect(m.get('X\\Y')).toEqual(['a', 'b']);
    expect(m.get('X\\Y\\Z')).toEqual(['b']);
  });
  it('폴더 체크 상태 · 누르면 전부 골라져 있을 때만 뺀다', () => {
    expect(folderCheck(m.get('X'), new Set())).toBe('none');
    expect(folderCheck(m.get('X'), new Set(['a']))).toBe('some');
    expect(folderCheck(m.get('X'), new Set(['a', 'b', 'c']))).toBe('all');
    expect(folderCheck([], new Set(['a']))).toBe('none');
    const p1 = toggleIds(new Set(['a']), m.get('X'));
    expect([...p1].sort()).toEqual(['a', 'b', 'c']);
    expect([...toggleIds(p1, m.get('X\\Y'))]).toEqual(['c']);
  });
  it('고른 대상 요약 — 중지 · 사용 · 엣지 전용', () => {
    expect(selectionInfo(new Set(['a', 'b', 'd', 'ghost']), targets)).toEqual({ targets: 3, tests: 6, off: 2, on: 1, edge: 1 });
  });
});

describe('v2.960 쉬운 등록 — 법인별 추천 등록', () => {
  const rows = [
    { key: 'k1', state: 'new', corpKey: 'dc-fra', corp: 'Frankfurt 법인', corpAgent: 'Edge-FRA', kind: 'set:idrac', kindLabel: 'iDRAC', checks: [{ name: 'TCP 443' }] },
    { key: 'k2', state: 'new', corpKey: 'dc-fra', corp: 'Frankfurt 법인', corpAgent: 'Edge-FRA', kind: 'set:pdu', kindLabel: 'PDU' },
    { key: 'k3', state: 'linked', corpKey: 'dc-fra', corp: 'Frankfurt 법인', kind: 'set:cvp', kindLabel: 'Arista CVP', targetId: 'g1', targetEnabled: false },
    { key: 'k4', state: 'linked', corpKey: 'dc-sel', corp: 'Seoul 법인', kind: 'set:cvp', kindLabel: 'Arista CVP', targetId: 'g2', targetEnabled: true },
    { key: 'k5', state: 'new', corpKey: '', corp: '전역', kind: 'set:bmstor', kindLabel: '베어메탈 스토리지(SSH)' },
    { key: 'k6', state: 'excluded', corpKey: 'dc-fra', kind: 'set:webhook' },
    { key: 'k7', state: 'problem', corp: '전역', kind: 'set:pdu', kindLabel: 'PDU' },   // 서버의 설정 문제 행은 corpKey 가 없다(법인 미상으로 센다)
    { key: 'k8', state: 'gone', corpKey: 'dc-fra', kind: 'set:pdu', targetId: 'g9', targetEnabled: false },
  ];
  const g = corpPlan(rows);
  it('법인 묶음 — 미감시(미등록 + 등록됐지만 중지) 많은 순 · 법인 미상은 맨 뒤 · 제외 · 사라짐은 빼고 설정 문제는 따로 센다', () => {
    expect(g.map((x) => [x.key, x.label, x.unmonitored, x.total])).toEqual([['dc-fra', 'Frankfurt 법인', 3, 3], ['dc-sel', 'Seoul 법인', 0, 1], ['', '법인 미상', 1, 1]]);
    expect(g[0].agent).toBe('Edge-FRA');
    expect(g[1].problem).toBe(0);
    expect(g[2].problem).toBe(1, '설정 문제 행은 법인 미상 묶음에서 센다');
    expect(g[0].kinds.find((k) => k.kind === 'set:idrac').checks).toBe('TCP 443');
  });
  it('고른 법인 · 뺀 종류 → 등록할 키 · 켤 대상(사용 중인 것은 건드리지 않는다)', () => {
    expect(pickedPlan(g, new Set(['dc-fra', 'dc-sel']))).toEqual({ keys: ['k1', 'k2'], offIds: ['g1'], corps: 1, newN: 2, offN: 1 });
    expect(pickedPlan(g, new Set(['dc-fra']), new Set(['dc-fra|set:pdu', 'dc-fra|set:cvp']))).toEqual({ keys: ['k1'], offIds: [], corps: 1, newN: 1, offN: 0 });
    expect(pickedPlan(g, new Set())).toEqual({ keys: [], offIds: [], corps: 0, newN: 0, offN: 0 });
  });
  it('시험 작업 머리 문구', () => {
    expect(trialHeadline({ counts: { pass: 9, fail: 2, wait: 2, skip: 0, running: 0 } })).toBe('통과 9 · 실패 2 · 엣지 보고 대기 2');
    expect(trialHeadline(null)).toBe('대상 없음');
  });
});

describe('v2.988 isFullScopeEditor — 서버 canEdit + fullScopeOnly 와 같은 기준(사용/중지 · 시험 · 지금 한 번 점검)', async () => {
  const { isFullScopeEditor } = await import('./svcmonAccess.js');
  it('판정', () => {
    expect(isFullScopeEditor({ role: 'admin' })).toBe(true);
    expect(isFullScopeEditor({ role: 'operator' })).toBe(true);
    expect(isFullScopeEditor({ role: 'operator', scope: { vcenters: ['vc-pl'] } })).toBe(false);   // v2.960 은 스위치를 열고 403 을 받았다
    expect(isFullScopeEditor({ role: 'operator', scope: { regions: ['EU'] } })).toBe(false);
    expect(isFullScopeEditor({ role: 'viewer' })).toBe(false);
    expect(isFullScopeEditor({ role: 'admin', demoGuest: true })).toBe(false);
    expect(isFullScopeEditor(null)).toBe(false);
  });
  it('트리 스위치 · 상세 창 버튼이 이 판정을 쓰고, 지금 한 번 점검은 실행 역할일 때만', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../SvcMonitor.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/const canToggle = canEdit && isFullScopeEditor\(me\) && data\?\.centralNode !== false/);
    expect(src).toMatch(/\{canToggle && data\?\.executes !== false && \(\(\) => \{/);
  });
});
