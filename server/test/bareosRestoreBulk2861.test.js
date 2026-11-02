/**
 * test/bareosRestoreBulk2861.test.js — v2.861 Bareos 묶음 복원(폴더에서 고른 VM 여러 대) · 디스크 불일치 허용 · 복원 뒤 NIC 끊기 마무리.
 *  ① bulkRestorePlan(순수): 1~50대 · 같은 대상 두 번 금지 · **2대 이상이면 덮어쓰기 금지**(사용자 결정 ⓐ) · 다른 법인 Director 섞기 금지 ·
 *     묶음 안 새 VM 이름 겹침 금지 · NIC 기본(새 VM 끊기 · 덮어쓰기 그대로 · 로컬 VMDK 없음) · 하나라도 막히면 묶음 전체 거부
 *  ② 데이터스토어 여유: 같은 DS 로 가는 VM 의 committed 합 + 남겨 둘 여유 · 못 읽으면 'unknown'(막지도 통과로 단정하지도 않는다)
 *  ③ restorePlan allowDisksMismatch — 덮어쓰기만 · 기본 꺼짐 · names.js 화이트리스트
 *  ④ ops.restorePoints / ops.restores — 세션 하나 · 성공 백업만 · 체인 길이 · 세션째 끊기면 남은 것 건너뜀 · 보낸 뒤 끊기면 결과 모름 · MUTATING
 *  ⑤ 엣지 회신 정제(edgeResult) — 아는 칸만 · 성공인데 rid 없으면 결과 모름 · RESULT_MS
 *  ⑥ finishRestores — 실패한 복원은 skipped · 성공 복원은 vmclone 'bareos-nic' 작업 · 재시작으로 작업을 잃으면 다시(최대 3) · 옛 작업의 늦은 결과는 새 시도를 덮지 않는다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bareosbulk2861-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';

const R = await import('../src/bareos/restore.js');
const { OPS, MUTATING, SESSION_DEAD } = await import('../src/bareos/ops.js');
const { sanitizeEdgeResult } = await import('../src/bareos/edgeResult.js');
const { RESULT_MS } = await import('../src/bareos/edgeOps.js');
const registry = await import('../src/bareos/registry.js');
const dispatch = await import('../src/vmclone/dispatch.js');
const { finishRestores, MAX_TRIES } = await import('../src/bareos/restoreFinish.js');
const { store } = await import('../src/store.js');
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const JOBS = {
  a: { id: 'a', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', dc: 'DC-A', folder: '/web', dir: 'D1' },
  b: { id: 'b', vcenterId: 'vc-a', vmId: 'vc-a:vm-2', vmName: 'app-02', dc: 'DC-A', folder: '/app', dir: 'D1' },
  c: { id: 'c', vcenterId: 'vc-b', vmId: 'vc-b:vm-9', vmName: 'db-09', dc: 'DC-B', folder: '/', dir: 'D2' },
};
const SNAP = {
  vms: [
    { id: 'vc-a:vm-1', vcenterId: 'vc-a', name: 'web-01', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/web', storageGB: 300 },
    { id: 'vc-a:vm-2', vcenterId: 'vc-a', name: 'app-02', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-A', folderPath: '/app', storageGB: 400 },
    { id: 'vc-b:vm-9', vcenterId: 'vc-b', name: 'db-09', powerState: 'POWERED_ON', snapshotCount: 0, vcDcPath: 'DC-B', folderPath: '/', storageGB: null },
  ],
  hosts: [{ vcenterId: 'vc-a', name: 'esx-1', cluster: 'CL-A' }],
  datastores: [
    { vcenterId: 'vc-a', name: 'ds-big', freeGB: 5000, capacityGB: 10000 },
    { vcenterId: 'vc-a', name: 'ds-small', freeGB: 780, capacityGB: 2000 },
    { vcenterId: 'vc-a', name: 'ds-unknown', freeGB: null, capacityGB: 1000 },
  ],
};
const plan = (items, snap = SNAP) => R.bulkRestorePlan({ items, jobOf: (id) => JOBS[id] || null, dirOf: (j) => j.dir, snapshot: snap });
const nv = (id, name, extra = {}) => ({ id, jobid: 130, mode: 'newVm', newVm: { name, ...extra } });

test('① 묶음 판정 — 상한 · 중복 · 덮어쓰기 금지 · 다른 법인 · 이름 겹침 · 하나라도 막히면 전체 거부', () => {
  assert.equal(R.BULK_RESTORE_MAX, 50);
  assert.match(plan([]).issue, /고르세요/);
  assert.match(plan(Array.from({ length: 51 }, (_, i) => nv('a', `x${i}`))).issue, /50대까지/);
  let p = plan([nv('a', 'web-01-r'), nv('a', 'web-01-r2')]);
  assert.equal(p.ok, false);
  assert.match(p.items[1].issue, /두 번/);
  p = plan([{ id: 'a', jobid: 130, mode: 'original', confirmName: 'web-01' }, nv('b', 'app-02-r')]);
  assert.equal(p.ok, false, '2대 이상이면 덮어쓰기 금지');
  assert.match(p.items[0].issue, /1대씩/);
  assert.equal(p.items[1].ok, true);
  assert.match(p.issue, /묶음 전체를 보내지 않았습니다/);
  // 1대면 덮어쓰기 가능(꺼짐 · 스냅샷 0 · 이름 재입력)
  p = plan([{ id: 'a', jobid: 130, mode: 'original', confirmName: 'web-01' }]);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.items[0].nic, 'keep', '덮어쓰기 기본은 그대로');
  p = plan([nv('a', 'web-01-r'), nv('c', 'db-09-r')]);
  assert.equal(p.ok, false);
  assert.match(p.items[1].issue, /다른 법인/);
  p = plan([nv('a', 'Same'), nv('b', 'same')]);
  assert.match(p.items[1].issue, /겹칩니다/, '묶음 안 이름 겹침(대소문자 무시)');
  p = plan([nv('a', 'web-01-r'), { id: 'b', jobid: 0, mode: 'newVm', newVm: { name: 'x' } }]);
  assert.match(p.items[1].issue, /jobid/);
  p = plan([nv('a', 'web-01-r'), { id: 'zz', jobid: 130, mode: 'newVm', newVm: { name: 'q' } }]);
  assert.match(p.items[1].issue, /찾지 못했습니다/);
  // NIC: 새 VM 기본 끊기 · 로컬 VMDK 없음 · 모르는 값 거부
  p = plan([nv('a', 'web-01-r'), { id: 'b', jobid: 130, mode: 'localVmdk' }]);
  assert.equal(p.ok, true, JSON.stringify(p.items));
  assert.deepEqual(p.items.map((x) => x.nic), ['disconnect', null]);
  assert.equal(p.directorId, 'D1');
  p = plan([{ ...nv('a', 'web-01-r'), nic: 'keep' }, { ...nv('b', 'app-02-r'), nic: 'cut' }]);
  assert.deepEqual([p.items[0].nic, p.items[1].ok], ['keep', false]);
  // 항목마다 restorePlan — 같은 vCenter 의 동명 VM
  p = plan([nv('a', 'app-02')]);
  assert.match(p.items[0].issue, /이미 있습니다/);
});

test('② 데이터스토어 여유 — 같은 DS 합산 · 부족하면 그 VM 들을 막는다 · 못 읽으면 unknown(막지 않는다)', () => {
  // ds-small: 여유 780GB, 필요 300+400=700GB + 남길 여유 max(10GiB, 5% × 2000GB = 100GB) → 부족(경계 100GB 정확히는 통과 — capacityShortfall 은 '<')
  let p = plan([nv('a', 'web-01-r', { datastore: 'ds-small' }), nv('b', 'app-02-r', { datastore: 'ds-small' })]);
  assert.equal(p.ok, false);
  const c = p.capacity.find((x) => x.datastore === 'ds-small');
  assert.deepEqual([c.verdict, c.needGB, c.freeGB], ['short', 700, 780]);
  assert.match(p.items[0].issue, /ds-small/);
  assert.match(p.items[1].issue, /여유가 부족/);
  // 한 대만이면 300 + 100 < 780 — 통과
  p = plan([nv('a', 'web-01-r', { datastore: 'ds-small' })]);
  assert.equal(p.ok, true);
  assert.equal(p.capacity[0].verdict, 'ok');
  // 여유를 못 읽은 DS — unknown · 막지 않는다
  p = plan([nv('a', 'web-01-r', { datastore: 'ds-unknown' })]);
  assert.deepEqual([p.ok, p.capacity[0].verdict, p.capacity[0].freeGB], [true, 'unknown', null]);
  // VM 용량을 못 읽으면 합이 모름 — unknown(0 으로 더하지 않는다)
  const snap2 = { ...SNAP, vms: SNAP.vms.map((v) => (v.id === 'vc-a:vm-2' ? { ...v, storageGB: null } : v)) };
  p = plan([nv('a', 'web-01-r', { datastore: 'ds-small' }), nv('b', 'app-02-r', { datastore: 'ds-small' })], snap2);
  assert.deepEqual([p.ok, p.capacity[0].verdict, p.capacity[0].needGB], [true, 'unknown', null]);
  // DS 를 고르지 않으면 원래 자리 — 판정하지 않는다
  assert.deepEqual(plan([nv('a', 'web-01-r')]).capacity, []);
});

test('③ 디스크 불일치 허용 — 덮어쓰기만 · 기본 꺼짐 · 화이트리스트', () => {
  const job = JOBS.a;
  const on = R.restorePlan({ mode: 'original', job, snapshot: SNAP, confirmName: 'web-01', allowDisksMismatch: true });
  assert.equal(on.pluginOptions, 'python3:restore_powerstate=off:restore_allow_disks_mismatch=yes');
  assert.equal(on.target.allowDisksMismatch, true);
  const off = R.restorePlan({ mode: 'original', job, snapshot: SNAP, confirmName: 'web-01' });
  assert.equal(off.pluginOptions, 'python3:restore_powerstate=off');
  const truthy = R.restorePlan({ mode: 'original', job, snapshot: SNAP, confirmName: 'web-01', allowDisksMismatch: 'yes' });
  assert.equal(truthy.pluginOptions, 'python3:restore_powerstate=off', 'true 만 켠다');
  const nvm = R.restorePlan({ mode: 'newVm', job, snapshot: SNAP, newVm: { name: 'n1' }, allowDisksMismatch: true });
  assert.doesNotMatch(nvm.pluginOptions, /disks_mismatch/, '새 VM 은 해당 없음');
});

// ── 가짜 세션(ops) ──
// 잡마다 jobid 가 다르다(실제 Director 처럼 — llist jobid= 는 이름 없이 묻는다)
const OFF = { 'pv-a': 0, 'pv-b': 1000, 'pv-c': 2000 };
const HIST = (name) => { const o = OFF[name] ?? 0; return [
  { jobid: 100 + o, name, type: 'B', level: 'F', jobstatus: 'T', starttime: '2026-10-20 02:00:00', endtime: '2026-10-20 02:40:00', jobbytes: 1000 },
  { jobid: 110 + o, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-21 02:00:00', endtime: '2026-10-21 02:05:00', jobbytes: 10 },
  { jobid: 120 + o, name, type: 'B', level: 'I', jobstatus: 'f', starttime: '2026-10-22 02:00:00', endtime: '2026-10-22 02:01:00', jobbytes: 0 },
  { jobid: 130 + o, name, type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-23 02:00:00', endtime: '2026-10-23 02:05:00', jobbytes: 12 },
]; };
const err = (code, msg = code) => Object.assign(new Error(msg), { code });
function fakeSession({ failOn = null } = {}) {
  const cmds = [];
  let next = 900;
  return {
    cmds,
    async call(cmd) {
      cmds.push(cmd);
      if (failOn) { const e = failOn(cmd, cmds); if (e) throw e; }
      const kv = Object.fromEntries([...cmd.matchAll(/(\w+)=("(?:\\.|[^"])*"|\S+)/g)].map((m) => [m[1], m[2]]));
      if (cmd.startsWith('list jobs job=')) return { jobs: HIST(kv.job) };
      if (cmd.startsWith('llist jobid=')) { for (const n of Object.keys(OFF)) { const x = HIST(n).find((r) => r.jobid === Number(kv.jobid)); if (x) return { jobs: [x] }; } return { jobs: [] }; }
      if (cmd.startsWith('restore ')) return { run: { jobid: next++ } };
      return { error: [`unknown ${cmd}`] };
    },
  };
}

test('④ ops.restorePoints — 세션 하나 · 성공 백업만 · 체인 길이 · 끊기면 남은 것 건너뜀 · 읽기 전용', async () => {
  assert.equal(MUTATING.has('restorePoints'), false);
  assert.equal(MUTATING.has('restores'), true);
  const s = fakeSession();
  const out = await OPS.restorePoints(s, { items: [{ key: 0, name: 'pv-a' }, { key: 1, name: 'bad name' }] });
  assert.equal(out[0].ok, true);
  assert.deepEqual(out[0].points.map((p) => [p.jobid, p.level, p.chain]), [[130, 'I', 3], [110, 'I', 2], [100, 'F', 1]], '실패한 120 은 지점이 아니다 · 최신 먼저');
  assert.equal(out[0].scanned, 4);
  assert.equal(out[1].ok, false);
  assert.equal(s.cmds.length, 1, '잘못된 이름은 Director 에 보내지 않는다');
  const s2 = fakeSession({ failOn: (cmd) => (cmd.includes('pv-a') ? err('closed') : null) });
  assert.ok(SESSION_DEAD.has('closed'));
  const o2 = await OPS.restorePoints(s2, { items: [{ key: 0, name: 'pv-a' }, { key: 1, name: 'pv-b' }] });
  assert.deepEqual(o2.map((x) => x.code), ['closed', 'skipped']);
  assert.equal(s2.cmds.length, 1);
});

test('④ ops.restores — 항목마다 단건과 같은 검사 · 한 건 실패는 나머지를 막지 않음 · 보낸 뒤 끊기면 결과 모름 · 끊기면 건너뜀', async () => {
  const item = (key, name, jobid = 130 + (OFF[name] ?? 0)) => ({ key, jobid, name, client: 'kr-fd', restoreJob: 'PortalVmwareRestore', pluginOptions: `python3:vmname=${name}-r:restore_powerstate=off` });
  const s = fakeSession();
  let out = await OPS.restores(s, { items: [item(0, 'pv-a'), item(1, 'pv-b', 1120), item(2, 'pv-c')] });
  assert.deepEqual(out.map((x) => [x.key, x.ok]), [[0, true], [1, false], [2, true]]);
  assert.deepEqual(out[0].chain, [100, 110, 130]);
  assert.match(out[1].message, /성공한 백업이 아닙니다/);
  assert.equal(s.cmds.filter((c) => c.startsWith('restore ')).length, 2);
  const rcmds = s.cmds.filter((c) => c.startsWith('restore '));
  assert.ok(rcmds.every((c) => !/\bselect\b/.test(c)), 'select 없음');
  assert.deepEqual(rcmds.map((c) => /jobid=([0-9,]+) /.exec(c)?.[1]), ['100,110,130', '2100,2110,2130'], '체인은 그 잡의 이력으로만');
  // 보낸 뒤 응답 중 끊김 → unknown · 남은 것은 건너뜀(보내지 않음)
  const s2 = fakeSession({ failOn: (cmd) => (cmd.startsWith('restore ') && cmd.includes('pv-a-r') ? err('timeout') : null) });
  out = await OPS.restores(s2, { items: [item(0, 'pv-a'), item(1, 'pv-b')] });
  assert.deepEqual(out.map((x) => x.code), ['unknown', 'skipped']);
  assert.match(out[0].message, /시작됐는지 알 수 없습니다/);
  // 보내기 전(이력 읽기) 끊김 → 그 코드 그대로(보내지 않았다)
  const s3 = fakeSession({ failOn: (cmd) => (cmd.startsWith('list jobs job=pv-a') ? err('closed') : null) });
  out = await OPS.restores(s3, { items: [item(0, 'pv-a'), item(1, 'pv-b')] });
  assert.deepEqual(out.map((x) => x.code), ['closed', 'skipped']);
  assert.equal(s3.cmds.filter((c) => c.startsWith('restore ')).length, 0);
});

test('⑤ 엣지 회신 정제 — 아는 칸만 · rid 없는 성공은 결과 모름 · 시한 표', () => {
  let r = sanitizeEdgeResult('restores', { ok: true, value: [{ key: 0, ok: true, rid: 901, chain: [100, '110', -1, 130], extra: 'x' }, { key: 1, ok: true }, { key: 2, ok: false, code: 'skipped', message: 'm', evil: 1 }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value[0], { key: 0, ok: true, rid: 901, chain: [100, 110, 130] });
  assert.deepEqual([r.value[1].ok, r.value[1].code], [false, 'unknown']);
  assert.deepEqual(r.value[2], { key: 2, ok: false, code: 'skipped', message: 'm' });
  r = sanitizeEdgeResult('restorePoints', { ok: true, value: [{ key: 0, ok: true, scanned: 4, points: [{ jobid: 130, level: 'I', state: 'ok', startedAt: Date.parse('2026-10-23T02:00:00'), bytes: 12, chain: 3, x: 1 }, { jobid: 5, level: 'Z', state: 'error', chain: -2 }] }] });
  assert.equal(r.value[0].points.length, 1, '성공이 아닌 지점은 버린다');
  assert.deepEqual(Object.keys(r.value[0].points[0]).sort(), ['bytes', 'chain', 'endedAt', 'jobid', 'level', 'startedAt', 'state']);
  assert.ok(RESULT_MS.restorePoints > 0 && RESULT_MS.restores >= RESULT_MS.runJobs);
});

test('⑥ finishRestores — 실패 복원 skipped · 성공 새 VM 은 bareos-nic 작업(데모 = 이 노드) · 재시작으로 잃으면 다시 · 상한 · 늦은 결과는 새 시도를 덮지 않는다', async () => {
  store.snapshot = { generatedAt: Date.now(), source: 'mock', vcenters: [{ id: 'vc-a', name: 'Seoul' }], vms: [], hosts: [], datastores: [] };
  // 원장에 대상을 직접 둔다(등록 라우트를 거치지 않는 단위 시험)
  const file = path.join(tmp, registry.FILE_NAME);
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: [
    { id: 'j1', vcenterId: 'vc-a', vmId: 'vc-a:vm-1', vmName: 'web-01', bareosJob: 'pv-a', restores: [
      { jobid: 901, status: 'T', state: 'ok', nic: 'disconnect', target: { name: 'web-01-r' }, at: now },
      { jobid: 902, status: 'f', state: 'error', nic: 'disconnect', target: { name: 'web-01-r2' }, at: now },
      { jobid: 903, status: 'T', state: 'ok', nic: 'keep', target: { name: 'web-01-r3' }, at: now },
      { jobid: 904, status: 'R', state: 'running', nic: 'disconnect', target: { name: 'web-01-r4' }, at: now },
    ] },
  ], retired: [] }));
  registry._resetForTest();
  const list = registry.restoresToFinish();
  assert.deepEqual(list.map((x) => x.rid).sort(), [901, 902], 'keep · 끝나지 않은 복원은 대상이 아니다');
  const sent = finishRestores(now);
  assert.equal(sent, 1);
  const rs = () => Object.fromEntries(registry.getJob('j1').restores.map((x) => [x.jobid, x.finish]));
  assert.equal(rs()[902].nic, 'skipped');
  assert.equal(rs()[901].nic, 'pending');
  assert.equal(rs()[901].tries, 1);
  const opId = rs()[901].opId;
  assert.ok(['running', 'pending', 'done'].includes(dispatch.opStateOf(opId)));
  // 데모 경로는 약 0.6초 — 결과가 원장에 남는다
  for (let i = 0; i < 40 && rs()[901].nic === 'pending'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(rs()[901].nic, 'ok', JSON.stringify(rs()[901]));
  assert.match(rs()[901].detail, /연결을 끊었습니다/);
  assert.equal(finishRestores(now), 0, '끝난 마무리는 다시 보내지 않는다');
  // 재시작으로 작업을 잃었다(원장엔 pending · 메모리엔 없음) → 다시 보낸다 · 상한이면 failed
  registry.patchRestoreFinish('j1', 901, { nic: 'pending', opId: 'vco-lost', tries: 1, at: now });
  assert.equal(finishRestores(now), 1);
  assert.equal(rs()[901].tries, 2);
  const newer = rs()[901].opId;
  // 옛 작업(vco-lost)의 늦은 결과는 새 시도를 덮지 않는다(훅 guard)
  const stale = { id: 'vco-lost', kind: 'bareos-nic', spec: { bareosJobId: 'j1', rid: 901 }, result: { ok: false, detail: 'old' }, doneAt: now };
  dispatch.finishOp(stale, { ok: false, detail: 'old' }, now);
  assert.equal(rs()[901].opId, newer);
  for (let i = 0; i < 40 && rs()[901].nic === 'pending'; i++) await new Promise((r) => setTimeout(r, 100));
  registry.patchRestoreFinish('j1', 901, { nic: 'pending', opId: 'vco-lost2', tries: MAX_TRIES, at: now });
  assert.equal(finishRestores(now), 0);
  assert.equal(rs()[901].nic, 'failed');
  assert.match(rs()[901].detail, /직접 확인/);
});
