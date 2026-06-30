import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-set-'));
process.env.CONFIG_DIR = tmp;

let ps, colReg;
before(async () => {
  ps = await import('../src/idrac/powerSettings.js');
  colReg = await import('../src/collector/registry.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

const snap = {
  vcenters: [{ id: 'OC2' }, { id: 'WA' }],
  hosts: [{ name: 'esxi-a', vcenterId: 'OC2' }],
};

test('filterMeasuredByMapping: 기본(off)은 전체 통과', () => {
  ps.savePowerSettings({ excludeUnmapped: false });
  const measured = [
    { serverId: '1', host: 'esxi-a', hostNames: ['esxi-a'] },           // 매핑됨
    { serverId: '2', host: 'unknown', hostNames: ['unknown'] },          // 미매핑
  ];
  assert.equal(ps.filterMeasuredByMapping(measured, snap).length, 2);
});

test('filterMeasuredByMapping: on이면 미매핑 제외', () => {
  ps.savePowerSettings({ excludeUnmapped: true });
  const measured = [
    { serverId: '1', host: 'esxi-a', hostNames: ['esxi-a'] },           // 매핑(이름)
    { serverId: '2', host: 'unknown', hostNames: ['unknown'] },          // 미매핑 → 제외
    { serverId: '3', vcenterId: 'WA', host: 'x', hostNames: ['x'] },     // 명시 vCenter → 매핑
  ];
  const out = ps.filterMeasuredByMapping(measured, snap);
  assert.equal(out.length, 2);
  assert.ok(out.every((m) => m.serverId !== '2'));
});

test('수집서버 vcenterId 매핑: 저장/유지', () => {
  colReg.addCollector({ id: 'OC2', name: 'OC2', url: 'http://10.0.0.1:4000', vcenterId: 'OC2' });
  let c = colReg.loadCollectors().find((x) => x.id === 'OC2');
  assert.equal(c.vcenterId, 'OC2');
  // 부분 업데이트 시 vcenterId 보존 + 변경 가능.
  colReg.updateCollector('OC2', { name: 'OC2-renamed' });
  c = colReg.loadCollectors().find((x) => x.id === 'OC2');
  assert.equal(c.vcenterId, 'OC2', '부분 업데이트로도 유지');
  colReg.updateCollector('OC2', { vcenterId: 'WA' });
  c = colReg.loadCollectors().find((x) => x.id === 'OC2');
  assert.equal(c.vcenterId, 'WA', '변경 반영');
});
