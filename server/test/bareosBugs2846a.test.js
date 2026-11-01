/**
 * test/bareosBugs2846a.test.js — v2.846 Bareos 버그 점검(5축 + 반증 1인) A 묶음 회귀: 재설치 뒤 다시 등록 · 원장 · 실패 메일 · 법인별 설정 · 계정 통합.
 *  D-1(높음) 다시 묶으면 jobid 기준 칸을 새로 시작 · 실패 메일 커서도(runsEpoch) — 새 카탈로그의 작은 jobid 가 버려지지 않는다
 *  E-1 다시 등록은 200건 묶음 · 엣지 회신에 없는 항목은 '결과 모름'(사유 미상 아님)
 *  E-4 묶지 못한 잡은 끄고 지운 이름에 남긴다(orphanCleanup 하나) · D-8 위치 칸도 지금 인벤토리 값
 *  D-6 지운 잡 이름 상한은 Director 마다 · D-5 스토리지 삭제 전제(그룹 스토리지 · 경로 없음 · 설정 못 읽음)
 *  C-4 엣지 대행 결과 모름이면 생성 비밀번호를 함께(적용됐을 수 있다) · 서버 예산 < 화면 시한
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2846a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const { generateSecret, generateToken } = await import('../src/auth/totp.js');
const SECRET = generateSecret();
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ username: 'adm', role: 'admin', totpEnabled: true, totpSecret: SECRET }] }));

const S = await import('../src/bareos/settings.js');
const REG = await import('../src/bareos/registry.js');
const N = await import('../src/bareos/notify.js');
const SV = await import('../src/bareos/manage/service.js');
const M = await import('../src/bareos/manage/apply.js');
const A = await import('../src/bareos/autoSetup.js');
const EO = await import('../src/bareos/edgeOps.js');
const G = await import('../src/bareos/groups.js');
const { fakeServer } = await import('./_fakeBareosSsh.js');
const { store } = await import('../src/store.js');

const DIR = S.addDirector({ name: '한국', host: '10.20.30.40', port: 9101, consoleName: 'portal', agent: 'edge-kr' }).director.id;
S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'File', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
after(() => { EO._resetForTest(); A._setDepsForTest(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/** 엣지 흉내 — 큐를 비우며 종류별로 답한다(answer(op) → 결과 봉투 · undefined 면 답하지 않음). */
function edgeLoop(answer) {
  let stop = false; const seen = [];
  (async () => {
    while (!stop) {
      for (const op of EO.takeEdgeOps('edge-kr', 5)) {
        seen.push(op);
        const r = await answer(op);
        if (r !== undefined) EO.completeEdgeOp(op.id, 'edge-kr', r);
      }
      await new Promise((res) => setTimeout(res, 5));
    }
  })();
  return { seen, stop: () => { stop = true; } };
}

test('D-1 다시 묶으면 실행 기록을 새로 시작 — 새 카탈로그의 작은 jobid 가 원장 · 실패 메일에 들어온다', () => {
  const j = REG.addJob({ vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'app-01', dc: 'DC', folder: '/', directorId: DIR, bareosJob: 'pv-1', client: 'c', storage: 's', pool: 'p', schedule: 'S', level: 'Incremental', createdBy: 'adm' });
  for (const id of [4990, 5001]) REG.applyRunRow(j.id, { jobid: id, status: 'T', level: 'I', name: 'pv-1', type: 'B', starttime: '2026-10-01 01:00:00', endtime: '2026-10-01 01:10:00', jobbytes: 100, jobfiles: 1 });
  assert.equal(REG.getJob(j.id).lastRun.jobid, 5001);
  // 재설치 전 메일 상태: 커서 5001
  const st0 = { since: 1, runs: { [j.id]: 5001 }, seen: {}, restores: {} };
  REG.rebindJobs([{ id: j.id, bareosJob: 'pv-1', client: 'kr-fd', storage: 'File', pool: 'VMwareKR', vmName: 'app-01-new', dc: 'DC2', folder: '/new' }]);
  const g = REG.getJob(j.id);
  assert.equal(g.lastRun, null); assert.deepEqual(g.finishedRuns, []); assert.equal(g.beforeRebind.lastRun.jobid, 5001);
  assert.deepEqual([g.vmName, g.dc, g.folder], ['app-01-new', 'DC2', '/new'], 'D-8 위치 칸도 지금 값');
  // 새 카탈로그: jobid 2 실패
  REG.applyRunRow(j.id, { jobid: 2, status: 'E', level: 'F', name: 'pv-1', type: 'B', starttime: '2026-11-02 01:00:00', endtime: '2026-11-02 01:05:00', jobbytes: 0, jobfiles: 0 });
  assert.equal(REG.getJob(j.id).lastRun.jobid, 2, '작은 jobid 도 lastRun 에 들어온다');
  const { rows, marks } = N.collectBareosFailures([REG.getJob(j.id)], st0);
  assert.deepEqual(rows.map((r) => r.jobid), [2], '옛 커서(5001)를 지우고 새 실패를 알린다');
  assert.equal(marks.epochs[j.id], g.runsEpoch);
  // 같은 세대로 다시 보면 커서가 이어진다(다시 알리지 않는다)
  const st1 = { since: 1, runs: { [j.id]: 2 }, seen: {}, restores: {}, epochs: { [j.id]: g.runsEpoch } };
  assert.equal(N.collectBareosFailures([REG.getJob(j.id)], st1).rows.length, 0);
  REG.deleteJob(j.id, { directorId: DIR });
});

test('D-6 지운 잡 이름 상한은 Director 마다 — 바쁜 법인이 다른 법인 이름을 밀어내지 않는다', () => {
  const list = []; for (let i = 0; i < REG.RETIRED_KEEP + 300; i += 1) list.push({ name: `a${i}`, directorId: 'A' });
  list.unshift({ name: 'b-old', directorId: 'B' });
  const t = REG.trimRetired(list);
  assert.ok(t.some((x) => x.name === 'b-old'), '다른 Director 의 이름은 남는다');
  assert.equal(t.filter((x) => x.directorId === 'A').length, REG.RETIRED_KEEP);
  assert.ok(t.some((x) => x.name === `a${REG.RETIRED_KEEP + 299}`) && !t.some((x) => x.name === 'a0'), 'Director 안에서는 오래된 것부터 버린다');
});

test('E-1 · E-4 다시 등록: 200건 묶음 · 회신에 없는 항목은 결과 모름 · 묶지 못한 잡은 끄고 지운 이름에', async () => {
  const vms = []; for (let i = 0; i < 450; i += 1) vms.push({ id: `vc-a:vm-${100 + i}`, vcenterId: 'vc-a', name: `vm${i}`, powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' });
  const prev = store.snapshot;
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }], hosts: [], datastores: [], vms, alarms: [], networks: [] };
  const ids = REG.addJobs(vms.map((v) => ({ vcenterId: 'vc-a', vmId: v.id, vmName: v.name, dc: 'DC-A', folder: '/app', directorId: DIR, bareosJob: `pv-x-${v.id.split('-').pop()}`, client: 'c', storage: 's', pool: 'p', schedule: '', level: 'Incremental', createdBy: 'adm' }))).map((x) => x.job.id);
  const victim = ids[5];
  const loop = edgeLoop(async (op) => {
    if (op.kind === 'jobNames') return { ok: true, value: { names: [] } };
    if (op.kind === 'disableJobs') return { ok: true, value: op.args.names.map((name) => ({ name, ok: true })) };
    if (op.kind === 'addJobs') {
      const items = op.args.items;
      // 첫 묶음: 마지막 10건은 회신에서 빠진다(엣지 계약 상한 · 잘림 흉내) · victim 은 만든 직후 원장에서 지워진다(묶기 실패)
      const out = items.map((it) => ({ key: it.key, ok: true, name: `pv-new-${it.key}` }));
      if (items.some((it) => it.key === 5)) REG.deleteJob(victim, { directorId: DIR });
      return { ok: true, value: items.length === 200 && items[0].key === 0 ? out.slice(0, 190) : out };
    }
    return undefined;
  });
  try {
    const r = await SV.reregisterTargets(S.directorById(DIR), ids);
    const adds = loop.seen.filter((o) => o.kind === 'addJobs');
    assert.deepEqual(adds.map((o) => o.args.items.length), [200, 200, 50], '200건 묶음');
    const miss = r.results.filter((x) => x.unknown);
    assert.equal(miss.length, 10);
    assert.match(miss[0].reason, /결과 모름/, "회신에 없는 항목은 '사유 미상' 이 아니다");
    const v = r.results.find((x) => x.id === victim);
    assert.equal(v.ok, false);
    assert.match(v.reason, /비활성화했습니다/);
    assert.ok(REG.retiredNames().some((x) => x.name === v.name && x.directorId === DIR), 'E-4: 지운 이름에 남긴다(다음 reload 대조가 다시 끈다)');
    assert.ok(loop.seen.some((o) => o.kind === 'disableJobs' && o.args.names.includes(v.name)));
    assert.equal(r.results.filter((x) => x.ok).length, 450 - 10 - 1);
  } finally {
    loop.stop(); store.snapshot = prev;
    for (const id of ids) REG.deleteJob(id, { directorId: DIR });
  }
});

test('D-5 스토리지 삭제 전제: 그룹이 쓰는 스토리지 · 경로 없음 · 설정 못 읽음', async () => {
  const d = S.directorById(DIR);
  const known = SV.knownFor(d, { results: { storages: { ok: true, value: [{ name: 'File' }, { name: 'Grp', address: 'x' }] } } }, S.loadSettings(), [{ vcenterId: 'vc-a', storage: 'Grp' }]);
  assert.ok(known.mappedStorages.includes('Grp'), '그룹 저장 위치도 매핑으로 본다');
  assert.throws(() => M.planManage('storage.delete', { name: 'Grp' }, known), /매핑/);
  // ③ 설정을 못 읽으면 판정하지 않는다(엣지 대행 config 가 실패)
  const loop = edgeLoop(async (op) => (op.kind === 'config' ? { ok: false, code: 'connect', reason: 'down' } : undefined));
  try {
    await assert.rejects(SV.planFor(d, 'storage.delete', { name: 'Nas' }), (e) => e.code === 'conflict' && /읽지 못해/.test(e.message));
  } finally { loop.stop(); SV.forgetConfig(DIR); }
  // ② 볼륨 경로가 없으면 0 으로 보지 않는다
  const dev = M.sdDeviceText({ device: 'NasStorage', mediaType: 'Nas', archiveDevice: '/mnt/nas01/bareos', count: 10, description: '' });
  const sto = M.dirStorageText({ name: 'Nas', address: 'b', sdPassword: 'p', device: 'NasStorage', mediaType: 'Nas', count: 10, description: '' });
  const srv = fakeServer({ env: 'D S C U', files: { '/etc/bareos/bareos-sd.d/device/NasStorage.conf': dev, '/etc/bareos/bareos-dir.d/storage/Nas.conf': sto } });
  const base = srv.ssh;
  srv.ssh = (creds, fn, opts) => base(creds, (api) => fn({ ...api, exec: async (c) => (c.includes('echo "N=$(find') ? { code: 0, stdout: 'MISSING\n', stderr: '' } : api.exec(c)) }), opts);
  A._setDepsForTest({ ssh: srv.ssh, sleep: async () => {} });
  await assert.rejects(M.applyManage(M.planManage('storage.delete', { name: 'Nas' }, {}), { host: '10.20.30.40', password: 'x1234567' }, {}), (e) => e.code === 'conflict' && /경로.*없습니다/.test(e.message));
  assert.ok(srv.F.has('/etc/bareos/bareos-dir.d/storage/Nas.conf'));
  void G;
});

/* ───────── C-4 라우트 ───────── */
let srvHttp; let base;
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  srvHttp = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srvHttp.address().port}/api/tools/bareos-backup/settings`;
});
after(() => { try { srvHttp?.close(); } catch { /* */ } });
const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { s: r.status, j: await r.json().catch(() => null) }; };

test('C-4 엣지 결과 모름이면 생성 비밀번호를 함께(적용됐을 수 있다) · 서버 예산 < 화면 시한(600초)', async () => {
  const R = await import('../src/routes/api/bareosManage.js');
  assert.ok(R.MANAGE_BUDGET_MS < 600_000 && R.BULK_BUDGET_MS < 600_000 && R.BULK_START_CUTOFF_MS < R.BULK_BUDGET_MS);
  const cfg = { results: { storages: { ok: true, value: [] }, consoles: { ok: true, value: [{ name: 'portal' }] }, profiles: { ok: true, value: [{ name: 'webui-readonly' }] }, pools: { ok: true, value: [] }, schedules: { ok: true, value: [] } }, version: '' };
  const loop = edgeLoop(async (op) => (op.kind === 'config' ? { ok: true, value: cfg } : op.kind === 'setup.manage' ? { ok: false, code: 'unknown', reason: '엣지가 시한 안에 끝내지 못했습니다' } : undefined));
  try {
    const one = await post(`/corp/${DIR}/manage`, { action: 'console.add', input: { name: 'ops1', profile: 'webui-readonly' }, generate: true, ssh: { host: '10.20.30.40', password: 'ssh-pw-123456' }, otp: generateToken(SECRET) });
    assert.equal(one.s, 504);
    assert.equal(one.j.maybeApplied, true);
    assert.match(one.j.generatedPassword, /^[A-Za-z0-9_-]{24}$/);
    const bulk = await post('/accounts/bulk', { action: 'console.add', name: 'ops2', profile: 'webui-readonly', directorIds: [DIR], generate: true, ssh: { [DIR]: { host: '10.20.30.40', password: 'ssh-pw-123456' } }, otp: generateToken(SECRET, { counter: Math.floor(Date.now() / 30000) + 1 }) });
    assert.equal(bulk.s, 200, JSON.stringify(bulk.j));
    const row = bulk.j.results[0];
    assert.equal(row.status, 'unknown');
    assert.equal(row.maybeApplied, true);
    assert.match(row.generatedPassword, /^[A-Za-z0-9_-]{24}$/);
  } finally { loop.stop(); }
});
