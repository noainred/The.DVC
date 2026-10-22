/**
 * v2.755 — 실서버 화면(vSphere 작업 목록: Veeam 이 administrator@vsphere.local 로 '가상 시스템 스냅샷 생성' → '스냅샷 제거' 를 VM 마다 짝으로 남김).
 *  ① 계정 표기: 'VSPHERE.LOCAL\Administrator' ↔ 'administrator@vsphere.local' 은 같은 계정(같은 도메인일 때만).
 *  ② 문구: 영어·한국어 작업 문구 모두(로그인에 언어를 지정하지 않아 vCenter 기본 언어를 따른다).
 *  ③ 공용 계정(사람도 쓴다)은 '만들고 12시간 안에 같은 계정이 같은 VM 의 스냅샷을 지운' 짝만 백업 시도로 센다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'veeam2755-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const S = await import('../src/veeam/snapEvents.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;
const VC = 'kr:vc01';
const t = (o) => ({ type: 'TaskEvent', severity: 'info', ...o });

test('① 같은 도메인의 두 표기는 같은 계정 · 다른 도메인은 아니다', () => {
  const is = S.makeVeeamAccountMatcher(['administrator@vsphere.local']);
  assert.equal(is('VSPHERE.LOCAL\\Administrator'), 'account');
  assert.equal(is('Administrator@VSPHERE.LOCAL'), 'account');
  assert.equal(is('CORP\\Administrator'), null);
  assert.equal(is('administrator@corp.local'), null);
  const is2 = S.makeVeeamAccountMatcher(['VSPHERE.LOCAL\\Administrator']);
  assert.equal(is2('administrator@vsphere.local'), 'account', '반대 방향도');
  assert.equal(S.isSharedAccount('VSPHERE.LOCAL\\Administrator'), true);
  assert.equal(S.isSharedAccount('CORP\\svc-backup'), false);
});

test('② 영어·한국어 작업 문구 — 생성·제거 · 실패·되돌리기는 생성이 아니다', () => {
  for (const m of ['Task: Create virtual machine snapshot', '작업: 가상 시스템 스냅샷 생성', '가상 머신 스냅샷 생성', '스냅샷 생성']) assert.equal(S.isSnapshotCreateEvent(t({ message: m })), true, m);
  for (const m of ['작업: 스냅샷 제거', '스냅샷 생성 실패', '스냅샷으로 되돌리기', '가상 시스템 디스크 통합', '모든 스냅샷 제거']) assert.equal(S.isSnapshotCreateEvent(t({ message: m })), false, m);
  for (const m of ['Task: Remove snapshot', 'Task: Remove all snapshots', '작업: 스냅샷 제거', '모든 스냅샷 삭제']) assert.equal(S.isSnapshotRemoveEvent(t({ message: m })), true, m);
  for (const m of ['작업: 가상 시스템 스냅샷 생성', '스냅샷 제거 실패']) assert.equal(S.isSnapshotRemoveEvent(t({ message: m })), false, m);
});

test('③ 공용 계정은 생성→12시간 안 제거 짝만 · 전용 계정은 생성만으로 · 사람이 만들어 둔 스냅샷은 빠지고 센다', () => {
  const A = 'VSPHERE.LOCAL\\Administrator';
  const vms = ['LESAELKSRCP1', 'LESAELKSRCP2', 'LESAPTLODBP1', 'LESDOPODBP1', 'APP01'].map((n, i) => ({ id: `${VC}:vm-${i + 1}`, name: n }));
  const rows = [
    t({ ts: NOW - 5 * HOUR, user: A, entity: 'LESAELKSRCP1', message: '작업: 가상 시스템 스냅샷 생성' }),
    t({ ts: NOW - 5 * HOUR + 7 * 60_000, user: A, entity: 'LESAELKSRCP1', message: '작업: 스냅샷 제거' }),             // 짝 — 백업 시도
    t({ ts: NOW - 6 * HOUR, user: 'administrator@vsphere.local', entity: 'LESAELKSRCP2', message: 'Task: Create virtual machine snapshot' }),
    t({ ts: NOW - 6 * HOUR + 3 * 60_000, user: A, entity: 'LESAELKSRCP2', message: 'Task: Remove snapshot' }),       // 표기가 달라도 같은 계정의 짝
    t({ ts: NOW - 30 * HOUR, user: A, entity: 'LESAPTLODBP1', message: '작업: 가상 시스템 스냅샷 생성' }),               // 지우지 않음(사람이 만든 것) — 뺀다
    t({ ts: NOW - 40 * HOUR, user: A, entity: 'LESDOPODBP1', message: '작업: 가상 시스템 스냅샷 생성' }),
    t({ ts: NOW - 20 * HOUR, user: A, entity: 'LESDOPODBP1', message: '작업: 스냅샷 제거' }),                       // 20시간 뒤 제거 — 12시간 밖이라 짝 아님
    t({ ts: NOW - 2 * HOUR, user: 'CORP\\kim', entity: 'APP01', message: '작업: 가상 시스템 스냅샷 생성' }),            // 다른 계정
    t({ ts: NOW - 2 * HOUR + 60_000, user: 'CORP\\kim', entity: 'APP01', message: '작업: 스냅샷 제거' }),
  ];
  const r = S.summarizeVeeamSnapEvents(vms, rows, { accounts: ['administrator@vsphere.local'], since: NOW - 7 * 24 * HOUR });
  assert.deepEqual(r.byVm, { [`${VC}:vm-1`]: [NOW - 5 * HOUR, 1], [`${VC}:vm-2`]: [NOW - 6 * HOUR, 1] });
  assert.equal(r.unpaired, 2, '사람이 만들어 둔 스냅샷·12시간 넘게 남은 스냅샷');
  // 전용 계정(공용이 아님)은 짝 없이도 센다(지금처럼)
  const r2 = S.summarizeVeeamSnapEvents(vms, [t({ ts: NOW - HOUR, user: 'CORP\\svc-backup', entity: 'APP01', message: '작업: 가상 시스템 스냅샷 생성' })], { accounts: ['CORP\\svc-backup'] });
  assert.deepEqual(r2.byVm, { [`${VC}:vm-5`]: [NOW - HOUR, 1] }); assert.equal(r2.unpaired, 0);
});

test('로컬 계산 — 실제 로그 DB 에서 한국어 문구도 읽는다(\'snapshot\'·\'스냅샷\' 두 번 읽고 겹친 행은 한 번)', async () => {
  S._resetForTest();
  S.saveManualAccounts(['administrator@vsphere.local']);
  const { getLogsDb } = await import('../src/logs/db.js');
  const db = await getLogsDb();
  await db.insertManyAsync([
    { vcenterId: VC, key: 'k1', ts: NOW - 3 * HOUR, severity: 'info', type: 'TaskEvent', user: 'VSPHERE.LOCAL\\Administrator', entity: 'web01', message: '작업: 가상 시스템 스냅샷 생성' },
    { vcenterId: VC, key: 'k2', ts: NOW - 3 * HOUR + 5 * 60_000, severity: 'info', type: 'TaskEvent', user: 'VSPHERE.LOCAL\\Administrator', entity: 'web01', message: '작업: 스냅샷 제거' },
    { vcenterId: VC, key: 'k3', ts: NOW - 4 * HOUR, severity: 'info', type: 'TaskEvent', user: 'VSPHERE.LOCAL\\Administrator', entity: 'db01', message: 'Task: Create virtual machine snapshot (스냅샷)' },
    { vcenterId: VC, key: 'k4', ts: NOW - 4 * HOUR + 60_000, severity: 'info', type: 'TaskEvent', user: 'VSPHERE.LOCAL\\Administrator', entity: 'db01', message: 'Task: Remove snapshot' },
  ]);
  const vms = [{ id: `${VC}:vm-1`, name: 'web01' }, { id: `${VC}:vm-2`, name: 'db01' }];
  const r = await S.localSnapSummary(db, VC, vms, { now: NOW });
  assert.deepEqual(r.byVm, { [`${VC}:vm-1`]: [NOW - 3 * HOUR, 1], [`${VC}:vm-2`]: [NOW - 4 * HOUR, 1] }, 'k3 는 두 검색에 다 걸리지만 한 번만 센다');
  S._resetForTest();
});
