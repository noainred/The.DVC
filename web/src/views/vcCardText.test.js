import { describe, it, expect } from 'vitest';
import { vcCardState, storageBarInfo, vcQuickDot } from './vcCardText.js';

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

/* v2.590(감사 F1) — 인증 실패로 멈춘 vCenter 는 '연결할 수 없습니다' 가 아니라 '멈췄다' 를 말한다. */
describe('vcCardState — 인증 실패 정지(v2.590)', () => {
  const NOW = 1_800_000_000_000;
  const stop = { since: NOW - 3_600_000, at: NOW - 60_000, attempts: 2, reason: 'InvalidLogin' };
  it('정지 문구 + 수동 확인 경로를 말하고 강조 표시를 한다', () => {
    const r = vcCardState({ status: 'unreachable', authStopped: stop }, NOW);
    expect(r.authStopped).toBe(true);
    expect(r.tone).toBe('bad');
    expect(r.text).toMatch(/주기 수집을 멈췄습니다/);
    expect(r.text).toMatch(/연결 테스트/);
    expect(r.text).not.toMatch(/연결할 수 없습니다/);
  });
  it('이월된 마지막 값이 있으면 지표를 보여 주되 낡은 값임을 말한다', () => {
    const r = vcCardState({ status: 'unreachable', stale: true, authStopped: stop, metrics: { hosts: 3, vms: 20 } }, NOW);
    expect(r.showMetrics).toBe(true);
    expect(r.text).toMatch(/정지 전 마지막으로 수집한/);
  });
  it('connected 면 정지 기록이 남아 있어도 정상 카드다(방금 로그인됐다)', () => {
    expect(vcCardState({ status: 'connected', authStopped: stop }, NOW).tone).toBe('ok');
  });
});

describe('v2.600 LO2600-01 storageBarInfo', () => {
  it('사용률 null 은 0 이 아니라 null(막대 —) 이고 이유를 말한다', () => {
    const r = storageBarInfo({ storageUsagePct: null, storageUsedTB: 0, storageTotalTB: 0, datastoresUsageUnknown: 3 });
    expect(r.pct).toBe(null);
    expect(r.title).toMatch(/0% 가 아닙니다/);
  });
  it('숫자는 그대로', () => {
    const r = storageBarInfo({ storageUsagePct: 42, storageUsedTB: 1, storageTotalTB: 2 });
    expect(r.pct).toBe(42);
    expect(r.detail).toBe('1/2 TB');
    expect(r.title).toBe(undefined);
  });
  it('VCenters.jsx 는 이 헬퍼로 막대를 그린다(|| 0 금지)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./VCenters.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/storageUsagePct \|\| 0/);
    expect(src).toMatch(/storageBarInfo\(m\)/);
  });
});

describe('v2.869 감사 A4-04 — 바로가기 점은 경보를 모르면 초록이 아니다', () => {
  it('REST 폴백(alarmsUnknown) · 경보 0 → 흐림 · 경보가 있으면 호박 · 아는 0 은 초록', () => {
    const base = { status: 'connected', lastSuccess: Date.now(), metrics: {} };
    expect(vcQuickDot({ ...base, alarmsUnknown: true }).dot).not.toBe('var(--green)');
    expect(vcQuickDot({ ...base, collectSource: 'rest' }).dot).toBe('var(--text-faint)');
    expect(vcQuickDot({ ...base, alarmsUnknown: true, metrics: { alarmsWarning: 1 } }).dot).toBe('var(--amber)');
    expect(vcQuickDot(base).dot).toBe('var(--green)');   // 전제: 경보를 아는 정상 vCenter 는 초록
  });
});
