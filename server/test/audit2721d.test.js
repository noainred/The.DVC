/**
 * audit2721d.test.js — v2.721(감사 R2-03): CVP KPI '스트리밍 아님' 은 not-streaming 판정 장비만이다.
 *   낡음·기록 없음·텔레메트리 실패로 확인 불가인 장비(스트리밍 중일 수 있다)를 '장비 − 스트리밍 중' 뺄셈으로 '스트리밍 아님' 에 넣지 않는다.
 *   서버 cvpTotals 의 notStreaming 은 unconfirmedBy['not-streaming'] 와 같아야 한다(웹 totalsFromDevices 와 같은 규칙).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const NOW = 1_790_000_000_000; // 고정 기준 시각(Date.now() 를 쓰지 않는다)
const IV = 300_000;
function dev(over = {}) {
  return { cvpId: 'c1', key: 'SN', hostname: 'sw', collectedAt: NOW - 60_000, streaming: true, telemetry: 'ok', cpuPct: 10, memPct: 10,
    partsList: [{ kind: 'psu', name: 'PSU1', state: 'ok' }], bgpPeers: [], ports: { total: 4, up: 4, down: 0 }, ...over };
}

test('R2-03 — 낡은 스트리밍 장비는 notStreaming 에 들지 않는다(서버)', async () => {
  const { cvpTotals } = await import('../src/routes/api/cvp.js');
  const t = cvpTotals([
    dev({ key: 'fresh' }),
    dev({ key: 'stale', collectedAt: NOW - 30 * 86_400_000 }),
    dev({ key: 'telfail', telemetry: 'failed' }),
    dev({ key: 'nostream', streaming: false }),
  ], { now: NOW, intervalMs: IV });
  assert.equal(t.devices, 4);
  assert.equal(t.streaming, 1);
  assert.equal(t.notStreaming, 1, '스트리밍 아님은 not-streaming 판정 1대뿐');
  assert.equal(t.notStreaming, t.unconfirmedBy['not-streaming']);
});

test('R2-03 — 서버 합계를 웹 kpiItems 에 넣으면 스트리밍 아님 1 · 확인 불가 2 로 말한다', async () => {
  const { cvpTotals } = await import('../src/routes/api/cvp.js');
  const { kpiItems } = await import('../../web/src/views/tools/cvpText.js');
  const t = cvpTotals([
    dev({ key: 'fresh' }),
    dev({ key: 'stale', collectedAt: NOW - 30 * 86_400_000 }),
    dev({ key: 'telfail', telemetry: 'failed' }),
    dev({ key: 'nostream', streaming: false }),
  ], { now: NOW, intervalMs: IV });
  const meta = kpiItems(t).find((k) => k.key === 'streaming').meta;
  assert.match(meta, /스트리밍 아님 1(?!\d)/);
  assert.match(meta, /확인 불가 2/);
});

test('R2-03 — 신선도 판정 없는 순수 합산도 streaming:false 를 notStreaming 으로 센다', async () => {
  const { cvpTotals } = await import('../src/routes/api/cvp.js');
  const t = cvpTotals([dev({ streaming: true }), dev({ streaming: false }), dev({ streaming: null })]);
  assert.equal(t.streaming, 1);
  assert.equal(t.notStreaming, 1);
});
