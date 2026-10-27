/**
 * v2.788.1 — EM 백업 서버 매핑(vCenter·B&R 등록) + 실패·경고 상세(세션의 VM 별 결과·사유).
 *  · 매핑 저장소 : 모르는 vCenter·B&R 400 · 손상이면 쓰기 503(빈 맵 위에 덮지 않음) · 둘 다 비우면 지움 · EM 삭제 시 그 EM 매핑 정리
 *  · 짝짓기 순서 : 수동 > 이름 자동 · 'none' 은 이름이 같아도 짝짓지 않음 · 지워진 등록은 missing · vCenter 수동 > B&R 등록 따름 > 모름
 *  · 라우트       : 매핑 저장은 관리자 + 전체 범위 · EM 탭 응답 캐시 키에 매핑 리비전(저장 즉시 반영)
 *  · 상세         : 저장된 결과에 없는 세션 404 · 범위 계정 403 · 인증 정지면 접속 안 함 · 401 이면 정지 기록 · 사유 비밀 가림 · 정규화
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamEm27881-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const M = await import('../src/veeam/em/mapping.js');
const V = await import('../src/veeam/em/view.js');
const EC = await import('../src/veeam/em/client.js');
const EP = await import('../src/veeam/em/parse.js');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

test('A 매핑 저장소 — 검증 · 지우기 · 손상이면 쓰기 거부 · EM 정리', () => {
  M._resetEmMapForTest();
  const ctx = { knownVcenters: ['kr:vc1', 'pl:vc2'], knownBr: ['vbr-1'], user: { username: 'adm' } };
  assert.equal(M.setEmMap({ emId: 'vem-1', server: 'HM', vcenterIds: ['nope'] }, ctx).status, 400, '모르는 vCenter');
  assert.equal(M.setEmMap({ emId: 'vem-1', server: 'HM', br: 'vbr-x' }, ctx).status, 400, '등록 안 된 B&R');
  const r0 = M.emMapRev();
  const r = M.setEmMap({ emId: 'vem-1', server: '  HM  ', vcenterIds: ['kr:vc1', 'kr:vc1'], br: 'vbr-1' }, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual([r.entry.vcenterIds, r.entry.br, r.entry.server, r.entry.by], [['kr:vc1'], 'vbr-1', 'HM', 'adm']);
  assert.ok(M.emMapRev() > r0, '리비전이 오른다(응답 캐시 키)');
  assert.ok(M.getEmMap()[M.mapKey('vem-1', 'hm')], '키는 이름 소문자');
  assert.equal(fs.statSync(path.join(DIR, 'veeam-em-map.json')).mode & 0o777, 0o600);
  M.setEmMap({ emId: 'vem-1', server: 'NB', br: 'none' }, ctx);
  assert.equal(M.setEmMap({ emId: 'vem-1', server: 'HM', vcenterIds: [], br: '' }, ctx).entry, null, '둘 다 비면 지운다');
  assert.equal(M.dropEmMapFor('vem-1'), 1, 'EM 삭제 시 그 EM 매핑 정리');
  fs.writeFileSync(path.join(DIR, 'veeam-em-map.json'), '{"servers":{"x":');
  M._resetEmMapForTest();
  assert.equal(M.emMapUnreadable(), true);
  const w = M.setEmMap({ emId: 'vem-1', server: 'HM', vcenterIds: ['kr:vc1'] }, ctx);
  assert.deepEqual([w.ok, w.status, w.code], [false, 503, 'emMapUnreadable'], '손상이면 빈 맵 위에 쓰지 않는다');
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('veeam-em-map.json.corrupt')));
  fs.rmSync(path.join(DIR, 'veeam-em-map.json'), { force: true });
  M._resetEmMapForTest();
});

test('B 짝짓기 순서 — 수동 > 이름 자동 · none 확정 · missing · vCenter 출처', () => {
  const br = [{ id: 'vbr-az', name: 'AZ', host: 'az-vbr.corp', vcenterIds: ['us:az'] }, { id: 'vbr-hm', name: 'Veeam-Hungary', host: '10.1.1.1', vcenterIds: ['eu:hm'] }];
  const map = {
    [M.mapKey('vem-1', 'HM')]: { br: 'vbr-hm', vcenterIds: [] },
    [M.mapKey('vem-1', 'AZ')]: { br: 'none', vcenterIds: ['us:az2'] },
    [M.mapKey('vem-1', 'GONE')]: { br: 'vbr-deleted', vcenterIds: [] },
  };
  const out = Object.fromEntries(V.mapBackupServers([{ name: 'HM' }, { name: 'AZ' }, { name: 'GONE' }, { name: 'az-vbr' }, { name: 'NJ' }],
    { emId: 'vem-1', map, brServers: br, vcName: new Map([['eu:hm', 'Hungary'], ['us:az2', 'AZ-2']]) }).map((x) => [x.name, x]));
  assert.deepEqual([out.HM.registered, out.HM.brSource, out.HM.vcSource, out.HM.vcNames], [true, 'manual', 'br', ['Hungary']], '수동 짝 · vCenter 는 B&R 등록을 따름');
  assert.deepEqual([out.AZ.registered, out.AZ.brSource, out.AZ.vcSource, out.AZ.vcNames], [false, 'none', 'manual', ['AZ-2']], "이름이 같아도 'none' 이면 짝짓지 않는다");
  assert.deepEqual([out.GONE.registered, out.GONE.brSource], [false, 'missing']);
  assert.deepEqual([out['az-vbr'].registered, out['az-vbr'].brSource], [true, 'auto'], '주소 첫 마디로 자동');
  assert.deepEqual([out.NJ.registered, out.NJ.brSource, out.NJ.vcSource, out.NJ.vcenterIds], [false, null, null, []], '모름 — 빈 목록을 법인 없음으로 단정하지 않는다');
  // 작업·세션에 법인 이름
  const view = V.emView({ id: 'vem-1', name: 'E' }, { result: { ok: true, ts: NOW, sections: {}, backupServers: [{ name: 'HM' }], jobs: [{ name: 'J', server: 'hm', last: { result: 'fail', end: NOW, uid: 'u1' } }], sessions: { counts24: {}, recentBad: [{ uid: 'u1', job: 'J', server: 'HM', result: 'fail' }] } } },
    { brServers: br, map, vcName: new Map([['eu:hm', 'Hungary']]) });
  assert.deepEqual(view.data.jobs.items[0].vcNames, ['Hungary']);
  assert.deepEqual(view.data.sessions.recentBad[0].vcNames, ['Hungary']);
});

test('C 상세 정규화 — 세션 UID 보존 · VM 별 사유 · 세션 id 형식', () => {
  const ss = EP.sessionsOf([{ UID: 'urn:veeam:BackupJobSession:0f2b1c3d-1111-4222-8333-444455556666', JobName: 'J', Result: 'Warning', State: 'Stopped', EndTimeUTC: new Date(NOW).toISOString() }]);
  assert.equal(ss[0].uid, 'urn:veeam:BackupJobSession:0f2b1c3d-1111-4222-8333-444455556666');
  const jobs = EP.jobsWithResults({ Jobs: [{ Name: 'J' }] }, ss, { now: NOW });
  assert.equal(jobs[0].last.uid, ss[0].uid);
  assert.equal(EP.sessionDigest(ss, { now: NOW }).recentBad[0].uid, ss[0].uid);
  assert.equal(EC.sessionIdOf(ss[0].uid), '0f2b1c3d-1111-4222-8333-444455556666');
  assert.equal(EC.sessionIdOf('../../api/jobs'), '', '형식이 아니면 경로를 만들지 않는다');
  const t = EP.taskSessionsOf({ BackupTaskSessions: [{ VmDisplayName: 'web01', Result: 'Failed', Reason: 'Error: snapshot\u0007 failed', TotalSize: 1e9 }, { Name: 'db01', Result: 'Success', Reason: '' }] });
  assert.deepEqual(t.map((x) => [x.vm, x.result, x.reason]), [['web01', 'fail', 'Error: snapshot failed'], ['db01', 'ok', '']]);
});

test('D 상세 수집기 — 사유의 비밀 가림 · 한 항목만 읽혀도 돌려줌 · 로그인 401 은 authFailed', async () => {
  const em = { id: 'vem-t', name: 'E', host: 'vem.corp.local', port: 9398, username: 'svc', password: 'Pw-Secret-9' };
  const uid = 'urn:veeam:BackupJobSession:0f2b1c3d-1111-4222-8333-444455556666';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url); calls.push(`${init.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/api/sessionMngr/') return json({ SessionId: 'L1' }, 201, { 'X-RestSvcSessionId': 'sid-1' });
    if (u.pathname.endsWith('/taskSessions')) return json({ BackupTaskSessions: [{ VmDisplayName: 'web01', Result: 'Failed', Reason: `login failed for svc / Pw-Secret-9 ${'x'.repeat(400)}` }] });
    if (u.pathname.startsWith('/api/backupSessions/')) return json({ message: 'no' }, 500);
    return new Response(null, { status: 204 });
  };
  const d = await EC.sessionDetail(em, uid, { fetchImpl });
  assert.equal(d.head, null);
  assert.match(d.errors.head, /500/);
  assert.ok(!d.tasks[0].reason.includes('Pw-Secret-9') && d.tasks[0].reason.includes('***'));
  assert.ok(d.tasks[0].reason.length > 300, '사유는 300자로 자르지 않는다(2,000자 상한)');
  assert.ok(calls.includes('GET /api/backupSessions/0f2b1c3d-1111-4222-8333-444455556666/taskSessions'));
  assert.ok(calls.some((c) => c.startsWith('DELETE /api/logonSessions/')));
  await assert.rejects(EC.sessionDetail(em, uid, { fetchImpl: async () => json({}, 401) }), (e) => e.authFailed === true);
});

test('E 라우트 — 매핑 저장 게이트 · 캐시 키 · 상세 404·403·인증 정지', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus, knownEmSessionUid, _resetEmDetailForTest } = await import('../src/routes/api/veeam.js');
  const { registerVeeamEm } = await import('../src/routes/admin/veeamEm.js');
  const ER = await import('../src/veeam/em/registry.js');
  const ES = await import('../src/veeam/em/store.js');
  const { emAuthGuard } = await import('../src/veeam/em/poller.js');
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: 'kr:vc1', name: 'vc1' }], hosts: [], vms: [] };
  ER._resetEmRegistryForTest(); M._resetEmMapForTest(); _resetEmDetailForTest();
  const em = ER.saveEm({ name: 'HQ', host: 'vem01.corp.local', username: 'svc', password: 'PW-1' });
  const UID = 'urn:veeam:BackupJobSession:0f2b1c3d-1111-4222-8333-444455556666';
  ES.putEmResult(em.id, { ok: true, ts: Date.now(), target: ER.emFingerprint(ER.getEmWithSecret(em.id)), sections: {}, notes: [], backupServers: [{ name: 'HM' }],
    jobs: [{ name: 'J', server: 'HM', last: { uid: UID, result: 'fail', end: NOW } }], sessions: { counts24: {}, recentBad: [] } });
  assert.equal(knownEmSessionUid(ES.getEmRecord(em.id).result, UID), true);
  let user = { username: 'adm', role: 'admin' };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const adm = express.Router(); registerVeeamEm(adm); app.use('/api/admin', adm);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => srv.close(() => ok())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const put = (body) => fetch(`${base}/admin/veeam/em/map`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const tab = async () => (await (await fetch(`${base}/tools/backup-em`)).json());
  assert.equal((await tab()).ems[0].data.backupServers[0].vcSource, null);
  assert.equal((await put({ emId: em.id, server: 'HM', vcenterIds: ['kr:vc1'] })).status, 200);
  assert.deepEqual((await tab()).ems[0].data.backupServers[0].vcNames, ['vc1'], '저장 즉시 EM 탭에 반영(캐시 키에 매핑 리비전)');
  const gl = await (await fetch(`${base}/admin/veeam/em`)).json();
  assert.equal(gl.mapping.rows[0].vcSource, 'manual');
  assert.equal((await put({ emId: 'nope', server: 'HM', vcenterIds: [] })).status, 404);
  user = { username: 'op', role: 'operator' };
  assert.equal((await put({ emId: em.id, server: 'HM', vcenterIds: [] })).status, 403, '운영자는 매핑을 바꾸지 못한다');
  user = { username: 'sa', role: 'admin', scope: { vcenters: ['kr:vc1'] } };
  assert.equal((await put({ emId: em.id, server: 'HM', vcenterIds: [] })).status, 403, '범위 관리자도 403');
  const det = (q) => fetch(`${base}/tools/backup-em/session?${new URLSearchParams(q)}`);
  assert.equal((await det({ em: em.id, uid: UID })).status, 403, '상세 — 범위 계정 403');
  user = { username: 'op', role: 'operator' };
  assert.equal((await det({ em: em.id, uid: 'urn:veeam:BackupJobSession:aaaaaaaa-1111-4222-8333-444455556666' })).status, 404, '저장된 결과에 없는 세션은 EM 에 묻지 않는다');
  emAuthGuard.markAuthStopped(em.id, ER.getEmWithSecret(em.id), '401');
  const st = await det({ em: em.id, uid: UID });
  assert.equal(st.status, 409);
  assert.equal((await st.json()).code, 'auth-stopped', '인증 정지면 접속하지 않는다');
  emAuthGuard.clearAuthStop(em.id);
});

test('F 소스 — 캐시 키·게이트', () => {
  const api = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(api, /\|map\$\{emMapRev\(\)\}`/);
  assert.match(api, /api\.get\('\/tools\/backup-em\/session', toolsPerm, fullScopeOnly,/);
  const adm = fs.readFileSync(new URL('../src/routes/admin/veeamEm.js', import.meta.url), 'utf8');
  assert.match(adm, /adminRouter\.put\('\/veeam\/em\/map', adminOnly, fleetWideOnly,/);
});
