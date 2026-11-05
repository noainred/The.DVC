import { describe, it, expect } from 'vitest';
import { folderTreeOf, matrixColumns, faultsView, backupView, powerText, srcSummary, groupActions, GROUP_TITLE, REASON_TEXT, pctText, matrixCellValue, regionCell, filterServices, reviewSummary } from './svcInventoryText.js';

const svc = (id, path, n) => ({ id, name: id, path, stat: { n: { total: n } } });

describe('svcInventoryText', () => {
  it('폴더 트리: 명시 폴더 ∪ 서비스 경로 · 노드 수는 아래 서비스 구성원 합 · 빈 폴더 유지', () => {
    const t = folderTreeOf({ folders: ['업무\\개발'] }, [svc('ERP', '업무', 5), svc('MES', '업무\\생산', 3), svc('AD', '', 2)]);
    expect(t.n).toBe(10);
    const work = t.children.find((c) => c.name === '업무');
    expect(work.n).toBe(8);
    expect(work.children.map((c) => c.name)).toEqual(['개발', '생산']);
    expect(work.children.find((c) => c.name === '개발').n).toBe(0);
    expect(t.services.map((s) => s.id)).toEqual(['AD']);
  });
  it('매트릭스 열: 지역별로 묶고 지역을 모르면 따로', () => {
    const cols = matrixColumns([{ vcenterId: 'a', name: 'vc-a' }, { vcenterId: 'b', name: 'vc-b' }, { vcenterId: 'c', name: 'vc-c' }], (id) => ({ a: '유럽', b: '아시아' }[id] || ''));
    expect(cols.map((c) => c.region)).toEqual(['아시아', '유럽', '지역 미지정']);
  });
  it('장애·백업 칸: 기능이 꺼졌거나 Bareos 미사용이면 null — 0 으로 보이지 않는다', () => {
    expect(faultsView({ member: 2, host: 1 }, false)).toBe(null);
    expect(faultsView({ member: 2, host: 1, memberUnknown: 1 }, true)).toEqual({ member: 2, host: 1, unknown: 1, total: 3 });
    expect(backupView({ ok: 1 }, { used: false })).toBe(null);
    expect(backupView({}, { used: true, unreadable: true })).toEqual({ unknown: true });
    expect(backupView({ none: 2, na: 5 }, { used: true })).toEqual({ ok: 0, fail: 0, none: 2, unknown: 0, na: 5 });
    expect(backupView({ na: 5 }, { used: true, unreadable: true })).toEqual({ ok: 0, fail: 0, none: 0, unknown: 0, na: 5 });
    expect(backupView({ unknown: 3, na: 5 }, { used: true, unreadable: true })).toEqual({ unknown: true });
  });
  it('켜짐: 전원을 모르는 구성원은 분모에서 뺀다 · 값 없으면 단위 없이 —', () => {
    expect(powerText({ on: 3, off: 1, unknown: 2 })).toBe('3/4 (+모름 2)');
    expect(pctText(null)).toBe('—');
  });
  it('소속 근거 요약과 묶음 동작 — 백틱 없는 문구', () => {
    expect(srcSummary({ pin: 1, folder: 4, none: 3 }).map((x) => x.k)).toEqual(['pin', 'folder']);
    expect(groupActions({ kind: 'folder', value: '/ERP/prod' }).createName).toBe('prod');
    expect(groupActions({ kind: 'entry', value: 'e1' }).op).toBe('scan.label');
    expect(groupActions({ kind: 'manual' }).pinOnly).toBe(true);
    for (const k of Object.keys(GROUP_TITLE)) expect(GROUP_TITLE[k]({ value: 'x', entry: {} }).includes('`')).toBe(false);
  });
  it('이유별 묶음 제목 — 못 받음은 수동 등록으로 단정하지 않고 법인 귀속 없음은 이유를 밝힌다(5차 2차 반증 1 · R18)', () => {
    expect(GROUP_TITLE.manual({ value: 'not-reported' })).toContain('모릅니다');
    expect(GROUP_TITLE.manual({ value: 'not-reported' })).not.toContain('수동 등록 iDRAC');
    expect(GROUP_TITLE.nocorp({ value: 'tag-conflict' })).toContain('두 법인');
    expect(GROUP_TITLE.nocorp({ value: 'attr-error' })).toContain('오류');
    expect(GROUP_TITLE.nocorp({ value: '' })).toContain('어느 귀속 규칙에도');
    for (const k of ['source-unreported', 'no-corp-error', 'no-corp-conflict']) { expect(REASON_TEXT[k]).toBeTruthy(); expect(REASON_TEXT[k].includes('`')).toBe(false); }
  });
  it('매트릭스 칸 모드 · 지역 합계(5차 M9) — CPU 는 Σ사용÷Σ용량(법인 평균의 평균 아님) · 못 읽는 법인은 CPU·장애에서 뺀다', () => {
    const a = { n: 3, faults: 2, stale: false, alloc: { vcpu: 8 }, usage: { cpu: 50, cpuUsed: 10, cpuTotal: 20 } };
    const b = { n: 1, faults: 1, stale: false, alloc: { vcpu: 4 }, usage: { cpu: 10, cpuUsed: 1, cpuTotal: 10 } };
    const st = { n: 5, faults: 9, stale: true, alloc: { vcpu: 2 }, usage: { cpu: 90, cpuUsed: 90, cpuTotal: 100 } };
    expect(matrixCellValue(a, 'n', true).text).toBe('3');
    expect(matrixCellValue(a, 'cpu', true).text).toBe('50%');
    expect(matrixCellValue(st, 'cpu', true).text).toBe('—');
    expect(matrixCellValue(a, 'faults', false).text).toBe('—');
    expect(matrixCellValue(a, 'vcpu', true).text).toBe('8');
    expect(regionCell([a, b, st, undefined], 'cpu', true).text).toBe('37%');   // (10+1)/(20+10) — (50+10)/2=30 이 아니다
    expect(regionCell([a, b, st], 'faults', true)).toMatchObject({ v: 3, stale: 1, corps: 3 });
    expect(regionCell([a, b, st], 'n', true).v).toBe(9);
    expect(regionCell([a, b], 'vcpu', true).v).toBe(12);
    expect(regionCell([undefined], 'n', true)).toBe(null);
    expect(regionCell([{ n: 1, usage: { cpu: null } }], 'cpu', true).text).toBe('—');
  });
  it('서비스 표 찾기·필터(5차 M8) · 검토 필요 요약(R17 — 수에 들어가는 것을 부제에 전부)', () => {
    const list = [{ name: 'ERP', path: '업무', owner: 'kim', corp: 'vc-a', tier: 1 }, { name: 'MES', path: '', owner: '', corp: 'vc-b', tier: 2 }];
    const cn = (id) => ({ 'vc-a': 'vcenter-seoul', 'vc-b': 'vcenter-pl' }[id]);
    expect(filterServices(list, { q: 'seoul', corpName: cn }).map((x) => x.name)).toEqual(['ERP']);
    expect(filterServices(list, { q: '업무' }).map((x) => x.name)).toEqual(['ERP']);
    expect(filterServices(list, { tier1: true }).map((x) => x.name)).toEqual(['ERP']);
    expect(filterServices(list, { noOwner: true }).map((x) => x.name)).toEqual(['MES']);
    const r = reviewSummary({ drift: 2, mismatch: 1, ghosts: 0, tagAmbiguous: 3, ghostsHeld: 4 });
    expect(r.n).toBe(6);
    expect(r.meta).toContain('법인 불일치 1'); expect(r.meta).toContain('태그 모호 3'); expect(r.meta).toContain('판정 보류 4');
    expect(reviewSummary({}).n).toBe(0);
  });
});
