/**
 * v2.514 — PowerStore 활성 알람 조회 회귀.
 *
 * 사용자 신고(2026-09-15, 운영 화면 캡처): `alerts: 오류: HTTP 400 — Unable to parse passed url.`
 *
 * 원인: v2.404~2.513 이 `?filter=state.eq.ACTIVE` 를 보냈다 — 그건 **Unity 문법**
 * (`unity.js:77` `/api/types/alert/instances?filter=state ne 2`)이고, PowerStore 는
 * PostgREST 계열이라 **필드명이 곧 쿼리 파라미터**(`?state=eq.ACTIVE`)다.
 *
 * 여기서 고정하는 것:
 *  · 보내는 URL 에 `filter=` 가 **없다**(재발 방지 — 이게 결함의 전부였다).
 *  · 필터가 거부돼도 알람 섹션이 죽지 않는다(필터 없이 받아 클라이언트에서 거른다).
 *  · 어느 경로를 썼는지 `debug` 로 밝힌다 — 조용히 다른 값을 보여주지 않는다.
 *  · 상한에 닿으면 `truncated` 로 밝힌다(조용한 상한 금지).
 *  · `state` 열이 없는 버전에서는 **거르지 않고 그 사실을 밝힌다** — 전부 버리는 것보다 정직하다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchActiveAlerts, ALERT_LIMIT, normalizePowerstore } from '../src/storage/collectors/powerstore.js';

/** 호출된 경로를 기록하는 가짜 GET. `reply` 가 함수면 그 결과(또는 throw)를 쓴다. */
const getter = (reply) => {
  const calls = [];
  const fn = async (path) => { calls.push(path); return reply(path, calls.length); };
  fn.calls = calls;
  return fn;
};

test('정상 경로 — PostgREST 문법(`state=eq.ACTIVE`)을 쓰고 `filter=` 를 쓰지 않는다', async () => {
  const get = getter(() => ([{ id: 'a1', severity: 'Critical', state: 'ACTIVE' }]));
  const r = await fetchActiveAlerts(get);
  assert.equal(get.calls.length, 1);
  assert.ok(!get.calls[0].includes('filter='), `Unity 문법이 되살아났다: ${get.calls[0]}`);
  assert.ok(get.calls[0].includes('state=eq.ACTIVE'), get.calls[0]);
  assert.equal(r.alerts.length, 1);
  assert.equal(r.debug.source, 'filtered');
  assert.equal(r.debug.truncated, false);
});

test('필터가 400 이면 필터 없이 받아 클라이언트에서 거른다(섹션이 죽지 않는다)', async () => {
  const get = getter((path) => {
    if (path.includes('state=eq.')) throw new Error('HTTP 400 — Unable to parse passed url.');
    return [
      { id: 'a1', severity: 'Critical', state: 'ACTIVE' },
      { id: 'a2', severity: 'Minor', state: 'CLEARED' },
      { id: 'a3', severity: 'Major', state: 'Active' },     // 대소문자 무시
    ];
  });
  const r = await fetchActiveAlerts(get);
  assert.equal(get.calls.length, 2);
  assert.deepEqual(r.alerts.map((a) => a.id), ['a1', 'a3']);
  assert.equal(r.debug.source, 'client-filtered');
  assert.match(r.debug.tried.join(' '), /400/, '실패 사유를 감추지 않는다');
});

test('`state` 열이 없는 버전은 거르지 않고 그 사실을 밝힌다(전부 버리지 않는다)', async () => {
  const get = getter((path) => {
    if (path.includes('state=eq.')) throw new Error('HTTP 400');
    return [{ id: 'a1', severity: 'Critical' }, { id: 'a2', severity: 'Minor' }];
  });
  const r = await fetchActiveAlerts(get);
  assert.equal(r.alerts.length, 2);
  assert.equal(r.debug.source, 'unfiltered', "거르지 못했다는 사실이 'unfiltered' 로 드러나야 한다");
});

test('모르는 상태값은 활성으로 센다 — 조용히 버리지 않는다', async () => {
  const get = getter((path) => {
    if (path.includes('state=eq.')) throw new Error('HTTP 400');
    return [{ id: 'a1', state: 'UNKNOWN_NEW_STATE' }, { id: 'a2', state: 'CLEARED' }];
  });
  const r = await fetchActiveAlerts(get);
  assert.deepEqual(r.alerts.map((a) => a.id), ['a1']);
});

test('상한에 닿으면 truncated 로 밝힌다(조용한 상한 금지)', async () => {
  const many = Array.from({ length: ALERT_LIMIT }, (_, i) => ({ id: `a${i}`, state: 'ACTIVE' }));
  const get = getter(() => many);
  const r = await fetchActiveAlerts(get);
  assert.equal(r.debug.truncated, true);
});

test('두 경로 모두 실패하면 던진다 — 오류를 0건으로 위장하지 않는다', async () => {
  const get = getter(() => { throw new Error('HTTP 503'); });
  await assert.rejects(() => fetchActiveAlerts(get), /503/);
});

test('normalize 가 alertsDebug 를 화면으로 올린다(spaceDebug 와 같은 규약)', () => {
  const snap = normalizePowerstore({ id: 'ps', type: 'powerstore', name: 'PS' }, {
    alerts: [{ id: 'a1', severity: 'Critical' }, { id: 'a2', severity: 'Minor' }],
    alertsDebug: { source: 'client-filtered', tried: ['x'], truncated: false },
  });
  assert.equal(snap.alerts.unresolved, 2);
  assert.equal(snap.sections.alerts, 'ok');
  assert.deepEqual(snap.extra.alertsBySeverity, { Critical: 1, Minor: 1 });
  assert.equal(snap.extra.alertsDebug.source, 'client-filtered');
});
