// v2.958 — /tools/vm-track ?region= 은 사용자 범위와의 교집합으로만 좁힌다(허브 KPI 가 리전 범위를 따르게). 순수 함수 계약.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { trackScopeIds } from '../src/vmtrack/scopeIds.js';

const vcs = [
  { id: 'vc-a', location: { region: '아시아' } },
  { id: 'vc-b', location: { region: '아시아' } },
  { id: 'vc-c', location: { region: '유럽' } },
  { id: 'vc-d' },                                   // 리전 없음
  null, 'garbage',                                  // 쓰레기 행은 무시
];

test('region 이 없으면 사용자 범위 그대로(null 은 null — 전체 경로 유지)', () => {
  assert.equal(trackScopeIds({ allowed: null, region: '', vcenters: vcs }), null);
  const s = new Set(['vc-a']);
  assert.equal(trackScopeIds({ allowed: s, region: '   ', vcenters: vcs }), s);
  assert.equal(trackScopeIds({}), null);
});

test('region 은 그 리전의 vCenter 집합 — 전체 범위 계정', () => {
  assert.deepEqual([...trackScopeIds({ allowed: null, region: '아시아', vcenters: vcs })].sort(), ['vc-a', 'vc-b']);
  assert.deepEqual([...trackScopeIds({ allowed: null, region: '유럽', vcenters: vcs })], ['vc-c']);
});

test('범위 계정은 교집합만 — 범위 밖 vCenter 는 리전이 맞아도 들어가지 않는다(scope 우회 금지)', () => {
  const out = trackScopeIds({ allowed: new Set(['vc-b', 'vc-c']), region: '아시아', vcenters: vcs });
  assert.deepEqual([...out], ['vc-b']);
});

test('맞는 vCenter 가 없으면 빈 Set — 전체로 넓히지 않는다 · 리전 문자열은 그대로 비교(대소문자 · 공백 보정 없음)', () => {
  const none = trackScopeIds({ allowed: null, region: '중동', vcenters: vcs });
  assert.ok(none instanceof Set); assert.equal(none.size, 0);
  assert.equal(trackScopeIds({ allowed: null, region: '아시아 ', vcenters: vcs }).size, 2, 'trim 한 리전으로 비교한다');
  assert.equal(trackScopeIds({ allowed: null, region: 'asia', vcenters: vcs }).size, 0);
});

test('라우트가 region 을 읽어 교집합으로 넘긴다(소스 계약) — service 는 빈 Set 을 빈 결과로 집계한다', () => {
  const src = fs.readFileSync(new URL('../src/routes/api/vmtrack.js', import.meta.url), 'utf8');
  assert.match(src, /trackScopeIds\(\{ allowed, region: String\(req\.query\.region \|\| ''\)/);
  assert.match(src, /vmtrackSeries\(\{ days, vcenterId, scopeIds \}\)/);
  const svc = fs.readFileSync(new URL('../src/vmtrack/service.js', import.meta.url), 'utf8');
  assert.match(svc, /filter\(\(r\) => scopeIds\.has\(r\.vcenter_id\)\)/, '범위 집합은 has 로만 거른다(빈 집합 = 없음)');
});
