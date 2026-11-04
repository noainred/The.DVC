/**
 * test/bareosRehearsalBugs2873.test.js — v2.873 Bareos 복원 · 검증 점검(5축 + 반증 1인) 확정분 중 복원 검증(리허설) 회차.
 *  ① B4-01(재현): 늘 막히는 VM(빠듯한 홈 데이터스토어)이 앞에 서도 다음 후보로 perCorp 대를 채운다 · 건너뛴 VM 은 다음 회차에 뒤로(triedAt)
 *  ② B3-03: 끝맺음(NIC 끊기 · 켜 보기)을 돌릴 곳을 정할 수 없는 vCenter 의 VM 은 보내지 않는다
 *  ③ B2-01: 다른 요청이 잡은 대상은 건너뛴다(공용 대상 잠금) · 회차가 끝나면 잡은 잠금을 푼다
 *  ④ B4-03(재현): 기록은 Director 마다 최근 RUNS_PER_DIR 건(28 법인이 돌아도 앞 법인 기록이 사라지지 않는다)
 *  ⑤ B4-08 · B4-09: 원장을 못 읽거나 회차 차지를 파일에 못 남기면 보내지 않고 회차도 차지하지 않는다 · 0대 회차는 감사에 한 줄(B4-02)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareos2873rh-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const RH = await import('../src/bareos/rehearsal.js');
const registry = await import('../src/bareos/registry.js');
const locks = await import('../src/bareos/jobLocks.js');
const { store } = await import('../src/store.js');
const { listAudit } = await import('../src/audit.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const J = (id, vc, vm, name, dir, extra = {}) => ({ id, vcenterId: vc, vmId: `${vc}:${vm}`, vmName: name, dc: 'DC', folder: '/', directorId: dir, bareosJob: `pv-${id}`, enabled: true, lastRun: { jobid: 10, state: 'ok' }, restores: [], ...extra });
function seed(jobs) {
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), JSON.stringify({ version: 1, jobs, retired: [] }));
  registry._resetForTest();
}
const VM = (vc, vm, name, gb, ds) => ({ id: `${vc}:${vm}`, vcenterId: vc, name, storageGB: gb, vcDcPath: 'DC', folderPath: '/', dev: { disks: [{ datastore: ds }] } });

test('① B4-01 막힌 VM 이 앞에 서도 다음 후보로 채운다 · 건너뛴 VM 은 다음 회차에 뒤로', async () => {
  RH._resetRehearsalForTest();
  RH.savePolicy({ enabled: false, weekday: 6, time: '03:17', perCorp: 1 }, { by: 't' });
  store.snapshot = { generatedAt: Date.now(), vcenters: [{ id: 'vc-a' }], hosts: [],
    datastores: [{ vcenterId: 'vc-a', name: 'tiny', freeGB: 50, capacityGB: 100 }, { vcenterId: 'vc-a', name: 'roomy', freeGB: 5000, capacityGB: 8000 }],
    vms: [VM('vc-a', 'vm-1', 'aaa-big', 400, 'tiny'), VM('vc-a', 'vm-2', 'bbb-ok', 20, 'roomy')] };
  seed([J('a1', 'vc-a', 'vm-1', 'aaa-big', 'D1'), J('b1', 'vc-a', 'vm-2', 'bbb-ok', 'D1')]);
  // 예전: pickCandidates(…, 1) 이 'aaa-big' 하나만 돌려 판정에서 빠지고 0대(매주)
  const r = await RH.runRehearsal('D1');
  const it = Object.fromEntries(r.items.map((x) => [x.jobId, x]));
  assert.match(it.a1.reason, /여유가 부족/);
  // 다음 후보가 자리를 채워 보내기 단계까지 간다(데모 Director 는 이 가짜 jobid 를 모른다 — 고르기 결과만 본다)
  assert.ok(it.b1, '다음 후보가 자리를 채운다');
  assert.doesNotMatch(it.b1.reason || '', /건너뛰었습니다/);
  const st = JSON.parse(fs.readFileSync(path.join(tmp, 'bareos-rehearsal-state.json'), 'utf8'));
  assert.ok(st.triedAt.a1 > 0, '건너뛴 VM 의 시도 시각');
  assert.equal(st.triedAt.b1, undefined);
  // 다음 회차 순서: 시도 시각이 있는 a1 이 뒤로
  const order = { ...st.lastAt, ...st.triedAt };
  assert.deepEqual(RH.pickCandidates(registry.listJobs(), 'D1', 5, (j) => j.directorId, order).map((j) => j.id), ['b1', 'a1']);
});

test('② B3-03 끝맺음을 돌릴 곳을 정할 수 없는 vCenter 의 VM 은 보내지 않는다', async () => {
  RH._resetRehearsalForTest();
  RH.savePolicy({ enabled: false, weekday: 6, time: '03:17', perCorp: 3 }, { by: 't' });
  // vc-z 는 등록부에도 스냅샷 vCenter 목록에도 없다 → 실행 위치 'none'
  store.snapshot = { generatedAt: Date.now(), vcenters: [{ id: 'vc-a' }], hosts: [],
    datastores: [{ vcenterId: 'vc-z', name: 'roomy', freeGB: 5000, capacityGB: 8000 }], vms: [VM('vc-z', 'vm-9', 'ghost', 20, 'roomy')] };
  seed([J('z1', 'vc-z', 'vm-9', 'ghost', 'D2')]);
  const r = await RH.runRehearsal('D2');
  assert.equal(r.started, 0);
  assert.match(r.items[0].reason, /끝맺음/);
  assert.equal(registry.getJob('z1').restores.length, 0, 'Director 에 보내지 않았다');
  assert.equal(RH.finishBlockOf()('vc-a'), '', '스냅샷에 있는 데모 vCenter 는 보낼 수 있다');
});

test('③ B2-01 다른 요청이 잡은 대상은 건너뛰고, 회차가 끝나면 잡은 잠금을 푼다', async () => {
  RH._resetRehearsalForTest();
  RH.savePolicy({ enabled: false, weekday: 6, time: '03:17', perCorp: 3 }, { by: 't' });
  store.snapshot = { generatedAt: Date.now(), vcenters: [{ id: 'vc-a' }], hosts: [],
    datastores: [{ vcenterId: 'vc-a', name: 'roomy', freeGB: 5000, capacityGB: 8000 }],
    vms: [VM('vc-a', 'vm-3', 'held-03', 20, 'roomy'), VM('vc-a', 'vm-4', 'free-04', 20, 'roomy')] };
  seed([J('h3', 'vc-a', 'vm-3', 'held-03', 'D3'), J('f4', 'vc-a', 'vm-4', 'free-04', 'D3')]);
  assert.equal(locks.tryLockJob('h3'), true, '묶음 복원이 보내는 중(아직 원장에 없음)');
  try {
    const r = await RH.runRehearsal('D3');
    const it = Object.fromEntries(r.items.map((x) => [x.jobId, x]));
    assert.match(it.h3.reason, /다른 요청/);
    assert.ok(it.f4, '잡지 못한 대상만 빠진다');
    assert.doesNotMatch(it.f4.reason || '', /다른 요청|건너뛰었습니다/);
    assert.equal(registry.getJob('h3').restores.length, 0);
    assert.equal(locks.isJobLocked('f4'), false, '회차가 잡은 잠금은 풀었다');
    assert.equal(locks.isJobLocked('h3'), true, '남의 잠금은 건드리지 않는다');
  } finally { locks.unlockJob('h3'); }
});

test('④ B4-03 기록은 Director 마다 최근 RUNS_PER_DIR 건', () => {
  const runs = [];
  for (let w = 0; w < 6; w++) for (let d = 0; d < 28; d++) runs.push({ id: `r${w}-${d}`, directorId: `dir_c${String(d).padStart(2, '0')}` });
  const kept = RH.keepRunsPerDir(runs.reverse());   // 앞이 최신
  const per = new Map();
  for (const r of kept) per.set(r.directorId, (per.get(r.directorId) || 0) + 1);
  assert.equal(per.size, 28, '28 법인 모두 남는다(예전: 20건 공용 → 8 법인 소실)');
  assert.ok([...per.values()].every((n) => n === RH.RUNS_PER_DIR));
  assert.equal(kept[0].id, 'r5-27', '최신이 앞');
});

test('⑤ B4-08 · B4-09 원장 못 읽음 · 회차 저장 실패면 보내지 않고 회차도 차지하지 않는다 · 0대 회차는 감사(B4-02)', async () => {
  RH._resetRehearsalForTest();
  store.snapshot = { generatedAt: Date.now(), vcenters: [{ id: 'vc-a' }], hosts: [],
    datastores: [{ vcenterId: 'vc-a', name: 'roomy', freeGB: 5000, capacityGB: 8000 }], vms: [VM('vc-a', 'vm-5', 'app-05', 20, 'roomy')] };
  // 원장 손상
  fs.writeFileSync(path.join(tmp, registry.FILE_NAME), '{not json');
  registry._resetForTest();
  const r0 = await RH.runRehearsal('D5');
  assert.deepEqual([r0.deferred, r0.started], [true, 0]);
  assert.match(r0.reason, /원장/);
  assert.equal(RH.rehearsalStatus().weeks.D5, undefined, '미룬 회차는 차지하지 않는다');
  // 상태 파일을 쓸 수 없다(자리에 디렉터리)
  seed([J('a5', 'vc-a', 'vm-5', 'app-05', 'D5')]);
  RH._resetRehearsalForTest();
  const sf = path.join(tmp, 'bareos-rehearsal-state.json');
  try { fs.rmSync(sf, { force: true }); } catch { /* */ }
  RH.rehearsalStatus();   // 상태를 먼저 읽어 둔다(파일 없음 → 빈 상태) — 읽기가 아니라 **쓰기**만 실패하게
  fs.mkdirSync(sf);
  try {
    const r1 = await RH.runRehearsal('D5');
    assert.deepEqual([r1.deferred, r1.started], [true, 0]);
    assert.match(r1.reason, /상태 파일을 쓰지 못해/);
    assert.equal(RH.rehearsalStatus().weeks.D5, undefined, '메모리 차지도 되돌린다(다음 틱에 다시)');
    assert.equal(registry.getJob('a5').restores.length, 0, '보내지 않았다');
  } finally { fs.rmSync(sf, { recursive: true, force: true }); }
  // 0대 회차 감사
  RH._resetRehearsalForTest();
  seed([]);
  const r2 = await RH.runRehearsal('D6', { by: 'rehearsal' });
  assert.equal(r2.started, 0);
  assert.ok(listAudit({ limit: 50, q: r2.runId }).items.some((x) => /시작 0대/.test(x.detail)), '0대 회차도 감사에 남는다');
});
