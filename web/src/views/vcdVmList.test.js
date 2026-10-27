// vcdVmList.test.js — VM 목록 내보내기 id 상한(v2.792) · 백업 현황 화면 대상(v2.800). 서버 상한과 같은 값인지 대조한다.
import { describe, it, expect } from 'vitest';
import { VM_LIST_MAX_IDS } from './vcdVmList.js';
import { backupScreenRequest } from './vmListExportText.js';

describe('VM 목록 내보내기 대상', () => {
  it('상한은 서버와 같다', async () => {
    const S = await import('../../../server/src/veeam/vmListCsv.js');
    expect(VM_LIST_MAX_IDS).toBe(S.VM_LIST_MAX_IDS);
  });
  it('백업 현황 화면 — 보이는 VM id 그대로 · 0대는 빈 목록(전체를 보내지 않는다) · 상한을 넘으면 보내지 않고 이유', () => {
    expect(backupScreenRequest(['a', 'b'], 5)).toEqual({ body: { ids: ['a', 'b'], view: 'detail' }, count: 2 });
    expect(backupScreenRequest([], 5)).toEqual({ body: { ids: [], view: 'detail' }, count: 0 });
    const r = backupScreenRequest(['a', 'b', 'c'], 2);
    expect(r.body).toBe(null); expect(r.error).toMatch(/넘습니다/);
  });
});
