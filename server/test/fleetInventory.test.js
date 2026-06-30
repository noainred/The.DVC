import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFleet } from '../src/insights/fleetInventory.js';

// vCenter ESXi 호스트 2대(서비스태그 보유), vCenter 1개.
const hosts = [
  { name: 'esxi-01', vcenterId: 'vc-kr', serviceTag: 'AAA111', model: 'PowerEdge R750', cpuCores: 64, memTotalMB: 524288, connectionState: 'CONNECTED', powerWatts: 420 },
  { name: 'esxi-02', vcenterId: 'vc-kr', serviceTag: 'BBB222', model: 'PowerEdge R750', cpuCores: 64, memTotalMB: 524288, connectionState: 'CONNECTED' },
];
const vcenters = [{ id: 'vc-kr', name: '한국 본사', location: { region: 'KR' } }];

test('가상화 호스트: iDRAC 서버가 서비스태그로 호스트에 매칭되면 idracBacked', () => {
  const servers = [
    // esxi-01을 받치는 iDRAC(서비스태그 일치) → 가상화 호스트, 베어메탈 아님
    { serverId: 'idrac-1', serverName: 'idrac-esxi-01', serviceTag: 'AAA111', host: '10.0.0.1', hostNames: ['aaa111'], model: 'R750', watts: 410, source: 'idrac' },
  ];
  const { virtualizationHosts, bareMetal, summary } = classifyFleet({ hosts, vcenters, servers });
  assert.equal(virtualizationHosts.length, 2);
  assert.equal(bareMetal.length, 0);
  const h1 = virtualizationHosts.find((h) => h.name === 'esxi-01');
  assert.equal(h1.idracBacked, true);
  assert.equal(h1.watts, 410);          // iDRAC 측정값 우선
  assert.equal(h1.vcenter, '한국 본사');
  const h2 = virtualizationHosts.find((h) => h.name === 'esxi-02');
  assert.equal(h2.idracBacked, false);
  assert.equal(h2.watts, null);         // 측정 없음
  assert.equal(summary.idracBackedHosts, 1);
});

test('베어메탈: 어느 호스트에도 매칭 안 되는 iDRAC 서버 + 전력 합산', () => {
  const servers = [
    { serverId: 'idrac-1', serverName: 'idrac-esxi-01', serviceTag: 'AAA111', host: '10.0.0.1', hostNames: ['aaa111'], model: 'R750', watts: 410, source: 'idrac' },
    // vCenter 어디에도 없는 물리 서버 2대
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: 300, source: 'idrac' },
    { serverId: 'bm-2', serverName: 'db-bare-02', serviceTag: 'ZZZ901', host: '10.0.9.2', hostNames: ['zzz901'], model: 'R760', watts: 250, source: 'ome' },
  ];
  const { bareMetal, summary } = classifyFleet({ hosts, vcenters, servers });
  assert.equal(bareMetal.length, 2);
  assert.deepEqual(bareMetal.map((b) => b.name), ['db-bare-01', 'db-bare-02']); // watts 내림차순
  assert.equal(summary.bareMetal, 2);
  assert.equal(summary.bareMetalMeasured, 2);
  assert.equal(summary.bareMetalWatts, 550);
  assert.equal(summary.bareMetalKw, 0.6); // round(550/100)/10 = 0.6
});

test('vCenter 원본 전력 행(source=vcenter)은 베어메탈로 잡지 않는다', () => {
  const servers = [
    { serverId: 'vc:vc-kr:esxi-02', serverName: 'esxi-02', serviceTag: 'BBB222', host: 'esxi-02', hostNames: ['esxi-02', 'bbb222'], model: 'R750', watts: 380, source: 'vcenter', vcenterId: 'vc-kr' },
  ];
  const { bareMetal, virtualizationHosts } = classifyFleet({ hosts, vcenters, servers });
  assert.equal(bareMetal.length, 0);
  const h2 = virtualizationHosts.find((h) => h.name === 'esxi-02');
  assert.equal(h2.watts, 380); // vCenter 전력이 호스트에 붙음
});

test('수동 예외: baremetal 태그는 매칭돼도 베어메탈로 강제', () => {
  const servers = [
    { serverId: 'idrac-1', serverName: 'idrac-esxi-01', serviceTag: 'AAA111', host: '10.0.0.1', hostNames: ['aaa111'], model: 'R750', watts: 410, source: 'idrac' },
  ];
  const tags = { aaa111: 'baremetal' }; // 서비스태그(소문자) 키 — 물리 1대(iDRAC+호스트)를 함께 가리킴
  const { bareMetal, virtualizationHosts, summary } = classifyFleet({ hosts, vcenters, servers, tags });
  assert.equal(bareMetal.length, 1);
  assert.equal(bareMetal[0].forced, true);
  assert.equal(bareMetal[0].serviceTag, 'AAA111');
  assert.equal(summary.forcedBareMetal, 1);
  // 동일 물리 박스이므로 esxi-01은 가상화 호스트 목록에서 빠지고 베어메탈로 이동(esxi-02만 남음).
  assert.equal(virtualizationHosts.length, 1);
  assert.equal(virtualizationHosts[0].name, 'esxi-02');
});

test('수동 예외: virtualization 강제 + 무매칭 서버는 합성 가상화 호스트로 보존(증발 금지)', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: 300, source: 'idrac' },
  ];
  const tags = { zzz900: 'virtualization' };
  const { bareMetal, virtualizationHosts, summary } = classifyFleet({ hosts, vcenters, servers, tags });
  assert.equal(bareMetal.length, 0);            // 베어메탈 아님
  // 사라지지 않고 가상화 호스트 목록에 합성 행으로 등장 + watts 보존
  const syn = virtualizationHosts.find((h) => h.name === 'db-bare-01');
  assert.ok(syn, '합성 가상화 행이 존재해야 함');
  assert.equal(syn.synthetic, true);
  assert.equal(syn.watts, 300);
  assert.equal(summary.syntheticVirt, 1);
});

test('수동 예외: exclude 태그는 인벤토리/전력에서 완전히 제외', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: 300, source: 'idrac' },
    { serverId: 'bm-2', serverName: 'db-bare-02', serviceTag: 'ZZZ901', host: '10.0.9.2', hostNames: ['zzz901'], model: 'R760', watts: 250, source: 'idrac' },
  ];
  const tags = { zzz900: 'exclude' };
  const { bareMetal, summary } = classifyFleet({ hosts, vcenters, servers, tags });
  assert.equal(bareMetal.length, 1);
  assert.equal(bareMetal[0].name, 'db-bare-02');
  assert.equal(summary.bareMetalWatts, 250);
  assert.equal(summary.excluded, 1);
});

test('전력 미보고 베어메탈(watts=null)도 목록에는 포함, 합산엔 미반영', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: null, source: 'idrac' },
  ];
  const { bareMetal, summary } = classifyFleet({ hosts, vcenters, servers });
  assert.equal(bareMetal.length, 1);
  assert.equal(bareMetal[0].watts, null);
  assert.equal(summary.bareMetalMeasured, 0);
  assert.equal(summary.bareMetalWatts, 0);
});

test('법인 등록(assign): 베어메탈에 소속 법인이 붙고 법인별로 집계', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: 300, source: 'idrac' },
    { serverId: 'bm-2', serverName: 'db-bare-02', serviceTag: 'ZZZ901', host: '10.0.9.2', hostNames: ['zzz901'], model: 'R760', watts: 200, source: 'ome' },
  ];
  const assign = { zzz900: 'vc-kr' }; // 서비스태그(소문자) → 법인
  const { bareMetal, byVcenter, summary } = classifyFleet({ hosts, vcenters, servers, assign });
  const b1 = bareMetal.find((b) => b.name === 'db-bare-01');
  assert.equal(b1.vcenterId, 'vc-kr');
  assert.equal(b1.vcenter, '한국 본사');
  assert.equal(b1.region, 'KR');
  assert.equal(summary.bareMetalAssigned, 1);
  // 법인별 집계: vc-kr 1대(300W) + 미지정 1대(200W)
  const kr = byVcenter.find((g) => g.vcenterId === 'vc-kr');
  assert.equal(kr.servers, 1);
  assert.equal(kr.watts, 300);
  const none = byVcenter.find((g) => g.vcenterId === '');
  assert.equal(none.name, '(미지정)');
  assert.equal(none.servers, 1);
});

test('법인 등록: 레지스트리 vcenterId(서버가 들고 온 값)가 fallback으로 적용', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: 300, source: 'idrac', vcenterId: 'vc-kr' },
  ];
  const { bareMetal } = classifyFleet({ hosts, vcenters, servers }); // assign 없음
  assert.equal(bareMetal[0].vcenterId, 'vc-kr'); // 서버가 들고 온 vcenterId 사용
  // 빈 문자열 매핑은 falsy → fallback(vc-kr) 유지
  const r2 = classifyFleet({ hosts, vcenters, servers, assign: { 'bm-1': '' } });
  assert.equal(r2.bareMetal[0].vcenterId, 'vc-kr');
});

const vcenters2 = [{ id: 'vc-kr', name: '한국 본사', location: { region: 'KR' } }, { id: 'vc-eu', name: '유럽', location: { region: 'EU' } }];

test('[classification-2] 이름매칭(서비스태그 불일치) 호스트를 서버 태그로 베어메탈 강제 → 중복 없음', () => {
  const hostsL = [{ name: 'esxi-09', vcenterId: 'vc-kr', serviceTag: 'HHH999', model: 'R750', powerWatts: 420, cpuCores: 32, memTotalMB: 262144 }];
  const servers = [
    // idrac-9는 서비스태그(SSS888)는 다르지만 호스트명(esxi-09)으로 esxi-09를 받침
    { serverId: 'idrac-9', serverName: 'idrac-09', serviceTag: 'SSS888', host: '10.0.0.9', hostNames: ['esxi-09'], model: 'R750', watts: 300, source: 'idrac' },
  ];
  const tags = { sss888: 'baremetal' }; // 서버의 서비스태그로 강제
  const { bareMetal, virtualizationHosts } = classifyFleet({ hosts: hostsL, vcenters, servers, tags });
  assert.equal(bareMetal.length, 1);
  assert.equal(bareMetal[0].name, 'idrac-09');
  // 같은 물리 박스가 가상화 호스트에 또 나타나면 안 됨(중복 방지) → esxi-09 제외
  assert.equal(virtualizationHosts.find((h) => h.name === 'esxi-09'), undefined);
  assert.equal(virtualizationHosts.length, 0);
});

test('[classification-3] 호스트 베어메탈 강제 시 받침 iDRAC 실측 전력을 사용(버리지 않음)', () => {
  const hostsL = [{ name: 'esxi-09', vcenterId: 'vc-kr', serviceTag: 'HHH999', model: 'R750', powerWatts: 420 }];
  const servers = [
    { serverId: 'idrac-9', serverName: 'idrac-09', serviceTag: 'SSS888', host: '10.0.0.9', hostNames: ['esxi-09'], model: 'R750', watts: 300, source: 'idrac' },
  ];
  const tags = { hhh999: 'baremetal' }; // 호스트의 서비스태그로 강제 → 호스트-강제 분기
  const { bareMetal } = classifyFleet({ hosts: hostsL, vcenters, servers, tags });
  assert.equal(bareMetal.length, 1);
  assert.equal(bareMetal[0].watts, 300); // vCenter 420이 아니라 iDRAC 실측 300
});

test('[power-aggregation-1] byVcenter 합 == summary.bareMetalWatts(0/측정누락 포함 일치)', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'b1', serviceTag: 'Z1', hostNames: ['z1'], watts: 300, source: 'idrac' },
    { serverId: 'bm-2', serverName: 'b2', serviceTag: 'Z2', hostNames: ['z2'], watts: 0, source: 'idrac' },   // 0W = 미측정
    { serverId: 'bm-3', serverName: 'b3', serviceTag: 'Z3', hostNames: ['z3'], watts: 200, source: 'ome' },
  ];
  const assign = { z1: 'vc-kr', z3: 'vc-eu' };
  const { byVcenter, summary } = classifyFleet({ hosts: [], vcenters: vcenters2, servers, assign });
  const sumByVc = byVcenter.reduce((a, g) => a + g.watts, 0);
  assert.equal(sumByVc, summary.bareMetalWatts);
  assert.equal(summary.bareMetalWatts, 500); // 300 + 200 (0W 제외)
});

test('[power-aggregation-2] 받침 iDRAC가 0W면 유효한 vCenter 전력을 0으로 덮어쓰지 않음', () => {
  const hostsL = [{ name: 'esxi-01', vcenterId: 'vc-kr', serviceTag: 'AAA111', powerWatts: 420 }];
  const servers = [
    { serverId: 'idrac-1', serverName: 'i1', serviceTag: 'AAA111', hostNames: ['aaa111'], watts: 0, source: 'idrac' },
  ];
  const { virtualizationHosts } = classifyFleet({ hosts: hostsL, vcenters, servers });
  const h1 = virtualizationHosts.find((h) => h.name === 'esxi-01');
  assert.equal(h1.watts, 420); // iDRAC 0W가 아니라 vCenter 420
  assert.equal(h1.idracBacked, true);
});

test('[data-consistency-1] iDRAC 레지스트리 vcenterId가 stale assign보다 우선(split-brain 방지)', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'b1', serviceTag: 'Z9', hostNames: ['z9'], watts: 100, source: 'idrac', vcenterId: 'vc-kr' },
  ];
  const assign = { z9: 'vc-eu' }; // 과거에 남은 stale 귀속
  const { bareMetal } = classifyFleet({ hosts: [], vcenters: vcenters2, servers, assign });
  assert.equal(bareMetal[0].vcenterId, 'vc-kr'); // 레지스트리(권위)가 이김
});

test('[data-consistency-5] 삭제된/유령 vCenter로의 귀속은 미지정 처리', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'b1', serviceTag: 'Z9', hostNames: ['z9'], watts: 100, source: 'ome' },
  ];
  const assign = { z9: 'ghost-vc' }; // vcenters에 없는 id
  const { bareMetal, byVcenter } = classifyFleet({ hosts: [], vcenters: vcenters2, servers, assign });
  assert.equal(bareMetal[0].vcenterId, ''); // 유령 → 미지정
  assert.equal(byVcenter.find((g) => g.vcenterId === 'ghost-vc'), undefined);
});

test('[자동추론] OME 상속(vcInferred) 베어메탈은 vcSource=inferred, 수동 assign이 우선', () => {
  const servers = [
    { serverId: 'ome:c1:Z9', serverName: 'ome-b1', serviceTag: 'Z9', hostNames: ['z9'], watts: 100, source: 'ome', vcenterId: 'vc-eu', vcInferred: true },
    { serverId: 'ome:c1:Z8', serverName: 'ome-b2', serviceTag: 'Z8', hostNames: ['z8'], watts: 50, source: 'ome', vcenterId: 'vc-eu', vcInferred: true },
  ];
  const assign = { z8: 'vc-kr' }; // 수동 등록은 추론보다 우선
  const { bareMetal, summary } = classifyFleet({ hosts: [], vcenters: vcenters2, servers, assign });
  const b1 = bareMetal.find((b) => b.name === 'ome-b1');
  assert.equal(b1.vcenterId, 'vc-eu');
  assert.equal(b1.vcSource, 'inferred');
  const b2 = bareMetal.find((b) => b.name === 'ome-b2');
  assert.equal(b2.vcenterId, 'vc-kr');     // 수동 우선
  assert.equal(b2.vcSource, 'assigned');
  assert.equal(summary.bareMetalInferred, 1);
});

test('[엣지집계] source=edge 베어메탈은 remoteAgent + vcSource=edge, 서비스태그로 중앙과 dedup', () => {
  const servers = [
    { serverId: 'remote:c1:X1', serverName: 'central-x1', serviceTag: 'X1', hostNames: ['x1'], watts: 100, source: 'remote', vcenterId: 'vc-kr' }, // 중앙(원격) 먼저
    { serverId: 'edge:dc-pl:X1', serverName: 'edge-x1', serviceTag: 'X1', hostNames: ['x1'], watts: null, source: 'edge', remoteAgent: 'dc-pl', vcenterId: 'vc-eu' }, // 같은 태그 → dedup
    { serverId: 'edge:dc-pl:E2', serverName: 'edge-e2', serviceTag: 'E2', hostNames: ['e2'], watts: null, source: 'edge', remoteAgent: 'dc-pl', vcenterId: 'vc-eu' },
  ];
  const { bareMetal } = classifyFleet({ hosts: [], vcenters: vcenters2, servers });
  assert.equal(bareMetal.length, 2); // X1 중복 제거(중앙 우선)
  const x1 = bareMetal.find((b) => b.serviceTag === 'X1');
  assert.equal(x1.source, 'remote');
  const e2 = bareMetal.find((b) => b.serviceTag === 'E2');
  assert.equal(e2.remoteAgent, 'dc-pl');
  assert.equal(e2.vcSource, 'edge');
  assert.equal(e2.vcenterId, 'vc-eu');
});

test('[엣지격리] 엣지 베어메탈 name이 타 DC ESXi 호스트명과 충돌해도 베어메탈 유지(silent loss 방지)', () => {
  const hostsL = [{ name: 'esxi-prod-01', vcenterId: 'vc-kr', serviceTag: 'KRHOST1', powerWatts: 400 }];
  const servers = [
    { serverId: 'edge:dc-pl:ABC123', serverName: 'esxi-prod-01', serviceTag: 'ABC123', hostNames: ['abc123', 'esxi-prod-01'], watts: 250, source: 'edge', remoteAgent: 'dc-pl', vcenterId: 'vc-eu' },
  ];
  const { bareMetal, virtualizationHosts } = classifyFleet({ hosts: hostsL, vcenters: vcenters2, servers });
  const bm = bareMetal.find((b) => b.serviceTag === 'ABC123');
  assert.ok(bm, '엣지 베어메탈이 유지되어야 함(이름 충돌 무시)');
  assert.equal(bm.remoteAgent, 'dc-pl');
  // 중앙 호스트가 엣지 서버에 받쳐지지 않음(전력/idracBacked 오염 없음)
  const h = virtualizationHosts.find((x) => x.name === 'esxi-prod-01');
  assert.equal(h.idracBacked, false);
  assert.equal(h.watts, 400); // 엣지 250W로 오염되지 않고 호스트 자체 400W 유지
});

test('[엣지격리2] 엣지 force-baremetal이 타 DC 동명 가상화 호스트를 억제하지 않음', () => {
  const hostsL = [{ name: 'esxi-01', vcenterId: 'vc-kr', serviceTag: 'KRTAG', powerWatts: 300 }];
  const servers = [
    { serverId: 'edge:dc-pl:esxi-01', serverName: 'esxi-01', serviceTag: '', host: 'esxi-01', hostNames: ['esxi-01'], watts: null, source: 'edge', remoteAgent: 'dc-pl', vcenterId: 'vc-eu' },
  ];
  const tags = { 'edge:dc-pl:esxi-01': 'baremetal' }; // 관리자가 엣지 행을 강제 baremetal
  const { virtualizationHosts, bareMetal } = classifyFleet({ hosts: hostsL, vcenters: vcenters2, servers, tags });
  // 한국 esxi-01 호스트는 가상화 목록에 그대로 남아야 함(엣지 이름이 억제하면 안 됨)
  assert.ok(virtualizationHosts.find((h) => h.name === 'esxi-01'), '동명 호스트가 유지되어야 함');
  assert.equal(virtualizationHosts.length, 1);
  assert.ok(bareMetal.find((b) => b.serverId === 'edge:dc-pl:esxi-01'));
});

test('[필터] 엣지 미인식 vCenter가 vcenters 목록에 노출되어 필터 가능', () => {
  const servers = [
    { serverId: 'edge:dc-x:E1', serverName: 'e1', serviceTag: 'E1', hostNames: ['e1'], watts: null, source: 'edge', remoteAgent: 'dc-x', vcenterId: 'vc-ghost' },
  ];
  const { vcenters: vcList } = classifyFleet({ hosts: [], vcenters: vcenters2, servers });
  assert.ok(vcList.find((v) => v.id === 'vc-ghost' && v.external), '미인식 vCenter가 필터 목록에 추가되어야 함');
});

test('[엣지소속] 엣지가 보고한 미인식 vCenter는 미지정 강등 없이 출처 보존', () => {
  const servers = [
    { serverId: 'edge:dc-x:E9', serverName: 'e9', serviceTag: 'E9', hostNames: ['e9'], watts: null, source: 'edge', remoteAgent: 'dc-x', vcenterId: 'vc-unknown' },
  ];
  const { bareMetal } = classifyFleet({ hosts: [], vcenters: vcenters2, servers });
  assert.equal(bareMetal[0].vcenterId, 'vc-unknown'); // knownVc 우회로 보존
  assert.equal(bareMetal[0].vcSource, 'edge');
});

test('[유령키] tags/assign에 매칭 안 되는 키는 ghostKeys로 집계, excluded는 live만', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'b1', serviceTag: 'Z1', hostNames: ['z1'], watts: 100, source: 'idrac' },
  ];
  const tags = { z1: 'exclude', deadtag: 'exclude' }; // deadtag는 어느 서버에도 없음
  const assign = { z1: 'vc-kr', deadassign: 'vc-eu' };
  const { summary, liveKeys } = classifyFleet({ hosts: [], vcenters: vcenters2, servers, tags, assign });
  assert.equal(summary.excluded, 1);   // z1만 live 제외(deadtag 제외)
  assert.equal(summary.ghostKeys, 2);  // deadtag + deadassign
  assert.ok(liveKeys.includes('z1'));
  assert.ok(!liveKeys.includes('deadtag'));
});
