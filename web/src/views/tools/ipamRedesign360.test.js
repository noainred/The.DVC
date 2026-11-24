// v3.6.0 IP 관리 재설계 묶음 다 — 서버 보기 · 호스트명 대조 · 스캔 대역 추가 표시 문구(순수).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { ADD_STATE, basketOf, canPick, cellText, dnsFwdText, groupCandidates, groupOf, nameCheckOf, pickAllNew, srcParts, topOdd, verdictText } from './ipamServerText.js';
import { IPAM_PAGES } from './ipamPages.js';

describe('v3.6.0 서버 보기 문구', () => {
  it('이름 확인 · 정방향 확인', () => {
    expect(nameCheckOf({ nameCheck: 'diff' }).label).toBe('불일치');
    expect(nameCheckOf({}).label).toBe('—');
    expect(dnsFwdText({ dnsFwd: 'other', dnsFwdAddrs: ['10.0.0.9'] })).toContain('10.0.0.9');
    expect(dnsFwdText({ dnsFwd: 'match' })).toBe('');
  });
});

describe('v3.6.0 호스트명 대조 문구', () => {
  it('칸 글자 — 값이 없으면 상태를 말한다', () => {
    expect(cellText({ state: 'ok', v: 'web01' })).toBe('web01');
    expect(cellText({ state: 'addr', v: '10.0.0.1' })).toBe('10.0.0.1 (주소)');
    expect(cellText({ state: 'na' })).toBe('해당 없음');
    expect(cellText({ state: 'hidden' })).toBe('가림');
    expect(cellText({ state: 'unread' })).toBe('못 읽음');
    expect(cellText(null)).toBe('—');
  });
  it("판정 — 못 읽은 곳이 있으면 '읽은 n곳은 같음'", () => {
    expect(verdictText({ verdict: 'same', partial: true, readN: 2 })).toBe('읽은 2곳은 같음');
    expect(verdictText({ verdict: 'same', partial: false })).toBe('모두 같음');
    expect(verdictText({ verdict: 'diff' })).toBe('서로 다름');
  });
  it('가장 많이 어긋나는 곳', () => {
    expect(topOdd({ oddBy: { idrac: 0, vcenter: 3, os: 7, dns: 1 } })).toEqual({ k: 'os', label: 'OS', n: 7 });
    expect(topOdd({ oddBy: { idrac: 0, vcenter: 0, os: 0, dns: 0 } })).toBe(null);
    expect(topOdd(null)).toBe(null);
  });
  it('페이지 — IP 주소 탭의 둘째 보기(대장 데이터 없이 그린다)', () => {
    const p = IPAM_PAGES.find((x) => x.k === 'names');
    expect(p.tab).toBe('addr'); expect(p.needsLedger).toBeFalsy();
    const core = fs.readFileSync(new URL('./IpamCore.jsx', import.meta.url), 'utf8');
    expect(core).toMatch(/view === 'names' \? <IpamHostNames \/>/);
    expect(core).toMatch(/<IpamServerModal ip=\{ip\}/);
  });
  it('무거운 집계 — 폴링하지 않는다(열 때 1회 + 새로고침)', () => {
    const src = fs.readFileSync(new URL('./IpamHostNames.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/usePolling|setInterval/);
  });
});

describe('v3.6.0 스캔 대역 추가(시안 ⑪)', () => {
  const rows = [
    { cidr: '10.0.0.0/24', cls: 'private', kind: 'new', vmIps: 3, esxiIps: 1, idracIps: 0, purpose: '웹' },
    { cidr: '10.0.1.0/24', cls: 'private', kind: 'covered', vmIps: 1 },
    { cidr: '10.0.2.0/24', cls: 'private', kind: 'other', esxiIps: 2, with: ['edge-b'] },
    { cidr: '203.0.113.0/24', cls: 'public', kind: 'new', idracIps: 1 },
    { cidr: '198.51.100.0/24', cls: 'mixed', kind: 'new', vmIps: 1 },
    { cidr: '172.16.0.0/24', kind: 'new', ips: 2 },
  ];
  it('묶음 — 공인 · 섞임은 공인, 분류를 모르면 따로(사설로 두지 않는다)', () => {
    expect(rows.map(groupOf)).toEqual(['private', 'private', 'private', 'public', 'public', 'unknown']);
    const g = groupCandidates(rows, '');
    expect(g.private.length).toBe(3); expect(g.public.length).toBe(2); expect(g.unknown.length).toBe(1);
    expect(groupCandidates(rows, '웹').private.map((r) => r.cidr)).toEqual(['10.0.0.0/24']);
  });
  it('담기 — 이미 스캔 중 · 형식 오류는 담을 수 없음 · 모두 담기는 새 대역만', () => {
    expect(canPick(rows[1])).toBe(false); expect(canPick(rows[2])).toBe(true);
    const all = pickAllNew(new Set(), rows.slice(0, 3));
    expect([...all]).toEqual(['10.0.0.0/24']);
    const b = basketOf(rows, new Set(['10.0.0.0/24', '10.0.1.0/24', '10.0.2.0/24', '203.0.113.0/24']));
    expect(b.all.length).toBe(3); expect(b.pri.length).toBe(2); expect(b.pub.length).toBe(1); expect(b.addrs).toBe(762); expect(b.overlap).toBe(1);
  });
  it('출처 조각 · 상태 글자', () => {
    expect(srcParts(rows[0])).toEqual(['VM 3', 'ESXi 1']);
    expect(srcParts(rows[5])).toEqual(['주소 2']);
    expect(ADD_STATE.covered.label).toBe('이미 스캔 중');
  });
  it('스캔 설정 화면 — 담기 화면이 가져오기와 같은 넣기(applyImport) 경로를 쓴다', () => {
    const src = fs.readFileSync(new URL('./IpScanSettings.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/<ScanRangeAdd agent=\{agent\} text=\{rangeText\} saved=\{saved\}[^>]*onConfirm=\{onImportConfirm\}/);
    expect(src).not.toMatch(/function SubnetSuggest/);
  });
});
