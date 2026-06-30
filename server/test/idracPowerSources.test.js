import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR — 레지스트리/DB가 이 디렉터리를 쓴다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idrac-src-'));
process.env.CONFIG_DIR = tmp;

let service, omeCache, state;
before(async () => {
  service = await import('../src/idrac/service.js');
  omeCache = await import('../src/idrac/omeCache.js');
  state = await import('../src/collector/state.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('measuredPowerBreakdown: OME/원격 소스별 분해 + 등록 여부', async () => {
  // 등록되지 않은 OME 1개가 3개 디바이스(전력 보고)를 캐시에 올림.
  omeCache.setOmeDevices('ome-x', [
    { serviceTag: 'AAA1', name: 'srv-a', watts: 100 },
    { serviceTag: 'BBB2', name: 'srv-b', watts: 200 },
    { serviceTag: 'CCC3', name: 'srv-c', watts: 300 },
  ]);
  // 등록되지 않은 수집서버 1개가 원격 호스트 2개를 보고.
  state.setRemoteHost('host-1', { watts: 50, ts: Date.now(), collectorId: 'col-y', serverName: 'h1' });
  state.setRemoteHost('host-2', { watts: 60, ts: Date.now(), collectorId: 'col-y', serverName: 'h2' });

  const b = await service.measuredPowerBreakdown();
  assert.equal(b.bySource.ome, 3, 'OME 디바이스 3개');
  assert.equal(b.bySource.remote, 2, '원격 호스트 2개');
  assert.equal(b.total, 5);
  assert.equal(b.registeredIdrac, 0, '등록 iDRAC 없음');

  const ome = b.ome.entries.find((e) => e.entryId === 'ome-x');
  assert.ok(ome && ome.registered === false, '미등록 OME으로 표시');
  assert.equal(ome.measured, 3);

  const col = b.remote.collectors.find((c) => c.collectorId === 'col-y');
  assert.ok(col && col.registered === false, '미등록 수집서버로 표시');
  assert.equal(col.hosts, 2);
});

test('purgeStalePower(mode=all): 등록 무관 OME 캐시·원격 호스트 전체 제거', async () => {
  // 사전 상태가 남아있다면 보강.
  omeCache.setOmeDevices('ome-z', [{ serviceTag: 'ZZZ9', name: 'srv-z', watts: 400 }]);
  state.setRemoteHost('host-9', { watts: 70, ts: Date.now(), collectorId: 'col-z', serverName: 'h9' });

  const r = await service.purgeStalePower({ mode: 'all' });
  assert.equal(r.mode, 'all');
  assert.ok(r.omeCleared >= 1, 'OME 디바이스 제거됨');
  assert.ok(r.remoteCleared >= 1, '원격 호스트 제거됨');

  const after = await service.measuredPowerBreakdown();
  assert.equal(after.bySource.ome, 0, '강제 초기화 후 OME 0');
  assert.equal(after.bySource.remote, 0, '강제 초기화 후 원격 0');
});
