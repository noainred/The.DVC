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
  const e = list.find((x) => x.vcenterId === 'OC2');
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
  const ids = en.map((e) => e.vcenterId).sort();
  assert.deepEqual(ids, ['OC2', 'WA']);
  const oc2 = en.find((e) => e.vcenterId === 'OC2');
  assert.equal(oc2.password, 'secret', '폴러용은 비밀번호 포함');
});

test('removeScanRanges + recordScanRangeRun', () => {
  sr.recordScanRangeRun('WA', { scanned: 256, found: 3, registered: 3 });
  let e = sr.listScanRanges().find((x) => x.vcenterId === 'WA');
  assert.ok(e.lastRun && e.lastRun.found === 3 && e.lastRun.at);
  assert.equal(sr.removeScanRanges('WA').ok, true);
  assert.equal(sr.listScanRanges().some((x) => x.vcenterId === 'WA'), false);
  assert.equal(sr.removeScanRanges('WA').ok, false); // 이미 없음
});

test('runIdracScanOnce: 대상 없으면 사유 반환 / 단건 대역·계정 없으면 거부', async () => {
  // 단건 대상이 대역/계정 없는 vCenter면 거부.
  const r1 = await poller.runIdracScanOnce({ vcenterId: 'NORANGE' });
  assert.equal(r1.ok, false);
  // 상태 객체 형태 점검.
  const st = poller.idracScanStatus();
  assert.equal(typeof st.enabledVcenters, 'number');
  assert.equal(typeof st.intervalMs, 'number');
  assert.equal(st.running, false);
});
