import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 스토리지 모니터링(v2.302) 회귀 방지 — 레지스트리 검증(SSRF·host 변경 비번 이월 금지)·
// 노드별 수집 대상 판정·Isilon 정규화(픽스처)·타입 카탈로그 계약.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-mon-test-'));
process.env.CONFIG_DIR = TMP;

const reg = await import('../src/storage/registry.js');
const { normalizeIsilon } = await import('../src/storage/collectors/isilon.js');
const { STORAGE_TYPES, emptySnapshot, isImplementedType } = await import('../src/storage/types.js');
const { saveEdgeStorage, edgeStorageSnapshots } = await import('../src/central/storageEdge.js');
const { parseIsiStatus, parseSize, parseBps, normalizeIsiStatus } = await import('../src/storage/collectors/isilonSsh.js');

test('타입 카탈로그 — 6종 구현(v2.310: +xtremio·vmax·powermax), 예정 2종(등록은 구현 타입만)', () => {
  for (const t of ['isilon', 'powerstore', 'unity480', 'xtremio', 'vmax', 'powermax']) assert.ok(isImplementedType(t), `${t} 구현 플립`);
  for (const t of ['vplex', 'metronode']) {
    assert.ok(STORAGE_TYPES.some((x) => x.type === t && !x.implemented), `${t} 카탈로그 예정 항목`);
  }
  assert.throws(() => reg.saveDevice({ type: 'vplex', name: 'X', host: '10.0.0.1', username: 'a' }), /미구현/);
  assert.throws(() => reg.saveDevice({ type: 'netapp', name: 'X', host: '10.0.0.1', username: 'a' }), /알 수 없는/);
});

test('레지스트리 검증 — host 화이트리스트·SSRF 차단·비밀번호 미반환', () => {
  assert.throws(() => reg.saveDevice({ type: 'isilon', name: 'A', host: 'bad host!', username: 'root' }), /host 형식/);
  assert.throws(() => reg.saveDevice({ type: 'isilon', name: 'A', host: '127.0.0.1', username: 'root' }), /차단/); // 루프백 — SSRF 가드
  const d = reg.saveDevice({ type: 'isilon', name: 'WA-ISI-01', host: '10.20.0.50', username: 'root', password: 'pw-secret-1', datacenterId: 'WA', agent: 'wa-edge' });
  assert.equal(d.password, undefined, '저장 결과에 비밀번호 미포함');
  assert.equal(d.hasPassword, true);
  assert.ok(!JSON.stringify(reg.listDevices()).includes('pw-secret-1'), '목록 직렬화에 비밀번호 부재');
  assert.equal(reg.getDeviceWithSecret(d.id).password, 'pw-secret-1', '수집기 전용 조회만 평문 접근');
});

test('host 변경 시 저장 비밀번호 이월 금지(uagmon M3 동일 규칙)', () => {
  const d = reg.saveDevice({ type: 'isilon', name: 'PL-ISI', host: '10.30.0.10', username: 'root', password: 'pl-pw-1' });
  const upd = reg.saveDevice({ id: d.id, type: 'isilon', name: 'PL-ISI', host: '10.30.0.99', username: 'root', password: '' });
  assert.equal(upd.hasPassword, false, 'host 바꿔치기로 기존 비번이 새 host 로 가지 않는다');
  const same = reg.saveDevice({ id: d.id, type: 'isilon', name: 'PL-ISI', host: '10.30.0.99', username: 'root', password: 'pl-pw-2' });
  assert.equal(same.hasPassword, true);
});

test('devicesForThisNode — 중앙(agent 빈값)/엣지(내 이름, 대소문자 무시) 분리', () => {
  const devices = [
    { id: '1', agent: '', enabled: true }, { id: '2', agent: 'WA-Edge', enabled: true },
    { id: '3', agent: 'other', enabled: true }, { id: '4', agent: '', enabled: false },
  ];
  assert.deepEqual(reg.devicesForThisNode({ devices, agentName: 'x', isEdge: false }).map((d) => d.id), ['1'], '중앙=미지정 장비만(비활성 제외)');
  assert.deepEqual(reg.devicesForThisNode({ devices, agentName: 'wa-edge', isEdge: true }).map((d) => d.id), ['2'], '엣지=내 이름 장비만');
});

test('normalizeIsilon — OneFS 픽스처 정규화(용량·버전·노드·계정·섹션 상태)', () => {
  const dev = { id: 'st-1', type: 'isilon', name: '등록명' };
  const snap = normalizeIsilon(dev, {
    config: { name: 'wa-cluster', guid: 'G-123', onefs_version: { release: '9.4.0.0' } },
    stats: { stats: [{ key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.bytes.used', value: 400 }] },
    nodes: { nodes: [{ id: 1, status: 'ok' }, { id: 2, status: 'down' }] },
    users: { users: [{ name: 'root', enabled: true }, { name: 'svc', enabled: false }] },
    pools: { storagepools: [{ name: 'p1', usage: { total_bytes: '1000', used_bytes: '400' } }] },
    events: { total: 3 },
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.name, 'wa-cluster', '장비 보고 이름이 등록명을 대체');
  assert.equal(snap.version, '9.4.0.0');
  assert.deepEqual(snap.capacity, { totalBytes: 1000, usedBytes: 400, pct: 40 });
  assert.equal(snap.nodes.count, 2);
  assert.equal(snap.nodes.unhealthy, 1);
  assert.equal(snap.nodes.list.length, 2, 'v2.303: 노드별 상세 list 동반');
  assert.equal(snap.accounts.length, 2);
  assert.equal(snap.pools[0].pct, 40);
  assert.equal(snap.alerts.unresolved, 3);
  assert.equal(snap.sections.config, 'ok');
});

test('normalizeIsilon — HDD/SSD 미디어 분리(v2.303): SSD 키 존재 시 HDD=전체−SSD', () => {
  const snap = normalizeIsilon({ id: 'st-m', type: 'isilon', name: 'M' }, {
    stats: { stats: [
      { key: 'ifs.bytes.total', value: 1000 }, { key: 'ifs.bytes.used', value: 500 },
      { key: 'ifs.ssd.bytes.total', value: 200 }, { key: 'ifs.ssd.bytes.used', value: 100 },
    ] },
  });
  assert.deepEqual(snap.media.ssd, { totalBytes: 200, usedBytes: 100, pct: 50 });
  assert.deepEqual(snap.media.hdd, { totalBytes: 800, usedBytes: 400, pct: 50 });
  // SSD 키 부재(메타데이터 전용/구버전) — SSD 0, HDD=전체
  const s2 = normalizeIsilon({ id: 'st-m2', type: 'isilon', name: 'M2' }, { stats: { stats: [{ key: 'ifs.bytes.total', value: 100 }, { key: 'ifs.bytes.used', value: 40 }] } });
  assert.equal(s2.media.ssd, null);
  assert.deepEqual(s2.media.hdd, { totalBytes: 100, usedBytes: 40, pct: 40 });
});

test('normalizeIsilon — 노드별 조인(v2.303): devid↔lnn, 무디스크 노드 hdd=null, IP 폴백', () => {
  const snap = normalizeIsilon({ id: 'st-n', type: 'isilon', name: 'N' }, {
    nodes: { nodes: [
      { lnn: 1, ip: '10.94.41.202', status: { health: 'ok' } },
      { lnn: 5, ip_addresses: ['10.94.41.206'], status: 'ok' },
    ] },
    nodeStats: { stats: [
      // 노드1: 무디스크(accelerator) — ifs.bytes.total 0, SSD 만 보유
      { devid: 1, key: 'node.ifs.bytes.total', value: 20 }, { devid: 1, key: 'node.ifs.bytes.used', value: 17 },
      { devid: 1, key: 'node.ifs.ssd.bytes.total', value: 20 }, { devid: 1, key: 'node.ifs.ssd.bytes.used', value: 17 },
      { devid: 1, key: 'node.net.ext.bytes.in.rate', value: 3400000 },
      // 노드5: HDD 108 + SSD 1.5
      { devid: 5, key: 'node.ifs.bytes.total', value: 109.5 }, { devid: 5, key: 'node.ifs.bytes.used', value: 88 },
      { devid: 5, key: 'node.ifs.ssd.bytes.total', value: 1.5 }, { devid: 5, key: 'node.ifs.ssd.bytes.used', value: 0.5 },
    ] },
  });
  const [n1, n5] = snap.nodes.list;
  assert.equal(n1.ip, '10.94.41.202');
  assert.equal(n1.hdd, null, '전체=SSD 인 노드는 HDD 풀 없음(No Storage HDDs)');
  assert.deepEqual(n1.ssd, { totalBytes: 20, usedBytes: 17, pct: 85 });
  assert.equal(n1.inBps, 3400000);
  assert.equal(n5.ip, '10.94.41.206', 'ip_addresses[0] 폴백');
  assert.equal(n5.hdd.totalBytes, 108);
  assert.equal(n5.ssd.totalBytes, 1.5);
  assert.equal(snap.nodes.count, 2);
});

test('normalizeIsilon — 전 섹션 실패면 ok=false + 섹션 상태 보존(부분 실패 정직 표기)', () => {
  const snap = normalizeIsilon({ id: 'st-2', type: 'isilon', name: 'X' }, {});
  assert.equal(snap.ok, false);
  assert.equal(snap.sections.config, 'skip');
  // avail 만 있는 구버전 응답 폴백(used = total - avail)
  const s2 = normalizeIsilon({ id: 'st-3', type: 'isilon', name: 'Y' }, { stats: { stats: [{ key: 'ifs.bytes.total', value: 100 }, { key: 'ifs.bytes.avail', value: 30 }] } });
  assert.equal(s2.capacity.usedBytes, 70);
  assert.equal(s2.ok, true, 'capacity 만 읽혀도 수집됨으로 판정');
});

test('중앙 엣지 저장소 — 인증된 agent 로 출처 각인 + 평탄화에 보고 시각', () => {
  saveEdgeStorage('wa-edge', [{ ...emptySnapshot({ id: 'st-9', type: 'isilon', name: 'N' }), ok: true, agent: '위조시도' }]);
  const flat = edgeStorageSnapshots();
  assert.equal(flat.length, 1);
  assert.equal(flat[0].agent, 'wa-edge', 'body 의 agent 가 아니라 저장 키(인증 agent)로 덮임');
  assert.ok(flat[0].reportedAt > 0 && flat[0].staleMs >= 0);
});

/* ── SSH 모드(isi status 파싱, v2.304) — 사용자 실물 샘플 2종 고정 ─────────────── */

// 샘플 A(2026-08-15 스크린샷 #2): SSD 스토리지 0(n/a)·L3 캐시 노드·VHS·효율 지표. 노드 2행 발췌.
const SAMPLE_A = `LGES-bigdata-archive-2# isi status
Cluster Name: LGES-bigdata-archive
Cluster Health:     [  OK ]
Data Reduction:     1.00 : 1
Storage Efficiency: 0.83 : 1
Cluster Storage:  HDD                 SSD Storage
Size:             2.5P (2.5P Raw)     0 (0 Raw)
VHS Size:         15.4T
Used:             55.1T (2%)          0 (n/a)
Avail:            2.5P (98%)          0 (n/a)

                  Health Ext  Throughput (bps)  HDD Storage      SSD Storage
ID |IP Address    |DASR |C/N|  In   Out  Total| Used / Size     |Used / Size
---+--------------+-----+---+-----+-----+-----+-----------------+-----------------
  1|10.94.42.184  | OK  | C |    0| 260k| 260k| 2.0T/ 107T( 2%)|      L3:  373G
  2|10.94.42.185  | OK  | C |    0|56.1k|56.1k| 2.6T/ 107T( 2%)|      L3:  373G
---+--------------+-----+---+-----+-----+-----+-----------------+-----------------
Cluster Totals:                 |    0| 2.2M| 2.2M|55.1T/ 2.5P( 2%)|   L3:  8.7T
`;

// 샘플 B(스크린샷 #1 계열): SSD 스토리지 풀 보유 + 무디스크(No Storage HDDs) 노드 혼재.
const SAMPLE_B = `Cluster Name: WA-ISI
Cluster Health:     [  OK ]
Cluster Storage:  HDD                 SSD Storage
Size:             6.1P (6.1P Raw)     282.8T (293.5T Raw)
VHS Size:         26.6T
Used:             5.0P (81%)          239.8T (85%)
Avail:            1.1P (19%)          43.0T (15%)

  1|10.94.41.202  | OK  | C |    0| 463M| 463M|(No Storage HDDs)|17.6T/20.7T( 85%)
  5|10.94.41.206  | OK  | C | 4.5M| 139k| 4.7M|87.9T/ 108T( 81%)|      L3:  1.5T
 20|10.94.41.191  | -A- | N |48.4k|78.1M|78.2M|86.8T/ 108T( 80%)|      L3:  1.5T
`;

test('parseSize/parseBps — isi 표기 단위(저장=1024·네트워크=1000)', () => {
  assert.equal(parseSize('2.5P'), Math.round(2.5 * 1024 ** 5));
  assert.equal(parseSize('373G'), Math.round(373 * 1024 ** 3));
  assert.equal(parseSize('0'), 0);
  assert.equal(parseBps('260k'), 260000);
  assert.equal(parseBps('2.2M'), 2200000);
  assert.equal(parseBps('0'), 0);
});

test('parseIsiStatus 샘플A — SSD 0(n/a)·VHS·효율·L3 노드·클러스터 L3 합계', () => {
  const p = parseIsiStatus(SAMPLE_A);
  assert.equal(p.name, 'LGES-bigdata-archive');
  assert.equal(p.health, 'OK');
  assert.equal(p.dataReduction, '1.00:1');
  assert.equal(p.storageEfficiency, '0.83:1');
  assert.equal(p.hdd.sizeBytes, Math.round(2.5 * 1024 ** 5));
  assert.equal(p.hdd.usedPct, 2);
  assert.equal(p.ssd, null, 'SSD 스토리지 0 → 풀 없음(0TB 오표시 금지)');
  assert.equal(p.vhsBytes, Math.round(15.4 * 1024 ** 4));
  assert.equal(p.l3TotalBytes, Math.round(8.7 * 1024 ** 4));
  assert.equal(p.nodes.length, 2, '노드 수 가변 — 행 수만큼');
  assert.equal(p.nodes[0].ip, '10.94.42.184');
  assert.equal(p.nodes[0].outBps, 260000);
  assert.equal(p.nodes[0].hdd.pct, 2);
  assert.equal(p.nodes[0].ssd, null);
  assert.equal(p.nodes[0].l3Bytes, Math.round(373 * 1024 ** 3), 'L3 캐시 노드 표기');
});

test('parseIsiStatus 샘플B — 무디스크 노드·SSD 풀·비정상 헬스(-A-)·N(미연결)', () => {
  const p = parseIsiStatus(SAMPLE_B);
  assert.equal(p.ssd.sizeBytes, Math.round(282.8 * 1024 ** 4));
  assert.equal(p.ssd.usedPct, 85);
  assert.equal(p.nodes.length, 3);
  assert.equal(p.nodes[0].hdd, null, '(No Storage HDDs) → HDD 없음');
  assert.equal(p.nodes[0].ssd.pct, 85);
  assert.equal(p.nodes[1].l3Bytes, Math.round(1.5 * 1024 ** 4));
  assert.equal(p.nodes[2].health, '-A-', 'DASR 플래그 원문 보존(Attention)');
  assert.equal(p.nodes[2].ext, 'N');
  const snap = normalizeIsiStatus({ id: 'st-s', type: 'isilon', name: '등록명' }, p, { version: '9.4.0.0' });
  assert.equal(snap.ok, true);
  assert.equal(snap.name, 'WA-ISI');
  assert.equal(snap.nodes.unhealthy, 1, '-A- 노드는 비정상 집계');
  assert.equal(snap.media.ssd.pct, 85);
  assert.equal(snap.capacity.totalBytes, p.hdd.sizeBytes + p.ssd.sizeBytes, '전체=HDD+SSD 합');
  assert.equal(snap.extra.collectMethod, 'ssh');
});

test('레지스트리 — collectMethod 기본 ssh·api 선택·sshPort 클램프(v2.304)', () => {
  const d = reg.saveDevice({ type: 'isilon', name: 'SSH-DEV', host: '10.40.0.5', username: 'root', password: 'x' });
  assert.equal(d.collectMethod, 'ssh', '기본 ssh(사용자 정확성 기준)');
  assert.equal(d.sshPort, 22);
  const d2 = reg.saveDevice({ id: d.id, type: 'isilon', name: 'SSH-DEV', host: '10.40.0.5', username: 'root', collectMethod: 'api', sshPort: 99999 });
  assert.equal(d2.collectMethod, 'api');
  assert.equal(d2.sshPort, 65535, '포트 상한 클램프');
});

test('parseIsiStatus — Critical Events·Cluster Job Status(v2.307, 실물 샘플): 대기 잡 17d 런타임 포함', () => {
  const TAIL = `Cluster Name: T
Critical Events:
Time            LNN  Event
--------------- ---- ------------------------------------------
08/15 09:12:33    5  One or more drives (bay(s) 7) are smartfailed

Cluster Job Status:

Running jobs:
Job                        Impact Pri Policy   Phase Run Time
-------------------------- ------ --- -------- ----- ----------
SmartPools[118838]         Low    6   LOW      1/2   12:18:39

Paused and waiting jobs:
Job                        Impact Pri Policy   Phase Run Time   State
-------------------------- ------ --- -------- ----- ---------- --------
MediaScan[87933]           Low    8   LOW      6/8   17d 8:46   Waiting
ShadowStoreProtect[118867] Low    6   LOW      1/1   0:00:00    Waiting

No failed jobs.

Recent job results:
Time            Job                          Event
--------------- ---------------------------- ------------
08/15 22:10:03  SnapshotDelete[118873]       Succeeded
08/15 21:39:53  SnapshotDelete[118872]       Succeeded
`;
  const p2 = parseIsiStatus(TAIL);
  assert.equal(p2.criticalEvents.length, 1);
  assert.deepEqual(p2.criticalEvents[0], { time: '08/15 09:12:33', lnn: 5, event: 'One or more drives (bay(s) 7) are smartfailed' });
  assert.equal(p2.jobs.running.length, 1);
  assert.deepEqual(p2.jobs.running[0], { job: 'SmartPools[118838]', impact: 'Low', pri: 6, policy: 'LOW', phase: '1/2', runTime: '12:18:39' });
  assert.equal(p2.jobs.paused.length, 2, "17d 8:46 런타임(2토큰) 행이 누락되면 1이 된다 — 회귀 방지");
  assert.deepEqual(p2.jobs.paused[0], { job: 'MediaScan[87933]', impact: 'Low', pri: 8, policy: 'LOW', phase: '6/8', runTime: '17d 8:46', state: 'Waiting' });
  assert.equal(p2.jobs.failed.length, 0, "'No failed jobs.' → 빈 배열");
  assert.equal(p2.jobs.recent.length, 2);
  assert.equal(p2.jobs.recent[0].event, 'Succeeded');
  // normalize: Critical Events 가 alerts 로 집계(SSH 모드 alerts '건너뜀' 갭 해소)
  const snap = normalizeIsiStatus({ id: 'st-t', type: 'isilon', name: 'T' }, p2, {});
  assert.equal(snap.alerts.unresolved, 1);
  assert.equal(snap.sections.alerts, 'ok');
  assert.equal(snap.extra.jobs.paused.length, 2);
});

test('parseIsiStatus — 이벤트/잡 섹션이 없는 출력(빈 배열, 기존 파싱 무영향)', () => {
  const p3 = parseIsiStatus('Cluster Name: X\nCluster Health: [ OK ]\n');
  assert.deepEqual(p3.criticalEvents, []);
  assert.deepEqual(p3.jobs, { running: [], paused: [], failed: [], recent: [] });
});

/* ── OneFS API 전 영역 수집 + DB(v2.308) ─────────────────────────────────── */

test('onefsCatalog — 사용자 영역 표(39개) 전수 등재(활성은 GET 엔드포인트 보유, 비활성은 사유 명시)', async () => {
  const { ONEFS_AREAS, enabledAreas } = await import('../src/storage/onefsCatalog.js');
  assert.equal(ONEFS_AREAS.length, 39, '사용자 표의 영역 전수(재검수 결과 39행 — Cluster~MetadataIQ)');
  for (const a of enabledAreas()) assert.ok(a.endpoints.length > 0, `${a.key}: 엔드포인트 필요`);
  for (const a of ONEFS_AREAS.filter((x) => x.enabled === false)) assert.ok(a.reason, `${a.key}: 비활성 사유 필수(은폐 금지)`);
  // 전부 조회 전용 — 쿼리스트링 외에 쓰기 동사/경로가 없어야 한다(수집기가 장비를 변경 금지).
  for (const a of enabledAreas()) for (const ep of a.endpoints) assert.ok(ep.startsWith('/platform/'), ep);
});

test('storage/db — 원문 저장(절단 포함)·요약·시계열·미지원 환경 no-op 안전', async () => {
  const db = await import('../src/storage/db.js');
  if (!(await db.dbAvailable())) { assert.deepEqual(await db.areaSummary('x'), [], 'DB 미지원 환경 — no-op 폴백'); return; }
  const big = { data: 'x'.repeat(600 * 1024) }; // 512KB 초과 → 절단 표기
  await db.saveAreaResults('dev-1', [
    { area: 'cluster', endpoint: '/platform/1/cluster/config', ok: true, data: { name: 'c1' } },
    { area: 'quota', endpoint: '/platform/1/quota/quotas', ok: false, error: 'HTTP 404' },
    { area: 'snapshot', endpoint: '/platform/1/snapshot/snapshots', ok: true, data: big },
  ]);
  const rows = await db.areaSummary('dev-1');
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.area === 'quota').ok, 0);
  assert.equal(rows.find((r) => r.area === 'snapshot').truncated, 1, '512KB 초과 원문은 절단 플래그');
  const one = await db.areaJson('dev-1', '/platform/1/cluster/config');
  assert.ok(one.json.includes('"name":"c1"'), '원문 JSON 저장');
  // 용량 시계열 — 성공 스냅샷만 적재
  await db.saveCapacityPoint({ deviceId: 'dev-1', ok: true, collectedAt: Date.now(), capacity: { totalBytes: 100, usedBytes: 40 }, media: { hdd: { totalBytes: 80, usedBytes: 30 }, ssd: { totalBytes: 20, usedBytes: 10 } } });
  await db.saveCapacityPoint({ deviceId: 'dev-1', ok: false }); // 실패는 미적재(그래프 오염 방지)
  const pts = await db.capacityHistory('dev-1', Date.now() - 60_000);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].hdd_total, 80);
});

/* ─── v2.309: PowerStore / Unity 정규화(순수 — 실장비 검증 전이므로 픽스처로 계약 고정) ─── */

test('normalizePowerstore: 클러스터/용량/노드/계정/알람 정규화 + 어플라이언스는 extra 로만', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const dev = { id: 'ps-1', type: 'powerstore', name: 'PS-500T', host: '10.0.0.9' };
  const snap = normalizePowerstore(dev, {
    cluster: [{ name: 'PS-Cluster', global_id: 'PS4XXXX', state: 'Configured' }],
    sw: [{ release_version: '3.6.1.0' }],
    appliances: [{ id: 'A1', name: 'appliance-1', model: 'PowerStore 500T', service_tag: 'ABC1234' }],
    metrics: [{ physical_total: 100e12, physical_used: 42e12 }],
    nodes: [{ id: 'N1', slot: 0 }, { id: 'N2', slot: 1 }],
    users: [{ id: 'u1', name: 'admin', is_locked: false }, { id: 'u2', name: 'svc', is_locked: true }],
    alerts: [{ id: 'al1' }, { id: 'al2' }, { id: 'al3' }],
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.name, 'PS-Cluster');
  assert.equal(snap.serial, 'PS4XXXX');
  assert.equal(snap.version, '3.6.1.0');
  assert.equal(snap.capacity.totalBytes, 100e12);
  assert.equal(snap.capacity.pct, 42);
  assert.equal(snap.nodes.count, 2);
  assert.equal(snap.accounts.length, 2);
  assert.equal(snap.accounts[1].enabled, false); // is_locked → 비활성 표기
  assert.equal(snap.alerts.unresolved, 3);
  assert.equal(snap.pools.length, 0);            // 용량 0 오표시 방지 — pools 로 넣지 않음
  assert.equal(snap.extra.appliances[0].model, 'PowerStore 500T');
  assert.equal(snap.sections.capacity, 'ok');
});

test('normalizePowerstore: 전 섹션 부재면 ok=false(부분 실패 은폐 금지)', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const snap = normalizePowerstore({ id: 'ps-2', type: 'powerstore', name: 'x' }, {});
  assert.equal(snap.ok, false);
  assert.ok(snap.error);
});

test('normalizeUnity: entries 포장 해제 + 풀/SP 헬스/용량 정규화', async () => {
  const { normalizeUnity } = await import('../src/storage/collectors/unity.js');
  const wrap = (list) => ({ entries: list.map((content) => ({ content })) });
  const dev = { id: 'un-1', type: 'unity480', name: 'Unity-480', host: '10.0.0.8' };
  const snap = normalizeUnity(dev, {
    system: wrap([{ name: 'UN480-A', model: 'Unity 480', serialNumber: 'FNM0012345' }]),
    sw: wrap([{ version: '5.3.0.0.5.120' }]),
    cap: wrap([{ sizeTotal: 200e12, sizeUsed: 150e12, sizeFree: 50e12 }]),
    pools: wrap([{ name: 'Pool-1', sizeTotal: 120e12, sizeUsed: 90e12 }, { name: 'Pool-2', sizeTotal: 80e12, sizeUsed: 60e12 }]),
    sps: wrap([{ name: 'SP A', health: { value: 5 } }, { name: 'SP B', health: { value: 20 } }]),
    users: wrap([{ name: 'admin' }]),
    alerts: wrap([{ id: 'a1' }]),
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.serial, 'FNM0012345');
  assert.equal(snap.version, '5.3.0.0.5.120');
  assert.equal(snap.capacity.pct, 75);
  assert.equal(snap.pools.length, 2);
  assert.equal(snap.pools[0].pct, 75);
  assert.equal(snap.nodes.count, 2);
  assert.equal(snap.nodes.unhealthy, 1);          // health.value 20 → 비정상 집계
  assert.equal(snap.nodes.list[1].health, 'health:20'); // 모르는 값은 그대로 노출(정직 표기)
  assert.equal(snap.alerts.unresolved, 1);
});

test('normalizeUnity: 빈 응답이면 ok=false, extra.model 없음', async () => {
  const { normalizeUnity } = await import('../src/storage/collectors/unity.js');
  const snap = normalizeUnity({ id: 'un-2', type: 'unity480', name: 'x' }, {});
  assert.equal(snap.ok, false);
});

test('types: powerstore/unity480(v2.309)·xtremio/vmax/powermax(v2.310) 구현 플립 — 등록 가능', async () => {
  const { isImplementedType } = await import('../src/storage/types.js');
  for (const t of ['powerstore', 'unity480', 'xtremio', 'vmax', 'powermax']) assert.equal(isImplementedType(t), true, t);
  assert.equal(isImplementedType('vplex'), false); // 나머지는 여전히 예정
});

/* ─── v2.310: XtremIO / VMAX·PowerMax 정규화(순수 — 실장비 검증 전이므로 픽스처로 계약 고정) ─── */

test('normalizeXtremio: KB→바이트 환산·전체 플래시 media.ssd·다중 클러스터 합산·컨트롤러 헬스', async () => {
  const { normalizeXtremio } = await import('../src/storage/collectors/xtremio.js');
  const dev = { id: 'xt-1', type: 'xtremio', name: 'XMS-KR', host: '10.0.0.7' };
  const snap = normalizeXtremio(dev, {
    clusters: [
      { name: 'XIO-C1', 'sys-psnt-part-number': 'XIO00161700123', 'sys-sw-version': '6.3.0-22',
        'sys-health-state': 'healthy', 'data-reduction-ratio': 3.1, 'num-of-bricks': 2,
        'ud-ssd-space': 100e9, 'ud-ssd-space-in-use': 40e9 },          // KB 단위(×1024 환산 검증)
      { name: 'XIO-C2', 'ud-ssd-space': 50e9, 'ud-ssd-space-in-use': 10e9 },
    ],
    controllers: [
      { name: 'X1-SC1', 'health-state': 'healthy', 'mgmt-addr': '10.0.0.11' },
      { name: 'X1-SC2', 'health-state': 'failed', 'mgmt-addr': '10.0.0.12' },
    ],
    users: [{ name: 'admin', role: 'admin' }],
    alertCount: 4,
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.name, 'XIO-C1 외 1');                       // 다중 클러스터 표기
  assert.equal(snap.version, '6.3.0-22');
  assert.equal(snap.capacity.totalBytes, 150e9 * 1024);          // KB 합산 → 바이트
  assert.equal(snap.capacity.usedBytes, 50e9 * 1024);
  assert.equal(snap.media.hdd, null);                            // 전체 플래시 — HDD 풀 없음
  assert.equal(snap.media.ssd.totalBytes, 150e9 * 1024);
  assert.equal(snap.pools.length, 2);
  assert.equal(snap.pools[0].pct, 40);
  assert.equal(snap.nodes.count, 2);
  assert.equal(snap.nodes.unhealthy, 1);                         // failed 컨트롤러 집계
  assert.equal(snap.nodes.list[1].health, 'failed');             // 모르는 상태 그대로(정직 표기)
  assert.equal(snap.alerts.unresolved, 4);
  assert.equal(snap.extra.numBricks, 2);
});

test('normalizeXtremio: 빈 응답이면 ok=false', async () => {
  const { normalizeXtremio } = await import('../src/storage/collectors/xtremio.js');
  assert.equal(normalizeXtremio({ id: 'xt-2', type: 'xtremio', name: 'x' }, {}).ok, false);
});

test('normalizePowermax: TB→바이트 환산·다중 어레이 합산·용량 없는 어레이는 pools 제외', async () => {
  const { normalizePowermax } = await import('../src/storage/collectors/powermax.js');
  const dev = { id: 'pm-1', type: 'powermax', name: 'UNI-KR', host: '10.0.0.6' };
  const snap = normalizePowermax(dev, {
    version: { version: 'V9.2.1.6' },
    arrays: [
      { symmetrixId: '000297600123', model: 'PowerMax_2000', ucode: '5978.711.711', local: true },
      { symmetrixId: '000297600456', model: 'VMAX250F', local: true },
      { symmetrixId: '000297600789', model: 'PowerMax_8000', local: true }, // caps 없음 → pools 제외
    ],
    caps: {
      '000297600123': { usable_total_tb: 100, usable_used_tb: 60 },
      '000297600456': { usable_total_tb: 50, usable_used_tb: 20 },
    },
    alertCount: 7,
  });
  assert.equal(snap.ok, true);
  assert.equal(snap.version, '9.2.1.6');                         // 선행 V 제거
  assert.equal(snap.name, '000297600123 외 2');
  assert.equal(snap.serial, '000297600123');
  assert.equal(snap.extra.model, 'PowerMax_2000');
  assert.equal(snap.capacity.totalBytes, 150e12);                // TB(1e12) 합산
  assert.equal(snap.capacity.usedBytes, 80e12);
  assert.equal(snap.pools.length, 2);                            // 용량 미확인 어레이는 0 오표시 대신 제외
  assert.equal(snap.pools[0].pct, 60);
  assert.equal(snap.alerts.unresolved, 7);
  assert.equal(snap.sections.accounts, 'skip');                  // 이번 범위 밖 — 정직 표기
});

test('normalizePowermax: 어레이 없음이면 ok=false', async () => {
  const { normalizePowermax } = await import('../src/storage/collectors/powermax.js');
  assert.equal(normalizePowermax({ id: 'pm-2', type: 'vmax', name: 'x' }, { caps: {} }).ok, false);
});

/* ─── v2.310 검증 반영: tryAny 계약(401 즉시 중단 = 장비 계정 잠금 예방 안전 불변조건) ─── */

test('tryAny: 401 즉시 재전파(후속 후보 미시도)·전 후보 실패 시 마지막 오류·폴백 성공 반환', async () => {
  const { tryAny } = await import('../src/storage/collectors/restCommon.js');
  // ① 401 이면 다음 후보를 시도하지 않고 즉시 던진다 — 잘못된 자격증명으로 후보 수만큼
  //    연속 401 을 유발해 장비 계정이 잠기는 사고를 막는 규칙(restCommon.js 머리말).
  let calls = 0;
  await assert.rejects(
    () => tryAny(async () => { calls++; throw new Error('인증 실패(401) — 계정/비밀번호 확인'); }, ['/a', '/b', '/c']),
    /401/,
  );
  assert.equal(calls, 1, '401 후 후속 후보를 시도하지 않는다');
  // ② 전 후보가 비-401 실패면 마지막 오류를 던진다.
  await assert.rejects(
    () => tryAny(async (p) => { throw new Error(`HTTP 404 (${p})`); }, ['/v3', '/v2']),
    /HTTP 404 \(\/v2\)/,
  );
  // ③ 첫 후보 실패 → 둘째 성공이면 성공값 반환(버전차 폴백의 본래 목적).
  const r = await tryAny(async (p) => { if (p === '/v3') throw new Error('HTTP 404'); return { ok: p }; }, ['/v3', '/v2']);
  assert.deepEqual(r, { ok: '/v2' });
});

/* ─── v2.310 검증 반영: putSnapshot 회귀(v2.308) 재발 방지 — 수집 결과가 스토어에 저장된다 ─── */

test('collectDeviceNow(mock): 수집 스냅샷이 localSnapshots 에 저장된다(UI/push 경로 회귀 방지)', async () => {
  // mock 판별은 config.dataSource(env DATA_SOURCE) — 이 테스트 프로세스는 DATA_SOURCE 미설정이라
  // 기본 'mock'(EDGE_ALL 아님)으로 동작한다. 명시해 두면 환경 변화에도 안전.
  process.env.DATA_SOURCE = process.env.DATA_SOURCE || 'mock';
  const { collectDeviceNow } = await import('../src/storage/poller.js');
  const { localSnapshots } = await import('../src/storage/store.js');
  const d = reg.saveDevice({ type: 'isilon', name: 'MOCK-ISI', host: '10.99.0.10', username: 'root', password: 'x' });
  try {
    await collectDeviceNow(d.id);
    const snap = localSnapshots().find((x) => x.deviceId === d.id);
    assert.ok(snap, 'v2.308 회귀: putSnapshot 이 collectOne 정규 경로에서 빠지면 여기서 실패한다');
    assert.equal(snap.ok, true);
  } finally { reg.deleteDevice(d.id); }
});
