// VM 수량 추이(v2.345) 단위테스트 — 슬롯 키/시각 계산 + 스냅샷 diff(순수 로직).
// 사용자 요구를 고정한다: 매일 00·12시 슬롯, vCenter별 증감, 증감 항목에 클러스터·호스트·
// 데이터스토어가 담겨야 클릭 상세가 성립한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotKey, slotStartMs, normalizeVm, diffVcenter, totalsOf } from '../src/vmtrack/diff.js';

test('slotKey: 00~11시 → T00, 12~23시 → T12(로컬 기준)', () => {
  assert.equal(slotKey(new Date(2026, 7, 21, 0, 0)), '2026-08-21T00');
  assert.equal(slotKey(new Date(2026, 7, 21, 11, 59)), '2026-08-21T00');
  assert.equal(slotKey(new Date(2026, 7, 21, 12, 0)), '2026-08-21T12');
  assert.equal(slotKey(new Date(2026, 7, 21, 23, 59)), '2026-08-21T12');
  assert.equal(slotKey(new Date(2026, 0, 5, 9, 30)), '2026-01-05T00', '월/일 zero-pad');
});

test('slotStartMs: 슬롯 시작 시각(차트 x축 정렬) · 잘못된 키는 null', () => {
  assert.equal(slotStartMs('2026-08-21T12'), new Date(2026, 7, 21, 12, 0, 0, 0).getTime());
  assert.equal(slotStartMs('2026-08-21T06'), null);
  assert.equal(slotStartMs(''), null);
});

test('normalizeVm: 추적 필드 추출 — 데이터스토어 배열/단일 모두 수용', () => {
  const a = normalizeVm({ id: 'vc1:vm-1', name: 'web01', cluster: 'C1', host: 'esx1', datastores: ['ds1', 'ds2'], powerState: 'POWERED_ON', cpuCount: 4, memMB: 8192, storageGB: 120, guestOS: 'Ubuntu' });
  assert.equal(a.vmId, 'vc1:vm-1');
  assert.equal(a.datastore, 'ds1, ds2');
  assert.equal(a.cpu, 4);
  const b = normalizeVm({ id: 'vc1:vm-2', datastore: 'ds9' });
  assert.equal(b.datastore, 'ds9');
  assert.equal(b.cpu, null, '숫자 없으면 null(0 으로 왜곡하지 않음)');
});

test('diffVcenter: 최초(로스터 없음)는 baseline — 전량을 신규로 잡지 않는다', () => {
  const d = diffVcenter([{ id: 'v1' }, { id: 'v2', powerState: 'POWERED_ON' }], new Map());
  assert.equal(d.baseline, true);
  assert.equal(d.total, 2);
  assert.equal(d.onCount, 1);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.live.length, 2, 'roster 저장용 live 는 채운다');
});

test('diffVcenter: 생성/삭제 판정 + 삭제 VM 의 마지막 위치(클러스터·호스트·DS) 보존', () => {
  const prev = new Map([
    ['vc1:vm-old', { vm_id: 'vc1:vm-old', name: 'old01', cluster: 'C9', host: 'esx9', datastore: 'dsX', power_state: 'POWERED_ON', cpu: 2, mem_mb: 4096, storage_gb: 40, guest_os: 'CentOS' }],
    ['vc1:vm-keep', { vm_id: 'vc1:vm-keep', name: 'keep01' }],
  ]);
  const now = [
    { id: 'vc1:vm-keep', name: 'keep01', powerState: 'POWERED_ON' },
    { id: 'vc1:vm-new', name: 'new01', cluster: 'C1', host: 'esx1', datastores: ['ds1'], powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384, storageGB: 200 },
  ];
  const d = diffVcenter(now, prev);
  assert.equal(d.baseline, false);
  assert.equal(d.total, 2);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, 'new01');
  assert.equal(d.added[0].cluster, 'C1');
  assert.equal(d.added[0].host, 'esx1');
  assert.equal(d.added[0].datastore, 'ds1');
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].vmId, 'vc1:vm-old');
  assert.equal(d.removed[0].cluster, 'C9', '삭제 VM 은 직전 관측 위치를 그대로 보고');
  assert.equal(d.removed[0].host, 'esx9');
  assert.equal(d.removed[0].datastore, 'dsX');
});

test('diffVcenter: 이름 변경은 삭제+생성으로 오탐하지 않는다(moref 기반 id)', () => {
  const prev = new Map([['vc1:vm-1', { vm_id: 'vc1:vm-1', name: 'before' }]]);
  const d = diffVcenter([{ id: 'vc1:vm-1', name: 'after' }], prev);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
  assert.equal(d.total, 1);
});

test('totalsOf: vCenter별 합산 · 전 vCenter 기준선일 때만 전체도 기준선', () => {
  const a = { total: 10, onCount: 8, added: [{}, {}], removed: [{}], baseline: false };
  const b = { total: 5, onCount: 5, added: [], removed: [], baseline: true };
  const t = totalsOf([a, b]);
  assert.equal(t.total, 15);
  assert.equal(t.onCount, 13);
  assert.equal(t.added, 2);
  assert.equal(t.removed, 1);
  assert.equal(t.baseline, false, '하나라도 기준선이 아니면 전체는 기준선 아님');
  assert.equal(totalsOf([b]).baseline, true);
  assert.equal(totalsOf([]).baseline, false, '빈 입력은 기준선 표기 안 함');
});

// ── v2.347: 켜진/꺼진 VM 수량 변화 + 전원 전환 ──────────────────────────────────

test('diffVcenter(v2.347): 켜짐/꺼짐 수량 + 전원 전환(Off→On / On→Off) 판정', () => {
  const prev = new Map([
    ['vc1:a', { vm_id: 'vc1:a', name: 'a', power_state: 'POWERED_OFF', cluster: 'C1', host: 'esx1', datastore: 'ds1' }],
    ['vc1:b', { vm_id: 'vc1:b', name: 'b', power_state: 'POWERED_ON' }],
    ['vc1:c', { vm_id: 'vc1:c', name: 'c', power_state: 'POWERED_ON' }],
  ]);
  const now = [
    { id: 'vc1:a', name: 'a', powerState: 'POWERED_ON', cluster: 'C1', host: 'esx1', datastores: ['ds1'] }, // Off→On
    { id: 'vc1:b', name: 'b', powerState: 'POWERED_OFF' },                                                  // On→Off
    { id: 'vc1:c', name: 'c', powerState: 'POWERED_ON' },                                                   // 유지
  ];
  const d = diffVcenter(now, prev);
  assert.equal(d.total, 3);
  assert.equal(d.onCount, 2);
  assert.equal(d.offCount, 1, 'offCount = total - onCount');
  assert.equal(d.poweredOn.length, 1);
  assert.equal(d.poweredOn[0].name, 'a');
  assert.equal(d.poweredOn[0].prevPowerState, 'POWERED_OFF', '상세에서 Off→On 을 보여주려면 이전 상태 필요');
  assert.equal(d.poweredOn[0].cluster, 'C1', '전환 항목도 현재 위치(클러스터·호스트·DS) 포함');
  assert.equal(d.poweredOn[0].datastore, 'ds1');
  assert.equal(d.poweredOff.length, 1);
  assert.equal(d.poweredOff[0].name, 'b');
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test('diffVcenter(v2.347): 신규 생성/삭제는 전원 전환으로 중복 집계하지 않는다', () => {
  const prev = new Map([['vc1:gone', { vm_id: 'vc1:gone', name: 'gone', power_state: 'POWERED_ON' }]]);
  const d = diffVcenter([{ id: 'vc1:new', name: 'new', powerState: 'POWERED_ON' }], prev);
  assert.equal(d.added.length, 1, '새로 만들어져 켜진 VM 은 생성으로만');
  assert.equal(d.poweredOn.length, 0);
  assert.equal(d.removed.length, 1, '삭제된 켜진 VM 은 삭제로만');
  assert.equal(d.poweredOff.length, 0);
  assert.equal(d.onCount, 1);
  assert.equal(d.offCount, 0);
});

test('diffVcenter(v2.347): 기준선은 전원 전환도 비운다', () => {
  const d = diffVcenter([{ id: 'v1', powerState: 'POWERED_ON' }, { id: 'v2', powerState: 'POWERED_OFF' }], new Map());
  assert.equal(d.baseline, true);
  assert.equal(d.onCount, 1);
  assert.equal(d.offCount, 1);
  assert.deepEqual(d.poweredOn, []);
  assert.deepEqual(d.poweredOff, []);
});

test('totalsOf(v2.347): 꺼짐·전원 전환도 합산 · offCount 없는 입력은 total-on 폴백', () => {
  const t = totalsOf([
    { total: 10, onCount: 7, offCount: 3, added: [], removed: [], poweredOn: [{}, {}], poweredOff: [{}], baseline: false },
    { total: 4, onCount: 1, added: [], removed: [], poweredOn: [], poweredOff: [{}], baseline: false }, // offCount 미제공
  ]);
  assert.equal(t.onCount, 8);
  assert.equal(t.offCount, 6, '3 + (4-1)');
  assert.equal(t.poweredOn, 2);
  assert.equal(t.poweredOff, 2);
});
