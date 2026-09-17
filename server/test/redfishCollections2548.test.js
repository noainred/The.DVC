/**
 * v2.548 F1 — `fetchInventory` 의 컬렉션별 성공/실패 메타(`inv.collections`·`inv.reachable`).
 *
 * 배경(조사로 확정): fetchInventory 는 어떤 경우에도 던지지 않는다 — identity·psu·storage·memory·
 * gpu/cpu·pcie 블록이 전부 `catch {}` 라, 연결 거부 호스트에도 29ms 만에 `collectedAt` 이 신선한
 * **빈 인벤토리**를 돌려준다. 그래서 파트 장애 판정이 '부품 0개 = 정상' 으로 읽어 열린 장애를 거짓으로
 * 닫았다. 이 테스트는 그 메타가 세 상황에서 정직한지 고정한다:
 *   ① 연결 거부 → reachable=false · 7개 컬렉션 전부 'failed' · 기존 필드는 그대로 빈 배열(하위 호환)
 *   ② 응답은 받았는데 일부 컬렉션만 실패 → 그 컬렉션만 'failed'(멤버 0개인 컬렉션은 'ok' — 읽었다)
 *   ③ Systems 만 실패(sysId 없음) → `if (sysId)` 로 감싸인 블록은 **try 본문이 돌지 않아 catch 도 안 탄다**.
 *      그래도 'failed' 여야 한다(시도조차 못 한 것을 '읽었다' 고 말하면 안 된다). Chassis 가 응답했으면
 *      reachable 은 true 다.
 * 실제 네트워크는 쓰지 않는다 — ①은 루프백의 닫힌 포트(127.0.0.1:1), ②③은 테스트가 띄운 루프백 HTTP 서버다.
 * 픽스처 식별자는 전부 합성(`SYNTH…`)이다(공개 저장소 — v2.513 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { COLLECTION_KINDS } from '../src/partfault/types.js';

// `config.idrac.timeoutMs` 는 config.js 가 모듈 로드 시 `IDRAC_TIMEOUT_MS` 로 굳힌다. 정적 import 는
// 호이스팅되므로 env 를 먼저 두고 **동적 import** 한다. 연결 거부는 즉시(실측 82ms) 실패하지만,
// 방화벽이 DROP 하는 환경에서 15초 기본 시한을 6개 블록 × N 번 기다리지 않게 하는 안전망이다.
process.env.IDRAC_TIMEOUT_MS = '1500';
const { fetchInventory } = await import('../src/idrac/redfish.js');

/** fetchInventory 가 찍는 컬렉션 — COLLECTION_KINDS 에서 `fans` 만 뺀 것(fans 는 fetchSensors 경로). */
const INV_COLLECTIONS = [...Object.keys(COLLECTION_KINDS).filter((k) => k !== 'fans'), 'system'].sort();   // 'system' = Systems 멤버(sysId) 확보 여부(v2.548 C3)
/** 하위 호환 — 예전부터 있던 배열 필드. 실패해도 빈 배열이어야 한다(소비처가 `.length`·`.map` 을 그대로 쓴다). */
const ARRAY_FIELDS = ['psus', 'disks', 'storageControllers', 'memoryDimms', 'cpus', 'gpus', 'pcie', 'nics', 'events', 'licenses', 'idracUsers', 'firmware', 'network'];

/**
 * 가짜 Redfish 서버. `routes[path]` 가 객체면 200 JSON, 숫자면 그 상태코드, 없으면 404.
 * 인증은 검사하지 않는다(rawGet 의 Basic 헤더가 붙어 오지만 이 테스트의 관심사가 아니다).
 */
async function startFakeRedfish(routes) {
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const r = routes[path];
    const status = r == null ? 404 : (typeof r === 'number' ? r : 200);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? r : { error: { message: `synthetic ${status}` } }));
  });
  await new Promise((ok, ng) => { srv.on('error', ng); srv.listen(0, '127.0.0.1', ok); });
  const port = srv.address().port;
  return { host: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => srv.close(ok)) };
}

const SYS = '/redfish/v1/Systems/System.Synth.1';
const CHASSIS = '/redfish/v1/Chassis/Chassis.Synth.1';
const IDENTITY_ROUTES = {
  '/redfish/v1/Systems': { Members: [{ '@odata.id': SYS }] },
  [SYS]: { HostName: 'synth-host', Model: 'PowerEdge SYNTH', SKU: 'SYNTH0000001', UUID: '00000000-0000-4000-8000-000000000001', Status: { Health: 'OK' } },
};
const CHASSIS_ROUTES = {
  '/redfish/v1/Chassis': { Members: [{ '@odata.id': CHASSIS }] },
  [`${CHASSIS}/Power`]: { PowerSupplies: [{ Name: 'PSU 1', SerialNumber: 'SYNTHPSU1', Status: { Health: 'OK', State: 'Enabled' } }] },
};

test('① 연결 거부: reachable=false · 7개 컬렉션 전부 failed · 기존 배열 필드는 그대로 빈 배열(하위 호환)', async () => {
  const inv = await fetchInventory({ id: 'x', host: 'http://127.0.0.1:1', username: 'u', password: 'p' });
  assert.equal(inv.reachable, false);
  // 키 집합이 COLLECTION_KINDS(-fans) 와 **글자 그대로** 같다 — 소비처(extract/idrac.js)가 이 이름으로 찾는다.
  assert.deepEqual(Object.keys(inv.collections).sort(), INV_COLLECTIONS);
  assert.ok(!('fans' in inv.collections), 'fans 는 fetchInventory 의 컬렉션이 아니다 — 폴러가 Thermal 에서 옮겨 넣는다');
  for (const k of INV_COLLECTIONS) assert.equal(inv.collections[k], 'failed', k);
  // 하위 호환 — 예전 동작 그대로: 던지지 않고, 배열은 비어 있고, collectedAt 은 찍힌다.
  for (const k of ARRAY_FIELDS) assert.deepEqual(inv[k], [], k);
  assert.deepEqual(inv.system, {});
  assert.equal(typeof inv.collectedAt, 'number');
});

test('② 일부 컬렉션만 실패: 실패한 것만 failed, 멤버 0개인 컬렉션은 ok(읽었다), reachable=true', async () => {
  const fake = await startFakeRedfish({
    ...IDENTITY_ROUTES,
    ...CHASSIS_ROUTES,
    [`${SYS}/Storage`]: 500,            // 컨트롤러 GET 자체가 실패 → disks·storageControllers 둘 다 failed
    [`${SYS}/Memory`]: { Members: [] }, // 응답은 받았는데 DIMM 0개 → 'ok'(읽었다 — 0 을 실패로 접지 않는다)
    [`${SYS}/Processors`]: { Members: [{ '@odata.id': `${SYS}/Processors/CPU.Synth.1` }] },
    [`${SYS}/Processors/CPU.Synth.1`]: { ProcessorType: 'CPU', Socket: 'CPU.1', TotalCores: 8, Status: { Health: 'OK', State: 'Enabled' } },
    // PCIeDevices 는 라우트 없음 → 404(구세대 iDRAC 미지원과 같은 모양) → failed
  });
  try {
    const inv = await fetchInventory({ id: 'x', host: fake.host, username: 'u', password: 'p' });
    assert.equal(inv.reachable, true);
    assert.deepEqual(inv.collections, {
      system: 'ok', psus: 'ok', disks: 'failed', storageControllers: 'failed', memoryDimms: 'ok', cpus: 'ok', gpus: 'ok', pcie: 'failed',
    });
    // 메타가 기존 값을 바꾸지 않는다.
    assert.equal(inv.system.serviceTag, 'SYNTH0000001');
    assert.equal(inv.psus.length, 1);
    assert.deepEqual(inv.memoryDimms, [], '멤버 0개 = 빈 배열 그대로');
    assert.equal(inv.cpus.length, 1);
    assert.deepEqual(inv.gpus, []);
    assert.deepEqual(inv.disks, []);
    assert.deepEqual(inv.pcie, []);
  } finally { await fake.close(); }
});

test('③ Systems 만 실패(sysId 없음): 시도조차 못 한 컬렉션은 failed 로 남고, Chassis 가 응답했으면 reachable=true', async () => {
  const fake = await startFakeRedfish({
    '/redfish/v1/Systems': 500,
    ...CHASSIS_ROUTES,
    // Storage/Memory/Processors/PCIeDevices 라우트는 있어도 sysId 가 없어 **호출되지 않는다** — 그 경로가 이 테스트의 핵심.
    [`${SYS}/Memory`]: { Members: [] },
  });
  try {
    const inv = await fetchInventory({ id: 'x', host: fake.host, username: 'u', password: 'p' });
    assert.equal(inv.reachable, true, 'Chassis(psus) 가 응답했다 — 장비는 닿았다');
    assert.deepEqual(inv.collections, {
      system: 'failed', psus: 'ok', disks: 'failed', storageControllers: 'failed', memoryDimms: 'failed', cpus: 'failed', gpus: 'failed', pcie: 'failed',
    });
    assert.deepEqual(inv.system, {}, 'identity 는 실패 — 기존과 같이 빈 객체');
    assert.equal(inv.psus.length, 1);
  } finally { await fake.close(); }
});
