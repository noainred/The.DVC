// 물리서버 기능 디버깅 회차 11 — 엣지 축 회귀(중앙 노드로 도는 별도 프로세스 · 11회차 엣지 축 재현 시험을 고친 판 기준으로 옮김).
//   엣지 urgent 의 곧 판정이 5회차(알림 발송 중)에 합류해 상한을 넘어 다시 잡혀도, 다시 잡은 판정은 곧(5초 바닥) 돈다 —
//   곧 판정 시작 때 판정 몫을 지우면 새 runOnce 가 없어 알림 대기(벽시계) × 20 으로 떨어졌다. 픽스처는 합성(127.0.0.1 가짜 웹훅 · 가짜 iDRAC).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dbg11edge-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const express = (await import('express')).default;
const whDelay = 3000; const whHits = [];
const wh = express(); wh.use(express.json({ limit: '1mb' }));
wh.post('/hook', (req, res) => { whHits.push({ at: Date.now(), title: String(req.body?.title || req.body?.text || JSON.stringify(req.body || {})) }); setTimeout(() => res.json({ ok: true }), whDelay); });
const wsrv = await new Promise((r) => { const s = wh.listen(0, '127.0.0.1', () => r(s)); });
after(() => { wsrv.closeAllConnections?.(); wsrv.close(); });
fs.writeFileSync(path.join(tmp, 'alerts.json'), JSON.stringify({ channels: { webhook: { enabled: true, url: `http://127.0.0.1:${wsrv.address().port}/hook` } }, suppressWindowMin: 0 }));
Object.assign(process.env, { CONFIG_DIR: tmp, DB_DIR: tmp, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', AUTH_ENABLED: 'false', PARTFAULT_ENABLED: 'true', PARTFAULT_HOOK_DEBOUNCE_MS: '1000' });
delete process.env.CENTRAL_URL;
const judges = []; let caps = 0;
const ol = console.log.bind(console); const ow = console.warn.bind(console);
console.log = (...a) => { const s = a.map(String).join(' '); if (s.startsWith('[partfault] 점검(')) judges.push({ at: Date.now(), opened: Number((s.match(/신규 (\d+)/) || [])[1] || 0), reason: (s.match(/점검\(([^)]*)\)/) || [])[1] }); ol(...a); };
console.warn = (...a) => { const s = a.map(String).join(' '); if (s.includes('5회 연속')) caps += 1; ow(...a); };
const edgeReport = (nOpen, urgent) => ({
  v: 2, agent: 'synth-site', version: '3.52.0', at: Date.now(), partIdents: 1, omitted: 0, scanned: { idrac: { devices: 1, ok: 1, failed: 0 } }, ...(urgent ? { urgent: true } : {}),
  devices: [{ scope: 'idrac', deviceId: 'synth-edge0', deviceKey: 'SYNTHEDGE0', deviceKeyKind: 'serviceTag', deviceName: 'synth-edge0', ok: true, reason: '', failedKinds: [], capped: false, notCollected: [],
    states: { ok: ['fan:FAN.1'], unknown: [], absent: [] },
    open: Array.from({ length: nOpen }, (_, k) => ({ kind: 'psu', partId: `PSU.EV.${k + 1}`, keyKind: 'name', state: 'fault', rawState: 'Critical', label: `PSU EV ${k + 1}`, detail: '' })) }],
});
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return !!fn(); };

test('엣지 urgent 의 곧 판정이 5회차(알림 중)에 합류해도 다시 잡은 판정은 곧(5초 바닥) 돈다 — 지금: 앞 회차 알림 대기 × 20(상한 60초) 뒤', async (t) => {
  const boxes = ['s1', 's2', 's3', 's4', 's5'];
  const psu = Object.fromEntries(boxes.map((b) => [b, 'OK']));
  const app = express();
  app.use('/bmc/:box', async (req, res) => {
    const box = req.params.box; const u = req.url.split('?')[0];
    if (u === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] });
    if (u === '/redfish/v1/Systems/System.Embedded.1') return res.json({ SKU: `SYNTH${box}`, SerialNumber: `SER${box}`, Model: 'PowerEdge R650', Manufacturer: 'Dell Inc.', PowerState: 'On', Status: { Health: 'OK' } });
    if (u === '/redfish/v1/Chassis') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Chassis/System.Embedded.1' }] });
    if (u.endsWith('/Power')) return res.json({ PowerControl: [{ PowerConsumedWatts: 300 }], PowerSupplies: [{ Name: 'PSU1', SerialNumber: `PSN-${box}`, Model: 'PWR', Status: { Health: psu[box], State: 'Enabled' } }] });
    if (u.endsWith('/Thermal')) return res.json({ Temperatures: [{ Name: 'Inlet', ReadingCelsius: 22 }], Fans: [{ Name: 'Fan1', Reading: 5000, Status: { Health: 'OK', State: 'Enabled' } }] });
    return res.json({ Members: [] });
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const { putEdgeReport } = await import('../src/central/partFaultEdge.js');
  const PF = await import('../src/partfault/poller.js');
  assert.equal((await putEdgeReport('synth-site', edgeReport(0, false))).ok, true);
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(boxes.map((b) => ({ id: b, name: `synth-${b}`, host: `${base}/bmc/${b}`, username: 'u', password: 'p', serviceTag: `SYNTH${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const E = await import('../src/idrac/eventSub.js');
  await P.pollNowManual();
  await new Promise((r) => setTimeout(r, 2500));   // 훅 판정(기준선) 지나가게
  PF._resetSoonForTest();
  E._resetEventsForTest();
  E._setEventDepsForTest({ debounceMs: 200, judgeFirstHoldMs: 10 });
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    const j0 = judges.length; const c0 = caps; const t0 = Date.now();
    // s1 0초 · s2 1초 · 그다음 3초마다 — 각 서버 장애가 진행 중 판정의 알림(3초) 안에 읽혀 판정이 5회차까지 이어진다
    const at = [0, 1000, 4000, 7000, 10000];
    for (let i = 0; i < boxes.length; i += 1) {
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + at[i] - Date.now())));
      psu[boxes[i]] = 'Critical';
      E.acceptEvents(s, { context: E.contextOf(s, boxes[i]), events: [{ sev: 'critical' }] });
    }
    // 4회차가 끝나면(판정 줄 4개) 5회차가 알림을 보내는 중 — 그 1초 뒤 엣지 urgent 보고(수신 라우트가 하는 것: putEdgeReport + runPartFaultsSoon)
    assert.ok(await waitFor(() => judges.length - j0 >= 4, 30_000), '판정이 4회차까지 이어짐');
    await new Promise((r) => setTimeout(r, 1000));
    const tE = Date.now();
    await putEdgeReport('synth-site', edgeReport(1, true)); PF.runPartFaultsSoon('edge-event');
    const ok = await waitFor(() => whHits.some((h) => h.at >= tE && h.title.includes('synth-edge0')), 70_000);
    const hit = whHits.find((h) => h.at >= tE && h.title.includes('synth-edge0'));
    const lat = (hit?.at ?? Date.now()) - tE;
    assert.ok(caps - c0 >= 1, `5회 상한 경고 ${caps - c0}번 — 이 장면은 상한 회차에 합류해야 재현`);
    // 기대: 5회차 남은 알림(≤ 3초) + 5초 바닥 + 여유 = 12초 안
    assert.ok(ok && lat < 12_000, `엣지 urgent → 그 장애 알림 ${ok ? `${lat}ms` : '70초 안에 없음'}(기대 < 12,000ms) · 판정 ${judges.slice(j0).map((j) => `${((j.at - t0) / 1000).toFixed(1)}s(${j.reason})`).join(' · ')}`);
  } finally { E._setEventDepsForTest(null); await new Promise((r) => setTimeout(r, 4_000)); E._resetEventsForTest(); }
});
