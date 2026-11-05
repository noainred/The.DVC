// v2.697(B10) — VM 구성 점검 문구·판정. 서버 vmcfg/parse.js 와 같은 입력으로 대조한다(번들 경계라 두 벌).
import { describe, it, expect } from 'vitest';
import * as web from './vmCfgText.js';
import * as srv from '../../../../server/src/vmcfg/parse.js';

const VMS = [
  { name: 'a', cfg: { question: { text: 'q' }, consolidationNeeded: true, cpuLimitMhz: 100, memLimitMB: 0, cbt: false, cpuReservationMhz: 5, guestIdConfig: 'rhel7_64Guest', guestIdTools: 'rhel8_64Guest', guestHostName: 'b.x', managedBy: { extensionKey: 'k', type: null } } },
  { name: 'tmpl', template: true, cfg: { question: { text: 'q' }, cbt: false }, dev: { cdroms: [{ connected: true, iso: true, file: 'f' }] } },
  { name: '10.0.0.1', cfg: { guestHostName: 'x.y', cpuLimitMhz: -1, memLimitMB: null, cbt: null } },
  { name: 'd', dev: { cdroms: [{ connected: true, iso: false }, { connected: false }], floppies: [{}], disks: [{ mode: 'independent_nonpersistent' }, { mode: 'independent_persistent', sharing: 'sharingMultiWriter' }, { rdm: true, rdmMode: 'physicalMode' }] } },
  { name: 'e' },
  { name: 'f', cfg: {}, dev: {} },
  // v2.899 nic-legacy — 구형 어댑터 · VMXNET 3 · SR-IOV · 이전 판(nics 키 없음)
  { name: 'g', dev: { nics: [{ adapter: 'E1000E' }, { adapter: 'VMXNET 3' }, { adapter: 'E1000' }, { adapter: 'SR-IOV' }, null] } },
  { name: 'h', dev: { nics: [{ adapter: 'VMXNET 3' }] } },
];

describe('vmCfgText', () => {
  it('코드 집합 — 서버 판정 코드 = 웹 코드 = 문구 키(1:1)', () => {
    expect(Object.keys(web.VM_CFG_CODES).sort()).toEqual(Object.keys(srv.VM_CFG_CODES).sort());
    expect(Object.keys(web.VM_CFG_TEXT).sort()).toEqual(Object.keys(srv.VM_CFG_CODES).sort());
    expect(web.VM_CFG_CODES).toEqual(srv.VM_CFG_CODES);
  });
  it('판정 — 서버와 같은 입력에서 같은 결과', () => {
    for (const vm of VMS) expect(web.vmCfgFindings(vm)).toEqual(srv.vmCfgFindings(vm));
  });
  it('v2.899 nic-legacy — 구형 어댑터만 · 유형 목록은 서버와 같다 · 어댑터를 읽지 않은 VM 은 판정하지 않는다', () => {
    expect([...web.LEGACY_NIC].sort()).toEqual([...srv.LEGACY_NIC].sort());
    const g = web.vmCfgFindings(VMS.find((v) => v.name === 'g')).find((f) => f.code === 'nic-legacy');
    expect(g.facts).toEqual({ count: 2, adapters: ['E1000E', 'E1000'] });
    expect(web.vmCfgFindings(VMS.find((v) => v.name === 'h')).some((f) => f.code === 'nic-legacy')).toBe(false);
    expect(web.vmCfgFindings({ name: 'old', dev: { disks: [] } }).some((f) => f.code === 'nic-legacy')).toBe(false);
  });
  it('문구에 백틱·별표 없음', () => {
    for (const t of Object.values(web.VM_CFG_TEXT)) {
      expect(t.title + t.fix).not.toMatch(/[`*]/);
    }
  });
  it('vmCfgRows — 미수집이면 none + 이유, 값이 없으면 — (0·꺼짐으로 채우지 않는다)', () => {
    expect(web.vmCfgRows({ name: 'x' }).state).toBe('none');
    expect(web.vmCfgRows({ name: 'x' }).note).toMatch(/아직 읽지 않았습니다/);
    const r = web.vmCfgRows({ name: 'x', cfg: { at: 1, cpuLimitMhz: -1, cpuReservationMhz: null } }, 61_000);
    expect(r.state).toBe('partial');
    const row = r.rows.find((x) => x.label === 'CPU 예약 / 제한');
    expect(row.value).toBe('— / 무제한');
    expect(r.rows.find((x) => x.label === 'CBT').value).toBe('—');
    expect(r.note).toMatch(/장치 미수집/);
  });
});
