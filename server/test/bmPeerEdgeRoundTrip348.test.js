/**
 * 물리서버 ‘같은 묶음 대비’(v3.48) 엣지 대행 — **성공 왕복**. 실제 collector 라우터를 띄우고(같은 프로세스가 엣지 역할) 실제 수집 서버 등록부에 그 주소를 올린 뒤
 *   중앙의 **실제 pull 함수**(central/bmPeerPull.js pullEdgePeerAvg)로 요청 1개에 서버 여러 대의 평균을 받는지 본다(bmEdgeRoundTrip 과 같은 틀 — 의존 주입 없이).
 *   · 토큰 없음 403 · keys 가 목록이 아니면 400 · 구간이 틀리면 400 · 대상 밖 키는 건너뛰고 수를 밝힌다 · 구버전 엣지(경로 없음 401/404)는 old-version(문구의 번호 = 릴리스 노트).
 * 기준 시각: 정시 −30분(v2.517 규약). 픽스처 식별자는 합성.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpeer-rt-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.COLLECTOR_TOKEN = 'tok-peer-rt';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }

test('엣지 대행 성공 왕복 — 요청 1개에 서버 여러 대의 24시간 평균 · 대상 밖 키는 수만 · 토큰 · 본문 검증 · 구버전 엣지', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  // OS 수집 등록(이름으로 함대 서버와 맞는다) — 포트 9(discard): 이 시험은 수집하지 않는다(대상 목록에 오르는 것만 필요)
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: ['a1', 'a2', 'a3'].map((x) => ({ id: `o-${x}`, name: `synth-${x}`, host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] })) }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'synth-a1', serviceTag: 'SYNTHA1', vcenterId: 'vcA' }, { serverId: 's-a2', name: 'synth-a2', serviceTag: 'SYNTHA2', vcenterId: 'vcA' },
    { serverId: 's-a3', name: 'synth-a3', serviceTag: 'SYNTHA3', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const db = await import('../src/bmusage/db.js');
  const { config } = await import('../src/config.js');
  // 지난 2시간 · 5분 간격 24점 — A1 은 CPU 40 %대 · A2 는 20 %대 · A3 는 계열 없음(평균 없음)
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const ts = NOW - 2 * HOUR + (i + 1) * 300_000;
    rows.push({ key: 'SYNTHA1', ts, cpu_pct: 40 + (i % 2), mem_pct: 60, os_at: ts });
    rows.push({ key: 'SYNTHA2', ts, cpu_pct: 20 + (i % 2), mem_pct: null, os_at: ts });
  }
  await db.insertUsage(rows, config.agent?.name || '');
  // 전력 — 실제 전력 DB(시간당 롤업)에 A1 의 24시간분(시간마다 400 · 420 W). 키는 함대 목록의 serverId(= iDRAC 등록부 id). 사용률의 iDRAC 경로는 꺼져 있다(idracTelemetry false)
  const idb = await (await import('../src/idrac/db.js')).getDb();
  idb.insertMany(Array.from({ length: 24 }, (_, h) => ({ serverId: 's-a1', watts: 400 + (h % 2) * 20, ts: NOW - 24 * HOUR + h * HOUR + 60_000 })));
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'self-edge', name: 'self-edge', url: base, token: 'tok-peer-rt' }).ok, true);
  const P = await import('../src/central/bmPeerPull.js');
  t.after(async () => { srv.close(); poller._setFleetForTest(null); });

  // ① 성공 왕복 — 요청 1개 · 서버 3대 + 대상 밖 1
  const r = await P.pullEdgePeerAvg('self-edge', { keys: ['SYNTHA1', 'SYNTHA2', 'SYNTHA3', 'NOPE'], from: NOW - 24 * HOUR, to: NOW });
  assert.equal(r.ok, true, JSON.stringify({ kind: r.kind, reason: r.reason }).slice(0, 300));
  assert.deepEqual(r.body.rows.map((x) => x.key), ['SYNTHA1', 'SYNTHA2', 'SYNTHA3']);
  assert.equal(r.body.unknown, 1, '대상 목록에 없는 키는 수만 밝힌다');
  const [a1, a2, a3] = r.body.rows;
  assert.equal(a1.cpu.avg, 40.5); assert.equal(a1.cpu.n, 24); assert.equal(a1.mem.avg, 60);
  assert.ok(a1.cpu.cov > 0 && a1.cpu.cov < 0.2, `2시간분의 점 — 24시간 중 구간 비율이 낮다(${a1.cpu.cov}) · 중앙 판정은 이 값을 하루 평균으로 보지 않는다`);
  assert.equal((await import('../src/bmcheck/peer.js')).avgValueOf(a1.cpu), null);
  assert.equal(a2.cpu.avg, 20.5); assert.equal(a2.mem.avg, null, '메모리를 못 읽은 서버 — 평균 없음(0 이 아니다)');
  assert.deepEqual([a3.cpu.avg, a3.cpu.n, a3.inletC], [null, 0, null], '계열이 없는 서버');
  assert.deepEqual(a3.power, { avg: null, n: 0, expected: 24, cov: 0 }, '전력 이력이 없는 서버 — 평균 없음(0 W 가 아니다)');
  assert.deepEqual(a1.power, { avg: 410, n: 24, expected: 24, cov: 1 }, '실제 전력 DB 의 시간당 롤업 → 24시간 평균(사용률의 iDRAC 경로가 꺼져 있어도 등록부 id 로 읽는다)');
  assert.equal((await import('../src/bmcheck/peer.js')).avgValueOf(a1.power), 410);
  assert.deepEqual([a1.inletC, a1.sensorAt], [null, null], '센서 표본이 없으면 흡기 온도는 없음');
  assert.deepEqual(Object.keys(a1).sort(), ['cpu', 'inletC', 'key', 'mem', 'power', 'sensorAt'], '줄에는 키와 수만(이름 · 주소 없음)');

  // ② 엣지 경로의 문 — 토큰 없음 · 본문 형식 · 구간
  const post = (body, headers = { 'X-Collector-Token': 'tok-peer-rt' }) => fetch(`${base}/api/collector/bm-usage/peer-avg`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ keys: ['SYNTHA1'], from: NOW - HOUR, to: NOW }, {})).status, 403, '토큰 없음');
  assert.equal((await post({ keys: 'SYNTHA1', from: NOW - HOUR, to: NOW })).status, 400, 'keys 는 목록');
  assert.equal((await post({ keys: ['SYNTHA1'], from: NOW, to: NOW - HOUR })).status, 400, '구간이 뒤집힘');
  assert.equal((await post({ keys: ['SYNTHA1'], from: NOW - 30 * 24 * HOUR, to: NOW })).status, 400, '구간 상한(8일)');
  const big = await post({ keys: Array.from({ length: 4000 }, (_, i) => `K${i}-${'x'.repeat(40)}`), from: NOW - HOUR, to: NOW });
  assert.equal(big.status, 413, '본문 상한(32KB) — 토큰이 맞아도');
  const raw = await (await post({ keys: ['SYNTHA1', 'SYNTHA1', 7], from: NOW - 24 * HOUR, to: NOW })).json();
  assert.deepEqual([raw.ok, raw.rows.length, raw.rows[0].key], [true, 1, 'SYNTHA1'], '중복 · 글자 아닌 키는 버린다');

  // ③ 구버전 엣지 — 경로 없음(401 · 404) → old-version · 문구의 최소 버전은 릴리스 노트에서
  const http = await import('node:http');
  const mk = (status) => new Promise((res) => { const sv = http.createServer((q, w) => { q.resume(); w.writeHead(status, { 'Content-Type': 'application/json' }); w.end('{"error":"x"}'); }); sv.listen(0, '127.0.0.1', () => res(sv)); });
  const s401 = await mk(401); const s404 = await mk(404);
  t.after(() => { s401.close(); s404.close(); });
  assert.equal(reg.addCollector({ id: 'edge-old401', name: 'edge-old401', url: `http://127.0.0.1:${s401.address().port}`, token: 'tok-old' }).ok, true);
  assert.equal(reg.addCollector({ id: 'edge-old404', name: 'edge-old404', url: `http://127.0.0.1:${s404.address().port}`, token: 'tok-old' }).ok, true);
  const V = (await import('../src/central/featureMinEdgeVersion.js')).peerMinEdgeVersion();
  for (const name of ['edge-old401', 'edge-old404']) {
    const old = await P.pullEdgePeerAvg(name, { keys: ['K1'], from: NOW - HOUR, to: NOW });
    assert.deepEqual([old.ok, old.kind], [false, 'old-version'], name);
    assert.ok(old.reason.includes(`v${V}`), `${name}: 문구의 최소 버전 = 릴리스 노트(없으면 지금 번호) — ${old.reason}`);
  }
  // 등록부에 없는 엣지
  assert.equal((await P.pullEdgePeerAvg('no-such-edge', { keys: ['K1'], from: NOW - HOUR, to: NOW })).kind, 'not-registered');
});
