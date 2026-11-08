/**
 * 다음 점검 ①(2차) — 반증(F1~F5) · 사용자 결정 회귀(실제 api 라우터 · 실제 분류 · 실제 대상 해석).
 *   사용자 결정(2026-11-08): "겹치는 노드의 IP · hostname · service tag 등을 수집해서 사용자가 추가할지 여부를 결정"
 *   ① 반증 r0b — 가상화 호스트 동명(서비스태그 없음 · 다른 vCenter)이 예전에는 사유 없이 빠졌다 → 겹침 목록 · 결정 ‘추가’ 면 별도 키로 대상
 *   ② 겹침 목록 · 결정 API — 범위(범위 밖 법인 행 · 상대는 이름도 개수도 없음) · 주소는 관리자 판본만 · 조회 밖 404 → 쓰기 밖 403 · 추가 → 별도 키로 수집 대상 ·
 *      키 겹침 409 · 제외 유지 · 되돌리기 · 기록만 남은 결정 되돌리기 · 손상 파일 503 + 결정 미적용 · 감사
 *   ③ 반증 r1 · r1b(F2) — 용도 태그: A 쓰기 뒤 B 판정 불변 · B 해제가 A 를 지우지 않음 · 예전 키 행은 범위 밖 법인에도 걸리면 409 · 전체 범위는 법인별로 나눠 옮김 · 계정명
 *   ④ 반증 r2(F3) — 범위 계정의 키 충돌 수는 보이는 줄로 · peers 없음
 *   ⑤ 반증 r3(F4) — 귀속 없음 후보는 노드까지 갈라 ‘-@노드’ 로 고른다(사유 수 = 후보 수)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmkeyovl-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.SETTINGS_OWNERS = 'own';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const USERS = {
  adm: { username: 'adm', role: 'admin', scope: null },
  admA: { username: 'adma', role: 'admin', scope: { vcenters: ['vcA'] } },
  admB: { username: 'admb', role: 'admin', scope: { vcenters: ['vcB'] } },
  opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
  opB: { username: 'opb', role: 'operator', scope: { vcenters: ['vcB'] } },
  opABwA: { username: 'opabwa', role: 'operator', scope: { vcenters: ['vcA', 'vcB'], writeVcenters: ['vcA'] } },
  vw: { username: 'vw', role: 'viewer', scope: null },
};
let _srv = null;
async function app(t) {
  const { store } = await import('../src/store.js');
  store.set?.({ ...store.get(), vcenters: [{ id: 'vcA', name: 'A 법인' }, { id: 'vcB', name: 'B 법인' }] });
  if (!_srv) {
    const express = (await import('express')).default;
    const { api } = await import('../src/routes/api.js');
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
    a.use('/api', api);
    const srv = await new Promise((r) => { const s = a.listen(0, '127.0.0.1', () => r(s)); });
    _srv = { srv, base: `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage` };
  }
  const call = async (u, method, p, body) => {
    const r = await fetch(`${_srv.base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { call };
}
test.after(() => { _srv?.srv.close(); });

/** 공통 태그 두 대(vcA · vcB) — 실제 classifyFleet 이 vcB 를 bareMetalDupes 로 남긴다(반증 r0). */
async function junkFleet(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [
    { id: 'r-a1', name: 'wb-a1', host: 'https://10.20.0.11', username: 'u', password: 'p', vcenterId: 'vcA', serviceTag: 'To Be Filled By O.E.M.' },
    { id: 'r-b1', name: 'wb-b1', host: 'https://10.20.0.12', username: 'u', password: 'p', vcenterId: 'vcB', serviceTag: 'To Be Filled By O.E.M.' },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: false, idracTelemetry: true }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const poller = await import('../src/bmusage/poller.js');
  const { classifyFleet } = await import('../src/insights/fleetInventory.js');
  const servers = [
    { serverId: 'r-a1', serverName: 'wb-a1', serviceTag: 'To Be Filled By O.E.M.', source: 'idrac', vcenterId: 'vcA' },
    { serverId: 'r-b1', serverName: 'wb-b1', serviceTag: 'To Be Filled By O.E.M.', source: 'idrac', vcenterId: 'vcB' },
  ];
  poller._setFleetForTest(async () => classifyFleet({ hosts: [], vcenters: [{ id: 'vcA', name: 'A 법인' }, { id: 'vcB', name: 'B 법인' }], servers, tags: {}, assign: {} }));
  t.after(() => poller._setFleetForTest(null));
  return poller;
}

test('① 반증 r0b — 가상화 호스트 동명(서비스태그 없음 · 다른 vCenter)은 겹침 목록으로 · 결정 ‘추가’ 면 별도 키로 대상', async () => {
  const { resolveTargets } = await import('../src/bmusage/targets.js');
  const KD = await import('../src/bmusage/keyDecisions.js');
  const vcenters = [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }];
  const virt = [
    { name: 'esxi-01', fleetId: 'esxi-01', vcenterId: 'vcA', serviceTag: '', idracServerId: 'r-a' },
    { name: 'esxi-01', fleetId: 'esxi-01', vcenterId: 'vcB', serviceTag: '', idracServerId: 'r-b' },
  ];
  const registry = [{ id: 'r-a', host: 'https://ia', username: 'u', password: 'p' }, { id: 'r-b', host: 'https://ib', username: 'u', password: 'p' }];
  const settings = { corps: { vcA: true, vcB: true }, idracTelemetry: true, osSsh: false, includeVirtualization: true };
  const r = resolveTargets({ bareMetal: [], virtHosts: virt, vcenters, registry, settings });
  assert.deepEqual(r.targets.map((x) => `${x.vcenterId}|${x.key}`), ['vcA|esxi-01']);
  assert.equal(r.keyOverlaps.length, 1, '예전(반증 r0b): skipped 0 · keyConflicts 0 — 사유 없이 빠졌다');
  const o = r.keyOverlaps[0];
  assert.deepEqual([o.role, o.vcenterId, o.name, o.idracHost, o.dupOf.vcenterId, o.dupOf.sameIdrac || false], ['virt', 'vcB', 'esxi-01', 'https://ib', 'vcA', false]);
  assert.equal(o.decidedKey, 'vcB:host:esxi-01');
  const decisions = new Map([[o.oid, { oid: o.oid, decision: 'add', key: o.decidedKey }]]);
  const r2 = resolveTargets({ bareMetal: [], virtHosts: virt, vcenters, registry, settings, decisions });
  assert.deepEqual(r2.targets.map((x) => `${x.vcenterId}|${x.key}|${x.keyKind}`).sort(), ['vcA|esxi-01|fleetId', 'vcB|vcB:host:esxi-01|decided']);
  assert.equal(r2.keyOverlaps[0]?.collecting ?? false, false, '추가한 뒤에는 겹침이 아니라 대상(이 판정에서는 목록에서 빠진다 — 키가 갈렸다)');
  assert.equal(KD.overlapIdOf({ role: 'virt', vcenterId: 'vcB', name: 'esxi-01' }), o.oid);
  // 중앙: 엣지가 맡는 서버(remoteAgent)의 겹침은 그 엣지가 수집하므로 올리지 않는다 · 이 노드 서버가 엣지 보고 서버에 밀린 것은 올린다(겹친 상대 = 엣지 보고)
  const dupes = [
    { serverId: '10.5.5.5', fleetId: '10.5.5.5', name: 'local-ip', serviceTag: '', source: 'idrac', vcenterId: 'vcA', remoteAgent: '', dupOf: { name: 'edge-ip', vcenterId: 'vcB', source: 'edge', remoteAgent: 'Edge-B' } },
    { serverId: 'edge:Edge-C:10.6.6.6', fleetId: '10.6.6.6', name: 'edge-ip2', serviceTag: '', source: 'edge', vcenterId: 'vcB', remoteAgent: 'Edge-C', dupOf: null },
  ];
  const r3 = resolveTargets({ bareMetal: [], dupes, registry: [{ id: '10.5.5.5', host: 'https://10.5.5.5', username: 'u', password: 'p' }], settings: { corps: { vcA: true, vcB: true }, idracTelemetry: true }, isEdge: false, agentName: '' });
  assert.deepEqual(r3.keyOverlaps.map((x) => [x.name, x.dupOf?.edge, x.idracHost]), [['local-ip', true, 'https://10.5.5.5']], '엣지 위임 서버는 그 엣지가 · 이 노드 서버만');
  const r4 = resolveTargets({ bareMetal: [], dupes, registry: [], settings: { corps: { vcA: false, vcB: true }, idracTelemetry: true }, isEdge: false, agentName: '' });
  assert.equal(r4.keyOverlaps.length, 0, '꺼진 법인 서버는 겹침과 무관하게 대상이 아니다(목록에 싣지 않는다)');
});

test('② 겹침 목록 · 결정 — 범위 · 주소 · 404 → 403 · 추가(별도 키로 대상) · 키 겹침 409 · 제외 유지 · 되돌리기 · 손상 503 · 감사', async (t) => {
  const { call } = await app(t);
  const poller = await junkFleet(t);
  const KD = await import('../src/bmusage/keyDecisions.js');
  KD._resetKeyDecisionsForTest();
  const adm = await call('adm', 'GET', '/key-overlaps');
  assert.equal(adm.status, 200, JSON.stringify(adm.body));
  assert.equal(adm.body.items.length, 1);
  const it = adm.body.items[0];
  assert.deepEqual([it.vcenterId, it.name, it.serviceTag, it.idracHost, it.source, it.dupOf?.vcenterId, it.decidedKey], ['vcB', 'wb-b1', 'To Be Filled By O.E.M.', 'https://10.20.0.12', 'idrac', 'vcA', 'vcB:r-b1']);
  assert.deepEqual(adm.body.counts, { total: 1, pending: 1, added: 0, excluded: 0 });
  // 범위: A 계정에는 B 법인 행이 없고 개수도 0 · B 운영자는 행은 보지만 상대(A 법인)는 이름도 없고 주소도 없다(비관리자) · B 관리자는 주소를 본다
  const a = await call('opA', 'GET', '/key-overlaps');
  assert.deepEqual([a.body.items.length, a.body.counts.total], [0, 0]);
  const b = await call('opB', 'GET', '/key-overlaps');
  assert.equal(b.body.items.length, 1); assert.equal(b.body.items[0].dupOf, null, '범위 밖 상대는 싣지 않는다'); assert.equal(b.body.items[0].idracHost, undefined); assert.equal(b.body.addressHidden, true);
  assert.ok(!JSON.stringify(b.body).includes('wb-a1') && !JSON.stringify(b.body).includes('10.20.0.1'), '다른 법인 서버 이름 · 주소가 없다');
  const ab = await call('admB', 'GET', '/key-overlaps');
  assert.equal(ab.body.items[0].idracHost, 'https://10.20.0.12'); assert.equal(ab.body.items[0].dupOf, null);
  // 주 화면 개수(보이는 법인 것만)
  assert.deepEqual((await call('opB', 'GET', '')).body.keyOverlaps, { total: 1, pending: 1, added: 0 });
  assert.deepEqual((await call('opA', 'GET', '')).body.keyOverlaps, { total: 0, pending: 0, added: 0 });
  // 쓰기 게이트 — 조회 밖 404 · 조회 되고 쓰기 밖 403 · viewer 403(역할) · 형식 400
  assert.equal((await call('opA', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'add' })).status, 404);
  assert.equal((await call('opABwA', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'add' })).status, 403);
  assert.equal((await call('vw', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'add' })).status, 403);
  assert.equal((await call('opB', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'maybe' })).status, 400);
  assert.equal((await call('opB', 'POST', '/key-overlaps/decision', { oid: 'bm|vcB|nope', decision: 'add' })).status, 404);
  // 추가 — 다음 대상 해석에서 별도 키로 대상(서비스태그로 등록을 찾지 않는다 — 자기 iDRAC) · 이미 수집 중인 A 서버의 키는 그대로
  const add = await call('opB', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'add' });
  assert.equal(add.status, 200, JSON.stringify(add.body)); assert.equal(add.body.key, 'vcB:r-b1');
  const tg = await poller.currentTargets();
  assert.deepEqual(tg.targets.map((x) => `${x.vcenterId}|${x.key}|${x.idrac?.regId}`).sort(), ['vcA|TO BE FILLED BY O.E.M.|r-a1', 'vcB|vcB:r-b1|r-b1']);
  assert.equal(tg.keyOverlaps[0].collecting, true);
  const after = await call('adm', 'GET', '/key-overlaps');
  assert.equal(after.body.items[0].decision.decision, 'add'); assert.equal(after.body.items[0].decision.by, 'opb', '관리자 판본은 결정한 사람');
  assert.equal((await call('opB', 'GET', '/key-overlaps')).body.items[0].decision.by, undefined, '비관리자는 결정한 사람을 싣지 않는다');
  // 새 키는 처음 쓰는 이름 — 성능 상세가 그 서버로 열린다(옛 키의 주석 · 정비 창이 따라오지 않는다)
  const det = await call('adm', 'GET', `/perf/${encodeURIComponent('vcB:r-b1')}?vcenterId=vcB`);
  assert.equal(det.status, 200); assert.equal(det.body.target.serverId, 'r-b1');
  // 키 겹침 409 — 지금 대상이 그 별도 키를 이미 쓰면(다른 서버) 결정하지 않는다
  const { bmKeyDecisionWrite } = await import('../src/routes/api/bmKeyOverlaps.js');
  const fakeTg = { targets: [{ key: 'vcB:r-b1', vcenterId: 'vcB' }], keyOverlaps: [{ ...tg.keyOverlaps[0], decision: null }] };
  const taken = await bmKeyDecisionWrite({ user: USERS.adm, body: { oid: it.oid, decision: 'add' } }, { currentTargets: async () => fakeTg });
  assert.equal(taken.status, 409); assert.equal(taken.body.code, 'key-taken');
  // 제외 유지 → 되돌리기(결정 없음 = 수집 안 함 · 쌓인 값은 지우지 않는다)
  assert.equal((await call('opB', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'exclude' })).status, 200);
  assert.deepEqual((await poller.currentTargets()).targets.map((x) => x.vcenterId), ['vcA'], '제외 유지 — 수집하지 않는다');
  assert.equal((await call('opABwA', 'DELETE', `/key-overlaps/decision?oid=${encodeURIComponent(it.oid)}`)).status, 403, '되돌리기도 쓰기 범위');
  const clr = await call('opB', 'DELETE', `/key-overlaps/decision?oid=${encodeURIComponent(it.oid)}`);
  assert.equal(clr.status, 200, JSON.stringify(clr.body));
  assert.equal((await call('opB', 'GET', '/key-overlaps')).body.items[0].decision, null);
  // 기록만 남은 결정(겹침이 풀린 서버) — 되돌리기는 결정 기록의 법인으로 게이트
  await KD.setKeyDecision({ oid: 'bm|vcB|gone-1', decision: 'exclude', vcenterId: 'vcB', serverId: 'gone-1', name: 'gone' }, { by: 'adm' });
  assert.equal((await call('opA', 'DELETE', '/key-overlaps/decision?oid=bm%7CvcB%7Cgone-1')).status, 404, '조회 밖');
  assert.equal((await call('opB', 'DELETE', '/key-overlaps/decision?oid=bm%7CvcB%7Cgone-1')).status, 200);
  // 감사
  const { auditEntriesWithAction } = await import('../src/audit.js');
  const au = auditEntriesWithAction('bm-usage.key-decision');
  assert.ok(au.length >= 4, `감사 ${au.length}건(추가 · 제외 · 되돌리기 · 기록 되돌리기)`);
  // 손상 — 읽기 503 · 쓰기 거부 · 결정을 적용하지 않는다(별도 키 수집 멈춤 — sourceErrors 로 밝힌다)
  assert.equal((await call('opB', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'add' })).status, 200);
  fs.writeFileSync(path.join(DIR, 'bm-key-decisions.json'), '{ broken');
  const bad = await call('adm', 'GET', '/key-overlaps');
  assert.equal(bad.status, 503); assert.equal(bad.body.code, 'settingsUnreadable');
  const tgBad = await poller.currentTargets();
  assert.deepEqual(tgBad.targets.map((x) => x.vcenterId), ['vcA'], '못 읽으면 결정을 적용하지 않는다');
  assert.ok(tgBad.sourceErrors.some((x) => x.source === 'key-decisions'));
  assert.equal((await call('opB', 'POST', '/key-overlaps/decision', { oid: it.oid, decision: 'exclude' })).status, 503, '손상이면 쓰기 거부(빈 목록으로 덮지 않는다)');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('bm-key-decisions.json.corrupt.')), '손상본 보존');
  for (const f of fs.readdirSync(DIR).filter((x) => x.startsWith('bm-key-decisions.json'))) fs.rmSync(path.join(DIR, f));
  KD._resetKeyDecisionsForTest();
});

test('③ 반증 r1 · r1b(F2) — 용도 태그는 (법인, 키) 쌍으로 저장: A 쓰기 뒤 B 판정 불변 · B 해제가 A 를 지우지 않음 · 예전 키 행 409 · 전체 범위는 법인별로 나눠 옮김 · 계정명', async (t) => {
  const { call } = await app(t);
  const IP = '10.1.1.5';
  // ⚠ OS 계정 등록부(bmstor)는 프로세스 캐시라 시험마다 바꾸지 않는다 — iDRAC 경로(등록부는 매번 읽는다)로 대상을 만든다.
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 's-a1', name: 'bm-a1', host: 'https://10.30.0.1', username: 'u', password: 'p', vcenterId: 'vcA' }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: false, idracTelemetry: true }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a1', fleetId: IP, name: 'bm-a1', serviceTag: '', vcenterId: 'vcA', vcName: 'A 법인' }], virtualizationHosts: [] }));
  const E = await import('../src/central/bmUsageEdgePull.js');
  E._resetForTest();
  E.putEdgeBmUsage('Edge-B', { ok: true, snap: { targets: [{ key: IP, name: 'b-ip', serviceTag: '', keyKind: 'fleetId', vcenterId: 'vcB', vcName: 'B 법인', paths: ['os'] }], perf: [], rows: [] } });
  t.after(() => { poller._setFleetForTest(null); E._resetForTest(); });
  const FT = await import('../src/insights/fleetTags.js');
  const profile = async (u, vc) => (await call(u, 'GET', `/perf/${IP}/profile${vc ? `?vcenterId=${vc}` : ''}`)).body;
  assert.equal((await call('admA', 'PUT', '/purpose', { key: IP, role: 'db' })).status, 200);
  assert.equal((await profile('admA')).manual?.role, 'db', 'A 서버에는 태그');
  assert.equal((await profile('adm', 'vcB')).manual, null, 'B 서버 판정은 그대로(반증 r1: role db · by adma)');
  assert.equal((await profile('admB')).manual, null, 'B 관리자에게 A 관리자 계정명이 보이지 않는다');
  assert.equal(FT.fleetPurposeOf(`vcA|${IP}`)?.role, 'db', '저장 키 = 법인|키');
  assert.equal(FT.fleetPurposeOf(IP), null, '예전(키 단독) 행을 새로 만들지 않는다');
  // B 해제는 A 를 지우지 않는다(반증 r1b)
  assert.equal((await call('admB', 'PUT', '/purpose', { key: IP, clear: true })).status, 200);
  assert.equal((await profile('admA')).manual?.role, 'db');
  // 예전 키 행 — 그 키의 B 서버가 쓰기 범위 밖인 계정은 409 · 전체 범위 관리자는 법인별로 나눠 옮긴 뒤 쓴다(값 · 처음 단 사람 보존)
  FT.setFleetPurpose(`vcA|${IP}`, null, {});
  assert.equal(FT.setFleetPurpose(IP, { role: 'web' }, { by: 'legacy-user', knownRoles: ['web', 'db', 'general', 'batch', 'storage'], knownApps: [] }).ok, true);
  assert.equal((await profile('adm', 'vcB')).manual?.role, 'web', '예전 행은 읽기에서 그대로 걸린다(저장 이전 없음)');
  assert.equal((await profile('admB')).manual?.by, undefined, '예전 행(어느 법인 것인지 모름)의 계정명은 범위 계정에 싣지 않는다');
  assert.equal((await profile('adm', 'vcB')).manual?.by, 'legacy-user', '전체 범위 관리자는 본다');
  const conflict = await call('admA', 'PUT', '/purpose', { key: IP, role: 'db' });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'legacy-shared');
  assert.equal(FT.fleetPurposeOf(IP)?.role, 'web', '409 — 아무것도 바꾸지 않았다');
  const full = await call('adm', 'PUT', '/purpose', { key: IP, role: 'db', vcenterId: 'vcA' });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal(FT.fleetPurposeOf(IP), null, '예전 행을 지웠다');
  assert.deepEqual([FT.fleetPurposeOf(`vcA|${IP}`)?.role, FT.fleetPurposeOf(`vcB|${IP}`)?.role, FT.fleetPurposeOf(`vcB|${IP}`)?.by], ['db', 'web', 'legacy-user'], 'B 는 예전 값 · 처음 단 사람 그대로');
  FT.setFleetPurpose(`vcA|${IP}`, null, {}); FT.setFleetPurpose(`vcB|${IP}`, null, {});
});

test('④ 반증 r2(F3) — 범위 계정의 키 충돌 수는 보이는 줄의 고유 키 · peers 없음', async (t) => {
  const { call } = await app(t);
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: ['a1', 'a2', 'a3', 'b1', 'b2'].map((id, i) => ({ id, name: id, host: `https://10.40.0.${i + 2}`, username: 'u', password: 'p' })) }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: false, idracTelemetry: true }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 'a1', fleetId: 'K1', name: 'a-one', serviceTag: '', vcenterId: 'vcA' }, { serverId: 'a2', fleetId: 'K1', name: 'a-two', serviceTag: '', vcenterId: 'vcA' },
    { serverId: 'a3', fleetId: 'K2', name: 'a-three', serviceTag: '', vcenterId: 'vcA' }, { serverId: 'b1', fleetId: 'K2', name: 'b-one', serviceTag: '', vcenterId: 'vcB' },
    { serverId: 'b2', fleetId: 'K3', name: 'b-ok', serviceTag: '', vcenterId: 'vcB' },
  ], virtualizationHosts: [] }));
  t.after(() => poller._setFleetForTest(null));
  const adm = await call('adm', 'GET', '');
  assert.equal(adm.body.counts.keyConflicts, 2);
  const b = await call('opB', 'GET', '');
  assert.equal(b.body.counts.keyConflicts, 1, '반증 r2: 2(B 와 무관한 K1 포함)');
  assert.deepEqual(b.body.keyConflicts, [{ key: 'K2', names: ['b-one'], keyKind: 'fleetId', vcenterId: 'vcB', role: 'bm' }], 'peers(범위 밖 서버까지 센 수) 없음');
});

test('⑤ 반증 r3(F4) — 귀속 없음 후보는 노드까지 갈라 ‘-@노드’ 로 고른다(사유 수 = 후보 수 = 버튼 수)', async () => {
  const { _resolvePerfTargetForTest: R, perfTargetFail } = await import('../src/routes/api/bmUsage.js');
  const D = {
    currentTargets: async () => ({ targets: [{ key: 'K', name: 'local-unassigned', vcenterId: '' }] }),
    listEdgeBmUsage: async () => [
      { agent: 'Edge-B', snapAt: 2, snap: { targets: [{ key: 'K', name: 'edge-b', vcenterId: 'vcB' }] } },
      { agent: 'Edge-C', snapAt: 1, snap: { targets: [{ key: 'K', name: 'edge-c-unassigned', vcenterId: '' }] } },
    ],
  };
  const amb = perfTargetFail(await R({}, D, { allowed: null, isAdmin: true, key: 'K' }));
  assert.equal(amb.code, 'ambiguous-key');
  const me = (await import('../src/config.js')).config.agent?.name || '';
  const un = [{ vcenterId: '', vcName: null, unassigned: true, agent: me, pick: `-@${me}` }, { vcenterId: '', vcName: null, unassigned: true, agent: 'Edge-C', pick: '-@Edge-C' }]
    .sort((x, y) => x.pick.localeCompare(y.pick));
  assert.deepEqual(amb.candidates, [{ vcenterId: 'vcB', vcName: null }, ...un], '예전: 후보 2(이 노드 · 엣지 C 귀속 없음이 한 쌍으로 합쳐짐) · 웹 버튼 1');
  assert.match(amb.reason, /3개 법인/);
  assert.equal((await R({}, D, { allowed: null, isAdmin: true, key: 'K', vcenterId: '-@Edge-C' })).target.name, 'edge-c-unassigned');
  assert.equal((await R({}, D, { allowed: null, isAdmin: true, key: 'K', vcenterId: `-@${me}` })).target.name, 'local-unassigned');
  assert.equal((await R({}, D, { allowed: null, isAdmin: true, key: 'K', vcenterId: 'vcB' })).target.name, 'edge-b');
  assert.equal(await R({}, D, { allowed: new Set(['vcB', 'vcC']), isAdmin: false, key: 'K', vcenterId: '-@Edge-C' }), null, '범위 계정은 귀속 없음을 못 고른다');
  assert.equal((await R({}, D, { allowed: new Set(['vcB']), isAdmin: false, key: 'K' })).target.name, 'edge-b', '범위 계정 후보는 B 하나');
});
