import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildDomainTiles } from '../console/consoleData.js';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

describe('v2.617 — 비활성 vCenter 는 불가가 아니다(관제 콘솔·V4 타일)', () => {
  it('컴퓨트 타일이 비활성을 불가로 세지 않는다', () => {
    const g = { vcenters: 4, vcentersConnected: 3, vcentersMaintenance: 0, vcentersDisabled: 1, hosts: 10, vms: 50, hostsDisconnected: 0, cpuUsagePct: 10, memUsagePct: 10 };
    const t = buildDomainTiles({ global: g, alarms: [] }).find((x) => x.page === 'compute');
    expect(t.level).toBe(0);
    expect(t.meta).not.toContain('불가');
    expect(t.meta).toContain('비활성 1');
  });
  it('헤더·개요·V4 컴퓨트도 비활성을 뺀다(소스)', () => {
    expect(src('../App.jsx')).toMatch(/conn \+ maint \+ off === total/);
    expect(src('../views/Overview.jsx')).toMatch(/vcentersDisabled \|\| 0\)\)\}개 연결 불가/);
    expect(src('../version_4/pages/Compute.jsx')).toMatch(/- \(g\.vcentersDisabled \|\| 0\)/);
  });
});

describe('v2.617 — V5 사이트 클릭은 상단 법인 선택을 바꾼다', () => {
  it('selectSite 가 v5 분기에서 setV5Scope', () => {
    const s = src('../App.jsx');
    const m = /const selectSite = \(id\) => \{([\s\S]*?)\n {2}\};/.exec(s);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/if \(v5On\) setV5Scope\(/);
  });
});

describe('v2.617 — 검색 인계를 받는 화면은 구독도 한다', () => {
  it.each([['../views/tools/IpamCore.jsx', 'ipam'], ['../views/tools/SerialLookup.jsx', 'serial-lookup']])('%s', (p, key) => {
    const s = src(p);
    expect(s).toMatch(/onSearchHandoff\(/);
    expect(s).toContain(`takeSearch('${key}')`);
  });
});
