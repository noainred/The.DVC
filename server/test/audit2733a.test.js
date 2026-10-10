/**
 * v2.733(점검 3회차 그룹 a) — C1-01: v2.732 B4-01 이후 중앙은 엣지 위임(site)·비활성·점검중 vCenter 의 이벤트를 수집하지 않는다.
 * 중앙 logs DB 를 읽는 리포트가 그 vCenter 를 '정상·0건·특이 패턴 없음' 으로 말하던 것을 **실제 라우터**(api · adminRouter)로 본다.
 *  ① 판정 한 벌(logs/coverage.js) — 등록부 + directCollectSkipReason, mock 이면 빈 맵(로그 폴러와 같은 기준)
 *  ② 로그 이슈 분석 — 고른 NC vCenter 는 sev 'unknown'·수치 null(옛 이벤트로 판정하지 않음) · 전체 보기는 NC 를 빼고 밝힌다
 *  ③ 구성 변경 이력 — notCollected(범위 안만)
 *  ④ 로그인 실패 분석 — 고른 NC vCenter 는 vcenter=null · 전체 보기는 NC 옛 실패를 빼고 oldFails 로 밝힌다 · 주기 감시 상태 notMonitored
 *  ⑤ VM 이동·생성/삭제 이력 · VM 상세(of) — 항목 notCollected · 목록 · 범위
 *  ⑥ VM 가용성 — NC vCenter 는 마지막 이벤트에서 끊고(허용치 0) notCollected 로 센다
 *  ⑦ 미보호 VM — 인라인 판정이 헬퍼로 바뀌어도 결과 동일 + 사유 실림
 *  ⑧ 재부팅 분류(순수) — coverageOf 의 why 를 행에 싣는다
 * 직접 수집 vCenter(vc-d)는 예전과 같은 결과인지 함께 고정한다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({
  vcenters: [
    { id: 'vc-d', name: 'Direct', host: 'd.example.invalid', username: 'u', password: 'p' },
    { id: 'vc-s', name: 'Poland-site', host: 's.example.invalid', username: 'u', password: 'p', collectMode: 'site', remoteAgent: 'edge-pl' },
    { id: 'vc-x', name: 'Disabled', host: 'x.example.invalid', username: 'u', password: 'p', enabled: false },
    { id: 'vc-m', name: 'Maint', host: 'm.example.invalid', username: 'u', password: 'p', maintenance: true },
  ],
}));

const servers = [];
after(async () => {
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const express = (await import('express')).default;
const { config } = await import('../src/config.js');
const { store } = await import('../src/store.js');
const { api } = await import('../src/routes/api.js');
const { adminRouter } = await import('../src/routes/admin.js');
const { getLogsDb } = await import('../src/logs/db.js');
const { eventNotCollectedMap, notCollectedList } = await import('../src/logs/coverage.js');
const { analyzeReboots } = await import('../src/hostcfg/reboots.js');
const { analyzeLogsForIssues } = await import('../src/net/logIssues.js');
const { runLoginAnalysisNow, loginMonitorStatus } = await import('../src/security/loginMonitor.js');

const NOW = Date.now();
const OLD = NOW - 3 * 86_400_000;      // 업그레이드 전(중앙이 직접 모으던 때)
const RECENT = NOW - 3_600_000;
const db = await getLogsDb();
const rows = [];
const ev = (vcenterId, key, ts, severity, type, entity, message, user = '') => rows.push({ vcenterId, key, ts, severity, type, user, entity, message });
// 직접 수집 vCenter — 지금도 쌓인다
for (let i = 0; i < 4; i++) ev('vc-d', `d-lost-${i}`, RECENT + i * 1000, 'error', 'HostConnectionLostEvent', 'esx-d1', 'Lost connection to host esx-d1');
for (let i = 0; i < 2; i++) ev('vc-d', `d-bad-${i}`, RECENT + 10_000 + i * 1000, 'warning', 'BadUsernameSessionEvent', '', 'Cannot login root@10.1.1.1', 'root');
ev('vc-d', 'd-reconf', RECENT + 20_000, 'info', 'VmReconfiguredEvent', 'vm-d1', 'Reconfigured vm-d1', 'admin');
ev('vc-d', 'd-on', OLD - 86_400_000, 'info', 'VmPoweredOnEvent', 'vm-d1', 'vm-d1 powered on');
// 엣지 위임 vCenter — 업그레이드 전 이벤트만 남아 있다
for (let i = 0; i < 6; i++) ev('vc-s', `s-lost-${i}`, OLD + i * 1000, 'error', 'HostConnectionLostEvent', 'esx-s1', 'Lost connection to host esx-s1');
for (let i = 0; i < 7; i++) ev('vc-s', `s-bad-${i}`, OLD + 10_000 + i * 1000, 'warning', 'BadUsernameSessionEvent', '', 'Cannot login admin@10.9.9.9', 'admin');
ev('vc-s', 's-reconf', OLD + 20_000, 'info', 'VmReconfiguredEvent', 'vm-s1', 'Reconfigured vm-s1', 'admin');
ev('vc-s', 's-on', OLD - 86_400_000, 'info', 'VmPoweredOnEvent', 'vm-s1', 'vm-s1 powered on');
ev('vc-s', 's-create', OLD + 30_000, 'info', 'VmCreatedEvent', 'vm-s2', 'Created vm-s2');
// 비활성 vCenter — 옛 오류 1건
ev('vc-x', 'x-lost-0', OLD, 'error', 'HostConnectionLostEvent', 'esx-x1', 'Lost connection to host esx-x1');
db.insertMany(rows);

const VMS = [
  { id: 'vc-d:vm-1', name: 'vm-d1', vcenterId: 'vc-d', powerState: 'POWERED_ON', storageGB: 10 },
  { id: 'vc-s:vm-1', name: 'vm-s1', vcenterId: 'vc-s', powerState: 'POWERED_ON', storageGB: 10 },
  { id: 'vc-m:vm-1', name: 'vm-m1', vcenterId: 'vc-m', powerState: 'POWERED_ON', storageGB: 10 },
];
store.snapshot = {
  generatedAt: new Date(NOW).toISOString(), source: 'live',
  vcenters: [
    { id: 'vc-d', name: 'Direct', status: 'ok' },
    { id: 'vc-s', name: 'Poland-site', status: 'ok', collectSource: 'site' },
    { id: 'vc-x', name: 'Disabled', status: 'disabled' },
    { id: 'vc-m', name: 'Maint', status: 'maintenance', maintenance: true },
  ],
  hosts: [], vms: VMS, datastores: [], networks: [], alarms: [], collectionErrors: [],
};

const ADMIN = { username: 'adm', role: 'admin', name: 'adm', scope: null };
async function serve(user = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...user }; next(); });
  app.use('/api/admin', adminRouter);
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  return async (p) => { const r = await fetch(base + p); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, b }; };
}
const ids = (list) => (list || []).map((x) => x.vcenterId).sort();

test('① 판정 한 벌 — site·disabled·maintenance → 사유, 직접 수집은 없음 · mock 이면 빈 맵(로그 폴러와 같은 기준)', () => {
  const m = eventNotCollectedMap();
  assert.deepEqual(Object.fromEntries(m), { 'vc-s': 'site', 'vc-x': 'disabled', 'vc-m': 'maintenance' });
  assert.equal(m.has('vc-d'), false);
  assert.deepEqual(ids(notCollectedList(m, { allowed: new Set(['vc-d', 'vc-s']) })), ['vc-s'], '범위 밖은 싣지 않는다');
  assert.deepEqual(ids(notCollectedList(m, { only: ['vc-m'] })), ['vc-m']);
  const prev = config.dataSource;
  try { config.dataSource = 'mock'; assert.equal(eventNotCollectedMap().size, 0, 'mock 은 폴러가 스냅샷 vCenter 전부를 모은다 — 판정하지 않는다'); }
  finally { config.dataSource = prev; }
});

test('② 로그 이슈 분석 — NC vCenter 를 고르면 unknown·null(옛 이벤트 6회로 판정하지 않음) · 직접 수집은 그대로 · 전체 보기는 NC 를 빼고 밝힌다', async () => {
  const get = await serve();
  const s = await get('/api/admin/net/log-issues?vcenterId=vc-s&days=7');
  assert.equal(s.status, 200);
  assert.deepEqual(s.b.patterns.map((p) => p.sev), ['unknown'], `NC 는 'ok' 도 옛 패턴도 아니다: ${JSON.stringify(s.b.patterns)}`);
  assert.equal(s.b.summary.errors, null, '수치는 null — 0 이 아니다');
  assert.deepEqual(s.b.notCollected, [{ vcenterId: 'vc-s', why: 'site' }]);
  for (const id of ['vc-x', 'vc-m']) {
    const r = await get(`/api/admin/net/log-issues?vcenterId=${id}&days=1`);
    assert.equal(r.b.patterns[0].sev, 'unknown', `${id} 도 '특이 패턴 없음' 이 아니다`);
  }
  const d = await get('/api/admin/net/log-issues?vcenterId=vc-d&days=7');
  assert.equal(d.b.summary.errors, 4);
  assert.ok(d.b.patterns.some((p) => /연결 끊김\/무응답 4회/.test(p.title)), JSON.stringify(d.b.patterns));
  assert.deepEqual(d.b.notCollected, [], '직접 수집 vCenter 를 고르면 목록은 비어 있다');
  const all = await get('/api/admin/net/log-issues?days=7');
  assert.equal(all.b.summary.errors, 4, 'NC 의 옛 오류 7건(vc-s 6 · vc-x 1)은 합계에서 뺀다');
  assert.ok(all.b.patterns.some((p) => /연결 끊김\/무응답 4회/.test(p.title)), '패턴도 직접 수집분만으로');
  assert.deepEqual(ids(all.b.notCollected), ['vc-m', 'vc-s', 'vc-x']);
  assert.deepEqual(all.b.excluded, { errors: 7, warnings: 7 });
  // 주입 경로(테스트·호출부): 빈 맵이면 예전과 같은 합계(옛 이벤트 포함)
  const legacy = await analyzeLogsForIssues({ days: 7 }, { notCollected: new Map() });
  assert.equal(legacy.summary.errors, 11);
});

test('③ 구성 변경 이력 — notCollected 를 싣고(범위 안만) 직접 수집 vCenter 는 그대로', async () => {
  const get = await serve();
  const s = await get('/api/tools/report/changes?vcenterId=vc-s&days=1');
  assert.equal(s.status, 200);
  assert.equal(s.b.total, 0);
  assert.deepEqual(s.b.notCollected, [{ vcenterId: 'vc-s', why: 'site', name: 'Poland-site' }], '0건은 "변경 없음" 이 아니다');
  const d = await get('/api/tools/report/changes?vcenterId=vc-d&days=1');
  assert.equal(d.b.total, 1);
  assert.deepEqual(d.b.notCollected, []);
  const all = await get('/api/tools/report/changes?days=7');
  assert.deepEqual(ids(all.b.notCollected), ['vc-m', 'vc-s', 'vc-x']);
  const scoped = await serve({ ...ADMIN, scope: { vcenters: ['vc-d', 'vc-s'] } });
  const sc = await scoped('/api/tools/report/changes?days=7');
  assert.deepEqual(ids(sc.b.notCollected), ['vc-s'], '범위 계정에는 범위 안 vCenter 만');
});

test('④ 로그인 실패 — NC 를 고르면 vcenter=null · 전체 보기는 NC 의 옛 실패 7건을 빼고 oldFails 로 · 주기 감시 상태 notMonitored', async () => {
  const get = await serve();
  const s = await get('/api/admin/security/login-fails?vcenterId=vc-s&days=7');
  assert.equal(s.status, 200);
  assert.equal(s.b.summary.vcenter, null, "'실패 0건' 이 아니다");
  assert.equal(s.b.scan.source, 'not-collected');
  assert.deepEqual(s.b.notCollected.map((x) => [x.vcenterId, x.why]), [['vc-s', 'site']]);
  const d = await get('/api/admin/security/login-fails?vcenterId=vc-d&days=7');
  assert.equal(d.b.summary.vcenter, 2);
  assert.deepEqual(d.b.notCollected, []);
  const all = await get('/api/admin/security/login-fails?days=7');
  assert.equal(all.b.summary.vcenter, 2, 'NC 의 옛 실패는 집계에 섞지 않는다');
  assert.equal(all.b.offenders.filter((o) => o.key === 'admin').length, 0, '옛 실패로 브루트포스 판정을 지어내지 않는다');
  const nc = Object.fromEntries(all.b.notCollected.map((x) => [x.vcenterId, x]));
  assert.equal(nc['vc-s'].oldFails, 7);
  assert.equal(nc['vc-x'].oldFails, 0);
  await runLoginAnalysisNow();
  assert.deepEqual(ids(loginMonitorStatus().notMonitored), ['vc-m', 'vc-s', 'vc-x'], '주기 감시가 보지 못하는 vCenter 를 상태에 남긴다');
});

test('⑤ VM 이동·생성/삭제 이력 · VM 상세 — 항목 notCollected·목록(범위 안만) · 직접 수집은 없음', async () => {
  const get = await serve();
  for (const p of ['/api/tools/vm-changes?days=7', '/api/tools/vm-lifecycle?days=7']) {
    const r = await get(p);
    assert.equal(r.status, 200, p);
    const cov = Object.fromEntries(r.b.vcenters.map((v) => [v.vcenterId, v]));
    assert.equal(cov['vc-s'].notCollected, 'site', `${p}: 옛 lastTs 가 남아 있어도 '지금 수집하지 않음'`);
    assert.ok(cov['vc-s'].lastTs, '옛 이벤트 시각은 그대로 둔다');
    assert.equal(cov['vc-m'].notCollected, 'maintenance');
    assert.equal(cov['vc-d'].notCollected, undefined);
    assert.deepEqual(ids(r.b.notCollected), ['vc-m', 'vc-s', 'vc-x']);
  }
  const of = await get(`/api/tools/vm-changes/of?vmId=${encodeURIComponent('vc-s:vm-1')}`);
  assert.equal(of.status, 200);
  assert.equal(of.b.notCollected, 'site');
  assert.equal(of.b.items.length, 1, '수집을 멈추기 전 이력은 그대로 보인다');
  const ofd = await get(`/api/tools/vm-changes/of?vmId=${encodeURIComponent('vc-d:vm-1')}`);
  assert.equal(ofd.b.notCollected, null);
  const scoped = await serve({ ...ADMIN, scope: { vcenters: ['vc-d', 'vc-s'] } });
  const sc = await scoped('/api/tools/vm-changes?days=7');
  assert.deepEqual(ids(sc.b.notCollected), ['vc-s'], '범위 계정에는 범위 안 vCenter 만');
});

test('⑥ VM 가용성 — NC vCenter 는 마지막 이벤트에서 끊고(허용치 0) notCollected 로 센다 · 직접 수집은 지금까지', async () => {
  const get = await serve();
  const r = await get('/api/tools/vm-availability?days=30');
  assert.equal(r.status, 200);
  const vcs = Object.fromEntries(r.b.vcenters.map((v) => [v.vcenterId, v]));
  assert.equal(vcs['vc-s'].notCollected, 'site');
  assert.equal(vcs['vc-s'].tailCut, true, '그 뒤를 가동으로 세지 않는다');
  assert.equal(vcs['vc-d'].notCollected, null);
  assert.equal(vcs['vc-d'].tailCut, false);
  assert.equal(r.b.coverage.notCollectedVcenters, 2, 'vc-s·vc-m(스냅샷에 VM 이 있는 NC)');
  assert.equal(r.b.coverage.notCollectedVms, 2);
  assert.equal(r.b.coverage.tailFromLastEvent, 0, "NC 는 '수집 성공 기록 없음(재시작 직후·계속 실패)' 으로 세지 않는다");
  assert.ok(r.b.coverage.tailNotCollected >= 1);
  assert.deepEqual(ids(r.b.notCollected), ['vc-m', 'vc-s', 'vc-x']);
});

test('⑦ 미보호 VM — 헬퍼로 바꿔도 결과 동일(직접 수집 VM 은 판정, NC 는 not-collected) + 사유를 싣는다', async () => {
  const get = await serve();
  const r = await get('/api/tools/report/unprotected?lookbackDays=7');
  assert.equal(r.status, 200);
  assert.equal(r.b.summary.unprotectedCount, 1, 'vc-d 의 VM 만 미보호로 판정');
  assert.equal(r.b.summary.undeterminedByReason['not-collected'], 2);
  assert.deepEqual(r.b.summary.notCollectedVcenters.map((x) => [x.vcenterId, x.why]).sort(), [['vc-m', 'maintenance'], ['vc-s', 'site']]);
});

test('⑧ 재부팅 분류(순수) — coverageOf 의 why 를 no-events 행에 싣고 개수를 센다(분류는 바꾸지 않는다)', () => {
  const hosts = [{ id: 'h1', name: 'esx-s1', vcenterId: 'vc-s', bootTime: NOW - 3_600_000, connectionState: 'CONNECTED' },
    { id: 'h2', name: 'esx-d1', vcenterId: 'vc-d', bootTime: NOW - 3_600_000, connectionState: 'CONNECTED' }];
  const cov = { 'vc-s': { firstTs: OLD - 10 * 86_400_000, lastTs: OLD, why: 'site' }, 'vc-d': { firstTs: OLD - 10 * 86_400_000, lastTs: OLD } };
  const r = analyzeReboots(hosts, [], { now: NOW, days: 30, coverageOf: (id) => cov[id] || null });
  const byName = Object.fromEntries(r.rows.map((x) => [x.name, x]));
  assert.equal(byName['esx-s1'].kind, 'no-events');
  assert.equal(byName['esx-s1'].notCollected, 'site');
  assert.equal(byName['esx-d1'].kind, 'no-events');
  assert.equal(byName['esx-d1'].notCollected, undefined, '직접 수집 vCenter 의 no-events 는 예전 그대로');
  assert.equal(r.noEventsNotCollected, 1);
});
