import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.320 — 2026-08-13 감사 보류 갭 2건(NSX 조회 scope · remote targetHost scope) 회귀 방지.
// 순수 판정 함수를 고정한다(라우트 배선은 overviewNsx.js·remote.js — 같은 함수를 호출).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nsx-remote-scope-test-'));
process.env.CONFIG_DIR = TMP;

const { visibleNsxManagers, managerInScope, scopedNsxRollup, allowedRegions } = await import('../src/nsx/scope.js');
const { targetHostScopeIssue } = await import('../src/routes/remote.js');

const VCS = [
  { id: 'vc-kr-1', location: { region: 'KR' } },
  { id: 'vc-us-1', location: { region: 'US-East' } },
  { id: 'vc-pl-1', location: { region: 'PL' } },
];
const MANAGERS = [
  { id: 'm-kr', name: 'NSX-KR', region: 'KR', vcenterId: '' },          // region 귀속
  { id: 'm-us', name: 'NSX-US', region: 'US-East', vcenterId: '' },
  { id: 'm-vc', name: 'NSX-VC', region: '', vcenterId: 'vc-kr-1' },     // vCenter 직접 귀속
  { id: 'm-none', name: 'NSX-ORPHAN', region: '', vcenterId: '' },      // 무귀속 — 범위 계정 미노출
];

test('visibleNsxManagers — vcenterId/region 귀속만 노출, 무귀속 숨김, 전체 범위는 전부', () => {
  const allowed = new Set(['vc-kr-1']);
  const vis = visibleNsxManagers(MANAGERS, VCS, allowed).map((m) => m.id).sort();
  assert.deepEqual(vis, ['m-kr', 'm-vc'], 'KR region 귀속 + vc-kr-1 직접 귀속만');
  assert.equal(visibleNsxManagers(MANAGERS, VCS, null).length, 4, '전체 범위 = 전부(기존 동작)');
  // 무귀속 매니저는 어떤 범위 계정에도 안 보인다('귀속 없는 데이터 미노출' 불변조건).
  const all = new Set(['vc-kr-1', 'vc-us-1', 'vc-pl-1']);
  assert.ok(!visibleNsxManagers(MANAGERS, VCS, all).some((m) => m.id === 'm-none'));
});

test('allowedRegions — 빈 region 제외(무귀속 매니저가 "" 매칭으로 새지 않게)', () => {
  const regions = allowedRegions([{ id: 'v1', location: { region: '' } }, { id: 'v2', location: { region: 'KR' } }], new Set(['v1', 'v2']));
  assert.deepEqual([...regions], ['KR']);
});

test('managerInScope — 레지스트리 형태(location.region)도 판정·범위 밖 false', () => {
  const allowed = new Set(['vc-us-1']);
  assert.equal(managerInScope({ id: 'x', location: { region: 'US-East' } }, VCS, allowed), true);
  assert.equal(managerInScope({ id: 'x', location: { region: 'KR' } }, VCS, allowed), false);
  assert.equal(managerInScope({ id: 'x', vcenterId: 'vc-us-1' }, VCS, allowed), true);
  assert.equal(managerInScope({ id: 'x' }, VCS, allowed), false, '무귀속 = 범위 계정 거부');
  assert.equal(managerInScope({ id: 'x' }, VCS, null), true, '전체 범위 = 허용');
});

test('scopedNsxRollup — 보이는 리소스만 집계(전 함대 총계 유출 차단), 필드 구성 유지', () => {
  const r = scopedNsxRollup({
    managers: [{ status: 'connected', firewall: { policies: 2, rules: 10 }, groups: 3 }, { status: 'degraded', firewall: { policies: 1, rules: 5 }, groups: 1 }],
    gateways: [{ tier: 'T0' }, { tier: 'T1' }, { tier: 'T1' }],
    segments: [{ type: 'OVERLAY' }, { type: 'VLAN' }],
    transportNodes: [{ type: 'host' }, { type: 'edge' }],
  });
  assert.equal(r.managers, 2); assert.equal(r.managersUp, 1); assert.equal(r.managersDegraded, 1);
  assert.equal(r.t0, 1); assert.equal(r.t1, 2);
  assert.equal(r.segments, 2); assert.equal(r.overlaySegments, 1); assert.equal(r.vlanSegments, 1);
  assert.equal(r.hostNodes, 1); assert.equal(r.edgeNodes, 1);
  assert.equal(r.dfwPolicies, 3); assert.equal(r.dfwRules, 15); assert.equal(r.groups, 4);
});

test('targetHostScopeIssue — 범위 내 VM IP/이름·호스트 이름만 허용, 범위 밖/미귀속 거부, 전체 범위 무제한', () => {
  const snap = {
    vms: [
      { vcenterId: 'vc-kr-1', name: 'web-01', ipAddresses: ['10.10.1.5', '10.10.1.6'] },
      { vcenterId: 'vc-us-1', name: 'db-01', ipAddress: '10.20.2.9' },
    ],
    hosts: [{ vcenterId: 'vc-kr-1', name: 'esx-kr-01.corp' }],
  };
  const kr = new Set(['vc-kr-1']);
  assert.equal(targetHostScopeIssue(snap, kr, '10.10.1.6'), null, '범위 내 VM IP(다중 IP 포함)');
  assert.equal(targetHostScopeIssue(snap, kr, 'WEB-01'), null, 'VM 이름(대소문자 무시)');
  assert.equal(targetHostScopeIssue(snap, kr, 'esx-kr-01.corp'), null, '범위 내 호스트 이름');
  assert.match(targetHostScopeIssue(snap, kr, '10.20.2.9'), /범위 내/, '범위 밖 vCenter 의 VM IP 거부');
  assert.match(targetHostScopeIssue(snap, kr, '10.99.99.99'), /범위 내/, '인벤토리에 없는 임의 IP 거부(정찰 차단)');
  assert.equal(targetHostScopeIssue(snap, null, '10.99.99.99'), null, '전체 범위 = 기존 신뢰 모델 유지');
});
