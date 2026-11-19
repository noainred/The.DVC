// v2.920 — 호스트 네트워크 카드 CVP 업링크 문구: 방향(In=송신) · 값 없음 — · 매칭 없음은 이유를 말한다.
import { describe, it, expect } from 'vitest';
import { basisOf, l2Text, ageText, bpsText, txRxText, errText, dropText, daySumText, speedText, uplinksByNic, hostLevelUplinks, nicUplinkText, uplinkSummary, uplinkTotals } from './hostNetText.js';

const ups = [
  { hostname: 'leaf1', port: 'Ethernet12', nic: 'vmnic0', basis: 'desc-nic', inBps: 1e9, outBps: 5e8, inErr: 3, outErr: 0, inDrop: 0, outDrop: 7, day: { inErr: 10, outErr: 0, inDrop: 2, outDrop: 40, samples: 288, dropN: 280, errN: 288 } },
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
  it('v2.924 L2 수집 현황 — 수집 전 · 실패 · 대수', () => {
    expect(l2Text(null)).toBe(''); expect(l2Text({ error: true })).toContain('조회하지 못했습니다');
    expect(l2Text({ fdbDevices: 0, lldpDevices: 0 })).toContain('수집 전'); expect(l2Text({ fdbDevices: 3, lldpDevices: 2 })).toContain('LLDP 를 읽은 스위치 2대 · MAC 테이블을 읽은 스위치 3대');
    expect(basisOf('mac-vm').label).toBe('높음'); expect(basisOf('lldp').label).toBe('확정');
    expect(l2Text({ fdbDevices: 3, lldpDevices: 2, lastAt: 1_000_000, lldpFailing: 1, fdbFailing: 0 }, 1_000_000 + 25 * 60_000)).toContain('최근 25분 전 · 마지막 읽기 실패 1건');
    expect(ageText(null)).toBe(''); expect(ageText(0, 1)).toBe(''); expect(ageText(1, 1 + 3 * 3_600_000)).toBe('3시간 전'); expect(ageText(1, 1 + 3 * 86_400_000)).toBe('3일 전');
    expect(uplinkSummary({ servers: 1, uplinks: [{ nic: 'vmnic0', basis: 'lldp' }] }, []).text).toBe('CVP 매칭 포트 1(인벤토리에 NIC 목록 없음)');
  });
  it('요약 — 없음의 이유', () => {
    expect(uplinkSummary({ cvpUnavailable: true }).text).toBe('CVP DB 없음');
    expect(uplinkSummary({ servers: 0, corpLimited: true }).note).toContain('이 호스트 법인');
    // v2.932(A1-03 · A1-07): 범위 + 법인 미지정은 이유를 말하고, 단서 상한은 비고에 밝힌다
    expect(uplinkSummary({ servers: 0, corpLimited: true, corpMissing: true }).note).toContain('법인이 지정되지 않아 CVP 매칭');
    expect(uplinkSummary({ servers: 1, uplinks: [{ nic: 'vmnic0', basis: 'lldp' }], termsTruncated: true }, [{ device: 'vmnic0' }]).note).toContain('일부 NIC 의 MAC');
    expect(uplinkSummary({ servers: 2, uplinks: [], terms: { short: 'esx01' } }, [1, 2]).text).toBe('CVP 매칭 0 / 2 NIC');
    expect(uplinkSummary({ servers: 2, uplinks: [], terms: { short: 'esx01' } }, [1, 2]).note).toContain('esx01');
    const s = uplinkSummary({ servers: 2, uplinks: ups, conflicts: [{ nic: 'vmnic0', ports: 3 }] }, [1, 2, 3, 4]);
    expect(s.text).toBe('CVP 매칭 2 / 4 NIC · 호스트 수준 1'); expect(s.note).toContain('충돌 1');
  });
  it('합계 — 없는 값은 더하지 않고 센다', () => {
    expect(uplinkTotals(ups)).toEqual({ tx: 1e9 + 2e6, rx: 5e8 + 1e6, unmeasured: 1, err: 3, drop: 7, dropDay: 42, errDay: 10 });
    expect(uplinkTotals([])).toEqual({ tx: null, rx: null, unmeasured: 0, err: null, drop: null, dropDay: null, errDay: null });
  });
  it('v2.923 드롭 — 직전 주기 · 24시간 부분 합(표본 수) · 없으면 —', () => {
    expect(dropText(ups[0])).toBe('0 / 7'); expect(dropText(ups[1])).toBe('—'); expect(dropText({ inDrop: '', outDrop: null })).toBe('—');
    expect(daySumText(ups[0].day)).toBe('2 / 40 (표본 280/288)'); expect(daySumText(ups[0].day, 'err')).toBe('10 / 0');
    expect(daySumText(null)).toBe('—'); expect(daySumText({ inDrop: null, outDrop: null, samples: 3, dropN: 0 })).toBe('—');
  });
});
