// vcdVmList.test.js — VM 목록 CSV·엑셀 요청 본문(v2.792). 서버 상한과 같은 값인지 대조한다. view 는 표시용 이름표(파일 이름·엑셀 '화면 조건').
import { describe, it, expect } from 'vitest';
import { vmListRequest, VM_LIST_MAX_IDS } from './vcdVmList.js';

const vms = (n, off = 0) => Array.from({ length: n }, (_, i) => ({ id: `vc:vm-${i}`, powerState: i < off ? 'POWERED_OFF' : 'POWERED_ON' }));

describe('VM 목록 CSV 요청', () => {
  it('검색이 없으면 화면 목록(visibleVms) 그대로 · 있으면 일치 VM 만', () => {
    expect(vmListRequest({ visibleVms: vms(3) })).toEqual({ body: { ids: ['vc:vm-0', 'vc:vm-1', 'vc:vm-2'], view: 'all' }, count: 3 });
    const m = [{ v: { id: 'vc:vm-1' } }];
    expect(vmListRequest({ query: ' web ', matches: m, visibleVms: vms(3) }).body).toEqual({ ids: ['vc:vm-1'], view: 'search' });
    expect(vmListRequest({ visibleVms: vms(2), inclPoweredOff: false }).body.view).toBe('noOff');
    expect(vmListRequest({ query: 'zzz', matches: [], visibleVms: vms(3) })).toEqual({ body: { ids: [], view: 'search' }, count: 0 }, '일치 0대면 빈 목록(전체를 보내지 않는다)');
  });
  it('상한을 넘으면 — 검색 없음: 전원 조건으로 · 검색 중: 거절(일부만 담지 않는다)', () => {
    expect(vmListRequest({ visibleVms: vms(5), max: 4, inclPoweredOff: false }).body).toEqual({ power: 'noOff', view: 'noOff' });
    expect(vmListRequest({ visibleVms: vms(5), max: 4 }).body).toEqual({ power: 'all', view: 'all' });
    const r = vmListRequest({ query: 'a', matches: vms(5).map((v) => ({ v })), max: 4 });
    expect(r.body).toBe(null); expect(r.error).toMatch(/검색어를 좁혀/);
  });
  it('상한은 서버와 같다', async () => {
    const S = await import('../../../server/src/veeam/vmListCsv.js');
    expect(VM_LIST_MAX_IDS).toBe(S.VM_LIST_MAX_IDS);
  });
});
