/**
 * v2.954(점검 B-5) — SAN 스토리지 현황 KPI '회선 사용률(합)' 분모: '지금' 값이 있는 행의 포트 속도만.
 *   분자(지금 합계 — trafficTotal)는 stale · 표본 없음 어레이를 더하지 않는데, 분모(rowTotals.speedSumBps)는 상태와 무관하게 다 더해 사용률이 낮게 보였다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sanutil2954-'));
process.env.CONFIG_DIR = tmp;
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('B-5 rowTotals — 지금 값이 없는 행(stale · no-sample)의 속도는 분모에서 뺀다', async () => {
  const L = await import('../src/sanswitch/storageList.js');
  const rows = [
    { avg24: 1e8, speedSumBps: 16e9, unknownSpeedPorts: 1, now: { bps: 2e8, ts: 1, stale: false } },
    { avg24: 1e8, speedSumBps: 32e9, unknownSpeedPorts: 2, now: { bps: null, ts: 1, stale: true } },
    { avg24: null, speedSumBps: 8e9, unknownSpeedPorts: 0, now: null },
    { avg24: 5e7, speedSumBps: 4e9, unknownSpeedPorts: 0, now: { bps: 0, ts: 1, stale: false } },   // 0 은 읽힌 값
  ];
  const t = L.rowTotals(rows);
  assert.equal(t.speedSumBps, 20e9);
  assert.equal(t.unknownSpeedPorts, 1, '속도 모르는 포트도 분모에 든 행만');
  assert.equal(t.arrays, 4); assert.equal(t.unmeasured, 1); assert.equal(t.avg24, 2.5e8, '24시간 합은 예전 규칙 그대로');
  assert.equal(L.rowTotals([rows[1], rows[2]]).speedSumBps, null, '지금 값이 있는 행이 없으면 분모 없음(사용률 —)');
});
