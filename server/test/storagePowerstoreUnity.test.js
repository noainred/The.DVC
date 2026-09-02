/**
 * v2.404 회귀 테스트 — PowerStore 물리 사용량/전량 수집 + Unity 라벨 + 연결 테스트 루틴.
 *
 * 고정하는 것:
 *  1) pickLatestSpacePoint: PowerStore 공간/성능 응답은 '한 점'이 아니라 시계열 배열이고
 *     정렬 방향이 경로마다 다르다. 예전 코드는 [0] 만 봐서 POST metrics/generate 응답(오래된
 *     것부터)에서 빈 점을 집어 용량이 '—' 로 남았다(사용자 신고: 접속은 되는데 사용량 없음).
 *  2) normalizePowerstore 가 물리 사용량 + 인벤토리/성능 요약을 채우는지, 그리고 요약이
 *     '원본 객체'가 아니라 개수·합계인지(스냅샷은 중앙으로 push 되므로 크기가 계약이다).
 *  3) Unity 카탈로그 라벨은 'Unity'(모델번호 제거)이되 type 키는 'unity480' 유지 —
 *     키를 바꾸면 이미 등록된 장비가 '알 수 없는 타입'이 되어 수집이 멈춘다.
 *  4) testDeviceConnection 이 스냅샷을 저장하지 않고(putSnapshot 미호출) 결과만 돌려주는지.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-unity-'));

// ─── 1) 시계열 점 선택 ─────────────────────────────────────────────────────────────
test('pickLatestSpacePoint: 오름차순 응답에서 최신 점을 고른다(예전 [0] 버그 고정)', async () => {
  const { pickLatestSpacePoint } = await import('../src/storage/collectors/powerstore.js');
  const asc = [
    { timestamp: '2026-09-01T00:00:00Z', physical_total: 100e12, physical_used: 10e12 },
    { timestamp: '2026-09-02T00:00:00Z', physical_total: 100e12, physical_used: 42e12 },
  ];
  assert.equal(pickLatestSpacePoint(asc).physical_used, 42e12);
  // 내림차순(구버전 GET order=timestamp.desc)도 같은 점을 골라야 한다.
  assert.equal(pickLatestSpacePoint([...asc].reverse()).physical_used, 42e12);
});

test('pickLatestSpacePoint: 물리 총량이 빈 최신 점은 건너뛰고 값이 있는 점을 쓴다', async () => {
  const { pickLatestSpacePoint } = await import('../src/storage/collectors/powerstore.js');
  const pts = [
    { timestamp: '2026-09-01T00:00:00Z', physical_total: 100e12, physical_used: 42e12 },
    { timestamp: '2026-09-02T00:00:00Z', physical_total: 0, physical_used: 0 }, // 아직 집계 전
  ];
  assert.equal(pickLatestSpacePoint(pts).physical_used, 42e12);
});

test('pickLatestSpacePoint: 빈 입력은 null(0 으로 위장하지 않는다)', async () => {
  const { pickLatestSpacePoint } = await import('../src/storage/collectors/powerstore.js');
  assert.equal(pickLatestSpacePoint([]), null);
  assert.equal(pickLatestSpacePoint(null), null);
});

// ─── 2) 정규화: 물리 사용량 + 인벤토리/성능 요약 ────────────────────────────────────
test('normalizePowerstore: 물리 사용량 상세(extra.space)와 어플라이언스별 풀을 채운다', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const snap = normalizePowerstore({ id: 'ps-1', type: 'powerstore', name: 'PS' }, {
    cluster: [{ name: 'PS-Cluster', global_id: 'PS4XXXX' }],
    metrics: [
      { timestamp: '2026-09-01T00:00:00Z', physical_total: 100e12, physical_used: 10e12 },
      { timestamp: '2026-09-02T00:00:00Z', physical_total: 100e12, physical_used: 42e12, logical_used: 130e12, data_reduction: 3.1 },
    ],
    appliancePools: [{ name: 'appliance-1', totalBytes: 100e12, usedBytes: 42e12, pct: 42 }],
  });
  assert.equal(snap.capacity.usedBytes, 42e12);
  assert.equal(snap.capacity.pct, 42);
  assert.equal(snap.sections.capacity, 'ok');
  assert.equal(snap.extra.space.physicalUsed, 42e12);
  assert.equal(snap.extra.space.logicalUsed, 130e12);
  assert.equal(snap.extra.space.dataReduction, 3.1);
  // 어플라이언스별 물리 사용량은 풀로 — 어디가 찼는지 봐야 하므로.
  assert.equal(snap.pools.length, 1);
  assert.equal(snap.pools[0].usedBytes, 42e12);
});

test('normalizePowerstore: 인벤토리는 원본이 아니라 개수·합계 요약으로만 싣는다', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const volumes = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, size: 1e12, state: i ? 'Ready' : 'Offline' }));
  const snap = normalizePowerstore({ id: 'ps-1', type: 'powerstore', name: 'PS' }, {
    cluster: [{ name: 'C' }],
    volumes,
    hosts: [{ id: 'h1' }, { id: 'h2' }],
    fileSystems: [{ id: 'f1', size_total: 10e12, size_used: 4e12 }],
    replication: [{ id: 'r1', state: 'OK' }, { id: 'r2', state: 'Paused' }],
    hardware: [{ id: 'd1', type: 'Drive', lifecycle_state: 'Healthy' }, { id: 'd2', type: 'Drive', lifecycle_state: 'Failed' }],
    alerts: [{ id: 'a1', severity: 'Critical' }, { id: 'a2', severity: 'Minor' }],
  });
  const inv = snap.extra.inventory;
  assert.equal(inv.volumes.count, 5);
  assert.equal(inv.volumes.provisionedBytes, 5e12);
  assert.equal(inv.volumes.byState.Offline, 1);
  assert.equal(inv.hosts.count, 2);
  assert.equal(inv.fileSystems.usedBytes, 4e12);
  assert.equal(inv.replicationSessions.byState.Paused, 1);
  assert.equal(inv.hardware.unhealthy, 1);
  assert.equal(snap.extra.alertsBySeverity.Critical, 1);
  // 요약만 — 원본 배열을 그대로 싣지 않는다(중앙 push 크기 계약).
  assert.equal(JSON.stringify(snap.extra).includes('"v0"'), false);
  assert.equal(snap.sections.inventory, 'ok');
});

test('normalizePowerstore: 성능 요약(extra.perf)은 값이 있는 항목만 채운다', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const snap = normalizePowerstore({ id: 'ps-1', type: 'powerstore', name: 'PS' }, {
    cluster: [{ name: 'C' }],
    perf: [{ timestamp: '2026-09-02T00:00:00Z', total_iops: 12345, read_iops: 10000, write_iops: 2345, avg_latency: 850 }],
  });
  assert.equal(snap.extra.perf.totalIops, 12345);
  assert.equal(snap.extra.perf.latencyUs, 850);
  assert.equal(snap.extra.perf.totalBandwidth, null); // 없는 값은 0 이 아니라 null(위장 금지)
  assert.equal(snap.sections.performance, 'ok');
});

// ─── 3) Unity 카탈로그 라벨/키 ─────────────────────────────────────────────────────
test("카탈로그: Unity 라벨은 'Unity', type 키는 'unity480' 유지(기존 등록 장비 호환)", async () => {
  const { STORAGE_TYPES, TYPE_LABEL, isImplementedType } = await import('../src/storage/types.js');
  const unity = STORAGE_TYPES.find((t) => t.type === 'unity480');
  assert.ok(unity, "type 키 'unity480' 이 사라지면 기존 등록 장비가 '알 수 없는 타입'이 된다.");
  assert.equal(unity.label, 'Unity');
  assert.equal(TYPE_LABEL.unity480, 'Unity');
  assert.equal(isImplementedType('unity480'), true);
  assert.equal(STORAGE_TYPES.some((t) => /Unity\s*480/.test(t.label)), false);
});

// ─── 4) 연결 테스트 루틴 ───────────────────────────────────────────────────────────
test('testDeviceConnection: 미구현 타입은 저장 없이 사유를 돌려준다', async () => {
  const { testDeviceConnection } = await import('../src/storage/poller.js');
  const r = await testDeviceConnection({ id: '__test__', type: 'nope', name: 'x', host: '10.0.0.1', username: 'u', password: 'p' });
  assert.equal(r.ok, false);
  assert.match(r.error, /수집기 미구현/);
});

test('testDeviceConnection: 실패해도 스냅샷을 저장하지 않는다(스토어 오염 금지)', async () => {
  const { testDeviceConnection } = await import('../src/storage/poller.js');
  const { localSnapshots } = await import('../src/storage/store.js');
  const before = localSnapshots().length;
  // 라우팅 불가 주소 → 수집기가 실패한다. 테스트는 결과만 돌려주고 스토어를 건드리면 안 된다.
  const r = await testDeviceConnection(
    { id: '__test__', type: 'powerstore', name: 'x', host: '192.0.2.1', username: 'u', password: 'p' },
    { timeoutMs: 3_000 },
  );
  assert.equal(r.ok, false);
  assert.ok(r.ms >= 0);
  assert.equal(localSnapshots().length, before, '테스트 결과가 스토어에 들어가면 등록 전 장비가 목록에 뜬다.');
});

test('testDeviceConnection: 상한 타임아웃이 걸린다(요청이 매달리지 않게)', async () => {
  const { testDeviceConnection } = await import('../src/storage/poller.js');
  const started = Date.now();
  const r = await testDeviceConnection(
    { id: '__test__', type: 'unity480', name: 'x', host: '192.0.2.2', username: 'u', password: 'p' },
    { timeoutMs: 1_000 },
  );
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 30_000, '상한 타임아웃이 동작해야 한다.');
});

// ─── 5) 타입별 수집 방식 카탈로그(v2.405) ───────────────────────────────────────────
test('COLLECT_METHODS: 모든 구현 타입이 수집 방식 목록을 갖는다(폼이 빈 메뉴를 그리지 않게)', async () => {
  const { STORAGE_TYPES, collectMethodsFor } = await import('../src/storage/types.js');
  for (const t of STORAGE_TYPES.filter((x) => x.implemented)) {
    const list = collectMethodsFor(t.type);
    assert.ok(Array.isArray(list) && list.length >= 1, `${t.type}: 수집 방식 목록이 비었습니다.`);
    for (const m of list) {
      assert.ok(m.value && m.label, `${t.type}: value/label 이 필요합니다(메뉴 표시용).`);
    }
  }
});

test('isilon 은 ssh 가 기본(과거 저장분 호환) · 그 외 구현 타입은 api 기본', async () => {
  const { defaultCollectMethod, STORAGE_TYPES } = await import('../src/storage/types.js');
  assert.equal(defaultCollectMethod('isilon'), 'ssh');
  for (const t of STORAGE_TYPES.filter((x) => x.implemented && x.type !== 'isilon')) {
    assert.equal(defaultCollectMethod(t.type), 'api', t.type);
  }
});

test('normalizeCollectMethod: 허용되지 않는 값은 기본값으로 보정(유령 값 저장 방지)', async () => {
  const { normalizeCollectMethod } = await import('../src/storage/types.js');
  assert.equal(normalizeCollectMethod('isilon', 'api'), 'api');
  assert.equal(normalizeCollectMethod('isilon', ''), 'ssh');
  assert.equal(normalizeCollectMethod('powerstore', 'ssh'), 'ssh'); // v2.405: pstcli 수집기 추가
  // PowerMax/VMAX 는 symcli 가 별도 SYMAPI 호스트를 요구해 장비 SSH 로는 불가 — api 로 보정.
  assert.equal(normalizeCollectMethod('powermax', 'ssh'), 'api');
  assert.equal(normalizeCollectMethod('vmax', 'ssh'), 'api');
});

test('수집 방식 목록의 모든 value 는 실제 수집기가 있는 것만(유령 선택지 금지)', async () => {
  const { STORAGE_TYPES, collectMethodsFor } = await import('../src/storage/types.js');
  // 'ssh' 를 목록에 올린 타입은 그 타입 파일이 실제로 ssh 분기를 갖고 있어야 한다.
  // (목록에만 올리면 사용자가 고를 수 있는데 수집은 안 되는 유령 선택지가 된다.)
  const fs = await import('node:fs');
  const url = await import('node:url');
  const pathMod = await import('node:path');
  const dir = pathMod.join(pathMod.dirname(url.fileURLToPath(import.meta.url)), '..', 'src', 'storage', 'collectors');
  const file = { isilon: 'isilon.js', powerstore: 'powerstore.js', unity480: 'unity.js', xtremio: 'xtremio.js', vplex: 'vplex.js', metronode: 'vplex.js', vmax: 'powermax.js', powermax: 'powermax.js' };
  for (const t of STORAGE_TYPES.filter((x) => x.implemented)) {
    const values = collectMethodsFor(t.type).map((m) => m.value);
    assert.ok(values.includes('api') || values.includes('ssh'), t.type);
    if (values.includes('ssh')) {
      const src = fs.readFileSync(pathMod.join(dir, file[t.type]), 'utf8');
      // isilon 은 `!== 'api'`(ssh 가 기본), 나머지는 `=== 'ssh'` 로 분기한다 — 둘 다 허용.
      assert.match(src, /collectMethod (?:===\s*'ssh'|!==\s*'api')/, `${t.type}: 카탈로그에 ssh 가 있는데 수집기에 ssh 분기가 없습니다.`);
    }
  }
});

test('SSH CLI 수집기 4종이 정규화 함수를 내보낸다(테스트 가능 계약)', async () => {
  for (const [mod, fn] of [
    ['powerstoreSsh.js', 'normalizePowerstoreSsh'], ['unitySsh.js', 'normalizeUnitySsh'],
    ['xtremioSsh.js', 'normalizeXtremioSsh'], ['vplexSsh.js', 'normalizeVplexSsh'],
  ]) {
    const m = await import(`../src/storage/collectors/${mod}`);
    assert.equal(typeof m[fn], 'function', `${mod}: ${fn} 이 없습니다.`);
    assert.equal(typeof m.collectViaSsh, 'function', `${mod}: collectViaSsh 가 없습니다.`);
  }
});

test('saveDevice: 타입에 없는 수집 방식은 저장 시 보정된다', async () => {
  const { saveDevice, listDevices } = await import('../src/storage/registry.js');
  // PowerMax 는 SSH 수집기가 없다(symcli 는 별도 SYMAPI 호스트 필요) → api 로 보정되어야 한다.
  const d = saveDevice({ type: 'powermax', name: 'pm-method', host: '10.20.0.77', username: 'admin', password: 'pw', collectMethod: 'ssh' });
  assert.equal(d.collectMethod, 'api');
  // PowerStore 는 v2.405 부터 ssh(pstcli)를 지원하므로 그대로 저장되어야 한다.
  const ps = saveDevice({ type: 'powerstore', name: 'ps-method', host: '10.20.0.79', username: 'admin', password: 'pw', collectMethod: 'ssh' });
  assert.equal(ps.collectMethod, 'ssh');
  const iso = saveDevice({ type: 'isilon', name: 'iso-method', host: '10.20.0.78', username: 'root', password: 'pw' });
  assert.equal(iso.collectMethod, 'ssh'); // 미지정이면 그 타입 기본값
  assert.ok(listDevices().length >= 2);
});

// ─── 6) mock 데이터 표식(v2.408) ────────────────────────────────────────────────────
// 사용자 신고: PowerStore 장비에 'OneFS 9.4.0(mock)' 이 찍혀 진짜 수집값처럼 보였다.
// 원인은 엣지가 DATA_SOURCE 미설정(기본 mock)으로 돌면서 가짜 스냅샷을 중앙에 push 한 것.
// 가짜임이 **데이터에** 남아야 중앙 화면이 배지·배너로 드러낼 수 있다.
test('mock 스냅샷은 extra.mock=true 로 표시된다(괄호 문자열에만 기대지 않는다)', async () => {
  const src = fs.readFileSync(new URL('../src/storage/poller.js', import.meta.url), 'utf8');
  assert.ok(!/snap\.version = 'OneFS 9\.4\.0\(mock\)'/.test(src),
    "타입과 무관한 'OneFS' 버전을 mock 에 쓰면 PowerStore 등에서 실제 수집값으로 오인된다.");
  // ⚠ 플래그는 mock 블록의 **마지막 snap.extra 재할당 안**에 있어야 한다. 앞에서 snap.extra.mock
  //   만 세우면 뒤의 `snap.extra = { ... }` 가 통째로 덮어써 플래그가 사라진다(실측으로 잡은 실수).
  const block = /config\.dataSource === 'mock'\)\s*\{([\s\S]*?)\n  \} else \{/.exec(src);
  assert.ok(block, 'mock 분기를 찾지 못했습니다.');
  const lastAssign = [...block[1].matchAll(/snap\.extra = \{([^}]*)\}/g)].pop();
  assert.ok(lastAssign, 'mock 분기에 snap.extra 할당이 있어야 합니다.');
  assert.match(lastAssign[1], /mock:\s*true/,
    'mock 분기의 마지막 snap.extra 할당에 mock:true 가 있어야 플래그가 살아남는다.');
});

test('mock 모드로 기동하면 콘솔 경고가 있다(조용한 가짜 수집 금지)', async () => {
  const src = fs.readFileSync(new URL('../src/storage/poller.js', import.meta.url), 'utf8');
  assert.match(src, /DATA_SOURCE=mock/, '기동 경고에 무엇이 문제인지 적혀 있어야 한다.');
  assert.match(src, /DATA_SOURCE=live/, '경고에 조치 방법(live 전환)이 있어야 한다.');
});

test('config: DATA_SOURCE 미설정 + EDGE_MODE≠all 이면 기본이 mock 이다(이 함정을 문서로 고정)', async () => {
  const src = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  // 기본값을 바꾸는 것은 개발 환경 영향이 커서 하지 않는다. 대신 '기본이 mock' 이라는 사실을
  // 테스트로 고정해, 누군가 이 줄을 손볼 때 위 경고/표식과 함께 다뤄야 함을 알 수 있게 한다.
  assert.match(src, /dataSource:\s*\(process\.env\.DATA_SOURCE \|\| \(EDGE_ALL \? 'live' : 'mock'\)\)/);
});
