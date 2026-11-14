/**
 * 베어메탈 사용률 · 성능 엣지 대행 — **성공 왕복**(6단계 반증 F2). 실제 collector 라우터를 띄우고(같은 프로세스가 엣지 역할) 실제 수집 서버 등록부에 그 주소를 올린 뒤
 *   중앙의 **실제 pull 함수**로 경로마다 ok=true 와 정제된 본문을 받는지 본다.
 *
 * 왜 이 파일이 생겼나(정정 기록): `central/edgePull.js pullFromEdge` 의 기본 본문 판정은 봉투(`/bm-usage`)의 `{ok, node}` 모양이다. 추이 · 장치 · NIC(3a v2.922) ·
 *   변경 · 베이스라인 · 구간 비교(5단계 v2.929) · 비교 계열(6단계) 응답에는 node 가 없어 **성공 응답이 전부 bad-body** 로 버려졌다. 기존 테스트는
 *   ① pullBmTrend 를 의존성 주입으로 바꿔 끼우거나(bmPerf2921 — 가짜가 바로 `{ok:true, body}` 를 돌려줬다) ② 구버전(401 · 404) 경로만 부르거나(bmPerf2929Focus ⑥ · bmPerfStage6Compare ③)
 *   ③ collector 경로를 직접 fetch 해(중앙 pullFromEdge 를 거치지 않음) 성공 왕복이 한 번도 실행되지 않았다. 데모(mock) 엣지는 이 경로들에 합성 응답이 없어 화면 판독도 닿지 않았다.
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmrt-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.COLLECTOR_TOKEN = 'tok-roundtrip';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

test('엣지 대행 성공 왕복 — 봉투 · 추이 · 장치 · NIC · 변경 · 베이스라인 · 구간 비교 · 비교 계열 · 스냅샷 · 집중 · 목표선 · 서버 비교(엣지 열)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  // 포트 9(discard) — 연결이 바로 거부된다(스냅샷 · 집중은 ‘업무 결과 code’ 로 돌아온다: 왕복 자체가 검사 대상).
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-a1', name: 'bm-a1', serviceTag: 'TAGA1', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const db = await import('../src/bmusage/db.js');
  const { config } = await import('../src/config.js');
  const rows = [];
  for (let i = 0; i < 12; i++) { const ts = NOW - HOUR + (i + 1) * 300_000; rows.push({ key: 'TAGA1', ts, cpu_pct: 20 + i, mem_pct: 40, disk_await_ms: 3, disk_await_ms_peak: 9, os_at: ts }); }
  await db.insertUsage(rows, config.agent?.name || '');
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'self-edge', name: 'self-edge', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-roundtrip' }).ok, true);
  const E = await import('../src/central/bmUsageEdgePull.js');
  const O = await import('../src/central/bmPerfOpsPull.js');
  const C = await import('../src/central/bmComparePull.js');
  t.after(async () => { srv.close(); poller._setFleetForTest(null); E._resetForTest(); });
  const ok = (r, what) => assert.equal(r.ok, true, `${what}: ${JSON.stringify({ kind: r.kind, reason: r.reason, code: r.code }).slice(0, 300)}`);

  // ① 봉투(기본 판정 = node 가 있는 모양 — 이 경로만 node 가 있다)
  const env = await E.pullBmUsage('self-edge');
  ok(env, '봉투'); assert.ok(env.rec?.snap?.targets?.some((x) => x.key === 'TAGA1'));
  // ② 3a 추이 · 장치 · NIC — 실제 값이 정제를 거쳐 그대로
  const tr = await E.pullBmTrend('self-edge', { mode: 'history', key: 'TAGA1', query: { metric: 'cpu_pct', from: NOW - HOUR, to: NOW, res: '5m' } });
  ok(tr, '추이'); assert.equal(tr.body.points.filter((p) => p.avg != null).length, 12); assert.equal(tr.body.points.at(-1).avg, 31);
  const pk = await E.pullBmTrend('self-edge', { mode: 'history', key: 'TAGA1', query: { metric: 'disk_await_ms', from: NOW - HOUR, to: NOW, res: '5m' } });
  ok(pk, '추이(피크)'); assert.equal(pk.body.points.at(-1).peak, 9);
  ok(await E.pullBmTrend('self-edge', { mode: 'devices', key: 'TAGA1' }), '장치 목록');
  ok(await E.pullBmTrend('self-edge', { mode: 'nics', key: 'TAGA1' }), 'NIC 최신');
  // ③ 5단계 변경 · 베이스라인 · 구간 비교
  const ch = await O.pullEdgePerfOps('self-edge', 'changes', { key: 'TAGA1', query: { from: NOW - HOUR, to: NOW } });
  ok(ch, '변경 이벤트'); assert.ok(Array.isArray(ch.body.events));
  const bl = await O.pullEdgePerfOps('self-edge', 'baseline', { key: 'TAGA1', query: { metric: 'cpu_pct', from: NOW - HOUR, to: NOW } });
  ok(bl, '베이스라인'); assert.ok(Array.isArray(bl.body.series));
  const cp = await O.pullEdgePerfOps('self-edge', 'compare', { key: 'TAGA1', query: { aFrom: NOW - HOUR, aTo: NOW - HOUR / 2, bFrom: NOW - HOUR / 2, bTo: NOW } });
  ok(cp, '구간 비교'); assert.ok(cp.body.metrics.length > 0);
  // ④ 6단계 비교 계열(요청 1개)
  const cs = await C.pullEdgeCompareSeries('self-edge', { key: 'TAGA1', metrics: ['cpu_pct', 'disk_await_ms'], from: NOW - HOUR, to: NOW });
  ok(cs, '비교 계열'); assert.equal(cs.body.metrics.cpu_pct.avg, 25.5); assert.equal(cs.body.metrics.disk_await_ms.peak, 9);
  // ⑤ 4단계 스냅샷 · 5단계 집중 — 업무 결과는 200 + code(왕복이 성공하면 code 가 ‘edge’ · ‘bad-body’ 가 아니다)
  const sl = await E.pullEdgeSnapshots('self-edge', { key: 'TAGA1' });
  assert.equal(sl.code, 'ok', JSON.stringify(sl).slice(0, 200)); assert.ok(Array.isArray(sl.snapshots));
  assert.equal((await E.pullEdgeSnapshots('self-edge', { key: 'NOPE' })).code, 'not-found', '대상 밖 키는 엣지가 not-found(왕복 성공)');
  const fl = await O.pullEdgeFocus('self-edge', { key: 'TAGA1' });
  assert.equal(fl.code, 'ok', JSON.stringify(fl).slice(0, 200)); assert.ok(Array.isArray(fl.sessions));
  const fs1 = await O.runEdgeFocus('self-edge', { key: 'TAGA1', reason: '왕복 시험', by: 'adm' });
  assert.notEqual(fs1.code, 'edge', JSON.stringify(fs1).slice(0, 200)); assert.ok(fs1.ok === true || typeof fs1.code === 'string');
  const st = await O.stopEdgeFocus('self-edge', { key: 'TAGA1', id: fs1.id || 'x' });
  assert.notEqual(st.code, 'edge', JSON.stringify(st).slice(0, 200));
  // ⑥ 라우트 수준 — 엣지 위임 서버로 보이게(이 노드 대상 없음 + 엣지 보관분) 목표선 · 서버 비교가 실제 pull 함수로 계열을 받는다
  const edgeDeps = { currentTargets: async () => ({ targets: [] }), listEdgeBmUsage: async () => [{ agent: 'self-edge', snapAt: Date.now(), snap: { targets: [{ key: 'TAGA1', name: 'bm-a1', vcenterId: 'vcA', osHost: '127.0.0.1' }], rows: [] } }] };
  const req = (params, query) => ({ user: { username: 'adm', role: 'admin', scope: null }, params, query });
  const { bmSloView } = await import('../src/routes/api/bmPlaybookSlo.js');
  const slo = await bmSloView(req({ key: 'TAGA1' }, { from: String(NOW - HOUR), to: String(NOW) }), {}, edgeDeps);
  assert.equal(slo.via, 'edge'); assert.ok(slo.items.length > 0);
  for (const it of slo.items) assert.equal(it.error, undefined, `목표 ${it.goal.metric}: ${it.error}`);
  const aw = slo.items.find((x) => x.goal.metric === 'disk_await_ms');
  assert.equal(aw.valid, 12, '엣지 계열 12주기'); assert.equal(aw.status, 'met', '피크 9ms < 10ms');
  const { bmCompareView } = await import('../src/routes/api/bmCompare.js');
  const cv = await bmCompareView(req({}, { keys: 'TAGA1', from: String(NOW - HOUR), to: String(NOW), metrics: 'cpu_pct' }), {}, { ...edgeDeps, minEdgeVersion: async () => '0.0.0' });
  const col = cv.columns.find((x) => x.key === 'TAGA1');
  // 보관분에 최신 행이 없어 판정 칸은 ‘표본 없음’ 이지만, 계열은 엣지에서 실제로 받아 왔다(예전에는 bad-body 사유로 비었다).
  assert.equal(col.via, 'edge'); assert.ok(col.seriesAt, JSON.stringify(col).slice(0, 300)); assert.equal(col.series?.cpu_pct?.avg, 25.5, '엣지 열에 계열 값');
  assert.equal(col.reason, undefined, '엣지 계열 사유 없음(예전: 응답 형식이 다릅니다)');
});
