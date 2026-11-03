/**
 * test/bareosRehearsalDigest2862.test.js — v2.862 Bareos 복원 검증(리허설) · 일일 요약 메일(순수 판정 · 마무리).
 *  ① 정책: 기본 꺼짐 · 틀린 값 거부(요일 · 시각 · 대수 · 데이터스토어 이름) · 차례(요일 · 시각 · 그날 한 번)
 *  ② 고르기: 그 Director · 활성 · 마지막 백업 성공 · 진행 중 복원 없음 · 위치 바뀜 없음 · 가장 오래 검증 안 한 순서 · 검증용 이름에 날짜
 *  ③ 요약: Director 조회 실패 법인은 '모름'(수를 만들지 않는다) · 24시간 밖 실행은 '실행 없음' · 실패 VM 목록 · 복원 검증 수 · 본문 이스케이프
 *  ④ 마무리: verify 복원은 'bareos-verify'(끊기 · 켜기 · Tools · 끄기 · 지우기 — 데모 경로) 결과가 원장 finish 에(Tools 시간 · 지움)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2862-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const RH = await import('../src/bareos/rehearsal.js');
const { DAY_OFFSET_MIN } = await import('../src/util/dayKey.js');
const DG = await import('../src/bareos/digest.js');
const registry = await import('../src/bareos/registry.js');
const { finishRestores } = await import('../src/bareos/restoreFinish.js');
const { store } = await import('../src/store.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('① 정책 — 기본 꺼짐 · 틀린 값 거부 · 차례', () => {
  assert.equal(RH.DEFAULTS.enabled, false, '검증은 VM 을 만든다 — 관리자가 켜야 돈다');
  assert.deepEqual([RH.DEFAULTS.weekday, RH.DEFAULTS.perCorp, RH.DEFAULTS.deleteOnOk], [6, 3, true]);
  assert.throws(() => RH.normPolicy({ weekday: 7 }), /요일/);
  assert.throws(() => RH.normPolicy({ time: '24:00' }), /시각/);
  assert.throws(() => RH.normPolicy({ perCorp: 0 }), /1~10/);
  assert.throws(() => RH.normPolicy({ perCorp: 11 }), /1~10/);
  assert.throws(() => RH.normPolicy({ datastores: { 'vc-a': 'ds"x' } }), /데이터스토어/);
  assert.deepEqual(RH.normPolicy({ enabled: 'yes' }).enabled, false, 'true 만 켠다');
  const p = RH.normPolicy({ enabled: true, weekday: 2, time: '04:10', perCorp: 2, deleteOnOk: false, datastores: { 'vc-a': ' ds-1 ', 'vc-b': '' } });
  assert.deepEqual(p, { enabled: true, weekday: 2, time: '04:10', perCorp: 2, deleteOnOk: false, datastores: { 'vc-a': 'ds-1' } });
  // 차례: 정한 요일의 정한 시각 뒤 · 그날 한 번
  const base = Date.UTC(2026, 10, 3, 0, 0) - DAY_OFFSET_MIN * 60_000;   // 포탈 시각 2026-11-03 00:00(화요일) — 모듈과 같은 오프셋
  const at = (h, m) => base + (h * 60 + m) * 60_000;
  const c = RH.clockOf(at(4, 11));
  assert.deepEqual([c.day, c.weekday], ['2026-11-03', 2]);
  assert.equal(RH.dueOf(p, '', at(4, 9)), false, '시각 전');
  assert.equal(RH.dueOf(p, '', at(4, 11)), true);
  assert.equal(RH.dueOf(p, c.day, at(4, 30)), false, '그날 이미 돌았다');
  assert.equal(RH.dueOf({ ...p, enabled: false }, '', at(4, 11)), false);
  assert.equal(RH.verifyName('web-01', '2026-11-03'), 'web-01-verify-20261103');
});

test('② 고르기 — 조건 · 돌아가며', () => {
  const ok = (id, extra = {}) => ({ id, vmName: id, vcenterId: 'vc-a', directorId: 'D1', enabled: true, lastRun: { jobid: 100, state: 'ok' }, restores: [], ...extra });
  const jobs = [
    ok('a'), ok('b'), ok('c', { lastRun: { jobid: 100, state: 'warning' } }),
    ok('d', { lastRun: { jobid: 100, state: 'error' } }), ok('e', { enabled: false }), ok('f', { directorId: 'D2' }),
    ok('g', { restores: [{ jobid: 9, state: 'running' }] }), ok('h'), ok('i', { lastRun: { jobid: null, state: 'ok' } }),
  ];
  const dirOf = (j) => j.directorId;
  const driftOf = (j) => (j.id === 'h' ? ['이름'] : null);   // 위치 바뀜은 인벤토리로(원장에는 drift 칸이 없다 — 반증 F8)
  assert.deepEqual(RH.pickCandidates(jobs, 'D1', 10, dirOf, {}, driftOf).map((j) => j.id), ['a', 'b', 'c']);
  assert.deepEqual(RH.pickCandidates(jobs, 'D1', 2, dirOf, { a: 5, b: 1 }, driftOf).map((j) => j.id), ['c', 'b'], '가장 오래 검증 안 한 것부터');
  // 반증 F3: 이름을 자를 때 날짜 꼬리를 지킨다(80자 VM 이 원래 이름과 같아지지 않게)
  const long = 'v'.repeat(80);
  const vn = RH.verifyName(long, '2026-11-03');
  assert.equal(vn.length, 80); assert.ok(vn.endsWith('-verify-20261103')); assert.notEqual(vn, long);
  assert.notEqual(RH.verifyName('x'.repeat(70), '2026-11-03'), RH.verifyName('x'.repeat(70), '2026-11-10'), '주마다 다른 이름');
});

test('③ 요약 — 모름은 수를 만들지 않는다 · 24시간 · 실패 목록 · 이스케이프', () => {
  const now = Date.now();
  const settings = { directors: [{ id: 'D1', name: '한국' }, { id: 'D2', name: '<폴란드>' }], sites: [] };
  const jobs = [
    { id: '1', vcenterId: 'vc-a', directorId: 'D1', vmName: 'web', enabled: true, lastRun: { jobid: 11, state: 'ok', endedAt: now - 3600_000 } },
    { id: '2', vcenterId: 'vc-a', directorId: 'D1', vmName: 'db<1>', enabled: true, lastRun: { jobid: 12, state: 'error', endedAt: now - 7200_000 }, lastError: { message: 'quiesce <fail>' } },
    { id: '3', vcenterId: 'vc-a', directorId: 'D1', vmName: 'old', enabled: true, lastRun: { jobid: 13, state: 'ok', endedAt: now - 3 * 86400_000 } },
    { id: '4', vcenterId: 'vc-b', directorId: 'D2', vmName: 'pl', enabled: true, lastRun: { jobid: 21, state: 'ok', endedAt: now - 1000 },
      restores: [{ jobid: 31, at: now - 1000, verify: true, state: 'ok', finish: { verify: 'failed' } }, { jobid: 32, at: now - 1000, state: 'error' }] },
    { id: '5', vcenterId: 'vc-a', directorId: 'D1', vmName: 'demo', enabled: true, demo: true, lastRun: { jobid: 1, state: 'error', endedAt: now } },
  ];
  const d = DG.digestData(jobs, settings, { D1: { ok: true }, D2: { ok: false, code: 'auth' } }, now);
  const kr = d.rows.find((x) => x.id === 'D1');
  assert.deepEqual([kr.targets, kr.ok, kr.fail, kr.stale], [3, 1, 1, 1]);
  const pl = d.rows.find((x) => x.id === 'D2');
  assert.equal(pl.known, false);
  assert.deepEqual([pl.verifyFail, pl.restores, pl.restoreFail], [1, 1, 1]);
  assert.deepEqual([d.total.ok, d.total.fail, d.total.unknown], [1, 1, 1], '모름 법인의 성공 수는 합에 넣지 않는다');
  assert.equal(d.fails.length, 1);
  const m = DG.renderDigest(d, now);
  assert.match(m.subject, /실패 1 · 경고 0 · 성공 1 · 결과 모름 법인 1/);
  assert.match(m.html, /&lt;폴란드&gt; \(Director 조회 실패 또는 조회 전 · auth\)/);
  assert.match(m.html, /db&lt;1&gt;/);
  assert.match(m.html, /quiesce &lt;fail&gt;/);
  assert.doesNotMatch(m.html, /<폴란드>|db<1>/);
  assert.match(m.html, /<td [^>]*>모름<\/td>/);
  // 반증 F4: 조회 기록이 없거나 ok:null 이면 '모름'(안다고 세지 않는다) · 취소는 따로 센다 · 모두 모름이면 0 을 앞세우지 않는다
  const jobs2 = [...jobs, { id: '6', vcenterId: 'vc-a', directorId: 'D1', vmName: 'cx', enabled: true, lastRun: { jobid: 14, state: 'canceled', endedAt: now - 1000 } }];
  const d2 = DG.digestData(jobs2, settings, { D1: { ok: true } }, now);
  assert.equal(d2.rows.find((x) => x.id === 'D2').known, false, '기록 없음 = 모름');
  assert.equal(d2.rows.find((x) => x.id === 'D1').cancel, 1);
  const d3 = DG.digestData(jobs, settings, { D1: { ok: null } }, now);
  assert.equal(d3.total.unknown, 2);
  assert.match(DG.renderDigest(d3, now).subject, /모든 법인 결과 모름/);
  assert.doesNotMatch(DG.renderDigest(d3, now).subject, /실패 0/);
  // 차례(staleAlert 와 같은 규칙) · 기본 켬 08:30
  assert.deepEqual([DG.DEFAULTS.enabled, DG.DEFAULTS.time], [true, '08:30']);
  assert.throws(() => DG.normDigest({ time: '8:30' }), /HH:MM/);
});

test('④ 검증 복원 마무리 — bareos-verify 결과(Tools 시간 · 지움)가 원장에', async () => {
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }], vms: [], hosts: [], datastores: [] };
  const now = Date.now();
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs: [
    { id: 'j1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', bareosJob: 'pv-a', restores: [
      { jobid: 901, status: 'T', state: 'ok', nic: 'disconnect', verify: true, deleteOnOk: true, rehearsal: 'rv-1', mode: 'newVm', target: { name: 'web-01-verify-20261103' }, at: now },
    ] },
  ], retired: [] }));
  registry._resetForTest();
  assert.equal(finishRestores(now), 1);
  const f = () => registry.getJob('j1').restores[0].finish;
  for (let i = 0; i < 40 && f()?.nic === 'pending'; i++) await new Promise((r) => setTimeout(r, 100));
  const fin = f();
  assert.ok(['ok', 'failed'].includes(fin.verify), JSON.stringify(fin));
  if (fin.verify === 'ok') { assert.ok(fin.toolsMs > 0); assert.equal(fin.deleted, true); assert.match(fin.detail, /Tools 응답/); }
  else { assert.equal(fin.toolsMs, undefined, 'Tools 를 못 받으면 시간을 만들지 않는다(0 아님)'); assert.equal(fin.deleted, undefined, '실패한 검증용 VM 은 지우지 않는다'); }
});

test('⑤ 반증 반영 — 빈 인벤토리면 미루고 회차를 차지하지 않는다(F3) · 홈 데이터스토어 여유를 본다(F5) · 회차는 보내기 전에 파일로(F2)', async () => {
  RH._resetRehearsalForTest();
  const today = RH.clockOf(Date.now()).day;
  store.snapshot = { initial: true, vms: [], hosts: [], datastores: [], vcenters: [] };
  const r0 = await RH.runRehearsal('D9');
  assert.equal(r0.deferred, true);
  assert.equal(RH.rehearsalStatus().weeks.D9, undefined, '미룬 회차는 차지하지 않는다');
  // 홈 데이터스토어: 여유 부족 · 정보 없음은 건너뛴다(보내지 않음 — Director 에 닿지 않는다)
  store.snapshot = { generatedAt: Date.now(), vcenters: [{ id: 'vc-a' }], hosts: [], datastores: [{ vcenterId: 'vc-a', name: 'tiny', freeGB: 50, capacityGB: 100 }],
    vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', storageGB: 200, vcDcPath: 'DC', folderPath: '/', dev: { disks: [{ datastore: 'tiny' }] } },
      { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'db-02', storageGB: 10, vcDcPath: 'DC', folderPath: '/' }] };
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs: [
    { id: 'k1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', dc: 'DC', folder: '/', directorId: 'D9', bareosJob: 'pv-1', enabled: true, lastRun: { jobid: 10, state: 'ok' }, restores: [] },
    { id: 'k2', vcenterId: 'vc-a', vmId: 'vc-a:vm-2', vmName: 'db-02', dc: 'DC', folder: '/', directorId: 'D9', bareosJob: 'pv-2', enabled: true, lastRun: { jobid: 11, state: 'ok' }, restores: [] },
  ], retired: [] }));
  registry._resetForTest();
  const r1 = await RH.runRehearsal('D9');
  assert.equal(r1.started, 0);
  const why = Object.fromEntries(r1.items.map((x) => [x.jobId, x.reason]));
  assert.match(why.k1, /여유가 부족/);
  assert.match(why.k2, /읽지 못해 건너뛰었습니다/);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-rehearsal-state.json'), 'utf8'));
  assert.equal(saved.weeks.D9, today);
  const src = fs.readFileSync(new URL('../src/bareos/rehearsal.js', import.meta.url), 'utf8');
  assert.match(src, /st\.weeks\[dirId\] = day;[^\n]*\n\s*if \(!saveState\(\)\) \{/, '회차 기록 바로 뒤에 파일 저장(보내기 전) — v2.872 B4-09 저장 실패면 보내지 않는다');
});

test('⑥ v2.863 정책에서 고른 데이터스토어 — 여유를 모르면 정기 검증이 보내지 않는다 · 인벤토리에 없으면 건너뜀 · 알면 판정을 지난다', async () => {
  RH._resetRehearsalForTest();
  RH.savePolicy({ enabled: false, weekday: 6, time: '03:17', perCorp: 3, deleteOnOk: true, datastores: { 'vc-a': 'shared-01', 'vc-b': 'gone-ds', 'vc-c': 'roomy' } }, { by: 't' });
  store.snapshot = { generatedAt: Date.now(), vcenters: [{ id: 'vc-a' }, { id: 'vc-b' }, { id: 'vc-c' }], hosts: [],
    datastores: [{ vcenterId: 'vc-a', name: 'shared-01', freeGB: null, capacityGB: 1000 }, { vcenterId: 'vc-c', name: 'roomy', freeGB: 5000, capacityGB: 8000 }],
    vms: [{ id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'app-01', storageGB: 40, vcDcPath: 'DC', folderPath: '/' },
      { id: 'vc-b:vm-2', vcenterId: 'vc-b', name: 'app-02', storageGB: 40, vcDcPath: 'DC', folderPath: '/' },
      { id: 'vc-c:vm-3', vcenterId: 'vc-c', name: 'app-03', storageGB: 40, vcDcPath: 'DC', folderPath: '/' }] };
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs: [
    { id: 'p1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'app-01', dc: 'DC', folder: '/', directorId: 'D8', bareosJob: 'pv-11', enabled: true, lastRun: { jobid: 21, state: 'ok' }, restores: [] },
    { id: 'p2', vcenterId: 'vc-b', vmId: 'vc-b:vm-2', vmName: 'app-02', dc: 'DC', folder: '/', directorId: 'D8', bareosJob: 'pv-12', enabled: true, lastRun: { jobid: 22, state: 'ok' }, restores: [] },
    { id: 'p3', vcenterId: 'vc-c', vmId: 'vc-c:vm-3', vmName: 'app-03', dc: 'DC', folder: '/', directorId: 'D8', bareosJob: 'pv-13', enabled: true, lastRun: { jobid: 23, state: 'ok' }, restores: [] },
  ], retired: [] }));
  registry._resetForTest();
  const r = await RH.runRehearsal('D8');
  const why = Object.fromEntries(r.items.map((x) => [x.jobId, x.reason || '']));
  assert.match(why.p1, /shared-01.*여유 · VM 용량을 읽지 못해 건너뛰었습니다/, '정한 DS 의 여유를 모르면 정기 작업은 보내지 않는다');
  assert.match(why.p2, /gone-ds.*인벤토리에 없습니다/, '인벤토리에 없는 DS 는 그 VM 만 건너뛴다');
  assert.doesNotMatch(why.p3, /여유|인벤토리에 없습니다/, '여유를 아는 DS 는 판정을 지나 보내기 단계로 간다');
  assert.equal(registry.getJob('p1').restores.length, 0);
  assert.equal(registry.getJob('p2').restores.length, 0);
});
