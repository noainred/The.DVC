import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactInv } from '../src/collector/agent.js';

// 엣지 export 콤팩트 인벤토리 회귀 방지 — 과거 nics 필드가 누락돼 중앙 'NIC 속도/모델 확인'
// 화면에서 엣지 원격 서버 전부가 '정보없음'(모델 0종)으로 나왔다.

test('compactInv: nics(어댑터·포트 speedMbps)를 export에 포함한다', () => {
  const out = compactInv({
    system: { model: 'PowerEdge R750', serviceTag: 'ABC1234', biosVersion: '1.0' },
    nics: [{
      name: 'NIC.Integrated.1', model: 'Intel(R) Ethernet 10G 4P X710',
      ports: [{ id: 'NIC.Integrated.1-1', link: 'Up', speedMbps: 10000, extra: 'drop-me' }],
    }],
    collectedAt: 123,
  });
  assert.equal(out.nics.length, 1);
  assert.equal(out.nics[0].model, 'Intel(R) Ethernet 10G 4P X710');
  assert.deepEqual(out.nics[0].ports, [{ id: 'NIC.Integrated.1-1', link: 'Up', speedMbps: 10000 }]);
});

test('compactInv: nics 없으면 빈 배열(구버전 인벤토리 호환)', () => {
  const out = compactInv({ system: { model: 'R650' }, collectedAt: 1 });
  assert.deepEqual(out.nics, []);
  assert.equal(compactInv(null), null);
});

// 파트 인벤토리 탭(v2.321) — 이 필드들이 빠지면 위임(엣지) 법인 서버가 파트 탭에서 전부
// 공백이 된다(위 nics 누락과 동일한 회귀 패턴). 시리얼 등 자산 상세는 의도적으로 미포함.
test('compactInv: 파트 필드(cpus·disks·psus·dimm·controller·pcie·fans)를 최소 형태로 포함한다', () => {
  const out = compactInv({
    cpus: [{ socket: 'CPU.1', model: 'Xeon 6346', cores: 16, threads: 32, maxSpeedMHz: 3100, health: 'OK' }],
    disks: [{ model: 'MZWLJ', capacityGB: 1920, media: 'SSD', protocol: 'NVMe', serial: 'S-DROP' }],
    psus: [{ model: 'PWR 1400W', manufacturer: 'DELL', capacityWatts: 1400, serial: 'P-DROP' }],
    memoryDimms: [{ sizeGB: 32, type: 'DDR4', speedMHz: 3200, manufacturer: 'SK Hynix', partNumber: 'HMA', serial: 'M-DROP' }],
    storageControllers: [{ model: 'PERC H755', firmware: '52.x', protocols: 'SAS' }],
    pcie: [{ model: 'BOSS-S2', manufacturer: 'DELL', deviceType: 'SingleFunction', firmware: 'F-DROP' }],
    fans: [{ name: 'Fan 1A', model: '', partNumber: 'FAN-XYZ', manufacturer: 'DROP' }],
    collectedAt: 2,
  });
  // v2.728: 부품 이름·상태(health·state)·PSU 입력값·디스크 예측 실패를 싣는다 — 못 읽은 상태도 **키는 싣는다**(빈 문자열 —
  //   중앙이 '구버전 엣지(키 없음)' 와 '못 읽음' 을 가른다). 예측 실패는 미확인이면 null(false 로 굳히지 않는다).
  assert.deepEqual(out.cpus, [{ socket: 'CPU.1', model: 'Xeon 6346', cores: 16, health: 'OK', state: '' }]);
  assert.deepEqual(out.disks, [{ name: '', model: 'MZWLJ', capacityGB: 1920, media: 'SSD', protocol: 'NVMe', health: '', state: '', predictiveFailure: null }], '시리얼은 싣지 않음');
  assert.deepEqual(out.psus, [{ name: '', model: 'PWR 1400W', manufacturer: 'DELL', capacityWatts: 1400, inputWatts: null, outputWatts: null, lineInputVoltage: null, health: '', state: '' }]);
  assert.deepEqual(out.memoryDimms, [{ locator: '', sizeGB: 32, type: 'DDR4', speedMHz: 3200, manufacturer: 'SK Hynix', partNumber: 'HMA', health: '', state: '' }]);
  assert.deepEqual(out.storageControllers, [{ name: '', model: 'PERC H755', firmware: '52.x', protocols: 'SAS', health: '' }]);
  assert.deepEqual(out.pcie, [{ name: '', model: 'BOSS-S2', manufacturer: 'DELL', deviceType: 'SingleFunction', health: '' }]);
  assert.deepEqual(out.fans, [{ name: 'Fan 1A', model: '', partNumber: 'FAN-XYZ', health: '' }]);
  for (const k of ['psus', 'disks', 'memoryDimms']) for (const x of out[k]) assert.ok(!('serial' in x), `${k}: 시리얼 미포함`);
  // 구버전(필드 부재) 호환 — 전부 빈 배열.
  const old = compactInv({ system: { model: 'R640' } });
  for (const k of ['cpus', 'disks', 'psus', 'memoryDimms', 'storageControllers', 'pcie', 'fans']) assert.deepEqual(old[k], [], k);
});
