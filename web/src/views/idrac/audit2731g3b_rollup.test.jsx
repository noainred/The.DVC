/**
 * v2.731 점검 1회차 G3b — A2-02: iDRAC 상세 하드웨어 탭 상단 롤업 배지(스토리지·PSU).
 * 예전 배지는 저장 롤업 글자를 정규식으로 칠해, 상태를 못 읽은 부품이 초록 'OK' · Critical 이 호박색 'Warning' 으로 보였다
 * (같은 탭 부품 표와 반대). 이제 서버 idrac/invView.js 가 원소 partState 로 만든 healthParts 를 읽는다 — 확인 불가는 회색.
 * renderToStaticMarkup 이라 레이아웃은 보지 않는다(Chromium 몫).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HealthRollupBadges } from './IdracDetailModal.jsx';

const h = React.createElement;
const render = (inv) => renderToStaticMarkup(h(HealthRollupBadges, { inv }));
const C = (o) => ({ ok: 0, warn: 0, fault: 0, unknown: 0, absent: 0, ...o });

describe('HealthRollupBadges (A2-02)', () => {
  it('못 읽은 PSU 만 있으면 초록 OK 가 아니라 회색 확인 불가', () => {
    const html = render({ health: { overall: 'OK', psu: '' }, healthParts: { psu: { state: 'unknown', counts: C({ unknown: 2 }) } } });
    expect(html).toContain('PSU: 확인 불가');
    expect(html).toMatch(/class="badge gray"[^>]*>PSU: 확인 불가/);
    expect(html).not.toContain('PSU: OK');
    expect(html).toContain('정상이라 말하지 않습니다');
  });

  it('Critical 은 빨간 Critical(Warning 으로 접지 않는다) · 못 읽은 개수는 title 이 밝힌다', () => {
    const html = render({ health: { psu: 'Critical', storage: 'Warning' }, healthParts: {
      psu: { state: 'fault', counts: C({ ok: 1, fault: 1 }) },
      storage: { state: 'warn', counts: C({ warn: 1, unknown: 1 }) },
    } });
    expect(html).toMatch(/class="badge red"[^>]*>PSU: Critical/);
    expect(html).toMatch(/class="badge amber"[^>]*>스토리지: Warning/);
    expect(html).toContain('PSU 2개 — 이상 1 · 정상 1');
    expect(html).toContain('상태를 읽지 못한 1개는 정상이라는 뜻이 아닙니다');
  });

  it('빈 슬롯뿐(state 빈 값)이면 배지를 만들지 않는다 · 전체/CPU/메모리는 원문 그대로', () => {
    const html = render({ health: { overall: 'Warning', processor: 'OK', memory: '' }, healthParts: { psu: { state: '', counts: C({ absent: 2 }) } } });
    expect(html).not.toContain('PSU:');
    expect(html).toMatch(/class="badge amber"[^>]*>전체: Warning/);
    expect(html).toMatch(/class="badge green"[^>]*>CPU: OK/);
    expect(html).not.toContain('메모리:');
    expect(html).not.toMatch(/undefined|null|NaN|\[object/);
  });

  it('부품 배열이 없어 판정이 실리지 않은 응답은 저장 글자 그대로', () => {
    const html = render({ health: { psu: 'OK' } });
    expect(html).toMatch(/class="badge green"[^>]*>PSU: OK/);
    expect(render(null)).toBe('');
  });
});
