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
  // 반증 의심 2: 등록부에 있는데 이름이 빈 항목은 '삭제됨(not-found)' 이 아니라 'no-name'
  assert.deepEqual([by.RMT003.reason, by.RMT003.collectorIssue], ['remote-collector-unknown', 'no-name'], '이름 없는 수집 서버 — 엣지 표에 없는 이름을 대지 않는다 · 사유는 사실대로');
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
  assert.deepEqual(remoteCollectorNameOf(RC, ' c1 '), { name: 'edge-pl', id: 'c1', issue: '' });
  assert.deepEqual(remoteCollectorNameOf(RC, ''), { name: '', issue: 'not-found' });
});

// ── ② 불변식: 기준판 대상 ⊆ 새 대상 ─────────────────────────────────────────
const REG = [
  { id: 'r-loc', host: 'https://10.1.0.10', username: 'u', password: 'p', serviceTag: 'LOC001', vcenterId: 'vcA' },
  { id: 'r-cen', host: 'https://10.1.0.11', username: 'u', password: 'p', serviceTag: 'RMT010', vcenterId: 'vcA' },   // 같은 서버를 중앙도 등록 — 중앙 수집 유지
  { id: 'r-nocred', host: 'https://10.1.0.12', username: '', password: '', serviceTag: 'RMT011', vcenterId: 'vcA' },
  { id: 'r-esx3', host: 'https://10.1.0.33', username: 'u', password: 'p', serviceTag: 'ESX003', vcenterId: 'vcA' },   // 가상화 호스트 — 중앙도 받침 iDRAC 을 등록(중앙 수집 유지)
  { id: 'r-esx5', host: 'https://10.1.0.35', username: 'u', password: 'p', serviceTag: 'ESX005', vcenterId: 'vcA' },
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
// 반증 F4: 가상화 호스트(ESXi) — 받침 iDRAC 이 엣지 원격 전력뿐(idracCollectorId) · 중앙도 등록 · 모르는 수집 서버 · 중앙 로컬 받침
const VIRT = [
  { name: 'esx-02', vcenterId: 'vcA', vcenter: 'A', serviceTag: 'ESX002', idracServerId: 'remote:c1:32', idracCollectorId: 'c1', fleetId: 'esx002' },
  { name: 'esx-03', vcenterId: 'vcA', vcenter: 'A', serviceTag: 'ESX003', idracServerId: 'remote:c1:33', idracCollectorId: 'c1', fleetId: 'esx003' },
  { name: 'esx-04', vcenterId: 'vcB', vcenter: 'B', serviceTag: '', idracServerId: 'remote:c9:34', idracCollectorId: 'c9', fleetId: 'esx-04' },
  { name: 'esx-05', vcenterId: 'vcA', vcenter: 'A', serviceTag: 'ESX005', idracServerId: 'r-esx5', fleetId: 'esx005' },
];
// 기준판 = collectorId · idracCollectorId 를 지운 같은 입력(새 판정은 그 둘이 있을 때만 갈린다 — 머리말).
const strip = (list) => list.map(({ collectorId: _c, ...r }) => r);
const stripV = (list) => list.map(({ idracCollectorId: _c, ...r }) => r);
const keysOf = (r) => new Set(r.targets.map((x) => `${x.role}|${x.key}`));
const SETTINGS = [];
for (const corps of [{}, { vcA: true }, { vcA: true, vcB: true }]) {
  for (const includeUnassigned of [false, true]) {
    for (const [idracTelemetry, osSsh] of [[true, true], [true, false], [false, true], [false, false]]) {
      for (const includeVirtualization of [false, true]) SETTINGS.push({ corps, includeUnassigned, idracTelemetry, osSsh, includeVirtualization });
    }
  }
}
const RCS = [RC, NAMES([], false), null, NAMES([['c1', 'edge-pl']])];
// 반증 F1: 등록부 상태 — 정상 · iDRAC 등록부 못 읽음(빈 목록 + 표지) · OS 등록부 못 읽음 · 둘 다(poller 가 넘기는 모양 그대로)
const REG_STATES = [
  { name: '정상', registry: REG, bmServers: OSREG, registryUnread: null },
  { name: 'iDRAC 못 읽음', registry: [], bmServers: OSREG, registryUnread: { idrac: true, os: false } },
  { name: 'OS 못 읽음', registry: REG, bmServers: [], registryUnread: { idrac: false, os: true } },
  { name: '둘 다 못 읽음', registry: [], bmServers: [], registryUnread: { idrac: true, os: true } },
];
const BM_MOVABLE = ['remote:c1:1', 'remote:c2:7', 'remote:c1:8', 'remote:c1:9', 'remote:c1:10'];
const VIRT_MOVABLE = ['remote:c1:32', 'remote:c9:34'];

test('② 불변식 — 기준판 대상 집합 ⊆ 새 대상 집합(베어메탈 · 가상화 호스트 · 등록부 4상태 · 설정 48조합 × 색인 4종 = 768)', () => {
  let delegatedSeen = 0; let unknownSeen = 0; let virtSeen = 0; let combos = 0;
  for (const rs of REG_STATES) {
    for (const settings of SETTINGS) {
      for (const remoteCollectors of RCS) {
        combos += 1;
        const input = { bareMetal: BM, virtHosts: VIRT, registry: rs.registry, bmServers: rs.bmServers, vcenters: VCS, settings, isEdge: false, agentName: '', registryUnread: rs.registryUnread };
        const base = resolveTargets({ ...input, bareMetal: strip(BM), virtHosts: stripV(VIRT) });
        const now = resolveTargets({ ...input, remoteCollectors });
        const nk = keysOf(now);
        for (const k of keysOf(base)) assert.ok(nk.has(k), `기준판 대상 ${k} 가 빠졌다 — ${rs.name} ${JSON.stringify(settings)}`);
        // 이 판정은 대상을 늘리지도 않는다(대상에는 이 노드 등록이 필요하다) — 대상 목록이 그대로다.
        assert.deepEqual(now.targets.map((x) => `${x.role}|${x.key}`), base.targets.map((x) => `${x.role}|${x.key}`));
        // 바뀐 행은 '이 노드 등록이 없는 원격 출처 서버' 뿐이고, 그 밖의 제외 사유는 한 글자도 같다.
        const moved = new Set(now.skipped.filter((s) => s.delegatedBy === 'collector' || s.reason === 'remote-collector-unknown').map((s) => s.serverId));
        for (const id of moved) {
          const virt = VIRT_MOVABLE.includes(id);
          assert.ok(virt || BM_MOVABLE.includes(id), `등록이 있는 서버(${id})를 위임으로 옮기면 안 된다 — ${rs.name}`);
          // 반증 F1: 등록부를 못 읽은 동안은 '등록 없음' 을 모른다 — 베어메탈은 iDRAC · OS 어느 쪽이든, 가상화 호스트는 iDRAC 을 못 읽으면 옮기지 않는다
          if (!virt) assert.ok(!rs.registryUnread, `등록부 못 읽음(${rs.name})인데 베어메탈 ${id} 를 엣지 위임으로 단정했다`);
          else assert.ok(!rs.registryUnread?.idrac, `iDRAC 등록부 못 읽음인데 가상화 호스트 ${id} 를 엣지 위임으로 단정했다`);
        }
        assert.deepEqual(now.skipped.filter((s) => !moved.has(s.serverId)), base.skipped.filter((s) => !moved.has(s.serverId)));
        for (const s of now.skipped.filter((x) => moved.has(x.serverId))) {
          assert.ok(s.reason === 'edge-delegated' ? s.agent === 'edge-pl' : (s.reason === 'remote-collector-unknown' && !s.agent), JSON.stringify(s));
          if (s.role === 'virt') virtSeen += 1;
          if (s.reason === 'edge-delegated') delegatedSeen += 1; else unknownSeen += 1;
        }
        // 등록이 있는 원격 서버의 사유는 예전 그대로(no-idrac-cred · os-foreign · os-ambiguous 등 — 이 노드 설정의 문제)
        const cred = now.skipped.find((s) => s.serverId === 'remote:c1:3');
        if (cred) assert.notEqual(cred.reason, 'edge-delegated');
      }
    }
  }
  assert.equal(combos, 768);
  assert.ok(delegatedSeen > 0 && unknownSeen > 0 && virtSeen > 0, '세 갈래가 실제로 돌았다');
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
  return async (u, p, method = 'GET', body = null) => {
    const r = await fetch(`${_srv.base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
}
test.after(() => { _srv?.srv.close(); });

let _gen = 0;
const COL_OK = [{ id: 'c1', name: 'edge-pl', url: 'https://10.9.0.1:3443', enabled: true }];
/**
 * 실제 경로 장면. collectors: 'ok' | 'corrupt' | 'none' | 배열 · idrac: 등록 배열 | 'corrupt'(손상 — 못 읽음) · os: 등록 배열(bmstor 등록부는 프로세스 첫 읽기를 캐시한다 — OS 손상은 별도 시험 파일 bmRemoteDelegate2959os) · fleetAgent/collectorId: 엣지 이름 · 수집 서버 id ·
 * extraRemote: 원격 전력 항목 더 · hosts: 스냅샷 ESXi 호스트 · envelope: { agent, snap } | null(엣지 보관분 없음) · settings: bm-usage 설정 덮어쓰기.
 */
async function scene({ collectors = 'ok', idrac = [], os = [], fleetAgent = 'edge-pl', collectorId = 'c1', extraRemote = [], hosts = [], envelope, settings = {}, fleet = true } = {}) {
  const { store } = await import('../src/store.js');
  store.snapshot = { generatedAt: `g-${++_gen}`, vcenters: VCS, hosts };
  for (const f of fs.readdirSync(DIR)) if (/^(collectors|idrac|bm-storage)\.json/.test(f)) fs.rmSync(path.join(DIR, f), { force: true });
  if (collectors === 'ok') fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors: COL_OK }));
  else if (Array.isArray(collectors)) fs.writeFileSync(path.join(DIR, 'collectors.json'), JSON.stringify({ collectors }));
  else if (collectors === 'corrupt') fs.writeFileSync(path.join(DIR, 'collectors.json'), '{"collectors": [ {"id": "c1", "name": "edge-pl"');   // 손상 — 못 읽음
  fs.writeFileSync(path.join(DIR, 'idrac.json'), idrac === 'corrupt' ? '{"servers": [ {"id": "r-cen"' : JSON.stringify({ servers: idrac }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: os }));
  fs.writeFileSync(path.join(DIR, 'fleet-tags.json'), JSON.stringify({ tags: { rmt001: 'baremetal', rmt002: 'baremetal' } }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: true, includeUnassigned: false, ...settings }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { setEdgeFleet, resetEdgeFleet } = await import('../src/central/fleet.js');
  const { setRemoteHost, clearCollectorHosts } = await import('../src/collector/state.js');
  resetEdgeFleet(); for (const c of ['c1', 'gm1', 'c2', 'x1']) clearCollectorHosts(c);
  // 사용자 환경 재현: 엣지 edge-pl 이 스캔해 자기 등록부에 넣은 두 서버를 fleet 보고로 올리고, 그중 RMT001 은 그 엣지가 iDRAC 전력을 폴링해 원격 전력으로도 올라온다.
  if (fleet) {
    setEdgeFleet(fleetAgent, [
      { serviceTag: 'RMT001', name: 'bm-oracle-01', vcenterId: 'vcA' },
      { serviceTag: 'RMT002', name: 'bm-nopower', vcenterId: 'vcA' },
    ], null);
  }
  setRemoteHost('10.0.0.5', { collectorId, serverId: 7, serverName: 'bm-oracle-01', serviceTag: 'RMT001', watts: 310, ts: NOW, vcenterId: 'vcA' });
  for (const r of extraRemote) { const { host, ...rest } = r; setRemoteHost(host, { collectorId, watts: 300, ts: NOW, vcenterId: 'vcA', ...rest }); }
  const E = await import('../src/central/bmUsageEdgePull.js');
  E._resetForTest();
  // 그 엣지 보관분: 엣지에서 꺼짐(사용자 화면의 '엣지에서 꺼짐 → 중앙에서 켜기')
  const env = envelope === undefined ? { agent: 'edge-pl', snap: { node: { agent: 'edge-pl', role: 'edge' }, enabled: false, targets: [{ key: 'RMT001', name: 'bm-oracle-01', vcenterId: 'vcA' }] } } : envelope;
  if (env) E.putEdgeBmUsage(env.agent, { ok: true, snap: env.snap });
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

// ── 반증 2차(v2.959) — F1 · F2 · F3 · F4 · 의심 1 · 의심 2 ─────────────────────
const REG_CEN = [{ id: 'r-cen', name: 'cen-10', host: 'https://10.1.0.11', username: 'root', password: 'pw', serviceTag: 'RMT010', vcenterId: 'vcA' }];
const RMT010 = { host: '10.5.0.10', serverId: 10, serverName: 'rm-cenreg', serviceTag: 'RMT010' };

test('반증 F1 — iDRAC 등록부를 못 읽으면 원격 서버를 엣지 수집으로 단정하지 않는다(실제 currentTargets · 라우트 · 누락 점검)', async () => {
  // 정상: 중앙이 RMT010 을 iDRAC 등록으로 수집 · RMT001(등록 없음)은 엣지 수집
  let tg = await (await scene({ idrac: REG_CEN, extraRemote: [RMT010] })).currentTargets();
  assert.deepEqual(tg.targets.map((x) => [x.key, x.paths]), [['RMT010', ['idrac']]]);
  assert.equal(tg.skipped.find((s) => s.serviceTag === 'RMT001').delegatedBy, 'collector');
  // 손상: 등록부를 못 읽음 — 예전(기준판) 사유 그대로 · 엣지 수집 0(원격 경로) · 경고가 그 이유를 말한다
  const poller = await scene({ idrac: 'corrupt', extraRemote: [RMT010] });
  tg = await poller.currentTargets();
  const by = Object.fromEntries(tg.skipped.map((s) => [s.serviceTag, s]));
  assert.equal(tg.targets.length, 0);
  assert.equal(by.RMT010.reason, 'no-idrac', '예전: no-idrac(중앙이 수집하던 서버) · 1차 판: edge-delegated(단정)');
  assert.equal(by.RMT001.reason, 'no-idrac', '등록이 없는지도 모른다 — 엣지 수집으로 단정하지 않는다');
  assert.ok(!tg.skipped.some((s) => s.delegatedBy === 'collector' || s.reason === 'remote-collector-unknown'));
  assert.equal(by.RMT002.reason, 'edge-delegated', 'fleet 보고 경로(인증된 엣지 이름)는 등록부와 무관 — 그대로');
  const se = tg.sourceErrors.find((e) => e.source === 'idrac-registry');
  assert.match(se.error, /no-idrac 로 보일 수 있습니다/);
  assert.match(se.error, /‘엣지 수집’ 으로 가르지 않습니다/, '경고가 왜 엣지 수집이 아닌지 말한다');
  // 라우트 · 누락 점검 · 공통 태그 판정기도 그 단정을 따르지 않는다(같은 장면)
  const call = await app();
  const a = await call('adm', '/tools/bm-usage');
  assert.ok(!a.body.skipped.some((s) => s.delegatedBy === 'collector'));
  assert.equal(a.body.skippedCounts['edge-delegated'], 1, 'fleet 경로 1대만');
  const m = await call('adm', '/tools/bm-usage/onboard/missing');
  assert.deepEqual(['RMT001', 'RMT010'].map((k) => m.body.rows.find((r) => r.serviceTag === k)?.via), ['local', 'local']);
});

test('반증 F2 — 같은 엣지는 이름 하나(수집 서버 등록부 name)로 · 등록부에 없는 이름 · 못 읽음은 받은 이름 그대로', async () => {
  const CT = await import('../src/bmusage/targets.js');
  const { remoteCollectorIndex } = await import('../src/insights/fleetInventory.js');
  const idx = remoteCollectorIndex({ list: [{ id: 'gm1', name: 'Gdansk Main' }, { id: 'c2', name: 'edge-us' }, { id: 'c3', name: '' }, { id: 'x', name: 'gm1' }], error: null });
  assert.equal(CT.canonicalAgentOf(idx, 'gm1'), 'Gdansk Main', 'id 별칭 → name');
  assert.equal(CT.canonicalAgentOf(idx, ' GDANSK main '), 'Gdansk Main', 'name 별칭(대소문자 · 공백 무시)');
  assert.equal(CT.canonicalAgentOf(idx, 'c3'), 'c3', '이름 빈 항목 — 받은 이름 그대로');
  assert.equal(CT.canonicalAgentOf(idx, 'edge-zz'), 'edge-zz', '등록부에 없는 이름 — 그대로');
  assert.equal(CT.canonicalAgentOf(remoteCollectorIndex({ list: [], error: { reason: 'x' } }), 'gm1'), 'gm1', '못 읽음 — 그대로');
  assert.equal(CT.canonicalAgentOf(null, 'gm1'), 'gm1');
  // 실제 경로: 자기등록 항목(id = 엣지 agent 'gm1')의 표시 이름을 관리자가 바꾼 꼴 — 예전에는 칩 두 개('Gdansk Main' 2대 · 'gm1' 1대 표에 없음)
  const cols = [{ id: 'gm1', name: 'Gdansk Main', url: 'https://10.9.0.1:3443', enabled: true }];
  await scene({ collectors: cols, fleetAgent: 'gm1', collectorId: 'gm1', envelope: { agent: 'Gdansk Main', snap: { node: { agent: 'gm1', role: 'edge' }, enabled: false, targets: [{ key: 'RMT001', name: 'bm-oracle-01', vcenterId: 'vcA' }] } } });
  const call = await app();
  const a = await call('adm', '/tools/bm-usage');
  const del = a.body.skipped.filter((s) => s.reason === 'edge-delegated');
  assert.deepEqual(del.map((s) => [s.serviceTag, s.agent]).sort(), [['RMT001', 'Gdansk Main'], ['RMT002', 'Gdansk Main']]);
  const e = await call('adm', '/tools/bm-usage/edges');
  assert.deepEqual(e.body.rows.map((r) => r.agent), ['Gdansk Main'], '엣지 표 · 중앙에서 켜기 · 당기기가 쓰는 이름과 같다');
  const m = await call('adm', '/tools/bm-usage/onboard/missing');
  assert.deepEqual(m.body.rows.filter((r) => r.via === 'edge').map((r) => r.agent), ['Gdansk Main', 'Gdansk Main']);
});

test('반증 F3 — 예전 용도 태그를 정리할 수 없는 중앙의 안내는 사실대로(엣지에서 정리 불가 · 지우지 않음) · 다 알 때는 그대로 정리', async () => {
  const REGL = [{ id: 'r-loc', name: 'loc-01', host: 'https://10.1.0.10', username: 'root', password: 'pw', serviceTag: 'LOC001', vcenterId: 'vcA' }];
  const FT = await import('../src/insights/fleetTags.js');
  const roles = { by: 'legacy-user', knownRoles: ['web', 'db', 'general', 'batch', 'storage'], knownApps: [] };
  const call = await app();
  // 엣지가 맡은 원격 서버가 있는 중앙(엣지 보관분 없음 = 재시작 직후 꼴) — 판정기 complete 거짓
  await scene({ idrac: REGL, fleet: false, envelope: null });
  assert.equal(FT.setFleetPurpose('LOC001', { role: 'web' }, roles).ok, true);
  const full = await call('adm', '/tools/bm-usage/purpose', 'PUT', { key: 'LOC001', vcenterId: 'vcA', clear: true });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.deepEqual([full.body.legacyRemains, full.body.legacyWhy], [true, 'incomplete']);
  assert.match(full.body.legacyNote, /예전 태그가 남아/);
  assert.match(full.body.legacyNote, /이 노드의 저장소/);
  assert.match(full.body.legacyNote, /엣지에서는 정리할 수 없/);
  assert.doesNotMatch(full.body.legacyNote, /엣지 · 단일 노드에서 정리/, '예전 안내(사실과 다름)');
  assert.equal(FT.fleetPurposeOf('LOC001')?.role, 'web', '지우지 않는다(보이지 않는 다른 법인 서버의 값일 수 있다)');
  const sc = await call('adma', '/tools/bm-usage/purpose', 'PUT', { key: 'LOC001', vcenterId: 'vcA', clear: true });
  assert.deepEqual([sc.status, sc.body.legacyWhy], [200, 'scope']);
  assert.match(sc.body.legacyNote, /범위가 지정된 계정은 지우지 않습니다/);
  assert.equal(FT.fleetPurposeOf('LOC001')?.role, 'web');
  // 엣지가 맡은 서버 · 엣지 보관분이 없는 노드(다 앎) — 전체 범위 지우기는 예전처럼 정리한다(안내 없음)
  const { clearCollectorHosts } = await import('../src/collector/state.js');
  clearCollectorHosts('c1');
  const ok = await call('adm', '/tools/bm-usage/purpose', 'PUT', { key: 'LOC001', vcenterId: 'vcA', clear: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.legacyRemains, undefined);
  assert.equal(FT.fleetPurposeOf('LOC001'), null, '다 알 때는 법인별로 나눠 옮기고 예전 행을 지운다(기존 동작)');
  FT.setFleetPurpose('vcA|LOC001', null, {});
});

test('반증 F4 — 가상화 호스트(ESXi)도: 받침 iDRAC 이 엣지 원격 전력뿐이면 엣지 수집 · 중앙 등록이 있으면 그대로 · /insights/fleet 내부 필드 없음', async () => {
  const hosts = [{ name: 'esx-02', vcenterId: 'vcA', serviceTag: 'ESX002', connectionState: 'connected' }, { name: 'esx-03', vcenterId: 'vcA', serviceTag: 'ESX003', connectionState: 'connected' }];
  const extraRemote = [{ host: 'esx-02', serverId: 32, serverName: 'esx-02', serviceTag: 'ESX002' }, { host: 'esx-03', serverId: 33, serverName: 'esx-03', serviceTag: 'ESX003' }];
  const reg3 = [{ id: 'r-esx3', name: 'esx-03-idrac', host: 'https://10.1.0.33', username: 'root', password: 'pw', serviceTag: 'ESX003', vcenterId: 'vcA' }];
  const poller = await scene({ idrac: reg3, hosts, extraRemote, settings: { includeVirtualization: true } });
  const { getFleetInventory } = await import('../src/insights/fleetInventory.js');
  const { store } = await import('../src/store.js');
  const inv = await getFleetInventory(store.snapshot);
  const v2 = inv.virtualizationHosts.find((h) => h.name === 'esx-02');
  assert.deepEqual([v2.idracServerId, v2.idracCollectorId], ['remote:c1:32', 'c1']);
  const tg = await poller.currentTargets();
  const sv = tg.skipped.find((s) => s.role === 'virt' && s.serviceTag === 'ESX002');
  assert.deepEqual([sv.reason, sv.agent, sv.vcenterId, sv.delegatedBy], ['edge-delegated', 'edge-pl', 'vcA', 'collector'], '예전: virt no-idrac');
  assert.deepEqual(tg.targets.filter((x) => x.role === 'virt').map((x) => [x.key, x.paths]), [['ESX003', ['idrac']]], '중앙이 등록한 받침은 중앙 대상 그대로');
  // iDRAC 등록부를 못 읽으면 가상화 호스트도 단정하지 않는다(F1 과 같은 규칙)
  const tgBad = await (await scene({ idrac: 'corrupt', hosts, extraRemote, settings: { includeVirtualization: true } })).currentTargets();
  assert.equal(tgBad.skipped.find((s) => s.role === 'virt' && s.serviceTag === 'ESX002').reason, 'no-idrac');
  await scene({ idrac: reg3, hosts, extraRemote, settings: { includeVirtualization: true } });
  const call = await app();
  const f = await call('adm', '/insights/fleet');
  assert.ok(f.body.virtualizationHosts.length >= 2 && f.body.virtualizationHosts.every((h) => !('idracCollectorId' in h)), '내부 필드 미포함');
});

test('반증 의심 1(재현 — 고침) — 서비스태그 없는 원격 서버의 누락 점검은 엣지 봉투를 엣지 쪽 키로 찾는다 · 그 키가 주소면 비관리자에게 가린다', async () => {
  const extraRemote = [{ host: '10.5.0.29', serverId: 'SRV-29', serverName: 'rm-notag', serviceTag: '' }, { host: '10.5.0.30', serverId: '10.5.0.30', serverName: 'rm-notag-ip', serviceTag: '' }];
  const envelope = { agent: 'edge-pl', snap: { node: { agent: 'edge-pl', role: 'edge' }, enabled: true,
    targets: [{ key: 'srv-29', name: 'rm-notag', vcenterId: 'vcA' }, { key: '10.5.0.30', name: 'rm-notag-ip', vcenterId: 'vcA' }],
    perf: [{ key: 'srv-29', coverage: 'both' }, { key: '10.5.0.30', coverage: 'os' }] } };
  const poller = await scene({ extraRemote, envelope });
  const tg = await poller.currentTargets();
  const s29 = tg.skipped.find((s) => s.serverId === 'remote:c1:SRV-29');
  assert.deepEqual([s29.reason, s29.key, s29.edgeKey], ['edge-delegated', 'remote:c1:srv-29', 'srv-29'], '중앙 키와 엣지 키는 다르다 — 엣지 쪽 키를 싣는다');
  assert.equal(tg.skipped.find((s) => s.serviceTag === 'RMT001').edgeKey, undefined, '서비스태그가 있으면 두 노드 키가 같다(싣지 않음)');
  const call = await app();
  const m = await call('adm', '/tools/bm-usage/onboard/missing');
  const rowOf = (name) => m.body.rows.find((r) => r.name === name);
  assert.deepEqual([rowOf('rm-notag').bucket, rowOf('rm-notag').reason], ['both', ''], '예전: unknown · edge-no-record');
  assert.equal(rowOf('rm-notag-ip').bucket, 'os');
  // 엣지 쪽 키가 주소면(IP 로 등록한 엣지 iDRAC) 비관리자 응답에서 가린다
  const o = await call('opa', '/tools/bm-usage');
  const ip = o.body.skipped.find((s) => s.name !== 'rm-notag' && String(s.serverId || '').length && s.delegatedBy === 'collector' && s.reason === 'edge-delegated' && s.edgeKey && s.edgeKey !== 'srv-29');
  assert.ok(ip, JSON.stringify(o.body.skipped));
  assert.notEqual(ip.edgeKey, '10.5.0.30', '주소 가림');
  assert.equal(JSON.stringify(o.body.skipped).includes('10.5.0.30'), false);
  const ad = await call('adm', '/tools/bm-usage');
  assert.ok(ad.body.skipped.some((s) => s.edgeKey === '10.5.0.30'), '관리자 판본은 원문');
});

// ── 재확인 R1 — 별칭이 겹치는 등록(앞 항목의 name = 뒤 항목의 id) ─────────────────
test('재확인 R1 — 엣지 이름 정규화는 전 항목 id 일치 먼저 · 이름이 다른 수집 서버로 가면 겹침 표지(상태 · 누락 점검 단정 없음)', async () => {
  const CT = await import('../src/bmusage/targets.js');
  const { remoteCollectorIndex } = await import('../src/insights/fleetInventory.js');
  const A = remoteCollectorIndex({ list: [{ id: 'x1', name: 'gm1' }, { id: 'gm1', name: 'Warsaw' }], error: null });
  assert.deepEqual(CT.canonicalAgentRef(A, 'gm1'), { name: 'Warsaw', id: 'gm1' }, '인증 이름 = 등록 id — 앞 항목의 name 보다 id 일치가 먼저(예전: x1 의 name 으로 묶음)');
  assert.deepEqual(CT.canonicalAgentRef(A, 'x1'), { name: 'gm1', id: 'x1' });
  assert.equal(CT.agentNameClash(A, 'gm1', 'x1'), false, 'clashA: 이름 gm1 은 목록 앞 x1 로 간다(findCollectorByName 과 같은 항목)');
  assert.equal(CT.agentNameClash(A, 'Warsaw', 'gm1'), false);
  const B = remoteCollectorIndex({ list: [{ id: 'gm1', name: 'Warsaw' }, { id: 'x1', name: 'gm1' }], error: null });
  assert.equal(CT.agentNameClash(B, 'gm1', 'x1'), true, 'clashB: 이름 gm1 은 다른 수집 서버(gm1)로 간다');
  assert.equal(CT.agentNameClash(B, 'Warsaw', 'gm1'), false);
  assert.equal(CT.agentNameClash(null, 'gm1', 'x1'), false, '모르면 단정하지 않는다');
  // id 로 찾은 항목의 name 이 비면 받은 이름 그대로 — 다른 항목의 name 으로 넘어가지 않는다(그 엣지는 id 가 같은 항목이다)
  const C = remoteCollectorIndex({ list: [{ id: 'c3', name: '' }, { id: 'zz', name: 'c3' }], error: null });
  assert.deepEqual(CT.canonicalAgentRef(C, 'c3'), { name: 'c3', id: '' });
  // 세 경로(fleet 보고 · 원격 전력 · 가상화 호스트 원격 받침 · 사이트 위임 vCenter) 모두 같은 표지(순수)
  const st = { corps: { vcA: true, vcB: true }, idracTelemetry: true, osSsh: true, includeUnassigned: true, includeVirtualization: true };
  const r = CT.resolveTargets({ isEdge: false, settings: st, remoteCollectors: B,
    vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcS', name: 'S', collectSource: 'site', collectedBy: 'x1' }],
    bareMetal: [
      { serverId: 'edge:x1:F01', name: 'f01', serviceTag: 'F01', source: 'edge', remoteAgent: 'x1', vcenterId: 'vcA' },
      { serverId: 'remote:x1:9', name: 'r09', serviceTag: 'R09', source: 'remote', collectorId: 'x1', vcenterId: 'vcA' },
      { serverId: 'remote:gm1:10', name: 'r10', serviceTag: 'R10', source: 'remote', collectorId: 'gm1', vcenterId: 'vcA' },
    ],
    virtHosts: [
      { name: 'esx-9', vcenterId: 'vcA', serviceTag: 'V09', idracServerId: 'remote:x1:19', idracCollectorId: 'x1', fleetId: 'v09' },
      { name: 'esx-s', vcenterId: 'vcS', serviceTag: 'VS1', idracServerId: '', fleetId: 'vs1' },
    ] });
  const sk = Object.fromEntries(r.skipped.map((x) => [x.serviceTag, x]));
  assert.deepEqual(['F01', 'R09', 'V09', 'VS1'].map((k) => [sk[k].agent, !!sk[k].agentClash]), [['gm1', true], ['gm1', true], ['gm1', true], ['gm1', true]], '이름 gm1 이 다른 수집 서버로 가는 행은 전부 표지');
  assert.deepEqual([sk.R10.agent, !!sk.R10.agentClash], ['Warsaw', false]);
  // 실제 경로(라우트 · 누락 점검) — 두 순서
  const call = await app();
  const REG = await import('../src/collector/registry.js');
  for (const [label, cols, clashExpected] of [
    ['clashA', [{ id: 'x1', name: 'gm1', url: 'https://10.9.0.7:3443', enabled: true }, { id: 'gm1', name: 'Warsaw', url: 'https://10.9.0.1:3443', enabled: true }], false],
    ['clashB', [{ id: 'gm1', name: 'Warsaw', url: 'https://10.9.0.1:3443', enabled: true }, { id: 'x1', name: 'gm1', url: 'https://10.9.0.7:3443', enabled: true }], true],
  ]) {
    await scene({ collectors: cols, fleetAgent: 'gm1', collectorId: 'gm1', envelope: null, settings: { corps: { vcA: true, vcB: true } },
      extraRemote: [{ host: '10.5.0.8', serverId: 8, serverName: 'bm-08', serviceTag: 'RMT008', collectorId: 'x1', vcenterId: 'vcB' }] });
    const a = await call('adm', '/tools/bm-usage');
    const del = a.body.skipped.filter((x) => x.reason === 'edge-delegated');
    const by = Object.fromEntries(del.map((x) => [x.serviceTag, x]));
    assert.deepEqual(['RMT001', 'RMT002', 'RMT008'].map((k) => by[k]?.agent), ['Warsaw', 'Warsaw', 'gm1'], `${label}: 엣지 gm1 의 서버(원격 · fleet)는 한 칸 'Warsaw' 2대 · x1 의 서버는 'gm1' 1대(예전 clashA: 'gm1' 2대 — 다른 엣지와 합침)`);
    assert.equal(!!by.RMT008.agentClash, clashExpected, `${label}: 이름 gm1 이 다른 수집 서버로 가는가`);
    assert.ok(!by.RMT001.agentClash && !by.RMT002.agentClash);
    // 겹침 판정은 당기기 · 중앙에서 켜기가 쓰는 이름 풀이(findCollectorByName)와 같은 답이다
    assert.equal(REG.findCollectorByName('gm1')?.id !== 'x1', clashExpected);
    assert.equal(REG.findCollectorByName('Warsaw')?.id, 'gm1');
    const m = await call('adm', '/tools/bm-usage/onboard/missing');
    const r8 = m.body.rows.find((x) => x.serviceTag === 'RMT008');
    assert.deepEqual([r8.via, r8.agent, r8.bucket, r8.reason], ['edge', 'gm1', 'unknown', clashExpected ? 'edge-name-clash' : 'edge-no-record'], `${label}: 겹치면 이름으로 찾은 보관분을 쓰지 않는다`);
  }
});

// ── 2차 재확인 — 같은 name 두 등록: 같은 엣지(같은 URL)면 겹침이 아니다 ───────────────
test('2차 재확인 — 같은 name 두 등록: 같은 URL(같은 엣지) → 겹침 없음 · 맞는 상태 / 다른 URL → 겹침 / URL 빈 항목 → 겹침', async () => {
  const CT = await import('../src/bmusage/targets.js');
  const { remoteCollectorIndex } = await import('../src/insights/fleetInventory.js');
  // 저장 규약과 같은 정규화(스킴 없음 · 끝 '/' · 스킴 대소문자)로 같은 URL 이 된다 — 새 규칙을 만들지 않았다(collector/registry.js normalizeCollectorUrl)
  const same = remoteCollectorIndex({ list: [{ id: 'gm1-old', name: 'gm1', url: 'https://10.9.0.1:3443' }, { id: 'gm1', name: 'gm1', url: 'HTTPS://10.9.0.1:3443/' }], error: null });
  assert.equal(CT.agentNameClash(same, 'gm1', 'gm1'), false, '같은 엣지의 옛 수동 등록 + 자기등록 — 당기기도 같은 엣지로 간다(오경보 아님)');
  const noScheme = remoteCollectorIndex({ list: [{ id: 'gm1-old', name: 'gm1', url: '10.9.0.1:3443' }, { id: 'gm1', name: 'gm1', url: 'https://10.9.0.1:3443' }], error: null });
  assert.equal(CT.agentNameClash(noScheme, 'gm1', 'gm1'), false, '스킴 없는 주소의 기본은 https://(저장 규약)');
  const diff = remoteCollectorIndex({ list: [{ id: 'a', name: 'edge-pl', url: 'https://10.9.0.1:3443' }, { id: 'b', name: 'edge-pl', url: 'https://10.9.0.2:3443' }], error: null });
  assert.equal(CT.agentNameClash(diff, 'edge-pl', 'b'), true, '다른 URL — 다른 엣지(겹침)');
  assert.equal(CT.agentNameClash(diff, 'edge-pl', 'a'), false, '이름이 가는 항목 자신은 겹침이 아니다');
  const empty = remoteCollectorIndex({ list: [{ id: 'a', name: 'x', url: '' }, { id: 'b', name: 'x', url: '' }], error: null });
  assert.equal(CT.agentNameClash(empty, 'x', 'b'), true, 'URL 이 빈 항목은 같은 엣지라고 단정하지 않는다');
  const half = remoteCollectorIndex({ list: [{ id: 'a', name: 'x', url: 'https://10.9.0.1:3443' }, { id: 'b', name: 'x' }], error: null });
  assert.equal(CT.agentNameClash(half, 'x', 'b'), true);
  // 실제 경로 — 같은 엣지 두 등록(dupSame): 겹침 표지 없음 · 누락 점검은 그 엣지 보관분의 커버리지(맞는 값 — 0b15e446 과 같다, e4248dd4 는 '모름')
  const call = await app();
  const env = { agent: 'gm1', snap: { node: { agent: 'gm1', role: 'edge' }, enabled: true, targets: [{ key: 'RMT001', name: 'bm-oracle-01', vcenterId: 'vcA' }, { key: 'RMT002', name: 'bm-nopower', vcenterId: 'vcA' }],
    perf: [{ key: 'RMT001', coverage: 'both' }, { key: 'RMT002', coverage: 'idrac' }] } };
  const dupSame = [{ id: 'gm1-old', name: 'gm1', url: 'https://10.9.0.1:3443', enabled: true }, { id: 'gm1', name: 'gm1', url: 'https://10.9.0.1:3443/', enabled: true }];
  await scene({ collectors: dupSame, fleetAgent: 'gm1', collectorId: 'gm1', envelope: env });
  let a = await call('adm', '/tools/bm-usage');
  let del = a.body.skipped.filter((x) => x.reason === 'edge-delegated');
  assert.deepEqual(del.map((x) => [x.serviceTag, x.agent, !!x.agentClash]).sort(), [['RMT001', 'gm1', false], ['RMT002', 'gm1', false]]);
  let m = await call('adm', '/tools/bm-usage/onboard/missing');
  assert.deepEqual(['RMT001', 'RMT002'].map((k) => m.body.rows.find((r) => r.serviceTag === k)?.bucket), ['both', 'idrac'], '같은 엣지 — 보관분 커버리지를 그대로(예전 판 e4248dd4: unknown · edge-name-clash)');
  // 다른 엣지 두 등록(dupDiff — URL 다름): 겹침 유지
  const dupDiff = [{ id: 'gm1-old', name: 'gm1', url: 'https://10.9.0.7:3443', enabled: true }, { id: 'gm1', name: 'gm1', url: 'https://10.9.0.1:3443', enabled: true }];
  await scene({ collectors: dupDiff, fleetAgent: 'gm1', collectorId: 'gm1', envelope: env });
  a = await call('adm', '/tools/bm-usage');
  del = a.body.skipped.filter((x) => x.reason === 'edge-delegated');
  assert.deepEqual(del.map((x) => [x.serviceTag, !!x.agentClash]).sort(), [['RMT001', true], ['RMT002', true]], '이름 gm1 은 다른 엣지(gm1-old)로 간다');
  m = await call('adm', '/tools/bm-usage/onboard/missing');
  assert.deepEqual(['RMT001', 'RMT002'].map((k) => m.body.rows.find((r) => r.serviceTag === k)?.reason), ['edge-name-clash', 'edge-name-clash']);
});
