// v2.700 — 데이터스토어 운영·vSAN 문구·판정. 서버 dscfg/parse.js·analyze.js 와 대조.
import { describe, it, expect } from 'vitest';
import * as web from './dsCfgText.js';
import * as srv from '../../../../server/src/dscfg/parse.js';
import * as an from '../../../../server/src/dscfg/analyze.js';

const DSS = [
  { name: 'a', accessible: false },
  { name: 'b', type: 'VMFS', vmfsMajor: 5, capacityGB: 1000, usedGB: 900, dcfg: { mounts: { total: 4, notAccessible: 1, notMounted: 0 }, maintenance: 'inMaintenance', uncommittedGB: 700, sioc: false, vmCount: 41 } },
  { name: 'c', type: 'NFS', capacityGB: 1000, usedGB: null, dcfg: { mounts: { total: 1, notAccessible: 0, notMounted: 0 }, sioc: false, uncommittedGB: 9999, vmCount: null } },
  { name: 'd' },
];
describe('dsCfgText', () => {
  it('코드·기준값 — 서버와 같다, 문구 키 1:1', () => {
    expect(web.DS_CFG_CODES).toEqual(srv.DS_CFG_CODES);
    expect(web.VSAN_CODES).toEqual(an.VSAN_CODES);
    expect(web.DS_OVERCOMMIT_PCT).toBe(srv.DS_OVERCOMMIT_PCT);
    expect(web.DS_MANY_VMS).toBe(srv.DS_MANY_VMS);
    expect(Object.keys(web.DS_TEXT).sort()).toEqual([...Object.keys(srv.DS_CFG_CODES), ...Object.keys(an.VSAN_CODES)].sort());
  });
  it('판정 — 서버와 같은 입력에서 같은 결과', () => {
    for (const d of DSS) expect(web.dsCfgFindings(d)).toEqual(srv.dsCfgFindings(d));
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of Object.values(web.DS_TEXT)) expect(t.title + t.fix).not.toMatch(/[`*]/);
  });
  it('gbText — 값이 없으면 —', () => {
    expect(web.gbText(null)).toBe('—');
    expect(web.gbText(2048)).toBe('2.0 TB');
  });
});
