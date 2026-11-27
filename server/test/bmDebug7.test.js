// 물리서버 기능 디버깅 회차 10 — 엣지 축 회귀(중앙 노드로 도는 별도 프로세스 · 10회차 엣지 축 재현 시험을 고친 판 기준으로 옮김).
//   ① 곧 판정 비용은 판정 몫(알림 발송 · 다른 요청 제외) — 배경 부하가 있어도 둘째 urgent 를 곧 판정한다.
//   ② 판정 재진입 5회 상한에 걸린 요청은 버리지 않고 곧 판정으로 다시 잡는다(마지막 서버의 장애도 판정된다).
// 픽스처는 합성(127.0.0.1 가짜 웹훅 · 가짜 iDRAC).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'dbg10edge-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
const express = (await import('express')).default;
let whDelay = 2000; const whHits = [];
const wh = express(); wh.use(express.json({ limit: '1mb' }));
wh.post('/hook', (req, res) => { whHits.push({ at: Date.now(), title: String(req.body?.title || req.body?.text || JSON.stringify(req.body || {})) }); setTimeout(() => res.json({ ok: true }), whDelay); });
const wsrv = await new Promise((r) => { const s = wh.listen(0, '127.0.0.1', () => r(s)); });
after(() => { wsrv.closeAllConnections?.(); wsrv.close(); });
fs.writeFileSync(path.join(tmp, 'alerts.json'), JSON.stringify({ channels: { webhook: { enabled: true, url: `http://127.0.0.1:${wsrv.address().port}/hook` } }, suppressWindowMin: 0 }));
Object.assign(process.env, { CONFIG_DIR: tmp, DB_DIR: tmp, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', AUTH_ENABLED: 'false', PARTFAULT_ENABLED: 'true', PARTFAULT_HOOK_DEBOUNCE_MS: '1000' });
delete process.env.CENTRAL_URL;
const judges = []; let caps = 0;
const ol = console.log.bind(console); const ow = console.warn.bind(console);
console.log = (...a) => { const s = a.map(String).join(' '); if (s.startsWith('[partfault] 점검(')) judges.push({ at: Date.now(), opened: Number((s.match(/신규 (\d+)/) || [])[1] || 0) }); ol(...a); };
console.warn = (...a) => { const s = a.map(String).join(' '); if (s.includes('5회 연속')) caps += 1; ow(...a); };
const report = (nOpen, urgent) => ({
  v: 2, agent: 'synth-site', version: '3.52.0', at: Date.now(), partIdents: 1, omitted: 0, scanned: { idrac: { devices: 1, ok: 1, failed: 0 } }, ...(urgent ? { urgent: true } : {}),
  devices: [{ scope: 'idrac', deviceId: 'synth-srv0', deviceKey: 'SYNTHTAG0', deviceKeyKind: 'serviceTag', deviceName: 'synth-srv0', ok: true, reason: '', failedKinds: [], capped: false, notCollected: [],
    states: { ok: ['fan:FAN.1'], unknown: [], absent: [] },
    open: Array.from({ length: nOpen }, (_, k) => ({ kind: 'psu', partId: `PSU.EV.${k + 1}`, keyKind: 'name', state: 'fault', rawState: 'Critical', label: `PSU EV ${k + 1}`, detail: '' })) }],
});
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return !!fn(); };

test('① 다른 요청 부하(루프 25%)가 있어도 알림 웹훅 2초 뒤의 둘째 urgent 보고를 곧(3초 안) 판정한다 — 지금: 부하 × 웹훅 대기 × 20 만큼 밀림', async () => {
  const { putEdgeReport } = await import('../src/central/partFaultEdge.js');
  const PF = await import('../src/partfault/poller.js');
  PF._resetSoonForTest();
  whDelay = 2000;
  assert.equal((await putEdgeReport('synth-site', report(0, false))).ok, true);
  await PF.runPartFaultsNow({ reason: 'baseline' });
  await new Promise((r) => setTimeout(r, 300));
  const load = setInterval(() => { const e = performance.now() + 25; while (performance.now() < e) { /* 다른 요청 처리 대용 */ } }, 100);
  try {
    const j0 = judges.length;
    await putEdgeReport('synth-site', report(1, true)); PF.runPartFaultsSoon('edge-event');
    assert.ok(await waitFor(() => judges.slice(j0).some((j) => j.opened >= 1), 10_000), '첫 보고는 바로 판정(알림 1건 · 웹훅 2초)');
    await new Promise((r) => setTimeout(r, 6_000));
    const j1 = judges.length; const tB = Date.now();
    await putEdgeReport('synth-site', report(2, true)); PF.runPartFaultsSoon('edge-event');
    const ok = await waitFor(() => judges.slice(j1).some((j) => j.opened >= 1), 40_000);
    const lat = (judges.slice(j1).find((j) => j.opened >= 1)?.at ?? Date.now()) - tB;
    assert.ok(ok && lat < 3_000 + whDelay, `둘째 urgent 보고 → 판정 끝 ${lat}ms(기대 < ${3_000 + whDelay}ms — 판정 자신의 웹훅 2초 포함. 배경 부하를 판정 비용으로 세면 약 14초)`);
  } finally { clearInterval(load); }
});

test('② 중앙 이벤트 묶음이 판정에 합류해 5회 상한에 걸려도 마지막 서버의 장애가 판정된다 — 지금: 상한 회차에 합류한 서버는 다음 정기 판정까지 안 됨', async (t) => {
  whDelay = 3000;
  const boxes = ['s1', 's2', 's3', 's4', 's5', 's6'];
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
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(boxes.map((b) => ({ id: b, name: `synth-${b}`, host: `${base}/bmc/${b}`, username: 'u', password: 'p', serviceTag: `SYNTH${b}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const E = await import('../src/idrac/eventSub.js');
  await P.pollNowManual();
  await new Promise((r) => setTimeout(r, 2500));   // 훅 판정(기준선) 지나가게
  E._resetEventsForTest();
  E._setEventDepsForTest({ debounceMs: 200, judgeFirstHoldMs: 10 });   // 실제 runCheck · 실제 judge(중앙 = runPartFaultsNow → 알림 3초)
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    const w0 = whHits.length; const c0 = caps; const t0 = Date.now();
    // s1 0초 · s2 1초 · 그다음 3초마다(각 서버의 장애가 진행 중인 판정의 알림 3초 안에 읽히게)
    const at = [0, 1000, 4000, 7000, 10000, 13000];
    for (let i = 0; i < boxes.length; i += 1) {
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + at[i] - Date.now())));
      psu[boxes[i]] = 'Critical';
      E.acceptEvents(s, { context: E.contextOf(s, boxes[i]), events: [{ sev: 'critical' }] });
    }
    const alerted = () => boxes.filter((b) => whHits.slice(w0).some((h) => h.title.includes(`synth-${b} ·`)));
    await waitFor(() => alerted().length === boxes.length, 30_000);
    assert.deepEqual(alerted(), boxes, `알림이 간 서버 ${alerted().join(',')} · 5회 상한 경고 ${caps - c0}번 — 상한 회차에 합류한 서버의 장애는 판정되지 않음`);
  } finally { E._setEventDepsForTest(null); await new Promise((r) => setTimeout(r, 4_000)); E._resetEventsForTest(); }
});
