/**
 * 검토 I-03(v2.730) — 엣지가 push 한 OneFS 영역 요약을 중앙이 **아는 필드만** 받는다(실제 central 라우터).
 *
 * 새 필드(expectedEndpoints·attempted·notTriedEndpoints·partial·stopReason · extra.areasNotTriedEndpoints·areasPartial·
 * areasExpectedEndpoints)를 그대로 통과시키고, 구버전 엣지(필드 없음)는 **필드를 지어내지 않고** 그대로 둔다(화면이 구버전
 * 판정 규칙으로 떨어지게). 화면이 글자로 그리는 값(area·error·stopReason)이 객체면 React #31 로 상세 창이 죽으므로 좁힌다.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'tok-rvC-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'rvC-central-'));
process.env.CONFIG_DIR = CFG;
process.env.DB_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';

let srv; let base;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/central`;
});
after(() => { srv?.close(); try { fs.rmSync(CFG, { recursive: true, force: true }); } catch { /* */ } });

const post = (p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': TOKEN }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const NEW_AREAS = [
  { area: 'cluster', ok: 1, failed: 0, expectedEndpoints: 3, attempted: 1, notTriedEndpoints: 2, partial: true, stopReason: 'deadline' },
  { area: 'node', ok: 0, failed: 0, skipped: true, notTried: true, expectedEndpoints: 1, attempted: 0, notTriedEndpoints: 1, partial: false, stopReason: 'deadline', error: '영역 수집 시한 초과로 이번 주기에는 시도하지 않았습니다' },
  { area: 'file', ok: 0, failed: 0, skipped: true, error: '경로 인자가 필요한 namespace API' },
];
const LEGACY_AREAS = [
  { area: 'cluster', ok: 1, failed: 0 },
  { area: 'node', ok: 0, failed: 0, skipped: true, notTried: true, error: '영역 수집 시한 초과로 이번 주기에는 시도하지 않았습니다' },
];

test('새 필드는 그대로, 구버전 엣지의 요약은 필드를 지어내지 않는다', async () => {
  const { edgeStorageSnapshots } = await import('../src/central/storageEdge.js');
  const r = await post('/storage-data', { agent: 'edge-c1', devices: [
    { deviceId: 'isi-new', type: 'isilon', ok: true, collectedAt: Date.now(), extra: {
      areas: NEW_AREAS, areasAt: Date.now(), areasEndpoints: 1, areasExpectedEndpoints: 66,
      areasStopped: 'deadline', areasNotTried: 35, areasNotTriedEndpoints: 65, areasPartial: 1 } },
    { deviceId: 'isi-old', type: 'isilon', ok: true, collectedAt: Date.now(), extra: {
      areas: LEGACY_AREAS, areasAt: Date.now(), areasEndpoints: 1, areasStopped: 'deadline', areasNotTried: 35 } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rows = Object.fromEntries(edgeStorageSnapshots().filter((d) => d.agent === 'edge-c1').map((d) => [d.deviceId, d]));
  assert.deepEqual(rows['isi-new'].extra.areas, NEW_AREAS, '새 필드 왕복');
  assert.equal(rows['isi-new'].extra.areasNotTriedEndpoints, 65);
  assert.equal(rows['isi-new'].extra.areasPartial, 1);
  assert.equal(rows['isi-new'].extra.areasExpectedEndpoints, 66);
  assert.equal(rows['isi-new'].extra.areasNotTried, 35, '영역 개수 단위 그대로');
  assert.deepEqual(rows['isi-old'].extra.areas, LEGACY_AREAS, '구버전 요약은 바꾸지 않는다');
  assert.ok(!('expectedEndpoints' in rows['isi-old'].extra.areas[0]), '없는 필드를 지어내지 않는다(화면이 구버전 규칙으로 판정)');
  assert.ok(!('areasPartial' in rows['isi-old'].extra));
});

test('객체·이상 값은 좁히고, 모르는 필드는 담지 않으며, 뺀 원소 수를 밝힌다', async () => {
  const { edgeStorageSnapshots } = await import('../src/central/storageEdge.js');
  const r = await post('/storage-data', { agent: 'edge-c2', devices: [
    { deviceId: 'isi-bad', type: 'isilon', ok: true, collectedAt: Date.now(), extra: {
      areas: [null, 'x', 7, { area: { a: 1 } }, { ok: 1 },
        { area: 'cluster', ok: '1', failed: '0', expectedEndpoints: 3, attempted: '1', notTriedEndpoints: -2, partial: 'yes',
          stopReason: { y: 1 }, error: { x: 1 }, evil: { z: 1 }, data: { huge: true } }],
      areasStopped: { k: 1 }, areasNotTriedEndpoints: '5', areasPartial: -1, areasEndpoints: 'n/a', areasError: { e: 1 }, areasAt: Date.now() + 365 * 86_400_000 } },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = edgeStorageSnapshots().find((x) => x.deviceId === 'isi-bad');
  const ex = d.extra;
  assert.equal(ex.areas.length, 1, '객체가 아니거나 area 글자가 없는 원소는 뺀다');
  assert.equal(ex.areasDropped, 5, '뺀 개수를 밝힌다');
  const a = ex.areas[0];
  assert.deepEqual(Object.keys(a).sort(), ['area', 'attempted', 'error', 'expectedEndpoints', 'failed', 'notTriedEndpoints', 'ok', 'partial', 'stopReason'].sort());
  assert.equal(a.ok, 1); assert.equal(a.failed, 0); assert.equal(a.attempted, 1);
  assert.equal(a.notTriedEndpoints, null, '음수는 값이 아니다(0 으로 만들지 않는다)');
  assert.equal(a.partial, false, '불리언이 아니면 참으로 읽지 않는다');
  assert.equal(a.stopReason, null); assert.equal(a.error, null, '객체는 글자로 그릴 수 없다 — null');
  assert.equal(ex.areasStopped, null);
  assert.equal(ex.areasNotTriedEndpoints, 5);
  assert.equal(ex.areasPartial, null);
  assert.equal(ex.areasEndpoints, null);
  assert.equal(ex.areasError, null);
  assert.ok(ex.areasAt <= Date.now(), '엣지 시계의 미래 시각은 수신 시각으로 자른다');
});

test('정제는 멱등이다(보관 파일을 다시 읽을 때 같은 정제를 거쳐도 바뀌지 않는다)', async () => {
  const { narrowStorageSnapshot } = await import('../src/central/storageEdge.js');
  const snap = { deviceId: 's', extra: { areas: NEW_AREAS, areasStopped: 'deadline', areasNotTried: 35, areasNotTriedEndpoints: 65, areasPartial: 1, areasExpectedEndpoints: 66 } };
  const once = narrowStorageSnapshot(snap);
  assert.equal(once.narrowed, 0, '정상 값은 좁힌 것으로 세지 않는다');
  assert.deepEqual(narrowStorageSnapshot(once.snap).snap, once.snap);
  // 기존 계약(v2.607 CEN2607-02 · v2.680 F-06)이 그대로인지 — 영역 필드가 없는 스냅샷은 예전과 같은 결과
  const n = narrowStorageSnapshot({ deviceId: 's1', extra: { alertsNote: { a: 1 }, healthState: ['x'], clusterHealth: 'OK', versionRaw: { v: 1 } } });
  assert.equal(n.narrowed, 3);
  const p = narrowStorageSnapshot({ id: 'x', extra: { power: 'nope', areas: [{ area: 'cluster', ok: 1, failed: 0, error: { a: 1 } }] } });
  assert.equal(p.snap.extra.power, null);
  assert.deepEqual(p.snap.extra.areas, [{ area: 'cluster', ok: 1, failed: 0, error: null }], '전력 정제 경로에서도 영역 정제가 빠지지 않는다');
  assert.ok(p.narrowed >= 2);
});
