// v2.785 점검 GN 회귀 — VM DNS 화면 판정(vmDnsText.js).
//  ① N-B3 — 매트릭스 '다른 법인' 색은 서버가 준 칸별 otherCorp 만 쓴다(대표 소유자 1명으로 다시 판정하지 않는다).
//          필드가 없는 예전 서버 응답에서만 예전 판정으로 돌아간다. VM 주소 칩도 서버의 otherCorpIps 를 쓴다.
//  ② N-B2 — 정책 'unsupported'(IPv6 — 정책 미지원) · N-I2 'local'(로컬 스텁 — 판정 안 함) 표기.
//  ③ N-I2 — 'local-stub' 표지 칩 · KPI 보고 칸 · 정합성 줄(서버가 값을 줄 때만).
//  ④ N-B4 — 도달성 건너뜀 'no-ipv6' 문구.
import { describe, it, expect } from 'vitest';
import {
  cellTone, matrixView, ipBadge, POLICY_LABEL, POLICY_TITLE, policyLabel, policyBadge, policyHeadText,
  flagChips, FLAG_LABEL, kpiCards, checkRows, skipText, skippedByText, reachText,
} from './vmDnsText.js';

// 같은 사설 주소 10.0.0.53 을 법인 A·B 가 각자 가진다 — 서버는 대표 소유자로 A-DNS 를 골랐다.
const SERVERS = [
  { ip: '10.0.0.53', kind: 'vm', who: { name: 'A-DNS', vcenterId: 'vc-a', vcenterName: 'A', label: 'VM' }, policy: 'none', owners: 2 },
  { ip: '8.8.8.8', kind: 'public', who: null, publicName: 'Google Public DNS', policy: 'unapproved', owners: 0 },
];
const MATRIX = {
  cols: [{ ip: '10.0.0.53', kind: 'vm', policy: 'none' }, { ip: '8.8.8.8', kind: 'public', policy: 'unapproved' }],
  rows: [
    { vcenterId: 'vc-a', name: 'A', cells: [5, 0], other: 0, total: 5, otherCorp: [false, false] },
    { vcenterId: 'vc-b', name: 'B', cells: [2, 0], other: 0, total: 2, otherCorp: [false, false] },
    { vcenterId: 'vc-c', name: 'C', cells: [1, 1], other: 0, total: 1, otherCorp: [true, false] },
  ],
};

describe('① N-B3 — 다른 법인 판정은 서버 값 하나', () => {
  it('B 행 칸은 대표 소유자(A)와 달라도 서버가 false 라 하면 다른 법인이 아니다', () => {
    const m = matrixView(MATRIX, SERVERS);
    const row = (id) => m.rows.find((r) => r.vcenterId === id);
    expect(row('vc-b').cells[0].tone).toBe('none');
    expect(row('vc-b').cells[0].title).not.toMatch(/다른 법인/);
    expect(row('vc-c').cells[0].tone).toBe('other');
    expect(row('vc-c').cells[0].title).toMatch(/다른 법인의 DNS/);
    expect(row('vc-c').cells[1].tone).toBe('bad');           // 공인은 늘 bad
    expect(row('vc-a').cells[0].tone).toBe('none');
  });
  it('cellTone — 서버 불리언이 있으면 그것만 쓴다', () => {
    expect(cellTone(MATRIX.cols[0], 'vc-b', SERVERS[0], false)).toBe('none');
    expect(cellTone(MATRIX.cols[0], 'vc-a', SERVERS[0], true)).toBe('other');
    expect(cellTone(MATRIX.cols[1], 'vc-c', SERVERS[1], true)).toBe('bad');
  });
  it('예전 서버 응답(otherCorp 없음)에서만 대표 소유자 판정으로 돌아간다', () => {
    const old = { ...MATRIX, rows: MATRIX.rows.map(({ otherCorp, ...r }) => r) };
    const m = matrixView(old, SERVERS);
    expect(m.rows.find((r) => r.vcenterId === 'vc-b').cells[0].tone).toBe('other');
    expect(cellTone(MATRIX.cols[0], 'vc-b', SERVERS[0])).toBe('other');
  });
  it('주소 칩 — VM 행의 otherCorpIps 가 있으면 그것만', () => {
    const byIp = new Map(SERVERS.map((s) => [s.ip, s]));
    expect(ipBadge('10.0.0.53', { vcenterId: 'vc-b', otherCorpIps: [] }, byIp)).toBe('blue');
    expect(ipBadge('10.0.0.53', { vcenterId: 'vc-a', otherCorpIps: ['10.0.0.53'] }, byIp)).toBe('amber');
    expect(ipBadge('8.8.8.8', { vcenterId: 'vc-a', otherCorpIps: [] }, byIp)).toBe('red');
    expect(ipBadge('10.0.0.53', { vcenterId: 'vc-b' }, byIp)).toBe('amber');   // 예전 응답 — 대표 소유자 판정
  });
});

describe('② 정책 표기 — unsupported · local', () => {
  it('라벨·설명·배지(회색) · 문구에 백틱 없음', () => {
    expect(POLICY_LABEL.unsupported).toBe('IPv6 — 정책 미지원');
    expect(policyLabel('unsupported')).toBe('IPv6 — 정책 미지원');
    expect(policyLabel('local')).toMatch(/로컬 스텁/);
    expect(policyBadge('unsupported')).toBe('gray');
    expect(policyBadge('local')).toBe('gray');
    for (const p of ['unsupported', 'local']) {
      expect(POLICY_TITLE[p]).toBeTruthy();
      expect(POLICY_TITLE[p]).not.toMatch(/`/);
      expect(POLICY_TITLE[p]).toMatch(/위반으로 세지 않습니다/);
    }
    expect(policyHeadText({ policy: 'unsupported' })).toMatch(/IPv6/);
    expect(policyHeadText({ policy: 'local' })).toMatch(/로컬 스텁/);
  });
});

describe('③ 로컬 스텁(local-stub)', () => {
  it('표지 칩', () => {
    expect(FLAG_LABEL['local-stub']).toBeTruthy();
    expect(flagChips(['local-stub', 'mismatch']).map((f) => f.key)).toEqual(['mismatch', 'local-stub']);
    expect(flagChips(['local-stub'])[0].badge).toBe('gray');
  });
  it('KPI 보고 칸 — 서버가 값을 주고 0 보다 크면 밝힌다', () => {
    const k = { vms: 100, reported: 80, unknown: 10, notCollected: 10, localStubVms: 12 };
    const rep = kpiCards(k).find((c) => c.key === 'reported');
    expect(rep.sub).toMatch(/로컬 스텁만 12대/);
    expect(kpiCards({ ...k, localStubVms: 0 }).find((c) => c.key === 'reported').sub).not.toMatch(/로컬 스텁/);
    expect(kpiCards({ ...k, localStubVms: undefined }).find((c) => c.key === 'reported').sub).not.toMatch(/로컬 스텁/);
  });
  it('정합성 줄 — kpis 에 값이 있을 때만 넷째 줄(예전 서버는 3줄)', () => {
    const checks = { mismatch: 0, otherCorp: 1, singleDns: 3 };
    expect(checkRows(checks).map((r) => r.key)).toEqual(['mismatch', 'otherCorp', 'singleDns']);
    const r = checkRows(checks, { localStubVms: 12 });
    expect(r.map((x) => x.key)).toEqual(['mismatch', 'otherCorp', 'singleDns', 'localStub']);
    expect(r[3]).toMatchObject({ n: '12' });
    expect(r[3].sub).not.toMatch(/`/);
    expect(checkRows(checks, { localStubVms: 0 })[3]).toMatchObject({ n: '0', tone: 'plain' });
  });
});

describe('④ no-ipv6 건너뜀', () => {
  it('사유 문구 · 요약 분해 · 도달성 칸', () => {
    expect(skipText('no-ipv6')).toMatch(/IPv6/);
    expect(skipText('no-ipv6')).not.toMatch(/점검하지 않음\(no-ipv6\)/);
    expect(skippedByText({ skippedBy: { 'no-ipv6': 3 } })).toBe('IPv6 없음 3');
    expect(reachText({ where: 'central', skipped: 'no-ipv6' })).toMatchObject({ text: '건너뜀', tone: 'muted' });
  });
});
