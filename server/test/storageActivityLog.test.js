import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 스토리지 수집 작업 로그(v2.315) 회귀 방지 — 링버퍼 상한·newest-first·필드 정규화·영속.
// CONFIG_DIR 을 임시로 잡고 동적 import(config.configDir 가 import 시점에 고정되므로 순서 중요).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-activity-test-'));
process.env.CONFIG_DIR = TMP;
process.env.STORAGE_ACTIVITY_MAX = '60'; // 하한(50) 위 값으로 폐기 동작 검증

const { recordActivity, listActivity, _resetForTest } = await import('../src/storage/activityLog.js');

test('링버퍼 상한 — MAX 초과분은 오래된 것부터 폐기(하한 50)', () => {
  _resetForTest();
  for (let i = 0; i < 75; i++) recordActivity({ deviceId: `d${i}`, name: `dev${i}`, ok: true, at: 1000 + i });
  const all = listActivity(1000);
  assert.equal(all.length, 60, 'MAX(60)로 절단');
  // newest-first: 가장 최근(i=74)이 맨 앞, 가장 오래 살아남은 건 i=15(75-60)
  assert.equal(all[0].deviceId, 'd74');
  assert.equal(all[all.length - 1].deviceId, 'd15');
});

test('newest-first + limit 적용', () => {
  _resetForTest();
  recordActivity({ deviceId: 'a', ok: true, at: 100 });
  recordActivity({ deviceId: 'b', ok: false, error: 'x', at: 200 });
  recordActivity({ deviceId: 'c', ok: true, at: 300 });
  const two = listActivity(2);
  assert.equal(two.length, 2);
  assert.deepEqual(two.map((e) => e.deviceId), ['c', 'b'], '최근 2건, 최신 우선');
});

test('필드 정규화 — 숫자 아님은 null, ok 는 불리언, 오류 문구 상한 300', () => {
  _resetForTest();
  const e = recordActivity({ deviceId: 'x', ok: 1, nodes: 'nope', usedBytes: 5, totalBytes: 10, durationMs: undefined, error: 'E'.repeat(500) });
  assert.equal(e.ok, true, 'truthy → 불리언 true');
  assert.equal(e.nodes, null, '숫자 아님 → null');
  assert.equal(e.usedBytes, 5);
  assert.equal(e.durationMs, null, 'undefined → null');
  assert.equal(e.error.length, 300, '오류 문구 300 절단');
});

test('영속 — 파일에 기록되고 재로드 시 유지(재생성 캐시)', () => {
  _resetForTest();
  recordActivity({ deviceId: 'persist', ok: true, at: 42 });
  const file = path.join(TMP, 'storage-activity.json');
  assert.ok(fs.existsSync(file), '영속 파일 생성');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(raw) && raw.some((r) => r.deviceId === 'persist'));
  _resetForTest(); // 인메모리 비운 뒤 재로드 시 파일에서 복구되는지
  assert.ok(listActivity(100).some((r) => r.deviceId === 'persist'), '재로드 복구');
});
