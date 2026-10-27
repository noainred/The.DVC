import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './vmListExportText.js';

describe('v2.798 VM 목록 내보내기(v2.800 백업 현황 › Detail 백업 내보내기) — 항목 고르기 · 내 저장값', async () => {
  const P = await import('../../../server/src/veeam/vmListPrefs.js');
  const C = await import('../../../server/src/veeam/vmListCatalog.js');
  const vms = [
    { id: 'v:1', folder: 'DC/vm/Prod/Web' }, { id: 'v:2', folder: 'DC/vm/Prod' }, { id: 'v:3', folder: 'DC/vm/Dev' }, { id: 'v:4', folder: 'vm' }, { id: 'v:5', folder: 'DC/vm/DMZ' },
  ];

  it('칸 수·이름 상한은 서버와 같다', () => {
    expect([T.SLOT_COUNT, T.NAME_MAX]).toEqual([P.SLOT_COUNT, P.NAME_MAX]);
  });

  it('폴더 고르기 — 상위 포함 · 하위 포함 수 · 트리와 같은 코드 단위 순서(DMZ < Dev)', () => {
    const f = T.folderOptions(vms);
    expect(f.map((x) => [x.path, x.count])).toEqual([['DC', 4], ['DC/DMZ', 1], ['DC/Dev', 1], ['DC/Prod', 2], ['DC/Prod/Web', 1]]);
    expect(T.vmsInFolder(vms, 'DC/Prod').map((v) => v.id)).toEqual(['v:1', 'v:2']);
    expect(T.vmsInFolder(vms, 'DC/Pro').map((v) => v.id)).toEqual([], '이름 앞부분만 같은 폴더는 아니다');
  });

  it('열 순서·토글 — 켜면 끝에 · 모두 켜기는 자리 지킴 · 끝에서 더 못 움직임', () => {
    expect(T.toggleCol(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(T.toggleCol(['a', 'b'], 'a')).toEqual(['b']);
    expect(T.addCols(['b'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(T.moveCol(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(T.moveCol(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
  });

  it('저장할 내용 — 고른 것만 싣고 불러올 때 없는 것은 지금 값 유지', () => {
    const st = { cols: ['name', 'tags'], fmt: 'xlsx', tagCols: true, target: 'folder', folder: 'DC/Prod' };
    const v = T.valueToSave(st, { fmt: true }, '월말');
    expect(v).toEqual({ name: '월말', cols: ['name', 'tags'], fmt: 'xlsx' });
    // 서버 검증을 통과하는 모양(같은 정규화 코어)
    expect(P.normalizeValue(v, { slotNo: 1 }).ok).toBe(true);
    const cur = { cols: ['x'], fmt: 'csv', tagCols: false, target: 'screen', folder: '' };
    expect(T.applyValue(cur, v)).toEqual({ ...cur, cols: ['name', 'tags'], fmt: 'xlsx' });
    expect(T.applyValue(cur, T.valueToSave(st, { target: true, tagCols: true }))).toMatchObject({ target: 'folder', folder: 'DC/Prod', tagCols: true, fmt: 'csv' });
    expect(P.normalizeValue(T.valueToSave(st, { fmt: true, tagCols: true, target: true }), { slotNo: 2 }).ok).toBe(true);
    // 예전(v2.798) 저장값의 multi 는 불러와도 상태에 싣지 않는다(파티션 반복은 없앴다)
    expect('multi' in T.applyValue(cur, { cols: ['name'], multi: 'partRows' })).toBe(false);
  });

  it('창을 열 때 — 기본값, 없으면 서버의 기본 조합', () => {
    const cat = C.catalogView();
    expect(T.initialState(cat, null).cols).toEqual(C.PRESETS.find((p) => p.id === 'base').keys);
    expect(T.initialState(cat, { def: { cols: ['notes'], fmt: 'xlsx' } })).toMatchObject({ cols: ['notes'], fmt: 'xlsx' });
    expect(T.defaultLine(null)).toMatch(/포탈 기본 조합/);
    expect(T.defaultLine({ def: { from: 2, cols: ['a'] }, slots: [null, { name: '월말' }] })).toMatch(/2번 ‘월말’ · 1개 항목/);
  });

  it('상태 배지 — 그 vCenter 의 실제 수집 상태가 우선', () => {
    expect(T.availBadge({ key: 'tags', avail: 'cache' }, { tags: 'not-collected' }).text).toBe('수집 전');
    expect(T.availBadge({ key: 'vjudge', avail: 'snap' }, { tags: 'not-collected' }).text).toBe('항상');
    expect(T.availBadge({ key: 'name', avail: 'snap' }, {}).text).toBe('항상');
  });

  it('내려받기 본문 — 화면 요청에 고른 항목을 붙인다 · 폴더면 그 폴더 id', () => {
    const st = { cols: ['name'], tagCols: false, target: 'screen', folder: '' };
    expect(T.exportBody(st, T.backupScreenRequest(['v:1'], 10)).body).toEqual({ ids: ['v:1'], view: 'detail', cols: ['name'], tagCols: false });
    expect(T.exportBody(st, { body: null, count: 30000, error: '넘습니다' })).toMatchObject({ body: null, error: '넘습니다' });
    expect(T.exportBody({ ...st, target: 'folder' }, null, [{ id: 'v:2' }]).body).toMatchObject({ ids: ['v:2'], view: 'folder' });
  });

  it('화면 — 날 select 없음 · 저장 결과 r?.ok === false 확인 · 늦은 미리보기 버림 · 대문자 변환 없음', () => {
    const src = fs.readFileSync(new URL('./VmListExportDialog.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/<select[\s>]/);
    expect(src).toMatch(/if \(r\?\.ok === false\)/);
    expect(src).toMatch(/if \(my === pvGen\.current\)/);
    expect(src).not.toMatch(/textTransform|text-transform/);
    expect(src).not.toMatch(/multi|partRows/, 'v2.800 — 파티션 한 줄 반복은 없앴다');
  });
});
