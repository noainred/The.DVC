/**
 * v2.781(점검 G1 D-B3) — vCenter 로그 '지금 수집' 결과 문구가 서버가 같은 응답에 싣는 stalled(끝까지 못 읽었는데 새로 저장 0)·
 *   lagging(1일 넘게 뒤처짐) 배열을 무시하고 '수집 완료: 0건 적재' 라고만 말해, 같은 화면의 표('정체')와 엇갈렸다.
 *   이제 두 수를 덧붙인다. 제목('수집 완료')은 바꾸지 않는다 — 문제(거부·정지·실패)만 '수집 끝(일부 실패)'.
 * 레이아웃·실제 DOM 은 보지 못한다(Chromium 몫 — 정직 기록).
 */
import { describe, it, expect } from 'vitest';
import { vcLogCollectText } from './VcenterLogs.jsx';

const fmt = () => 'T';

describe('D-B3 vcLogCollectText — 정체·지연 vCenter 수', () => {
  it('stalled·lagging 이 있으면 각각의 수를 말하고 제목은 수집 완료 그대로', () => {
    const t = vcLogCollectText({ ok: true, at: 1, collected: 0, stalled: [{ vcenterId: 'oc2', read: 2000, stored: 0 }], lagging: [{ vcenterId: 'oc2', lagMs: 13 * 86_400_000 }, { vcenterId: 'pl', lagMs: 2 * 86_400_000 }] }, fmt);
    expect(t).toMatch(/^수집 완료: 0건 적재 · /);
    expect(t).toMatch(/새로 저장 0 — 1곳/);
    expect(t).toMatch(/‘정체’/);
    expect(t).toMatch(/1일 넘게 뒤처진 vCenter 2곳/);
    expect(t).not.toMatch(/`/);   // BoldText 규칙 — 문구에 백틱 금지
  });
  it('둘 다 없거나 배열이 아니면 예전 문구 그대로', () => {
    expect(vcLogCollectText({ ok: true, at: 1, collected: 5 }, fmt)).toBe('수집 완료: 5건 적재');
    expect(vcLogCollectText({ ok: true, at: 1, collected: 5, stalled: [], lagging: [] }, fmt)).toBe('수집 완료: 5건 적재');
    expect(vcLogCollectText({ ok: true, at: 1, collected: 5, stalled: null, lagging: 'x' }, fmt)).toBe('수집 완료: 5건 적재');
  });
  it('실패와 함께면 제목은 일부 실패 · 정체·지연 수도 함께', () => {
    const t = vcLogCollectText({ ok: true, at: 1, collected: 3, failed: [{ vcenterId: 'us', error: 'timeout' }], lagging: [{ vcenterId: 'us', lagMs: 3 * 86_400_000 }] }, fmt);
    expect(t).toMatch(/^수집 끝\(일부 실패\): 3건 적재 · 수집 실패 1곳\(us: timeout\) · 1일 넘게 뒤처진 vCenter 1곳/);
  });
  it('busy·running·skipped 는 정체·지연이 있어도 예전 분기가 먼저', () => {
    expect(vcLogCollectText({ ok: true, busy: true, stalled: [{ vcenterId: 'a' }] }, fmt)).toMatch(/^이전 수집이 아직 진행 중입니다/);
    expect(vcLogCollectText({ ok: true, skipped: true, lagging: [{ vcenterId: 'a' }] }, fmt)).toMatch(/^로그 수집이 꺼져 있어/);
  });
});
