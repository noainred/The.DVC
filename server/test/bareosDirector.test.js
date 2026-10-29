/**
 * test/bareosDirector.test.js — src/bareos/director.js 가 Director 에 **보내는 명령 문자열**과 응답 해석을 가짜 Director 로 고정한다.
 *  - configure add job: FdPluginOptions 는 값에 따옴표를 남긴다(ALIST_STR) · 자격증명 없음 · 이미 있으면 exists
 *  - run → jobid · llist → 정규화(못 읽은 수치는 null) · joblog 상한(뒤쪽 보존) · .bvfs_get_jobids 여러 모양
 *  - restore 는 jobid 목록 + select all done yes(‘select current’ 없음 — 범용 FileSet 공유)
 *  - catalogLists: 하나가 실패해도 나머지 · 실패한 것은 null + errors(빈 목록으로 꾸미지 않는다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { withConsole } from '../src/bareos/console.js';
import {
  addJob, runJob, jobStatus, jobLog, restoreChain, runRestore, catalogLists, jobHistory, setJobEnabled, cancelJob, parseBanner, namesOf, normalizeJobRow,
} from '../src/bareos/director.js';
import { startFakeDirector, LOOPBACK_DEPS } from './_fakeBareosDirector.js';

const servers = [];
after(async () => { for (const s of servers) await s.close(); });

async function withFake(handle, fn) {
  const fd = await startFakeDirector({ name: 'portal', password: 'pw', tls: false, handle });
  servers.push(fd);
  const r = await withConsole({ host: '127.0.0.1', port: fd.port, name: 'portal', password: 'pw', tls: 'none', timeoutMs: 5000 }, fn, LOOPBACK_DEPS);
  return { r, log: fd.log.filter((c) => !c.startsWith('.api')) };
}

test('configure add job: 명령 문자열 · FdPluginOptions 에 따옴표가 남는다 · 이미 있으면 exists', async () => {
  const def = {
    name: 'pv-3fa1c2d9-vm-123', jobDefs: 'PortalVmwareDefaults', client: 'kr-fd', storage: 'kr-sd', pool: 'VMwareKR', schedule: 'VMwareNightly',
    level: 'Incremental', description: 'VMware Portal websrv 01',
    pluginOptions: 'python3:vcserver=vc.kr:dc=DC-Seoul:folder=/web:vmname=websrv 01:config_file=/etc/bareos/vmware/vc-kr-1.ini',
  };
  const { r, log } = await withFake((cmd) => (cmd.startsWith('configure add') ? { add: { resource: 'Job', name: def.name, filename: '/etc/bareos/bareos-dir.d/job/pv.conf' } } : null),
    (s) => addJob(s, def));
  assert.deepEqual(r, { exists: false, name: def.name, filename: '/etc/bareos/bareos-dir.d/job/pv.conf' });
  assert.equal(log[0], 'configure add job name=pv-3fa1c2d9-vm-123 jobdefs=PortalVmwareDefaults client=kr-fd storage=kr-sd pool=VMwareKR schedule=VMwareNightly level=Incremental '
    + 'fdpluginoptions="\\"python3:vcserver=vc.kr:dc=DC-Seoul:folder=/web:vmname=websrv 01:config_file=/etc/bareos/vmware/vc-kr-1.ini\\"" description="VMware Portal websrv 01"');
  assert.doesNotMatch(log[0], /vcpass|vcuser/);
  const dup = await withFake(() => ({ error: ['Resource "Job" with name "pv-x" already exists.'] }), (s) => addJob(s, { ...def, name: 'pv-x' }));
  assert.deepEqual(dup.r, { exists: true, name: 'pv-x' });
  await assert.rejects(withFake(() => null, (s) => addJob(s, { ...def, client: 'kr fd' })), (e) => e.code === 'invalid');
  await assert.rejects(withFake(() => null, (s) => addJob(s, { ...def, pluginOptions: 'python3:vmname=a;b' })), (e) => e.code === 'invalid');
});

test('run → jobid · jobid 없으면 protocol 오류(지어내지 않는다)', async () => {
  const { r, log } = await withFake(() => ({ run: { jobid: '1234' } }), (s) => runJob(s, { job: 'pv-1-vm-1', level: 'Full' }));
  assert.equal(r, 1234);
  assert.equal(log[0], 'run job=pv-1-vm-1 level=Full yes');
  await assert.rejects(withFake(() => ({ run: {} }), (s) => runJob(s, { job: 'pv-1-vm-1' })), (e) => e.code === 'protocol');
});

test('llist jobid → 정규화 · 못 읽은 수치는 null', async () => {
  const row = { jobid: '1234', job: 'pv-1.2026-10-29_02.10.01_05', name: 'pv-1', type: 'B', level: 'I', jobstatus: 'T', starttime: '2026-10-29 02:10:03', endtime: '2026-10-29 02:24:10', jobbytes: '3221225472', jobfiles: '3', joberrors: '0', client: 'kr-fd' };
  const { r, log } = await withFake(() => ({ jobs: [row] }), (s) => jobStatus(s, 1234));
  assert.equal(log[0], 'llist jobid=1234');
  assert.equal(r.state, 'ok');
  assert.equal(r.bytes, 3221225472);
  assert.equal(r.errors, 0);
  assert.ok(Number.isFinite(r.startedAt) && r.endedAt > r.startedAt);
  const empty = normalizeJobRow({ jobid: 5, jobstatus: 'R', jobbytes: '', jobfiles: null });
  assert.equal(empty.bytes, null);
  assert.equal(empty.files, null);
  assert.equal(empty.endedAt, null);
  const neg = normalizeJobRow({ jobid: 6, jobstatus: 'T', jobbytes: -730144440, jobfiles: '-1', joberrors: 0 });
  assert.equal(neg.bytes, null, '음수 바이트는 읽을 수 없는 값');
  assert.equal(neg.files, null);
  assert.equal(neg.errors, 0);
  assert.equal((await withFake(() => ({ jobs: [] }), (s) => jobStatus(s, 9))).r, null);
  await assert.rejects(withFake(() => null, (s) => jobStatus(s, 'x;y')), (e) => e.code === 'invalid');
});

test('joblog: 상한을 넘으면 뒤쪽(요약·오류)을 남기고 truncated', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ time: '2026-10-29 02:10:00', logtext: `line ${i}\n` }));
  const { r } = await withFake(() => ({ joblog: rows }), (s) => jobLog(s, 7, { maxLines: 10 }));
  assert.equal(r.total, 50);
  assert.equal(r.lines.length, 10);
  assert.ok(r.truncated);
  assert.match(r.lines.at(-1), /line 49$/);
});

test('.bvfs_get_jobids: 배열·{jobids:[…]}·쉼표 문자열 모양 모두 · 못 읽으면 null', async () => {
  assert.deepEqual((await withFake(() => ({ jobids: [{ id: 1234 }, { id: 1198 }] }), (s) => restoreChain(s, 1234))).r, [1198, 1234]);
  assert.deepEqual((await withFake(() => ({ jobids: '1198,1210,1234' }), (s) => restoreChain(s, 1234))).r, [1198, 1210, 1234]);
  assert.equal((await withFake(() => ({ nothing: true }), (s) => restoreChain(s, 1234))).r, null);
});

test('restore: jobid 목록 + restorejob + pluginoptions + select all done yes', async () => {
  const { r, log } = await withFake(() => ({ run: { jobid: 1300 } }),
    (s) => runRestore(s, { client: 'kr-fd', jobids: [1198, 1234], restoreJob: 'PortalVmwareRestore', pluginOptions: 'python3:restore_powerstate=off:vmname=web r' }));
  assert.equal(r, 1300);
  assert.equal(log[0], 'restore client=kr-fd restoreclient=kr-fd jobid=1198,1234 restorejob=PortalVmwareRestore pluginoptions="python3:restore_powerstate=off:vmname=web r" select all done yes');
  assert.doesNotMatch(log[0], /current/);
  await assert.rejects(withFake(() => null, (s) => runRestore(s, { client: 'kr-fd', jobids: [], restoreJob: 'R', pluginOptions: 'python3:x=1' })), (e) => e.code === 'invalid');
});

test('catalogLists: 하나가 실패해도 나머지 · 실패는 null + errors', async () => {
  const { r } = await withFake((cmd) => (cmd === '.pools' ? { error: ['Access denied'] } : cmd === '.clients' ? { clients: [{ name: 'pl-fd' }, { name: 'kr-fd' }, { name: 'bad name' }] } : { x: [] }),
    (s) => catalogLists(s));
  assert.deepEqual(r.clients, ['kr-fd', 'pl-fd']);
  assert.equal(r.pools, null);
  assert.match(r.errors.pools, /Access denied/);
  assert.deepEqual(r.storages, []);
});

test('jobHistory · enable/disable · cancel 명령 문자열', async () => {
  const { log } = await withFake(() => ({ jobs: [{ jobid: 1, jobstatus: 'T' }] }), async (s) => {
    await jobHistory(s, 'pv-1-vm-1', 500); await setJobEnabled(s, 'pv-1-vm-1', false); await setJobEnabled(s, 'pv-1-vm-1', true); await cancelJob(s, 42);
  });
  assert.deepEqual(log, ['list jobs job=pv-1-vm-1 limit=200', 'disable job=pv-1-vm-1', 'enable job=pv-1-vm-1', 'cancel jobid=42']);
});

test('배너 해석 · 이름 목록 필터', () => {
  assert.deepEqual(parseBanner('OK: bareos-dir Version: 25.0.4 (01 July 2026)\n'), { director: 'bareos-dir', version: '25.0.4' });
  assert.deepEqual(parseBanner(''), { director: '', version: '' });
  assert.deepEqual(namesOf({ storages: ['b', 'a', 'a', 'x;y'] }), ['a', 'b']);
});

test('데모 Director 이력 — 바이트·시각이 음수가 되지 않는다(이름 해시가 2^31 이상이어도)', async () => {
  const { demoCall } = await import('../src/mock/demo/bareos.js');
  const { demoHash } = await import('../src/mock/demo/flags.js');
  const names = ['pv-0a1b2c3d-vm-1', 'pv-ffffffff-vm-77', 'a', 'pv-12345678-vm-9001'];
  assert.ok(names.some((n) => demoHash(n) >= 2 ** 31), '해시가 2^31 이상인 이름이 하나는 있어야 이 시험이 의미가 있다');
  for (const n of names) {
    demoCall(`configure add job name=${n} client=c storage=s pool=p`, {});
    const r = demoCall(`list jobs job=${n} limit=50`, {});
    assert.ok(r.jobs.length > 0, n);
    for (const row of r.jobs) {
      assert.ok(row.jobbytes >= 0, `${n} ${row.jobid} jobbytes=${row.jobbytes}`);
      assert.ok(Date.parse(`${row.starttime.replace(' ', 'T')}Z`) > 0);
    }
  }
});

test('데모 Director 시각 — 카탈로그 문자열은 현지 시각(시간대 없음)이라 한국 시각 서버에서도 실행 시각이 지금과 같다', async () => {
  const prev = process.env.TZ;
  process.env.TZ = 'Asia/Seoul'; // UTC 컨테이너에서는 UTC 문자열 결함이 드러나지 않는다
  try {
    const { demoCall } = await import('../src/mock/demo/bareos.js');
    demoCall('configure add job name=pv-tz-vm-1 client=c storage=s pool=p', {});
    const { run } = demoCall('run job=pv-tz-vm-1 level=Full yes', {});
    const row = normalizeJobRow(demoCall(`llist jobid=${run.jobid}`, {}).jobs[0]);
    assert.ok(Math.abs(row.startedAt - Date.now()) < 60_000, `startedAt 이 ${Math.round((row.startedAt - Date.now()) / 3_600_000)}시간 어긋났다`);
    assert.ok(demoCall('list jobs days=1', {}).jobs.some((r) => r.jobid === run.jobid), 'days 거르기가 방금 실행을 빠뜨렸다');
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});
