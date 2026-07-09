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

test('saveScanRanges: 저장 + 비밀번호 마스킹/유지(엔트리 id로 수정)', () => {
  const r = sr.saveScanRanges({ datacenterId: 'OC2', ranges: '10.0.0.0/24\n10.0.1.1-10.0.1.50', username: 'root', password: 'secret', agent: '', enabled: true });
  assert.equal(r.ok, true);
  assert.ok(r.id, '엔트리 id 발급');
  assert.deepEqual(r.ranges, ['10.0.0.0/24', '10.0.1.1-10.0.1.50']);
  assert.equal(r.hasPassword, true);
  assert.equal(r.username, 'root');
  // 목록 응답에는 평문 비밀번호가 없어야 함.
  const list = sr.listScanRanges();
  const e = list.find((x) => x.id === r.id);
  assert.ok(e && !('password' in e));
  assert.equal(e.hasPassword, true);

  // 빈 비밀번호로 부분 수정(같은 id) 시 기존 비밀번호 유지.
  sr.saveScanRanges({ id: r.id, datacenterId: 'OC2', enabled: false, password: '' });
  const raw = sr.getScanRangeRaw(r.id);
  assert.equal(raw.password, 'secret', '빈 비번 저장은 기존 유지');
  assert.equal(raw.enabled, false);
});

test('한 법인에 서비스별 여러 엔트리 — datacenterId가 같아도 별개 엔트리로 저장', () => {
  const a = sr.saveScanRanges({ datacenterId: 'DCX', service: '서비스A', ranges: '10.1.0.0/24', username: 'root', password: 'pw', agent: 'agentA' });
  const b = sr.saveScanRanges({ datacenterId: 'DCX', service: '서비스B', ranges: '10.1.1.0/24', username: 'root', password: 'pw', agent: 'agentB' });
  assert.notEqual(a.id, b.id, '같은 법인이라도 서로 다른 엔트리(id)');
  const list = sr.listScanRanges().filter((x) => x.datacenterId === 'DCX');
  assert.equal(list.length, 2, '법인 DCX에 서비스 2개');
  assert.deepEqual(list.map((x) => x.service).sort(), ['서비스A', '서비스B']);
  assert.deepEqual(list.map((x) => x.agent).sort(), ['agentA', 'agentB']);
  // 법인 전체 조회는 두 엔트리를 모두 반환.
  const forDc = sr.scanRangesForDatacenter('DCX');
  assert.equal(forDc.length, 2);
  // 한 서비스만 삭제해도 다른 서비스는 유지.
  assert.equal(sr.removeScanRanges(a.id).ok, true);
  const rest = sr.scanRangesForDatacenter('DCX');
  assert.equal(rest.length, 1);
  assert.equal(rest[0].service, '서비스B');
});

test('enabledScanRanges: enabled + 대역 + 계정 + 비번 있는 것만', () => {
  const oc2 = sr.listScanRanges().find((x) => x.datacenterId === 'OC2');
  sr.saveScanRanges({ id: oc2.id, datacenterId: 'OC2', enabled: true });          // 다시 활성
  const wa = sr.saveScanRanges({ datacenterId: 'WA', ranges: '192.168.1.0/24', username: 'root', password: 'pw2' });
  sr.saveScanRanges({ datacenterId: 'NOCRED', ranges: '172.16.0.0/24', username: '' }); // 계정 없음 → 제외
  sr.saveScanRanges({ datacenterId: 'NORANGE', ranges: '', username: 'root', password: 'x' }); // 대역 없음 → 제외
  sr.saveScanRanges({ datacenterId: 'NOPW', ranges: '172.16.1.0/24', username: 'root' }); // 비번 없음 → 제외
  const en = sr.enabledScanRanges();
  const dcs = en.map((e) => e.datacenterId).sort();
  assert.ok(dcs.includes('OC2') && dcs.includes('WA'));
  assert.ok(!dcs.includes('NOCRED') && !dcs.includes('NORANGE') && !dcs.includes('NOPW'));
  const oc2e = en.find((e) => e.datacenterId === 'OC2');
  assert.equal(oc2e.password, 'secret', '폴러용은 비밀번호 포함');
  assert.ok(oc2e.id, '폴러용 엔트리에도 id 포함');
  // WA 엔트리 lastRun 기록 후 삭제.
  sr.recordScanRangeRun(wa.id, { scanned: 256, found: 3, registered: 3 });
  const wae = sr.listScanRanges().find((x) => x.id === wa.id);
  assert.ok(wae.lastRun && wae.lastRun.found === 3 && wae.lastRun.at);
  assert.equal(sr.removeScanRanges(wa.id).ok, true);
  assert.equal(sr.removeScanRanges(wa.id).ok, false); // 이미 없음
});

test('dispatch(전달 방식) 저장/기본값 — poll 기본, push 저장·유지', () => {
  const a = sr.saveScanRanges({ datacenterId: 'DCP', service: 'poll기본', ranges: '10.7.0.0/24', username: 'root', password: 'pw', agent: 'agentP' });
  assert.equal(a.dispatch, 'poll', '미지정 시 기본 poll');
  const b = sr.saveScanRanges({ datacenterId: 'DCP', service: 'push서비스', ranges: '10.7.1.0/24', username: 'root', password: 'pw', agent: 'agentQ', dispatch: 'push' });
  assert.equal(b.dispatch, 'push', 'push 저장');
  // 다른 필드만 수정해도 dispatch 유지.
  const b2 = sr.saveScanRanges({ id: b.id, datacenterId: 'DCP', enabled: false });
  assert.equal(b2.dispatch, 'push', '부분 수정 시 dispatch 유지');
  // 폴러용 원본에도 dispatch 포함.
  const en = sr.enabledScanRanges().find((e) => e.id === a.id);
  assert.equal(en.dispatch, 'poll');
});

test('runIdracScanOnce: 대상 없으면 사유 반환 / 단건(id) 대역·계정 없으면 거부', async () => {
  const nr = sr.saveScanRanges({ datacenterId: 'NORANGE2', ranges: '', username: 'root' });
  const r1 = await poller.runIdracScanOnce({ id: nr.id });
  assert.equal(r1.ok, false);
  const st = poller.idracScanStatus();
  assert.equal(typeof st.enabledDatacenters, 'number');
  assert.equal(typeof st.intervalMs, 'number');
  assert.equal(st.running, false);
});

test('lastScanCycleAt: 기록 전보다 기록 후 증가', () => {
  const before = sr.lastScanCycleAt();
  const a = sr.saveScanRanges({ datacenterId: 'DC-A', ranges: '10.9.0.0/24', username: 'root', password: 'x', enabled: true });
  sr.recordScanRangeRun(a.id, { scanned: 10, found: 0 });
  const after1 = sr.lastScanCycleAt();
  assert.ok(after1 >= before && after1 > 0);
  const b = sr.saveScanRanges({ datacenterId: 'DC-B', ranges: '10.9.1.0/24', username: 'root', password: 'x', enabled: true });
  sr.recordScanRangeRun(b.id, {});
  assert.ok(sr.lastScanCycleAt() >= after1);
});
