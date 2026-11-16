/**
 * 2차 공통 기능 점검 10회차: /summary 의 vCenter 별 행(byVcenter)이 '용량을 못 읽은 호스트' 수를 싣고(hostsCapacityUnknown),
 * Summary 화면의 vCenter 별 가상화율은 그때 판정하지 않는다 — 예전엔 분모(물리 코어 · RAM)만 부분 합이라 비율이 부풀었다.
 * 전체 합계(v2.771 R6-F3-2)는 이미 같은 규칙이었다. 판정은 store.hostCapacityKnown 하나.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8'));

test('서버 — vCenter 별 행에 hostsCapacityUnknown(hostCapacityKnown 판정)', () => {
  const s = read('server/src/routes/api/inventory.js');
  assert.match(s, /if \(!hostCapacityKnown\(h\)\) b\.capUnknown\+\+/);
  assert.match(s, /hostsCapacityUnknown: b\.capUnknown/);
});

test('화면 — Summary 비율 창은 용량 미상 호스트가 있는 vCenter 의 비율을 null 로', () => {
  const s = read('web/src/views/Summary.jsx');
  assert.match(s, /capUnknownOf\(vc\) > 0 \? null : ratioOrNull\(vc\.ramAllocatedGB, vc\.memTotalGB\)/);
  assert.match(s, /capUnknownOf\(vc\) > 0 \? null : ratioOrNull\(vc\.vcpuAllocated, vc\.cpuCores\)/);
});

test('화면(10회차 보완) — 물리 칸은 부분 합 표시(*) · 배지 툴팁은 미상 호스트 수를 말한다', () => {
  const s = read('web/src/views/Summary.jsx');
  assert.match(s, /\(key === 'cpuCores' \|\| key === 'memTotalGB'\) \? capUnknownTitle\(vc\) : null/);
  assert.match(s, /capUnknownTitle\(vc\) \|\| '물리 자원/);
});

test('virtRatioText — capUnknownOf · capUnknownTitle(못 읽은 값은 0 이 아니다 · 0 이하 · 글자는 미상 없음)', async () => {
  const m = await import('../../web/src/views/virtRatioText.js');
  assert.equal(m.capUnknownOf({ hostsCapacityUnknown: 2 }), 2);
  for (const v of [0, -1, null, undefined, '', 'x']) assert.equal(m.capUnknownOf({ hostsCapacityUnknown: v }), 0, String(v));
  assert.equal(m.capUnknownOf(null), 0);
  assert.equal(m.capUnknownTitle({ hostsCapacityUnknown: 0 }), null);
  assert.match(m.capUnknownTitle({ hostsCapacityUnknown: 3 }), /호스트 3대/);
});
