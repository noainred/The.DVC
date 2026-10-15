// v2.741 점검 그룹 GF — CVP Overview 법인 트래픽(감사 LEFT-04).
//  서버(cvp/overview.js)는 v2.720 B1-06 부터 방향별 결측을 inUnread·outUnread 로 세는데 화면(trafficRows)은 그 필드를 읽지 않아,
//  수신을 한 대도 못 읽은 법인이 '수신 0 bps · 합 8.0 Gbps · 측정 포트 18개' 로 완전한 측정처럼 보였다(트래픽 없음이라는 거짓).
//  이제 전부 못 읽은 방향은 '—', 일부만 못 읽었으면 부분 합임을 note·partial 로 말한다. 구버전 서버(그 방향 합 0)도 같게 보인다.
import { describe, it, expect } from 'vitest';
import { trafficRows, trafficTotalsText } from './cvpOverviewText.js';

describe('trafficRows — 방향별 결측(LEFT-04)', () => {
  it('측정 장비 전부에서 수신을 못 읽었으면 수신은 — 이고 부분 합으로 표시한다(구버전 서버의 0 도 같게)', () => {
    for (const inBps of [0, null]) {
      const [r] = trafficRows([{ corpId: 'dc1', corpName: 'Seoul', traffic: { inBps, outBps: 8e9, portsMeasured: 18, portsUnmeasured: 0, devicesMeasured: 2, devicesUnmeasured: 0, inUnread: 2 } }]);
      expect(r.inText).toBe('—');
      expect(r.inBps).toBeNull();
      expect(r.outText).toBe('8.0 Gbps');
      expect(r.partial).toBe(true);
      expect(r.note).toContain('수신');
      expect(r.note).toContain('2대');
    }
  });
  it('일부 장비만 송신을 못 읽었으면 값은 두되 부분 합이라고 말한다', () => {
    const [r] = trafficRows([{ corpId: 'dc2', corpName: 'Busan', traffic: { inBps: 3e9, outBps: 7e8, portsMeasured: 8, portsUnmeasured: 0, devicesMeasured: 2, inUnread: 0, outUnread: 1 } }]);
    expect(r.inText).toBe('3.0 Gbps');
    expect(r.outText).toBe('700 Mbps');
    expect(r.partial).toBe(true);
    expect(r.note).toContain('송신');
    expect(r.note).toContain('1대');
  });
  it('두 방향을 모두 못 읽었으면 합도 — (0 bps 가 아니다)', () => {
    const [r] = trafficRows([{ corpId: 'x', corpName: 'X', traffic: { inBps: 0, outBps: 0, portsMeasured: 4, devicesMeasured: 1, inUnread: 1, outUnread: 1 } }]);
    expect(r.sum).toBeNull();
    expect(r.sumText).toBe('—');
  });
  it('온전한 측정은 예전 그대로(partial 아님)', () => {
    const [r] = trafficRows([{ corpId: 'ok', corpName: 'OK', traffic: { inBps: 1e9, outBps: 1e9, portsMeasured: 4, portsUnmeasured: 0, devicesMeasured: 1 } }]);
    expect(r.partial).toBe(false);
    expect(r.sumText).toBe('2.0 Gbps');
    expect(r.note).toBe('측정 포트 4개');
  });
});

describe('trafficTotalsText — 전체 수신·송신 KPI(LEFT-04)', () => {
  it('측정 포트가 없으면 —', () => {
    const k = trafficTotalsText({ portsMeasured: 0, inBps: 0, outBps: 0 });
    expect(k.inText).toBe('—'); expect(k.outText).toBe('—');
  });
  it('전부 못 읽은 방향은 —, 일부만 못 읽었으면 그 사실을 말한다', () => {
    const k = trafficTotalsText({ portsMeasured: 20, devicesMeasured: 3, inBps: 0, outBps: 5e9, inUnread: 3, outUnread: 1 });
    expect(k.inText).toBe('—');
    expect(k.outText).toBe('5.0 Gbps');
    expect(k.inNote).toContain('3대');
    expect(k.outNote).toContain('1대');
    const ok = trafficTotalsText({ portsMeasured: 20, devicesMeasured: 3, inBps: 1e9, outBps: 1e9 });
    expect(ok.inNote).toBe(''); expect(ok.outNote).toBe('');
  });
});
