// v2.915 — 호스트 네트워크 카드 CVP 업링크 문구: 방향(In=송신) · 값 없음 — · 매칭 없음은 이유를 말한다.
import { describe, it, expect } from 'vitest';
import { basisOf, bpsText, txRxText, errText, speedText, uplinksByNic, hostLevelUplinks, nicUplinkText, uplinkSummary, uplinkTotals } from './hostNetText.js';

const ups = [
  { hostname: 'leaf1', port: 'Ethernet12', nic: 'vmnic0', basis: 'desc-nic', inBps: 1e9, outBps: 5e8, inErr: 3, outErr: 0 },
  { hostname: 'leaf2', port: 'Ethernet12', nic: 'vmnic1', basis: 'desc-mac', inBps: null, outBps: null, inErr: null, outErr: null },
  { hostname: 'leaf2', port: 'Ethernet20', nic: null, basis: 'desc-name', inBps: 2e6, outBps: 1e6 },
];
describe('업링크 문구', () => {
  it('bps · 송신/수신 · 에러 · 속도', () => {
    expect(bpsText(1e9)).toBe('1.00 Gbps'); expect(bpsText(null)).toBe('—'); expect(bpsText('')).toBe('—');
    expect(txRxText(ups[0])).toBe('1.00 Gbps / 500.0 Mbps'); expect(txRxText(ups[1])).toBe('—');
    expect(errText(ups[0])).toBe('3 / 0'); expect(errText(ups[1])).toBe('—');
    expect(speedText(25e9)).toBe('25 G'); expect(speedText(1e8)).toBe('100 M'); expect(speedText(null)).toBe('—');
    expect(basisOf('desc-name').label).toBe('보통'); expect(basisOf('x').label).toBe('미매칭');
  });
  it('NIC 별 · 호스트 수준', () => {
    expect([...uplinksByNic(ups).keys()]).toEqual(['vmnic0', 'vmnic1']);
    expect(hostLevelUplinks(ups).map((u) => u.port)).toEqual(['Ethernet20']);
    expect(nicUplinkText(uplinksByNic(ups).get('vmnic0'))).toBe('leaf1 Ethernet12'); expect(nicUplinkText([])).toBe('');
  });
  it('요약 — 없음의 이유', () => {
    expect(uplinkSummary({ cvpUnavailable: true }).text).toBe('CVP DB 없음');
    expect(uplinkSummary({ servers: 0, corpLimited: true }).note).toContain('이 법인');
    expect(uplinkSummary({ servers: 2, uplinks: [], terms: { short: 'esx01' } }, [1, 2]).text).toBe('CVP 매칭 0 / 2 NIC');
    expect(uplinkSummary({ servers: 2, uplinks: [], terms: { short: 'esx01' } }, [1, 2]).note).toContain('esx01');
    const s = uplinkSummary({ servers: 2, uplinks: ups, conflicts: [{ nic: 'vmnic0', ports: 3 }] }, [1, 2, 3, 4]);
    expect(s.text).toBe('CVP 매칭 2 / 4 NIC · 호스트 수준 1'); expect(s.note).toContain('충돌 1');
  });
  it('합계 — 없는 값은 더하지 않고 센다', () => {
    expect(uplinkTotals(ups)).toEqual({ tx: 1e9 + 2e6, rx: 5e8 + 1e6, unmeasured: 1, err: 3 });
    expect(uplinkTotals([])).toEqual({ tx: null, rx: null, unmeasured: 0, err: null });
  });
});
