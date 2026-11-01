/**
 * test/bareosBugs2847a.test.js — v2.847 Bareos 버그 점검 2회차(5축 + 반증 1인 — hunt2/R.md) A 묶음 회귀: 다시 등록 · 등록 · 원장.
 *  D2-3 다시 묶을 때 실행 기록은 카탈로그 세대가 바뀌었거나 모를 때만 새로 시작(같은 세대면 이어 감) · 비워도 진행 중 복원은 남긴다
 *  D2-2 빈 `.jobs` 는 '못 읽음'(409) · 다시 등록은 원장 이름 그대로만 만든다(있으면 건너뜀 — 접미사로 두 번째 잡을 만들지 않는다)
 *  E2-1 명령 도중 끊긴 등록은 '실패' 가 아니라 `.jobs` 로 가린다(다시 등록: 있으면 묶음 · 일반 등록: 원장 밖 잡은 끈다 · 없으면 확정 실패)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2847a-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const S = await import('../src/bareos/settings.js');
const REG = await import('../src/bareos/registry.js');
const SV = await import('../src/bareos/manage/service.js');
const svc = await import('../src/bareos/service.js');
const OPS = (await import('../src/bareos/ops.js')).OPS;
const { jobNameFor } = await import('../src/bareos/names.js');
const W = await import('../../web/src/views/tools/bareosCorpText.js');
const { store } = await import('../src/store.js');

const DIR = S.addDirector({ name: '한국', host: '10.20.30.40', port: 9101, consoleName: 'portal' }).director.id;
S.saveSettings({ sites: [{ vcenterId: 'vc-a', directorId: DIR, vcserver: 'vc-a.corp', client: 'kr-fd', storage: 'File', pool: 'VMwareKR', configFile: '/etc/bareos/vmware/vc-a.ini' }] });
after(() => { svc._setSessionFactoryForTest(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const VMS = [
  { id: 'vc-a:vm-10', vcenterId: 'vc-a', name: 'app-10', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
  { id: 'vc-a:vm-11', vcenterId: 'vc-a', name: 'app-11', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
  { id: 'vc-a:vm-12', vcenterId: 'vc-a', name: 'app-12', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
  { id: 'vc-a:vm-13', vcenterId: 'vc-a', name: 'app-13', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
  { id: 'vc-a:vm-14', vcenterId: 'vc-a', name: 'app-14', powerState: 'POWERED_ON', vcDcPath: 'DC-A', folderPath: '/app' },
];
const nameOf = (vmId, sfx = '') => jobNameFor('vc-a', vmId.split(':')[1], sfx);
const mk = (vmId, extra = {}) => REG.addJob({ vcenterId: 'vc-a', vmId, vmName: VMS.find((v) => v.id === vmId).name, dc: 'DC-A', folder: '/app', directorId: DIR, bareosJob: nameOf(vmId), client: 'kr-fd', storage: 'File', pool: 'VMwareKR', schedule: 'WeeklyCycle', level: 'Incremental', createdBy: 'adm', ...extra });
const run = (id, jobid, status = 'T') => REG.applyRunRow(id, { jobid, status, level: 'I', name: REG.getJob(id).bareosJob, type: 'B', starttime: '2026-10-01 01:00:00', endtime: '2026-10-01 01:10:00', jobbytes: 100, jobfiles: 1 });

/** 가짜 Director 세션 — have: `.jobs` 에 있는 이름 · catalog: `list jobs job=X` 의 행 · onAdd(name) 가 던지면 그대로. */
function fakeDirector({ have = ['RestoreFiles', 'BackupCatalog'], catalog = {}, onAdd = null, historyFails = false } = {}) {
  const names = new Set(have); const sent = [];
  svc._setSessionFactoryForTest(async () => ({
    info: { banner: 'OK: bareos-dir Version: 25.0.4 (01 Jan 2026)' }, close() {},
    call: async (cmd) => {
      sent.push(cmd);
      if (cmd === '.jobs') return { jobs: [...names].map((name) => ({ name })) };
      const lj = /^list jobs job=(\S+)$/.exec(cmd);
      if (lj) { if (historyFails) throw Object.assign(new Error('down'), { code: 'connect' }); return { jobs: (catalog[lj[1]] || []).map((jobid) => ({ jobid, name: lj[1], type: 'B', jobstatus: 'T', level: 'I' })) }; }
      if (cmd.startsWith('configure add job')) {
        const name = /name=(\S+)/.exec(cmd)[1];
        if (names.has(name)) throw Object.assign(new Error(`resource ${name} already exists`), { code: 'jsonrpc' });
        if (onAdd) { const r = onAdd(name, names); if (r instanceof Error) throw r; }
        names.add(name);
        return { add: { name } };
      }
      if (cmd.startsWith('disable job=')) return {};
      throw Object.assign(new Error(`bad ${cmd}`), { code: 'jsonrpc' });
    },
  }));
  return { sent, names };
}

function withSnap(fn) {
  return async () => {
    const prev = store.snapshot;
    store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }], hosts: [], datastores: [], vms: VMS, alarms: [], networks: [] };
    const ids = [];
    try { await fn(ids); } finally {
      store.snapshot = prev;
      for (const j of REG.listJobs()) REG.deleteJob(j.id, { directorId: DIR });
    }
  };
}

test('D2-2 빈 .jobs 는 판정 불가(409) — 전부 빠짐으로 보이지 않는다', withSnap(async () => {
  mk('vc-a:vm-10');
  fakeDirector({ have: [] });
  await assert.rejects(SV.missingTargets(S.directorById(DIR)), (e) => e.code === 'conflict' && /비어 왔습니다/.test(e.message));
  await assert.rejects(SV.reregisterTargets(S.directorById(DIR), [REG.listJobs()[0].id]), (e) => e.code === 'conflict');
}));

test('D2-2 다시 등록은 원장 이름 그대로만 — 그 이름이 생겼으면 건너뛰고 -r2 를 만들지 않는다(ops.addJobs exactSfx)', withSnap(async () => {
  const a = mk('vc-a:vm-10');
  // .jobs 를 읽은 뒤 add 직전에 사람이 같은 이름을 만든 경우(경쟁) — 예전에는 -r2 로 넘어갔다
  const fd = fakeDirector({ onAdd: null });
  const s = { call: async (cmd) => { if (cmd.startsWith('configure add job')) throw Object.assign(new Error('resource already exists'), { code: 'jsonrpc' }); return {}; } };
  const it = { key: 0, vcenterId: 'vc-a', moref: 'vm-10', base: { jobDefs: 'DefaultJob', client: 'kr-fd', storage: 'File', pool: 'VMwareKR', level: 'Incremental', pluginOptions: 'python3:x', description: 'd' } };
  const [r1] = await OPS.addJobs(s, { items: [{ ...it, exactSfx: '' }] });
  assert.deepEqual([r1.ok, r1.code], [false, 'exists']);
  assert.match(r1.message, /건너뜁니다/);
  // 접미사 칸이 없으면(일반 등록) 예전처럼 다음 이름을 쓴다 — 지운 대상의 비활성 잡을 피하는 규칙
  let n = 0; const s2 = { call: async (cmd) => { if (cmd.startsWith('configure add job')) { if (n++ === 0) throw Object.assign(new Error('resource already exists'), { code: 'jsonrpc' }); return { add: { name: /name=(\S+)/.exec(cmd)[1] } }; } return {}; } };
  const [r2] = await OPS.addJobs(s2, { items: [it] });
  assert.equal(r2.name, nameOf('vc-a:vm-10', 'r2'));
  // 다시 등록이 보내는 항목에는 원장 이름의 접미사가 실린다
  const r = await SV.reregisterTargets(S.directorById(DIR), [a.id]);
  assert.deepEqual(r.results.map((x) => [x.ok, x.name]), [[true, nameOf('vc-a:vm-10')]]);
  assert.equal(fd.sent.filter((c) => c.startsWith('configure add job')).length, 1);
  assert.ok(!fd.sent.some((c) => c.includes(`name=${nameOf('vc-a:vm-10', 'r2')}`)), '두 번째 잡을 만들지 않는다');
}));

test('D2-3 카탈로그가 그대로면 실행 기록을 이어 간다(커서 · 진행 중 복원 · runsEpoch 그대로)', withSnap(async () => {
  const a = mk('vc-a:vm-10');
  run(a.id, 5000); run(a.id, 5001, 'E');
  REG.addRestore(a.id, { jobid: 7001, status: 'R', at: Date.now() });
  const restoresBefore = REG.getJob(a.id).restores;
  fakeDirector({ catalog: { [a.bareosJob]: [4990, 5000, 5001] } });
  assert.equal(await SV.catalogGeneration(S.directorById(DIR)), 'same');
  const r = await SV.reregisterTargets(S.directorById(DIR), [a.id]);
  assert.equal(r.generation, 'same');
  const g = REG.getJob(a.id);
  assert.deepEqual([g.lastRun.jobid, g.finishedRuns.map((x) => x.jobid), g.runsEpoch, g.beforeRebind], [5001, [5000, 5001], undefined, undefined], '이미 알린 실패를 다시 알리지 않는다');
  assert.deepEqual(g.restores, restoresBefore);
  assert.match(W.reregisterSummary(r.results, r.generation).text, /이어 갑니다/);
}));

test('D2-3 카탈로그가 새로 만들어졌거나 판정하지 못하면 새로 시작 — 진행 중 복원은 남긴다', withSnap(async () => {
  const a = mk('vc-a:vm-10');
  run(a.id, 5001);
  // 진행 중 복원 1 + 끝난 복원 1
  REG.addRestore(a.id, { jobid: 7001 }); REG.addRestore(a.id, { jobid: 7000 });
  REG.applyRestoreRow(a.id, { jobid: 7000, status: 'T', startedAt: Date.now() - 60_000, endedAt: Date.now() });
  fakeDirector({ catalog: { [a.bareosJob]: [1, 2] } });
  assert.equal(await SV.catalogGeneration(S.directorById(DIR)), 'new');
  const r = await SV.reregisterTargets(S.directorById(DIR), [a.id]);
  assert.equal(r.generation, 'new');
  const g = REG.getJob(a.id);
  assert.equal(g.lastRun, null); assert.equal(g.beforeRebind.lastRun.jobid, 5001); assert.ok(g.runsEpoch > 0);
  assert.deepEqual(g.restores.map((x) => x.jobid), [7001], '진행 중 복원만 남긴다');
  // 판정 불가 → 새로 시작(D-1 의 '새 실행 버림' 이 더 큰 손실)
  const b = mk('vc-a:vm-11'); run(b.id, 9000);
  fakeDirector({ historyFails: true });
  assert.equal(await SV.catalogGeneration(S.directorById(DIR)), 'unknown');
  const r2 = await SV.reregisterTargets(S.directorById(DIR), [b.id]);
  assert.equal(r2.generation, 'unknown');
  assert.equal(REG.getJob(b.id).lastRun, null);
  // 원장에 실행 기록이 없으면 묻지 않는다
  for (const j of REG.listJobs()) REG.deleteJob(j.id, { directorId: DIR });
  mk('vc-a:vm-12');
  const fd = fakeDirector();
  assert.equal(await SV.catalogGeneration(S.directorById(DIR)), 'none');
  assert.ok(!fd.sent.some((c) => c.startsWith('list jobs')));
}));

test('E2-1 다시 등록 — 명령 도중 끊긴 항목은 .jobs 로 가린다(있으면 묶고 · 없으면 확정 실패)', withSnap(async () => {
  const a = mk('vc-a:vm-10'); const b = mk('vc-a:vm-11');
  run(a.id, 5001); run(b.id, 5002);
  // a: Director 가 만든 뒤 회신 전에 끊김 · b: 만들기 전에 끊김(세션째 죽어 b 는 '건너뜀' 이 아니라 같은 묶음 회신에서 closed)
  const closed = () => Object.assign(new Error('Director 가 연결을 닫았습니다.'), { code: 'closed' });
  let calls = 0;
  fakeDirector({ catalog: {}, onAdd: (name, names) => { calls += 1; if (calls === 1) { names.add(name); return closed(); } return closed(); } });
  const r = await SV.reregisterTargets(S.directorById(DIR), [a.id, b.id]);
  const ra = r.results.find((x) => x.id === a.id); const rb = r.results.find((x) => x.id === b.id);
  assert.deepEqual([ra.ok, ra.unknown, ra.name], [true, false, a.bareosJob], 'Director 에 생긴 잡은 같은 행에 묶는다(실행 기록 새로 시작 경로를 건너뛰지 않는다)');
  assert.ok(REG.getJob(a.id).runsEpoch > 0);
  assert.equal(rb.ok, false); assert.ok(!rb.unknown, '세션째 끊겨 보내지 않은 항목은 결과 모름이 아니다');
  assert.match(rb.reason, /건너뜀/);
  const sum = W.reregisterSummary([{ ok: true }, { ok: false, unknown: true }, { ok: false }], 'new');
  assert.match(sum.text, /성공 1 · 실패 1 · 결과 모름 1/, 'E2-6 결과 모름은 실패로 세지 않는다');
  // 감사도 같은 넷으로 센다
  const route = fs.readFileSync(new URL('../src/routes/api/bareosManage.js', import.meta.url), 'utf8');
  assert.match(route, /const unknown = r\.results\.filter\(\(x\) => !x\.ok && x\.unknown\)\.length;/);
  assert.match(route, /실패 \$\{r\.results\.length - ok - unknown - notSent\} · 결과 모름 \$\{unknown\} · 보내지 않음 \$\{notSent\}/);
}));

test('E2-1 일반 등록 — 명령 도중 끊기면 원장 밖 잡을 끄고 지운 이름에 남긴다(다시 등록해도 같은 VM 잡이 켜진 채 둘이 되지 않는다)', withSnap(async () => {
  const closed = () => Object.assign(new Error('Director 가 연결을 닫았습니다.'), { code: 'closed' });
  const fd = fakeDirector({ onAdd: (name, names) => { names.add(name); return closed(); } });
  const out = await svc.createBackupTargets({ vcenterId: 'vc-a', vmIds: ['vc-a:vm-13'], level: 'Incremental', schedule: 'WeeklyCycle', by: 'adm' });
  assert.equal(out[0].ok, false);
  assert.match(out[0].reason, /비활성화했습니다/);
  assert.ok(fd.sent.includes(`disable job=${nameOf('vc-a:vm-13')}`), fd.sent.slice(-4).join(' | '));
  assert.ok(REG.retiredNames().some((x) => x.name === nameOf('vc-a:vm-13') && x.directorId === DIR));
  // 만들기 전에 끊겼으면(Director 에 없음) 확정 실패 — 끌 것이 없다
  fakeDirector({ onAdd: () => closed() });
  await assert.rejects(svc.createBackupTarget({ vcenterId: 'vc-a', vmId: 'vc-a:vm-14', level: 'Incremental', schedule: 'WeeklyCycle', by: 'adm' }),
    (e) => e.code === 'error' && /만들어지지 않았습니다/.test(e.message));
}));
