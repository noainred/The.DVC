// v2.721(감사 R1-02·R2-02) — SAN 스토리지 사용량 법인 소계: 계열이 전부 측정 없음이면 0 이 아니라 null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanStorageDcSubtotals } from '../src/routes/api/sanSwitch.js';

const arr = (dc, avg, extra = {}) => ({ endpointKind: 'array', datacenterId: dc, deviceIds: ['sw-a'], avgTotal: avg, maxTotal: avg == null ? null : avg * 2, peakAvg: avg == null ? null : avg + 1, peakTotal: avg == null ? null : avg * 3, ...extra });

test('R1-02: 측정 없음 계열만 있는 법인은 avg·max·peak 가 null 이고 unmeasured 를 센다', () => {
  const rows = sanStorageDcSubtotals([arr('dcA', null), arr('dcA', null), arr('dcB', 100)]);
  const a = rows.find((r) => r.datacenterId === 'dcA');
  assert.equal(a.storages, 0);
  assert.equal(a.unmeasured, 2);
  assert.equal(a.avgTotal, null);
  assert.equal(a.maxTotal, null);
  assert.equal(a.peakAvg, null);
  assert.equal(a.peakTotal, null);
  assert.equal(a.switches, 1);
  const b = rows.find((r) => r.datacenterId === 'dcB');
  assert.deepEqual([b.storages, b.unmeasured, b.avgTotal, b.maxTotal, b.peakAvg, b.peakTotal], [1, 0, 100, 200, 101, 300]);
  // 정렬: 측정값 큰 순 — null 은 뒤로.
  assert.deepEqual(rows.map((r) => r.datacenterId), ['dcB', 'dcA']);
});

test('R1-02: 측정·측정 없음이 섞인 법인은 측정분만 더하고 null 로 만들지 않는다', () => {
  const rows = sanStorageDcSubtotals([arr('dcA', 10), arr('dcA', null), { ...arr('dcA', 99), endpointKind: 'host' }]);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].storages, rows[0].unmeasured, rows[0].avgTotal, rows[0].peakAvg], [1, 1, 10, 11]);
});

test('R1-02: 이상 입력(null 원소·배열 아님)에서 던지지 않는다', () => {
  assert.deepEqual(sanStorageDcSubtotals(null), []);
  assert.equal(sanStorageDcSubtotals([null, arr('x', 5)]).length, 1);
});
