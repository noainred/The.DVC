// 물리서버 기능 디버깅 회차 9 — 엣지 축 회귀(중앙 노드로 도는 별도 프로세스 · 9회차 엣지 축 재현 시험을 고친 판 기준으로 옮김).
//   ① 중앙 ‘곧 판정’ 간격은 앞 판정의 이벤트 루프 활동 시간 기준 — 알림 웹훅 대기를 20배 하지 않는다(벽시계였던 8회차 판은 웹훅 1초 → 약 15초).
//   ② 중앙 노드의 이벤트 묶음은 마지막 판정(알림 발송 포함)을 기다리지 않고 끝난다 — 알림 채널이 느려도 다른 서버의 이벤트 읽기가 밀리지 않는다.
// 픽스처는 합성(127.0.0.1 가짜 웹훅 · 가짜 iDRAC).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dbg9edge-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const express = (await import('express')).default;
let whDelay = 1000; const whHits = [];
const wh = express(); wh.use(express.json({ limit: '1mb' }));
wh.post('/hook', (req, res) => { whHits.push(Date.now()); setTimeout(() => res.json({ ok: true }), whDelay); });
const wsrv = await new Promise((r) => { const s = wh.listen(0, '127.0.0.1', () => r(s)); });
after(() => { wsrv.closeAllConnections?.(); wsrv.close(); });
fs.writeFileSync(path.join(tmp, 'alerts.json'), JSON.stringify({ channels: { webhook: { enabled: true, url: `http://127.0.0.1:${wsrv.address().port}/hook` } }, suppressWindowMin: 0 }));
Object.assign(process.env, { CONFIG_DIR: tmp, DB_DIR: tmp, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', AUTH_ENABLED: 'false', PARTFAULT_ENABLED: 'true', PARTFAULT_HOOK_DEBOUNCE_MS: '1000' });
delete process.env.CENTRAL_URL;
const judges = [];
const ol = console.log.bind(console);
console.log = (...a) => { const s = a.map(String).join(' '); if (s.startsWith('[partfault] 점검(')) judges.push({ at: Date.now(), opened: Number((s.match(/신규 (\d+)/) || [])[1] || 0) }); ol(...a); };

const report = (nOpen, urgent) => ({
  v: 2, agent: 'synth-site', version: '3.52.0', at: Date.now(), partIdents: 1, omitted: 0, scanned: { idrac: { devices: 1, ok: 1, failed: 0 } }, ...(urgent ? { urgent: true } : {}),
  devices: [{ scope: 'idrac', deviceId: 'synth-srv0', deviceKey: 'SYNTHTAG0', deviceKeyKind: 'serviceTag', deviceName: 'synth-srv0', ok: true, reason: '', failedKinds: [], capped: false, notCollected: [],
    states: { ok: ['fan:FAN.1'], unknown: [], absent: [] },
    open: Array.from({ length: nOpen }, (_, k) => ({ kind: 'psu', partId: `PSU.EV.${k + 1}`, keyKind: 'name', state: 'fault', rawState: 'Critical', label: `PSU EV ${k + 1}`, detail: '' })) }],
});
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return !!fn(); };

test('① 알림을 보낸 판정 뒤에 온 urgent 보고도 곧(수 초 안에) 판정한다 — 알림 웹훅 1초가 다음 곧 판정을 20초 미루지 않는다(지금: 약 15초)', async () => {
  const { putEdgeReport } = await import('../src/central/partFaultEdge.js');
  const PF = await import('../src/partfault/poller.js');
  PF._resetSoonForTest();
  whDelay = 1000;
  assert.equal((await putEdgeReport('synth-site', report(0, false))).ok, true);
  await PF.runPartFaultsNow({ reason: 'baseline' });
  await new Promise((r) => setTimeout(r, 300));
  const j0 = judges.length;
  await putEdgeReport('synth-site', report(1, true)); PF.runPartFaultsSoon('edge-event');
  assert.ok(await waitFor(() => judges.slice(j0).some((j) => j.opened >= 1), 10_000), '첫 보고는 바로 판정(알림 1건 · 웹훅 1초)');
  await new Promise((r) => setTimeout(r, 6_000));   // 8회차 전 판의 5초 창이 지난 뒤
  const j1 = judges.length; const tB = Date.now();
  await putEdgeReport('synth-site', report(2, true)); PF.runPartFaultsSoon('edge-event');
  const ok = await waitFor(() => judges.slice(j1).some((j) => j.opened >= 1), 25_000);
  const lat = (judges.slice(j1).find((j) => j.opened >= 1)?.at ?? Date.now()) - tB;
  assert.ok(ok && lat < 3_000, `둘째 urgent 보고 → 판정 ${lat}ms(기대 < 3,000ms — 앞 판정의 알림 대기까지 20배로 세면 약 15초)`);
});

test('② 중앙 노드의 이벤트 묶음은 알림 발송(웹훅 3초)을 기다리지 않는다 — 다른 서버의 이벤트 읽기가 밀리지 않는다(지금: 기다림)', async (t) => {
  whDelay = 3000;
  const psu = { y9: 'OK', q9: 'OK' };
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
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(['y9', 'q9'].map((b) => ({ id: b, name: `synth-${b}`, host: `${base}/bmc/${b}`, username: 'u', password: 'p', serviceTag: `SYNTH${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const C = await import('../src/idrac/invCache.js');
  const E = await import('../src/idrac/eventSub.js');
  await P.pollNowManual();
  await new Promise((r) => setTimeout(r, 1500));   // 훅 판정(기준선) 지나가게
  E._resetEventsForTest();
  E._setEventDepsForTest({ debounceMs: 200, judgeFirstHoldMs: 10 });   // 실제 runCheck · 실제 judge(중앙 = runPartFaultsNow → 알림)
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    psu.y9 = 'Critical';
    E.acceptEvents(s, { context: E.contextOf(s, 'y9'), events: [{ sev: 'critical' }] });
    assert.ok(await waitFor(() => C.getInventory('y9')?.psus?.[0]?.health === 'Critical', 5_000), 'Y 를 다시 읽음');
    await new Promise((r) => setTimeout(r, 400));   // Y 판정이 알림을 보내는 중
    psu.q9 = 'Critical'; const tQ = Date.now();
    E.acceptEvents(s, { context: E.contextOf(s, 'q9'), events: [{ sev: 'critical' }] });
    await waitFor(() => C.getInventory('q9')?.psus?.[0]?.health === 'Critical', 10_000);
    const lat = Date.now() - tQ;
    assert.ok(lat < 1_500, `Q 이벤트 → 다시 읽힘 ${lat}ms(기대 < 1,500ms — 앞 묶음이 알림 웹훅 3초를 기다리면 약 2.8초 이상)`);
  } finally { E._setEventDepsForTest(null); await new Promise((r) => setTimeout(r, 4_000)); E._resetEventsForTest(); }
});
