/**
 * v2.421 — PowerStore '접속은 되는데 용량 수집이 안 됨' 수정: 공간 지표 구간 폴백·CSRF 재확보·시도 내역 진단·
 * physical_total 없는 점을 'ok + 0 TB' 로 위장하지 않기·HTTP 오류 본문 사유.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('fetchSpaceMetrics: One_Day 가 값 없는 점만 주면 One_Hour → Five_Mins 순으로 시도하고 시도 내역을 남긴다', async () => {
  const { fetchSpaceMetrics } = await import('../src/storage/collectors/powerstore.js');
  const calls = [];
  const post = async (_p, body) => {
    calls.push(body.interval);
    if (body.interval === 'One_Day') return [{ timestamp: '2026-09-07T00:00:00Z', physical_total: 0, physical_used: 0 }];
    if (body.interval === 'One_Hour') return [{ timestamp: '2026-09-07T23:00:00Z', physical_total: 100e12, physical_used: 40e12 }];
    return [];
  };
  const r = await fetchSpaceMetrics({ post, csrf: 't', get: async () => { throw new Error('HTTP 404'); }, entity: 'space_metrics_by_cluster', entityId: '0' });
  assert.deepEqual(calls, ['One_Day', 'One_Hour']);
  assert.equal(r.debug.source, 'generate'); assert.equal(r.debug.interval, 'One_Hour');
  assert.ok(r.debug.tried[0].includes('One_Day') && r.debug.tried[0].includes('physical_total 없음'));
  assert.equal(r.points[0].physical_used, 40e12);
});

test('fetchSpaceMetrics: CSRF 거부(403/422 token)면 login_session 에서 토큰을 받아 1회 재시도', async () => {
  const { fetchSpaceMetrics } = await import('../src/storage/collectors/powerstore.js');
  const seen = [];
  const post = async (_p, _b, h) => {
    seen.push(h['DELL-EMC-TOKEN'] || null);
    if (h['DELL-EMC-TOKEN'] !== 'fresh') throw new Error('HTTP 422 — CSRF token missing');
    return [{ physical_total: 10, physical_used: 1 }];
  };
  const rawGet = async (p) => { assert.equal(p, '/api/rest/login_session'); return { body: {}, headers: new Headers({ 'DELL-EMC-TOKEN': 'fresh' }) }; };
  const r = await fetchSpaceMetrics({ post, csrf: null, get: async () => { throw new Error('HTTP 404'); }, rawGet, entity: 'space_metrics_by_cluster', entityId: '0' });
  assert.deepEqual(seen, [null, 'fresh']);
  assert.ok(r.debug.tried.some((t) => /login_session 에서 CSRF 토큰 재확보/.test(t)));
  assert.equal(r.points[0].physical_total, 10);
});

test('fetchSpaceMetrics: generate·GET 전부 실패하면 시도 내역이 붙은 오류; 값 없는 점만 있으면 그 점을 돌려 정직 표기', async () => {
  const { fetchSpaceMetrics } = await import('../src/storage/collectors/powerstore.js');
  await assert.rejects(
    fetchSpaceMetrics({ post: async () => { throw new Error('HTTP 400 — bad'); }, csrf: 't', get: async () => { throw new Error('HTTP 404'); }, entity: 'space_metrics_by_cluster', entityId: '0' }),
    (e) => /HTTP 400 — bad \[시도: generate One_Day: HTTP 400 — bad · generate One_Hour/.test(e.message) && /GET space_metrics_by_cluster: HTTP 404/.test(e.message),
  );
  const r = await fetchSpaceMetrics({ post: async () => [{ timestamp: 'x', logical_used: 5 }], csrf: 't', get: async () => { throw new Error('HTTP 404'); }, entity: 'space_metrics_by_cluster', entityId: '0' });
  assert.equal(r.points[0].logical_used, 5); assert.equal(r.debug.interval, null);
});

test('normalizePowerstore: 점은 있는데 physical_total 이 없으면 capacity 섹션 오류(0 TB 정상 위장 금지) + spaceDebug', async () => {
  const { normalizePowerstore } = await import('../src/storage/collectors/powerstore.js');
  const snap = normalizePowerstore({ id: 'ps', type: 'powerstore', name: 'PS' }, {
    cluster: [{ name: 'C', id: '0' }], sw: [{ release_version: '3.5.0.2' }],
    metrics: [{ timestamp: 't', entity: 'space_metrics_by_cluster', logical_used: 1 }],
    metricsDebug: { source: 'generate', interval: null, tried: ['generate One_Day: 1점(physical_total 없음)'] },
    nodes: [{ id: 'n1' }, { id: 'n2' }],
  });
  assert.equal(snap.ok, true, '구성은 됐으므로 ok(접속 성공)');
  assert.match(snap.sections.capacity, /^오류: 공간 지표 점 1개 중 physical_total 이 있는 점이 없음\(필드: timestamp,logical_used\)/);
  assert.equal(snap.capacity.totalBytes, 0);
  assert.equal(snap.extra.spaceDebug.tried.length, 1);
});

test('httpFailMessage: PowerStore 오류 본문(messages[].message_l10n)을 사유로 붙이고 비밀번호는 마스킹', async () => {
  const { httpFailMessage } = await import('../src/storage/collectors/restCommon.js');
  const res = new Response(JSON.stringify({ messages: [{ code: '0xE0101001', severity: 'Error', message_l10n: 'Invalid interval for entity space_metrics_by_cluster' }] }), { status: 422 });
  assert.equal(await httpFailMessage(res), 'HTTP 422 — Invalid interval for entity space_metrics_by_cluster');
  const plain = new Response('bad request s3cret here', { status: 400 });
  assert.equal(await httpFailMessage(plain, { password: 's3cret' }), 'HTTP 400 — bad request *** here');
  const empty = new Response('', { status: 500 });
  assert.equal(await httpFailMessage(empty), 'HTTP 500');
});
