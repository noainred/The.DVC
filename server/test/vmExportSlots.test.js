import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vmExport.js 는 store/config 를 import 하므로 격리 CONFIG_DIR 지정 후 로드(기존 테스트 관례).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-export-slots-test-'));
process.env.CONFIG_DIR = TMP;

const { VM_EXPORT_COLUMNS } = await import('../src/vcenter/vmExport.js');

// v2.278 사용자 확정 템플릿 회귀 방지 — 디스크 1~7 슬롯(슬롯당 5필드) + '디스크8+ 요약'.
// 할당된 디스크만 해당 칸에, 없으면 빈칸, 8개 초과분은 요약 컬럼으로 정보 보전.
const col = (key) => VM_EXPORT_COLUMNS.find((c) => c.key === key);
const mkDisk = (n) => ({
  label: `Hard disk ${n}`, capacityGB: n * 10, thin: n % 2 === 1, rdm: n === 9,
  mode: 'persistent', datastore: `DS-${n}`, fileName: `[DS-${n}] vm/vm_${n}.vmdk`,
});
const mkD = (count) => ({ props: {}, nics: [], disks: Array.from({ length: count }, (_, i) => mkDisk(i + 1)), guest: [], enriched: true });
const vm = { name: 'slot-vm', vcenterId: 'vc' };

test('디스크 슬롯 컬럼 존재: 1~7 슬롯 × 5필드 + 8+ 요약, 병합형 "디스크 상세"는 제거됨', () => {
  for (let n = 1; n <= 7; n++) {
    for (const f of ['CapacityGB', 'Type', 'Mode', 'Datastore', 'File']) {
      assert.ok(col(`disk${n}${f}`), `disk${n}${f} 컬럼이 있어야 함`);
    }
  }
  assert.ok(col('disksOverflow'), '디스크8+ 요약 컬럼');
  assert.equal(col('disks'), undefined, '구 병합형 "디스크 상세" 컬럼은 슬롯으로 대체돼 없어야 함');
});

test('9개 디스크 VM: 슬롯 1~7 채움 + 8·9번은 요약으로(정보 손실 없음)', () => {
  const d = mkD(9);
  assert.equal(col('disk1CapacityGB').get(vm, d), 10);
  assert.equal(col('disk1Type').get(vm, d), 'thin');       // n=1 홀수 → thin
  assert.equal(col('disk2Type').get(vm, d), 'thick');      // n=2 짝수 → thick
  assert.equal(col('disk7CapacityGB').get(vm, d), 70);
  assert.equal(col('disk7Datastore').get(vm, d), 'DS-7');
  assert.equal(col('disk7File').get(vm, d), '[DS-7] vm/vm_7.vmdk');
  const overflow = col('disksOverflow').get(vm, d);
  assert.match(overflow, /Hard disk 8 80GB thick/);
  assert.match(overflow, /Hard disk 9 90GB RDM/);          // n=9 → RDM 이 thin 보다 우선 표기
  assert.match(overflow, /\[DS-8\]/);
});

test('1개 디스크 VM: 슬롯 2~7 과 요약은 전부 빈칸', () => {
  const d = mkD(1);
  assert.equal(col('disk1CapacityGB').get(vm, d), 10);
  for (let n = 2; n <= 7; n++) {
    assert.equal(col(`disk${n}CapacityGB`).get(vm, d), '');
    assert.equal(col(`disk${n}Type`).get(vm, d), '');
    assert.equal(col(`disk${n}Datastore`).get(vm, d), '');
    assert.equal(col(`disk${n}File`).get(vm, d), '');
  }
  assert.equal(col('disksOverflow').get(vm, d), '');
});

test('디스크 0개(라이브 보강 실패 등): 모든 슬롯 빈칸 — 크래시 없음', () => {
  const d = mkD(0);
  for (let n = 1; n <= 7; n++) assert.equal(col(`disk${n}CapacityGB`).get(vm, d), '');
  assert.equal(col('disksOverflow').get(vm, d), '');
});
