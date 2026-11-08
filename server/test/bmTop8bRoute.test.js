/**
 * 리눅스 성능 8b단계 ⑳ — 프로세스 Top-N **실제 라우터 · 엣지 대행 성공 왕복**(6단계 반증 F2 규약 — 실제 collector 라우터 ↔ 실제 pullEdgeTop · pullEdgeTopBand · bodyOk 명시).
 *   ① 엣지 대행: collector /bm-usage/top · /top/band ↔ central 당김 — 실제 저장 값이 정제를 지나 돌아온다 · 대상 밖 키 404(bad-body 아님) · 봉투 모양은 본문이 아니다
 *   ② 중앙 라우트: 이 노드 서버(로컬) · 엣지 서버(대행) · 범위 밖 404 · 비관리자는 사용자 이름이 가림 토큰 · ts 없으면 400
 *   ③ 엣지 문자열 정제: comm · user 제어 · 양방향 문자 · 길이 · 엣지가 준 hint 는 버리고 다시 붙인다 · 시각 clamp · 상태 한 글자
 *   ④ 구버전 엣지(경로 없음) → old-version · 최소 버전은 릴리스 노트의 8b 표지(숫자를 박지 않는다)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bm8btopr-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.COLLECTOR_TOKEN = 'tok-8b-top';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const STEP = 300_000;
const NOW = Math.floor(Date.now() / STEP) * STEP - STEP;

const topOf = (pid, cpu, upS = 50_000) => ({ src: 'top', dtS: 1.1, clk: 100, pageKb: 4, uptimeS: upS, nproc: 300, nrun: 2, nd: 1, cpuTotal: cpu + 3, candidates: 1,
  cpu: [{ pid, user: 'gpadmin', state: 'R', comm: 'postgres', cpu, cpuS: 500, start: 10, rssKb: 4000, rd: 2000, wr: 1000, ioPerm: false }],
  mem: [{ pid, user: 'gpadmin', rssKb: 4000, state: 'R', etimes: 49_990, comm: 'postgres', start: 10 }], io: [], ioPerm: 0, ioUnknown: 0, unparsed: 0, capped: false });

test('① ② 엣지 대행 왕복 · 중앙 라우트 · 범위 · 가림', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [{ id: 'o-t1', name: 'bm-t1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] }] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true }, osSsh: true, idracTelemetry: false }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [{ serverId: 's-t1', name: 'bm-t1', serviceTag: 'TTAG1', vcenterId: 'vcA' }], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { config } = await import('../src/config.js');
  const agent = config.agent?.name || '';
  const TS = await import('../src/bmusage/topStore.js');
  TS._resetTopStoreForTest();
  await TS.topWriteBatch({ agent, items: [{ key: 'TTAG1', ts: NOW - STEP, top: topOf(4242, 40, 50_000) }, { key: 'TTAG1', ts: NOW, top: topOf(4242, 75, 50_300) }] });
  // 엣지 역할 — 같은 프로세스의 collector 라우터
  const express = (await import('express')).default;
  const { collectorRouter } = await import('../src/routes/collector.js');
  const app = express(); app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'top-edge', name: 'top-edge', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-8b-top' }).ok, true);
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const P = await import('../src/central/bmTopPull.js');
  const r = await P.pullEdgeTop('top-edge', 'TTAG1', { ts: NOW });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.body.rows.cpu[0].pid, 4242); assert.equal(r.body.rows.cpu[0].val, 75); assert.equal(r.body.rows.cpu[0].hint, 'gpdb'); assert.equal(r.body.rows.cpu[0].cont, true);
  assert.equal(r.body.sample.ts, NOW); assert.equal(r.body.prevTs, NOW - STEP);
  const b = await P.pullEdgeTopBand('top-edge', 'TTAG1', { from: NOW - 3_600_000, to: NOW + 1 });
  assert.equal(b.ok, true, JSON.stringify(b).slice(0, 300)); assert.equal(b.body.res, '5m'); assert.equal(b.body.points.length, 2); assert.deepEqual(b.body.comms, ['postgres']);
  const nf = await P.pullEdgeTop('top-edge', 'NOPE', { ts: NOW });
  assert.equal(nf.ok, false); assert.notEqual(nf.kind, 'bad-body', '대상 밖 키는 엣지가 404 로 답한다(왕복 성공)');
  assert.equal(P.topPointBodyOk({ ok: true, node: {} }), false, '봉투 모양은 점 본문이 아니다'); assert.equal(P.topBandBodyOk({ ok: true, node: {} }), false);

  // ② 중앙 라우트 — 이 노드 서버(로컬) · 엣지 서버(대행 — 엣지 보관분 대상) · 범위 밖 404 · 가림
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('top-edge', { ok: true, snap: { targets: [{ key: 'EKEY1', name: 'bm-e1', vcenterId: 'vcB' }], topVer: 1 } });
  t.after(() => E._resetForTest());
  const R = await import('../src/routes/api/bmTop.js');
  const adm = { user: { username: 'adm', role: 'admin', scope: null }, query: { ts: String(NOW) }, params: { key: 'TTAG1' } };
  const lp = await R.bmTopPoint(adm, {});
  assert.equal(lp.via, 'local'); assert.equal(lp.rows.cpu[0].user, 'gpadmin', '관리자 = 사용자 이름 원문');
  const op = { user: { username: 'op', role: 'operator', scope: null }, query: { ts: String(NOW) }, params: { key: 'TTAG1' } };
  const mp = await R.bmTopPoint(op, {});
  assert.notEqual(mp.rows.cpu[0].user, 'gpadmin', '비관리자 = 가림 토큰'); assert.equal(mp.userHidden, true); assert.equal(mp.rows.cpu[0].comm, 'postgres', 'comm 은 본문 — 그대로');
  const ep = await R.bmTopPoint({ ...adm, params: { key: 'EKEY1' } }, {}, { pullTop: async (a, k, o) => ({ ok: true, body: { ok: true, key: k, sample: { ts: o.ts }, rows: { cpu: [], mem: [], io: [] }, agent: a } }) });
  assert.equal(ep.via, 'edge'); assert.equal(ep.agent, 'top-edge');
  const opA = { user: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } }, query: { ts: String(NOW) }, params: { key: 'EKEY1' } };
  assert.equal((await R.bmTopPoint(opA, {})).__status, 404, '범위 밖(vcB) 서버 = 404(존재 은닉)');
  assert.equal((await R.bmTopPoint({ ...adm, query: {} }, {})).__status, 400, 'ts 없으면 400');
  const bv = await R.bmTopBandView({ ...adm, query: { from: String(NOW - 3_600_000), to: String(NOW + 1) } }, {});
  assert.equal(bv.ok, true); assert.equal(bv.points.length, 2);
  assert.equal((await R.bmTopBandView({ ...adm, query: { from: '5', to: '1' } }, {})).__status, 400);
});

test('③ 엣지 문자열 정제(순수)', async () => {
  const P = await import('../src/central/bmTopPull.js');
  const now = Date.now();
  const body = { ok: true, key: 'X', sample: { ts: now + 10 * 86_400_000, baseTs: now, same: 'yes', src: 'evil', nproc: '12', cpuTotal: '5.5' },
    rows: { cpu: [{ rank: 1, pid: 7, user: 'ro‮ot', comm: '##END\u0000\u001b[31m' + 'x'.repeat(500), val: '50', state: 'RR', hint: 'gpdb', ioPerm: 'true', startAt: now + 999_999_999 }, { pid: 'bad' }, null],
      mem: Array.from({ length: 30 }, (_, i) => ({ pid: i + 1, comm: 'a' })), evil: [{ pid: 1 }] }, prevTs: 'x' };
  const s = P.sanitizeTopPoint(body, 'X', now);
  assert.equal(s.sample.ts, now, '엣지 미래 시각은 수신 시각으로'); assert.equal(s.sample.same, false); assert.equal(s.sample.src, null); assert.equal(s.sample.nproc, 12); assert.equal(s.sample.cpuTotal, 5.5);
  const c = s.rows.cpu[0];
  assert.equal(s.rows.cpu.length, 1, '형식 밖 행은 버린다');
  assert.ok(!/[\u0000-\u001f‮]/.test(c.comm) && c.comm.length <= 64, `comm 정제(${JSON.stringify(c.comm)})`);
  assert.ok(!/‮/.test(c.user)); assert.equal(c.state, null, '상태는 한 글자만'); assert.equal(c.ioPerm, false, '불리언은 true 만');
  assert.equal(c.hint, null, '엣지가 준 hint 는 쓰지 않는다(중앙이 다시 붙인다 — 이 comm · user 는 단서 없음)');
  assert.equal(s.rows.mem.length, 5, '종류당 5행');
  assert.ok(!('evil' in s.rows));
  const band = P.sanitizeTopBand({ ok: true, key: 'X', res: '1h', comms: ['a\u0007', 'b', 'c', 'd', 'e', 'f', 'g'], points: [{ t: now, by: { 'a?': 3, zz: 9, b: 'x' }, other: '2' }, { t: 'bad' }] }, 'X', now);
  assert.equal(band.comms.length, 6); assert.deepEqual(band.points[0].by, { 'a?': 3 }, '띠 comm 은 목록 안 것만 · 수만'); assert.equal(band.points.length, 1);
});

test('④ 구버전 엣지 → old-version · 8b 최소 버전은 릴리스 노트 표지', async (t) => {
  const express = (await import('express')).default;
  const app = express();
  app.get('/api/collector/bm-usage', (req, res) => res.json({ ok: true, node: { agent: 'old', version: '2.900.0' } }));
  app.use((req, res) => res.status(404).json({ ok: false }));
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => srv.close());
  const reg = await import('../src/collector/registry.js');
  reg.addCollector({ id: 'old-top', name: 'old-top', url: `http://127.0.0.1:${srv.address().port}`, token: 'tok-8b-top' });
  const P = await import('../src/central/bmTopPull.js');
  const r = await P.pullEdgeTop('old-top', 'X', { ts: Date.now() });
  assert.equal(r.ok, false); assert.equal(r.kind, 'old-version', JSON.stringify(r));
  const F = await import('../src/central/featureMinEdgeVersion.js');
  assert.match(String(F.STAGE8B_TITLE_RE), /8b단계/);
  const tmp = path.join(DIR, 'notes8b.json');
  fs.writeFileSync(tmp, JSON.stringify({ notes: [{ version: '2.947.0', title: '리눅스 통합 성능 모니터링 8b단계(프로세스 Top-N · 저활용 · 전력/온도)' }, { version: '2.946.0', title: '리눅스 통합 성능 모니터링 8a단계' }] }));
  F._resetFeatureMinEdgeVersionForTest(F.STAGE8B_TITLE_RE);
  assert.equal(F.stage8bMinEdgeVersion({ notesFile: tmp }), '2.947.0');
  F._resetFeatureMinEdgeVersionForTest(F.STAGE8B_TITLE_RE);
  assert.equal(F.stage8bMinEdgeVersion({ notesFile: path.join(DIR, 'none.json'), fallback: () => '2.999.3' }), '2.999.3', '노트에 없으면 지금 판(숫자를 박지 않는다)');
  F._resetFeatureMinEdgeVersionForTest(F.STAGE8B_TITLE_RE);
  const src = fs.readFileSync(new URL('../src/central/bmTopPull.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /minVersion: ['"]\d/, '최소 버전을 숫자로 박지 않는다');
});
