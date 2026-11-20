// v3.2.0 — DNS 정합성 문구(ipamDnsText.js) · 호스트명 칸 배지 조합 · 설정 저장 본문.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DNS_FWD, DNS_FWD_ORDER, hasDnsMismatch, dnsBadge, dnsSummary, dnsSummaryParts, dnsDetailLine, dnsStatsText } from './ipamDnsText.js';
import { HostNameCell } from './IpamHostName.jsx';
import { scanSettingsBody } from './ipamScanForm.js';

describe('ipamDnsText', () => {
  it('판정 라벨은 서버 DNS_FWD_STATES 와 1:1 · 어긋남은 다른 IP · 정방향 없음 둘만', () => {
    expect(DNS_FWD_ORDER).toEqual(['match', 'other', 'none', 'unknown']);
    expect(Object.keys(DNS_FWD)).toEqual(DNS_FWD_ORDER);
    expect(['match', 'other', 'none', 'unknown', undefined].map((v) => hasDnsMismatch({ dnsFwd: v }))).toEqual([false, true, true, false, false]);
    expect(hasDnsMismatch(null)).toBe(false);
  });
  it('배지 — 일치 · 확인 못 함 · 없음은 null, 다른 IP 는 주소 · 정방향 없음은 이름을 title 에', () => {
    expect(dnsBadge({ dnsFwd: 'match' })).toBe(null);
    expect(dnsBadge({ dnsFwd: 'unknown' })).toBe(null);
    expect(dnsBadge({})).toBe(null);
    const o = dnsBadge({ dnsFwd: 'other', dnsPtr: 'fs-old.corp', dnsFwdAddrs: ['10.210.7.12'], dnsFwdAt: 5 }, (t) => `T${t}`);
    expect(o.label).toBe('DNS 다른 IP');
    expect(o.title).toMatch(/fs-old\.corp/);
    expect(o.title).toMatch(/10\.210\.7\.12/);
    expect(o.title).toMatch(/T5 확인$/);
    const n = dnsBadge({ dnsFwd: 'none', dnsPtr: 'bmc.corp' });
    expect([n.label, n.tone]).toEqual(['정방향 없음', 'amber']);
    expect(n.title).not.toMatch(/확인$/);
  });
  it('요약 — 결과가 실린 행만 · 불일치 · 확인 못 함 조각(0 은 뺀다)', () => {
    const s = dnsSummary([{ dnsFwd: 'match' }, { dnsFwd: 'match' }, { dnsFwd: 'other' }, { dnsFwd: 'none' }, { dnsFwd: 'unknown' }, {}, { dnsFwd: 'bogus' }, null]);
    expect(s).toEqual({ total: 5, match: 2, other: 1, none: 1, unknown: 1 });
    expect(dnsSummaryParts(s).map((p) => p.label)).toEqual(['불일치 2', '확인 못 함 1']);
    expect(dnsSummaryParts({ total: 2, match: 2, other: 0, none: 0, unknown: 0 })).toEqual([]);
    expect(dnsSummaryParts(null)).toEqual([]);
  });
  it('IP 상세 정방향 줄 — 확인하지 않았으면 null · 확인 못 함은 시각 없음', () => {
    expect(dnsDetailLine(null)).toBe(null);
    expect(dnsDetailLine({ v: 'x' })).toBe(null);
    expect(dnsDetailLine({ v: 'other', at: 9, addrs: ['10.0.0.9', '10.0.0.8'] })).toEqual({ text: '10.0.0.9, 10.0.0.8 — 이 IP 아님', tone: 'amber', at: 9 });
    expect(dnsDetailLine({ v: 'match', at: 9 }).tone).toBe('green');
    expect(dnsDetailLine({ v: 'none', at: 9 }).text).toMatch(/그런 이름 없음/);
    expect(dnsDetailLine({ v: 'unknown', at: 9 }).at).toBe(null);
  });
  it('스캔 요약 문구 — 결과가 없으면 빈 문자열 · 멈춘 사유', () => {
    expect(dnsStatsText(null)).toBe('');
    expect(dnsStatsText({ dnsFwd: { match: 0, other: 0, none: 0, unknown: 0 } })).toBe('');
    expect(dnsStatsText({ dnsFwd: { match: 3, other: 1, none: 0, unknown: 2, stopped: 'unreachable' } })).toBe('정방향 확인 3/6 · 불일치 1 · 확인 못 함 2 · DNS 응답 없음');
    expect(dnsStatsText({ dnsFwd: { match: 4, other: null, none: 0, unknown: 0 } })).toBe('정방향 확인 4/4');
  });
});

describe('호스트명 칸 — 배지 조합(이름 다름 × 정방향 판정)', () => {
  const base = { ownerType: 'scanned', netName: 'fs-old.corp', netNameSrc: 'dns' };
  const html = (r) => renderToStaticMarkup(React.createElement(HostNameCell, { r }));
  // 조합 표: [이름 다름, 정방향 판정] → 보이는 배지 글자(출처 배지 '역DNS' 는 늘 있다)
  const TABLE = [
    [false, undefined, []],
    [false, 'match', []],
    [false, 'unknown', []],
    [false, 'other', ['DNS 다른 IP']],
    [false, 'none', ['정방향 없음']],
    [true, undefined, ['이름 다름']],
    [true, 'match', ['이름 다름']],
    [true, 'other', ['이름 다름', 'DNS 다른 IP']],
    [true, 'none', ['이름 다름', '정방향 없음']],
  ];
  for (const [mismatch, v, want] of TABLE) {
    it(`이름 다름 ${mismatch} · 정방향 ${v ?? '없음'} → ${want.join(' + ') || '배지 없음'}`, () => {
      const out = html({ ...base, ...(mismatch ? { nameMismatch: true, nameAlt: [{ src: 'netbios', name: 'NAS' }] } : {}), ...(v ? { dnsFwd: v, dnsPtr: 'fs-old.corp', dnsFwdAddrs: ['10.0.0.9'] } : {}) });
      const got = ['이름 다름', 'DNS 다른 IP', '정방향 없음'].filter((t) => out.includes(`>${t}<`));
      expect(got).toEqual(want);
      expect(out).toContain('>역DNS<');
    });
  }
});

describe('스캔 설정 저장 본문', () => {
  it('정방향 확인 켬/끔은 그대로 · 기간 빈 칸은 보내지 않는다(서버가 이전 값 유지)', () => {
    const b = scanSettingsBody({ dnsConfirm: false, dnsConfirmHours: '' }, 'edge-a');
    expect(b.dnsConfirm).toBe(false);
    expect(b.dnsConfirmHours).toBe(undefined);
    expect(scanSettingsBody({ dnsConfirmHours: '6' }, 'edge-a').dnsConfirmHours).toBe(6);
  });
});
