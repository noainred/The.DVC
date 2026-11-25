/**
 * rebut149.test.js — 149회차: 147회차(143 결정 D1 — REST 수집 vCenter 를 스냅샷 이력 추이에서 ‘뺀 vCenter’ 로) 반증의 전제 고정.
 *   147 은 기록 상태 'no-snap' 을 점검중 · 비활성처럼 그날 묶음에서 뺀다(history.excludeKindOf). 이것이 일시 실패를 숨기지 않으려면
 *   'no-snap' 이 **REST 수집(스냅샷 개수를 받지 않는 수집 방식)일 때만** 기록돼야 하고, REST 이면서 못 읽음 · 낡음 · 첫 수집 중 · 비활성 · 점검중인 vCenter 는
 *   그 사유가 이겨야 한다(view.vcReadIssue 의 순서). 149 는 이 전제를 실제 기록 경로(dayRecord)로 전수 대조했다 — 어긋남 0.
 *   이 순서를 바꾸면(예: REST 를 먼저 보면) 엣지가 낡은 REST 위임 vCenter 의 날이 ‘빠진 날’ 이 아니라 ‘뺀 날’ 이 되어 추이에서 조용히 사라진다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dayRecord } = await import('../src/snaphist/record.js');
const { excludeKindOf, aggregateDays } = await import('../src/snaphist/history.js');

const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000;

test('no-snap 은 REST 수집일 때만 · REST 여도 못 읽음 · 낡음 · 첫 수집 중 · 비활성 · 점검중은 그 사유(빠진 날 또는 점검중) — 전수 대조', () => {
  const statuses = ['connected', 'unreachable', 'maintenance', 'pending', 'disabled', 'error'];
  const sources = [undefined, 'rest', 'site', 'soap'];
  const methods = [undefined, 'rest', 'soap'];
  let n = 0;
  for (const status of statuses) for (const stale of [false, true]) for (const maint of [false, true]) for (const src of sources) for (const method of methods) {
    const vc = { id: 'v1', name: 'V', status, ...(stale ? { stale: true } : {}), ...(maint ? { maintenance: true } : {}),
      ...(src ? { collectSource: src } : {}), ...(method ? { collectMethod: method } : {}) };
    const got = dayRecord({ vcenters: [vc], vms: [{ id: 'v1:a', vcenterId: 'v1', name: 'a', snapshotCount: 0 }] }, { now: NOW }).perVc[0].status;
    const rest = src === 'rest' || method === 'rest';
    const why = status === 'maintenance' || maint ? 'maintenance' : status === 'unreachable' ? 'unreachable' : stale ? 'stale'
      : status === 'pending' ? 'pending' : status === 'disabled' ? 'disabled' : rest ? 'no-snap' : 'ok';
    assert.equal(got, why, JSON.stringify(vc));
    // 추이에서 빼는 것은 점검중 · 비활성 · REST 뿐 — 일시 실패(unreachable · stale · pending)는 빠진 날
    assert.equal(!!excludeKindOf(got), ['maintenance', 'disabled', 'no-snap'].includes(got), got);
    n += 1;
  }
  assert.equal(n, 6 * 2 * 2 * 4 * 3);
});

test('REST 이면서 낡은 위임 vCenter 의 날은 빠진 날(missing) — 뺀 날(excluded)이 아니다', () => {
  const vc = { id: 'e1', name: 'E', status: 'connected', collectSource: 'site', collectMethod: 'rest', stale: true };
  const st = dayRecord({ vcenters: [vc, { id: 'a1', name: 'A', status: 'connected' }], vms: [] }, { now: NOW }).perVc.map((r) => [r.vcenterId, r.status]);
  assert.deepEqual(st, [['e1', 'stale'], ['a1', 'ok']]);
  const day = '2026-11-10';
  const rows = [{ day, vcenter_id: 'e1', status: 'stale' }, { day, vcenter_id: 'a1', status: 'ok', vms: 1, snaps: 1, gb: 3, gb_unknown: 0, over: 0 }];
  const [p] = aggregateDays([day], rows, new Set(['e1', 'a1']), new Map([['e1', day], ['a1', day]]));
  assert.deepEqual([p.gb, p.missing, p.excluded, p.excludedRest], [null, 1, 0, 0]);
});
