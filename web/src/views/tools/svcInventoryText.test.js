import { describe, it, expect } from 'vitest';
import { folderTreeOf, matrixColumns, faultsView, backupView, powerText, srcSummary, groupActions, GROUP_TITLE, pctText } from './svcInventoryText.js';

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
});
