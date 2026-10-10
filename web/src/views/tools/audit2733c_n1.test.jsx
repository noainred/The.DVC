// v2.733 점검 3회차 그룹 c — C2-04(웹 절반): N+1 판정 칸은 true(여유)·false(위험)·null(판정 안 함) 셋이다.
//   예전 화면은 `c.n1Ok ? 여유 : 위험` 이라 서버가 판정하지 않은 독립 호스트 그룹(null)도 '위험'·빨간 행으로 칠했다.
//   renderToStaticMarkup 이라 클릭·레이아웃은 보지 못한다(Chromium 확인 몫).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { N1Table, n1RiskCount } from './InsightsThreats.jsx';

const CL = [
  { vcenterId: 'vcA', cluster: 'CL1', standalone: false, hosts: 3, hostsUsageExcluded: 0, maintenance: 1, clusterUnknown: 0, n1Ok: false, cpuAfterFailPct: 160, memAfterFailPct: 160, cpuUsagePct: 53, memUsagePct: 53 },
  { vcenterId: 'vcA', cluster: 'CL2', standalone: false, hosts: 2, hostsUsageExcluded: 1, maintenance: 0, clusterUnknown: 0, n1Ok: true, cpuAfterFailPct: 40, memAfterFailPct: 30, cpuUsagePct: 20, memUsagePct: 15 },
  { vcenterId: 'vcA', cluster: 'standalone', standalone: true, hosts: 3, hostsUsageExcluded: 0, maintenance: 0, clusterUnknown: 2, n1Ok: null, cpuAfterFailPct: null, memAfterFailPct: null, cpuUsagePct: 30, memUsagePct: 29 },
];

describe('C2-04 N+1 판정 칸', () => {
  it('위험 개수는 false 만 센다(null 은 판정 안 함)', () => {
    expect(n1RiskCount(CL)).toBe(1);
    expect(n1RiskCount([{ n1Ok: null }, { n1Ok: undefined }])).toBe(0);
    expect(n1RiskCount(undefined)).toBe(0);
  });
  it('독립 호스트 그룹은 위험으로 칠하지 않고 판정 안 함 · 유지보수·끊김·소속 미상을 말한다', () => {
    const html = renderToStaticMarkup(React.createElement(N1Table, { cl: CL }));
    const rows = html.split('<tr').slice(2);   // thead 행 제외
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('위험');
    expect(rows[0]).toContain('rgba(239,68,68,.10)');
    expect(rows[0]).toContain('유지보수 1대 제외');
    expect(rows[1]).toContain('여유');
    expect(rows[1]).toContain('연결 끊김 1대 제외');
    // 독립 호스트 — '위험' 배지도 빨간 행도 아니다
    expect(rows[2]).not.toContain('badge red');
    expect(rows[2]).not.toContain('rgba(239,68,68');
    expect(rows[2]).toContain('판정 안 함');
    expect(rows[2]).toContain('독립 호스트(클러스터 없음)');
    expect(rows[2]).toContain('소속을 읽지 못한 호스트 2대 포함');
    expect(html).toContain('유지보수 호스트');
  });
});
