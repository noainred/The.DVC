// v2.703 — 코어 라이선스 산정(A13): 소켓당 최소 16코어 · 모르는 호스트는 산정 안 함 · vSAN TiB 와 전체 기준 추가 필요량 · 보고 비교.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hostCoreLicense, analyzeCoreLicense, MIN_CORES_PER_SOCKET } from '../src/corelicense/analyze.js';

test('① 호스트 산정 — 소켓 × max(16, 소켓당 코어), 소켓당 코어는 올림 · 모르면 null', () => {
  assert.equal(MIN_CORES_PER_SOCKET, 16);
  assert.deepEqual(hostCoreLicense({ cpuSockets: 2, cpuCores: 16 }), { sockets: 2, cores: 16, perSocket: 8, licensed: 32, padded: 16 });
  assert.equal(hostCoreLicense({ cpuSockets: 2, cpuCores: 64 }).licensed, 64);
  assert.equal(hostCoreLicense({ cpuSockets: 2, cpuCores: 33 }).perSocket, 17, '홀수 코어는 소켓당 올림');
  assert.equal(hostCoreLicense({ cpuSockets: 1, cpuCores: 24 }).padded, 0);
  for (const h of [{ cpuSockets: null, cpuCores: 16 }, { cpuSockets: 0, cpuCores: 16 }, { cpuSockets: 2, cpuCores: 0 }, { cpuSockets: '', cpuCores: 16 }, {}]) {
    assert.equal(hostCoreLicense(h), null, JSON.stringify(h));
  }
});

const SNAP = {
  vcenters: [
    { id: 'a', name: 'A', licenses: [{ costUnit: 'core', used: 96, total: 200 }, { costUnit: 'cpuPackage', used: 4, total: 10 }] },
    { id: 'b', name: 'B', licenses: [{ costUnit: 'core', used: 10, total: 50 }] },
    { id: 'c', name: 'C', licenses: [] },
  ],
  hosts: [
    { vcenterId: 'a', name: 'a1', cpuSockets: 2, cpuCores: 16, connectionState: 'CONNECTED' },   // 32 (+16)
    { vcenterId: 'a', name: 'a2', cpuSockets: 2, cpuCores: 64, connectionState: 'DISCONNECTED' }, // 64 · 끊김도 대상
    { vcenterId: 'b', name: 'b1', cpuSockets: null, cpuCores: 32, connectionState: 'CONNECTED' },  // 모름
    { vcenterId: 'b', name: 'b2', cpuSockets: 1, cpuCores: 8, connectionState: 'CONNECTED' },      // 16 (+8)
    { vcenterId: 'x', name: 'x1', cpuSockets: 1, cpuCores: 8 },                                    // 범위 밖 vCenter
  ],
  datastores: [
    { vcenterId: 'a', type: 'vsan', capacityGB: 102_400 },   // 100 TiB
    { vcenterId: 'b', type: 'vsan', capacityGB: null },      // 모름
    { vcenterId: 'c', type: 'VMFS', capacityGB: 1024 },
  ],
};

test('② 법인 합계 — 모르는 호스트는 빼고 세며, 부분 합이면 보고와 비교하지 않는다 · 끊긴 호스트 포함', () => {
  const r = analyzeCoreLicense(SNAP);
  const a = r.vcenters.find((v) => v.vcenterId === 'a');
  assert.equal(a.licensed, 96); assert.equal(a.padded, 16); assert.equal(a.disconnected, 1);
  assert.equal(a.reportedCoreUsed, 96); assert.equal(a.reportedDiff, 0, 'cpuPackage 라이선스는 코어 보고에 섞지 않는다');
  const b = r.vcenters.find((v) => v.vcenterId === 'b');
  assert.equal(b.unknown, 1); assert.equal(b.licensed, 16);
  assert.equal(b.reportedDiff, null, '산정 못 한 호스트가 있으면 비교하지 않는다(부분 합끼리 비교 = 거짓 차이)');
  assert.equal(b.vsanUnknown, 1);
  const c = r.vcenters.find((v) => v.vcenterId === 'c');
  assert.equal(c.reportedCoreUsed, null); assert.equal(c.vsanDs, 0, 'VMFS 는 vSAN 이 아니다');
  assert.equal(r.totals.licensed, 112); assert.equal(r.totals.unknown, 1); assert.equal(r.totals.hosts, 4, '등록 안 된 vCenter 의 호스트는 세지 않는다');
  assert.equal(r.totals.vsanTib, 100);
  assert.equal(r.totals.vsanIncludedTib, null, '가정을 고르지 않으면 포함 용량을 지어내지 않는다');
  assert.ok(r.hosts.find((h) => h.name === 'b1').unknown);
});

test('③ vSAN 추가 필요량 — 합계는 전체 기준(법인별 초과를 더하지 않는다)', () => {
  const snap = {
    vcenters: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    hosts: [{ vcenterId: 'a', name: 'a', cpuSockets: 2, cpuCores: 32 }, { vcenterId: 'b', name: 'b', cpuSockets: 4, cpuCores: 128 }],
    datastores: [{ vcenterId: 'a', type: 'vsan', capacityGB: 40 * 1024 }],
  };
  const r = analyzeCoreLicense(snap, { vsanPlan: 'vcf' });   // 코어당 1 TiB
  assert.equal(r.vcenters.find((v) => v.vcenterId === 'a').vsanAddonTib, 8, 'A 만 보면 32 TiB 포함 → 8 TiB 초과');
  assert.equal(r.totals.vsanIncludedTib, 160);
  assert.equal(r.totals.vsanAddonTib, 0, 'B 의 남는 포함 용량이 A 의 초과를 덮는다(계약 전체에서 합쳐진다)');
  assert.equal(analyzeCoreLicense(snap, { vsanPlan: 'zzz' }).rule.vsanTibPerCore, 0, '모르는 가정은 0(계산 안 함)');
});

test('④ 범위 — vcenterIds 밖은 행도 합계도 없다 · 수집 경로가 소켓 수와 costUnit 을 싣고 엣지 수신이 소켓을 수로 좁힌다', () => {
  const r = analyzeCoreLicense(SNAP, { vcenterIds: ['a'] });
  assert.deepEqual(r.vcenters.map((v) => v.vcenterId), ['a']);
  assert.equal(r.totals.licensed, 96);
  const soap = fs.readFileSync(new URL('../src/vcenter/soapClient.js', import.meta.url), 'utf8');
  assert.match(soap, /'summary\.hardware\.numCpuPkgs'/);
  assert.match(soap, /cpuSockets: Number\(p\['summary\.hardware\.numCpuPkgs'\]\) > 0/);
  assert.match(soap, /<costUnit>/);
  assert.match(fs.readFileSync(new URL('../src/routes/central.js', import.meta.url), 'utf8'), /INV_NUM_KEYS = \[[^\]]*'cpuSockets'/);
});

// v2.727(감사 C-02): used 를 보고하지 않은 코어 라이선스는 '보고 0' 이 아니다 — 합·차이는 null, 개수로 밝힌다.
test('⑤ 보고값 미상 — used null 인 코어 라이선스가 있으면 reportedCoreUsed·reportedDiff 는 null + reportedUsedUnknown', () => {
  const snap = { vcenters: [{ id: 'a', name: 'A', licenses: [{ costUnit: 'core', total: 200 }] }],   // used 없음(vim25 optional)
    hosts: [{ vcenterId: 'a', name: 'h1', cpuSockets: 2, cpuCores: 64, connectionState: 'CONNECTED' }], datastores: [] };
  const v = analyzeCoreLicense(snap).vcenters[0];
  assert.equal(v.reportedCoreUsed, null); assert.equal(v.reportedDiff, null, '예전엔 0 − 64 = −64 라는 없는 차이');
  assert.equal(v.reportedUsedUnknown, 1); assert.equal(v.reportedCoreTotal, 200);
  const z = analyzeCoreLicense({ ...snap, vcenters: [{ id: 'a', name: 'A', licenses: [{ costUnit: 'core', total: 200, used: 0 }] }] }).vcenters[0];
  assert.equal(z.reportedCoreUsed, 0, '보고된 0 은 값'); assert.equal(z.reportedDiff, -64);
});
