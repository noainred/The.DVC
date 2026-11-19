/**
 * 리눅스 성능 8a단계 — 용량 소진 예측 **실제 라우터 · 엣지 대행 성공 왕복**(6단계 반증 F2 규약 — 실제 collector 라우터 ↔ 실제 pullEdgeCapacity).
 *   ① 엣지 대행: collector `/bm-usage/capacity` ↔ central `pullEdgeCapacity`(bodyOk 명시) — 실제 마운트 일 롤업 · 일 롤업 값이 예측 · 계열 · 맞춤선으로 돌아온다 · 대상 밖 키 404
 *   ② 함대 표 라우트: 이 노드 결과 + 엣지 봉투 결과 · 범위(행 법인) · 출처 상태(구버전 · 아직 계산 전 · 손상)를 0 행이 아니라 표지로 · 다시 계산은 전체 범위만
 *   ③ 상세 라우트: 이 노드 서버는 그때 계산(계열 · 정비 창 제외 날짜) · 엣지 서버는 대행 · 범위 밖 404
 * 기준 시각: 실제 시각을 정시로 떨어뜨린 기준(제품이 실제 시각으로 자르는 기간 파일 — common.md).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8acapr-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.COLLECTOR_TOKEN = 'tok-8a-cap';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000; const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

test('① ② ③ 엣지 대행 왕복 · 함대 표 · 상세 · 범위 · 출처 표지', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: ['/data1'] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a1', name: 'bm-a1', serviceTag: 'CTAGA1', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { config } = await import('../src/config.js');
  const agent = config.agent?.name || '';
  // 20일 — 마운트 /data1 하루 +0.9%p · 메모리 평탄
  const M = await import('../src/bmusage/monthStore.js');
  const mounts = []; const rows = [];
  for (let b = 19; b >= 0; b -= 1) {
    const ts = NOW - b * DAY;
    mounts.push({ key: 'CTAGA1', ts, mount: '/data1', used_pct: 87.2 - b * 0.9, inode_pct: 4, size_bytes: 8e12, used_bytes: 7e12 });
    rows.push({ key: 'CTAGA1', ts, cpu_pct: 20, mem_pct: 55, os_at: ts });
  }
  await M.writeMountRows(mounts, agent);
  const db = await import('../src/bmusage/db.js');
  await db.insertUsage(rows, agent);
  // 엣지 역할 — 같은 프로세스의 collector 라우터
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'cap-edge', name: 'cap-edge', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-8a-cap' }).ok, true);
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const P = await import('../src/central/bmCapacityPull.js');
  const r = await P.pullEdgeCapacity('cap-edge', 'CTAGA1');
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  const fsRow = r.body.rows.find((x) => x.kind === 'fs' && x.res === '/data1');
  assert.equal(fsRow.status, 'forecast'); assert.equal(fsRow.slope, 0.9); assert.ok(fsRow.daysToTarget >= 3 && fsRow.daysToTarget <= 5, JSON.stringify(fsRow));
  assert.equal(r.body.rows.find((x) => x.kind === 'mem').status, 'no-growth', '평탄 메모리 = 증가 없음(안전으로 적지 않는다)');
  assert.ok(r.body.series['fs:/data1'].length >= 19); assert.ok(r.body.fits['fs:/data1'].slope > 0.8);
  const nf = await P.pullEdgeCapacity('cap-edge', 'NOPE');
  assert.equal(nf.ok, false); assert.notEqual(nf.kind, 'bad-body');
  assert.equal(P.capacityBodyOk({ ok: true, node: {} }), false, '봉투 모양은 상세 본문이 아니다');

  // ② 함대 표 — 이 노드 결과 + 엣지 봉투(대상 · 결과 · 구버전 · 아직 계산 전)
  const C = await import('../src/bmusage/capacity.js');
  assert.equal((await C.recomputeCapacity({ force: true })).ok, true);
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('edge-b', { ok: true, snap: { targets: [{ key: 'BT1', name: 'bm-b1', vcenterId: 'vcB' }], capacityVer: 1, capacity: { at: NOW, day: '2026-11-06', rows: [{ key: 'BT1', kind: 'fs', res: '/', status: 'forecast', daysToTarget: 2, current: 88 }] } } });
  E.putEdgeBmUsage('edge-old', { ok: true, snap: { targets: [{ key: 'OT1', name: 'bm-o', vcenterId: 'vcA' }] } });
  E.putEdgeBmUsage('edge-new', { ok: true, snap: { targets: [{ key: 'NT1', name: 'bm-n', vcenterId: 'vcA' }], capacityVer: 1 } });
  t.after(() => E._resetForTest());
  const { bmCapacityFleet, bmCapacityDetail } = await import('../src/routes/api/bmCapacity.js');
  const adm = { user: { username: 'adm', role: 'admin', scope: null }, query: {}, params: {} };
  const f = await bmCapacityFleet(adm, { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] });
  assert.equal(f.ok, true);
  assert.ok(f.rows.some((x) => x.key === 'CTAGA1' && x.via === 'local'));
  assert.equal(f.rows[0].key, 'BT1', '도달일 순(2일 먼저)');
  assert.equal(f.summary.soon, 2, '7일 안 두 대(서버 수)');
  const src = Object.fromEntries(f.sources.map((s) => [s.node, s]));
  assert.equal(src['edge-old'].old, true, '구버전 엣지 = 표지(0 행이 아니라)'); assert.equal(src['edge-new'].none, true, '아직 계산 전 = 표지');
  const opA = { user: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, query: {}, params: {} };
  const fa = await bmCapacityFleet(opA, { vcenters: [{ id: 'vcA' }, { id: 'vcB' }] });
  assert.ok(fa.rows.every((x) => x.vcenterId === 'vcA'), '범위 계정은 자기 법인 행만');
  assert.ok(!fa.sources.some((s) => s.node === 'edge-b'), '범위 밖 노드 출처도 숨김');
  // ③ 상세 — 이 노드 서버 · 엣지 서버 · 범위 밖
  const d1 = await bmCapacityDetail({ ...adm, params: { key: 'CTAGA1' } }, {});
  assert.equal(d1.via, 'local'); assert.ok(d1.series['fs:/data1'].length >= 19);
  const d2 = await bmCapacityDetail({ ...adm, params: { key: 'BT1' } }, {}, { pullEdgeCapacity: async (a, k) => ({ ok: true, body: { ok: true, key: k, rows: [], series: {}, fits: {} } }) });
  assert.equal(d2.via, 'edge'); assert.equal(d2.agent, 'edge-b');
  assert.equal((await bmCapacityDetail({ ...opA, params: { key: 'BT1' } }, {})).__status, 404);
});
