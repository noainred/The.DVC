/**
 * v2.731 점검 1회차 G2b — A4-02 화면 쪽: 호스트 접근 설정이 '포탈 포트' 를 서버가 준 **실제로 듣는 포트 전부**로 다룬다.
 *   TLS_PORT ≠ PORT 로 HTTPS 만 열면 PORT 는 듣지 않는다 — 예전 화면은 data.portalPort 하나(=config.port)로 허용목록 포트를 만들어
 *   실제 포트를 관리 대상에서 빠뜨렸다(서버 정규화는 이제 그 포트를 넣지만, 화면이 보내는 목록·문구도 같은 값이어야 한다).
 */
import { describe, it, expect } from 'vitest';
import { portalPortsOf, webPortsOf, webPortsLabel } from './HostAccessSettings.jsx';

describe('A4-02 호스트 접근 — 포탈 포트 목록', () => {
  it('서버가 portalPorts 를 주면 그것 전부(중복 없이, 문자열)', () => {
    expect(portalPortsOf({ portalPort: 4443, portalPorts: [4443, 4000] })).toEqual(['4443', '4000']);
    expect(portalPortsOf({ portalPort: 4443, portalPorts: [4443, 4443] })).toEqual(['4443']);
  });
  it('구버전 서버(portalPorts 없음)는 portalPort 하나 · 값이 없으면 빈 목록(지어내지 않는다)', () => {
    expect(portalPortsOf({ portalPort: 4000 })).toEqual(['4000']);
    expect(portalPortsOf({})).toEqual([]);
    expect(portalPortsOf({ portalPort: null, portalPorts: [] })).toEqual([]);
  });
  it('보내는 web.ports = 포탈 포트 전부 + 고른 80/443 — 실제 TLS 포트가 빠지지 않는다', () => {
    const data = { portalPort: 4443, portalPorts: [4443] };
    expect(webPortsOf(data, { web80: false, web443: false })).toEqual(['4443']);
    expect(webPortsOf(data, { web80: true, web443: true })).toEqual(['4443', '80', '443']);
    expect(webPortsOf({ portalPort: 443, portalPorts: [443] }, { web443: true })).toEqual(['443'], 'TLS 포트가 443 이면 한 번만');
  });
  it('머리 문구가 실제 포트를 말한다', () => {
    expect(webPortsLabel({ portalPorts: [4443, 4000] }, { web80: true })).toBe('포탈 포트 4443·4000 · 80');
    expect(webPortsLabel({ portalPort: 4000 }, {})).toBe('포탈 포트 4000');
    expect(webPortsLabel({}, {})).toBe('포탈 포트 —');
  });
});
