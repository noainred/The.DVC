import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partsOfInv, partBuckets, serversWithPart, isPartCat, PART_CATS } from '../src/idrac/partsInventory.js';

// 대표 인벤토리 픽스처 — 필드 누락(세대/라이선스 차이)과 합성 NIC 항목 포함.
const INV_A = {
  system: { model: 'PowerEdge R750', serviceTag: 'AAA111' },
  cpus: [
    { socket: 'CPU.Socket.1', model: 'Intel(R) Xeon(R) Gold 6346', cores: 16, maxSpeedMHz: 3100 },
    { socket: 'CPU.Socket.2', model: 'Intel(R) Xeon(R) Gold 6346', cores: 16, maxSpeedMHz: 3100 },
  ],
  gpus: [{ name: 'GPU.1', model: 'NVIDIA A40', manufacturer: 'NVIDIA' }],
  memoryDimms: [
    { locator: 'A1', sizeGB: 32, type: 'DDR4', speedMHz: 3200, manufacturer: 'SK Hynix', partNumber: 'HMA84GR7' },
    { locator: 'A2', sizeGB: 32, type: 'DDR4', speedMHz: 3200, manufacturer: 'SK Hynix', partNumber: 'HMA84GR7' },
  ],
  disks: [
    { model: 'MZWLJ1T9HBJR', capacityGB: 1920, media: 'SSD', protocol: 'NVMe' },
    { model: 'MZWLJ1T9HBJR', capacityGB: 1920, media: 'SSD', protocol: 'NVMe' },
  ],
  storageControllers: [{ name: 'PERC H755', model: 'PERC H755 Front', protocols: 'SAS/SATA' }],
  nics: [
    { name: 'NIC.1', model: 'Broadcom BCM57414', ports: [{ id: '1' }, { id: '2' }] },
    { name: 'EthernetInterfaces', model: '(EthernetInterfaces)', ports: [{ id: 'x' }] }, // 합성 폴백 — 실물 아님
  ],
  psus: [{ model: 'PWR SPLY,1400W', manufacturer: 'DELL', capacityWatts: 1400 }, { model: 'PWR SPLY,1400W', capacityWatts: 1400 }],
  pcie: [{ name: 'SLOT4', model: 'BOSS-S2', manufacturer: 'DELL', deviceType: 'SingleFunction' }, { name: '', model: '' }], // 빈 항목은 제외
  fans: [{ name: 'Fan 1A', model: '', partNumber: 'FAN-XYZ' }, { name: 'Fan 1B', model: '', partNumber: 'FAN-XYZ' }],
};
// 구형/엣지 콤팩트(개별 CPU 미수집) — cpu 요약 폴백 검증.
const INV_B = { system: { model: 'PowerEdge R740' }, cpu: { model: 'Intel Gold 6246R', count: 2 }, disks: [{ model: 'ST2000NX', capacityGB: 2000, media: 'HDD' }] };

const SERVERS = [
  { id: 'a', name: 'srv-a', host: 'https://10.0.0.1', vcenterId: 'vc1' },
  { id: 'b', name: 'srv-b', host: '10.0.0.2', vcenterId: 'vc2', remote: true },
  { id: 'c', name: 'srv-c(미수집)' },
];
const invFor = (s) => (s.id === 'a' ? INV_A : s.id === 'b' ? INV_B : null);

test('partsOfInv: 카테고리별 유닛 펼침 — 합성 NIC 제외·빈 PCIe 제외·CPU 요약 폴백', () => {
  assert.equal(partsOfInv(INV_A, 'nic').length, 1, '(EthernetInterfaces) 합성 항목 제외');
  assert.equal(partsOfInv(INV_A, 'pcie').length, 1, '모델/이름 둘 다 빈 PCIe 항목 제외');
  assert.equal(partsOfInv(INV_A, 'cpu').length, 2);
  const bCpu = partsOfInv(INV_B, 'cpu');
  assert.equal(bCpu.length, 2, 'cpus 미수집 시 cpu.model×count 폴백');
  assert.equal(bCpu[0].label, 'Intel Gold 6246R');
  assert.equal(partsOfInv(null).length, 0);
  // 전 카테고리 모드는 cat 필드를 부여한다.
  const all = partsOfInv(INV_A);
  assert.ok(all.every((u) => isPartCat(u.cat)));
});

test('partBuckets: 라벨 버킷 수량·서버 수·미수집 보고·검색 필터', () => {
  const r = partBuckets(SERVERS, invFor, {});
  assert.equal(r.collected, 2);
  assert.equal(r.total, 3);
  assert.deepEqual(r.missing, [{ id: 'c', name: 'srv-c(미수집)' }], '미수집 서버를 조용히 숨기지 않음');
  const dimm = r.buckets.find((b) => b.cat === 'dimm');
  assert.equal(dimm.label, 'SK Hynix 32GB DDR4 3200MHz');
  assert.equal(dimm.count, 2);
  assert.equal(dimm.serverCount, 1);
  const disk1920 = r.buckets.find((b) => b.cat === 'disk' && b.label.includes('1920GB'));
  assert.equal(disk1920.count, 2);
  // 검색: 두 서버에 걸친 필터
  const q = partBuckets(SERVERS, invFor, { q: 'hdd' });
  assert.equal(q.buckets.length, 1);
  assert.equal(q.buckets[0].label, 'ST2000NX 2000GB HDD');
  // 카테고리 한정
  const onlyPsu = partBuckets(SERVERS, invFor, { cat: 'psu' });
  assert.ok(onlyPsu.buckets.every((b) => b.cat === 'psu'));
  assert.equal(onlyPsu.buckets.reduce((a, b) => a + b.count, 0), 2);
});

test('serversWithPart: 드릴다운 — 서버당 수량, 잘못된 key 는 null', () => {
  const key = `cpu|Intel(R) Xeon(R) Gold 6346`;
  const list = serversWithPart(SERVERS, invFor, key);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'a');
  assert.equal(list[0].count, 2, '한 서버에 2소켓');
  assert.equal(list[0].host, '10.0.0.1', 'https:// 접두 제거');
  assert.equal(serversWithPart(SERVERS, invFor, 'nope|x'), null, '알 수 없는 카테고리');
  assert.equal(serversWithPart(SERVERS, invFor, 'cpu'), null, '라벨 없는 key');
  // 라벨에 | 가 들어가도 복원된다(라벨 = split 후 재결합).
  const fan = serversWithPart(SERVERS, invFor, 'fan|FAN-XYZ');
  assert.equal(fan[0].count, 2);
});

test('PART_CATS: 카테고리 정의 무결성(중복 없음·이름 보유)', () => {
  const keys = PART_CATS.map((c) => c.cat);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(PART_CATS.every((c) => c.name && typeof c.units === 'function'));
});
