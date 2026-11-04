/**
 * test/bareosRestoreBugs2873.test.js — Bareos 복원 · 검증 버그 점검(5축 + 반증 1인 · 2026-11-04) 확정분 회귀.
 *  ① B1-01 복원 pluginoptions 의 공백: Bareos restore 는 받은 pluginoptions 를 run 으로 **따옴표 없이** 다시 조립해 한 번 더 쪼갠다
 *     (ua_restore.cc 22~master `" pluginoptions=%s"` → ParseUaArgs → ua_run.cc 'Invalid keyword'). 그 두 번 파싱을 lib/scan.cc next_arg 이식으로 재현한다.
 *  ② B1-02 로컬 VMDK 는 where 를 준다(복원 잡 Where = / → FD 가 '' 로 바꿔 FD 루트에 풀렸다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { restoreCommand, LOCAL_VMDK_WHERE } = await import('../src/bareos/director.js');
const { restorePlan } = await import('../src/bareos/restore.js');

// Bareos lib/scan.cc next_arg · ParseArgs 이식(공백 = 필드 끝 · " 토글 · \ 다음 글자 그대로) — 반증 담당이 원문과 바이트 대조
const isSp = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
function nextArg(st) {
  let p = st.i; const s = st.s;
  while (p < s.length && isSp(s[p])) p++;
  let out = ''; let inq = false;
  while (p < s.length) {
    const c = s[p];
    if (c === '\\') { p++; if (p < s.length) out += s[p++]; continue; }
    if (c === '"') { p++; inq = !inq; continue; }
    if (!inq && isSp(c)) { p++; break; }
    out += c; p++;
  }
  st.i = p; return out;
}
function parseArgs(cmd) {
  const st = { s: cmd.trimEnd(), i: 0 }; const kv = [];
  for (;;) { const n = nextArg(st); if (!n) break; const e = n.indexOf('='); kv.push(e >= 0 ? [n.slice(0, e), n.slice(e + 1)] : [n, null]); }
  return kv;
}
const RUN_KW = new Set(['job', 'jobid', 'client', 'fd', 'fileset', 'level', 'storage', 'sd', 'regexwhere', 'where', 'bootstrap', 'replace', 'when', 'priority', 'yes', 'verifyjob', 'files', 'catalog', 'since', 'cloned', 'verifylist', 'migrationjob', 'pool', 'backupclient', 'restoreclient', 'pluginoptions', 'spooldata', 'comment', 'ignoreduplicatecheck', 'accurate', 'backupformat', 'consolidatejob', 'nextpool', 'restorejob']);
/** restore 명령 → (1차 파싱) → ua_restore 가 run 으로 다시 조립(따옴표 없이) → (2차 파싱) 의 pluginoptions 와 모르는 키워드. */
function bareosTwoPass(cmd) {
  const first = parseArgs(cmd);
  const po = first.find(([k]) => k.toLowerCase() === 'pluginoptions')?.[1];
  const where = first.find(([k]) => k.toLowerCase() === 'where')?.[1];
  const run = `run job="RestoreJob" client="c" restoreclient="c" storage="s" bootstrap="/b" files=1 catalog="MyCatalog"${where != null ? ` where="${where}"` : ''} pluginoptions=${po} yes`;
  const second = parseArgs(run);
  return { pluginoptions: second.find(([k]) => k === 'pluginoptions')?.[1], where: second.find(([k]) => k === 'where')?.[1] ?? null, invalid: second.slice(1).map(([k]) => k).filter((k) => !RUN_KW.has(k.toLowerCase())) };
}

const base = { vcserver: 'vc.example.com', configFile: '/etc/bareos/vmware/vc.ini' };
const snap = { vms: [], datastores: [{ vcenterId: 'vc1', name: 'datastore1 (1)' }], hosts: [] };

test('① B1-01 공백이 든 VM · 데이터센터 · 폴더 · 데이터스토어 이름도 run 까지 그대로 간다(Bareos 두 번 파싱)', () => {
  for (const job of [
    { vcenterId: 'vc1', vmId: 'vm-1', vmName: 'web 01', dc: 'Seoul DC', folder: '/Prod Servers' },
    { vcenterId: 'vc1', vmId: 'vm-1', vmName: 'web01', dc: 'SeoulDC', folder: '/Prod' },
  ]) {
    const p = restorePlan({ mode: 'newVm', job, snapshot: snap, newVm: { name: `${job.vmName}-r`, datastore: 'datastore1 (1)' }, base });
    assert.equal(p.ok, true, p.issue);
    const r = bareosTwoPass(restoreCommand({ client: 'fd1', jobids: [10, 11], restoreJob: 'RestoreFiles', pluginOptions: p.pluginOptions }));
    assert.deepEqual(r.invalid, [], `run 이 거부할 키워드가 없어야: ${r.invalid}`);
    assert.equal(r.pluginoptions, p.pluginOptions, '두 번 파싱 뒤에도 원래 옵션 그대로');
  }
  // 덮어쓰기도 같은 함수
  const ov = { vcenterId: 'vc1', vmId: 'vm-1', vmName: 'db 01', dc: 'Seoul DC', folder: '/DB Servers' };
  const os = { vms: [{ id: 'vm-1', vcenterId: 'vc1', name: 'db 01', powerState: 'POWERED_OFF', snapshotCount: 0, vcDcPath: 'Seoul DC', folderPath: '/DB Servers' }], datastores: [], hosts: [] };
  const po = restorePlan({ mode: 'original', job: ov, snapshot: os, confirmName: 'db 01', base });
  assert.equal(po.ok, true, po.issue);
  const r = bareosTwoPass(restoreCommand({ client: 'fd1', jobids: [10], restoreJob: 'RestoreFiles', pluginOptions: po.pluginOptions }));
  assert.deepEqual([r.invalid, r.pluginoptions], [[], po.pluginOptions]);
});

test('② B1-02 로컬 VMDK 는 where 를 화면이 말하는 경로로 준다 · 다른 방식에는 where 가 없다', () => {
  const job = { vcenterId: 'vc1', vmId: 'vm-1', vmName: 'web01', dc: 'DC', folder: '/Prod' };
  const lv = restorePlan({ mode: 'localVmdk', job, snapshot: snap, base });
  const cmd = restoreCommand({ client: 'fd1', jobids: [10], restoreJob: 'RestoreFiles', pluginOptions: lv.pluginOptions });
  const r = bareosTwoPass(cmd);
  assert.equal(LOCAL_VMDK_WHERE, '/tmp/bareos-restores');
  assert.deepEqual([r.where, r.invalid], [LOCAL_VMDK_WHERE, []]);
  const nv = restorePlan({ mode: 'newVm', job, snapshot: snap, newVm: { name: 'web01-r' }, base });
  assert.doesNotMatch(restoreCommand({ client: 'fd1', jobids: [10], restoreJob: 'RestoreFiles', pluginOptions: nv.pluginOptions }), /\bwhere=/);
});
