// v3.4.0 — IP 관리 재설계 묶음 가(탭 5개 · 현황 · 대역 목록/주소 맵 · 필터 한 줄 · '복수IP'). 설계 docs/design/ipam-redesign.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { IPAM_PAGES, IPAM_TABS, IPAM_DEFAULT_PAGE, tabGroups, tabOfPage, ipamPage } from './ipamPages.js';
import { utilSummary, heatBin, topSubnets, checkCards, checkBadge, mapCellKind, mapCounts, filterSubnets, pctText, meterTone } from './ipamHomeText.js';
import { RECON_OPTIONS, ROW_OPTIONS, reconLabel } from './ipamFilterText.js';
import { firstBase } from './IpamCore.jsx';

const read = (f) => fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');

describe('탭 5개', () => {
  it('모든 페이지가 탭 하나에 속하고 기본 페이지는 현황', () => {
    const tabs = new Set(IPAM_TABS.map(([t]) => t));
    for (const p of IPAM_PAGES) expect(tabs.has(p.tab), p.k).toBe(true);
    expect(IPAM_DEFAULT_PAGE).toBe('home');
    expect(ipamPage('home')).toBeTruthy();
    expect(tabOfPage('changes')).toBe('scan');
    expect(tabOfPage('list')).toBe('addr');
  });
  it('탭 안 보기는 페이지 전부를 한 번씩 덮는다(빠진 페이지 = 갈 길이 없는 화면)', () => {
    const seen = tabGroups('yes').flatMap((g) => g.pages.map((p) => p.k));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(IPAM_PAGES.map((p) => p.k).sort());
  });
  it("관리자 탭은 403('no')일 때만 숨긴다 — 모름은 보인다", () => {
    expect(tabGroups('unknown').map((g) => g.t)).toContain('scan');
    expect(tabGroups('no').map((g) => g.t)).not.toContain('scan');
    expect(tabGroups('no', { csvOk: false }).map((g) => g.t)).not.toContain('setup');
    expect(tabGroups('yes').find((g) => g.t === 'scan').admin).toBe(true);
  });
});

describe('현황 계산', () => {
  it('사용률 — 못 읽음은 null, 빈 목록은 pct null', () => {
    expect(utilSummary(null)).toBe(null);
    expect(utilSummary([]).pct).toBe(null);
    const u = utilSummary([{ used: 254 }, { used: 0 }, { used: 203 }]);
    expect(u).toMatchObject({ nets: 3, used: 457, cap: 762, free: 305, over80: 1 }); // 203/254 = 79.9% 는 80% 미만
    expect(pctText(u.pct)).toBe('60%');
    expect(pctText(null)).toBe('—');
  });
  it('지도 단계 · 막대 색 경계', () => {
    expect([0, 19.9, 20, 59.9, 60, 79.9, 80, 100].map(heatBin)).toEqual([0, 0, 1, 2, 3, 3, 4, 4]);
    expect(heatBin(null)).toBe(null);
    expect([79.9, 80, 89.9, 90].map(meterTone)).toEqual(['ok', 'warn', 'warn', 'crit']);
  });
  it('상위 대역 — used 내림차순, 같으면 원래 순서', () => {
    const t = topSubnets([{ base: 'a', subnet: 'a/24', used: 10 }, { base: 'b', subnet: 'b/24', used: 30 }, { base: 'c', subnet: 'c/24', used: 10 }], 2);
    expect(t.map((x) => x.base)).toEqual(['b', 'a']);
    expect(t[0].free).toBe(224);
  });
  it("확인할 것 — 대장을 못 받았으면 0 이 아니라 null, 0 은 '없음'", () => {
    expect(checkCards(null, null).every((c) => c.n === null)).toBe(true);
    const cs = checkCards({ duplicateIps: 0, multiHomed: 5 }, { conflict: 2, macAlert: 0, reserved: 1, dnsBad: 0 });
    expect(checkBadge(cs.find((c) => c.k === 'conflict'))).toMatchObject({ label: '심각' });
    expect(checkBadge(cs.find((c) => c.k === 'duplicate'))).toMatchObject({ label: '없음' });
    expect(cs.find((c) => c.k === 'multihomed').label).toBe('복수IP');
    expect(checkBadge({ n: null })).toBe(null);
  });
  it('확인할 것의 필터 키는 IP 주소 탭의 고르기 항목에 전부 있다(누르면 빈 화면이 되지 않게)', () => {
    const rk = new Set(RECON_OPTIONS.map((o) => o.k));
    const wk = new Set(ROW_OPTIONS.map((o) => o.k));
    for (const c of checkCards({}, {})) {
      if (c.go.recon) expect(rk.has(c.go.recon), c.k).toBe(true);
      if (c.go.row) expect(wk.has(c.go.row), c.k).toBe(true);
    }
  });
});

describe('대역 탭', () => {
  it('맵 칸 종류', () => {
    expect(mapCellKind({ status: 'network' })).toBe('nw');
    expect(mapCellKind({ status: 'duplicate' })).toBe('bad');
    expect(mapCellKind({ status: 'multihomed' })).toBe('used');
    expect(mapCellKind({ status: 'scanned' })).toBe('scan');
    expect(mapCellKind({ status: 'empty', mgmtStatus: 'dhcp' })).toBe('dhcp');
    expect(mapCellKind({ status: 'empty', mgmtStatus: 'reserved' })).toBe('rsv');
    expect(mapCellKind({ status: 'released' })).toBe('rel');
    expect(mapCellKind({})).toBe('free');
    expect(mapCounts([{ status: 'used' }, {}, {}])).toMatchObject({ used: 1, free: 2 });
  });
  it('대역 찾기 · 처음 고를 대역', () => {
    const l = [{ base: '10.20.30', subnet: '10.20.30.0/24', used: 5 }, { base: '10.20.31', subnet: '10.20.31.0/24', used: 9 }];
    expect(filterSubnets(l, '10.20.31').length).toBe(1);
    expect(filterSubnets(l, '').length).toBe(2);
    expect(firstBase(l)).toBe('10.20.31');
    expect(firstBase(l, '10.20.30')).toBe('10.20.30');
    expect(firstBase(l, '1.1.1')).toBe('10.20.31');
    expect(firstBase([])).toBe('');
  });
});

describe('필터 한 줄 · 표기', () => {
  it('고르기 항목 키는 IpamCore 의 행 판정에 전부 있다', () => {
    const core = read('IpamCore.jsx');
    for (const o of RECON_OPTIONS.filter((x) => x.k && !['vcenter', 'both', 'scan', 'manual', 'conflict'].includes(x.k))) {
      expect(core, o.k).toMatch(new RegExp(`reconFilter === '${o.k}'`));
    }
    for (const o of ROW_OPTIONS.filter((x) => x.k)) expect(core, o.k).toMatch(new RegExp(`rowFilter === '${o.k}'`));
    expect(reconLabel({ label: 'x' }, null)).toBe('x');
    expect(reconLabel({ label: 'x' }, 1200)).toBe('x (1,200)');
  });
  it("화면 표기는 '복수IP' — '멀티홈' 이 화면 문구에 남지 않는다(2026-11-13 사용자 결정)", () => {
    for (const f of ['IpamCore.jsx', 'IpamHome.jsx', 'IpamSubnets.jsx', 'ipamFilterText.js', 'ipamHomeText.js']) {
      const strs = read(f).match(/(['"`])(?:(?!\1).)*멀티홈(?:(?!\1).)*\1|>[^<{]*멀티홈[^<{]*</g) || [];
      expect(strs.filter((x) => !/예전 표기/.test(x)), f).toEqual([]);
    }
  });
  it('빨간 강조 검색창 · KPI 카드 9장 · 서브넷 칩 벽이 없다', () => {
    const core = read('IpamCore.jsx');
    expect(core).not.toMatch(/border: '2px solid #ef4444'/);
    expect(core).not.toMatch(/<Card label="총 IP"/);
    expect(core).not.toMatch(/subnets\.map\(\(s\) => \(\s*<span key=\{s\.base\} className="badge gray"/);
  });
});
