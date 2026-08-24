// VM 수량 추이(v2.345) 단위테스트 — 슬롯 키/시각 계산 + 스냅샷 diff(순수 로직).
// 사용자 요구를 고정한다: 매일 00·12시 슬롯, vCenter별 증감, 증감 항목에 클러스터·호스트·
// 데이터스토어가 담겨야 클릭 상세가 성립한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotKey, slotStartMs, normalizeVm, diffVcenter, totalsOf, normalizeDs, diffDatastores } from '../src/vmtrack/diff.js';

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

// ── v2.348: vCenter 에 연결된 데이터스토어 사용량 추적 ─────────────────────────────

test('normalizeDs: 용량 필드 추출 · freeGB 미제공 시 cap-used 로 보완 · 사용률 계산', () => {
  const a = normalizeDs({ id: 'vc1:ds1', name: 'ds1', storageType: 'vsan', capacityGB: 1000, usedGB: 250, freeGB: 750 });
  assert.equal(a.dsId, 'vc1:ds1');
  assert.equal(a.type, 'vsan');
  assert.equal(a.usagePct, 25);
  const b = normalizeDs({ id: 'vc1:ds2', name: 'ds2', type: 'NFS', capacityGB: 200, usedGB: 50 });
  assert.equal(b.freeGB, 150, 'freeGB 없으면 cap-used');
  assert.equal(b.type, 'NFS', 'storageType 없으면 type 폴백');
});

test('diffDatastores: 최초는 기준선 — 집계는 하되 변경 목록은 비운다', () => {
  const d = diffDatastores([
    { id: 'vc1:a', name: 'a', capacityGB: 1000, usedGB: 400 },
    { id: 'vc1:b', name: 'b', capacityGB: 1000, usedGB: 100 },
  ], new Map());
  assert.equal(d.baseline, true);
  assert.equal(d.count, 2);
  assert.equal(d.capGB, 2000);
  assert.equal(d.usedGB, 500);
  assert.equal(d.freeGB, 1500);
  assert.equal(d.usagePct, 25);
  assert.deepEqual(d.changed, []);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.removed, []);
});

test('diffDatastores: 임계 이상 사용량 변화만 기록(합계는 항상 정확) + 연결/해제', () => {
  const prev = new Map([
    ['vc1:a', { ds_id: 'vc1:a', name: 'a', type: 'vsan', cap_gb: 1000, used_gb: 400, free_gb: 600 }],
    ['vc1:tiny', { ds_id: 'vc1:tiny', name: 'tiny', cap_gb: 100, used_gb: 50, free_gb: 50 }],
    ['vc1:gone', { ds_id: 'vc1:gone', name: 'gone', type: 'NFS', cap_gb: 500, used_gb: 300, free_gb: 200 }],
  ]);
  const now = [
    { id: 'vc1:a', name: 'a', storageType: 'vsan', capacityGB: 1000, usedGB: 450 },  // +50GB → 기록
    { id: 'vc1:tiny', name: 'tiny', capacityGB: 100, usedGB: 50.5 },                  // +0.5GB → 임계 미만, 기록 안 함
    { id: 'vc1:new', name: 'new', capacityGB: 2000, usedGB: 10 },                     // 신규 연결
  ];
  const d = diffDatastores(now, prev);
  assert.equal(d.count, 3);
  assert.equal(d.usedGB, 510.5, '합계는 임계와 무관하게 정확(차트 원천)');
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].name, 'a');
  assert.equal(d.changed[0].deltaGB, 50);
  assert.equal(d.changed[0].prevUsedGB, 400, '상세에서 이전→현재를 보여주려면 필요');
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, 'new');
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].name, 'gone');
  assert.equal(d.removed[0].usedGB, 300, '해제된 DS 는 마지막 관측치 보존');
});

test('diffDatastores: 사용량 감소도 기록(정리·삭제 추적)', () => {
  const prev = new Map([['vc1:a', { ds_id: 'vc1:a', name: 'a', cap_gb: 1000, used_gb: 900, free_gb: 100 }]]);
  const d = diffDatastores([{ id: 'vc1:a', name: 'a', capacityGB: 1000, usedGB: 700 }], prev);
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].deltaGB, -200);
  assert.equal(d.usagePct, 70);
});

test('totalsOf(v2.348): 데이터스토어 개수·용량·사용량 합산', () => {
  const t = totalsOf([
    { total: 1, onCount: 1, added: [], removed: [], ds: { count: 2, capGB: 1000, usedGB: 400 }, baseline: false },
    { total: 1, onCount: 0, added: [], removed: [], ds: { count: 3, capGB: 2000, usedGB: 600 }, baseline: false },
    { total: 1, onCount: 0, added: [], removed: [], baseline: false }, // ds 없음(수집 전) — 0 취급
  ]);
  assert.equal(t.dsCount, 5);
  assert.equal(t.dsCapGB, 3000);
  assert.equal(t.dsUsedGB, 1000);
});
