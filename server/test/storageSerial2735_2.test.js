/**
 * 스토리지 시리얼 표시(v2.735.2 — 사용자 요청 "PowerScale 각 장비의 시리얼/service tag · Unity · XtremIO 시리얼 보이게").
 *
 * ⚠ 정직 기록: 아래 장비 출력은 **합성**이다(이 현장 장비의 `isi_hw_status -i` · `/sys/general show -detail` ·
 *   XMS 클러스터 응답을 본 적이 없다 — OneFS·Unity CLI·XMS REST 문서 지식). 그래서 파서는 키를 후보로 읽고,
 *   못 읽으면 값을 지어내지 않고 사유(probe)를 남긴다 — 이 테스트가 그 두 성질을 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const hw = await import('../src/storage/collectors/isilonHw.js');
const isiSsh = await import('../src/storage/collectors/isilonSsh.js');
const isi = await import('../src/storage/collectors/isilon.js');
const xio = await import('../src/storage/collectors/xtremio.js');
const xioSsh = await import('../src/storage/collectors/xtremioSsh.js');
const unitySsh = await import('../src/storage/collectors/unitySsh.js');
const { sanitizeNodeList } = await import('../src/central/edgeRecord.js');

const HW_OUT = [
  'SYN-cl-1:   SerNo: SYNSER0001',
  'SYN-cl-1:  Config: 400-0049-03',
  'SYN-cl-1: ChsSerN: SYNCHS0001',
  'SYN-cl-1: Product: A300-4U-Single-96GB-1x1GE-2x25GE SFP+-60TB-1638GB SSD',
  'SYN-cl-2:   SerNo: SYNSER0002',
  'SYN-cl-2: ChsSerN: SYNCHS0001',
  'SYN-cl-2: Product: A300-4U-Single-96GB-1x1GE-2x25GE SFP+-60TB-1638GB SSD',
  'SYN-cl-10:   SerNo: SYNSER0010',
  'other-3:   SerNo: NOTMINE',
  'garbage line without colon',
].join('\n');

test('① isi_hw_status 파서 — LNN 별 SerNo·섀시·제품 · 다른 접두는 버린다 · 선형', () => {
  const p = hw.parseIsiHwStatus(HW_OUT, { clusterName: 'syn-cl' });
  assert.equal(p.nodes, 3);
  assert.deepEqual(p.byLnn['1'], { serial: 'SYNSER0001', chassisSerial: 'SYNCHS0001', model: 'A300-4U-Single-96GB-1x1GE-2x25GE SFP+-60TB-1638GB SSD' });
  assert.equal(p.byLnn['10'].serial, 'SYNSER0010');
  assert.equal(p.byLnn['3'], undefined);             // 다른 클러스터 이름 접두 — 노드 번호를 믿을 수 없다
  // 긴 줄·콜론 없는 긴 공백 — 선형(상한 내)
  const t0 = Date.now();
  hw.parseIsiHwStatus(`${' '.repeat(200_000)}\n${'a'.repeat(200_000)}:${' '.repeat(200_000)}`, { clusterName: 'x' });
  assert.ok(Date.now() - t0 < 1000);
});

test('② SSH 읽기 — 6시간 캐시 · 실패는 1시간 뒤 · 직전 성공 유지 · 예산 초과는 시작하지 않음', async () => {
  hw._resetIsiHwCacheForTest();
  let calls = 0; let mode = 'ok';
  const sh = { exec: async (cmd) => { calls += 1; assert.equal(cmd, hw.ISI_HW_CMD); if (mode === 'throw') throw new Error('permission denied'); return { stdout: mode === 'ok' ? HW_OUT : '' }; } };
  const dev = { id: 'isi-1', host: '10.0.0.1' };
  let now = 1_000_000;
  const r1 = await hw.readIsiHwSsh(sh, dev, { sessionStartedAt: now, clusterName: 'SYN-cl', now: () => now });
  assert.equal(r1.ok, true); assert.equal(r1.cached, false); assert.equal(calls, 1);
  now += 3_600_000;
  const r2 = await hw.readIsiHwSsh(sh, dev, { sessionStartedAt: now, clusterName: 'SYN-cl', now: () => now });
  assert.equal(r2.cached, true); assert.equal(calls, 1);   // 6시간 안 — 묻지 않는다
  now += 6 * 3_600_000; mode = 'throw';
  const r3 = await hw.readIsiHwSsh(sh, dev, { sessionStartedAt: now, clusterName: 'SYN-cl', now: () => now });
  assert.equal(calls, 2);
  assert.equal(r3.ok, true);                                // 실패해도 직전 성공값을 준다(시리얼은 바뀌지 않는다)
  assert.equal(r3.lastError.reason, 'exec');
  // 예산 초과 — 캐시가 없는 장비는 시작하지 않고 사유를 남긴다(실패로 기억하지 않는다).
  const r4 = await hw.readIsiHwSsh(sh, { id: 'isi-2', host: 'h2' }, { sessionStartedAt: now - 150_000, now: () => now });
  assert.equal(r4.ok, false); assert.equal(r4.reason, 'budget'); assert.equal(calls, 2);
  // 출력은 있는데 접두가 클러스터 이름과 다르면 사유에 그 사실을 적는다.
  mode = 'ok';
  const r5 = await hw.readIsiHwSsh(sh, { id: 'isi-3', host: 'h3' }, { sessionStartedAt: now, clusterName: 'renamed', now: () => now });
  assert.equal(r5.ok, false); assert.equal(r5.reason, 'parse');
  assert.match(r5.detail, /클러스터 이름\(renamed\)/);
});

test('③ 스냅샷에 붙이기 — isi status 노드 ID(LNN)로 · 못 읽으면 값 없이 사유 · 엣지 정제가 시리얼을 지우지 않는다', () => {
  const status = [
    'Cluster Name: SYN-cl', 'Cluster Health:     [  OK ]',
    ' 1|10.0.0.11  | OK  | C  | 0| 0| 0| (No Storage HDDs)| 17T/ 20T( 83%)',
    ' 2|10.0.0.12  | OK  | C  | 0| 0| 0| (No Storage HDDs)| 17T/ 20T( 83%)',
    ' 3|10.0.0.13  | OK  | C  | 0| 0| 0| (No Storage HDDs)| 17T/ 20T( 83%)',
  ].join('\n');
  const parsed = isiSsh.parseIsiStatus(status);
  const snap = isiSsh.normalizeIsiStatus({ id: 'isi-1', type: 'isilon', name: 'x', host: 'h' }, parsed, {});
  const r = { ok: true, at: 123, cached: false, byLnn: hw.parseIsiHwStatus(HW_OUT, { clusterName: 'SYN-cl' }).byLnn };
  hw.applyIsiNodeHw(snap, r, { source: hw.ISI_HW_CMD });
  assert.equal(snap.nodes.list[0].serial, 'SYNSER0001');
  assert.equal(snap.nodes.list[0].chassisSerial, 'SYNCHS0001');
  assert.match(snap.nodes.list[0].model, /^A300/);
  assert.equal(snap.nodes.list[2].serial, undefined);       // 3번 노드 줄 없음 — 지어내지 않는다
  assert.deepEqual({ read: snap.extra.nodeSerials.read, total: snap.extra.nodeSerials.total }, { read: 2, total: 3 });
  // 엣지 → 중앙 정제가 시리얼·섀시 시리얼을 지우지 않는다(아는 필드).
  const copy = JSON.parse(JSON.stringify(snap));
  sanitizeNodeList(copy);
  assert.equal(copy.nodes.list[0].serial, 'SYNSER0001');
  assert.equal(copy.nodes.list[0].chassisSerial, 'SYNCHS0001');
  // 못 읽음 — 사유만.
  const snap2 = isiSsh.normalizeIsiStatus({ id: 'isi-1', type: 'isilon', name: 'x', host: 'h' }, parsed, {});
  hw.applyIsiNodeHw(snap2, { ok: false, reason: 'exec', detail: 'permission denied' }, { source: hw.ISI_HW_CMD });
  assert.equal(snap2.nodes.list[0].serial, undefined);
  assert.equal(snap2.extra.nodeSerialProbe.reason, 'exec');
});

test('④ REST — /cluster/nodes 의 hardware 하위 · GUID 는 GUID 라고 부른다', () => {
  const snap = isi.normalizeIsilon({ id: 'r', type: 'isilon', name: 'r', host: 'h' }, {
    config: { name: 'c', guid: '0050568f1a2b', onefs_version: { release: '9.7.1.5' } },
    nodes: { nodes: [
      { id: 1, lnn: 1, hardware: { serial_number: 'SYNREST01', product: 'F600-1U' } },
      { id: 2, lnn: 2, hardware: {} },
    ] },
  });
  assert.equal(snap.serial, '0050568f1a2b');
  assert.equal(snap.extra.serialKind, 'guid');
  assert.equal(snap.nodes.list[0].serial, 'SYNREST01');
  assert.equal(snap.nodes.list[0].model, 'F600-1U');
  assert.equal(Object.hasOwn(snap.nodes.list[1], 'serial'), false);
  assert.deepEqual({ read: snap.extra.nodeSerials.read, total: snap.extra.nodeSerials.total }, { read: 1, total: 2 });
});

test('⑤ XtremIO REST — 시리얼 후보·이름 패턴 · 부품번호는 패턴에서 제외 · 없으면 비슷한 키를 밝힌다', () => {
  assert.equal(xio.pickXtremioSerial({ 'sys-psnt-serial-number': 'SYNPSNT1', 'sys-psnt-part-number': 'P1' }).key, 'sys-psnt-serial-number');
  assert.equal(xio.pickXtremioSerial({ 'cluster-psnt-sn': 'SYNPSNT2' }).value, 'SYNPSNT2');      // 패턴(이름에 psnt)
  assert.equal(xio.pickXtremioSerial({ 'brick-part-number': 'X' }).value, '');                  // part 는 시리얼이 아니다
  assert.equal(xio.pickXtremioSerial({ 'sys-psnt-part-number': 'XIO00161700123' }).value, 'XIO00161700123'); // v2.310 부터의 이름은 유지
  const none = xio.pickXtremioSerial({ name: 'c', 'sys-id': ['g', 'c', 1], 'sys-sw-version': '6.4', 'brick-list': [] });
  assert.equal(none.value, '');
  assert.ok(none.seenKeys.includes('sys-id'));
  const snap = xio.normalizeXtremio({ id: 'x', type: 'xtremio', name: 'x', host: 'h' }, { clusters: [{ name: 'c', 'sys-psnt-serial-number': 'SYNPSNT1', 'ud-ssd-space': 10, 'ud-ssd-space-in-use': 1 }] });
  assert.equal(snap.serial, 'SYNPSNT1');
  assert.equal(snap.extra.serialKind, 'psnt');
  const snap2 = xio.normalizeXtremio({ id: 'x', type: 'xtremio', name: 'x', host: 'h' }, { clusters: [{ name: 'c', 'ud-ssd-space': 10 }] });
  assert.equal(snap2.serial, '');
  assert.equal(snap2.extra.serialProbe.reason, 'no-field');
});

test('⑥ XtremIO SSH — 클러스터 번호(Index)를 시리얼로 쓰지 않는다', () => {
  const out = { clusters: 'Cluster-Name  Index  SW-Version\nc1            1      6.4.0\n' };
  const snap = xioSsh.normalizeXtremioSsh({ id: 'x', type: 'xtremio', name: 'x', host: 'h' }, out);
  assert.notEqual(snap.serial, '1');
  assert.equal(snap.serial, '');
});

test('⑦ Unity SSH — 버전을 못 준 앞 후보 원문에서도 시리얼을 건진다 · 못 찾으면 사유', () => {
  const raw = [
    { key: 'version', cmd: 'svc_diag', ok: false, sample: '실행 오류: not found' },
    { key: 'version', cmd: 'uemcli /sys/general show -detail', ok: true,
      sample: 'Storage system address: 127.0.0.1\n\n1:    System name           = SYN-unity\n      Model                 = Unity 480F\n      Product serial number = SYNUNITY0001\n      Health state          = OK (5)\n' },
    { key: 'version', cmd: 'uemcli /sys/soft/ver show', ok: true, sample: '1:    ID   = INST_1\n      Type = Installed\n      Version = 5.5.2.0.5.014\n' },
  ];
  const snap = { serial: '', extra: {} };
  unitySsh.applyUnitySerialFallback(snap, raw);
  assert.equal(snap.serial, 'SYNUNITY0001');
  assert.equal(snap.extra.serialSource, 'uemcli /sys/general show -detail');
  assert.equal(snap.extra.serialKind, 'serial');
  const none = { serial: '', extra: {} };
  unitySsh.applyUnitySerialFallback(none, raw.slice(2));
  assert.equal(none.serial, '');
  assert.equal(none.extra.serialProbe.reason, 'not-in-output');
});
