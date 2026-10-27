// v2.801 — 미리보기 '크게 보기'(전체 화면 팝업) 도우미. 칸 색 규칙은 서버 vmXlsxStyle 과 한 쌍(서버 테스트 vmExcel2801 이 대조).
import { describe, it, expect } from 'vitest';
import { cellTone, cellText, folderGroups, matchRows, bandsOf, folderLine, PREVIEW_BIG } from './exportPreviewText.js';
import { exportBody, initialState, valueToSave, applyValue, badgeOf } from './vmExportText.js';
import * as VL from '../vmListExportText.js';

describe('exportPreviewText', () => {
  it('칸 색 — 엑셀과 같은 규칙(값은 그대로)', () => {
    expect(cellTone('수집 안 됨', 'uuid')).toBe('missing');
    expect(cellTone('내려받을 때 조회', 'uuid')).toBe('missing');
    expect(cellTone('POWERED_ON', 'powerState')).toBe('on');
    expect(cellTone('꺼짐', 'power')).toBe('off');
    // v2.807 백업 방식 색(서버 METHOD_LOOK 과 한 쌍 — 서버 vmExcel2801 ⑥ 대조)
    expect(['Veeam', 'Clone', 'Config 백업', '백업 안함', ''].map((v) => cellTone(v, 'bmethod'))).toEqual(['m-veeam', 'm-clone', 'm-config', 'm-none', '']);
    expect(cellTone('SUSPENDED', 'powerState')).toBe('warn');
    expect(cellTone(95, 'cpuUsagePct')).toBe('hot');
    expect(cellTone(80, 'memUsagePct')).toBe('warm');
    expect(cellTone(79.9, 'memUsagePct')).toBe('');
    expect(cellTone(95, 'cpuCount')).toBe('', '사용률이 아닌 수는 색 없음');
    expect(cellTone('예', 'vbkYn')).toBe('yes');
    expect(cellTone('아니오', 'vsnapYn')).toBe('no');
    expect(cellTone('모름', 'vbkYn')).toBe('off');
    expect(cellTone('아니오', 'notes')).toBe('', '여부 열이 아니면 손대지 않는다');
    expect(cellTone('Veeam 백업', 'vjudge')).toBe('v-veeam');
    expect(cellTone('스냅샷 흔적만(Veeam 대상 아님)', 'vjudge')).toBe('v-snap');
    expect(cellTone('web-01', 'name')).toBe('name');
  });
  it('숫자는 천 단위 쉼표 · null 은 빈칸', () => {
    expect(cellText(12345)).toBe('12,345');
    expect(cellText(1.25)).toBe('1.3');
    expect(cellText(null)).toBe('');
    expect(cellText('=cmd')).toBe('=cmd');
  });
  it('폴더별로 나눠 보기 — 트리 순서(상위 먼저 · 코드 단위) · 최상위는 맨 뒤 · 폴더 안 순서는 그대로', () => {
    const folders = ['B', '', 'A/x', 'A', 'A/x', 'DMZ', 'Dev'];
    const g = folderGroups(folders, folders.length);
    expect(g.map((x) => x.folder)).toEqual(['A', 'A/x', 'B', 'DMZ', 'Dev', '']);
    expect(g.find((x) => x.folder === 'A/x').rows).toEqual([2, 4]);
    expect(folderLine('A/x', 2)).toBe('A / x · 2 VM');
    expect(folderLine('', 1)).toBe('(최상위) · 1 VM');
  });
  it('찾기 · 묶음 띠', () => {
    const cells = [['web-01', '10.0.0.1'], ['DB-01', '10.0.0.2'], ['app', null]];
    expect(matchRows(cells, '')).toEqual([0, 1, 2]);
    expect(matchRows(cells, 'db')).toEqual([1]);
    expect(matchRows(cells, '10.0.0')).toEqual([0, 1]);
    const b = bandsOf([{ group: 'base' }, { group: 'base' }, { group: 'cpu' }, { group: 'base' }], (g) => ({ base: '기본', cpu: 'CPU' }[g]));
    expect(b).toEqual([{ group: 'base', name: '기본', span: 2 }, { group: 'cpu', name: 'CPU', span: 1 }, { group: 'base', name: '기본', span: 1 }]);
    expect(PREVIEW_BIG).toBe(100);
  });
});

describe('여부 기준 일수(ynDays) — 요청 본문·저장값', () => {
  const cat = { presets: [{ id: 'asset', keys: ['name'] }], defaultPreset: 'asset', ynDefault: 1 };
  it('VM 전체 정보', () => {
    const st = initialState(cat, null);
    expect(st.ynDays).toBe(1);
    expect(exportBody({ ...st, ynDays: 3 }).ynDays).toBe(3);
    expect(exportBody({ ...st, ynDays: 5 }).ynDays).toBeUndefined();
    expect(valueToSave({ ...st, ynDays: 7 }, { view: true }).ynDays).toBe(7);
    expect(valueToSave({ ...st, ynDays: 7 }, {}).ynDays).toBeUndefined();
    expect(applyValue(st, { cols: ['name'], ynDays: 2 }).ynDays).toBe(2);
    expect(applyValue(st, { cols: ['name'], ynDays: 9 }).ynDays).toBe(1);
    expect(badgeOf({ src: 'veeam' })).toEqual({ text: 'Veeam', tone: 'cache' });
  });
  it('VM 목록', () => {
    const st = VL.initialState({ presets: [{ id: 'base', keys: ['name'] }], ynDefault: 1 }, null);
    expect(st.ynDays).toBe(1);
    expect(VL.exportBody({ ...st, ynDays: 2 }, { body: { ids: ['a'] }, count: 1 }).body.ynDays).toBe(2);
    expect(VL.valueToSave({ ...st, ynDays: 3 }, { ynDays: true }).ynDays).toBe(3);
    expect(VL.valueToSave({ ...st, ynDays: 3 }, {}).ynDays).toBeUndefined();
    expect(VL.applyValue(st, { cols: ['name'], ynDays: 7 }).ynDays).toBe(7);
  });
});
