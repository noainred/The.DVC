import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// v2.313 보안 감사 반영 — 프로비저닝 조회의 사용자 scope 강제(요청 필터보다 먼저 교집합).
// 과거 갭: /provision/sources·/saved 가 범위 밖 전 vCenter VM/템플릿·저장 작업을 노출했다.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-scope-test-'));
process.env.CONFIG_DIR = TMP;

const { store } = await import('../src/store.js');
const { listSources } = await import('../src/provision/jobs.js');
const { listSaved, addSaved } = await import('../src/provision/saved.js');

// 두 vCenter(vc-a, vc-b)에 걸친 VM 스냅샷을 주입.
store.snapshot = {
  ...store.snapshot,
  vms: [
    { id: 'vc-a:1', name: 'A-web', vcenterId: 'vc-a', template: false, powerState: 'poweredOn', cpuCount: 2, memMB: 4096 },
    { id: 'vc-a:2', name: 'A-tpl', vcenterId: 'vc-a', template: true, powerState: 'poweredOff', cpuCount: 4, memMB: 8192 },
    { id: 'vc-b:1', name: 'B-db', vcenterId: 'vc-b', template: false, powerState: 'poweredOn', cpuCount: 8, memMB: 16384 },
  ],
};

test('listSources — allowed(scope) 교집합이 요청 vcenterId 필터보다 먼저 적용', () => {
  // 제한 없음(null) → 전체
  assert.equal(listSources(undefined, '', null).total, 3);
  // vc-a 로 제한 → vc-a 것만(2건), vc-b 제외
  const scoped = listSources(undefined, '', new Set(['vc-a']));
  assert.equal(scoped.total, 2);
  assert.ok(scoped.sources.every((s) => s.vcenterId === 'vc-a'), '범위 밖 vCenter VM 미노출');
  // 범위 밖 vcenterId 를 명시해도 allowed 가 먼저라 빈 결과
  assert.equal(listSources('vc-b', '', new Set(['vc-a'])).total, 0);
  // 범위 내 vcenterId 명시 → 그 vCenter 것만
  assert.equal(listSources('vc-a', '', new Set(['vc-a'])).total, 2);
});

test('listSaved — allowed(scope) 로 저장 작업 필터 + vCenter 귀속 없는 작업은 범위 계정 미노출', () => {
  addSaved({ spec: { namePattern: 'jA' }, source: { name: 'jA', vcenterId: 'vc-a', id: 'vc-a:2' }, user: { username: 'u' } });
  addSaved({ spec: { namePattern: 'jB' }, source: { name: 'jB', vcenterId: 'vc-b', id: 'vc-b:1' }, user: { username: 'u' } });
  addSaved({ spec: { namePattern: 'jN' }, source: { name: 'jN', vcenterId: '', id: '' }, user: { username: 'u' } }); // 귀속 없음

  assert.equal(listSaved({ allowed: null }).total, 3, '제한 없음=전체');
  const scoped = listSaved({ allowed: new Set(['vc-a']) });
  assert.equal(scoped.total, 1, 'vc-a 것만');
  assert.equal(scoped.items[0].vcenterId, 'vc-a');
  assert.deepEqual(scoped.vcenters, ['vc-a'], '필터 탭도 범위 내 vCenter 만');
  // 귀속 없는 작업(vcenterId 빈값)은 범위 계정에 안 나온다.
  assert.ok(!listSaved({ allowed: new Set(['vc-a', 'vc-b']) }).items.some((i) => i.name === 'jN'));
});
