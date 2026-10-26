/**
 * v2.788 — Veeam Enterprise Manager(EM) 수집 · 설정 하위 탭 · Veeam 'EM' 탭 · 라이선스 만료 알림·추이 · 저장소 사용량 이력.
 *  · 등록부   : 응답에 비밀번호 없음 · 접속처가 바뀌면 저장 비밀번호를 승계하지 않음 · 루프백 차단 · 손상은 보존(빈 값 위에 덮지 않음)
 *  · 수집기   : 로그인 401 → authFailed(주기 정지) · 항목 하나가 실패해도 나머지로 결과 · 로그아웃 · 오류 문구에 비밀번호 없음 ·
 *               세션 기간 필터를 거절하면 필터 없이 · 모든 항목 실패면 전체 실패
 *  · 정규화   : 필드 대소문자 무시 · 작업별 마지막 결과(기록 없으면 null — '정상' 이 아니다) · 24시간 집계
 *  · B&R 라이선스 : licenseOf · 엣지 결과 정제 뒤에도 남음(화이트리스트) · 실패 주기에도 lastOk 에 남음
 *  · 이력 DB  : 같은 날 다시 쓰면 갱신(이중 계수 없음) · 못 읽은 값은 NULL
 *  · 라이선스 알림 : 단계가 바뀔 때만 1회 · 처음 보는 정상은 기록만 · 만료일 모름은 판정 안 함 · 갱신은 '안내' 1회
 *  · 라우트   : EM 탭은 전체 범위만(범위 계정 403) · 관리자가 아니면 EM 주소를 싣지 않음 · 설정 라우트는 관리자 + 전체 범위 · 폴러는 엣지에서 돌지 않음
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeamEm2788-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
delete process.env.CENTRAL_URL;
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const ER = await import('../src/veeam/em/registry.js');
const EC = await import('../src/veeam/em/client.js');
const EP = await import('../src/veeam/em/parse.js');
const P = await import('../src/veeam/parse.js');
const ST = await import('../src/veeam/store.js');
const H = await import('../src/veeam/historyDb.js');
const LW = await import('../src/veeam/licenseWatch.js');
const { config } = await import('../src/config.js');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;
const DAY = 86_400_000;

const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
/** 가짜 EM — routes 의 응답을 돌려준다. 함수면 (url, init) 로 부른다. 부른 기록을 남긴다. */
function fakeEm(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, url: String(url), headers: init.headers || {} });
    if (key === 'POST /api/sessionMngr/') return routes.login ? routes.login(u, init) : json({ SessionId: 'logon-1' }, 201, { 'X-RestSvcSessionId': 'sess-abc' });
    if (key.startsWith('DELETE /api/logonSessions/')) return new Response(null, { status: 204 });
    const h = routes[u.pathname];
    if (!h) return json({ message: 'not found' }, 404);
    return typeof h === 'function' ? h(u, init) : json(h);
  };
  return { calls, fetchImpl };
}
const EM = { id: 'vem-t', name: 'HQ', host: 'vem01.corp.local', port: 9398, username: 'svc', password: 'S3cret-PW!' };

test('A 등록부 — 비밀번호 없음 · 접속처 변경 시 비밀 미승계 · 루프백 차단 · 손상 보존', () => {
  ER._resetEmRegistryForTest();
  const d = ER.saveEm({ name: 'HQ', host: 'vem01.corp.local', username: 'svc', password: 'PW-1' });
  assert.equal(d.port, ER.DEFAULT_EM_PORT);
  assert.equal(d.hasPassword, true);
  assert.ok(!JSON.stringify(ER.listEms()).includes('PW-1'), '목록에 비밀번호 없음');
  const st = fs.statSync(path.join(DIR, 'veeam-em.json'));
  assert.equal(st.mode & 0o777, 0o600);
  // 이름만 바꾸면 비밀번호 유지 · 주소를 바꾸면 폐기
  assert.equal(ER.saveEm({ id: d.id, name: 'HQ2', host: 'vem01.corp.local', username: 'svc', password: '' }).hasPassword, true);
  const moved = ER.saveEm({ id: d.id, name: 'HQ2', host: 'vem99.corp.local', username: 'svc', password: '' });
  assert.equal(moved.moved, true);
  assert.equal(ER.getEmWithSecret(d.id).password, undefined, '새 접속처로 옛 비밀번호를 보내지 않는다');
  assert.throws(() => ER.saveEm({ name: 'L', host: '127.0.0.1', username: 'u', password: 'p' }), /차단/);
  assert.throws(() => ER.saveEm({ name: 'X', host: 'vem99.corp.local', username: 'u', password: 'p' }), /이미 등록/);
  // 손상 — 원본을 보존하고 빈 목록(덮지 않는다)
  fs.writeFileSync(path.join(DIR, 'veeam-em.json'), '{"ems":[{"id":');
  ER._resetEmRegistryForTest();
  assert.deepEqual(ER.listEms(), []);
  assert.ok(ER.emRegistryLoadError());
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('veeam-em.json.corrupt')));
  fs.rmSync(path.join(DIR, 'veeam-em.json'), { force: true });
  ER._resetEmRegistryForTest();
});

test('B 수집기 — 로그인 401 은 authFailed · 오류 문구에 비밀번호 없음', async () => {
  const { fetchImpl } = fakeEm({ login: () => json({ message: 'bad' }, 401) });
  await assert.rejects(EC.collectEm(EM, { fetchImpl }), (e) => e.authFailed === true && !String(e.message).includes(EM.password));
  const echo = fakeEm({ login: () => json({ message: `invalid password ${EM.password}` }, 500) });
  await assert.rejects(EC.collectEm(EM, { fetchImpl: echo.fetchImpl }), (e) => !String(e.message).includes(EM.password) && /\*\*\*/.test(e.message));
});

test('B 수집기 — 항목 하나가 실패해도 나머지로 결과 · 세션 헤더 · 로그아웃 · 필터 거절이면 필터 없이 · 정규화', async () => {
  const sess = [
    { JobName: 'KR-Daily', JobUid: 'j1', Result: 'Failed', State: 'Stopped', CreationTimeUTC: new Date(NOW - 3 * 3600_000).toISOString(), EndTimeUTC: new Date(NOW - 2 * 3600_000).toISOString(), Links: [{ Type: 'BackupServerReference', Name: 'VBR-KR01' }] },
    { JobName: 'KR-Daily', JobUid: 'j1', Result: 'Success', State: 'Stopped', CreationTimeUTC: new Date(NOW - 30 * 3600_000).toISOString(), EndTimeUTC: new Date(NOW - 29 * 3600_000).toISOString() },
    { JobName: 'PL-App', JobUid: 'j2', Result: 'Warning', State: 'Stopped', CreationTimeUTC: new Date(NOW - 5 * 3600_000).toISOString(), EndTimeUTC: new Date(NOW - 4 * 3600_000).toISOString() },
    { JobName: 'US-Rep', JobUid: 'j3', Result: 'None', State: 'Working', CreationTimeUTC: new Date(NOW - 600_000).toISOString() },
  ];
  let filterSeen = 0;
  const { calls, fetchImpl } = fakeEm({
    '/api/reports/summary/overview': { BackupServers: 14, ProxyServers: 38, RunningJobs: 4, SuccessfulVmLastestStates: 5138, warningvmlastestStates: 186, FailedVmLastestStates: 88 },
    '/api/reports/summary/job_statistics': () => json({ message: 'boom' }, 500),
    '/api/reports/summary/vms_overview': { ProtectedVms: 5412, BackedUpVms: 5301, RestorePoints: null },
    '/api/reports/summary/repository': () => json({ message: `denied for ${EM.password}` }, 500),   // 항목 오류 문구가 비밀번호를 되울려도 가린다
    '/api/jobs': { Jobs: [{ Name: 'KR-Daily', UID: 'j1', JobType: 'Backup', Links: [{ Type: 'BackupServerReference', Name: 'VBR-KR01' }] }, { Name: 'PL-App', UID: 'j2' }, { Name: 'US-Rep', UID: 'j3' }, { Name: 'Idle', UID: 'j4' }] },
    '/api/repositories': { Repositories: [{ Name: 'R1', Capacity: 100, FreeSpace: 7, Links: [{ Type: 'BackupServerReference', Name: 'VBR-PL01' }] }, { Name: 'S3', Capacity: null, FreeSpace: null }] },
    '/api/query': (u) => {
      if (u.searchParams.get('filter')) { filterSeen++; return json({ message: 'filter not supported' }, 400); }
      if (u.searchParams.get('type') === 'ReplicaJobSession') return json({ message: 'no' }, 500);
      return json({ Entities: { BackupJobSessions: { BackupJobSessions: sess } } });
    },
  });
  const r = await EC.collectEm(EM, { fetchImpl, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.sections.overview.ok, true);
  assert.equal(r.sections.jobStats.ok, false, '작업 통계 실패는 그 항목만');
  assert.match(r.sections.jobStats.reason, /500/);
  assert.equal(r.sections.processed.ok, false, '404 도 그 항목만');
  assert.ok(!r.sections.repoReport.reason.includes(EM.password) && /\*\*\*/.test(r.sections.repoReport.reason), '항목 사유에 비밀번호 없음');
  assert.equal(r.jobStats, null);
  assert.deepEqual([r.overview.backupServers, r.overview.vmWarn, r.overview.scheduledJobs], [14, 186, null], '대소문자 무시 · 없는 필드는 null');
  assert.equal(r.vms.restorePoints, null, 'null 은 0 이 아니다');
  const byName = Object.fromEntries(r.jobs.map((j) => [j.name, j]));
  assert.deepEqual([byName['KR-Daily'].last.result, byName['KR-Daily'].server, byName['KR-Daily'].runs24.fail], ['fail', 'VBR-KR01', 1], '가장 늦게 끝난 세션');
  assert.equal(byName['PL-App'].last.result, 'warn');
  assert.ok(byName['US-Rep'].running && byName['US-Rep'].last === null, '실행 중 · 끝난 기록 없음');
  assert.equal(byName.Idle.last, null, '기록 없으면 null(정상이라 하지 않는다)');
  assert.deepEqual(r.sessions.counts24, { total: 2, ok: 0, warn: 1, fail: 1, running: 1 });
  assert.equal(filterSeen, 1);
  assert.ok(r.notes.some((n) => /필터 없이/.test(n)));
  assert.ok(r.notes.some((n) => /복제 작업 세션은 읽지 못했습니다/.test(n)), '복제 세션 실패는 백업 세션을 지우지 않는다');
  assert.equal(r.repositories.find((x) => x.name === 'R1').server, 'VBR-PL01');
  assert.ok(calls.filter((c) => c.key.startsWith('GET')).every((c) => c.headers['X-RestSvcSessionId'] === 'sess-abc'), 'GET 마다 세션 헤더');
  assert.ok(calls.some((c) => c.key === 'DELETE /api/logonSessions/logon-1'), '로그아웃');
  assert.ok(!JSON.stringify(r).includes(EM.password) && !JSON.stringify(r).includes('sess-abc'));
});

test('B 수집기 — 모든 항목 실패면 전체 실패(빈 결과를 성공으로 저장하지 않는다) · 로그인 뒤 401 은 정지하지 않는다', async () => {
  const all500 = fakeEm(Object.fromEntries(['/api/reports/summary/overview', '/api/reports/summary/job_statistics', '/api/reports/summary/vms_overview', '/api/reports/summary/processed_vms', '/api/reports/summary/repository', '/api/backupServers', '/api/jobs', '/api/repositories', '/api/query'].map((p) => [p, () => json({}, 500)])));
  await assert.rejects(EC.collectEm(EM, { fetchImpl: all500.fetchImpl }), /어떤 항목도/);
  const tok = fakeEm({ '/api/reports/summary/overview': () => new Response('', { status: 401 }) });
  await assert.rejects(EC.collectEm(EM, { fetchImpl: tok.fetchImpl }), (e) => e.status === 401 && !e.authFailed);
});

test('C B&R 라이선스 — licenseOf · 엣지 정제 뒤에도 남는다 · 실패 주기에도 lastOk 에 남는다', () => {
  const lic = P.licenseOf({ status: 'Valid', type: 'Subscription', edition: 'EnterprisePlus', expirationDate: '2027-03-31T00:00:00Z', supportExpirationDate: '2026-12-12T00:00:00Z',
    instanceLicenseSummary: { licensedInstancesNumber: 3000, usedInstancesNumber: 2410 }, socketLicenseSummary: { licensedSocketsNumber: null } });
  assert.deepEqual([lic.instances, lic.sockets, lic.edition], [{ licensed: 3000, used: 2410 }, null, 'EnterprisePlus']);
  assert.equal(P.licenseOf({ foo: 1 }), null);
  const clean = P.sanitizeServerResult({ ok: true, ts: NOW, jobs: [], vms: [], license: { ...lic, evil: '<x>', instances: { licensed: '3000', used: 2410 } } }, NOW);
  assert.deepEqual(clean.license.instances, { licensed: 3000, used: 2410 }, '문자열 수치는 수로');
  assert.equal(clean.license.evil, undefined, '모르는 필드는 버린다');
  ST._resetForTest();
  ST.putResult('vbr-x', { ok: true, ts: NOW, jobs: [], vms: [], counts: {}, notes: [], license: lic });
  ST.putResult('vbr-x', { ok: false, ts: NOW + 1, error: 'down', jobs: [], vms: [], counts: {}, notes: [] });
  assert.deepEqual(ST.usableResult(ST.getRecord('vbr-x')).license, lic);
});

test('D 이력 DB — 같은 날 다시 쓰면 갱신 · 못 읽은 값은 NULL · 조회', async () => {
  H._resetHistoryDbForTest();
  assert.equal(await H.recordLicenseDaily('vbr:a', { instances: { used: 10, licensed: 100 } }, NOW), true);
  await H.recordLicenseDaily('vbr:a', { instances: { used: 12, licensed: 100 } }, NOW + 60_000);
  await H.recordLicenseDaily('vbr:a', { instances: { used: null, licensed: 100 } }, NOW + DAY);
  const lh = await H.licenseHistory(90, NOW + DAY);
  assert.equal(lh['vbr:a'].length, 2, '하루 한 점');
  assert.deepEqual(lh['vbr:a'].map((x) => x[1]), [12, null], '그날 마지막 값 · 모름은 null');
  assert.equal(await H.recordRepoDaily('em:1', [{ key: 'VBR|R1', capacity: 100, free: 7 }, { key: '', capacity: 1 }], NOW), 1);
  assert.deepEqual((await H.repoHistory(90, NOW))['em:1#VBR|R1'][0].slice(1), [100, 7]);
});

test('E 라이선스 알림 — 단계가 바뀔 때만 · 처음 보는 정상은 기록만 · 만료일 모름은 판정 안 함 · 갱신은 안내 1회', () => {
  const it = (expires, supportExpires) => [{ id: 's1', name: 'VBR-1', license: { expires, supportExpires } }];
  let r = LW.evaluateLicenses(it(NOW + 200 * DAY, null), {}, NOW);
  assert.equal(r.fires.length, 0, '처음 보는 정상 — 알리지 않는다 · 모르는 지원 만료는 판정하지 않는다');
  assert.equal(r.next['s1:sup'], undefined);
  r = LW.evaluateLicenses(it(NOW + 25 * DAY, null), r.next, NOW);
  assert.deepEqual(r.fires.map((f) => [f.kind, f.stage, f.improved]), [['lic', 'd30', false]]);
  assert.equal(LW.alertOf(r.fires[0]).severity, 'warning');
  const again = LW.evaluateLicenses(it(NOW + 24 * DAY, null), r.next, NOW);
  assert.equal(again.fires.length, 0, '같은 단계는 다시 알리지 않는다(재시작 뒤에도 — 상태 파일)');
  const exp = LW.evaluateLicenses(it(NOW - DAY, null), again.next, NOW);
  assert.equal(LW.alertOf(exp.fires[0]).severity, 'critical');
  const renewed = LW.evaluateLicenses(it(NOW + 365 * DAY, null), exp.next, NOW);
  assert.deepEqual(renewed.fires.map((f) => [f.stage, f.improved]), [['ok', true]]);
  assert.equal(LW.alertOf(renewed.fires[0]).severity, 'info');
  const unknown = LW.evaluateLicenses(it(null, null), renewed.next, NOW);
  assert.equal(unknown.fires.length, 0);
  assert.equal(unknown.next['s1:lic'].stage, 'ok', '모르면 이전 상태를 그대로 둔다');
  assert.ok(!/`/.test(LW.alertOf(r.fires[0]).title));
});

test('F 폴러 — 엣지 노드에서는 EM 을 읽지 않는다', async () => {
  const EPL = await import('../src/veeam/em/poller.js');
  const prev = config.agent.centralUrl;
  config.agent.centralUrl = 'https://central.corp:4000';
  try {
    assert.deepEqual(ER.emsForThisNode(), []);
    const r = await EPL.pollEmOnce({ manual: true });
    assert.equal(r.skipped, true);
  } finally { config.agent.centralUrl = prev; }
});

test('G 라우트 — EM 탭 전체 범위만 · 관리자 아니면 주소 없음 · 설정 라우트 관리자+전체 범위 · 비밀번호 미노출', async () => {
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const { registerVeeamEm } = await import('../src/routes/admin/veeamEm.js');
  const ES = await import('../src/veeam/em/store.js');
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: 'kr:vc1', name: 'vc1' }, { id: 'pl:vc2', name: 'vc2' }], hosts: [], vms: [] };
  ER._resetEmRegistryForTest();
  const em = ER.saveEm({ name: 'HQ', host: 'vem01.corp.local', username: 'svc', password: 'ROUTE-PW' });
  ES.putEmResult(em.id, { ok: true, ts: Date.now(), target: ER.emFingerprint(ER.getEmWithSecret(em.id)), sections: { overview: { ok: true } }, notes: [], overview: { backupServers: 2 }, jobs: [{ name: 'J', server: 'S', last: { result: 'fail', end: NOW } }], repositories: [{ name: 'R', capacity: 10, free: 1 }] });
  let user = { username: 'op', role: 'operator' };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const adm = express.Router(); registerVeeamEm(adm); app.use('/api/admin', adm);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => srv.close(() => ok())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { status: r.status, body: await r.json() }; };
  let r = await get('/tools/backup-em');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ems[0].host, undefined, '관리자가 아니면 EM 주소를 싣지 않는다');
  assert.equal(r.body.ems[0].data.jobs.items[0].state, 'fail');
  assert.equal(r.body.ems[0].data.repositories[0].usedPct, 90);
  assert.ok(!JSON.stringify(r.body).includes('ROUTE-PW'));
  user = { username: 's', role: 'operator', scope: { vcenters: ['kr:vc1'] } };
  r = await get('/tools/backup-em');
  assert.equal(r.status, 403, '범위 계정 — EM 은 vCenter 귀속이 없다');
  assert.match(r.body.reason, /전체 범위/);
  assert.equal((await get('/admin/veeam/em')).status, 403, '설정 — 관리자만');
  user = { username: 'sa', role: 'admin', scope: { vcenters: ['kr:vc1'] } };
  assert.equal((await get('/admin/veeam/em')).status, 403, '설정 — 범위 관리자도 403');
  user = { username: 'adm', role: 'admin' };
  r = await get('/admin/veeam/em');
  assert.equal(r.status, 200);
  assert.equal(r.body.ems[0].hasPassword, true);
  assert.ok(!JSON.stringify(r.body).includes('ROUTE-PW'));
  r = await get('/tools/backup-em');
  assert.equal(r.body.ems[0].host, 'vem01.corp.local', '관리자 판본은 주소를 싣는다(캐시 키에 역할)');
  // 연결 시험은 저장된 EM 의 주소로만 — 본문 host 를 받지 않는다(루프백 대상이면 저장 단계에서 막힌다)
  const t = await fetch(`${base}/admin/veeam/em/${em.id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host: '127.0.0.1' }) });
  const tb = await t.json();
  assert.equal(tb.ok, false);
  assert.ok(!String(tb.reason).includes('127.0.0.1'), '요청 본문의 주소로 접속하지 않는다');
});

test('H 소스 — 조회 라우트 게이트·캐시 키 · 폴러 index 연결 · 비밀 파일 등록', () => {
  const api = fs.readFileSync(new URL('../src/routes/api/veeam.js', import.meta.url), 'utf8');
  assert.match(api, /api\.get\('\/tools\/backup-em', toolsPerm, fullScopeOnly,/);
  assert.match(api, /extraKey: `\$\{scopeKey\(req\.user, store\.get\(\)\)\}\|\$\{admin \? 'admin' : 'user'\}`/);
  const idx = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(idx, /startEmPoller, startLicenseWatch,/);
  const sv = fs.readFileSync(new URL('../src/security/secretVault.js', import.meta.url), 'utf8');
  assert.match(sv, /'veeam-em\.json',/);
  const gi = fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
  assert.match(gi, /server\/config\/veeam-em\.json/);
  assert.deepEqual([...EC.EM_SECTIONS], ['overview', 'jobStats', 'vms', 'processed', 'repoReport', 'backupServers', 'jobs', 'repositories', 'sessions']);
  assert.equal(typeof EP.pick, 'function');
});
