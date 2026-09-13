// v2.499 — 비교 매트릭스 집계 회귀 고정.
// 핵심: (1) 가로축 vCenter · 세로축 이름, (2) 없는 조합은 **셀이 없다**(0 으로 채우지 않는다),
// (3) 같은 이름이 여러 vCenter 에 있으면 나란히 비교된다, (4) 행/열 합계가 보이는 행과 일치한다,
// (5) 행 상한·절단 정직 표기, (6) scope 밖 vCenter 는 열에도 행에도 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterMatrix, datastoreMatrix, stripSitePrefix, CLUSTER_METRICS, DATASTORE_METRICS } from '../src/tools/compareMatrix.js';

const host = (vc, cluster, o = {}) => ({
  vcenterId: vc, name: `esx-${Math.random().toString(16).slice(2, 8)}`, cluster,
  cpuCores: 32, cpuTotalMhz: 96_000, cpuUsageMhz: 24_000, memTotalMB: 524_288, memUsageMB: 262_144, ...o,
});
const vm = (vc, cluster, o = {}) => ({ vcenterId: vc, cluster, powerState: 'POWERED_ON', cpuCount: 4, memMB: 8_192, ...o });
const ds = (vc, name, o = {}) => ({ vcenterId: vc, id: `${vc}:ds-${name}`, name, capacityGB: 10_240, freeGB: 2_048, usedGB: 8_192, ...o });

const slice = {
  vcenters: [{ id: 'vc-kr', name: '한국' }, { id: 'vc-us', name: '미국동부' }, { id: 'vc-pl', name: '폴란드' }],
  hosts: [
    host('vc-kr', 'PROD'), host('vc-kr', 'PROD'), host('vc-kr', 'DEV'),
    host('vc-us', 'PROD', { cpuUsageMhz: 76_800, memUsageMB: 471_859 }),
    host('vc-pl', 'DMZ', { cpuCores: 16, cpuTotalMhz: 48_000, cpuUsageMhz: 4_800, memTotalMB: 262_144, memUsageMB: 26_214 }),
  ],
  vms: [
    vm('vc-kr', 'PROD'), vm('vc-kr', 'PROD'), vm('vc-kr', 'PROD', { powerState: 'POWERED_OFF' }),
    vm('vc-kr', 'DEV'), vm('vc-us', 'PROD'), vm('vc-pl', 'DMZ'),
    vm('vc-kr', 'PROD', { template: true }),   // 템플릿은 세지 않는다
  ],
  datastores: [
    ds('vc-kr', 'SAN-GOLD'), ds('vc-kr', 'SAN-GOLD'), ds('vc-kr', 'NFS-BACKUP', { capacityGB: 40_960, freeGB: 4_096, usedGB: 36_864 }),
    ds('vc-us', 'SAN-GOLD', { capacityGB: 20_480, freeGB: 16_384, usedGB: 4_096 }),
  ],
};

test('클러스터 매트릭스 — 같은 이름이 vCenter 별로 나란히 비교되고 없는 조합은 셀이 없다', () => {
  const m = clusterMatrix(slice);
  assert.deepEqual(m.vcenters.map((v) => v.id), ['vc-kr', 'vc-us', 'vc-pl'], '가로축 = vCenter');
  const prod = m.rows.find((r) => r.name === 'PROD');
  assert.ok(prod, '세로축 = 클러스터 이름');
  assert.equal(prod.vcenters, 2, 'PROD 는 두 vCenter 에 있다');
  assert.equal(prod.cells['vc-pl'], undefined, '없는 조합은 0 이 아니라 **키 자체가 없다**');
  assert.equal(prod.cells['vc-kr'].hosts, 2);
  assert.equal(prod.cells['vc-kr'].cpuUsagePct, 25, '24,000 / 96,000 = 25%');
  assert.equal(prod.cells['vc-us'].cpuUsagePct, 80, '같은 클러스터 이름의 사이트별 차이가 바로 보인다');
  assert.equal(prod.cells['vc-kr'].vms, 3, '템플릿 제외');
  assert.equal(prod.cells['vc-kr'].vmsOn, 2);
  // vCPU:코어 = 켜진 VM vCPU 합 ÷ 물리 코어(2 호스트 × 32)
  assert.equal(prod.cells['vc-kr'].vcpuPerCore, 0.1);
  assert.equal(prod.cells['vc-kr'].memOvercommitPct, 2, '(2×8,192) / (2×524,288) ≈ 1.6% → 2%');
  const dmz = m.rows.find((r) => r.name === 'DMZ');
  assert.deepEqual(Object.keys(dmz.cells), ['vc-pl']);
});

test('클러스터 매트릭스 — 행 합계는 전 vCenter 합, 열 합계는 보이는 행의 합', () => {
  const m = clusterMatrix(slice);
  const prod = m.rows.find((r) => r.name === 'PROD');
  assert.equal(prod.total.hosts, 3, '한국 2 + 미국 1');
  assert.equal(prod.total.vms, 4);
  assert.equal(m.colTotals['vc-kr'].hosts, 3, '한국은 PROD 2 + DEV 1');
  assert.equal(m.colTotals['vc-us'].hosts, 1);
  assert.equal(m.colTotals['vc-pl'].vms, 1);
  // 열 합계의 사용률은 그 vCenter 전체 기준(가중 평균이 아니라 합계로 계산)
  assert.equal(m.colTotals['vc-us'].cpuUsagePct, 80);
});

test('클러스터 없음 → (독립 호스트) 행으로 모으고, VM 만 있는 클러스터도 행이 생긴다', () => {
  const m = clusterMatrix({
    vcenters: [{ id: 'vc1', name: 'vc1' }],
    hosts: [host('vc1', ''), host('vc1', null)],
    vms: [vm('vc1', ''), vm('vc1', 'GHOST')],
    datastores: [],
  });
  const standalone = m.rows.find((r) => r.name === '(독립 호스트)');
  assert.equal(standalone.cells.vc1.hosts, 2);
  const ghost = m.rows.find((r) => r.name === 'GHOST');
  assert.ok(ghost, '호스트가 없는 클러스터 이름의 VM 도 숨기지 않는다(스냅샷 불일치를 드러낸다)');
  assert.equal(ghost.cells.vc1.hosts, 0);
  assert.equal(ghost.cells.vc1.cpuUsagePct, null, '호스트가 없으면 사용률은 0 이 아니라 null');
});

test('스토리지 매트릭스 — 같은 이름은 vCenter 안에서 합산하고 개수를 밝힌다', () => {
  const m = datastoreMatrix(slice);
  const gold = m.rows.find((r) => r.name === 'SAN-GOLD');
  assert.equal(gold.cells['vc-kr'].count, 2, '같은 이름 2개 → 합산하고 개수 표기');
  assert.equal(gold.cells['vc-kr'].capacityTB, 20);
  assert.equal(gold.cells['vc-kr'].usedPct, 80);
  assert.equal(gold.cells['vc-us'].usedPct, 20);
  assert.equal(gold.cells['vc-pl'], undefined);
  // 총 용량이 같으면(SAN-GOLD 20,480+20,480 = NFS-BACKUP 40,960) 이름순으로 안정 정렬한다.
  assert.deepEqual(m.rows.map((r) => r.name), ['NFS-BACKUP', 'SAN-GOLD']);
  const nfs = m.rows.find((r) => r.name === 'NFS-BACKUP');
  assert.equal(nfs.cells['vc-kr'].freeTB, 4);
  assert.equal(nfs.total.capacityTB, 40);
});

test('스토리지 매트릭스 — 총 용량이 큰 행이 먼저 온다', () => {
  const m = datastoreMatrix({
    vcenters: [{ id: 'vc1', name: 'vc1' }, { id: 'vc2', name: 'vc2' }],
    datastores: [
      ds('vc1', 'SMALL', { capacityGB: 1_024, freeGB: 512, usedGB: 512 }),
      ds('vc1', 'BIG', { capacityGB: 50_000, freeGB: 1_000, usedGB: 49_000 }),
      ds('vc2', 'SMALL', { capacityGB: 1_024, freeGB: 512, usedGB: 512 }),
    ],
  });
  assert.deepEqual(m.rows.map((r) => r.name), ['BIG', 'SMALL']);
  assert.equal(m.rows[1].vcenters, 2, '두 vCenter 에 같은 이름이 있으면 나란히 비교된다');
});

test('usedGB 가 없으면 capacity-free 로 계산한다(0 으로 채우지 않는다)', () => {
  const m = datastoreMatrix({
    vcenters: [{ id: 'vc1', name: 'vc1' }],
    datastores: [{ vcenterId: 'vc1', id: 'vc1:ds-1', name: 'X', capacityGB: 1_024, freeGB: 256 }],
  });
  assert.equal(m.rows[0].cells.vc1.usedTB, 0.8);
  assert.equal(m.rows[0].cells.vc1.usedPct, 75);
});

test('행 상한 — 규모 순으로 자르고 자른 수를 정직하게 알린다', () => {
  const many = { vcenters: [{ id: 'vc1', name: 'vc1' }], datastores: [] };
  for (let i = 0; i < 50; i++) many.datastores.push(ds('vc1', `DS-${String(i).padStart(2, '0')}`, { capacityGB: 1_000 + i }));
  const m = datastoreMatrix(many, { maxRows: 10 });
  assert.equal(m.rows.length, 10);
  assert.equal(m.rowCount, 50);
  assert.equal(m.truncated, true);
  assert.equal(m.truncatedRows, 40);
  assert.equal(m.rows[0].name, 'DS-49', '가장 큰 것부터');
  // 열 합계는 **보이는 행만** — 표의 합과 어긋나면 안 된다
  const visible = m.rows.reduce((a, r) => a + (r.cells.vc1?.count || 0), 0);
  assert.equal(m.colTotals.vc1.count, visible);
});

test('scope — 허용 목록(vcenters) 밖 자원은 열에도 행에도 나타나지 않는다', () => {
  const m = clusterMatrix({
    vcenters: [{ id: 'vc-kr', name: '한국' }],       // scopeSlice 가 남긴 허용 목록
    hosts: [host('vc-kr', 'PROD'), host('vc-secret', 'TOPSECRET')],
    vms: [vm('vc-secret', 'TOPSECRET')],
    datastores: [],
  });
  assert.deepEqual(m.vcenters.map((v) => v.id), ['vc-kr']);
  assert.deepEqual(m.rows.map((r) => r.name), ['PROD'], '범위 밖 클러스터 이름이 행으로 새면 안 된다');
  assert.equal(JSON.stringify(m).includes('vc-secret'), false);
  assert.equal(JSON.stringify(m).includes('TOPSECRET'), false);
});

test('빈 입력·지표 정의', () => {
  const empty = clusterMatrix({});
  assert.deepEqual(empty.rows, []);
  assert.deepEqual(empty.vcenters, []);
  assert.equal(empty.truncated, false);
  assert.deepEqual(datastoreMatrix({}).rows, []);
  // 지표 정의는 화면이 열·색 판정에 쓰므로 키가 셀 모양과 1:1 이어야 한다
  const cellKeys = Object.keys(clusterMatrix(slice).rows[0].cells['vc-kr']);
  assert.deepEqual(CLUSTER_METRICS.map((m) => m.key).sort(), cellKeys.sort());
  const dsKeys = Object.keys(datastoreMatrix(slice).rows[0].cells['vc-kr']);
  assert.deepEqual(DATASTORE_METRICS.map((m) => m.key).sort(), dsKeys.sort());
  for (const m of [...CLUSTER_METRICS, ...DATASTORE_METRICS]) assert.ok(['bad', 'good', 'neutral'].includes(m.higher), m.key);
});

test('사이트 접두 제거(휴리스틱) — 역할끼리 묶어 대각선 매트릭스를 실제 비교로 만든다', () => {
  assert.equal(stripSitePrefix('Ashburn-CL3'), 'CL3');
  assert.equal(stripSitePrefix('ashburn-ds-vsan-2'), 'ds-vsan-2');
  assert.equal(stripSitePrefix('PROD'), 'PROD', '구분자가 없으면 그대로(이름이 사라지면 안 된다)');
  assert.equal(stripSitePrefix('-CL1'), '-CL1', '앞이 비면 손대지 않는다');
  assert.equal(stripSitePrefix('CL1-'), 'CL1-');
  assert.equal(stripSitePrefix(null), '');

  const s2 = {
    vcenters: [{ id: 'vc-us', name: '미국' }, { id: 'vc-eu', name: '유럽' }],
    hosts: [host('vc-us', 'Ashburn-CL1'), host('vc-eu', 'Dublin-CL1', { cpuUsageMhz: 76_800 })],
    vms: [vm('vc-us', 'Ashburn-CL1'), vm('vc-eu', 'Dublin-CL1')],
    datastores: [],
  };
  const plain = clusterMatrix(s2);
  assert.equal(plain.rows.length, 2, '정규화 없이는 사이트별로 행이 갈린다(대각선)');
  assert.equal(plain.rows[0].vcenters, 1);
  assert.equal(plain.rows[0].origNames, undefined, '합쳐진 것이 없으면 원래 이름 목록을 싣지 않는다');

  const norm = clusterMatrix(s2, { normalize: true });
  assert.equal(norm.rows.length, 1, '접두를 떼면 같은 역할이 한 행으로 모인다');
  assert.equal(norm.rows[0].name, 'CL1');
  assert.equal(norm.rows[0].vcenters, 2, '두 사이트가 나란히 비교된다');
  assert.equal(norm.rows[0].cells['vc-us'].cpuUsagePct, 25);
  assert.equal(norm.rows[0].cells['vc-eu'].cpuUsagePct, 80);
  assert.deepEqual(norm.rows[0].origNames, ['Ashburn-CL1', 'Dublin-CL1'], '무엇이 합쳐졌는지 밝힌다');
});

test('접두 제거는 데이터스토어에도 적용되고 합산이 정확하다', () => {
  const s2 = {
    vcenters: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    datastores: [
      ds('a', 'siteA-gold', { capacityGB: 1_024, freeGB: 512, usedGB: 512 }),
      ds('b', 'siteB-gold', { capacityGB: 3_072, freeGB: 1_024, usedGB: 2_048 }),
    ],
  };
  const norm = datastoreMatrix(s2, { normalize: true });
  assert.equal(norm.rows.length, 1);
  assert.equal(norm.rows[0].name, 'gold');
  assert.equal(norm.rows[0].cells.a.usedPct, 50);
  assert.equal(norm.rows[0].cells.b.usedPct, 66.7);
  assert.equal(norm.rows[0].total.capacityTB, 4);
  assert.deepEqual(norm.rows[0].origNames, ['siteA-gold', 'siteB-gold']);
});
