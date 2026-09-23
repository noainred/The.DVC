import { describe, it, expect } from 'vitest';
import { vcCardState } from './vcCardText.js';

describe('vcCardState (v2.583 #39)', () => {
  it('pending 을 연결 실패라 말하지 않는다', () => {
    const r = vcCardState({ status: 'pending' });
    expect(r.text).toMatch(/첫 수집 중/);
    expect(r.text).not.toMatch(/연결할 수 없/);
    expect(vcCardState({ status: 'pending', note: '사이트 에이전트 수집 대기' }).text).toMatch(/사이트 에이전트 수집 대기/);
  });
  it('maintenance 는 수집분이 있으면 지표를 보여 준다', () => {
    expect(vcCardState({ status: 'maintenance', metrics: { hosts: 3, vms: 10 } }).showMetrics).toBe(true);
    expect(vcCardState({ status: 'maintenance', metrics: {} }).showMetrics).toBe(false);
  });
  it('disabled·unreachable 구분', () => {
    expect(vcCardState({ status: 'disabled' }).text).toMatch(/꺼져/);
    const u = vcCardState({ status: 'unreachable' });
    expect(u.text).toMatch(/연결할 수 없/);
    expect(u.showError).toBe(true);
  });
  it('connected', () => { expect(vcCardState({ status: 'connected' }).showMetrics).toBe(true); });
});
