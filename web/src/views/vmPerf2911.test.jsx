// v2.911 — VM 상세 · 성능 그래프(시안 docs/design/vm-perf ①②) 소스 스윕 + 단추 렌더: vCenter 트리의 VM 클릭은 드로어 · 성능 모달 제거 · '📈' 7곳은 개체 보기 › 모니터 링크.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { stripComments } from '../test/_stripComments.js';
import { VmMetricButton, HostMetricButton } from '../components/VmMetrics.jsx';

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('① vCenter 트리 VM 클릭 = 드로어(가상화 서버와 같은 VmDrawer)', () => {
  it('VCenterDetail 은 VM 을 옛 모달로 열지 않고 드로어를 그린다 · 순서는 treeVmRows · 개체 보기로 가면 드로어를 닫는다', () => {
    const s = read('./VCenterDetail.jsx');
    expect(s).not.toMatch(/setSel\(\{ type: 'vm'/);
    expect(s).toMatch(/import VmDrawer from '\.\/vms\/VmDrawer\.jsx'/);
    expect(s).toMatch(/treeVmRows\(\{ view, query, matches, cap: SEARCH_CAP, clusters, vmsByHost, folderTree \}\)/);
    expect(s).toMatch(/<VmDrawer vm=\{vmDrawer\} rows=\{treeRows\}/);
    expect(s).toMatch(/if \(r\.obj\) setVmDrawer\(null\)/);
    expect(s).toMatch(/setSel\(\{ type: 'host'/);        // 호스트 · 데이터스토어 모달은 그대로(범위 밖)
    expect(s).toMatch(/setSel\(\{ type: 'datastore'/);
  });
});

describe('② 성능 — 모달 대신 개체 보기 › 모니터 첫 섹션', () => {
  it('VmMetrics.jsx 에 모달 · recharts 가 없고 두 단추는 모니터 탭 링크 · vcenterId 를 모르면 그리지 않는다', () => {
    const s = read('../components/VmMetrics.jsx');
    expect(s).not.toMatch(/MetricModal|recharts|modal-overlay|datetime-local/);
    const a = renderToStaticMarkup(React.createElement(VmMetricButton, { vmId: 'vc-us-east:vm-7', vmName: 'app-1', vcenterId: 'vc-us-east' }));
    expect(a).toContain('href="#/vcenters/vc-us-east/vm/vc-us-east%3Avm-7/monitor"');
    expect(a).toContain('성능 그래프 보기');
    const h = renderToStaticMarkup(React.createElement(HostMetricButton, { hostId: 'vc-a:host-1', hostName: 'esx1', vcenterId: 'vc-a' }));
    expect(h).toContain('href="#/vcenters/vc-a/host/vc-a%3Ahost-1/monitor"');
    expect(renderToStaticMarkup(React.createElement(VmMetricButton, { vmId: 'vc-a:vm-1', vmName: 'x' }))).toBe('');
  });
  it('호출처 7곳이 vcenterId 를 넘긴다(드로어 · 옛 모달은 닫기까지) · 모니터 탭은 VmPerfView 를 첫 섹션으로', () => {
    const ed = read('../components/EntityDetail.jsx');
    // v2.926: EntityDetail 의 VM 가지는 드로어로 위임한다(VM 단추는 드로어 안) — 호스트 단추는 그대로.
    expect(ed).toMatch(/if \(type === 'vm'\) return <Lazy><VmDrawer vm=\{item\} rows=\{\[\]\}/);
    expect(ed).not.toMatch(/<VmMetricButton/);
    expect(ed).toMatch(/<HostMetricButton hostId=\{item\.id\} hostName=\{item\.name\} vcenterId=\{item\.vcenterId\} onBefore=\{onClose\} \/>/);
    expect(read('./vms/VmDrawer.jsx')).toMatch(/<VmMetricButton vmId=\{vm\.id\} vmName=\{vm\.name\} vcenterId=\{vm\.vcenterId\} onBefore=\{onClose\} \/>/);
    expect(read('./HostDetail.jsx')).toMatch(/<HostMetricButton hostId=\{h\.id\} hostName=\{h\.name\} vcenterId=\{h\.vcenterId\} \/>/);
    const vo = read('./vcd/VmObject.jsx');
    expect(vo).toMatch(/<VmMetricButton vmId=\{vm\.id\} vmName=\{vm\.name\} vcenterId=\{vm\.vcenterId\} \/>/);
    expect(vo).toMatch(/<VmPerfView entityType="vm" id=\{vm\.id\} name=\{vm\.name\} vcenterId=\{vm\.vcenterId\} powered=\{powered\} \/>/);   // v2.926 vcenterId(엣지 포탈 링크)
    expect((vo.match(/VmMetricButton vmId=/g) || []).length).toBe(1);   // 모니터 탭의 '성능' 카드(버튼만 있던 것)는 사라졌다
    const ho = read('./vcd/HostObject.jsx');
    expect(ho).toMatch(/<HostMetricButton hostId=\{host\.id\} hostName=\{host\.name\} vcenterId=\{host\.vcenterId\} \/>/);
    expect(ho).toMatch(/<VmPerfView entityType="host" id=\{host\.id\} name=\{host\.name\}/);
    expect((ho.match(/HostMetricButton hostId=/g) || []).length).toBe(1);
  });
  it('드로어 · 개체 보기 요약의 24시간 스파크는 types=cpu,mem 한 번(로그인 1회)', () => {
    const s = read('./vms/vmSeries.jsx');
    expect(s).toMatch(/types: 'cpu,mem'/);
    expect(s).not.toMatch(/for \(const type of \['cpu', 'mem'\]\)/);
  });
  it('VmPerfView — 주기 · 기준 · 보관 숫자를 화면에 박지 않는다(응답 값) · 문구에 백틱 없음 · 결측 판정은 numOrNull', () => {
    const s = read('../components/vmperf/VmPerfView.jsx');
    expect(s).toMatch(/data\?\.overloadPct/);
    expect(s).toMatch(/data\?\.retention/);
    expect(s).toMatch(/refreshSec/);
    expect(s).toMatch(/numOrNull/);
    expect(s).not.toMatch(/90%/);   // 과부하 기준 숫자는 응답에서
    for (const m of s.matchAll(/<BoldText text=\{([^}]+)\}/g)) expect(m[1]).not.toMatch(/`[^`]*`[^`]*`/);
  });
});
