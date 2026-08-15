import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// VM 복제(백업식, v2.299) 회귀 방지 — 잡 저장소 CRUD·스케줄 due 판정·보존정책·NFS 마운트
// 스펙 검증·백업 파일 필터. 저장소 오염 방지: import 전에 CONFIG_DIR 격리(다른 테스트와 동일 규약).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vmclone-test-'));
process.env.CONFIG_DIR = TMP;

const store = await import('../src/vmclone/store.js');
const { validateMountSpec, mountPointOf } = await import('../src/system/nfsMounts.js');
const { backupFileFilter, parseDsPath } = await import('../src/vmclone/vsphere.js');

test('잡 저장: 필수값 검증·같은 VM 중복 금지·keep/스케줄 정규화', () => {
  assert.throws(() => store.saveJob({}), /vCenter·VM 지정/);
  const j = store.saveJob({
    vcenterId: 'OC2', vmId: 'OC2:vm-101', vmName: 'LESDAHMPS01',
    dest: { type: 'datastore', datastoreName: 'DS-BAK' },
    schedule: { mode: 'daily', time: '2:05' }, // 시(hour)만 한 자리 허용 → 02:05 정규화(분은 2자리 필수 — UI time 입력이 보장)
    keep: 99,                                   // 상한 30 클램프
  });
  assert.equal(j.schedule.time, '02:05');
  // 분 한 자리('2:5') 같은 무효 시각은 manual 로 폴백(무효 스케줄로 자동 실행되는 사고 방지)
  const jBad = store.saveJob({ vcenterId: 'OC2', vmId: 'OC2:vm-901', vmName: 'BADTIME', dest: { type: 'datastore', datastoreName: 'D' }, schedule: { mode: 'daily', time: '2:5' } });
  assert.equal(jBad.schedule.mode, 'manual');
  assert.equal(j.keep, 30);
  assert.equal(j.enabled, true);
  // 같은 VM 재등록 거부(잡 간 스냅샷/클론 간섭 방지)
  assert.throws(() => store.saveJob({ vcenterId: 'OC2', vmId: 'OC2:vm-101', vmName: 'X', dest: { type: 'datastore', datastoreName: 'D' } }), /이미 복제 잡/);
  // NFS 대상: mountId 필수 + subdir 슬러그화(경로 탈출 문자는 제거)
  assert.throws(() => store.saveJob({ vcenterId: 'OC2', vmId: 'OC2:vm-102', vmName: 'Y', dest: { type: 'nfs' } }), /마운트 항목/);
  const j2 = store.saveJob({ vcenterId: 'OC2', vmId: 'OC2:vm-102', vmName: 'Y', dest: { type: 'nfs', mountId: 'nfs-a', subdir: '../..//evil dir' } });
  assert.equal(j2.dest.subdir, '....evildir'); // 슬러그 결과에 경로 구분자·공백 없음(탈출 불가)
  assert.ok(!j2.dest.subdir.includes('/') && !j2.dest.subdir.includes('\\'));
});

test('isDue — daily(오늘 시각 경과 + 오늘 미실행)·interval(N시간 경과)·manual/비활성 false', () => {
  const base = new Date('2026-08-15T10:00:00'); // 로컬 10:00
  const at = (h, m) => new Date(`2026-08-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`).getTime();
  const daily = { enabled: true, schedule: { mode: 'daily', time: '02:00' }, lastRun: null };
  assert.equal(store.isDue(daily, base.getTime()), true, '오늘 02:00 이 지났고 미실행 → due');
  assert.equal(store.isDue({ ...daily, lastRun: { at: at(2, 30) } }, base.getTime()), false, '오늘 이미 실행 → 미도래');
  assert.equal(store.isDue({ ...daily, lastRun: { at: at(1, 0) - 86400e3 } }, at(1, 30)), false, '오늘 02:00 이전 시각 → 미도래');
  const iv = { enabled: true, schedule: { mode: 'interval', hours: 6 }, lastRun: { at: base.getTime() - 5 * 3600e3 } };
  assert.equal(store.isDue(iv, base.getTime()), false, '5시간 경과(6시간 간격) → 미도래');
  assert.equal(store.isDue({ ...iv, lastRun: { at: base.getTime() - 7 * 3600e3 } }, base.getTime()), true);
  assert.equal(store.isDue({ enabled: false, schedule: { mode: 'interval', hours: 1 }, lastRun: null }, base.getTime()), false, '비활성 → 항상 false');
  assert.equal(store.isDue({ enabled: true, schedule: { mode: 'manual' } }, base.getTime()), false);
});

test('pruneList — keep 초과분을 오래된 순으로만 반환(원장 기준 보존정책)', () => {
  const clones = [
    { name: 'c', ref: 'r3', at: 300 }, { name: 'a', ref: 'r1', at: 100 }, { name: 'b', ref: 'r2', at: 200 },
  ];
  assert.deepEqual(store.pruneList(clones, 2).map((c) => c.ref), ['r1'], '가장 오래된 1개만');
  assert.deepEqual(store.pruneList(clones, 3), [], 'keep 이내면 삭제 없음');
  assert.deepEqual(store.pruneList([], 1), []);
});

test('validateMountSpec — 화이트리스트(인젝션·경로 탈출·선행 - 차단)', () => {
  const ok = validateMountSpec({ server: 'nas-01.corp', exportPath: '/volume1/vm-backup', options: 'vers=3,nolock' });
  assert.equal(ok.server, 'nas-01.corp');
  assert.throws(() => validateMountSpec({ server: 'nas; rm -rf /', exportPath: '/v' }), /서버 형식/);
  assert.throws(() => validateMountSpec({ server: '-o', exportPath: '/v' }), /서버 형식/, "선행 '-' 차단");
  assert.throws(() => validateMountSpec({ server: 'nas', exportPath: '/v/../etc' }), /경로 형식/);
  assert.throws(() => validateMountSpec({ server: 'nas', exportPath: 'relative' }), /경로 형식/);
  assert.throws(() => validateMountSpec({ server: 'nas', exportPath: '/v', options: 'vers=3,-osudo' }), /'-' 로 시작/);
  assert.throws(() => validateMountSpec({ server: 'nas', exportPath: '/v', options: 'a;b' }), /옵션 형식/);
  // 마운트 지점은 BASE 아래 id 로 고정(임의 경로 마운트 구조적 차단)
  assert.ok(mountPointOf('abc/../../etc').indexOf('..') === -1);
});

test('backupFileFilter — 베이스 파일만(델타·스왑·스냅샷 메타·로그 제외)', () => {
  assert.equal(backupFileFilter('[DS] vm/vm.vmx'), true);
  assert.equal(backupFileFilter('[DS] vm/vm.nvram'), true);
  assert.equal(backupFileFilter('[DS] vm/disk.vmdk'), true, '베이스 디스크립터');
  assert.equal(backupFileFilter('[DS] vm/disk-flat.vmdk'), true, '베이스 flat');
  assert.equal(backupFileFilter('[DS] vm/disk-000001.vmdk'), false, '스냅샷 델타 디스크립터 제외');
  assert.equal(backupFileFilter('[DS] vm/disk-000001-delta.vmdk'), false);
  assert.equal(backupFileFilter('[DS] vm/disk-000002-sesparse.vmdk'), false);
  assert.equal(backupFileFilter('[DS] vm/vm.vswp'), false, '스왑 제외');
  assert.equal(backupFileFilter('[DS] vm/vm-Snapshot1.vmsn'), false);
  assert.equal(backupFileFilter('[DS] vm/vmware.log'), false);
});

test('parseDsPath — "[DS] 경로" 표기 파서', () => {
  assert.deepEqual(parseDsPath('[DS-01] folder/vm.vmx'), { ds: 'DS-01', rel: 'folder/vm.vmx' });
  assert.equal(parseDsPath('no-bracket'), null);
});

test('recordRun — 원장 갱신(추가/제거) + lastRun 기록', () => {
  const j = store.saveJob({ vcenterId: 'WA', vmId: 'WA:vm-7', vmName: 'ntp01', dest: { type: 'datastore', datastoreName: 'D1' } });
  store.recordRun(j.id, { ok: true, detail: '클론 완료', ms: 1234, addClone: { name: 'ntp01-bak-1', ref: 'vm-90', at: 1 } });
  store.recordRun(j.id, { ok: true, detail: '2차', ms: 1, addClone: { name: 'ntp01-bak-2', ref: 'vm-91', at: 2 }, removeCloneRefs: ['vm-90'] });
  const cur = store.getJob(j.id);
  assert.deepEqual(cur.clones.map((c) => c.ref), ['vm-91'], '보존정책 제거 반영');
  assert.equal(cur.lastRun.ok, true);
  assert.equal(cur.lastRun.detail, '2차');
});
