/**
 * sanPortsScopeText.test.js — 포트 전송 범위 안내 회귀(v2.517).
 *
 * 고정하는 것: **'전체를 받았다' 와 '문제 포트만 왔다' 를 뭉개지 않는다**, 그리고 문제 포트만 온
 * 세 원인(구버전 엣지 / 현장 되돌림 / 크기 가드)을 **다르게 안내한다** — 조치가 다르기 때문이다.
 */
import { describe, it, expect } from 'vitest';
import { portsScopeNote } from './sanPortsScopeText.js';

describe('portsScopeNote', () => {
  it('중앙 직접 수집은 배너 없음(축약 경로를 타지 않는다)', () => {
    expect(portsScopeNote({ agent: '', ports: { portsOmitted: 0, portsScope: 'full' } })).toBeNull();
    expect(portsScopeNote({ agent: '', ports: { portsOmitted: 5 } })).toBeNull();
  });

  it('전체를 받았으면 배너 없음', () => {
    expect(portsScopeNote({ agent: 'HG', ports: { portsScope: 'full', portsOmitted: 0 } })).toBeNull();
  });

  it('구버전 엣지 — 업그레이드를 안내하고, 설정 탓이라 단정하지 않는다', () => {
    const n = portsScopeNote({ agent: 'HG', ports: { portsOmitted: 125 } });
    expect(n.tone).toBe('warn');
    expect(n.text).toMatch(/125개/);
    expect(n.action).toMatch(/v2\.517 미만/);
    expect(n.action).not.toMatch(/SANSW_PUSH_PORTS/);
  });

  it('현장 되돌림(problem) — 되돌리는 방법을 안내한다', () => {
    const n = portsScopeNote({ agent: 'AZ', ports: { portsScope: 'problem', portsOmitted: 60 } });
    expect(n.action).toMatch(/SANSW_PUSH_PORTS/);
    expect(n.action).toMatch(/AZ/);
  });

  it('크기 가드 — 서버가 준 사유를 그대로 보여준다(조용한 축약 금지)', () => {
    const reason = '전체 포트가 1회 전송 상한(900KB)을 넘어(1180KB) 문제 포트만 보냈습니다';
    const n = portsScopeNote({ agent: 'PL', ports: { portsScope: 'problem', portsOmitted: 700, portsScopeReason: reason } });
    expect(n.text).toContain(reason);
    expect(n.action).toMatch(/SANSW_PUSH_DEVICE_MAX_BYTES/);
  });

  it('범위도 모르고 뺀 것도 없으면 아무 말도 하지 않는다(지어내지 않는다)', () => {
    expect(portsScopeNote({ agent: 'HG', ports: { portsOmitted: 0 } })).toBeNull();
    expect(portsScopeNote({ agent: 'HG', ports: {} })).toBeNull();
    expect(portsScopeNote({})).toBeNull();
  });
});
