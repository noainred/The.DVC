/**
 * v2.959 — 엣지 iDRAC 스캔이 자동 등록한 서버가 중앙 베어메탈 사용률에서 ‘iDRAC 등록 없음’ 으로 보이던 결함(사용자 보고: 1,157대 · 엣지 수집 1대).
 *   원인 3단: ① bmusage/targets.js — 중앙은 remoteAgent 가 없으면 자기 서버로 본다 ② idrac/service.js — 원격 전력(수집 서버 pull) 항목에는 엣지 이름이 없고 collectorId 만 있다
 *   ③ insights/fleetInventory.js — 같은 서버의 엣지 fleet 보고(remoteAgent 있음)는 이미 잡힌 원격 항목과 겹치면 버린다 → 중앙 등록부에서 찾다가 없으니 no-idrac.
 *   고친 판정: 중앙 · 출처 remote · collectorId 있음 · 이 노드에 그 서버 등록(iDRAC · OS · 법인이 맞지 않는 OS 등록) 0 → edge-delegated + 등록부 이름.
 *   수집 서버를 등록부에서 못 찾거나 등록부를 못 읽으면 remote-collector-unknown(이름 추측 0 — ‘엣지 수집’ 에도 ‘iDRAC 등록 없음’ 에도 넣지 않는다).
 *
 * ① 판정(순수) ② 불변식 — 기준판 대상 집합 ⊆ 새 대상 집합(여러 입력 × 설정 조합) ③ 실제 경로(getFleetInventory → poller.currentTargets → 라우트) ·
 * ④ 재현 2건(엣지 스캔 서버 · 중앙 직접 스캔 대조) ⑤ 소비처(공통 태그 판정기 · 누락 점검 · /insights/fleet 내부 필드)
 *
 * 불변식의 ‘기준판’ 은 **collectorId 를 지운 같은 입력**이다 — 새 판정은 collectorId 가 있을 때만 갈리므로(그 밖의 코드는 순서만 바뀐 순수 계산)
 *   지운 입력의 결과가 곧 기준판(0ca493bc) 결과다. 이 동치는 작업 때 기준판 targets.js 를 같은 입력으로 돌려 한 번 대조했다(기록 docs/rules/idrac-server.md v2.959).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmrmt2959-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.CENTRAL_TOKEN = 'test-central-token-2959';   // 중앙 역할 — 엣지 fleet 보고를 합친다
delete process.env.CENTRAL_URL;
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// 기준 시각 — 실제 시각에서 정시 경계로 떨어뜨린다(docs/rules/common.md). 원격 전력 신선도(2시간) 안 · 경계에서 먼 값.
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const T = await import('../src/bmusage/targets.js');
const { resolveTargets, remoteCollectorNameOf } = T;
const VCS = [{ id: 'vcA', name: 'A 법인', status: 'connected' }, { id: 'vcB', name: 'B 법인', status: 'connected' }];
const NAMES = (pairs, readable = true) => ({ readable, names: new Map(pairs) });
const RC = NAMES([['c1', 'edge-pl'], ['c3', '']]);

// ── ① 판정(순수) ─────────────────────────────────────────────────────────────
test('① 원격 출처 · 이 노드 등록 없음 → 엣지 수집(등록부 이름) · 못 읽음 · 없는 id · 이름 없음 → 수집 서버 모름(추측 0)', () => {
  const bm = [
    { serverId: 'remote:c1:7', name: 'bm-oracle-01', serviceTag: 'RMT001', source: 'remote', collectorId: 'c1', vcenterId: 'vcA', remoteAgent: '' },
    { serverId: 'remote:c2:8', name: 'bm-x', serviceTag: 'RMT002', source: 'remote', collectorId: 'c2', vcenterId: 'vcA', remoteAgent: '' },
    { serverId: 'remote:c3:9', name: 'bm-y', serviceTag: 'RMT003', source: 'remote', collectorId: 'c3', vcenterId: 'vcA', remoteAgent: '' },
    { serverId: 'remote:C1:10', name: 'bm-z', serviceTag: 'RMT004', source: 'remote', collectorId: 'C1', vcenterId: '', remoteAgent: '' },
  ];
  const st = { corps: { vcA: true }, idracTelemetry: true, osSsh: true, includeUnassigned: false };
  const r = resolveTargets({ bareMetal: bm, settings: st, isEdge: false, remoteCollectors: RC });
  const by = Object.fromEntries(r.skipped.map((s) => [s.serviceTag, s]));
  assert.equal(r.targets.length, 0);
  assert.deepEqual([by.RMT001.reason, by.RMT001.agent, by.RMT001.vcenterId, by.RMT001.delegatedBy], ['edge-delegated', 'edge-pl', 'vcA', 'collector']);
  assert.deepEqual([by.RMT002.reason, by.RMT002.collectorIssue, by.RMT002.agent], ['remote-collector-unknown', 'not-found', undefined], '없는 id — 이름을 지어내지 않는다');
  assert.deepEqual([by.RMT003.reason, by.RMT003.collectorIssue], ['remote-collector-unknown', 'not-found'], '이름 없는 수집 서버 — 엣지 표에 없는 이름을 대지 않는다');
  // 대소문자만 다른 id(등록부는 id 대소문자 중복을 합친다) · 귀속 없음 · includeUnassigned 꺼짐이어도 엣지 수집(중앙 설정과 무관)
  assert.deepEqual([by.RMT004.reason, by.RMT004.agent, by.RMT004.vcenterId], ['edge-delegated', 'edge-pl', '']);
  for (const rc of [null, NAMES([['c1', 'edge-pl']], false), { readable: true, names: {} }]) {
    const u = resolveTargets({ bareMetal: bm, settings: st, isEdge: false, remoteCollectors: rc });
    assert.ok(u.skipped.every((s) => s.reason === 'remote-collector-unknown' && s.collectorIssue === 'unread' && !s.agent), `등록부 못 읽음(${JSON.stringify(rc)}) — 전부 수집 서버 모름 · 이름 0`);
    assert.ok(!u.skipped.some((s) => s.reason === 'no-idrac' || s.reason === 'edge-delegated'));
  }
  // 엣지 노드 · 단독 엣지 판정은 바뀌지 않는다(엣지는 자기 등록부로 수집 — 이 규칙은 중앙만)
  const e = resolveTargets({ bareMetal: bm, settings: st, isEdge: true, agentName: 'edge-pl', remoteCollectors: RC });
  assert.ok(!e.skipped.some((s) => s.reason === 'remote-collector-unknown' || s.delegatedBy), '엣지 노드에는 원격 위임 판정이 없다');
  assert.deepEqual(remoteCollectorNameOf(RC, ' c1 '), { name: 'edge-pl', issue: '' });
  assert.deepEqual(remoteCollectorNameOf(RC, ''), { name: '', issue: 'not-found' });
});

// ── ② 불변식: 기준판 대상 ⊆ 새 대상 ─────────────────────────────────────────
const REG = [
  { id: 'r-loc', host: 'https://10.1.0.10', username: 'u', password: 'p', serviceTag: 'LOC001', vcenterId: 'vcA' },
  { id: 'r-cen', host: 'https://10.1.0.11', username: 'u', password: 'p', serviceTag: 'RMT010', vcenterId: 'vcA' },   // 같은 서버를 중앙도 등록 — 중앙 수집 유지
  { id: 'r-nocred', host: 'https://10.1.0.12', username: '', password: '', serviceTag: 'RMT011', vcenterId: 'vcA' },
];
const OSREG = [
  { id: 'o1', name: 'os-only-01', host: '10.2.0.1', vcenterId: 'vcA', username: 'u', password: 'p' },             // OS 계정만 있음 — 중앙 수집 유지
  { id: 'o2', name: 'db-foreign', host: '10.2.0.2', vcenterId: 'vcB', username: 'u', password: 'p' },             // 다른 법인 OS 등록 — 이 노드 설정 문제(예전 사유 유지)
  { id: 'o3', name: 'amb-01', host: '10.2.0.3', vcenterId: '', username: 'u', password: 'p' },
  { id: 'o4', name: 'amb-01', host: '10.2.0.4', vcenterId: '', username: 'u', password: 'p' },                    // 같은 이름 다른 주소 — os-ambiguous
];
const BM = [
  { serverId: 'remote:c1:1', name: 'rm-noreg', serviceTag: 'RMT001', source: 'remote', collectorId: 'c1', vcenterId: 'vcA' },
  { serverId: 'remote:c1:2', name: 'rm-cenreg', serviceTag: 'RMT010', source: 'remote', collectorId: 'c1', vcenterId: 'vcA' },
  { serverId: 'remote:c1:3', name: 'rm-nocred', serviceTag: 'RMT011', source: 'remote', collectorId: 'c1', vcenterId: 'vcA' },
  { serverId: 'remote:c1:4', name: 'os-only-01', serviceTag: 'RMT012', source: 'remote', collectorId: 'c1', vcenterId: 'vcA' },
  { serverId: 'remote:c1:5', name: 'db-foreign', serviceTag: 'RMT013', source: 'remote', collectorId: 'c1', vcenterId: 'vcA' },
  { serverId: 'remote:c1:6', name: 'amb-01', serviceTag: 'RMT014', source: 'remote', collectorId: 'c1', vcenterId: 'vcA' },
  { serverId: 'remote:c2:7', name: 'rm-unknown', serviceTag: 'RMT015', source: 'remote', collectorId: 'c2', vcenterId: 'vcA' },
  { serverId: 'remote:c1:8', name: 'rm-unassigned', serviceTag: 'RMT016', source: 'remote', collectorId: 'c1', vcenterId: '' },
  { serverId: 'remote:c1:9', name: 'rm-corpB', serviceTag: 'RMT017', source: 'remote', collectorId: 'c1', vcenterId: 'vcB' },
  { serverId: 'remote:c1:10', name: 'rm-notag', serviceTag: '', source: 'remote', collectorId: 'c1', vcenterId: 'vcA', fleetId: 'remote:c1:10' },
  { serverId: 'r-loc', name: 'loc-01', serviceTag: 'LOC001', source: 'idrac', vcenterId: 'vcA' },
  { serverId: 'edge:edge-x:EDG001', name: 'edge-x-01', serviceTag: 'EDG001', source: 'edge', remoteAgent: 'edge-x', vcenterId: 'vcB' },
  { serverId: 'ome:1:OME001', name: 'ome-01', serviceTag: 'OME001', source: 'ome', vcenterId: 'vcA' },
];
const strip = (list) => list.map(({ collectorId: _c, ...r }) => r);
const keysOf = (r) => new Set(r.targets.map((x) => x.key));
const SETTINGS = [];
for (const corps of [{}, { vcA: true }, { vcA: true, vcB: true }]) {
  for (const includeUnassigned of [false, true]) {
    for (const [idracTelemetry, osSsh] of [[true, true], [true, false], [false, true], [false, false]]) SETTINGS.push({ corps, includeUnassigned, idracTelemetry, osSsh });
  }
}
const RCS = [RC, NAMES([], false), null, NAMES([['c1', 'edge-pl']])];

test('② 불변식 — 기준판 대상 집합 ⊆ 새 대상 집합(중앙 등록 있음 · OS 계정만 · 모르는 수집 서버 · 등록부 손상 · 설정 48조합 × 색인 4종)', () => {
  let delegatedSeen = 0; let unknownSeen = 0; let combos = 0;
  for (const settings of SETTINGS) {
    for (const remoteCollectors of RCS) {
      combos += 1;
      const input = { bareMetal: BM, registry: REG, bmServers: OSREG, vcenters: VCS, settings, isEdge: false, agentName: '' };
      const base = resolveTargets({ ...input, bareMetal: strip(BM) });
      const now = resolveTargets({ ...input, remoteCollectors });
      const nk = keysOf(now);
      for (const k of keysOf(base)) assert.ok(nk.has(k), `기준판 대상 ${k} 가 빠졌다 — ${JSON.stringify(settings)}`);
      // 이 판정은 대상을 늘리지도 않는다(대상에는 이 노드 등록이 필요하다) — 대상 목록이 그대로다.
      assert.deepEqual(now.targets.map((x) => x.key), base.targets.map((x) => x.key));
      // 바뀐 행은 '이 노드 등록이 없는 원격 출처 서버' 뿐이고, 그 밖의 제외 사유는 한 글자도 같다.
      const moved = new Set(now.skipped.filter((s) => s.delegatedBy === 'collector' || s.reason === 'remote-collector-unknown').map((s) => s.serverId));
      for (const id of moved) assert.ok(['remote:c1:1', 'remote:c2:7', 'remote:c1:8', 'remote:c1:9', 'remote:c1:10'].includes(id), `등록이 있는 서버(${id})를 위임으로 옮기면 안 된다`);
      assert.deepEqual(now.skipped.filter((s) => !moved.has(s.serverId)), base.skipped.filter((s) => !moved.has(s.serverId)));
      for (const s of now.skipped.filter((x) => moved.has(x.serverId))) {
        assert.ok(s.reason === 'edge-delegated' ? s.agent === 'edge-pl' : (s.reason === 'remote-collector-unknown' && !s.agent), JSON.stringify(s));
        if (s.reason === 'edge-delegated') delegatedSeen += 1; else unknownSeen += 1;
      }
      // 등록이 있는 원격 서버의 사유는 예전 그대로(no-idrac-cred · os-foreign · os-ambiguous 등 — 이 노드 설정의 문제)
      const cred = now.skipped.find((s) => s.serverId === 'remote:c1:3');
      if (cred) assert.notEqual(cred.reason, 'edge-delegated');
    }
  }
  assert.equal(combos, 96);
  assert.ok(delegatedSeen > 0 && unknownSeen > 0, '두 갈래가 실제로 돌았다');
});

test('② 기준판 대상의 예: 중앙도 등록한 원격 서버 · OS 계정만 있는 원격 서버는 계속 중앙 대상', () => {
  const st = { corps: { vcA: true }, idracTelemetry: true, osSsh: true, includeUnassigned: false };
  const r = resolveTargets({ bareMetal: BM, registry: REG, bmServers: OSREG, vcenters: VCS, settings: st, isEdge: false, remoteCollectors: RC });
  const tk = Object.fromEntries(r.targets.map((x) => [x.key, x.paths]));
  assert.deepEqual(tk.RMT010, ['idrac'], '중앙 iDRAC 등록 — 중앙 수집 유지');
  assert.deepEqual(tk.RMT012, ['os'], 'OS 계정만 — 중앙 수집 유지');
  const sk = Object.fromEntries(r.skipped.map((s) => [s.serverId, s.reason]));
  assert.equal(sk['remote:c1:3'], 'no-idrac-cred');
  assert.equal(sk['remote:c1:5'], 'os-foreign');
  assert.equal(sk['remote:c1:6'], 'os-ambiguous');
  assert.equal(sk['remote:c1:1'], 'edge-delegated');
  assert.equal(sk['remote:c1:9'], 'edge-delegated', '법인 꺼짐이어도 — 중앙은 어차피 수집할 수 없다(그 엣지 일)');
  assert.equal(sk['remote:c2:7'], 'remote-collector-unknown');
});

// ── ③ ④ 실제 경로 ───────────────────────────────────────────────────────────
const USERS = {
  adm: { username: 'adm', role: 'admin', scope: null },
  adma: { username: 'adma', role: 'admin', scope: { vcenters: ['vcA'] } },
  opa: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
  opb: { username: 'opb', role: 'operator', scope: { vcenters: ['vcB'] } },
};
let _srv = null;
async function app() {
  if (!_srv) {
    const express = (await import('express')).default;
    const { api } = await import('../src/routes/api.js');
    const { insightsRouter } = await import('../src/routes/insights.js');
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
    a.use('/api/insights', insightsRouter);
    a.use('/api', api);
    const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
    _srv = { srv, base: `http://127.0.0.1:${srv.address().port}/api` };
  }
  return async (u, p) => { const r = await fetch(`${_srv.base}${p}`, { headers: { 'x-u': u } }); return { status: r.status, body: await r.json() }; };
}
test.after(() => { _srv?.srv.close(); });

let _gen = 0;
async function scene({ collectors = 'ok' } = {}) {
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: `g-${++_gen}`, vcenters: VCS, hosts: [] };
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('collectors.json')) fs.rmSync(path.join(DIR, f), { force: true });
  if (collectors === 'ok') fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'edge-pl', url: 'https://10.9.0.1:3443', enabled: true }] }));
  else if (collectors === 'corrupt') fs.writeFileSync(path.join(DIR, 'collectors.json'), '{"collectors": [ {"id": "c1", "name": "edge-pl"');   // 손상 — 못 읽음
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'fleet-tags.json'), JSON.stringify({ tags: { rmt001: 'baremetal', rmt002: 'baremetal' } }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: true, includeUnassigned: false }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { setEdgeFleet, resetEdgeFleet } = await import('../src/central/fleet.js');
  const { setRemoteHost, clearCollectorHosts } = await import('../src/collector/state.js');
  resetEdgeFleet(); clearCollectorHosts('c1');
  // 사용자 환경 재현: 엣지 edge-pl 이 스캔해 자기 등록부에 넣은 두 서버를 fleet 보고로 올리고, 그중 RMT001 은 그 엣지가 iDRAC 전력을 폴링해 원격 전력으로도 올라온다.
  setEdgeFleet('edge-pl', [
    { serviceTag: 'RMT001', name: 'bm-oracle-01', vcenterId: 'vcA' },
    { serviceTag: 'RMT002', name: 'bm-nopower', vcenterId: 'vcA' },
  ], null);
  setRemoteHost('10.0.0.5', { collectorId: 'c1', serverId: 7, serverName: 'bm-oracle-01', serviceTag: 'RMT001', watts: 310, ts: NOW, vcenterId: 'vcA' });
  const E = await import('../src/central/bmUsageEdgePull.js');
  E._resetForTest();
  // 그 엣지 보관분: 엣지에서 꺼짐(사용자 화면의 '엣지에서 꺼짐 → 중앙에서 켜기')
  E.putEdgeBmUsage('edge-pl', { ok: true, snap: { node: { agent: 'edge-pl', role: 'edge' }, enabled: false, targets: [{ key: 'RMT001', name: 'bm-oracle-01', vcenterId: 'vcA' }] } });
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(null);
  return poller;
}

test('③ ④ 재현 — 엣지 스캔 서버: 실제 getFleetInventory → currentTargets 에서 no-idrac 이 아니라 엣지 수집(edge-pl) · 계정은 가져오지 않는다', async () => {
  const poller = await scene();
  const { getFleetInventory } = await import('../src/insights/fleetInventory.js');
  const { store } = await import('../src/store.js');
  const inv = await getFleetInventory(store.snapshot);
  const rmt1 = inv.bareMetal.find((b) => b.serviceTag === 'RMT001');
  assert.deepEqual([rmt1.source, rmt1.remoteAgent, rmt1.collectorId], ['remote', '', 'c1'], 'remoteAgent 뜻은 그대로 · collectorId 를 덧붙인다');
  assert.equal(Object.keys(inv).includes('remoteCollectors'), false, '이름 색인은 열거되지 않는다(응답에 실리지 않는다)');
  assert.equal(JSON.stringify(inv).includes('remoteCollectors'), false);
  assert.deepEqual([inv.remoteCollectors.readable, inv.remoteCollectors.names.get('c1')], [true, 'edge-pl']);
  const tg = await poller.currentTargets();
  const by = Object.fromEntries(tg.skipped.map((s) => [s.serviceTag, s]));
  assert.deepEqual([by.RMT001.reason, by.RMT001.agent, by.RMT001.vcenterId], ['edge-delegated', 'edge-pl', 'vcA'], '예전: no-idrac');
  assert.deepEqual([by.RMT002.reason, by.RMT002.agent], ['edge-delegated', 'edge-pl'], 'fleet 보고 경로(예전부터 엣지 수집)');
  assert.equal(tg.counts.byReason['no-idrac'], undefined);
  assert.equal(tg.targets.length, 0, '중앙은 접속하지 않는다(대상 0)');
  assert.ok(!JSON.stringify(tg.skipped).match(/password|username/), '계정 필드 없음');
});

test('④ 대조 — 중앙이 직접 스캔(실제 registerScanned)한 서버는 iDRAC 경로로 중앙 대상(바뀌지 않음)', async () => {
  const poller = await scene();
  const { registerScanned } = await import('../src/idrac/registry.js');
  const r0 = registerScanned([{ ip: '10.1.1.11', hostName: 'bm-a', serviceTag: 'CEN001' }], 'root', 'pw', 'merge', 'vcA', 'vcA');
  assert.equal(r0.ok, true);
  const tg = await poller.currentTargets();
  const t1 = tg.targets.find((x) => x.key === 'CEN001');
  assert.deepEqual(t1?.paths, ['idrac']);
  assert.equal(tg.skipped.find((s) => s.serviceTag === 'CEN001'), undefined);
});

test('③ 수집 서버 등록부 손상 → remote-collector-unknown(엣지 수집 · no-idrac 어느 쪽에도 넣지 않는다) · 다시 읽히면 엣지 수집', async () => {
  const poller = await scene({ collectors: 'corrupt' });
  const tg = await poller.currentTargets();
  const s = tg.skipped.find((x) => x.serviceTag === 'RMT001');
  assert.deepEqual([s.reason, s.collectorIssue, s.agent], ['remote-collector-unknown', 'unread', undefined]);
  // fleet 보고 경로(인증된 agent 이름)는 등록부와 무관 — 그대로 엣지 수집
  assert.equal(tg.skipped.find((x) => x.serviceTag === 'RMT002').reason, 'edge-delegated');
  const tg2 = await (await scene()).currentTargets();
  assert.equal(tg2.skipped.find((x) => x.serviceTag === 'RMT001').reason, 'edge-delegated', '복구되면 바로');
  // 파일이 아예 없음(첫 설치 — 못 읽음이 아니다) → 없는 id
  const tg3 = await (await scene({ collectors: 'none' })).currentTargets();
  assert.deepEqual([tg3.skipped.find((x) => x.serviceTag === 'RMT001').reason, tg3.skipped.find((x) => x.serviceTag === 'RMT001').collectorIssue], ['remote-collector-unknown', 'not-found']);
});

test('③ 라우트 — /tools/bm-usage(관리자 · 범위 운영자) · /edges · 누락 점검(관리자 · 범위 관리자) · /insights/fleet 내부 필드 없음', async () => {
  await scene();
  const call = await app();
  // 관리자 — 둘 다 엣지 수집(edge-pl) · 사유별 수
  const a = await call('adm', '/tools/bm-usage');
  assert.equal(a.status, 200);
  const aSk = a.body.skipped.filter((s) => s.reason === 'edge-delegated');
  assert.deepEqual(aSk.map((s) => [s.serviceTag, s.agent]).sort(), [['RMT001', 'edge-pl'], ['RMT002', 'edge-pl']]);
  assert.equal(a.body.skippedCounts['edge-delegated'], 2);
  assert.equal(a.body.skippedCounts['no-idrac'], undefined);
  assert.ok(a.body.reasons['remote-collector-unknown'], '사유 문구 표에 새 code');
  // 범위 운영자 vcA — 범위 안 행(법인 축이 있는 원격 위임 행)만 · 수도 보이는 행으로
  const o = await call('opa', '/tools/bm-usage');
  assert.equal(o.status, 200);
  const oSk = o.body.skipped.filter((s) => s.reason === 'edge-delegated');
  assert.deepEqual(oSk.map((s) => [s.serviceTag, s.agent, s.vcenterId]), [['RMT001', 'edge-pl', 'vcA']]);
  assert.equal(o.body.skippedCounts['edge-delegated'], 1);
  // 범위 운영자 vcB — vcA 서버 · 그 엣지 이름이 하나도 없다
  const b = await call('opb', '/tools/bm-usage');
  assert.equal(b.status, 200);
  assert.equal(JSON.stringify(b.body.skipped).includes('edge-pl'), false);
  assert.equal(JSON.stringify(b.body.skipped).includes('RMT001'), false);
  assert.equal(b.body.skippedCounts['edge-delegated'], undefined);
  // 엣지 표 — 같은 이름(등록부 name) · 엣지에서 꺼짐 · 범위 운영자 vcB 에는 그 엣지 줄이 없다(대상이 보이지 않음)
  const e = await call('adm', '/tools/bm-usage/edges');
  assert.deepEqual(e.body.rows.map((r) => [r.agent, r.enabledOnEdge]), [['edge-pl', false]]);
  assert.deepEqual((await call('opa', '/tools/bm-usage/edges')).body.rows.map((r) => r.agent), ['edge-pl']);
  assert.deepEqual((await call('opb', '/tools/bm-usage/edges')).body.rows, []);
  // 누락 점검 — 엣지 칸(그 엣지 보관분 · 기록 없으면 모름) · 범위 관리자 vcA 는 범위 안만 · 귀속 없음 행 없음
  const m = await call('adm', '/tools/bm-usage/onboard/missing');
  assert.equal(m.status, 200);
  const mr = m.body.rows.find((r) => r.serviceTag === 'RMT001');
  assert.deepEqual([mr.via, mr.agent, mr.bucket, mr.reason], ['edge', 'edge-pl', 'unknown', 'edge-no-record'], '예전: via local · none · no-idrac');
  const ma = await call('adma', '/tools/bm-usage/onboard/missing');
  assert.equal(ma.status, 200);
  assert.deepEqual(ma.body.rows.filter((r) => r.via === 'edge').map((r) => r.serviceTag), ['RMT001']);
  assert.ok(ma.body.rows.every((r) => r.vcenterId === 'vcA'));
  // 서버 분석 응답에는 collectorId(내부용)를 싣지 않는다
  const f = await call('adm', '/insights/fleet');
  assert.equal(f.status, 200);
  const fr = f.body.bareMetal.find((x) => x.serviceTag === 'RMT001');
  assert.ok(fr && !('collectorId' in fr), '내부 필드 미포함');
  assert.equal(JSON.stringify(f.body).includes('remoteCollectors'), false);
});

test('⑤ 소비처 — 공통 태그 판정기(complete) · 누락 점검(수집 서버 모름 = 모름)', async () => {
  const CT = await import('../src/bmusage/commonTag.js');
  const base = { isEdge: false, targets: [{ key: 'A', serviceTag: 'A', vcenterId: 'vcA' }], skipped: [] };
  assert.equal(CT.tagJudgeOf(base, []).complete, true);
  assert.equal(CT.tagJudgeOf({ ...base, skipped: [{ reason: 'edge-delegated', agent: 'edge-pl', serviceTag: 'B', vcenterId: 'vcA', delegatedBy: 'collector' }] }, []).complete, false, '엣지가 맡은 서버가 있으면 다 안다고 하지 않는다');
  assert.equal(CT.tagJudgeOf({ ...base, skipped: [{ reason: 'remote-collector-unknown', serviceTag: 'B', vcenterId: 'vcA' }] }, []).complete, false, '모르는 수집 서버도 보수 쪽');
  const { missingCheck } = await import('../src/bmusage/onboard/missing.js');
  const m = missingCheck({ skipped: [{ key: 'B', name: 'b', serviceTag: 'B', vcenterId: 'vcA', reason: 'remote-collector-unknown', collectorIssue: 'unread' }] });
  assert.deepEqual([m.rows[0].bucket, m.rows[0].reason, m.rows[0].via], ['unknown', 'remote-collector-unknown', 'edge'], '못 읽음 ≠ 없음');
  assert.equal(m.counts.none, 0);
});
