// v2.926 — 성능 화면 · 드로어 후속 3건(사용자 선택 A · 표준): ① 옛 VM 모달을 쓰던 5곳 → 드로어 한 벌 ② 엣지 위임 vCenter 의 엣지 포탈 링크 ③ vCenter 상세 key.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { metricErrorState, edgePortalHref } from '../components/vmMetricsText.js';

const read = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('① EntityDetail type=vm → VmDrawer (옛 VM 모달 제거)', () => {
  it('EntityDetail 은 VM 을 드로어로 위임하고(동적 import · rows 없음) 옛 VM 본문(KV · VM 단추)이 없다 · 호스트 · 데이터스토어 모달은 그대로', () => {
    const s = read('../components/EntityDetail.jsx');
    expect(s).toMatch(/const VmDrawer = React\.lazy\(\(\) => import\('\.\.\/views\/vms\/VmDrawer\.jsx'\)\)/);
    expect(s).toMatch(/if \(type === 'vm'\) return <Lazy><VmDrawer vm=\{item\} rows=\{\[\]\} onClose=\{onClose\}/);
    expect(s).not.toMatch(/type === 'vm' && <VmPartitionsSection|<DRow label="vCPU">|RightsizeReport|<VmMetricButton/);
    // v2.975: 호스트 가지도 드로어로 위임됐다(hosts/hostDrawer2975.test.jsx) — 남은 모달은 데이터스토어뿐.
    expect(s).toMatch(/if \(type === 'host'\) return <Lazy><HostDrawer host=\{item\} rows=\{\[\]\}/);
    expect(s).toMatch(/<DsBrowseSection item=\{item\} \/>/);
  });
  it('옛 모달을 쓰던 5곳은 여전히 EntityDetail/VmLink 를 거친다(드로어가 자동으로 적용된다) — 직접 Modal 을 만들지 않는다', () => {
    for (const rel of ['./Alarms.jsx', './Explore.jsx', './VCenters.jsx']) expect(read(rel)).toMatch(/<EntityDetail /);
    expect(read('./HostDetail.jsx')).toMatch(/<VmLink /);
    expect(read('../views/tools/ContentionTool.jsx')).toMatch(/VmLink/);
    expect(read('../components/EntityDetail.jsx')).toMatch(/\{vm && <EntityDetail type="vm" item=\{vm\} onClose/);   // VmLink
  });
});

describe('② 엣지 위임 vCenter — 409 의 edge 를 읽고 엣지 포탈 주소를 만든다', () => {
  it('metricErrorState: edge 는 url 문자열이 있을 때만 · 없으면 null · skipReason 판정은 그대로', () => {
    const mk = (body) => metricErrorState(Object.assign(new Error('x'), { status: 409, body }));
    expect(mk({ skipReason: 'site', reason: 'r', edge: { id: 'e1', name: 'AZ', url: 'http://10.0.0.1:4000' } }).skip).toEqual({ skipReason: 'site', reason: 'r', edge: { id: 'e1', name: 'AZ', url: 'http://10.0.0.1:4000' } });
    expect(mk({ skipReason: 'site', reason: 'r' }).skip.edge).toBe(null);
    expect(mk({ skipReason: 'site', reason: 'r', edge: { id: 'e1' } }).skip.edge).toBe(null);
    expect(mk({ skipReason: 'site', reason: 'r', edge: 'http://x' }).skip.edge).toBe(null);
    expect(mk({ skipReason: 'site', reason: 'r', edge: { url: 'http://x' } }).skip.edge).toEqual({ id: '', name: '', url: 'http://x' });
    expect(mk({ skipReason: 'disabled', reason: 'r' }).skip.skipReason).toBe('disabled');
  });
  it('edgePortalHref: 끝 슬래시를 떼고 해시를 붙인다 · http(s) 가 아니면 null · 긴 슬래시 꼬리도 선형', () => {
    expect(edgePortalHref({ url: 'http://192.0.2.10:4000/' }, '#/vcenters/vc-s/vm/vc-s%3Avm-1/monitor')).toBe('http://192.0.2.10:4000/#/vcenters/vc-s/vm/vc-s%3Avm-1/monitor');
    expect(edgePortalHref({ url: 'https://edge.example' }, '/vcenters/vc-s')).toBe('https://edge.example/#/vcenters/vc-s');
    expect(edgePortalHref({ url: `http://h${'/'.repeat(5000)}` }, '#/x')).toBe('http://h/#/x');
    expect(edgePortalHref({ url: 'ftp://h' }, '#/x')).toBe(null);
    expect(edgePortalHref({ url: 'javascript:alert(1)' }, '#/x')).toBe(null);
    expect(edgePortalHref(null, '#/x')).toBe(null);
    expect(edgePortalHref({ url: '' }, '#/x')).toBe(null);
  });
  it('VmPerfView 는 vcenterId 를 받아 엣지 포탈 링크를 새 창으로 연다 · 개체 보기 두 곳이 vcenterId 를 넘긴다', () => {
    const s = read('../components/vmperf/VmPerfView.jsx');
    expect(s).toMatch(/edgePortalHref\(st\.skip\.edge, vcHash\(vcenterId/);
    expect(s).toMatch(/target="_blank" rel="noopener noreferrer"/);
    expect(read('./vcd/VmObject.jsx')).toMatch(/<VmPerfView entityType="vm" id=\{vm\.id\} name=\{vm\.name\} vcenterId=\{vm\.vcenterId\}/);
    expect(read('./vcd/HostObject.jsx')).toMatch(/<VmPerfView entityType="host" id=\{host\.id\} name=\{host\.name\} vcenterId=\{host\.vcenterId\}/);
  });
});

describe('③ vCenter 상세는 vCenter 마다 새로 마운트(key)', () => {
  it('VCenters.jsx — key={openSite.id}', () => {
    expect(read('./VCenters.jsx')).toMatch(/<VCenterDetail key=\{openSite\.id\} site=\{openSite\}/);
  });
});
