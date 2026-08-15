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

test('타입 카탈로그 — isilon 구현·로드맵 7종 예정(등록은 구현 타입만)', () => {
  assert.ok(isImplementedType('isilon'));
  for (const t of ['xtremio', 'powerstore', 'vmax', 'powermax', 'vplex', 'unity480', 'metronode']) {
    assert.ok(STORAGE_TYPES.some((x) => x.type === t && !x.implemented), `${t} 카탈로그 예정 항목`);
  }
  assert.throws(() => reg.saveDevice({ type: 'powermax', name: 'X', host: '10.0.0.1', username: 'a' }), /미구현/);
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
