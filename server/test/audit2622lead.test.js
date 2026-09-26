/*
 * v2.622 리드 통합분 — 그룹 수정(A~F) 밖에서 리드가 연결한 것.
 *   DATA-05 후속: computeUnprotected 가 판정 근거(logSettings·coveredVcenterIds)를 받게 됐는데 라우트가 넘기지 않으면
 *     수정은 동작하지 않는다(그룹 B leadTodo). 라우트가 둘 다 넘기는지 고정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('DATA-05 후속 · 미보호 VM 라우트는 로그 설정과 이벤트 커버리지를 computeUnprotected 에 넘긴다', () => {
  const s = stripComments(fs.readFileSync(path.join(here, '..', 'src', 'routes', 'api', 'reports.js'), 'utf8'));
  assert.match(s, /computeUnprotected\(scoped\.vms, rows, \{[^}]*logSettings: loadLogSettings\(\)[^}]*coveredVcenterIds[^}]*\}\)/);
  assert.match(s, /countCapped\(\{ vcenterId: vc\.id, since: lf\.since \}, 1\)/, '커버리지는 조회 창 기준');
});

test('DATA-05 후속 · 커버리지가 주어지면 이벤트 없는 vCenter 의 VM 은 미보호가 아니라 판정 불가', async () => {
  const { computeUnprotected } = await import('../src/reports/unprotected.js');
  const vms = [
    { id: 'a1', name: 'a1', vcenterId: 'vc-a', powerState: 'POWERED_ON' },
    { id: 'b1', name: 'b1', vcenterId: 'vc-b', powerState: 'POWERED_ON' },
  ];
  const r = computeUnprotected(vms, [], { logSettings: { enabled: true, minSeverity: 'info' }, coveredVcenterIds: new Set(['vc-a']) });
  assert.equal(r.summary.unprotectedCount, 1);
  assert.equal(r.summary.undeterminedCount, 1);
  assert.deepEqual(r.summary.noEventVcenters, ['vc-b']);
});
