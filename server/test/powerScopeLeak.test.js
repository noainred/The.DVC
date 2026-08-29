import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 확정 버그 회귀 방지(2026-08-30) — 전력 집계의 scope 누수.
//
// 배경: allMeasuredPower() 는 `hosts` 인자와 무관하게 loadRegistry()/OME/원격의 **전 등록
// 서버**를 반환한다. 범위 제한 계정에 scopeSlice 로 좁힌 스냅샷만 넘기면, 범위 밖 vCenter 에
// 귀속된 서버는 귀속 판정에 실패해 '(미매핑)' 으로 강등된 뒤에도 집계·목록에 그대로 포함됐다.
// → FinOps(totals·topHosts)·전력분석(servers[])이 전 함대의 서버 이름·서비스태그·모델·소비전력과
// 전사 총량을 범위 계정에 노출. server/CLAUDE.md '귀속 없는 데이터는 범위 계정 미노출' 위반.
//
// 라우트는 범위 제한 계정에 keepMappedMeasured 를 **설정과 무관하게 강제**해 이를 막는다.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'power-scope-'));
process.env.CONFIG_DIR = tmp;

const { keepMappedMeasured } = await import('../src/idrac/attribution.js');
const { computeFinOps } = await import('../src/insights/finops.js');
const { computePowerBreakdown } = await import('../src/insights/powerBreakdown.js');

// vCenter A 만 허용된 범위 계정이 보는 스냅샷(scopeSlice 결과와 같은 형태).
const scopedSnap = {
  vcenters: [{ id: 'vc-a', name: 'Seoul', location: { region: 'KR' } }],
  hosts: [{ name: 'esxi-a1', vcenterId: 'vc-a', serviceTag: 'TAGA1', model: 'R650' }],
};

// allMeasuredPower() 가 돌려주는 형태 — 범위 밖(vc-b) 서버와 아예 무귀속 베어메탈이 섞여 있다.
const measuredAll = [
  { serverId: 'a1', serverName: 'esxi-a1', host: 'esxi-a1', hostNames: ['esxi-a1'], serviceTag: 'TAGA1', watts: 300, source: 'idrac' },
  { serverId: 'b1', serverName: 'esxi-b1', host: 'esxi-b1', hostNames: ['esxi-b1'], serviceTag: 'TAGB1', watts: 500, vcenterId: 'vc-b', source: 'idrac' },
  { serverId: 'x1', serverName: 'bare-metal-x', host: 'bare-x', hostNames: ['bare-x'], serviceTag: 'TAGX1', watts: 700, source: 'remote' },
];

test('keepMappedMeasured: 허용 스냅샷에 귀속되지 않는 서버는 전부 제거', () => {
  const kept = keepMappedMeasured(measuredAll, scopedSnap);
  assert.deepEqual(kept.map((m) => m.serverId), ['a1'], '범위 밖(b1)·무귀속(x1) 서버가 남으면 누수');
});

test('FinOps: 필터 없이 넘기면 전 함대 전력·서버명이 노출된다(회귀 감지용 대조)', () => {
  const leaked = computeFinOps(scopedSnap, measuredAll);
  assert.equal(leaked.totals.watts, 1500, '필터 전에는 범위 밖 전력까지 합산됨(=누수 상태)');
  const names = leaked.topHosts.map((h) => h.host);
  assert.ok(names.includes('esxi-b1') && names.includes('bare-metal-x'), '누수 상태 전제 확인');
});

test('FinOps: 범위 강제 필터 적용 후에는 허용 vCenter 전력만 남는다', () => {
  const safe = computeFinOps(scopedSnap, keepMappedMeasured(measuredAll, scopedSnap));
  assert.equal(safe.totals.watts, 300, '허용 vCenter(vc-a) 전력만 합산돼야 함');
  assert.equal(safe.unmappedServers, 0, '범위 계정에는 (미매핑) 항목이 남지 않아야 함');
  const names = safe.topHosts.map((h) => h.host);
  assert.ok(!names.includes('esxi-b1'), '범위 밖 서버명 노출 금지');
  assert.ok(!names.includes('bare-metal-x'), '무귀속 베어메탈 노출 금지');
  assert.ok(!safe.byVcenter.some((v) => v.vcId === '(미매핑)'), '(미매핑) 그룹 노출 금지');
});

test('전력분석: 범위 강제 필터 후 servers[] 에 범위 밖 서버·서비스태그가 없다', () => {
  const safe = computePowerBreakdown(scopedSnap, keepMappedMeasured(measuredAll, scopedSnap), {});
  assert.equal(safe.totals.watts, 300);
  assert.equal(safe.unmappedServers, 0);
  const tags = safe.servers.map((s) => s.serviceTag);
  assert.deepEqual(safe.servers.map((s) => s.name), ['esxi-a1']);
  assert.ok(!tags.includes('TAGB1') && !tags.includes('TAGX1'), '범위 밖 서비스태그 노출 금지');
});

test('전체 범위 계정(필터 미적용)은 종전대로 (미매핑) 포함 — 동작 보존', () => {
  // 미매핑 전력을 봐야 하는 쪽은 전체 범위 운영자다. 이 경로의 동작이 바뀌면 안 된다.
  const full = computeFinOps(scopedSnap, measuredAll);
  assert.equal(full.unmappedServers, 2);
  assert.ok(full.byVcenter.some((v) => v.vcId === '(미매핑)'));
});
