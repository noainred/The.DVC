// v2.600 감사 그룹 f — 포탈 점검·지도·로그 분석(WEB2600-02·04·05·06). 웹 문구는 vitest 가 따로 고정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanInventory, findingsOf, INV_FINDING } from '../src/portalcheck/invScan.js';
import { buildDataFlow, UNAUTH_EDGE_ID } from '../src/dataflow/build.js';
import { buildDeviceFlow } from '../src/devflow/build.js';
import { buildCommMap } from '../src/commmap/build.js';
import { PULL_UNAUTH_KEY } from '../src/central/pullStats.js';

// 기준 시각은 경계에서 떨어뜨려 고정(CLAUDE.md v2.517 규약 — Date.now() 를 쓰지 않는다)
const NOW = Date.UTC(2026, 8, 24, 2, 30, 0);

test('WEB2600-02 전부 거부된 엣지도 엣지 표에 나온다(이름 미검증) · 인증 실패 칸은 행이 아니다', () => {
  const scan = scanInventory({
    now: NOW,
    vcenters: [{ id: 'vc-a', name: 'VC-A', collectMode: 'site' }],
    inventory: [{ vcenterId: 'vc-a', agent: 'edge-ok', at: NOW - 30_000, hosts: 3, vms: 10 }],
    ingestRows: [{ agent: 'edge-ok', pushes: 5, wireBytes: 100, lastAt: NOW - 30_000, last: { endpoint: '/inventory', vcenterId: 'vc-a', hosts: 3, vms: 10 } }],
    rejects: {
      rows: [
        { agent: 'edge-seoul', total: 4, lastAt: NOW - 5_000, lastKind: 'bad-request', lastReason: 'vcenterId 없음', byEndpoint: { '/inventory': 4 } },
        { agent: PULL_UNAUTH_KEY, total: 7, lastAt: NOW - 1_000, lastKind: 'auth', byEndpoint: { '/inventory': 7 } },
      ],
      recent: [],
    },
  });
  const seoul = scan.agents.find((a) => a.agent === 'edge-seoul');
  assert.ok(seoul, '거부만 있는 엣지가 빠지면 이 표가 가장 보여줘야 할 엣지를 숨긴다');
  assert.equal(seoul.rejectedOnly, true);
  assert.equal(seoul.verified, false);
  assert.equal(seoul.sentInventory, false);
  assert.equal(seoul.rejectedInventory, true);
  assert.equal(seoul.rejects.total, 4);
  assert.equal(scan.agents[0].agent, 'edge-seoul', '전부 거부된 엣지가 맨 위');
  assert.ok(!scan.agents.some((a) => a.agent === PULL_UNAUTH_KEY), '인증 실패 칸을 엣지 행으로 만들지 않는다');
  assert.equal(scan.unauthRejects, 7);
  const f = findingsOf(scan).find((x) => x.code === INV_FINDING.AGENT_REJECTED_ONLY);
  assert.ok(f); assert.equal(f.target, 'edge-seoul'); assert.equal(f.facts.unverified, true);
  // 이미 수신 기록이 있는 엣지는 거부가 있어도 행이 하나다(중복 행 금지)
  assert.equal(scan.agents.filter((a) => a.agent.toLowerCase() === 'edge-ok').length, 1);
});

test('WEB2600-05 등록부에 없는 vCenter 로 저장된 인벤토리를 밝힌다', () => {
  const scan = scanInventory({
    now: NOW,
    vcenters: [{ id: 'vc-a', collectMode: 'site' }, { id: 'vc-d', collectMode: 'direct' }],
    inventory: [
      { vcenterId: 'vc-a', agent: 'e1', at: NOW - 1000, hosts: 1, vms: 1 },
      { vcenterId: 'vc-d', agent: 'e1', at: NOW - 1000 },           // 등록돼 있으면(수집 방식 무관) 고아가 아니다
      { vcenterId: 'vc-ghost', agent: 'e2', at: NOW - 2000, hosts: 2, vms: 9 },
    ],
  });
  assert.deepEqual(scan.orphans.map((o) => o.vcenterId), ['vc-ghost']);
  assert.equal(scan.orphans[0].agent, 'e2');
  const f = findingsOf(scan).filter((x) => x.code === INV_FINDING.UNREGISTERED_VCENTER);
  assert.equal(f.length, 1); assert.equal(f[0].target, 'vc-ghost'); assert.equal(f[0].grade, 'warn');
});

test('WEB2600-02·05 서버 발견 코드는 웹 문구 표에 전부 있다(1:1)', async () => {
  const { findingCodesDeclared } = await import('../../web/src/views/tools/invCheckText.js');
  const declared = new Set(findingCodesDeclared());
  for (const c of Object.values(INV_FINDING)) assert.ok(declared.has(c), `웹 문구 없음: ${c}`);
});

const ROUTES = [
  { side: 'central', method: 'GET', path: '/storage-config' },
  { side: 'central', method: 'POST', path: '/inventory' },
];

test('WEB2600-04 인증 실패 집계 칸은 엣지 노드·선·합계에 들어가지 않고 unauth 로 밝힌다', () => {
  const f = buildDataFlow({
    now: NOW, routes: ROUTES,
    collectors: [{ id: 'gm1', url: 'https://10.0.0.1:3000' }],
    pulls: { rows: [
      { agent: 'gm1', verified: true, byEndpoint: [{ endpoint: '/storage-config', count: 3, lastOkAt: NOW - 1000, intervalMs: 60_000 }] },
      { agent: PULL_UNAUTH_KEY, verified: false, byEndpoint: [{ endpoint: '/storage-config', count: 0, failCount: 5, lastFailAt: NOW - 500, lastStatus: 403 }] },
    ] },
    rejects: { rows: [{ agent: PULL_UNAUTH_KEY, total: 2 }], recent: [
      { at: NOW - 400, agent: PULL_UNAUTH_KEY, endpoint: '/inventory', kind: 'auth', reason: '토큰 불일치' },
      { at: NOW - 300, agent: PULL_UNAUTH_KEY, endpoint: '/inventory', kind: 'auth', reason: '토큰 불일치' },
    ] },
  });
  assert.deepEqual(f.edges.map((e) => e.id), ['gm1'], '인증 실패 칸이 등록부 밖 엣지로 그려지면 안 된다');
  assert.ok(!f.links.some((l) => l.edge === UNAUTH_EDGE_ID));
  assert.equal(f.routes.find((r) => r.path === '/storage-config').state, 'ok', '실제 엣지의 경로가 거짓 실패로 칠해지지 않는다');
  assert.equal(f.totals.fail, 0);
  assert.ok(f.unauth);
  assert.equal(f.unauth.count, 7);
  assert.equal(f.unauth.reason, 'unauth-bucket');
  assert.equal(f.unauth.lastAt, NOW - 300);
  assert.equal(f.rejectsWithoutTime, 0);
  // 인증 실패가 없으면 null
  assert.equal(buildDataFlow({ now: NOW, routes: ROUTES }).unauth, null);

  // 3단 지도 — 엣지 합계에 들어가지 않고 unauth 를 그대로 싣는다
  const comm = buildCommMap({ now: NOW, collectors: [{ id: 'gm1', name: 'GM1', url: 'https://10.0.0.1:3000', enabled: true }],
    status: { gm1: { ok: true, at: NOW - 60_000 } }, resMax: Infinity, directMax: Infinity });
  const d = buildDeviceFlow({ now: NOW, comm, flow: f });
  assert.equal(d.totals.edges, 1);
  assert.ok(!d.edges.some((e) => e.name === PULL_UNAUTH_KEY));
  assert.equal(d.unauth.count, 7);
});

test('WEB2600-06 Node ExperimentalWarning 은 정보(info)로 분류되고 미분류로 올라가지 않는다', async () => {
  const IDX = await import('../src/loganalysis/index.js');
  const E = await import('../src/loganalysis/engine.js');
  const rules = IDX.activeRules();
  const idx = E.indexRules(rules);
  const st = E.newState();
  const msg = '(node:2372) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)';
  E.addItem(st, { msg, level: 'error' }, idx);
  assert.ok(st.rules['node-experimental-warning'], `규칙에 걸려야 한다: ${Object.keys(st.rules)}`);
  const rep = E.buildReport(st, rules);
  assert.ok(!rep.findings.some((x) => x.kind === 'unclassified'), '미분류(medium)로 올라가면 안 된다');
  const hit = rep.findings.find((x) => x.id === 'node-experimental-warning');
  assert.equal(hit.severity, 'info');
  assert.deepEqual(hit.entities.map((e) => e.name), ['SQLite']);
});
