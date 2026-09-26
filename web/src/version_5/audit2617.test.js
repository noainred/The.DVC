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
    // v2.618: 개요·V4 컴퓨트의 뺄셈은 vcStatusCounts 로 옮겼다(아래 ARCH-1 묶음이 고정한다).
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

describe('v2.618 ARCH-1 — 첫 수집 중은 연결 불가가 아니다(판정 한 곳)', async () => {
  const { vcStatusCounts, vcStatusMeta } = await import('../console/consoleData.js');
  it('서버가 unreachable·pending 을 주면 그대로', () => {
    const g = { vcenters: 28, vcentersConnected: 0, vcentersPending: 28, vcentersUnreachable: 0, vcentersMaintenance: 0, vcentersDisabled: 0 };
    expect(vcStatusCounts(g).unreach).toBe(0);
    expect(vcStatusMeta(g)).toBe('연결 불가 0 · 첫 수집 중 28');
  });
  it('구버전 서버면 예전 뺄셈(비활성 제외)', () => {
    expect(vcStatusCounts({ vcenters: 5, vcentersConnected: 3, vcentersDisabled: 1 }).unreach).toBe(1);
  });
  it('4곳 모두 그 함수를 쓰고 뺄셈 사본이 없다', () => {
    for (const p of ['../views/Overview.jsx', '../version_4/pages/Compute.jsx', '../console/pages/ConsoleCompute.jsx']) {
      const s = src(p);
      expect(s).toContain('vcStatusMeta(g)');
      expect(s).not.toMatch(/g\.vcenters - g\.vcentersConnected/);
    }
  });
});

describe('v2.618 ARCH-5·6 — 사본을 두지 않는다(스윕)', async () => {
  const fs2 = await import('node:fs');
  const path = await import('node:path');
  const root = new URL('../', import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const e of fs2.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p); } };
  walk(root);
  it('상대시각을 손으로 계산하는 사본이 없다(relTime.js 만)', () => {
    const bad = files.filter((f) => !f.endsWith('relTime.js') && !f.endsWith('ServiceDown.jsx') /* 경과 초 카운터(상대시각 아님) */ && /Math\.floor\(\(Date\.now\(\) - [\w.]+\) \/ 1000\)/.test(fs2.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('numOrNull 형 사본이 없다(numOrNull.js 만)', () => {
    const re = /v == null \|\| v === '' \|\| !Number\.isFinite\(Number\(v\)\) \? null|if \(v == null \|\| v === ''\) return null; const n = Number\(v\)/;
    const bad = files.filter((f) => !f.endsWith('numOrNull.js') && re.test(fs2.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
