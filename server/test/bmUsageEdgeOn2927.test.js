/**
 * test/bmUsageEdgeOn2927.test.js — 베어메탈 사용률 '중앙에서 켜기'(v2.927 · 사용자 요청 "중앙에서 엣지를 켜는 기능 추가").
 *
 * 한 프로세스가 중앙(실제 centralRouter · 실제 api 라우터)과 엣지(실제 pullBmUsageConfigNow — 엣지 코드는 바꾸지 않았다)를 겸한다
 * (v2.627 test/bmUsageDistribute2627.test.js 와 같은 방식 — bmusage-settings.json = 중앙 원본이자 엣지 로컬 · bmusage-central.json = 엣지 사본).
 * 고정하는 것:
 *  ① 매핑 — 사이트 vCenter(collectedBy) + 엣지 보고 베어메탈(중앙 목록에 있는 id 만 · 다른 엣지 소유 사이트 vCenter 제외) · 대소문자 무시
 *     · 사이트 규칙은 targets.js 한 곳(소스 스윕 — 두 벌 금지)
 *  ② 내려가는 판 = 중앙 로컬 배포 키 **전부** + 켜기 true + 그 엣지 법인(구버전 엣지가 빠진 키를 기본값으로 채우지 않게) · Enterprise 없음
 *  ③ 모드 — 전체(제외 아님) > 중앙 켜기 > 제외/꺼짐 · 공유 토큰 = per-edge-unverified · 매핑 준비 전 hold · 법인 0 = no-corps · 수동 충돌 = 제외 우선
 *  ④ 저장 충돌 — 제외 ↔ 중앙 켜기 양방향 409 · 전체 배포가 덮는 엣지 409 · 전체 배포를 켜면 가려진 엣지를 밝힌다 · 프로토타입 이름
 *  ⑤ 상태 — 행마다 그 엣지 판의 서명으로 적용됨/전달됨/대기 · unverified · releasing
 *  ⑥ 실제 라우터 — viewer·operator 403 · 범위 admin 403 · 등록부에 없는 이름 404 · 엣지 노드 409 · admin 200 + 감사
 *  ⑦ 실제 엣지 인출 — 개별 토큰: 적용(엣지 유효 설정 = 켜짐 · 그 법인 · 중앙 주기 · Enterprise 는 로컬) → 적용됨 · 다른 엣지·공유 토큰은 못 받음
 *     · 매핑 준비 전 503(사본 유지) · 해제 → 다음 인출에 로컬 복귀 · 법인 0 → 로컬
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
process.env.CONFIG_DIR = DIR;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2927';
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'mock';
delete process.env.BMUSAGE_ENABLED;
delete process.env.CENTRAL_URL;

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
let srv; let port; let config; let S; let pull; let store; let T; let EC; let fleet; let audit; let tokA; let tokB;
const LOCAL = { enabled: false, corps: { 'vc-other': true }, intervalMs: 420_000, rawRetentionDays: 60, dailyRetentionDays: 400, osSsh: false,
  idracTelemetry: true, idracFullTelemetry: false, includeVirtualization: true, alertEnabled: true, alertPct: 85,
  enterpriseEnabled: true, enterpriseAck: true, enterpriseMode: 'api' };
const SNAP = { rollups: {}, hosts: [], vms: [], vcenters: [
  { id: 'vc-site-a', name: '법인A', collectSource: 'site', collectedBy: 'Edge-A' },
  { id: 'vc-site-b', name: '법인B', collectSource: 'site', collectedBy: 'Edge-B' },
  { id: 'vc-direct-a', name: '법인A-직접' },
  { id: 'vc-other', name: '중앙 법인' },
] };

before(async () => {
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify(LOCAL));
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { api } = await import('../src/routes/api.js');
  ({ config } = await import('../src/config.js'));
  ({ store } = await import('../src/store.js'));
  S = await import('../src/bmusage/settings.js');
  T = await import('../src/bmusage/targets.js');
  EC = await import('../src/bmusage/edgeCorps.js');
  fleet = await import('../src/central/fleet.js');
  audit = await import('../src/audit.js');
  pull = await import('../src/agent/bmUsageConfigPull.js');
  const tokens = await import('../src/central/agentTokens.js');
  tokA = tokens.issueAgentToken('Edge-A').token;
  tokB = tokens.issueAgentToken('Edge-B').token;
  const USERS = {
    adm: { username: 'adm', role: 'admin', scope: null },
    op: { username: 'op', role: 'operator', scope: null },
    viewer: { username: 'v', role: 'viewer', scope: null },
    sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-site-a'] } },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/central', centralRouter);
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = http.createServer(app);
  port = await listen(srv);
  store.snapshot = structuredClone(SNAP);
  fleet.setEdgeFleet('Edge-A', [
    { name: 'bm-a1', serviceTag: 'TA1', vcenterId: 'vc-direct-a' },
    { name: 'bm-a2', serviceTag: 'TA2', vcenterId: 'vc-site-b' },   // 다른 엣지(Edge-B) 소유 사이트 vCenter — 넣지 않는다
    { name: 'bm-a3', serviceTag: 'TA3', vcenterId: 'vc-unknown' },  // 중앙 목록에 없는 id — 넣지 않는다
  ], Date.now(), { verified: true });
  config.agent.centralUrl = '';
});
after(() => { try { srv?.close(); } catch { /* */ } fs.rmSync(DIR, { recursive: true, force: true }); });

const asEdge = (name, token) => { config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = token; config.agent.name = name; };
const asCentral = () => { config.agent.centralUrl = ''; };
const put = (u, p, body) => fetch(`http://127.0.0.1:${port}/api/tools/bm-usage${p}`, { method: 'PUT', headers: { 'x-u': u, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
const rowOf = (dist, name) => (dist?.rows || []).find((x) => x.agent.toLowerCase() === name.toLowerCase());
const resetDist = () => { for (const f of fs.readdirSync(DIR)) if (f.startsWith('bmusage-distribute.json')) fs.rmSync(path.join(DIR, f)); };
const resetCopy = () => { fs.rmSync(path.join(DIR, 'bmusage-central.json'), { force: true }); };
const src = (map, ready = true) => (agent) => ({ ready, ids: map[String(agent).toLowerCase()] || [] });

test('① 매핑 — 사이트 vCenter + 엣지 보고 베어메탈(목록에 있는 id · 남의 사이트 vCenter 제외) · 대소문자 무시 · 사이트 규칙은 한 곳', () => {
  const bm = fleet.getEdgeFleetServers();
  const idx = T.edgeCorpIndex({ vcenters: SNAP.vcenters, bareMetal: bm });
  assert.deepEqual(T.edgeCorpIds({ agent: 'edge-a' }, idx), ['vc-direct-a', 'vc-site-a']);
  assert.deepEqual(T.edgeCorpIds({ agent: 'EDGE-B' }, idx), ['vc-site-b']);
  assert.deepEqual(T.edgeCorpIds({ agent: 'nobody' }, idx), []);
  assert.deepEqual(T.edgeCorpIds({ vcenters: [{ id: 'x', collectMode: 'site', agent: 'E' }], bareMetal: [{ remoteAgent: { toString: () => 'E' }, vcenterId: 'x' }, null, 'str'], agent: 'e' }), ['x'], 'collectMode·agent 도 같은 규칙 · 글자가 아닌 remoteAgent·원소는 무시');
  // 실제 매핑 원천(edgeCorpsSource)도 같은 값 · 골격 스냅샷이면 ready:false
  const live = EC.edgeCorpsSource();
  assert.deepEqual(live('Edge-A'), { ready: true, ids: ['vc-direct-a', 'vc-site-a'] });
  const saved = store.snapshot;
  store.snapshot = { ...structuredClone(SNAP), initial: true };
  assert.equal(EC.edgeCorpsSource()('Edge-A').ready, false, '첫 병합 전 골격은 모른다');
  store.snapshot = { vcenters: [], rollups: null };
  assert.equal(EC.edgeCorpsSource()('Edge-A').ready, false, '첫 수집 전 빈 스냅샷도 모른다');
  assert.equal(EC.edgeCorpsSource({ now: Date.now() + EC.MAPPING_HOLD_MAX_MS + 1 })('Edge-A').ready, true, '보류에는 시한이 있다');
  store.snapshot = saved;
  // 소스 스윕 — 사이트 위임 규칙 문자열은 bmusage/ 안에서 targets.js 의 한 곳뿐(두 벌 금지)
  const dir = path.resolve(HERE, '../src/bmusage');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const n = (fs.readFileSync(path.join(dir, f), 'utf8').match(/collectSource === 'site' \|\| v\.collectMode === 'site'/g) || []).length;
    if (n) hits.push(`${f}:${n}`);
  }
  assert.deepEqual(hits, ['targets.js:1']);
  const tsrc = fs.readFileSync(path.join(dir, 'targets.js'), 'utf8');
  assert.match(tsrc, /const siteAgent = siteAgentByVcenter\(vcenters\);/, 'resolveTargets 가 같은 함수를 쓴다');
  assert.match(fs.readFileSync(path.join(dir, 'edgeCorps.js'), 'utf8'), /import \{ edgeCorpIndex, edgeCorpIds \} from '\.\/targets\.js'/);
});

test('② 내려가는 판 — 중앙 로컬 배포 키 전부 · 켜기 true · 그 엣지 법인 · Enterprise 없음', () => {
  const s = S.perEdgeSettings(S.loadLocalBmUsageSettings(), ['vc-site-a', 'vc-direct-a']);
  assert.deepEqual(Object.keys(s).sort(), [...S.DISTRIBUTED_KEYS].sort(), '배포 키 전부(일부만 보내면 구버전 엣지가 나머지를 기본값으로 덮는다)');
  assert.equal(s.enabled, true);
  assert.deepEqual(Object.keys(s.corps).sort(), ['vc-direct-a', 'vc-site-a']);
  assert.equal(s.corps['vc-other'], undefined, '다른 법인은 보내지 않는다');
  assert.equal(s.intervalMs, 420_000); assert.equal(s.rawRetentionDays, 60); assert.equal(s.osSsh, false); assert.equal(s.alertPct, 85);
  assert.equal(s.idracFullTelemetry, false); assert.equal(s.includeVirtualization, true);
  for (const k of Object.keys(s)) assert.ok(!/^enterprise/.test(k), k);
});

test('③ 모드 — 전체 > 중앙 켜기 > 제외/꺼짐 · 공유 토큰 · 매핑 준비 전 · 법인 0 · 수동 충돌은 제외 우선', () => {
  resetDist(); S._resetForTest();
  const ec = src({ 'edge-a': ['vc-site-a'] });
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true, edgeCorps: ec }), { distribute: false, mode: 'off', reason: 'off' });
  assert.equal(S.setPerEdge('Edge-A', true, 'adm').ok, true);
  const on = S.distributeFor('edge-a', { verified: true, edgeCorps: ec });
  assert.equal(on.distribute, true); assert.equal(on.mode, 'per-edge');
  assert.deepEqual(Object.keys(on.settings.corps), ['vc-site-a']);
  assert.equal(on.sig, S.settingsSig(on.settings));
  assert.deepEqual(S.distributeFor('Edge-A', { verified: false, edgeCorps: ec }), { distribute: false, mode: 'per-edge', reason: 'per-edge-unverified' }, '공유 토큰(이름 미검증)에는 내주지 않는다');
  assert.equal(S.distributeFor('Edge-A', { verified: true }).hold, true, '매핑 함수가 없으면 모른다(hold)');
  assert.equal(S.distributeFor('Edge-A', { verified: true, edgeCorps: src({}, false) }).hold, true);
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true, edgeCorps: src({}) }), { distribute: false, mode: 'per-edge', reason: 'no-corps' });
  assert.equal(S.distributeFor('Edge-B', { verified: true, edgeCorps: ec }).reason, 'off', '다른 엣지는 그대로');
  // 전체 배포를 켜면 전체가 우선(v2.627 동작 그대로) — 그 엣지의 중앙 켜기는 가려진다
  S.saveDistribution({ enabled: true }, 'adm');
  const all = S.distributeFor('Edge-A', { verified: true, edgeCorps: ec });
  assert.equal(all.mode, 'all'); assert.deepEqual(Object.keys(all.settings.corps), ['vc-other']); assert.equal(all.settings.enabled, false);
  assert.deepEqual(S.perEdgeSuperseded(), ['edge-a']);
  // 수동 편집으로 제외 + 중앙 켜기가 같이 생기면 제외가 이긴다(장비 부하를 더하지 않는 쪽) · conflict 표시
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-distribute.json'), 'utf8'));
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), JSON.stringify({ ...raw, excluded: { 'EDGE-A': true } }));
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true, edgeCorps: ec }), { distribute: false, mode: 'excluded', reason: 'excluded', conflict: true });
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), JSON.stringify({ ...raw, enabled: false, excluded: { 'edge-a': true } }));
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true, edgeCorps: ec }), { distribute: false, mode: 'off', reason: 'off', conflict: true });
  const st = S.distributionStatus(['Edge-A'], { edgeCorps: ec });
  assert.equal(rowOf(st, 'Edge-A').conflict, true);
  // 손상 파일 — 꺼짐(켜진 척하지 않는다) · 중앙 켜기도 없다
  fs.writeFileSync(path.join(DIR, 'bmusage-distribute.json'), '{broken');
  assert.deepEqual(S.distributeFor('Edge-A', { verified: true, edgeCorps: ec }), { distribute: false, mode: 'off', reason: 'off' });
  resetDist();
});

test('④ 저장 충돌 — 제외 ↔ 중앙 켜기 · 전체 배포가 덮는 엣지 · 프로토타입 이름', () => {
  resetDist(); S._resetForTest();
  S.saveDistribution({ excluded: { 'Edge-A': true } }, 'adm');
  const ex = S.setPerEdge('Edge-A', true, 'adm');
  assert.equal(ex.ok, false); assert.equal(ex.conflict, 'excluded');
  S.saveDistribution({ excluded: {} }, 'adm');
  assert.equal(S.setPerEdge('Edge-A', true, 'adm').changed, true);
  assert.equal(S.setPerEdge('edge-a', true, 'adm').changed, false, '같은 지시는 바뀌지 않는다(대소문자 무시)');
  assert.deepEqual(S.exclusionConflicts({ 'EDGE-A': true, 'Edge-B': true }), ['edge-a']);
  assert.deepEqual(S.exclusionConflicts({ 'edge-a': false }), []);
  // 전체 배포 켬 상태에서 새로 켜기 → 'all' 충돌
  S.saveDistribution({ enabled: true }, 'adm');
  const all = S.setPerEdge('Edge-B', true, 'adm');
  assert.equal(all.ok, false); assert.equal(all.conflict, 'all');
  assert.equal(S.setPerEdge('Edge-A', false, 'adm').changed, true, '해제는 언제나 된다');
  assert.equal(S.setPerEdge('Edge-A', false, 'adm').changed, false);
  S.saveDistribution({ enabled: false }, 'adm');
  // 프로토타입 이름 — 자기 속성으로만 저장·조회 · Object.prototype 오염 없음
  for (const n of ['__proto__', 'constructor', 'toString']) assert.equal(S.setPerEdge(n, true, 'adm').ok, true, n);
  const d = S.loadDistribution();
  assert.deepEqual(Object.keys(d.perEdge).sort(), ['__proto__', 'constructor', 'tostring']);
  assert.equal(Object.getPrototypeOf(d.perEdge), null);
  assert.equal(({}).on, undefined, 'Object.prototype 오염 없음');
  assert.equal(S.distributeFor('hasOwnProperty', { verified: true, edgeCorps: src({ hasownproperty: ['x'] }) }).reason, 'off', '상속 속성으로 켜지지 않는다');
  assert.equal(S.distributeFor('__proto__', { verified: true, edgeCorps: src({ __proto__: null, ['__proto__']: ['vc-x'] }) }).mode, 'per-edge');
  const bad = S.normalizeDistribution({ perEdge: { a: { on: 'true' }, b: { on: true, at: 'x', by: { x: 1 } }, '': { on: true } } });
  assert.deepEqual(Object.keys(bad.perEdge), ['b'], "on 은 true 만 · 빈 이름 제외");
  assert.equal(bad.perEdge.b.at, 0);
  resetDist();
});

test('⑤ 상태 — 행마다 그 엣지 판의 서명으로 비교(전역 서명 하나와 비교하면 영원히 대기) · unverified · releasing', () => {
  resetDist(); S._resetForTest();
  const ec = src({ 'edge-a': ['vc-site-a'], 'edge-b': ['vc-site-b'] });
  S.setPerEdge('Edge-A', true, 'adm');
  let st = S.distributionStatus(['Edge-A', 'Edge-B'], { edgeCorps: ec, tokenAgents: new Set(['edge-a']) });
  let a = rowOf(st, 'Edge-A');
  assert.equal(a.mode, 'per-edge'); assert.equal(a.state, 'no-pull'); assert.equal(a.perEdge, true); assert.equal(a.perEdgeBy, 'adm');
  assert.deepEqual(a.corps, ['vc-site-a']); assert.equal(a.tokenIssued, true); assert.equal(rowOf(st, 'Edge-B').tokenIssued, false);
  assert.equal(rowOf(st, 'Edge-B').mode, 'off'); assert.deepEqual(rowOf(st, 'Edge-B').corps, ['vc-site-b'], '켜기 전에도 그 엣지 법인을 싣는다(확인 문구)');
  assert.equal(st.perEdgeBase.enabled, true); assert.equal(st.perEdgeBase.intervalMs, 420_000); assert.equal(st.perEdgeBase.corps, undefined);
  const out = S.distributeFor('Edge-A', { verified: true, edgeCorps: ec });
  assert.notEqual(out.sig, st.sig, '중앙 켜기 판의 서명은 전역 서명과 다르다');
  S.recordBmUsagePull('Edge-A', { appliedSig: '', verified: true, deliveredSig: out.sig });
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: ec }), 'Edge-A').state, 'delivered');
  S.recordBmUsagePull('Edge-A', { appliedSig: out.sig, verified: true, deliveredSig: out.sig });
  a = rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: ec }), 'Edge-A');
  assert.equal(a.state, 'applied'); assert.equal(a.sig, out.sig);
  // 매핑이 바뀌면(법인 추가) 서명이 바뀌어 '대기'
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: src({ 'edge-a': ['vc-site-a', 'vc-new'] }) }), 'Edge-A').state, 'pending');
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: src({}, false) }), 'Edge-A').state, 'not-ready');
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: src({}) }), 'Edge-A').state, 'no-corps');
  // 공유 토큰 인출만 있는 엣지 — 받지 못했다
  S.setPerEdge('Edge-B', true, 'adm');
  S.recordBmUsagePull('Edge-B', { verified: false, reason: 'per-edge-unverified' });
  assert.equal(rowOf(S.distributionStatus(['Edge-B'], { edgeCorps: ec }), 'Edge-B').state, 'unverified');
  // 해제 직후 — 엣지는 아직 사본을 쥐고 있다(releasing) → 다음 인출(distribute:false) 뒤 off
  S.setPerEdge('Edge-A', false, 'adm');
  st = S.distributionStatus(['Edge-A'], { edgeCorps: ec });
  assert.equal(rowOf(st, 'Edge-A').state, 'releasing'); assert.equal(rowOf(st, 'Edge-A').mode, 'off');
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

test('⑥ 실제 라우터 — PUT /distribute/edge 권한·등록부·엣지 노드·감사 · PUT /distribute 제외 충돌·가려짐', async () => {
  resetDist(); S._resetForTest(); asCentral();
  assert.equal((await put('viewer', '/distribute/edge', { agent: 'Edge-A', on: true })).s, 403);
  assert.equal((await put('op', '/distribute/edge', { agent: 'Edge-A', on: true })).s, 403, 'operator 도 막는다(adminOnly)');
  assert.equal((await put('sadm', '/distribute/edge', { agent: 'Edge-A', on: true })).s, 403, '범위 admin 은 막는다(fleetOnly)');
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Nope-Edge', on: true })).s, 404, '등록부에 없는 이름');
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Edge-A' })).s, 400, 'on 필요');
  assert.equal((await put('adm', '/distribute/edge', { agent: { toString: 'x' }, on: true })).s, 400, '글자가 아닌 이름');
  config.agent.centralUrl = 'http://central.invalid';
  const en = await put('adm', '/distribute/edge', { agent: 'Edge-A', on: true });
  assert.equal(en.s, 409); assert.equal(en.j.code, 'edge-node');
  asCentral();
  assert.equal(S.loadDistribution().perEdge['edge-a'], undefined, '거부된 요청은 저장하지 않는다');
  const ok = await put('adm', '/distribute/edge', { agent: 'edge-a', on: true });
  assert.equal(ok.s, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.agent, 'Edge-A', '등록부 표기로 저장'); assert.equal(ok.j.changed, true);
  assert.match(ok.j.nextPull.note, /다음 인출/);
  const r = rowOf(ok.j.distribution, 'Edge-A');
  assert.equal(r.mode, 'per-edge'); assert.equal(r.perEdge, true); assert.deepEqual(r.corps, ['vc-direct-a', 'vc-site-a']); assert.equal(r.tokenIssued, true);
  const a1 = audit.auditEntriesWithAction('bm-usage.distribute.edge');
  assert.ok(a1.some((x) => /"agent":"Edge-A"/.test(x.detail) && /"on":true/.test(x.detail) && x.user === 'adm'), JSON.stringify(a1));
  const rawAudit = fs.readFileSync(path.join(DIR, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === 'bm-usage.distribute.edge');
  assert.ok(rawAudit.some((e) => e.target === 'Edge-A'), '감사 target = 등록부 표기의 엣지 이름');
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
  assert.ok(audit.auditEntriesWithAction('bm-usage.distribute.edge').some((x) => /"on":false/.test(x.detail)));
  resetDist();
});

test('⑦ 실제 엣지 인출(개별 토큰) — 적용 → 적용됨 · 다른 엣지·공유 토큰은 못 받음 · 준비 전 503 사본 유지 · 해제·법인 0 → 로컬 복귀', async () => {
  resetDist(); resetCopy(); S._resetForTest(); asCentral();
  assert.equal((await put('adm', '/distribute/edge', { agent: 'Edge-A', on: true })).s, 200);
  // 엣지 A(개별 토큰) — 받는다
  asEdge('Edge-A', tokA);
  const r1 = await pull.pullBmUsageConfigNow();
  assert.equal(r1.ok, true, JSON.stringify(r1)); assert.equal(r1.managed, true); assert.equal(r1.changed, true);
  const copy = JSON.parse(fs.readFileSync(path.join(DIR, 'bmusage-central.json'), 'utf8'));
  assert.deepEqual(Object.keys(copy.settings).sort(), [...S.DISTRIBUTED_KEYS].sort());
  // 엣지 유효 설정: 켜짐 · 그 법인 · 중앙 주기·보존·경로·알림 · Enterprise 는 엣지 로컬
  const eff = S.loadBmUsageSettings();
  assert.equal(eff.enabled, true); assert.deepEqual(Object.keys(eff.corps).sort(), ['vc-direct-a', 'vc-site-a']);
  assert.equal(eff.intervalMs, 420_000); assert.equal(eff.osSsh, false); assert.equal(eff.alertEnabled, true);
  assert.equal(eff.enterpriseMode, 'api'); assert.equal(eff.enterpriseEnabled, true);
  asCentral();
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'delivered');
  asEdge('Edge-A', tokA);
  assert.equal((await pull.pullBmUsageConfigNow()).changed, false);
  asCentral();
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'applied', '행별 서명 — 중앙 켜기 엣지도 적용됨이 된다');
  // 다른 엣지(B, 개별 토큰) — 중앙 켜기가 없으니 off
  const rb = await (await fetch(`http://127.0.0.1:${port}/api/central/bmusage-config?agent=Edge-B`, { headers: { 'X-Central-Token': tokB } })).json();
  assert.deepEqual([rb.distribute, rb.reason, rb.mode], [false, 'off', 'off']);
  // 개별 토큰 B 가 A 의 이름을 대면 미들웨어가 403
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/central/bmusage-config?agent=Edge-A`, { headers: { 'X-Central-Token': tokB } })).status, 403);
  // 공유 토큰이 A 의 이름을 대면 — 켜진 설정을 받지 못한다
  const rs = await (await fetch(`http://127.0.0.1:${port}/api/central/bmusage-config?agent=Edge-A`, { headers: { 'X-Central-Token': 'ctok-2927' } })).json();
  assert.deepEqual([rs.distribute, rs.reason, rs.settings], [false, 'per-edge-unverified', undefined]);
  assert.equal(rowOf(S.distributionStatus(['Edge-A'], { edgeCorps: EC.edgeCorpsSource() }), 'Edge-A').state, 'applied', '공유 토큰 인출은 1시간 안의 검증 기록을 덮지 않는다(v2.628)');
  // 매핑 준비 전(중앙 기동 직후 골격) — 503 · 엣지는 사본 유지
  store.snapshot = { ...structuredClone(SNAP), initial: true };
  asEdge('Edge-A', tokA);
  const r503 = await pull.pullBmUsageConfigNow();
  assert.equal(r503.ok, false); assert.match(r503.error, /503/); assert.equal(r503.keptCopy, true);
  assert.equal(S.loadBmUsageSettings().enabled, true, '사본 유지 — 켜진 채');
  store.snapshot = structuredClone(SNAP);
  // 법인 0(매핑이 사라짐) → no-corps → 엣지가 사본을 지운다(켜도 대상이 없다)
  store.snapshot = { ...structuredClone(SNAP), vcenters: SNAP.vcenters.filter((v) => v.id !== 'vc-site-a' && v.id !== 'vc-direct-a') };
  const rn = await pull.pullBmUsageConfigNow();
  assert.equal(rn.ok, true); assert.equal(rn.managed, false); assert.equal(rn.reason, 'no-corps');
  store.snapshot = structuredClone(SNAP);
  assert.equal((await pull.pullBmUsageConfigNow()).managed, true, '매핑이 돌아오면 다시 받는다');
  // 해제 → 다음 인출에 distribute:false → 엣지 로컬 설정(꺼짐)으로
  asCentral();
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
