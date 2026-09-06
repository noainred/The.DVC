/**
 * v2.412 회귀 테스트 — 시리얼 통합 조회.
 *
 * 고정하는 것:
 *  1) 검색 정규화 — 구분자·대소문자를 무시해야 자산대장 표기와 장비 표기가 서로 걸린다.
 *  2) 빈/무의미 시리얼('-', 'N/A', 'unknown')은 행을 만들지 않는다 — 빈 행이 섞이면
 *     '수집됨'으로 오해되고, 검색 결과가 잡음으로 오염된다.
 *  3) 완전 일치를 부분 일치보다 먼저 보여준다(RMA 조회는 대개 완전 일치).
 *  4) 종류 필터·상한(truncated) 동작.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'serial-'));

test('normKey: 대소문자·구분자를 무시한다(자산대장 표기와 장비 표기를 잇는다)', async () => {
  const { normKey } = await import('../src/insights/serialLookup.js');
  assert.equal(normKey('10:00:00:05:1E'), '100000051e');
  assert.equal(normKey('BRC-FPL1944 R00C'), 'brcfpl1944r00c');
  assert.equal(normKey('J7K2M13'), 'j7k2m13');
  assert.equal(normKey(null), '');
});

test('searchSerials: 부분 일치 + 완전 일치 우선', async () => {
  const { searchSerials, normKey } = await import('../src/insights/serialLookup.js');
  const mk = (serial, kind = 'server', deviceName = 'x') => ({ kind, serial, key: normKey(serial), deviceName });
  const rows = [mk('J7K2M13XX'), mk('AAAJ7K2M13'), mk('J7K2M13')];
  const r = searchSerials(rows, 'j7k2m13');
  assert.equal(r.total, 3);
  assert.equal(r.rows[0].serial, 'J7K2M13', '완전 일치가 먼저 나와야 한다');
});

test('searchSerials: 구분자가 든 시리얼도 구분자 없는 질의로 찾는다', async () => {
  const { searchSerials, normKey } = await import('../src/insights/serialLookup.js');
  const rows = [{ kind: 'sanswitch', serial: '10:00:00:05:1e:aa:bb:cc', key: normKey('10:00:00:05:1e:aa:bb:cc'), deviceName: 'sw' }];
  assert.equal(searchSerials(rows, '100000051e').total, 1);
  assert.equal(searchSerials(rows, '10:00:00:05').total, 1);
  assert.equal(searchSerials(rows, '99').total, 0);
});

test('searchSerials: 빈 질의는 결과 0(전체를 쏟지 않는다)', async () => {
  const { searchSerials, normKey } = await import('../src/insights/serialLookup.js');
  const rows = [{ kind: 'server', serial: 'A1', key: normKey('A1'), deviceName: 'x' }];
  assert.equal(searchSerials(rows, '').total, 0);
  assert.equal(searchSerials(rows, '   ').total, 0);
});

test('searchSerials: 종류 필터와 상한(truncated)', async () => {
  const { searchSerials, normKey } = await import('../src/insights/serialLookup.js');
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ kind: i % 2 ? 'server' : 'storage', serial: `SN${i}`, key: normKey(`SN${i}`), deviceName: 'd' });
  assert.equal(searchSerials(rows, 'sn').total, 30);
  assert.equal(searchSerials(rows, 'sn', { kinds: ['storage'] }).total, 15);
  const cap = searchSerials(rows, 'sn', { limit: 10 });
  assert.equal(cap.rows.length, 10);
  assert.equal(cap.truncated, true);
  assert.equal(cap.total, 30, '상한은 표시만 자르고 총계는 진짜 수를 알려야 한다');
});

test('buildSerialIndex: 빈/무의미 시리얼은 행을 만들지 않는다', async () => {
  const { buildSerialIndex, _resetForTest } = await import('../src/insights/serialLookup.js');
  const { saveDevice: saveSw, _resetForTest: resetSw } = await import('../src/sanswitch/registry.js');
  const { putSnapshot, _resetForTest: resetStore } = await import('../src/sanswitch/store.js');
  _resetForTest(); resetSw(); resetStore();
  const d = saveSw({ type: 'brocade', name: 'SW-EMPTY', host: '10.5.5.5', username: 'admin', password: 'p' });
  putSnapshot({
    deviceId: d.id, type: 'brocade', name: 'SW-EMPTY', host: '10.5.5.5', ok: true,
    serial: '', wwn: 'N/A', model: '', collectedAt: Date.now(),
    extra: { chassisPartNumber: '-', chassisId: 'unknown' },
    ports: { list: [] }, health: {}, sections: {},
  });
  const idx = buildSerialIndex({ user: { role: 'admin' }, query: {} });
  const mine = idx.rows.filter((r) => r.deviceId === d.id);
  assert.equal(mine.length, 0, "빈 문자열·'N/A'·'-'·'unknown' 은 시리얼이 아니다");
  _resetForTest(); resetSw(); resetStore();
});

test('buildSerialIndex: SAN 스위치 섀시·PSU·SFP 시리얼을 모두 수집한다', async () => {
  const { buildSerialIndex, _resetForTest } = await import('../src/insights/serialLookup.js');
  const { saveDevice: saveSw, _resetForTest: resetSw } = await import('../src/sanswitch/registry.js');
  const { putSnapshot, _resetForTest: resetStore } = await import('../src/sanswitch/store.js');
  _resetForTest(); resetSw(); resetStore();
  const d = saveSw({ type: 'brocade', name: 'OC2-1', host: '10.6.6.6', username: 'admin', password: 'p', datacenterId: 'dc-oc' });
  putSnapshot({
    deviceId: d.id, type: 'brocade', name: 'LES_DVC_SAN_03', host: '10.6.6.6', datacenterId: 'dc-oc',
    ok: true, collectedAt: Date.now(), fabricOs: 'v9.0.1d', model: '',
    serial: 'BRCFPL1944R00C', wwn: '10:00:00:05:1e:aa:bb:cc',
    extra: { switchType: '165.3', chassisPartNumber: '40-1001320-06', chassisId: 'EMC0000CA' },
    health: { psuDetail: [{ unit: 1, serial: '34R0E7', source: 'AC', voltageV: 218, powerW: 240 }] },
    ports: { list: [{ index: 0, slotPort: '0', sfpSerial: 'HAA114001', sfpPartNumber: '57-1000012-01', sfpVendor: 'BROCADE' }] },
    sections: {},
  });
  const idx = buildSerialIndex({ user: { role: 'admin' }, query: {} });
  const mine = idx.rows.filter((r) => r.deviceId === d.id);
  const by = (t) => mine.find((r) => r.serialType === t);
  assert.equal(by('섀시 시리얼').serial, 'BRCFPL1944R00C');
  assert.equal(by('Switch WWN').serial, '10:00:00:05:1e:aa:bb:cc');
  assert.equal(by('섀시 부품번호').serial, '40-1001320-06');
  assert.equal(by('섀시 ID').serial, 'EMC0000CA');
  const psu = mine.find((r) => r.part === '전원공급장치');
  assert.equal(psu.serial, '34R0E7');
  assert.equal(psu.kind, 'sanswitch-part');
  const sfp = mine.find((r) => r.part === 'SFP');
  assert.equal(sfp.serial, 'HAA114001');
  assert.equal(sfp.partLocation, '포트 0');
  // 모델명이 없으면 switchType 원값을 쓴다(추측 금지)
  assert.equal(by('섀시 시리얼').model, 'switchType 165.3');
  assert.equal(by('섀시 시리얼').datacenterId, 'dc-oc');
  _resetForTest(); resetSw(); resetStore();
});

test('buildSerialIndex: 한 출처가 실패해도 나머지는 살아 있고 사유를 남긴다', async () => {
  const { buildSerialIndex } = await import('../src/insights/serialLookup.js');
  // req 가 없으면 서버 목록 조회가 실패한다(analysisServersWithRemote 는 req 를 쓴다).
  const idx = buildSerialIndex(null);
  assert.ok(idx.sources, '출처별 상태를 반드시 보고한다');
  assert.ok(Object.keys(idx.sources).length >= 6, '실패한 출처가 있어도 나머지 출처는 집계된다');
});
