/**
 * views/audit2732i3_alerts.test.jsx — 점검 2회차(v2.732) 그룹 i3: 알림 설정 두 화면이 범위 계정 응답의 웹훅 URL 가림(서버 B3-03 —
 * routes/admin/opsSettings.js hideChannelUrls: url '' + hasUrl + urlHidden, config.urlsHidden)을 '빈 칸 = 미설정' 으로 그리지 않고,
 * 이미 403 인 저장·테스트 발송 버튼을 잠그는가. 두 화면: 설정 › 알림(Alerts2.jsx) · 특수 기능 › 리포트 › 알림 채널(ToolsReports AlertChannels).
 * 렌더(renderToStaticMarkup)로 실제 입력칸·버튼 HTML 을 본다 + 저장 본문에서 가린 채널의 url 이 빠지는지(빈 값이 주소를 지우지 않게).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Alerts2 from './Alerts2.jsx';
import { AlertChannels } from './ToolsReports.jsx';
import { alertsLockReason, channelUrlField, withoutHiddenUrls } from './alertChannelUrlText.js';

const h = React.createElement;
const RULES = { criticalAlarms: { enabled: true }, datastorePct: { enabled: true, threshold: 90 } };
// 서버 hideChannelUrls 를 거친 범위 계정 응답 모양(slack 은 주소 있음, webhook 은 없음)
const HIDDEN_CFG = {
  channels: {
    slack: { enabled: true, url: '', hasUrl: true, urlHidden: true },
    webhook: { enabled: false, url: '', hasUrl: false, urlHidden: true },
    teams: { enabled: false, url: '', hasUrl: false, urlHidden: true },
    email: { enabled: true },
  },
  rules: RULES, cooldownMin: 30, intervalSec: 60, suppressWindowMin: 5, urlsHidden: true,
};
const FULL_CFG = {
  channels: {
    slack: { enabled: true, url: 'https://hooks.example/services/T0/B0/SECRET' },
    webhook: { enabled: false, url: '' },
    teams: { enabled: false, url: '' },
    email: { enabled: false },
  },
  rules: RULES, cooldownMin: 30, intervalSec: 60, suppressWindowMin: 5,
};
const status = (config, scoped) => ({ config, firing: [], recent: [], ...(scoped ? { scoped: true, omittedOutOfScope: { firing: 0, recent: 0 } } : {}) });

const inputs = (html) => [...html.matchAll(/<input[^>]*class="input"[^>]*>/g)].map((m) => m[0]);
const btn = (html, label) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].filter((m) => m[1] === label).map((m) => m[0]);

describe('알림 채널 URL 가림 판정(순수)', () => {
  it('가린 채널은 잠그고 저장 여부를 말한다 — 빈 칸을 미설정으로 그리지 않는다', () => {
    expect(channelUrlField(HIDDEN_CFG.channels.slack, 'x')).toMatchObject({ value: '', disabled: true, placeholder: '설정됨(가림)', hidden: true });
    expect(channelUrlField(HIDDEN_CFG.channels.webhook, 'x')).toMatchObject({ disabled: true, placeholder: '설정 안 됨' });
    expect(channelUrlField({ url: '', urlHidden: true }, 'x').placeholder).toBe('가림(저장 여부 모름)');
    expect(channelUrlField(FULL_CFG.channels.slack, 'ph')).toMatchObject({ value: FULL_CFG.channels.slack.url, disabled: false, placeholder: 'ph' });
  });
  it('범위 계정이면 잠금 사유, 전체 범위면 빈 문자열(구버전 서버의 scoped 도 본다)', () => {
    expect(alertsLockReason(HIDDEN_CFG)).toContain('전체 범위');
    expect(alertsLockReason(FULL_CFG)).toBe('');
    expect(alertsLockReason(FULL_CFG, { scoped: true })).toContain('전체 범위');
  });
  it('저장 본문에서 가린 채널의 url(빈 값)·표지를 뺀다 — 서버는 url 이 없으면 이전 주소를 유지한다', () => {
    const b = withoutHiddenUrls(HIDDEN_CFG);
    expect(b.urlsHidden).toBeUndefined();
    expect('url' in b.channels.slack).toBe(false);
    expect('hasUrl' in b.channels.slack).toBe(false);
    expect(b.channels.slack.enabled).toBe(true);
    expect(b.channels.email).toEqual({ enabled: true });
    expect(withoutHiddenUrls(FULL_CFG).channels.slack.url).toBe(FULL_CFG.channels.slack.url);
  });
});

describe('설정 › 알림(Alerts2) 렌더', () => {
  it('범위 계정 — URL 칸은 잠기고 \'설정됨(가림)\'/\'설정 안 됨\', 저장·테스트 버튼은 잠긴다', () => {
    const html = renderToStaticMarkup(h(Alerts2, { initialData: status(HIDDEN_CFG, true) }));
    const urlInputs = inputs(html).filter((x) => /placeholder="(설정됨\(가림\)|설정 안 됨)"/.test(x));
    expect(urlInputs.length).toBe(2);
    for (const x of urlInputs) expect(x).toContain('disabled=""');
    expect(html).toContain('placeholder="설정됨(가림)"');
    for (const b of [...btn(html, '저장'), ...btn(html, '테스트 발송')]) expect(b).toContain('disabled=""');
    expect(btn(html, '저장').length).toBe(2);
    expect(html).toContain('data-alert-lock');
  });
  it('전체 범위 — 예전처럼 URL 원문·버튼 활성', () => {
    const html = renderToStaticMarkup(h(Alerts2, { initialData: status(FULL_CFG, false) }));
    expect(html).toContain('value="https://hooks.example/services/T0/B0/SECRET"');
    for (const b of [...btn(html, '저장'), ...btn(html, '테스트 발송')]) expect(b).not.toContain('disabled=""');
    expect(html).not.toContain('data-alert-lock');
  });
});

describe('특수 기능 › 리포트 › 알림 채널(AlertChannels) 렌더', () => {
  const REPORT = { channels: { slack: { enabled: true, configured: true }, teams: { enabled: false, configured: false }, webhook: { enabled: false, configured: false } }, firing: [], recent: [], suppressWindowMin: 5, cooldownMin: 30 };
  it('범위 관리자 — 세 채널 URL 칸이 잠기고 저장·테스트 버튼이 잠긴다', () => {
    const html = renderToStaticMarkup(h(AlertChannels, { isAdmin: true, initialData: REPORT, initialCfg: HIDDEN_CFG }));
    const urlInputs = inputs(html).filter((x) => /placeholder="(설정됨\(가림\)|설정 안 됨)"/.test(x));
    expect(urlInputs.length).toBe(3);
    for (const x of urlInputs) expect(x).toContain('disabled=""');
    for (const b of [...btn(html, '저장'), ...btn(html, '테스트 발송')]) expect(b).toContain('disabled=""');
    expect(html).toContain('data-alert-lock');
  });
  it('전체 범위 관리자 — URL 원문·버튼 활성', () => {
    const html = renderToStaticMarkup(h(AlertChannels, { isAdmin: true, initialData: REPORT, initialCfg: FULL_CFG }));
    expect(html).toContain('value="https://hooks.example/services/T0/B0/SECRET"');
    for (const b of [...btn(html, '저장'), ...btn(html, '테스트 발송')]) expect(b).not.toContain('disabled=""');
    expect(html).not.toContain('data-alert-lock');
  });
});
