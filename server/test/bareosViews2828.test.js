/**
 * test/bareosViews2828.test.js — v2.828 Bareos 조회 화면(통합 현황 bareos-summary · 법인별 현황 bareos-detail) + 백업 방식 'bareos' + 원장 상한.
 *  A 판정(bareos/vmView.js) — 미등록·잡·결과·오래됨·진행 · 못 읽은 값은 null(0 이 아니다) · Director 상태 · 부분 합
 *  B 원장 — MAX_JOBS 3,000 · 들여쓰기 없는 쓰기 · registryRev · jobDigests 는 사본 · lastOkAt 은 T·W
 *  C 라우트 — viewer 도 본다(조회 전용 · adminOnly 아님) · 범위 계정은 자기 vCenter 만(밖은 404) · 원장 손상은 모름 · Detail 의 b 칸 · CSV
 *  D 소스 — 조회 라우트는 Director 에 접속하지 않는다 · 캐시 키에 scopeKey·표시·원장 리비전 · 도구 키 매핑 · 방식 목록 한 곳
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosviews-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, '..', 'src', p), 'utf8');

const NOW = Date.now();
const H = 3_600_000;
const run = (jobid, status, endedAt, extra = {}) => ({ jobid, status, state: { T: 'ok', W: 'warning', f: 'error', R: 'running' }[status], level: 'Incremental', startedAt: endedAt - H, endedAt, bytes: 1024, files: 1, errors: 0, checkedAt: NOW, ...extra });

// 설정: vc-a(Seoul) 는 Director 있음 · vc-b(Warsaw) 는 매핑 없음(미설정)
fs.writeFileSync(path.join(tmp, 'bareos.json'), JSON.stringify({
  version: 2,
  directors: [{ id: 'dir_kr', name: 'KR-dir', host: 'bareos-kr.corp', port: 9101, consoleName: 'portal', password: 'pw-kr' }],
  defaults: {},
  sites: [{ vcenterId: 'vc-a', directorId: 'dir_kr', vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'kr-sd', pool: 'VMware-kr', schedule: 'VMwareNightly', configFile: '/etc/bareos/vmware/kr.ini' }],
}));
const job = (id, vcenterId, vmId, vmName, o = {}) => ({
  id, vcenterId, vmId, vmName, dc: 'DC', folder: '/old', directorId: vcenterId === 'vc-a' ? 'dir_kr' : 'dir_kr', bareosJob: `vm-${id}`, client: 'kr-fd', storage: 'kr-sd', pool: 'p', schedule: 'VMwareNightly',
  level: 'Incremental', enabled: true, createdBy: 'adm', createdAt: NOW - 30 * 24 * H, pending: null, lastRun: null, lastError: null, missingInDirector: false, restores: [], ...o,
});
fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), JSON.stringify({ version: 1, retired: [], jobs: [
  job('j1', 'vc-a', 'vc-a:vm-1', 'web-01', { lastRun: run(10, 'T', NOW - 2 * H), finishedRuns: [run(10, 'T', NOW - 2 * H)] }),           // 성공(최근)
  job('j2', 'vc-a', 'vc-a:vm-2', 'db-02', { lastRun: run(20, 'f', NOW - 3 * H), finishedRuns: [run(19, 'T', NOW - 50 * H), run(20, 'f', NOW - 3 * H)] }),   // 실패 · 마지막 백업 50시간 전(1일 초과)
  job('j3', 'vc-a', 'vc-a:vm-3', 'app-03', { pending: { jobid: 30, status: 'R', state: 'running' }, lastRun: run(30, 'R', null, { endedAt: null }) }),       // 진행 중 · 백업 없음
  job('j4', 'vc-a', 'vc-a:vm-gone', 'old-vm', { lastRun: run(40, 'W', NOW - 5 * H), finishedRuns: [run(40, 'W', NOW - 5 * H)] }),     // 인벤토리에 없음 · 경고
  job('j9', 'vc-b', 'vc-b:vm-9', 'pl-09', { lastRun: run(90, 'T', NOW - H) }),                                                        // 범위 밖 시험용
] }));
// 백업 방식: vm-1·vm-2 bareos(잡 있음) · vm-5 bareos(잡 없음 = 미등록) · vm-3 veeam(잡 있음 = 방식 불일치)
fs.writeFileSync(path.join(tmp, 'backup-marks.json'), JSON.stringify({
  'vc-a:vm-1': { method: 'bareos', crit: 'high' }, 'vc-a:vm-2': { method: 'bareos' }, 'vc-a:vm-5': { method: 'bareos', crit: 'high' }, 'vc-a:vm-3': { method: 'veeam' },
}));

const { stripComments } = await import('./_stripComments.js');
const VV = await import('../src/bareos/vmView.js');
const REG = await import('../src/bareos/registry.js');
const BS = await import('../src/veeam/backupStatus.js');
const BM = await import('../src/veeam/backupMarks.js');

let srv; let base; let store;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  viewer: { username: 'vw', role: 'viewer', scope: null },
  sv: { username: 'sv', role: 'operator', scope: { vcenters: ['vc-b'] } },
  sa: { username: 'sa', role: 'admin', scope: { vcenters: ['vc-b'] } },
};
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  ({ store } = await import('../src/store.js'));
  store.snapshot = {
    generatedAt: NOW, source: 'mock',
    vcenters: [{ id: 'vc-a', name: 'Seoul', host: 'https://vc-a.corp', location: { region: 'KR' } }, { id: 'vc-b', name: 'Warsaw', host: 'https://vc-b.corp', location: { region: 'PL' } }],
    hosts: [], datastores: [], alarms: [], networks: [],
    vms: [
      { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_ON', folder: 'A.MGMT/web', storageGB: 100 },
      { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'db-02', powerState: 'POWERED_ON', folder: 'A.MGMT/db', storageGB: 200 },
      { id: 'vc-a:vm-3', vcenterId: 'vc-a', name: 'app-03', powerState: 'POWERED_ON', folder: 'A.MGMT/app' },
      { id: 'vc-a:vm-5', vcenterId: 'vc-a', name: 'erp-05', powerState: 'POWERED_ON', folder: 'B.PROD', storageGB: 50 },
      { id: 'vc-a:vm-6', vcenterId: 'vc-a', name: 'misc-06', powerState: 'POWERED_ON', folder: 'B.PROD', storageGB: 10 },
      { id: 'vc-a:tpl', vcenterId: 'vc-a', name: 'tpl', template: true, powerState: 'POWERED_OFF', folder: 'B.PROD' },
      { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'pl-09', powerState: 'POWERED_ON', folder: 'PL' },
    ],
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/tools`;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
async function call(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('A-1 bareosVmView — 미등록·무관·마지막으로 끝난 실행·진행·마지막 백업(T·W)', () => {
  assert.deepEqual(VV.bareosVmView(null, 'bareos'), { job: false }, '방식 Bareos + 잡 없음 = 미등록');
  assert.equal(VV.bareosVmView(null, 'veeam'), undefined, '무관한 VM 은 키 없음');
  const d = REG.jobDigests().find((x) => x.id === 'j2');
  const b = VV.bareosVmView(d, 'bareos');
  assert.equal(b.st, 'error'); assert.equal(b.at, NOW - 3 * H); assert.equal(b.ok, NOW - 50 * H, '마지막 백업은 성공한 앞 실행');
  const r3 = VV.bareosVmView(REG.jobDigests().find((x) => x.id === 'j3'), 'veeam');
  assert.equal(r3.run, 'running'); assert.equal(r3.st, null, '끝난 실행이 없으면 결과 없음'); assert.equal(r3.ok, null);
  const r4 = VV.bareosVmView(REG.jobDigests().find((x) => x.id === 'j4'), '');
  assert.equal(r4.st, 'warning'); assert.equal(r4.ok, NOW - 5 * H, '경고(W)도 백업이 만들어졌다'); assert.equal(r4.by, 1024);
});

test('A-2 bareosClass · corpCounts — 모름은 null · 결과를 모르면 unknown = 잡 수 · 부분 합 표지', () => {
  const k = VV.bareosClass({ job: true, on: true, st: 'ok', ok: NOW - 2 * 86_400_000 }, { rpoDays: 1, now: NOW });
  assert.equal(k.old, true); assert.equal(VV.bareosClass({ job: true, on: true, st: 'ok', ok: NOW - 2 * 86_400_000 }, { rpoDays: 3, now: NOW }).old, false);
  assert.equal(VV.bareosClass(null).unknown, true); assert.equal(VV.bareosClass(null).job, false);
  const rows = [{ method: 'bareos', b: { job: true, on: true, st: 'ok', ok: NOW } }, { method: 'bareos', b: { job: false } }, { method: 'veeam', b: { job: true, on: false, st: 'error', ok: null } }];
  const c = VV.corpCounts(rows, { now: NOW });
  // v2.830 버그 점검 S16: '백업 없음' 은 켜진 잡만(웹 칩·우선 목록과 같은 판정) — 꺼진 잡(셋째 행)은 세지 않는다(예전 기대값 1 은 서버만 다르게 셌다)
  assert.deepEqual([c.bareosMethod, c.jobs, c.on, c.off, c.missing, c.mismatch, c.ok, c.fail, c.never], [2, 2, 1, 1, 1, 1, 1, 1, 0]);
  assert.equal(VV.corpCounts([{ method: 'bareos', b: { job: true, on: true, st: null, ok: null } }], { now: NOW }).never, 1, '켜진 잡의 백업 없음은 센다');
  const u = VV.corpCounts(rows, { resultsKnown: false, now: NOW });
  assert.deepEqual([u.ok, u.fail, u.old, u.run, u.unknown, u.jobs], [null, null, null, null, 2, 2], 'Director 를 못 읽으면 결과는 모름 — 잡 수는 원장으로 안다');
  const m = VV.corpCounts(rows, { marksKnown: false, now: NOW });
  assert.deepEqual([m.bareosMethod, m.missing, m.mismatch], [null, null, null]);
  const s = VV.sumCounts([c, u]);
  assert.equal(s.ok, 1); assert.equal(s.partial.ok, true, '모르는 법인이 있으면 부분 합');
});

test('A-3 directorState — 미설정·인증 정지·조회 실패는 결과를 모른다 · 회신 대기·조회 전은 안다', () => {
  const st = (o) => VV.directorState(o);
  assert.deepEqual(st({ mapped: false, configured: true }), { state: 'unset', resultsKnown: false });
  assert.deepEqual(st({ mapped: true, configured: true, authStopped: true, poll: { ok: true } }), { state: 'auth', resultsKnown: false });
  assert.deepEqual(st({ mapped: true, configured: true, poll: { ok: false } }), { state: 'error', resultsKnown: false });
  assert.deepEqual(st({ mapped: true, configured: true, poll: { ok: null, relay: 'pending' } }), { state: 'relay', resultsKnown: true });
  assert.deepEqual(st({ mapped: true, configured: true }), { state: 'pending', resultsKnown: true });
  assert.deepEqual(st({ mapped: true, configured: true, poll: { ok: true } }), { state: 'ok', resultsKnown: true });
});

test('B 원장 — 상한 3,000 · 들여쓰기 없는 쓰기 · 리비전 · jobDigests 는 사본', () => {
  assert.equal(REG.MAX_JOBS, 3000);
  const r0 = REG.registryRev();
  REG.patchJob('j9', { level: 'Full' });
  assert.ok(REG.registryRev() > r0, '쓰면 리비전이 오른다(응답 캐시 키)');
  const raw = fs.readFileSync(path.join(tmp, 'bareos-jobs.json'), 'utf8');
  assert.ok(!raw.includes('\n  '), '들여쓰기 없이 쓴다(3,000개에서 크기·직렬화 시간 — MAX_JOBS 실측)');
  const d = REG.jobDigests().find((x) => x.id === 'j1');
  d.lastRun.status = 'f'; d.vmName = 'x';
  const again = REG.jobDigests().find((x) => x.id === 'j1');
  assert.equal(again.lastRun.status, 'T'); assert.equal(again.vmName, 'web-01');
  assert.ok(!('restores' in again) && !('finishedRuns' in again), '조회용 요약에는 원문 이력이 없다');
});

test('B-2 백업 방식 bareos — 저장 · 글자 · Veeam 미백업 아님(서버 세 곳이 같은 목록)', () => {
  assert.ok(BM.METHOD_VALUES.includes('bareos'));
  assert.equal(BS.METHOD_TEXT.bareos, 'Bareos');
  assert.deepEqual(Object.keys(BS.METHOD_TEXT), [...BM.METHOD_VALUES], '방식 목록과 글자 표의 순서가 같다');
  assert.deepEqual([...BS.NOT_VEEAM_GAP], [...BM.NOT_VEEAM_GAP_MARKS], 'needGap 판정 목록 사본이 같다');
  const vm = { id: 'x', name: 'x', m: { method: 'bareos', need: true }, v: null, s: { ev: null } };
  assert.equal(BS.vmViewMatches(vm, 'needgap', { now: NOW }), false, 'Bareos 방식이면 Veeam 이 없어도 미백업 아님');
  assert.equal(BS.vmViewMatches({ ...vm, b: { job: false } }, 'bareos-missing', { now: NOW }), true);
  assert.equal(BS.vmViewMatches({ ...vm, b: null }, 'bareos-missing', { now: NOW }), false, '원장을 모르면 미등록이라 하지 않는다');
});

test('C-1 통합 현황 — 운영자도 본다(adminOnly 아님 · viewer 는 tools 권한이 없어 403) · 법인별 수 · 미설정 법인은 결과 모름 · 우선 확인', async () => {
  assert.equal((await call('viewer', '/bareos-summary')).s, 403, 'viewer 기본 권한에는 특수 기능(tools)이 없다 — 다른 도구와 같다');
  const r = await call('op', '/bareos-summary');
  assert.equal(r.s, 200, r.t);
  const a = r.j.rows.find((x) => x.id === 'vc-a');
  const b = r.j.rows.find((x) => x.id === 'vc-b');
  assert.equal(a.vm, 5, '템플릿은 VM 수에서 뺀다');
  assert.deepEqual([a.counts.bareosMethod, a.counts.jobs, a.counts.missing, a.counts.mismatch, a.counts.gone], [3, 4, 1, 1, 1]);
  assert.deepEqual([a.counts.ok, a.counts.warn, a.counts.fail, a.counts.run, a.counts.old, a.counts.never], [1, 1, 1, 1, 1, 1]);
  assert.equal(a.director.state, 'pending'); assert.equal(a.director.name, 'KR-dir');
  assert.ok(!('host' in a.director) && !r.t.includes('bareos-kr.corp') && !r.t.includes('pw-kr'), 'Director 주소·비밀번호 없음');
  assert.equal(b.director.state, 'unset'); assert.equal(b.counts.ok, null, '미설정 법인의 결과는 0 이 아니라 모름'); assert.equal(b.counts.unknown, 1);
  assert.equal(r.j.totals.partial.ok, true, '합계는 부분 합');
  const kinds = r.j.priority.map((x) => `${x.name}:${x.kind}`);
  assert.ok(kinds.includes('db-02:fail') && kinds.includes('erp-05:missing') && kinds.includes('app-03:never'), kinds.join(','));
  assert.equal(r.j.priority[0].crit, 'high', '중요도 상 먼저');
});

test('C-2 법인별 현황 — 행(방식 Bareos ∪ 잡) · 인벤토리에 없는 잡 · 잡 이름·최근 실행 · 범위 밖 404', async () => {
  const r = await call('op', '/bareos-detail?vcenterId=vc-a');
  assert.equal(r.s, 200, r.t);
  const names = r.j.rows.map((x) => x.name).sort();
  assert.deepEqual(names, ['app-03', 'db-02', 'erp-05', 'old-vm', 'web-01'], '방식 Bareos 도 잡도 없는 misc-06 은 빠진다');
  const gone = r.j.rows.find((x) => x.name === 'old-vm');
  assert.equal(gone.gone, true); assert.equal(gone.folder, '/old', '등록 때 위치');
  const db = r.j.rows.find((x) => x.name === 'db-02');
  assert.equal(db.job.name, 'vm-j2'); assert.deepEqual(db.runs.map((x) => x.st), ['error', 'ok'], '최근 끝난 실행 — 새 것 먼저');
  assert.equal(r.j.rows.find((x) => x.name === 'erp-05').b.job, false);
  assert.deepEqual(r.j.corps.map((x) => x.id), ['vc-a', 'vc-b']);
  const s = await call('sv', '/bareos-detail?vcenterId=vc-a');
  assert.equal(s.s, 404, '범위 밖 vCenter 는 존재를 숨긴다');
  const ss = await call('sv', '/bareos-summary');
  assert.deepEqual(ss.j.rows.map((x) => x.id), ['vc-b'], '범위 계정은 자기 법인만');
  assert.ok(!ss.t.includes('web-01'), '다른 법인의 VM 이름이 없다');
});

test('C-3 Backup Detail 의 b 칸 — 잡 있는 VM · 미등록 · 무관 VM 은 키 없음', async () => {
  const r = await call('admin', '/backup-detail?vcenterId=vc-a&excl=0');
  assert.equal(r.s, 200, r.t);
  const by = Object.fromEntries(r.j.vms.map((v) => [v.name, v]));
  assert.equal(by['web-01'].b.st, 'ok');
  assert.deepEqual(by['erp-05'].b, { job: false });
  assert.ok(!('b' in by['misc-06']), 'Bareos 와 무관한 VM 은 키가 없다');
  assert.equal(by['app-03'].b.run, 'running');
});

test('C-4 CSV — 범위·감사·열', async () => {
  const r = await fetch(`${base}/bareos-summary.csv`, { headers: { 'x-u': 'admin' } });
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /법인\(vCenter\),Director,Director 상태/);
  assert.match(t, /Warsaw,,미설정/);
  const d = await fetch(`${base}/bareos-detail.csv?vcenterId=vc-b`, { headers: { 'x-u': 'sa' } });
  assert.equal(d.status, 200);
  const nd = await fetch(`${base}/bareos-detail.csv?vcenterId=vc-a`, { headers: { 'x-u': 'sa' } });
  assert.equal(nd.status, 404);
});

test('C-5 원장 손상 — 잡·결과는 모름(null) · 미등록이라 하지 않는다', async () => {
  fs.writeFileSync(path.join(tmp, 'bareos-jobs.json'), '{ broken');
  REG._resetForTest();
  const r = await call('op', '/bareos-summary');
  assert.equal(r.j.registryUnreadable, true);
  const a = r.j.rows.find((x) => x.id === 'vc-a');
  assert.deepEqual([a.counts.jobs, a.counts.missing, a.counts.ok, a.counts.unknown], [null, null, null, null]);
  const d = await call('op', '/bareos-detail?vcenterId=vc-a');
  assert.ok(d.j.rows.every((x) => x.b === null), '방식 Bareos 인 VM 은 b=null(모름)');
});

test('D 소스 — 조회 라우트는 Director 에 접속하지 않는다 · 캐시 키 · 도구 키 · Detail 캐시 키에 원장 리비전', () => {
  const v = stripComments(src('routes/api/bareosViews.js'));
  for (const bad of ['onDirector', 'readDirector', 'withDirector', 'relayToEdge', 'pollOnce']) assert.ok(!v.includes(bad), `${bad} 를 쓰지 않는다`);
  assert.match(v, /scopeKey\(req\.user, snap\)/); assert.match(v, /marksRev\(\)/); assert.match(v, /registryRev\(\)/);
  assert.match(v, /requirePerm\('tools'\)/);
  const ta = src('auth/toolAccess.js');
  assert.match(ta, /'bareos-summary': 'bareos-summary'/); assert.match(ta, /'bareos-detail': 'bareos-detail'/);
  assert.match(src('routes/api/veeam.js'), /\|b\$\{bareosRegistryRev\(\)\}/);
  assert.match(src('toolcats/catalog.js'), /'bareos-summary', 'bareos-detail'/);
});
