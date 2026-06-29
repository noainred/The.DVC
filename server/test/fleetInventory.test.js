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

test('수동 예외: virtualization 태그는 매칭 안 돼도 베어메탈에서 제외', () => {
  const servers = [
    { serverId: 'bm-1', serverName: 'db-bare-01', serviceTag: 'ZZZ900', host: '10.0.9.1', hostNames: ['zzz900'], model: 'R760', watts: 300, source: 'idrac' },
  ];
  const tags = { zzz900: 'virtualization' };
  const { bareMetal, summary } = classifyFleet({ hosts, vcenters, servers, tags });
  assert.equal(bareMetal.length, 0);
  assert.equal(summary.bareMetalWatts, 0);
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
