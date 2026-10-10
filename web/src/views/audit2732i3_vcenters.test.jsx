/**
 * views/audit2732i3_vcenters.test.jsx — 점검 2회차(v2.732) 그룹 i3: Platform(vCenter 목록) 카드 머리의 상태 배지와 상단 KPI 가
 * 낡은 위임 vCenter(서버 B2-01 — status 'connected' 그대로 + stale:true)를 초록 'Connected' 로만 말하지 않는가.
 * 판정은 vcCardState().stale 하나(그룹 a). 배지는 렌더(renderToStaticMarkup)로, KPI 메타는 실제 함수 호출로 본다.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VcStateBadge, vcCountMeta } from './VCenters.jsx';

const h = React.createElement;
const NOW = Date.UTC(2026, 9, 10, 1, 30);
const DAY = 86_400_000;
const FRESH = { id: 'vc-a', name: 'vc-a', status: 'connected', metrics: { hosts: 1, vms: 1 } };
const STALE = { id: 'vc-b', name: 'vc-b', status: 'connected', stale: true, collectSource: 'site', receivedAt: NOW - 3 * DAY, metrics: { hosts: 1, vms: 1 } };
const DOWN = { id: 'vc-c', name: 'vc-c', status: 'unreachable', metrics: {} };

describe('vCenter 카드 상태 배지', () => {
  it('낡은 위임 vCenter — 초록 Connected 가 아니라 호박색 낡은 값 + 마지막 수신 시각(title)', () => {
    const html = renderToStaticMarkup(h(VcStateBadge, { s: STALE, now: NOW }));
    expect(html).toContain('badge amber');
    expect(html).toContain('낡은 값');
    expect(html).not.toContain('badge green');
    expect(html).toContain('3일 전');
    expect(html).toContain('지금 값이 아닙니다');
  });
  it('지금 값 · 연결 실패는 예전 배지 그대로', () => {
    const a = renderToStaticMarkup(h(VcStateBadge, { s: FRESH, now: NOW }));
    expect(a).toContain('badge green');
    expect(a).toContain('Connected');
    const c = renderToStaticMarkup(h(VcStateBadge, { s: DOWN, now: NOW }));
    expect(c).toContain('badge red');
  });
  it('수신 시각을 모르면 지어내지 않는다', () => {
    const html = renderToStaticMarkup(h(VcStateBadge, { s: { ...STALE, receivedAt: null }, now: NOW }));
    expect(html).toContain('마지막 수신 시각을 모릅니다');
    expect(html).not.toMatch(/\d+일 전|방금/);
  });
});

describe('상단 KPI 전체 vCenter 메타', () => {
  it('연결됨 수는 그대로(헤더 N/M 계약) + 그중 낡은 값 개수를 말한다', () => {
    const m = vcCountMeta([FRESH, STALE, DOWN], NOW);
    expect(m.text).toBe('연결됨 2(낡은 값 1 포함) · 불가 1');
    expect(m.title).toContain('낡은 값');
  });
  it('낡은 값이 없으면 예전 문구 그대로', () => {
    const m = vcCountMeta([FRESH, DOWN], NOW);
    expect(m.text).toBe('연결됨 1 · 불가 1');
    expect(m.title).toBeUndefined();
  });
});
