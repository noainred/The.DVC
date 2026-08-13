import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// forecast.js / metrics db 는 import 시 CONFIG_DIR 사용 → 격리.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forecast-scope-'));
process.env.CONFIG_DIR = TMP;

const { getMetricsDb } = await import('../src/metrics/db.js');
const { forecastCapacity } = await import('../src/insights/forecast.js');

// v2.288 회귀 방지(확정 버그): GPU 예측은 스냅샷이 아니라 metrics DB gpu_vc 키를 직접 훑으므로,
// scopeSlice 된 스냅샷을 넘겨도 allowed 필터가 없으면 범위 밖 vCenter GPU 가 샌다.
test('forecastCapacity: allowed 집합이 GPU 예측을 범위 내 vCenter 로 제한', async () => {
  const db = await getMetricsDb();
  const now = Date.now();
  // vc-a·vc-b 각각 6시간 상승 시계열(선형·양의 기울기 → fit 통과, cap 100 미만이라 daysToLimit 계산됨).
  for (let i = 5; i >= 0; i--) {
    const ts = now - i * 3600_000;
    db.insertMany([
      { metric: 'gpu_vc', k: 'vc-a', v: 40 + (5 - i) * 5 },   // 40→65
      { metric: 'gpu_vc', k: 'vc-b', v: 30 + (5 - i) * 4 },   // 30→50
    ], ts);
  }
  const snap = { datastores: [], vcenters: [] };

  // 무제한(allowed 없음) → 두 vCenter 모두 예측에 포함.
  const all = await forecastCapacity(snap, { days: 14, bucketMin: 60 });
  const allVcs = new Set(all.gpu.map((g) => g.vcenterId));
  assert.ok(allVcs.has('vc-a') && allVcs.has('vc-b'), '무제한 계정은 두 vCenter GPU 모두 봄');

  // 범위 제한(allowed=vc-a) → vc-a 만, vc-b 는 누출되지 않아야 함.
  const scoped = await forecastCapacity(snap, { days: 14, bucketMin: 60, allowed: new Set(['vc-a']) });
  const scopedVcs = scoped.gpu.map((g) => g.vcenterId);
  assert.ok(scopedVcs.includes('vc-a'), 'vc-a 는 보여야 함');
  assert.ok(!scopedVcs.includes('vc-b'), '범위 밖 vc-b GPU 는 누출되면 안 됨');
});
