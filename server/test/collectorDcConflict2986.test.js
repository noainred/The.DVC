// v2.986 수집 서버 법인 ↔ vCenter 할당 법인 불일치(사용자 결정 2026-11-12 '불일치가 생기면 사용자가 매칭을 선택' · '버튼으로 한쪽에 맞추기').
//   판정 규칙은 바꾸지 않는다 — 불일치를 화면에 알리고 사용자가 수집 서버 매칭 또는 vCenter 할당 한쪽을 바꿔 원천을 하나로 맞춘다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectorDcMatch, dcConflictsOf } from '../src/routes/admin/collectorsDc.js';
import { stripComments } from './_stripComments.js';

const dcs = [{ id: 'pl', name: 'Poland' }, { id: 'nj', name: 'New Jersey' }, { id: 'PL-WAW', name: 'Warsaw' }];

test('불일치 — 수집 서버 법인(사용자 매칭 · 이름 맞춤)과 그 vCenter(등록부 · 원격 서버)의 할당 법인이 다르면', () => {
  const cols = [
    { id: 'pl-edge', datacenterId: 'pl', vcenterId: 'vc-a' },            // vc-a → nj : 불일치
    { id: 'nj', vcenterId: 'vc-b' },                                     // 이름 맞춤 nj · vc-b → nj : 일치
    { id: 'x-edge', datacenter: 'Nowhere', vcenterId: 'vc-a' },          // 법인 미지정 → 불일치 아님
    { id: 'w-edge', datacenterId: 'pl-waw', vcenterId: 'vc-c' },         // 대소문자만 다른 할당 → 일치
    { id: 'r-edge', datacenterId: 'pl' },                                // 원격 서버의 vCenter vc-a(nj) · vc-z(할당 없음)
  ];
  const assign = { 'vc-a': 'nj', 'vc-b': 'nj', 'vc-c': 'PL-WAW' };
  const vcOfCollector = (cid) => (cid === 'r-edge' ? ['vc-a', 'vc-z'] : []);
  const m = collectorDcMatch(cols, dcs, { assign, vcOfCollector, vcName: (v) => ({ 'vc-a': 'vcenter-A' }[v] || '') });
  assert.deepEqual(m['pl-edge'].conflicts, [{ vcenterId: 'vc-a', vcenterName: 'vcenter-A', datacenterId: 'nj', datacenterName: 'New Jersey' }]);
  assert.equal(m.nj.conflicts, undefined);
  assert.equal(m['x-edge'].conflicts, undefined, '법인을 모르면 불일치가 아니다');
  assert.equal(m['w-edge'].conflicts, undefined, '대소문자만 다르면 같은 법인');
  assert.deepEqual(m['r-edge'].conflicts.map((c) => c.vcenterId), ['vc-a'], '원격 서버의 vCenter 도 본다 · 할당 없는 vCenter 는 제외');
  assert.deepEqual(m['pl-edge'].id, 'pl', '판정(매칭 결과)은 바꾸지 않는다');
  assert.deepEqual(collectorDcMatch(cols, dcs)['pl-edge'], { id: 'pl', via: 'manual' }, '문맥을 주지 않으면 예전 모양');
});

test('상한 · 빈 입력 — 불일치 목록은 8개까지 · 법인 없으면 빈 목록', () => {
  const assign = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`vc-${i}`, 'nj']));
  const many = dcConflictsOf({ id: 'e', vcenterId: 'vc-0' }, 'pl', { assign, vcOfCollector: () => Object.keys(assign), datacenters: dcs });
  assert.equal(many.length, 8);
  assert.deepEqual(dcConflictsOf({ id: 'e', vcenterId: 'vc-0' }, '', { assign }), []);
  assert.deepEqual(dcConflictsOf({ id: 'e', vcenterId: 'vc-0' }, 'pl', {}), []);
});

test('라우트 — 목록 · 매칭 저장 응답이 불일치 문맥(할당 · 원격 vCenter · 이름)으로 판정한다 · 해소 버튼은 기존 쓰기 경로', () => {
  const src = stripComments(fs.readFileSync(new URL('../src/routes/admin/collectorsDc.js', import.meta.url), 'utf8'));
  assert.equal((src.match(/listDatacenters\(\) \|\| \[\], dcMatchContext\(\)\)/g) || []).length, 2);
  const web = fs.readFileSync(new URL('../../web/src/views/Collectors.jsx', import.meta.url), 'utf8');
  assert.match(web, /putJson\('\/admin\/datacenters\/assign', \{ entries: \[\{ vcenterId: ch\.vcenterId, datacenterId: ch\.datacenterId \}\] \}\)/);
  assert.match(web, /onClick=\{\(\) => saveDc\(c, ch\.toCollector\.datacenterId\)\}/);
});
