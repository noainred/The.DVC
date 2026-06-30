import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'netissue-'));
const { recordNetScan, getNetIssues, analyzeNetIssues } = await import('../src/security/netIssueStore.js');

const VM = { vcenterId: 'vc1', vm: 'gpu-01', os: 'linux' };

test('recordNetScan: 첫 스캔은 기준선만 잡고 이슈 없음', () => {
  const found = recordNetScan(VM, [{ iface: 'eth0', rxDrop: 100, txDrop: 0, rxErr: 0, txErr: 0, rxPkts: 10000, txPkts: 5000 }]);
  assert.equal(found.length, 0);
});

test('recordNetScan: 드롭 증가분(델타) ≥ 임계 → 이슈 + dropRate 산출', () => {
  // 직전 rxDrop=100 → 150 (신규 50), rxPkts 10000 → 10300 (신규 300)
  const found = recordNetScan(VM, [{ iface: 'eth0', rxDrop: 150, txDrop: 0, rxErr: 0, txErr: 0, rxPkts: 10300, txPkts: 5000 }]);
  assert.equal(found.length, 1);
  assert.equal(found[0].newDrop, 50);
  assert.equal(found[0].iface, 'eth0');
  assert.equal(found[0].dropRate, Number(((50 / 300) * 100).toFixed(3))); // 16.667
});

test('recordNetScan: 카운터 리셋(재부팅)은 음수 방지 → 이슈 아님', () => {
  // rxDrop 150 → 5 (감소) : Math.max(0, ...)로 0 처리
  const found = recordNetScan(VM, [{ iface: 'eth0', rxDrop: 5, txDrop: 0, rxErr: 0, txErr: 0, rxPkts: 200, txPkts: 100 }]);
  assert.equal(found.length, 0);
});

test('analyzeNetIssues: 요약/상위 VM 집계', () => {
  const a = analyzeNetIssues({ vcenterId: 'vc1', days: 7 });
  assert.equal(a.summary.total, 1);          // 위에서 1건 기록됨
  assert.equal(a.summary.vms, 1);
  assert.equal(a.summary.drops, 50);
  assert.ok(a.topVms[0].vm === 'gpu-01');
  assert.equal(getNetIssues(0).length, 1);
});

test('analyzeNetIssues: 다른 vCenter 필터 시 제외', () => {
  const a = analyzeNetIssues({ vcenterId: 'vc-other', days: 7 });
  assert.equal(a.summary.total, 0);
});
