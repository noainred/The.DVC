// v2.732 점검 2회차 그룹 a — B2-01(웹): 담당 엣지의 push 가 멈춘 위임(site) vCenter 를 정상 초록으로 칠하지 않는다.
// 서버는 그 vCenter 의 status 를 엣지가 마지막으로 보낸 값('connected') 그대로 두고 stale·receivedAt 만 붙인다(헤더 N/M 계약).
// 그래서 화면 판정이 status 만 보면 며칠 전 값이 '연결됨 · 지금 값' 으로 보였다(v2.570 이 '가장 위험한 거짓' 이라 적은 상태).
// 판정은 순수 모듈을 실제로 호출해 본다(node 환경 — DOM 없음).
import { describe, it, expect } from 'vitest';
import { vcCardState } from './vcCardText.js';
import { corpSiteStatus } from './corpSiteStatus.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const siteStale = { id: 'vc-site1', status: 'connected', stale: true, collectSource: 'site', receivedAt: NOW - 3 * DAY, metrics: { hosts: 1, vms: 1 } };

describe('B2-01 vcCardState — 낡은 위임 vCenter', () => {
  it('connected + stale 은 정상(ok) 이 아니다 — 낡은 값 + 마지막 수신 시각을 말한다', () => {
    const r = vcCardState(siteStale, NOW);
    expect(r.tone).toBe('warn');
    expect(r.showMetrics).toBe(true);        // 값은 보여 주되(숨기면 마지막 값도 모른다) 낡았다고 말한다
    expect(r.stale).toBe(true);
    expect(r.text).toMatch(/낡은 값/);
    expect(r.text).toMatch(/3일 전/);
    expect(r.text).toMatch(/지금 값이 아닙니다/);
    expect(r.text).not.toMatch(/`/);         // BoldText 는 백틱을 해석하지 않는다
  });
  it('마지막 수신 시각을 모르면 지어내지 않는다(1970년·0초 전 금지)', () => {
    for (const receivedAt of [undefined, null, 0, '']) {
      const r = vcCardState({ ...siteStale, receivedAt }, NOW);
      expect(r.tone).toBe('warn');
      expect(r.text).toMatch(/낡은 값/);
      expect(r.text).toMatch(/모릅니다/);
      expect(r.text).not.toMatch(/\d+일 전|\d+초 전|방금/);
    }
  });
  it('접속 실패 이월(LASTGOOD) 의 staleSince 도 마지막 수신으로 읽는다', () => {
    const r = vcCardState({ status: 'connected', stale: true, staleSince: NOW - 2 * 3_600_000, metrics: { hosts: 1 } }, NOW);
    expect(r.text).toMatch(/2시간 전/);
  });
  it('stale 이 아닌 connected 는 예전 그대로 정상', () => {
    expect(vcCardState({ status: 'connected', stale: false, receivedAt: NOW }, NOW)).toEqual({ showMetrics: true, tone: 'ok', text: '' });
    expect(vcCardState({ status: 'connected' }, NOW).tone).toBe('ok');
  });
  it('unreachable + stale(접속 실패 이월)은 예전 판정(연결 실패) 그대로', () => {
    const r = vcCardState({ status: 'unreachable', stale: true, staleSince: NOW - DAY, metrics: { hosts: 3 } }, NOW);
    expect(r.tone).toBe('bad');
    expect(r.text).toMatch(/연결할 수 없/);
  });
});

describe('B2-01 corpSiteStatus — 법인별 표', () => {
  it('connected + stale 은 세되(마지막 값) 낡은 값 표지와 마지막 수신 시각을 단다', () => {
    const r = corpSiteStatus(siteStale, NOW);
    expect(r.countable).toBe(true);
    expect(r.mark).toBe('낡은 값');
    expect(r.stale).toBe(true);
    expect(r.title).toMatch(/3일 전/);
    expect(r.title).toMatch(/지금 값이 아닙니다/);
    expect(r.title).not.toMatch(/\*\*|`/);   // title 속성은 BoldText 를 거치지 않는다
  });
  it('수신 시각을 모르면 시각을 지어내지 않는다', () => {
    const r = corpSiteStatus({ ...siteStale, receivedAt: null }, NOW);
    expect(r.mark).toBe('낡은 값');
    expect(r.title).toMatch(/모릅니다/);
  });
  it('stale 아닌 connected·상태 없음은 표지 없음(예전 그대로)', () => {
    expect(corpSiteStatus({ status: 'connected' }, NOW)).toEqual({ countable: true, mark: null, title: null });
    expect(corpSiteStatus({}, NOW)).toEqual({ countable: true, mark: null, title: null });
  });
  it('unreachable + stale + 지표 있음은 예전처럼 낡은 값 — 마지막 정상 수집 시각을 말한다', () => {
    const r = corpSiteStatus({ status: 'unreachable', stale: true, staleSince: NOW - 2 * DAY, metrics: { hosts: 3 } }, NOW);
    expect(r).toMatchObject({ countable: true, mark: '낡은 값', stale: true });
    expect(r.title).toMatch(/2일 전/);
  });
});
