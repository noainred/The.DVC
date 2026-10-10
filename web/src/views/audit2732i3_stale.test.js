/**
 * views/audit2732i3_stale.test.js — 점검 2회차(v2.732) 그룹 i3: 경영 보기 법인 점(execOverviewText.siteRowsExec)과 V6 법인 카드 톤
 * (version_6/v6Data.siteCards)이 낡은 위임 vCenter(서버 B2-01 — status 'connected' 그대로 + stale:true)를 정상 초록으로 칠하지 않는가.
 * 판정은 corpSiteStatus().stale 하나(그룹 a 가 만든 것)를 두 화면이 그대로 쓴다 — 여기서는 실제 함수를 호출해 결과로 본다.
 */
import { describe, it, expect } from 'vitest';
import { siteRowsExec } from './execOverviewText.js';
import { siteCards, siteToneCounts } from '../version_6/v6Data.js';

const NOW = Date.UTC(2026, 9, 10, 1, 30); // 정시에서 떨어진 고정 시각(시각 경계를 판정하지 않는다)
const DAY = 86_400_000;
const site = (o) => ({ name: o.id, location: { city: o.id, country: 'KR', region: '대한민국' }, ...o });
const SITES = [
  site({ id: 'vc-fresh', status: 'connected', metrics: { hosts: 3, vms: 30, cpuUsagePct: 20, memUsagePct: 30, storageUsagePct: 40 } }),
  site({ id: 'vc-site-stale', status: 'connected', stale: true, collectSource: 'site', receivedAt: NOW - 3 * DAY,
    metrics: { hosts: 3, vms: 30, cpuUsagePct: 20, memUsagePct: 30, storageUsagePct: 40 } }),
  site({ id: 'vc-stale-crit', status: 'connected', stale: true, collectSource: 'site', receivedAt: NOW - DAY,
    metrics: { hosts: 3, vms: 30, cpuUsagePct: 95, memUsagePct: 30, storageUsagePct: 40 } }),
  site({ id: 'vc-lastgood', status: 'unreachable', stale: true, staleSince: NOW - DAY,
    metrics: { hosts: 2, vms: 10, cpuUsagePct: 10, memUsagePct: 10, storageUsagePct: 10 } }),
];

describe('경영 보기 법인 점 — 낡은 값은 초록이 아니다', () => {
  const rows = Object.fromEntries(siteRowsExec(SITES).map((r) => [r.id, r]));
  it('지금 값 사이트는 예전 그대로 초록(ok)', () => {
    expect(rows['vc-fresh'].dot).toBe('ok');
    expect(rows['vc-fresh'].stale).toBe(false);
  });
  it('위임 push 가 멈춘 사이트(connected + stale)는 호박색(warn) + 낡은 값 표지', () => {
    expect(rows['vc-site-stale'].dot).toBe('warn');
    expect(rows['vc-site-stale'].stale).toBe(true);
    expect(rows['vc-site-stale'].mark).toBe('낡은 값');
    expect(rows['vc-site-stale'].vms).toBe(30); // 값은 보여 준다(숨기면 마지막 값도 모른다)
  });
  it('마지막 값이 이미 위험이면 위험 그대로(낮추지 않는다)', () => {
    expect(rows['vc-stale-crit'].dot).toBe('bad');
  });
  it('연결 실패 이월(LASTGOOD) 도 초록이 아니다', () => {
    expect(rows['vc-lastgood'].dot).toBe('warn');
  });
});

describe('V6 법인 카드 톤 — 낡은 값은 정상(ok)으로 세지 않는다', () => {
  const cards = siteCards(SITES);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
  it('지금 값 카드는 예전 그대로 ok', () => {
    expect(byId['vc-fresh'].tone).toBe('ok');
  });
  it('낡은 값 카드는 warn(주의) · 마지막 값이 위험이면 crit', () => {
    expect(byId['vc-site-stale'].tone).toBe('warn');
    expect(byId['vc-site-stale'].stale).toBe(true);
    expect(byId['vc-site-stale'].mark).toBe('낡은 값');
    expect(byId['vc-stale-crit'].tone).toBe('crit');
    expect(byId['vc-lastgood'].tone).toBe('warn');
  });
  it('머리말 개수 — 정상에 낡은 값이 섞이지 않는다', () => {
    const c = siteToneCounts(cards);
    expect(c.ok).toBe(1);
    expect(c.warn).toBe(2);
    expect(c.crit).toBe(1);
  });
});
