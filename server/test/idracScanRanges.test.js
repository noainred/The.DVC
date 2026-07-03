import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-scanrng-'));
process.env.CONFIG_DIR = tmp;

let sr, poller;
before(async () => {
  sr = await import('../src/idrac/scanRanges.js');
  poller = await import('../src/idrac/scanPoller.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('saveScanRanges: 저장 + 비밀번호 마스킹/유지', () => {
  const r = sr.saveScanRanges('OC2', { ranges: '10.0.0.0/24\n10.0.1.1-10.0.1.50', username: 'root', password: 'secret', agent: '', enabled: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ranges, ['10.0.0.0/24', '10.0.1.1-10.0.1.50']);
  assert.equal(r.hasPassword, true);
  assert.equal(r.username, 'root');
  // 목록 응답에는 평문 비밀번호가 없어야 함.
  const list = sr.listScanRanges();
  const e = list.find((x) => x.datacenterId === 'OC2');
  assert.ok(e && !('password' in e));
  assert.equal(e.hasPassword, true);

  // 빈 비밀번호로 부분 수정 시 기존 비밀번호 유지.
  sr.saveScanRanges('OC2', { enabled: false, password: '' });
  const raw = sr.getScanRangeRaw('OC2');
  assert.equal(raw.password, 'secret', '빈 비번 저장은 기존 유지');
  assert.equal(raw.enabled, false);
});

test('enabledScanRanges: enabled + 대역 + 계정 있는 것만(비번 포함)', () => {
  sr.saveScanRanges('OC2', { enabled: true });                 // 다시 활성
  sr.saveScanRanges('WA', { ranges: '192.168.1.0/24', username: 'root', password: 'pw2' });
  sr.saveScanRanges('NOCRED', { ranges: '172.16.0.0/24', username: '' }); // 계정 없음 → 제외
  sr.saveScanRanges('NORANGE', { ranges: '', username: 'root', password: 'x' }); // 대역 없음 → 제외
  sr.saveScanRanges('NOPW', { ranges: '172.16.1.0/24', username: 'root' }); // 비밀번호 없음 → 제외(스캔 보류)
  const en = sr.enabledScanRanges();
  const ids = en.map((e) => e.datacenterId).sort();
  assert.deepEqual(ids, ['OC2', 'WA']);
  const oc2 = en.find((e) => e.datacenterId === 'OC2');
  assert.equal(oc2.password, 'secret', '폴러용은 비밀번호 포함');
});

test('removeScanRanges + recordScanRangeRun', () => {
  sr.recordScanRangeRun('WA', { scanned: 256, found: 3, registered: 3 });
  let e = sr.listScanRanges().find((x) => x.datacenterId === 'WA');
  assert.ok(e.lastRun && e.lastRun.found === 3 && e.lastRun.at);
  assert.equal(sr.removeScanRanges('WA').ok, true);
  assert.equal(sr.listScanRanges().some((x) => x.datacenterId === 'WA'), false);
  assert.equal(sr.removeScanRanges('WA').ok, false); // 이미 없음
});

test('runIdracScanOnce: 대상 없으면 사유 반환 / 단건 대역·계정 없으면 거부', async () => {
  // 단건 대상이 대역/계정 없는 법인이면 거부.
  const r1 = await poller.runIdracScanOnce({ datacenterId: 'NORANGE' });
  assert.equal(r1.ok, false);
  // 상태 객체 형태 점검.
  const st = poller.idracScanStatus();
  assert.equal(typeof st.enabledDatacenters, 'number');
  assert.equal(typeof st.intervalMs, 'number');
  assert.equal(st.running, false);
});

test('lastScanCycleAt: 스캔 실행 전 0, recordScanRangeRun 후 최대 at 반환', () => {
  // 새 격리 상태 가정 없이 현재 파일 기준 — 위 테스트에서 OC2 등이 저장됐을 수 있으나 lastRun은 없음
  const before = sr.lastScanCycleAt();
  const t1 = Date.now() - 5000;
  sr.saveScanRanges('DC-A', { ranges: '10.9.0.0/24', username: 'root', password: 'x', enabled: true });
  sr.recordScanRangeRun('DC-A', { at: t1, scanned: 10, found: 0 });
  // recordScanRangeRun는 at를 Date.now()로 덮어씀 — 이 함수 계약상 lastRun.at은 '기록 시각'
  const after1 = sr.lastScanCycleAt();
  assert.ok(after1 >= before, 'lastScanCycleAt는 기록 후 증가/유지');
  assert.ok(after1 > 0, '스캔 기록 후 0보다 큼');
  // 두 번째 법인이 더 늦게 기록되면 그 값이 최대
  sr.saveScanRanges('DC-B', { ranges: '10.9.1.0/24', username: 'root', password: 'x', enabled: true });
  sr.recordScanRangeRun('DC-B', {});
  const after2 = sr.lastScanCycleAt();
  assert.ok(after2 >= after1, '더 최근 기록이 최대값');
});
