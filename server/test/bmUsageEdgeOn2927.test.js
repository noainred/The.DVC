/**
 * test/bmUsageEdgeOn2927.test.js — 베어메탈 사용률 '중앙에서 켜기'(v2.927 · 사용자 요청 "중앙에서 엣지를 켜는 기능 추가").
 *
 * 한 프로세스가 중앙(실제 centralRouter · **실제 authMiddleware → requireEnrolled → auditMiddleware → api** — index.js 와 같은 순서)과
 * 엣지(실제 pullBmUsageConfigNow — 엣지 코드는 바꾸지 않았다)를 겸한다(v2.627 test/bmUsageDistribute2627.test.js 와 같은 방식 —
 * bmusage-settings.json = 중앙 원본이자 엣지 로컬 · bmusage-central.json = 엣지 사본).
 * 고정하는 것:
 *  ① 매핑 — 등록부 remoteAgent → 위임 인벤토리 소유 → 스냅샷 관측(점검중·비활성·push 전·골격에도 흔들리지 않게 · 반증 F2) + 엣지 보고 베어메탈
 *     (중앙이 아는 id 만 · 다른 엣지 담당 사이트 vCenter 제외) · 사이트 관측 규칙은 targets.js 한 곳(소스 스윕)
 *  ② 내려가는 판 = 중앙 로컬 배포 키 **전부** + 켜기 true + **저장한** 법인(구버전 엣지가 빠진 키를 기본값으로 채우지 않게) · Enterprise 없음
 *  ③ 모드 — 전체(제외 아님) > 중앙 켜기 > 제외/꺼짐 · 공유 토큰 = per-edge-unverified · 수동 충돌은 제외 우선 · 법인 없는 항목은 버리고 센다
 *  ④ 저장 — 제외 ↔ 중앙 켜기 양방향 409 · 전체 배포가 덮는 엣지 409 · 법인 0 · 법인/엣지 상한(too-many) · 다시 확인 · 프로토타입 이름
 *  ⑤ 상태 — 행마다 그 엣지 판(저장 법인)의 서명 · 매핑이 바뀌면 corpsChanged(서명·인출은 그대로) · unverified · releasing · 가려짐
 *  ⑥ 실제 라우터(실제 토큰 인증) — viewer·operator·범위 admin·데모 403 · 등록부 밖 404 · 엣지 노드 409 · 비엣지/역할 모름 409 not-edge(반증 F7) ·
 *     법인 0 400 · 화면 목록 ≠ 지금 매핑 409 corps-changed · admin 200 + 감사 · 토큰 폐기 뒤에도 해제 200(반증 F1) · 재발급 뒤 켜짐 받지 않음
 *  ⑦ 실제 엣지 인출(개별 토큰) — 적용 → 적용됨 · 매핑이 비거나 공유 토큰 fleet push 로 바뀌어도 저장 법인 그대로(반증 F2·F3) · 다른 엣지·공유 토큰은 못 받음 ·
 *     해제 → 다음 인출에 로컬 복귀
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bmedgeon2927-'));
Object.assign(process.env, {
  CONFIG_DIR: DIR, SSRF_ALLOW_LOOPBACK: 'true', CENTRAL_TOKEN: 'ctok-2927', AUTH_ENABLED: 'true', AUTH_SECRET: 'q'.repeat(48),
  OTP_ROLE_ENFORCE: 'false', DATA_SOURCE: 'mock',
});
delete process.env.BMUSAGE_ENABLED;
delete process.env.CENTRAL_URL;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let srv; let port; let config; let S; let pull; let store; let T; let EC; let fleet; let audit; let tokens; let EP; let tokA; let tokB;
const TOK = {};
const LOCAL = { enabled: false, corps: { 'vc-other': true }, intervalMs: 420_000, rawRetentionDays: 60, dailyRetentionDays: 400, osSsh: false,
  idracTelemetry: true, idracFullTelemetry: false, includeVirtualization: true, alertEnabled: true, alertPct: 85,
  enterpriseEnabled: true, enterpriseAck: true, enterpriseMode: 'api' };
// 등록부: 담당 엣지를 선언한 사이트 vCenter · 선언 없이 인벤토리만 올라온 사이트 vCenter(점검중) · 비활성 · 직접 수집 2곳
const REGISTRY = [
  { id: 'vc-site-a', name: '법인A', host: 'a.invalid', collectMode: 'site', remoteAgent: 'Edge-A' },
  { id: 'vc-inv-a', name: '법인A-2', host: 'a2.invalid', collectMode: 'site', maintenance: true },
  { id: 'vc-off-a', name: '법인A-3', host: 'a3.invalid', collectMode: 'site', remoteAgent: 'Edge-A', enabled: false },
  { id: 'vc-site-b', name: '법인B', host: 'b.invalid', collectMode: 'site', remoteAgent: 'Edge-B' },
  { id: 'vc-gone', name: '법인G', host: 'g.invalid', collectMode: 'site', remoteAgent: 'Gone-Edge' },
  { id: 'vc-direct-a', name: '법인A-직접', host: 'd.invalid' },
  { id: 'vc-other', name: '중앙 법인', host: 'o.invalid' },
];
const A_CORPS = ['vc-direct-a', 'vc-inv-a', 'vc-off-a', 'vc-site-a'];
// 첫 병합 전 골격 — 관측(collectedBy)이 하나도 없다. 매핑은 등록부·인벤토리로 이어져야 한다.
const SKELETON = { initial: true, rollups: {}, hosts: [], vms: [], vcenters: REGISTRY.map((v) => ({ id: v.id, name: v.name, status: 'pending', ...(v.collectMode === 'site' ? { collectSource: 'site' } : {}) })) };

before(async () => {
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify(LOCAL));
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REGISTRY }));
  const inv = (id, agent) => ({ at: Date.now(), agent, generatedAt: Date.now(), data: { vcenter: { id, name: id }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] } });
  fs.writeFileSync(path.join(DIR, 'central-inventory.json'), JSON.stringify({ inventory: { 'vc-inv-a': inv('vc-inv-a', 'Edge-A') } }));
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { api } = await import('../src/routes/api.js');
  const auth = await import('../src/auth/auth.js');
  ({ config } = await import('../src/config.js'));
  ({ store } = await import('../src/store.js'));
  S = await import('../src/bmusage/settings.js');
  T = await import('../src/bmusage/targets.js');
  EC = await import('../src/bmusage/edgeCorps.js');
  EP = await import('../src/central/bmUsageEdgePull.js');
  fleet = await import('../src/central/fleet.js');
  audit = await import('../src/audit.js');
  pull = await import('../src/agent/bmUsageConfigPull.js');
  tokens = await import('../src/central/agentTokens.js');
  tokA = tokens.issueAgentToken('Edge-A').token;
  tokB = tokens.issueAgentToken('Edge-B').token;
  for (const n of ['OC2', 'Edge-Old', 'Edge-C', 'Gone-Edge']) tokens.issueAgentToken(n);
  // 엣지 보관분(역할): 엣지 4곳 · 중앙·단독 1곳(OC2) · 역할을 알리지 않는 구버전 1곳
  for (const [n, role] of [['Edge-A', 'edge'], ['Edge-B', 'edge'], ['Edge-C', 'edge'], ['Gone-Edge', 'edge'], ['OC2', 'central'], ['Edge-Old', '']]) {
    EP.putEdgeBmUsage(n, { ok: true, ms: 1, snap: { node: { agent: n, version: '2.925.0', ...(role ? { role } : {}) }, enabled: false, targets: [], rows: [] } });
  }
  const mk = (u) => auth.createUser(u, { trusted: true });
  mk({ username: 'adm', role: 'admin', password: 'Passw0rd!long1' });
  mk({ username: 'op', role: 'operator', password: 'Passw0rd!long1' });
  mk({ username: 'vw', role: 'viewer', password: 'Passw0rd!long1' });
  mk({ username: 'sadm', role: 'admin', password: 'Passw0rd!long1', scope: { vcenters: ['vc-site-a'] } });
  for (const name of ['adm', 'op', 'vw', 'sadm', auth.DEMO_USERNAME]) {
    const u = auth.getUser(name); const sid = `sid-${name}`; const exp = Math.floor(Date.now() / 1000) + 3600;
    TOK[name] = auth.signToken({ sub: name, role: u.role, name: u.name || name, src: 'local', tv: u.tokenVersion || 0, sid }, { exp });
    auth.noteIssuedSession({ sub: name, sid, exp });
  }
  TOK.demo = TOK[auth.DEMO_USERNAME];
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  app.use('/api', auth.authMiddleware, auth.requireEnrolled, audit.auditMiddleware, api);   // index.js 와 같은 순서
  srv = http.createServer(app);
  port = await listen(srv);
  store.snapshot = structuredClone(SKELETON);
  fleet.setEdgeFleet('Edge-A', [
    { name: 'bm-a1', serviceTag: 'TA1', vcenterId: 'vc-direct-a' },
    { name: 'bm-a2', serviceTag: 'TA2', vcenterId: 'vc-site-b' },   // 다른 엣지(Edge-B) 담당 사이트 vCenter — 넣지 않는다
    { name: 'bm-a3', serviceTag: 'TA3', vcenterId: 'vc-unknown' },  // 중앙이 모르는 id — 넣지 않는다
  ], Date.now(), { verified: true });
  config.agent.centralUrl = '';
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });

const asEdge = (name, token) => { config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = token; config.agent.name = name; };
const asCentral = () => { config.agent.centralUrl = ''; };
const put = (u, p, body) => fetch(`http://127.0.0.1:${port}/api/tools/bm-usage${p}`, { method: 'PUT', headers: { authorization: `Bearer ${TOK[u]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
const rowOf = (dist, name) => (dist?.rows || []).find((x) => x.agent.toLowerCase() === name.toLowerCase());
const resetDist = () => { for (const f of fs.readdirSync(DIR)) if (f.startsWith('bmusage-distribute.json')) fs.rmSync(path.join(DIR, f)); };
const resetCopy = () => { fs.rmSync(path.join(DIR, 'bmusage-central.json'), { force: true }); };
const src = (map) => (agent) => map[String(agent).toLowerCase()] || [];
const pullAs = (agent, token, applied = '') => fetch(`http://127.0.0.1:${port}/api/central/bmusage-config?agent=${agent}&applied=${encodeURIComponent(applied)}`, { headers: { 'X-Central-Token': token } }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));

test('① 매핑 — 등록부 담당 엣지 → 위임 인벤토리 소유 → 관측 · 점검중·비활성·push 전·골격에도 유지 · 엣지 보고 베어메탈 · 사이트 관측 규칙은 한 곳', () => {
  // 순수 — 우선순위: 등록부가 이긴다(direct 로 등록된 vCenter 는 관측이 site 여도 담당 없음)
  const own = T.siteOwnerByVcenter({
    registry: [{ id: 'x1', collectMode: 'site', remoteAgent: 'E1' }, { id: 'x2', collectMode: 'site' }, { id: 'x3', collectMode: 'site' }, { id: 'x4' }],
    inventory: [{ vcenterId: 'x1', agent: 'E9' }, { vcenterId: 'x2', agent: 'E2' }],
    vcenters: [{ id: 'x3', collectSource: 'site', collectedBy: 'E3' }, { id: 'x4', collectSource: 'site', collectedBy: 'E4' }, { id: 'x5', collectSource: 'site', collectedBy: 'E5' }],
  });
  assert.deepEqual(Object.fromEntries(own), { x1: 'E1', x2: 'E2', x3: 'E3', x4: '', x5: 'E5' });
  // 반증 mapMaint 재현(점검중 · 비활성 · push 전) — 등록부·인벤토리로 4곳 모두 잡힌다
  const mm = T.edgeCorpIndex({
    registry: [{ id: 'vc-a1', collectMode: 'site' }, { id: 'vc-a2', collectMode: 'site', maintenance: true }, { id: 'vc-a3', collectMode: 'site', enabled: false }, { id: 'vc-a4', collectMode: 'site', remoteAgent: 'Edge-A' }],
    inventory: ['vc-a1', 'vc-a2', 'vc-a3'].map((id) => ({ vcenterId: id, agent: 'Edge-A' })),
    vcenters: [{ id: 'vc-a1', collectSource: 'site', collectedBy: 'Edge-A' }, { id: 'vc-a2', status: 'maintenance' }, { id: 'vc-a4', collectSource: 'site', status: 'pending' }],
  });
  assert.deepEqual(T.edgeCorpIds({ agent: 'edge-a' }, mm), ['vc-a1', 'vc-a2', 'vc-a3', 'vc-a4']);
  assert.deepEqual(T.edgeCorpIds({ vcenters: [{ id: 'x', collectMode: 'site', agent: 'E' }], bareMetal: [{ remoteAgent: { toString: () => 'E' }, vcenterId: 'x' }, null, 'str'], agent: 'e' }), ['x'], '글자가 아닌 remoteAgent·원소는 무시');
  // 실제 원천(edgeCorpsSource) — 골격 스냅샷(관측 0)에서도 등록부·인벤토리·fleet 으로 잡힌다
  const live = EC.edgeCorpsSource();
  assert.deepEqual(live('Edge-A'), A_CORPS);
  assert.deepEqual(live('EDGE-B'), ['vc-site-b']);
  assert.deepEqual(live('nobody'), []);
  // 소스 스윕 — 사이트 관측 규칙 문자열은 bmusage/ 안에서 targets.js 의 한 곳뿐(두 벌 금지)
  const dir = path.resolve(HERE, '../src/bmusage');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const n = (fs.readFileSync(path.join(dir, f), 'utf8').match(/collectSource === 'site' \|\| v\.collectMode === 'site'/g) || []).length;
    if (n) hits.push(`${f}:${n}`);
  }
  assert.deepEqual(hits, ['targets.js:1']);
  const tsrc = fs.readFileSync(path.join(dir, 'targets.js'), 'utf8');
  assert.match(tsrc, /const siteAgent = siteAgentByVcenter\(vcenters\);/, 'resolveTargets 가 같은 함수를 쓴다');
  assert.match(tsrc, /const observed = siteAgentByVcenter\(vcenters\);/, '중앙 켜기 매핑도 같은 함수를 쓴다');
  assert.match(fs.readFileSync(path.join(dir, 'edgeCorps.js'), 'utf8'), /import \{ edgeCorpIndex, edgeCorpIds \} from '\.\/targets\.js'/);
});

test('② 내려가는 판 — 중앙 로컬 배포 키 전부 · 켜기 true · 저장 법인 · Enterprise 없음', () => {
  const s = S.perEdgeSettings(S.loadLocalBmUsageSettings(), ['vc-site-a', 'vc-direct-a']);
  assert.deepEqual(Object.keys(s).sort(), [...S.DISTRIBUTED_KEYS].sort(), '배포 키 전부(일부만 보내면 구버전 엣지가 나머지를 기본값으로 덮는다)');
  assert.equal(s.enabled, true);
  assert.deepEqual(Object.keys(s.corps).sort(), ['vc-direct-a', 'vc-site-a']);
  assert.equal(s.corps['vc-other'], undefined, '다른 법인은 보내지 않는다');
  assert.equal(s.intervalMs, 420_000); assert.equal(s.rawRetentionDays, 60); assert.equal(s.osSsh, false); assert.equal(s.alertPct, 85);
  assert.equal(s.idracFullTelemetry, false); assert.equal(s.includeVirtualization, true);
  for (const k of Object.keys(s)) assert.ok(!/^enterprise/.test(k), k);
});

test('③ 모드 — 전체 > 중앙 켜기(저장 법인) > 제외/꺼짐 · 공유 토큰 · 수동 충돌은 제외 우선 · 법인 없는 항목은 버리고 센다', () => {
  resetDist(); S._resetForTest();
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true }), { distribute: false, mode: 'off', reason: 'off' });
  assert.equal(S.setPerEdge('Edge-A', true, 'adm', { corps: ['vc-site-a'] }).ok, true);
  const on = S.distributeFor('edge-a', { verified: true });
  assert.equal(on.distribute, true); assert.equal(on.mode, 'per-edge');
  assert.deepEqual(Object.keys(on.settings.corps), ['vc-site-a'], '저장 법인 그대로(인출 때 매핑을 다시 계산하지 않는다)');
  assert.equal(on.sig, S.settingsSig(on.settings));
  assert.deepEqual(S.distributeFor('Edge-A', { verified: false }), { distribute: false, mode: 'per-edge', reason: 'per-edge-unverified' }, '공유 토큰(이름 미검증)에는 내주지 않는다');
  assert.equal(S.distributeFor('Edge-B', { verified: true }).reason, 'off', '다른 엣지는 그대로');
  // 전체 배포를 켜면 전체가 우선(v2.627 동작 그대로) — 그 엣지의 중앙 켜기는 가려진다
  S.saveDistribution({ enabled: true }, 'adm');
  const all = S.distributeFor('Edge-A', { verified: true });
  assert.equal(all.mode, 'all'); assert.deepEqual(Object.keys(all.settings.corps), ['vc-other']); assert.equal(all.settings.enabled, false);
  assert.deepEqual(S.perEdgeSuperseded(), ['edge-a']);
  // 수동 편집으로 제외 + 중앙 켜기가 같이 생기면 제외가 이긴다(장비 부하를 더하지 않는 쪽) · conflict 표시
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-distribute.json'), 'utf8'));
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), JSON.stringify({ ...raw, excluded: { 'EDGE-A': true } }));
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true }), { distribute: false, mode: 'excluded', reason: 'excluded', conflict: true });
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), JSON.stringify({ ...raw, enabled: false, excluded: { 'edge-a': true } }));
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true }), { distribute: false, mode: 'off', reason: 'off', conflict: true });
  assert.equal(rowOf(S.distributionStatus(['Edge-A']), 'Edge-A').conflict, true);
  // 법인 없는 항목(손으로 고친 파일)은 만들 수 없다 — 버리고 센다(조용히 켜지도 끄지도 않는다)
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), JSON.stringify({ enabled: false, perEdge: { 'edge-a': { on: true }, 'edge-b': { on: true, corps: [] }, 'edge-c': { on: true, corps: ['vc-x', 7, ' vc-x '] } } }));
  const d = S.loadDistribution();
  assert.deepEqual(Object.keys(d.perEdge), ['edge-c']); assert.deepEqual(d.perEdge['edge-c'].corps, ['vc-x']);
  assert.equal(d.perEdgeOmitted, 2); assert.equal(S.distributionStatus([]).perEdgeOmitted, 2);
  assert.ok(!JSON.stringify(d).includes('perEdgeOmitted'), '센 값은 파일에 쓰지 않는다');
  // 손상 파일 — 꺼짐(켜진 척하지 않는다) · 중앙 켜기도 없다 · 확정 라벨이 '모두 비워짐' 을 말한다
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), '{broken');
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true }), { distribute: false, mode: 'off', reason: 'off' });
  assert.match(fs.readFileSync(path.resolve(HERE, '../src/bmusage/settings.js'), 'utf8'), /label: '베어메탈 사용률 배포\(전체 배포 · 제외 · 중앙 켜기 — 기본값으로 확정하면 모두 비워집니다\)'/);
  resetDist();
});

test('④ 저장 — 제외 ↔ 중앙 켜기 · 전체 배포 · 법인 0 · 상한(too-many) · 다시 확인 · 프로토타입 이름', () => {
  resetDist(); S._resetForTest();
  S.saveDistribution({ excluded: { 'Edge-A': true } }, 'adm');
  const ex = S.setPerEdge('Edge-A', true, 'adm', { corps: ['vc-site-a'] });
  assert.equal(ex.ok, false); assert.equal(ex.conflict, 'excluded');
  S.saveDistribution({ excluded: {} }, 'adm');
  assert.equal(S.setPerEdge('Edge-A', true, 'adm', { corps: [] }).code, 'no-corps');
  assert.equal(S.setPerEdge('Edge-A', true, 'adm').code, 'no-corps');
  assert.equal(S.setPerEdge('Edge-A', true, 'adm', { corps: Array.from({ length: S.PER_EDGE_CORPS_MAX + 1 }, (_, i) => `vc-${i}`) }).code, 'too-many');
  assert.equal(S.setPerEdge('Edge-A', true, 'adm', { corps: ['vc-site-a'] }).changed, true);
  assert.equal(S.setPerEdge('edge-a', true, 'adm', { corps: ['vc-site-a'] }).changed, false, '같은 법인이면 바뀌지 않는다(대소문자 무시)');
  const re = S.setPerEdge('Edge-A', true, 'adm2', { corps: ['vc-site-a', 'vc-inv-a'] });
  assert.equal(re.changed, true, '다시 확인 — 법인 갱신');
  assert.deepEqual(S.perEdgeFor('EDGE-A').corps, ['vc-inv-a', 'vc-site-a']); assert.equal(S.perEdgeFor('Edge-A').by, 'adm2');
  assert.deepEqual(S.exclusionConflicts({ 'EDGE-A': true, 'Edge-B': true }), ['edge-a']);
  assert.deepEqual(S.exclusionConflicts({ 'edge-a': false }), []);
  // 전체 배포 켬 상태에서 새로 켜기 → 'all' 충돌
  S.saveDistribution({ enabled: true }, 'adm');
  const all = S.setPerEdge('Edge-B', true, 'adm', { corps: ['vc-site-b'] });
  assert.equal(all.ok, false); assert.equal(all.conflict, 'all');
  assert.equal(S.setPerEdge('Edge-A', false, 'adm').changed, true, '해제는 언제나 된다');
  assert.equal(S.setPerEdge('Edge-A', false, 'adm').changed, false);
  S.saveDistribution({ enabled: false }, 'adm');
  // 엣지 수 상한 — 넘는 저장은 too-many(조용히 버리지 않는다) · 이미 켠 엣지의 다시 확인은 된다
  for (let i = 0; i < S.PER_EDGE_MAX; i += 1) assert.equal(S.setPerEdge(`e-${i}`, true, 'adm', { corps: ['vc-x'] }).ok, true);
  const over = S.setPerEdge('e-over', true, 'adm', { corps: ['vc-x'] });
  assert.equal(over.ok, false); assert.equal(over.code, 'too-many');
  assert.equal(S.setPerEdge('e-0', true, 'adm', { corps: ['vc-y'] }).changed, true);
  assert.equal(Object.keys(S.loadDistribution().perEdge).length, S.PER_EDGE_MAX);
  resetDist();
  // 프로토타입 이름 — 자기 속성으로만 저장·조회 · Object.prototype 오염 없음
  for (const n of ['__proto__', 'constructor', 'toString']) assert.equal(S.setPerEdge(n, true, 'adm', { corps: ['vc-x'] }).ok, true, n);
  const d = S.loadDistribution();
  assert.deepEqual(Object.keys(d.perEdge).sort(), ['__proto__', 'constructor', 'tostring']);
  assert.equal(Object.getPrototypeOf(d.perEdge), null);
  assert.equal(({}).on, undefined, 'Object.prototype 오염 없음');
  assert.equal(S.distributeFor('hasOwnProperty', { verified: true }).reason, 'off', '상속 속성으로 켜지지 않는다');
  assert.equal(S.distributeFor('__proto__', { verified: true }).mode, 'per-edge');
  resetDist();
});

test('⑤ 상태 — 행마다 저장 법인 판의 서명 · 매핑이 바뀌면 corpsChanged(서명·인출은 그대로) · unverified · releasing · 가려짐', () => {
  resetDist(); S._resetForTest();
  const ec = src({ 'edge-a': ['vc-site-a'], 'edge-b': ['vc-site-b'] });
  S.setPerEdge('Edge-A', true, 'adm', { corps: ['vc-site-a'] });
  let st = S.distributionStatus(['Edge-A', 'Edge-B'], { edgeCorps: ec, tokenAgents: new Set(['edge-a']) });
  let a = rowOf(st, 'Edge-A');
  assert.equal(a.mode, 'per-edge'); assert.equal(a.state, 'no-pull'); assert.equal(a.perEdge, true); assert.equal(a.perEdgeBy, 'adm');
  assert.deepEqual(a.savedCorps, ['vc-site-a']); assert.deepEqual(a.corps, ['vc-site-a']); assert.equal(a.corpsChanged, false);
  assert.equal(a.tokenIssued, true); assert.equal(rowOf(st, 'Edge-B').tokenIssued, false);
  assert.equal(rowOf(st, 'Edge-B').mode, 'off'); assert.deepEqual(rowOf(st, 'Edge-B').corps, ['vc-site-b'], '켜기 전에도 그 엣지 법인을 싣는다(확인 문구)');
  assert.equal(rowOf(st, 'Edge-B').corpsChanged, false);
  assert.equal(st.perEdgeBase.enabled, true); assert.equal(st.perEdgeBase.intervalMs, 420_000); assert.equal(st.perEdgeBase.corps, undefined);
  assert.equal(st.mappingReady, undefined, '쓰지 않는 값은 싣지 않는다(F9)');
  const out = S.distributeFor('Edge-A', { verified: true });
  assert.notEqual(out.sig, st.sig, '중앙 켜기 판의 서명은 전역 서명과 다르다');
  S.recordBmUsagePull('Edge-A', { appliedSig: '', verified: true, deliveredSig: out.sig });
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: ec }), 'Edge-A').state, 'delivered');
  S.recordBmUsagePull('Edge-A', { appliedSig: out.sig, verified: true, deliveredSig: out.sig });
  a = rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: ec }), 'Edge-A');
  assert.equal(a.state, 'applied'); assert.equal(a.sig, out.sig);
  // 매핑이 바뀌거나(법인 추가) 비어도(점검중·만료) — 서명·인출은 저장 법인 그대로(적용됨 유지) · 화면만 '다시 확인' 을 받는다
  for (const m of [{ 'edge-a': ['vc-site-a', 'vc-new'] }, {}]) {
    const r = rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: src(m) }), 'Edge-A');
    assert.equal(r.state, 'applied', JSON.stringify(m)); assert.equal(r.corpsChanged, true); assert.equal(r.sig, out.sig);
  }
  assert.equal(rowOf(S.distributionStatus(['Edge-A']), 'Edge-A').corpsChanged, null, '지금 매핑을 모르면 단정하지 않는다');
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true }).settings.corps, { 'vc-site-a': true });
  // 공유 토큰 인출만 있는 엣지 — 받지 못했다
  S.setPerEdge('Edge-B', true, 'adm', { corps: ['vc-site-b'] });
  S.recordBmUsagePull('Edge-B', { verified: false, reason: 'per-edge-unverified' });
  assert.equal(rowOf(S.distributionStatus(['Edge-B'], { edgeCorps: ec }), 'Edge-B').state, 'unverified');
  // 해제 직후 — 엣지는 아직 사본을 쥐고 있다(releasing) → 다음 인출(distribute:false) 뒤 off
  S.setPerEdge('Edge-A', false, 'adm');
  st = S.distributionStatus(['Edge-A'], { edgeCorps: ec });
  assert.equal(rowOf(st, 'Edge-A').state, 'releasing'); assert.equal(rowOf(st, 'Edge-A').mode, 'off'); assert.equal(rowOf(st, 'Edge-A').corpsChanged, false);
  S.recordBmUsagePull('Edge-A', { appliedSig: out.sig, verified: true, deliveredSig: '', reason: 'off' });
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: ec }), 'Edge-A').state, 'off');
  // 전체 배포 행은 예전처럼 전역 서명과 비교한다(v2.627 동작)
  S.saveDistribution({ enabled: true }, 'adm');
  st = S.distributionStatus(['Edge-A', 'Edge-B'], { edgeCorps: ec });
  assert.equal(rowOf(st, 'Edge-A').mode, 'all'); assert.equal(rowOf(st, 'Edge-A').sig, st.sig);
  assert.equal(rowOf(st, 'Edge-B').perEdgeSuperseded, true, '전체 배포에 가려진 중앙 켜기를 밝힌다');
  // 등록부에서 빠진 이름이라도 중앙 켜기가 저장돼 있으면 행이 남는다
  S.saveDistribution({ enabled: false }, 'adm');
  assert.ok(rowOf(S.distributionStatus([], { edgeCorps: ec }), 'edge-b'), '켜 둔 지시가 화면에서 사라지지 않는다');
  resetDist(); S._resetForTest();
});

test('⑥ 실제 라우터(실제 토큰 인증) — 권한·등록부·역할(F7)·법인·화면 목록 대조·감사 · 토큰 폐기 뒤 해제(F1) · /distribute 충돌·가려짐', async () => {
  resetDist(); S._resetForTest(); asCentral();
  for (const u of ['vw', 'op', 'sadm', 'demo']) assert.equal((await put(u, '/distribute/edge', { agent: 'Edge-A', on: true })).s, 403, u);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tools/bm-usage/distribute/edge`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"agent":"Edge-A","on":true}' })).status, 401, '토큰 없음');
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Nope-Edge', on: true })).s, 404, '등록부에 없는 이름');
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Edge-A' })).s, 400, 'on 필요');
  assert.equal((await put('adm', '/distribute/edge', { agent: { toString: 'x' }, on: true })).s, 400, '글자가 아닌 이름');
  config.agent.centralUrl = 'http://central.invalid';
  const en = await put('adm', '/distribute/edge', { agent: 'Edge-A', on: true });
  assert.equal(en.s, 409); assert.equal(en.j.code, 'edge-node');
  asCentral();
  // F7 — 엣지가 아닌 노드(중앙·단독) · 역할을 모르는 노드는 켜지 않는다
  const oc2 = await put('adm', '/distribute/edge', { agent: 'OC2', on: true });
  assert.equal(oc2.s, 409); assert.equal(oc2.j.conflict, 'not-edge'); assert.equal(oc2.j.role, 'central'); assert.match(oc2.j.reason, /엣지가 아닙니다/);
  const old = await put('adm', '/distribute/edge', { agent: 'Edge-Old', on: true });
  assert.equal(old.s, 409); assert.equal(old.j.role, 'unknown'); assert.match(old.j.reason, /역할을 확인할 수 없어/);
  // 법인 0 — 400(켜도 대상이 없다) · 저장하지 않는다
  const nc = await put('adm', '/distribute/edge', { agent: 'Edge-C', on: true });
  assert.equal(nc.s, 400); assert.equal(nc.j.code, 'no-corps'); assert.equal(S.perEdgeFor('Edge-C'), null);
  // 화면이 보여 준 목록이 지금 매핑과 다르면 409 corps-changed(관리자가 본 목록 = 저장 목록)
  const cc = await put('adm', '/distribute/edge', { agent: 'Edge-A', on: true, corps: ['vc-site-a'] });
  assert.equal(cc.s, 409); assert.equal(cc.j.conflict, 'corps-changed'); assert.deepEqual(cc.j.corps, A_CORPS);
  assert.equal(S.perEdgeFor('Edge-A'), null, '거부된 요청은 저장하지 않는다');
  const ok = await put('adm', '/distribute/edge', { agent: 'edge-a', on: true, corps: [...A_CORPS].reverse() });
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.agent, 'Edge-A', '등록부 표기로 저장'); assert.equal(ok.j.changed, true); assert.deepEqual(ok.j.corps, A_CORPS);
  assert.match(ok.j.nextPull.note, /다음 인출/);
  const r = rowOf(ok.j.distribution, 'Edge-A');
  assert.equal(r.mode, 'per-edge'); assert.deepEqual(r.savedCorps, A_CORPS); assert.equal(r.corpsChanged, false); assert.equal(r.tokenIssued, true);
  const raw = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'bm-usage.distribute.edge');
  assert.ok(raw.some((e) => e.target === 'Edge-A' && e.user === 'adm' && /"on":true/.test(e.detail) && /"corpsCount":4/.test(e.detail)), JSON.stringify(raw));
  // 제외로 바꾸려 하면 409(반대 지시)
  const ex = await put('adm', '/distribute', { excluded: { 'EDGE-A': true } });
  assert.equal(ex.s, 409); assert.equal(ex.j.conflict, 'per-edge'); assert.deepEqual(ex.j.agents, ['edge-a']);
  assert.equal(S.loadDistribution().excluded['edge-a'], undefined);
  // 전체 배포를 켜면 가려진 엣지를 밝힌다 · 그 상태에서 다른 엣지 새로 켜기는 409 'all'
  const allOn = await put('adm', '/distribute', { enabled: true });
  assert.equal(allOn.s, 200); assert.deepEqual(allOn.j.perEdgeSuperseded, ['edge-a']);
  const b = await put('adm', '/distribute/edge', { agent: 'Edge-B', on: true });
  assert.equal(b.s, 409); assert.equal(b.j.conflict, 'all');
  assert.equal((await put('adm', '/distribute', { enabled: false })).s, 200);
  const off = await put('adm', '/distribute/edge', { agent: 'Edge-A', on: false });
  assert.equal(off.s, 200); assert.equal(rowOf(off.j.distribution, 'Edge-A').perEdge, false);
  // F1 — 켠 뒤 토큰을 폐기해 등록부에서 빠져도 해제는 된다(예전 404) · 다시 발급해도 켜짐을 받지 않는다
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Gone-Edge', on: true })).s, 200);
  tokens.revokeAgentToken('Gone-Edge');
  const { knownAgentNames } = await import('../src/central/knownAgents.js');
  assert.ok(!knownAgentNames().some((n) => n.toLowerCase() === 'gone-edge'), '등록부에서 빠졌다');
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Gone-Edge', on: true })).s, 404, '켜기는 여전히 등록부 이름만');
  const rel = await put('adm', '/distribute/edge', { agent: 'gone-edge', on: false });
  assert.equal(rel.s, 200, JSON.stringify(rel.j)); assert.equal(rel.j.changed, true); assert.equal(S.perEdgeFor('Gone-Edge'), null);
  assert.equal((await put('adm', '/distribute/edge', { agent: 'gone-edge', on: false })).s, 404, '지시도 등록도 없으면 404');
  const tokG = tokens.issueAgentToken('Gone-Edge').token;
  const pg = await pullAs('Gone-Edge', tokG);
  assert.deepEqual([pg.s, pg.j.distribute, pg.j.reason], [200, false, 'off'], '재발급 뒤 켜짐을 받지 않는다');
  resetDist();
});

test('⑦ 실제 엣지 인출(개별 토큰) — 적용 → 적용됨 · 매핑이 비거나 공유 토큰 fleet push 로 바뀌어도 저장 법인 그대로(F2·F3) · 해제 → 로컬 복귀', async () => {
  resetDist(); resetCopy(); S._resetForTest(); asCentral();
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Edge-A', on: true, corps: A_CORPS })).s, 200);
  // 엣지 A(개별 토큰) — 받는다
  asEdge('Edge-A', tokA);
  const r1 = await pull.pullBmUsageConfigNow();
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r1.managed, true); assert.equal(r1.changed, true);
  const copy = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-central.json'), 'utf8'));
  assert.deepEqual(Object.keys(copy.settings).sort(), [...S.DISTRIBUTED_KEYS].sort());
  // 엣지 유효 설정: 켜짐 · 저장 법인 · 중앙 주기·보존·경로·알림 · Enterprise 는 엣지 로컬
  const eff = S.loadBmUsageSettings();
  assert.equal(eff.enabled, true); assert.deepEqual(Object.keys(eff.corps).sort(), A_CORPS);
  assert.equal(eff.intervalMs, 420_000); assert.equal(eff.osSsh, false); assert.equal(eff.alertEnabled, true);
  assert.equal(eff.enterpriseMode, 'api'); assert.equal(eff.enterpriseEnabled, true);
  asCentral();
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'delivered');
  asEdge('Edge-A', tokA);
  assert.equal((await pull.pullBmUsageConfigNow()).changed, false);
  asCentral();
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'applied', '행별 서명 — 중앙 켜기 엣지도 적용됨이 된다');
  // F2 — 매핑 원천이 순간적으로 빈다(fleet 만료 · 관측 0) → 인출은 저장 법인 그대로 · 엣지는 켜진 채 · 화면은 '바뀜'
  fleet.resetEdgeFleet();
  store.snapshot = { rollups: {}, vcenters: [] };
  asEdge('Edge-A', tokA);
  const r2 = await pull.pullBmUsageConfigNow();
  assert.equal(r2.ok, true); assert.equal(r2.managed, true); assert.equal(r2.changed, false);
  assert.equal(S.loadBmUsageSettings().enabled, true); assert.deepEqual(Object.keys(S.loadBmUsageSettings().corps).sort(), A_CORPS);
  asCentral();
  let row = rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A');
  assert.equal(row.corpsChanged, true); assert.equal(row.state, 'applied'); assert.ok(!row.corps.includes('vc-direct-a'));
  // F3 — 공유 토큰 + 아는 이름으로 fleet push 가 매핑을 바꿔도(남의 직접 수집 법인) 엣지가 받는 법인은 저장 목록이다
  const fp = await fetch(`http://127.0.0.1:${port}/api/central/fleet`, { method: 'POST', headers: { 'X-Central-Token': 'ctok-2927', 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'Edge-A', baremetal: [{ name: 'bm-x', serviceTag: 'TX', vcenterId: 'vc-other' }] }) });
  assert.equal(fp.status, 200);
  row = rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A');
  assert.ok(row.corps.includes('vc-other'), '지금 매핑은 바뀌었다(정직 기록 — 공유 토큰 push 영향)'); assert.equal(row.corpsChanged, true);
  const ra = await pullAs('Edge-A', tokA, S.bmUsageCentralState().sig);   // 엣지가 지금 쥔 판을 알린다(워커와 같은 모양)
  assert.deepEqual(Object.keys(ra.j.settings.corps).sort(), A_CORPS, '엣지가 받는 법인은 저장 목록');
  store.snapshot = structuredClone(SKELETON);
  // 다른 엣지(B, 개별 토큰) — 중앙 켜기가 없으니 off
  const rb = await pullAs('Edge-B', tokB);
  assert.deepEqual([rb.j.distribute, rb.j.reason, rb.j.mode], [false, 'off', 'off']);
  // 개별 토큰 B 가 A 의 이름을 대면 미들웨어가 403
  assert.equal((await pullAs('Edge-A', tokB)).s, 403);
  // 공유 토큰이 A 의 이름을 대면 — 켜진 설정을 받지 못한다
  const rs = await pullAs('Edge-A', 'ctok-2927');
  assert.deepEqual([rs.j.distribute, rs.j.reason, rs.j.settings], [false, 'per-edge-unverified', undefined]);
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'applied', '공유 토큰 인출은 1시간 안의 검증 기록을 덮지 않는다(v2.628)');
  // 해제 → 다음 인출에 distribute:false → 엣지 로컬 설정(꺼짐)으로
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Edge-A', on: false })).s, 200);
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'releasing');
  asEdge('Edge-A', tokA);
  const rr = await pull.pullBmUsageConfigNow();
  assert.equal(rr.ok, true); assert.equal(rr.managed, false); assert.equal(rr.reason, 'off'); assert.equal(rr.changed, true);
  assert.equal(fs.existsSync(path.join(DIR, 'bmusage-central.json')), false);
  const back = S.loadBmUsageSettings();
  assert.equal(back.enabled, false); assert.deepEqual(Object.keys(back.corps), ['vc-other']); assert.equal(back.intervalMs, 420_000);
  asCentral();
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'off');
  resetDist();
});
