/**
 * 물리서버 ‘하드웨어 이벤트 로그’(v3.49) 엣지 대행 — **실제 왕복**. 실제 collector 라우터(같은 프로세스가 엣지 역할) + 가짜 iDRAC(Redfish SEL)를 같은 express 에 띄우고,
 *   실제 수집 서버 등록부에 그 주소를 올린 뒤 중앙의 **실제 pull 함수**(central/bmHwLogPull.js pullEdgeHwLog)로 받는다(bmPeerEdgeRoundTrip 과 같은 틀 — 의존 주입 없이).
 *   반증 A4(변이 M3 · M4 · M5 · M6 · M7 생존)를 닫는다: 꺼진 등록 · 없는 서버는 not-found(구버전과 가른다) · 경로 없는 엣지는 old-version · 같은 서버 60초 메모 · 열쇠(k) 대조.
 *   반증 A10: 장비가 오래된 것부터 주고 쪽 상한을 넘으면 끝쪽(가장 새 기록)부터 읽고 건너뛴 수를 밝힌다.
 * 픽스처 식별자 · 주소는 합성(SYNTH… · 192.0.2.x 문구).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmhwlog-rt-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
process.env.COLLECTOR_TOKEN = 'tok-hwlog-rt';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

const H0 = Date.UTC(2026, 10, 20);
const entries = (n, { desc = false } = {}) => {
  const a = Array.from({ length: n }, (_, i) => ({ Id: String(i), Created: new Date(H0 + i * 60_000).toISOString(), Severity: i % 5 ? 'OK' : 'Critical', Message: `evt m${i} from 192.0.2.${i % 250} on SYNTH01`, MessageId: `C${i}`, SensorType: 'Sys' }));
  return desc ? a.reverse() : a;
};
const SETS = { small: entries(120), big: entries(1024), bigDesc: entries(1024, { desc: true }) };

test('엣지 대행 왕복 — 성공 · 열쇠 대조 · 꺼진 등록 · 없는 서버(not-found) · 경로 없는 엣지(old-version) · 60초 메모 · 토큰 · 끝쪽부터 읽기', async (t) => {
  const express = (await import('express')).default;
  const bmc = { hits: [] };
  const app = express();
  // 가짜 iDRAC — /bmc/<묶음>/redfish/... (Members@odata.count · $skip 쪽 넘기기)
  app.use('/bmc/:set', (req, res) => {
    bmc.hits.push(`${req.params.set} ${req.method} ${req.url}`);
    if (req.params.set === 'auth') return res.status(401).json({ error: 'no' });
    if (req.url.startsWith('/redfish/v1/Managers') && !req.url.includes('LogServices')) return res.json({ Members: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] });
    const all = SETS[req.params.set] || [];
    const skip = Number((/\$skip=(\d+)/.exec(req.url) || [])[1] || 0);
    return res.json({ Members: all.slice(skip, skip + 50), 'Members@odata.count': all.length, ...(skip + 50 < all.length ? { 'Members@odata.nextLink': 'x' } : {}) });
  });
  const { collectorRouter } = await import('../src/routes/collector.js');
  app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  // 경로가 없는 엣지(구버전) — 모든 요청 404
  const oldApp = express(); oldApp.use((req, res) => res.status(404).send('Not Found'));
  const oldSrv = await new Promise((r) => { const s = oldApp.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); oldSrv.closeAllConnections?.(); oldSrv.close(); });

  const registry = await import('../src/idrac/registry.js');
  const invCache = await import('../src/idrac/invCache.js');
  const S = (id, set, extra = {}) => ({ id, name: `synth-${id}`, host: `${base}/bmc/${set}`, username: 'root', password: 'pw', ...extra });
  registry.importServers([
    S('s1', 'small', { serviceTag: 'SYNTH01' }), S('s2', 'small', { serviceTag: 'SYNTH02', enabled: false }), S('S3-Mixed', 'small'),
    S('s4', 'big', { serviceTag: 'SYNTH04' }), S('s5', 'bigDesc', { serviceTag: 'SYNTH05' }), S('s6', 'auth', { serviceTag: 'SYNTH06' }),
  ], 'replace');
  invCache.setInventory('S3-Mixed', { system: { serviceTag: 'INVTAG3' } });
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'self-edge', name: 'self-edge', url: base, token: 'tok-hwlog-rt' }).ok, true);
  assert.equal(reg.addCollector({ id: 'old-edge', name: 'old-edge', url: `http://127.0.0.1:${oldSrv.address().port}`, token: 'tok-hwlog-rt' }).ok, true);
  const P = await import('../src/central/bmHwLogPull.js');

  // ① 성공 — 가장 새 기록이 맨 위 · 주소 · 태그는 엣지가 가리지 않는다(가림은 중앙 라우트가 판본에 따라)
  const a = await P.pullEdgeHwLog('self-edge', { id: 's1' });
  assert.equal(a.ok, true, JSON.stringify(a).slice(0, 300));
  assert.deepEqual([a.body.status, a.body.read, a.body.total, a.body.rows.length, a.body.gap], ['ok', 120, 120, 120, 0]);
  assert.match(a.body.rows[0].msg, /evt m119 /);
  // ② 같은 서버를 열쇠(k = 태그 소문자)로 60초 안에 — 장비에 묻지 않는다(엣지 메모)
  bmc.hits = [];
  const a2 = await P.pullEdgeHwLog('self-edge', { k: 'synth01' });
  assert.deepEqual([a2.ok, a2.body.read, bmc.hits.length], [true, 120, 0], '엣지 60초 메모');
  // ③ 없는 서버 · ④ 꺼진 등록 — not-found(구버전과 가른다 · 장비에 묻지 않는다)
  bmc.hits = [];
  assert.equal((await P.pullEdgeHwLog('self-edge', { id: 'nope' })).kind, 'not-found');
  assert.equal((await P.pullEdgeHwLog('self-edge', { id: 's2' })).kind, 'not-found', '꺼진 등록은 읽지 않는다');
  assert.equal((await P.pullEdgeHwLog('self-edge', { k: 'synth02' })).kind, 'not-found');
  assert.equal(bmc.hits.filter((h) => h.startsWith('small')).length, 0);
  // ⑤ 열쇠 — 대문자 id 의 소문자 · 인벤토리 태그도 같은 서버
  assert.equal((await P.pullEdgeHwLog('self-edge', { k: 's3-mixed' })).ok, true);
  assert.equal((await P.pullEdgeHwLog('self-edge', { k: 'invtag3' })).ok, true);
  assert.equal((await P.pullEdgeHwLog('self-edge', { k: 'synth99' })).kind, 'not-found', '모르는 열쇠');
  // ⑥ 경로 없는 엣지 — old-version(not-found 로 오판하지 않는다)
  const old = await P.pullEdgeHwLog('old-edge', { id: 's1' });
  assert.equal(old.kind, 'old-version', JSON.stringify(old));
  // ⑦ 인자 없음 — 묻지 않는다
  assert.equal((await P.pullEdgeHwLog('self-edge', {})).kind, 'bad-args');
  // ⑧ 토큰이 먼저 · id · k 둘 다 없으면 400
  assert.equal((await fetch(`${base}/api/collector/bm-hwlog?id=s1`)).status, 403);
  assert.equal((await fetch(`${base}/api/collector/bm-hwlog`, { headers: { 'X-Collector-Token': 'tok-hwlog-rt' } })).status, 400);
  // ⑨ 인증 실패 — 상태로 돌려준다(던지지 않는다 · 엣지가 다시 시도하지 않는다)
  const au = await P.pullEdgeHwLog('self-edge', { id: 's6' });
  assert.deepEqual([au.ok, au.body.status, au.body.rows.length], [true, 'auth', 0]);
  // ⑩ 1,024 건 · 오래된 것부터 주는 장비 — 첫 쪽 뒤 끝쪽으로 건너뛰어 가장 새 기록을 읽는다 · 건너뛴 수를 밝힌다(반증 A10)
  const big = await P.pullEdgeHwLog('self-edge', { id: 's4' });
  assert.equal(big.ok, true);
  assert.match(big.body.rows[0].msg, /evt m1023 /, '가장 새 기록이 맨 위');
  assert.equal(big.body.read, 1000); assert.equal(big.body.gap, 24, '읽지 않은 가운데 수');
  assert.equal(big.body.total, 1024);
  // 새 것부터 주는 장비 — 건너뛰지 않는다(앞쪽이 가장 새 것) · 쪽 상한 표지
  const desc = await P.pullEdgeHwLog('self-edge', { id: 's5' });
  assert.deepEqual([desc.body.gap, desc.body.stopped], [0, 'max']);
  assert.match(desc.body.rows[0].msg, /evt m1023 /);
});
