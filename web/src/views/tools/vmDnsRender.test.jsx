/**
 * VM DNS 설정 확인 — 렌더 스모크(서버 없이 계약 모양 응답으로). 브라우저가 아니라 renderToStaticMarkup 이라
 * 레이아웃은 보지 못한다(그건 Chromium 확인 몫). 여기서 잡는 것: 런타임 예외 · React #31(객체를 글자로) · 'null'/'undefined'/'NaN'
 * 이 화면에 새는 것 · 0 을 지어내는 것.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KpiRow, ServerSection, MatrixSection, DomainsCard, ModeCard, RecentChanges, PolicyPanel, ServerDetail, ChangesPanel } from './VmDnsTool.jsx';
import { kpiCards, normPolicy } from './vmDnsText.js';

const h = React.createElement;
const SERVERS = [
  { ip: '10.20.0.53', kind: 'vm', who: { name: 'NJ-DC01', vcenterId: 'vc-nj', vcenterName: 'NJ', label: 'VM' }, publicName: null, cls: 'private', vms: 1204, firstVms: 1100, corps: [{ id: 'vc-nj', name: 'NJ', vms: 1100 }], policy: 'approved', unapprovedVms: 0, otherCorpVms: 0, owners: 1, probe: { at: 1_000, where: 'central', qname: 'nj.corp.example', udp: { ok: true, ms: 3, rcode: 'NOERROR', error: null }, tcp: { ok: false, ms: null, rcode: null, error: 'timeout' } } },
  { ip: '8.8.8.8', kind: 'public', who: null, publicName: 'Google Public DNS', cls: 'public', vms: 61, firstVms: 23, corps: [{ id: 'vc-nj', name: 'NJ', vms: 9 }], policy: 'unapproved', unapprovedVms: 61, otherCorpVms: 0, owners: 0, probe: { at: 1_000, where: 'central', skipped: 'mock', udp: null, tcp: null } },
  { ip: '10.9.9.9', kind: 'vm', who: { label: '다른 법인 VM', name: null, vcenterId: null }, cls: 'private', vms: 3, firstVms: 0, corps: [], policy: 'none', owners: 2, probe: { at: 1, where: 'edge-only', udp: null, tcp: null } },
  { ip: '10.0.0.53', kind: 'unknown', who: null, cls: 'private', vms: 2, firstVms: 2, corps: [], policy: 'mixed', owners: 0, probe: null },
];
const DATA = {
  generatedAt: '2026-10-05T07:00:00.000Z', initial: false,
  scope: { scoped: false, omittedOutOfScope: 0 },
  vcenters: [{ id: 'vc-nj', name: 'NJ', vms: 554, reported: 500, unknown: 50, notCollected: 4, collect: 'direct', rest: false }],
  kpis: { vms: 554, reported: 500, unknown: 50, notCollected: 4, servers: 4, serversByKind: { vm: 2, host: 0, public: 1, unknown: 1 }, unapprovedVms: 61, publicVms: 61, mismatchVms: 0, otherCorpVms: 3, singleDnsVms: 10, dhcpVms: 50, staticVms: 450, policyCorps: 1 },
  servers: SERVERS, serversTotal: 4, serversOmitted: 0,
  matrix: { cols: SERVERS.map((s) => ({ ip: s.ip, kind: s.kind, policy: s.policy })), rows: [{ vcenterId: 'vc-nj', name: 'NJ', cells: [540, 9, 3, 0], other: 5, total: 554 }] },
  domains: [{ name: 'nj.corp.example', vms: 450 }], search: [{ name: 'corp.example', vms: 300 }],
  checks: { mismatch: 0, otherCorp: 3, singleDns: 10 },
  changes: { available: true, recent: [{ ts: Date.now() - 60_000, vmId: 'vm-1', vmName: 'NJ-APP-1', vcenterId: 'vc-nj', vcenterName: 'NJ', before: ['10.20.0.53'], after: ['8.8.8.8'], first: false }] },
  probe: { running: false, lastRunAt: Date.now() - 600_000, finishedAt: Date.now() - 590_000, summary: { targets: 4, answered: 1, failed: 0, skipped: 1, edgeOnly: 1, skippedBy: { mock: 1 } } },
  policy: { publicUnapproved: true, rev: 3, corps: 1 },
  history: { lastRunAt: Date.now() - 60_000, intervalMs: 600_000, retentionDays: 365, idleReason: '' },
};
const byIp = new Map(SERVERS.map((s) => [s.ip, s]));
const POLICY = { corps: { 'vc-nj': ['10.20.0.53', '10.20.0.0/24'], 'vc-gone': ['1.2.3.4'] }, publicUnapproved: true, rev: 3, invalid: [{ vcenterId: 'vc-nj', value: '010.1.1.1', reason: '정규형 아님' }], orphan: ['vc-gone'] };

const noLeak = (html) => {
  expect(html).not.toMatch(/>(null|undefined|NaN)</);
  expect(html).not.toMatch(/\[object Object\]/);
  expect(html).not.toMatch(/(null|undefined|NaN)(%|ms|대|개)/);
};

describe('VM DNS 렌더 스모크', () => {
  it('KPI 8칸 — 값이 없으면 —', () => {
    const html = renderToStaticMarkup(h(KpiRow, { cards: kpiCards(DATA.kpis, { vcCount: 1, publicUnapproved: true }) }));
    expect(html).toContain('조사한 VM');
    expect(html).toContain('미수집');
    noLeak(html);
    const empty = renderToStaticMarkup(h(KpiRow, { cards: kpiCards(null) }));
    expect((empty.match(/>—</g) || []).length).toBe(8);
  });
  it('DNS 서버 표 — 정체·정책·도달성·가린 소유자', () => {
    const html = renderToStaticMarkup(h(ServerSection, { data: DATA, onPick: () => {} }));
    expect(html).toContain('Google Public DNS');
    expect(html).toContain('다른 법인 VM 외 1대');
    expect(html).toContain('udp 3ms · tcp 시한 초과');
    expect(html).toContain('중앙에서 못 잼');
    expect(html).toContain('건너뜀');
    expect(html).toContain('min-width:900px');
    expect(html).not.toMatch(/color:#[0-9a-f]{3,6}/i);
    noLeak(html);
  });
  it('매트릭스 — 칸 색은 토큰, 0 은 ·', () => {
    const html = renderToStaticMarkup(h(MatrixSection, { matrix: DATA.matrix, servers: SERVERS }));
    expect(html).toContain('color-mix(in srgb, var(--accent)');
    expect(html).toContain('color-mix(in srgb, var(--red)');
    expect(html).toContain('color-mix(in srgb, var(--amber)');   // 가린 소유자 = 다른 법인
    expect(html).toContain('>·<');
    noLeak(html);
  });
  it('아래 3장', () => {
    const html = renderToStaticMarkup(h('div', null,
      h(DomainsCard, { domains: DATA.domains, search: DATA.search }),
      h(ModeCard, { kpis: DATA.kpis, checks: DATA.checks }),
      h(RecentChanges, { changes: DATA.changes, kindOf: (ip) => byIp.get(ip)?.kind || null, onMore: () => {} })));
    expect(html).toContain('nj.corp.example');
    expect(html).toContain('NJ-APP-1');
    expect(html).toContain('방식을 읽은 500대 기준');
    noLeak(html);
    const none = renderToStaticMarkup(h(RecentChanges, { changes: { available: false, reason: 'DB 없음', recent: [] }, kindOf: () => null, onMore: () => {} }));
    expect(none).toContain('기록이 없다는 뜻이 아닙니다');
  });
  it('정책 · 도달성 — 관리자는 편집 칸·버튼, 아니면 없음', () => {
    const props = { vcList: DATA.vcenters, servers: SERVERS, byIp, policy: POLICY, policyErr: null, onSaved: async () => {}, data: DATA, onProbe: () => {}, probeBusy: false, draft: normPolicy(POLICY), setDraft: () => {} };
    const admin = renderToStaticMarkup(h(PolicyPanel, { ...props, canWrite: true }));
    expect(admin).toContain('정책 저장');
    expect(admin).toContain('지금 점검 (4개)');
    expect(admin).toContain('vc-gone');                 // 목록에 없는 vCenter 키도 보인다
    expect(admin).toContain('형식이 틀린 1개');
    expect(admin).toContain('건너뜀: 데모 1');
    expect(admin).toContain('nj.corp.example');         // 질의 이름
    noLeak(admin);
    const viewer = renderToStaticMarkup(h(PolicyPanel, { ...props, canWrite: false }));
    expect(viewer).not.toContain('정책 저장');
    expect(viewer).not.toContain('지금 점검');
    expect(viewer).toContain('전체 범위 관리자만');
  });
  it('상세·변경 이력 탭 — 첫 렌더는 고르기·불러오는 중(예외 없음)', () => {
    const picker = renderToStaticMarkup(h(ServerDetail, { ip: '', vcId: '', data: DATA, byIp, onBack: () => {}, onPick: () => {} }));
    expect(picker).toContain('주소를 고르세요');
    const loading = renderToStaticMarkup(h(ServerDetail, { ip: '8.8.8.8', vcId: '', data: DATA, byIp, onBack: () => {}, onPick: () => {} }));
    expect(loading).toContain('8.8.8.8');
    expect(loading).toContain('Google Public DNS');
    noLeak(loading);
    expect(() => renderToStaticMarkup(h(ChangesPanel, { vcId: '', kindOf: () => null, onPickIp: () => {}, history: DATA.history }))).not.toThrow();
  });
});
