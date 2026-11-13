// v2.935(C-③) — VM ‘네트워크 위치(CVP)’ 문구 · 호스트 업링크 블록의 EndpointLocation 문구.
import { describe, it, expect } from 'vitest';
import { locRows, locSummary, verdictOf } from './vmCvpLocText.js';
import { epStatusText, epLocateText, epDisagreeText, basisOf } from '../hostNetText.js';

describe('VM 네트워크 위치(CVP)', () => {
  const d = { hostPortsKnown: true, servers: 1, rows: [
    { label: 'Network adapter 1', mac: '005056990001', verdict: 'match', locations: [{ hostname: 'leafL', port: 'Ethernet1', vlan: 100, learnedAt: '2026-11-07T01:02:00Z' }] },
    { label: 'Network adapter 2', mac: '005056990002', verdict: 'mismatch', locations: [{ hostname: 'leafL', port: 'Ethernet2', vlan: null }] },
    { label: 'Network adapter 3', mac: '005056990003', verdict: 'none', locations: [] },
    { label: 'Network adapter 4', mac: '005056990004', verdict: 'not-asked', locations: [] }] };
  it('행 — 콜론 MAC · 위치 · VLAN 없음은 —', () => {
    const r = locRows(d);
    expect(r[0]).toMatchObject({ mac: '00:50:56:99:00:01', where: 'leafL Ethernet1', vlan: '100' });
    expect(r[1].vlan).toBe('—'); expect(r[2].where).toBe('—');
    expect(r.map((x) => x.v.label)).toEqual(['일치', '불일치', '위치 없음', '아직 안 물음']);
    expect(verdictOf('weird').label).toBe('판정 보류');
  });
  it('요약 — 개수 · 판정 보류 사유 · 대기', () => {
    expect(locSummary(d)).toBe('vNIC 4 · 일치 1 · 불일치 1 · 그 밖 2 · 부품 주기에 차례로 · 버튼으로 지금');
    expect(locSummary({ ...d, partsEveryMs: 1_800_000 })).toContain('부품 주기 30분에 차례로');
    expect(locSummary({ ...d, scan: false })).toContain('주기 조회는 꺼져 있습니다');
    expect(locSummary({ ...d, unavailable: true })).toContain('위치 DB 를 읽지 못했습니다');   // 반증 L-7 — '아직 안 물음' 으로 말하지 않는다
    expect(locRows({ rows: [{ mac: '005056000001', verdict: 'unknown', note: 'LAG(Port-Channel) — 멤버 포트를 몰라 판정을 보류합니다', locations: [] }] })[0].note).toContain('LAG');
    expect(locSummary({ ...d, hostPortsKnown: false, pending: true })).toContain('호스트 업링크 포트를 몰라 판정 보류');
    expect(locSummary({ rows: [], servers: 0 })).toContain('CVP 가 없습니다');
    expect(locSummary({ rows: [], servers: 2 })).toContain('vNIC MAC 을 아직 읽지 않았습니다');
  });
});

describe('호스트 업링크 — EndpointLocation 문구', () => {
  it('현황 — 물어본 적 없으면 그 사실만 · 미지원 · 대기', () => {
    expect(epStatusText({ macs: 0 })).toContain('아직 물어보지 않았습니다');
    expect(epStatusText({ macs: 0 })).not.toContain('30분');   // 반증 L-9: 주기 숫자를 박지 않는다(API 값)
    expect(epStatusText({ macs: 0, partsEveryMs: 900_000 })).toContain('15분');
    expect(epStatusText({ unavailable: true, macs: 0 })).toContain('읽지 못했습니다');
    const t = epStatusText({ macs: 12, lastAt: 1000, unsupported: 1, pending: true }, 1000 + 5 * 60_000);
    expect(t).toBe('CVP 위치 — 물어본 MAC 12개 · 최근 5분 전 · EndpointLocation 미지원 CVP 1대(2021.1 이상 필요) · 엣지 조회 요청 대기 중');
    expect(epStatusText({ error: true })).toContain('읽지 못했습니다');
    expect(epStatusText(null)).toBe('');
  });
  it('지금 조회 결과 · 엣지 요청 · CVP 없음', () => {
    expect(epLocateText({ direct: [{ name: 'CVP-L', ok: true, found: 3, none: 1, errors: 0 }], queued: [{ name: 'CVP-D', agent: 'edge-a' }] }))
      .toBe('CVP-L: 위치 있음 3 · 없음 1 · CVP-D: 담당 엣지 edge-a 에 요청함(다음 설정 pull 때 묻고 결과를 올립니다)');
    expect(epLocateText({ direct: [{ name: 'X', ok: false, reason: 'HTTP 401' }], queued: [] })).toBe('X: 실패(HTTP 401)');
    expect(epLocateText({ direct: [], queued: [] })).toContain('CVP 가 없습니다');
    expect(epLocateText({ note: '인벤토리에 MAC 없음' })).toBe('인벤토리에 MAC 없음');
  });
  it('LLDP 와 다른 NIC · 근거 라벨', () => {
    expect(epDisagreeText([{ nic: 'vmnic1', lldp: { hostname: 'leaf1', port: 'Et3' }, endpoint: { hostname: 'leaf2', port: 'Et9' } }])).toEqual(['vmnic1: LLDP 는 leaf1 Et3 · CVP 위치는 leaf2 Et9']);
    expect(basisOf('endpoint').label).toBe('확정');
    for (const s of [epStatusText({ macs: 1, lastAt: 1 }), epLocateText({ direct: [], queued: [] })]) expect(s).not.toMatch(/`/);
  });
});

describe('v2.940 엣지 시계 원본(C-③ L-10)', () => {
  it('물어본 시각이 수신 시각으로 잘렸으면 표지', () => {
    expect(locRows({ rows: [{ mac: '005056000001', verdict: 'match', edgeClockAheadMs: 5 * 60_000, locations: [] }] })[0].clock.label).toBe('엣지 시계 +5분');
    expect(locRows({ rows: [{ mac: '005056000001', verdict: 'match', locations: [] }] })[0].clock).toBe(null);
  });
});
