/**
 * v2.954(점검 D-1 · D-2 · D-3) — 중앙 → 엣지 배포 계약에서 ‘엣지 대상을 모름’ · ‘제거를 못 함’ 을 조용히 성공으로 바꾸지 않는다.
 *   D-1 정비 창 배포: 중앙 재시작 뒤(엣지 봉투 없음) 그 엣지 법인에 태그 창이 살아 있으면 — 반증 재수정: 보류(12h)는 억제를 줄이는 쓰기까지 막아 버렸다 —
 *       보류하지 않고 태그 창에 keysUnknown 을 달아 보내 엣지가 직전 배포본의 keys 를 이어 쓰게 하고, 그 엣지 봉투를 한 번 자동 인출한다 ·
 *       배포 현황은 ‘targets-unknown’(빈 keys 판을 ‘applied’ 로 보이지 않게).
 *   D-2 파트 장애 보류: 엣지 대상을 모르는 엣지 장비를 ‘대상 모름’ 으로 센다(보류하지는 않는다 — 모르는 장비를 억제하지 않는다).
 *   D-3 7b 엣지 적용: 빠진 행 제거가 실패한 판 · 적용 상태를 잃은 판에서는 새 서명을 보고하지 않는다(중앙 제거 대기 F14 가 풀리지 않게) · 실패 항목은 created 에 남는다.
 *   수정 전 판본에서 ① ② ③ ④ ⑤ 가 실패한다(빈 keys 배포 · applied · 계수 없음 · 새 서명 보고).
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 T0(고정 epoch · Date.now() 직접 비교 금지).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmedge2954-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const MIN = 60_000; const HOUR = 60 * MIN;
const T0 = Math.floor(Date.now() / HOUR) * HOUR;
const REGISTRY = [{ id: 'vcE', name: 'KR-EDGE', host: 'e.invalid', collectMode: 'site', remoteAgent: 'Edge-A' }, { id: 'vcF', name: 'KR-EDGE2', host: 'f.invalid', collectMode: 'site', remoteAgent: 'Edge-B' }];

let S; let ST; let DP; let E; let PH;
before(async () => {
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: REGISTRY }));
  const { store } = await import('../src/store.js');
  store.snapshot = { ...store.get(), vcenters: REGISTRY.map((v) => ({ id: v.id, name: v.name })) };
  S = await import('../src/bmusage/maint/schedule.js');
  ST = await import('../src/bmusage/maint/store.js');
  DP = await import('../src/bmusage/maint/deploy.js');
  E = await import('../src/central/bmUsageEdgePull.js');
  PH = await import('../src/bmusage/maint/partfaultHold.js');
});
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const loc = (ms) => S.fmtLocal('Asia/Seoul', ms).replace(' ', 'T');
const sched = () => ({ kind: 'once', start: loc(T0 - 30 * MIN), end: loc(T0 + 20 * HOUR) });

test('① D-1 — 대상을 모르면 배포는 하되 태그 창에 keysUnknown · 봉투 자동 인출(엣지별 간격) · 대상을 알면 펼쳐 배포', async () => {
  await ST.addWindow({ name: '법인 패치', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: sched(), scopes: { alerts: true } }, { by: 'own', now: T0 });
  const tag = await ST.addWindow({ name: 'DB 롤아웃', reason: 'r', target: { kind: 'tag', tag: 'role:db' }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: sched(), scopes: { alerts: true, collect: true } }, { by: 'own', now: T0 });
  assert.ok(tag?.id, JSON.stringify(tag));
  DP._resetMaintDeployForTest(); E._resetForTest();
  const pulled = [];
  DP._setAutoPullForTest(async (a) => { pulled.push(a); });
  const blind = await DP.deployFor('Edge-A', { verified: true, now: T0 });
  assert.equal(blind.distribute, true, '보류하지 않는다(억제를 줄이는 쓰기 · 다른 창까지 막지 않게 — 반증)');
  assert.equal(blind.targetsUnknown, true);
  const tw = blind.windows.find((w) => w.id === tag.id);
  assert.equal(tw.target.keysUnknown, true); assert.deepEqual(tw.target.keys, []);
  assert.ok(!blind.windows.some((w) => w.target.kind !== 'tag' && w.target.keysUnknown), '태그 창에만');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(pulled, ['Edge-A'], '봉투 자동 인출 한 번');
  await DP.deployFor('Edge-A', { verified: true, now: T0 + MIN });
  await new Promise((r) => setImmediate(r));
  assert.equal(pulled.length, 1, '간격 안에는 다시 당기지 않는다');
  await DP.deployFor('Edge-A', { verified: true, now: T0 + DP.AUTO_PULL_GAP_MS + MIN });
  await new Promise((r) => setImmediate(r));
  assert.equal(pulled.length, 2, '간격이 지나면 다시 시도');
  // 태그 창이 없는 법인의 엣지는 대상을 몰라도 그대로(자동 인출 없음)
  const other = await DP.deployFor('Edge-B', { verified: true, now: T0 });
  assert.equal(other.distribute, true); assert.equal(other.targetsUnknown, undefined);
  // 대상을 알면(봉투 인출) 펼쳐서 배포
  E.putEdgeBmUsage('Edge-A', { ok: true, snap: { targets: [{ key: 'E1', serviceTag: 'E1', vcenterId: 'vcE' }, { key: 'E2', serviceTag: 'E2', vcenterId: 'vcE' }], maintVer: 1 } });
  const FT = await import('../src/insights/fleetTags.js');
  assert.equal(FT.setFleetPurpose('e2', { role: 'db' }, { knownRoles: ['db', 'web', 'cache', 'file', 'general'] }).ok, true);
  const known = await DP.deployFor('Edge-A', { verified: true, now: T0 });
  assert.equal(known.distribute, true);
  const kw = known.windows.find((w) => w.id === tag.id);
  assert.deepEqual(kw.target.keys, ['E2']); assert.equal(kw.target.keysUnknown, undefined);
  assert.equal(known.targetsUnknown, undefined);
  DP._setAutoPullForTest(async () => {});
});

test('② D-1 — 엣지: keysUnknown 태그 창은 직전 배포본의 같은 창 keys 를 이어 쓴다(직전 판에 없던 창은 0대)', async () => {
  const live = await DP.liveWindows(ST.listWindows(), T0);
  const ctx = { live, corps: new Set(['vcE']), tagsOf: () => ['role:db'] };
  const full = DP.windowsForEdge({ ...ctx, edgeTargets: [{ key: 'E2', serviceTag: 'E2', vcenterId: 'vcE' }] });
  const blind = DP.windowsForEdge({ ...ctx, edgeTargets: [], targetsKnown: false });
  const tagId = full.find((w) => w.target.kind === 'tag').id;
  // 직전 판에 태그 창이 없으면 이어 쓸 것이 없다(0대 — 예전과 같다)
  assert.equal(ST.saveDeployed(full.filter((w) => w.target.kind !== 'tag'), { sig: 'a'.repeat(32), now: T0 }).ok, true);
  const r0 = ST.saveDeployed(blind, { sig: 'b'.repeat(32), now: T0 + MIN });
  assert.equal(r0.carried, undefined, JSON.stringify(r0));
  assert.deepEqual(ST.loadDeployed(T0 + MIN).items.find((x) => x.id === tagId).target.keys, []);
  // 직전 판에 같은 창(같은 태그)이 있으면 그 keys 를 이어 쓴다 — 빈 keys 로 억제가 꺼지지 않게
  assert.equal(ST.saveDeployed(full, { sig: 'c'.repeat(32), now: T0 + 2 * MIN }).ok, true);
  const r = ST.saveDeployed(blind, { sig: 'd'.repeat(32), now: T0 + 3 * MIN });
  assert.equal(r.carried, 1, JSON.stringify(r));
  assert.deepEqual(ST.loadDeployed(T0 + 3 * MIN).items.find((x) => x.id === tagId).target.keys, ['E2']);
});

test('③ D-1 — 배포 현황: 대상을 모르면 빈 keys 판을 적용했어도 ‘applied’ 가 아니라 ‘targets-unknown’', async () => {
  DP._resetMaintDeployForTest(); E._resetForTest();
  // 수정 전 판본이 보냈을 빈 keys 판의 서명(엣지가 그대로 적용해 보고하는 값)
  const live = await DP.liveWindows(ST.listWindows(), Date.now());
  const emptySig = DP.sigOf(DP.windowsForEdge({ live, corps: new Set(['vcE']), edgeTargets: [], tagsOf: () => [] }));
  DP.recordMaintPull('Edge-A', { appliedSig: emptySig, version: '2.954.0' });
  const view = await DP.deployStatusView([], Date.now());
  const row = view.edges.find((x) => x.agent.toLowerCase() === 'edge-a');
  assert.equal(row.status, 'targets-unknown', JSON.stringify(row));
});

test('④ D-2 — 파트 장애 보류: 대상을 모르는 엣지 장비는 ‘대상 모름’ 으로 센다(보류는 하지 않는다) · 그 법인에 hold 창이 없으면 세지 않는다', async () => {
  await ST.addWindow({ name: '보류 창', reason: 'r', target: { kind: 'corp' }, vcenterId: 'vcE', tz: 'Asia/Seoul', schedule: { kind: 'once', start: loc(Date.now() - 30 * MIN), end: loc(Date.now() + 2 * HOUR) }, scopes: { hold: true } }, { by: 'own', now: Date.now() });
  const devices = [{ agent: 'Edge-A', scope: 'idrac', deviceId: 'd1', deviceKey: 'TAGX1' }, { agent: 'Edge-A', scope: 'idrac', deviceId: 'd2', deviceKey: 'TAGX2' }, { agent: 'Edge-B', scope: 'idrac', deviceId: 'd3', deviceKey: 'TAGX3' }];
  const targets = []; targets.knownAgents = new Set();
  const corpsOf = (ag) => (ag === 'edge-a' ? ['vcE'] : ['vcF']);
  const r = await PH.partfaultMaintHold(devices, { now: Date.now(), deps: { targets, corpsOf, audit: async () => null } });
  assert.equal(r.hold.size, 0, '모르는 장비는 보류하지 않는다');
  assert.deepEqual(r.targetsUnknown, { agents: ['edge-a'], devices: 2 }, JSON.stringify(r));
  // 대상을 아는 엣지(봉투에 장비가 없음)는 ‘모름’ 이 아니다
  const t2 = []; t2.knownAgents = new Set(['edge-a']);
  const r2 = await PH.partfaultMaintHold(devices, { now: Date.now(), deps: { targets: t2, corpsOf, audit: async () => null } });
  assert.equal(r2.targetsUnknown, undefined);
});

/* ───────────── D-3 — 7b 엣지 적용 ───────────── */
const corps = [{ id: 'vcE', name: 'KR-EDGE' }];
const row = (name, ip) => ({ name, corp: 'vcE', osHost: ip, osUser: 'mon', osKey: 'password', mounts: ['/'], enabled: true });
const APPLIED = () => path.join(DIR, 'bm-onboard-applied.json');

test('⑤ D-3 ① — 빠진 행 제거가 실패한 판은 새 서명을 보고하지 않고 실패 항목을 created 에 남긴다 · 다음 판에 다시 지운다', async () => {
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  const RUN = await import('../src/bmusage/onboard/onboardRun.js');
  const BM = await import('../src/bmstor/registry.js');
  const D = await RUN.defaultOnboardDeps();
  const s1 = '1'.repeat(32); const s2 = '2'.repeat(32);
  const a = await EA.applyEdgeDeployment([row('d3a', '10.91.0.1')], { sig: s1, D, corps, myCorps: ['vcE'], pending: [] });
  assert.equal(a.ok, true, JSON.stringify(a));
  const id = BM.listBmServersRaw().find((x) => x.name === 'd3a')?.id;
  assert.ok(id); assert.equal(EA.readAppliedState().state.sig, s1);
  const Dfail = { ...D, BM: { ...D.BM, applyBmServerBatch: () => ({ ok: false, reason: 'ENOSPC' }) } };
  const f = await EA.applyEdgeDeployment([], { sig: s2, D: Dfail, corps, myCorps: ['vcE'], pending: ['d3a'] });
  assert.equal(f.ok, false, JSON.stringify(f));
  const st = EA.readAppliedState().state;
  assert.notEqual(st.sig, s2, '제거하지 못한 판의 서명을 보고하면 중앙 제거 대기가 풀린다');
  assert.equal(st.created.d3a?.os, id, '실패 항목은 created 에 남는다');
  const g = await EA.applyEdgeDeployment([], { sig: s2, D, corps, myCorps: ['vcE'], pending: ['d3a'] });
  assert.equal(g.ok, true, JSON.stringify(g)); assert.ok(g.removed >= 1);
  assert.equal(BM.listBmServersRaw().some((x) => x.name === 'd3a'), false);
  assert.equal(EA.readAppliedState().state.sig, s2);
});

test('⑥ D-3 ② — 적용 상태 파일을 잃은 판부터는 중앙 제거 대기가 엣지에 남아 있는 동안 서명을 보고하지 않는다 · 남은 것이 없으면 보고', async () => {
  const EA = await import('../src/bmusage/onboard/edgeApply.js');
  const RUN = await import('../src/bmusage/onboard/onboardRun.js');
  const BM = await import('../src/bmstor/registry.js');
  const D = await RUN.defaultOnboardDeps();
  const s3 = '3'.repeat(32); const s4 = '4'.repeat(32);
  assert.equal((await EA.applyEdgeDeployment([row('d3b', '10.91.0.2')], { sig: s3, D, corps, myCorps: ['vcE'], pending: [] })).ok, true);
  fs.writeFileSync(APPLIED(), '{broken');   // 손상 — 만든 항목 목록을 잃는다
  const r = await EA.applyEdgeDeployment([], { sig: s4, D, corps, myCorps: ['vcE'], pending: ['d3b'] });
  assert.equal(r.lost, true, JSON.stringify(r));
  assert.ok(BM.listBmServersRaw().some((x) => x.name === 'd3b'), '목록을 잃었으니 지우지 않는다(손으로 둔 것일 수 있다)');
  assert.equal(EA.readAppliedState().state.sig, '', '중앙에 새 서명을 보고하지 않는다');
  // 같은 판 다시(구 중앙 — pending 없음): 확인할 수 없으니 계속 보고하지 않는다
  await EA.applyEdgeDeployment([], { sig: s4, D, corps, myCorps: ['vcE'], pending: null });
  assert.equal(EA.readAppliedState().state.sig, '');
  // 엣지 관리자가 남은 항목을 정리 → 다음 인출에 확인되면 보고
  BM.removeBmServer(BM.listBmServersRaw().find((x) => x.name === 'd3b').id);
  const ok = await EA.applyEdgeDeployment([], { sig: s4, D, corps, myCorps: ['vcE'], pending: ['d3b'] });
  assert.equal(ok.skipped, true);
  assert.equal(EA.readAppliedState().state.sig, s4);
});

test('⑦ D-3 — 중앙 배포 응답에 그 엣지의 제거 대기 이름이 실린다(이름만)', async () => {
  const ED = await import('../src/bmusage/onboard/edgeDeploy.js');
  ED._resetEdgeDeployForTest();
  assert.equal(ED.applyEdgeChanges({ upserts: [{ agent: 'edge-p', row: { name: 'pa', corp: 'vcE', osHost: '10.92.0.1', osUser: 'mon', osKey: 'password', mounts: ['/'] } }] }, { by: 'own' }).ok, true);
  assert.equal(ED.applyEdgeChanges({ removes: [{ agent: 'edge-p', name: 'pa' }] }, { by: 'own' }).ok, true);
  const out = ED.deployFor('edge-p', { verified: true });
  assert.deepEqual(out.pending, ['pa']);
  assert.equal(ED.deployFor('edge-p', { verified: false }).pending, undefined, '검증 안 된 이름에는 주지 않는다');
});
