// v2.954 — 점검 축 E(웹 화면) 확정 결함 6건의 회귀 테스트.
//   E-1 VcTable 셀 수 없는 vCenter '—' · 합계 countableTotals · E-2 PlatformHub 는 App 의 범위 요약 prop · E-3 SAN 상세 편중 = 서버 규칙(최소 처리량 포함) ·
//   E-4 분류 · 매핑 두 칼럼이 1100px 이하에서 한 칼럼 · E-5 BmPowerFleet 랙 늦은 응답 · E-6 BmCompareView 빈 선택에서 로더 세대 증가.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../test/_stripComments.js';

vi.mock('../api.js', async (orig) => {
  const real = await orig();
  // 허브가 자체 폴링을 하면 이 '전 법인' 값(999)이 보인다 — prop 으로 받은 범위 요약만 그려야 한다.
  const unscoped = { totals: { vcenters: { total: 999 }, hosts: { total: 999 }, vms: { total: 999 } }, byVc: [] };
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: () => ({ data: unscoped, error: null, loading: false }), toolAllowed: () => true, hasRole: () => true, can: () => true };
});

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const h = React.createElement;
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H - 30 * 60_000;

describe('E-1 VcTable — 셀 수 없는 vCenter 는 0 이 아니라 —', () => {
  it('첫 수집 중 · 비활성 행은 호스트 · VM · 알람 · 사용률이 — 이고 합계에 0 으로 더하지 않는다(빠진 곳 수 표기)', async () => {
    const { default: VcTable } = await import('./platform/VcTable.jsx');
    const sites = [
      { id: 'KR', name: 'KR', status: 'connected', metrics: { hosts: 10, vms: 120, alarmsCritical: 1, alarmsWarning: 2, cpuUsagePct: 40, memUsagePct: 50 } },
      { id: 'PL', name: 'PL', status: 'pending', metrics: { hosts: 0, vms: 0, alarmsCritical: 0, alarmsWarning: 0, cpuUsagePct: 0, memUsagePct: 0 } },
      { id: 'US', name: 'US', status: 'disabled', metrics: { hosts: 0, vms: 0, alarmsCritical: 0, alarmsWarning: 0 } },
    ];
    const html = renderToStaticMarkup(h(VcTable, { sites, byVc: new Map(), backupText: () => null, onOpen() {}, onGoHosts() {}, onGoVms() {}, now: NOW }));
    const rows = html.split('<tr').slice(1);
    const pl = rows.find((r) => r.includes('<b>PL</b>'));
    expect(pl).toBeTruthy();
    expect(pl).not.toMatch(/>0 →</);          // 호스트 · VM 버튼 '0 →' 없음
    expect(pl).not.toMatch(/>0%</);           // 사용률 0% 없음
    expect(pl).not.toMatch(/tabular">0</);    // 알람 0 없음
    const total = rows.find((r) => r.includes('합계 ·'));
    expect(total).toMatch(/>10</);
    expect(total).toMatch(/>120</);
    expect(total).toContain('미수집 2곳 제외');
  });
  it('합계는 countableTotals 를 쓴다(판정 복제 금지 — 행 판정은 corpSiteStatus)', () => {
    const s = read('./platform/VcTable.jsx');
    expect(s).toMatch(/countableTotals\(rows/);
    expect(s).toMatch(/corpSiteStatus\(s, now\)/);
    expect(s).not.toMatch(/Number\.isFinite\(s\.metrics\?\.hosts\)/);
  });
});

describe('E-2 PlatformHub — App 의 범위 요약 prop 하나만', () => {
  it('summary prop 의 수를 그리고 자체 /platform/summary 폴링을 하지 않는다', async () => {
    const { default: PlatformHub } = await import('./platform/PlatformHub.jsx');
    const summary = { totals: { vcenters: { total: 1, connected: 1 }, hosts: { total: 12 }, vms: { total: 345 } }, byVc: [{ id: 'PL', vms: { attention: 3 } }] };
    const html = renderToStaticMarkup(h(PlatformHub, { tab: 'vms', tabs: ['vcenters', 'hosts', 'vms'], onTab() {}, summary, vcenters: [{ id: 'PL', name: 'PL', status: 'connected' }], vcenterId: 'PL', onPickVcenter() {} }));
    expect(html).toContain('345');
    expect(html).not.toContain('999');
    const src = read('./platform/PlatformHub.jsx');
    expect(src).not.toMatch(/usePolling/);
    expect(src).not.toMatch(/\/platform\/summary'/);
  });
  it('App 은 범위 요약을 한 번 부르고 허브에 summary 로 넘긴다', () => {
    const app = read('../App.jsx');
    expect((app.match(/'\/platform\/summary'/g) || []).length).toBe(1);
    expect(app).toMatch(/<PlatformHub[\s\S]{0,200}?summary=\{platformSummary\}/);
  });
});

describe('E-3 SAN 상세 편중 — 서버 규칙(최소 처리량 포함)', () => {
  it('directorSkew 는 서버 storageList.directorsOf 와 같은 입력에서 같은 결론', async () => {
    const { directorSkew } = await import('./tools/sanStorageText.js');
    const { directorsOf } = await import('../../../server/src/sanswitch/storageList.js');
    const { IMBALANCE_MIN_BPS, IMBALANCE_RATIO } = await import('../../../server/src/sanswitch/portUsage.js');
    const rule = { minBps: IMBALANCE_MIN_BPS, ratio: IMBALANCE_RATIO };
    const G = 1e9 / 8;   // 1 Gb/s (bytes/s)
    const cases = [
      [0.05 * G, 0.08 * G],             // 한가한 어레이 — 1.4배를 넘어도 최소 처리량 미만
      [1 * G, 2 * G],                   // 편중
      [1 * G, 1.1 * G, 1.2 * G],        // 편중 없음
      [2 * G, null],                    // 표본 있는 디렉터 1개
      [0.6 * G, 0.6 * G, 1.0 * G],      // 경계 근처
    ];
    for (const avgs of cases) {
      const srv = directorsOf(avgs.map((a, i) => ({ group: `FA-${i + 1}D`, confidence: 'auto', avg24: a, deviceId: '1', port: i })));
      const web = directorSkew(avgs.map((a, i) => ({ group: `FA-${i + 1}D`, avg: a })), rule);
      expect(web.state === 'skewed').toBe(srv.imbalance != null);
      if (srv.imbalance) { expect(web.group).toBe(srv.imbalance.group); expect(web.ratio).toBe(srv.imbalance.ratio); }
    }
    expect(directorSkew([{ group: 'A', avg: 0.05 * G }, { group: 'B', avg: 0.08 * G }], rule).state).toBe('low');
    expect(directorSkew([{ group: 'A', avg: 1 }, { group: 'B', avg: 2 }], null).state).toBe('unknown');
  });
  it('상세 화면에 1.4 를 박지 않고 API 규칙(check-settings 의 imbalanceRule)으로 판정한다', () => {
    const s = read('./tools/SanStorageTool.jsx');
    expect(s).not.toMatch(/>=\s*1\.4\b/);
    expect(s).not.toMatch(/1\.4배/);
    expect(s).toMatch(/directorSkew\(/);
    expect(s).toMatch(/\/tools\/san-storage\/check-settings/);
  });
});

describe('E-4 분류 · 매핑 — 1100px 이하 한 칼럼', () => {
  it('sst-two 에 인라인 gridTemplateColumns 가 없고, 1100px 미디어 쿼리가 .sst-two.map 도 한 칼럼으로', () => {
    const jsx = read('./tools/SanStorageMapping.jsx');
    expect(jsx).not.toMatch(/className="sst-two[^"]*"\s+style=\{\{[^}]*gridTemplateColumns/);
    expect(jsx).toMatch(/className="sst-two map"/);
    const css = fs.readFileSync(new URL('./tools/sanStorage.css', import.meta.url), 'utf8');
    const m = /@media \(max-width: 1100px\) \{([\s\S]*?)\n\}/.exec(css);
    expect(m).toBeTruthy();
    expect(m[1]).toMatch(/\.sst-two\.map[^{]*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });
});

describe('E-5 BmPowerFleet — 랙 늦은 응답은 버린다', () => {
  it('openRack 은 세대 가드(useLatest)로 그린다', () => {
    const s = read('./tools/BmPowerFleet.jsx');
    const body = /const openRack = [\s\S]*?\n {2}\};/.exec(s)?.[0] || '';
    expect(body).toMatch(/latest\(fetchJson\('\/tools\/bm-usage\/power'/);
    expect(body).not.toMatch(/await fetchJson/);
    expect(s).toMatch(/const latest = useLatest\(\)/);
  });
});

describe('E-6 BmCompareView — 서버를 모두 빼면 진행 중 조회를 버린다', () => {
  it('cancel() 뒤 끝난 조회는 stale 이고 set 하지 않는다', async () => {
    const { createCompareLoader } = await import('./tools/BmCompareView.jsx');
    let r1; const slow = new Promise((r) => { r1 = r; });
    const L = createCompareLoader(() => slow);
    const got = [];
    const p = L.load({}, (x) => got.push(x));
    L.cancel();
    r1({ ok: true, n: 1 });
    expect(await p).toBe('stale');
    expect(got.filter((x) => x.resp)).toEqual([]);
  });
  it('빈 키 분기가 로더를 취소한다', () => {
    const s = read('./tools/BmCompareView.jsx');
    expect(s).toMatch(/if \(!keys\.length\) \{ loader\.current\.cancel\(\);/);
  });
});
