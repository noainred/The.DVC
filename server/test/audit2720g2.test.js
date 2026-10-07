// v2.720 그룹 G2 — 데모 계정의 '지금 수집' 은 데모(mock-) 장비만(감사 R1-03·B2-01·R1-06) · 데모 계정 조회 거부 추가(B2-03) ·
//   CVP KPI 는 확인 불가 장비의 남은 값을 합산하지 않는다(B1-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2720g2-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 루프백 리스너로 '실제 접속 시도' 를 센다

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

// 연결 수를 세는 루프백 리스너 — 데모 계정의 수집이 사람이 등록한 장비에 접속했는지 본다.
let conns = 0;
const listener = net.createServer((s) => { conns++; s.destroy(); });
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const PORT = listener.address().port;
test.after(() => { listener.close(); });

const DEMO_USER = { username: 'demo', role: 'admin', demoGuest: true };
const ADMIN_USER = { username: 'admin', role: 'admin' };

async function appWith(user, registers) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { ...user }; next(); });
  const api = express.Router();
  for (const reg of registers) reg(api);
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body = {}) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { post, close: () => new Promise((r) => srv.close(r)) };
}

// ── ① 스윕: SAFE_ACTIONS 의 수집형 경로는 전부 라우트에서 isDemoGuest 를 본다 ────────────────────
// 리드 통합으로 넘긴 경로(이 그룹의 수정 범위 밖). 고치면 이 목록에서 뺄 것 — 스윕이 바로 그 경로를 검사한다.
const PENDING_LEAD = new Set([
  // v2.720 통합: storage 두 경로·horizon-sessions 는 demoOnly 를 받았다(스윕이 본다). curuser 는 mock 모드에서 언제나 합성
  //   (snap.source==='mock' 이면 전 vCenter 가 mock 잡 — 실제 로그인 없음)이라 demoOnly 가 필요 없다.
  'POST /api/tools/curuser/collect',
]);

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('① 수집형 SAFE_ACTIONS 는 라우트가 isDemoGuest 로 데모 장비만 수집한다(소스 스윕)', async () => {
  const { SAFE_ACTIONS } = await import('../src/auth/demoGuest.js');
  const collect = SAFE_ACTIONS.filter((s) => /\/collect(-all)?$/.test(s.split(' ')[1]));
  assert.ok(collect.length >= 9, `수집형 경로가 너무 적다: ${collect.length}`);
  const files = walk(path.join(SRC, 'routes')).map((f) => ({ f, src: stripComments(fs.readFileSync(f, 'utf8')) }));
  const missing = [];
  for (const a of collect) {
    if (PENDING_LEAD.has(a)) continue;
    const route = a.split(' ')[1].replace(/^\/api/, '');
    const needle = `.post('${route}'`;
    const hit = files.find((x) => x.src.includes(needle));
    assert.ok(hit, `라우트를 찾지 못했다: ${a}`);
    const i = hit.src.indexOf(needle);
    const next = hit.src.slice(i + needle.length).search(/\n\s*api\.(get|post|put|delete|patch)\(/);
    const body = next < 0 ? hit.src.slice(i) : hit.src.slice(i, i + needle.length + next);
    if (!/isDemoGuest\(/.test(body)) missing.push(`${a} (${path.relative(SRC, hit.f)})`);
  }
  assert.deepEqual(missing, [], '데모 계정 가드가 없는 수집 라우트');
  for (const p of PENDING_LEAD) assert.ok(SAFE_ACTIONS.includes(p), `PENDING_LEAD 에 SAFE_ACTIONS 밖 경로: ${p}`);
});

// ── ② B2-03: 엣지 로그·통신 점검·RMA·중계 렌더는 데모 계정 조회도 거부 ─────────────────────────────
test('② B2-03 — 데모 계정 READ_DENY 에 엣지 로그·통신 점검·RMA·relaytopo/render', async () => {
  const { demoGuestDenial } = await import('../src/auth/demoGuest.js');
  for (const p of ['/api/tools/edge-log', '/api/tools/edge-log/edge1', '/api/tools/link-check/samples', '/api/tools/link-check/events',
    '/api/tools/rma', '/api/tools/rma/history', '/api/tools/relaytopo/render/dc1']) {
    assert.ok(demoGuestDenial('GET', p), `거부되어야 한다: ${p}`);
  }
  // 이웃 경로는 그대로 열려 있다(접두가 넓게 먹지 않는다).
  for (const p of ['/api/tools/relaytopo', '/api/tools/sanswitch', '/api/tools/rmax', '/api/tools/edge-logs']) {
    assert.equal(demoGuestDenial('GET', p), null, `열려 있어야 한다: ${p}`);
  }
});

// ── ③ SAN 스위치: 단건·전체·포트 사용량 ───────────────────────────────────────────────────────────
test('③ SAN 스위치 — 데모 계정은 사람이 등록한 스위치(중앙·엣지)에 접속·재수집 요청하지 않는다', async () => {
  const reg = await import('../src/sanswitch/registry.js');
  const req = await import('../src/sanswitch/collectRequests.js');
  const poller = await import('../src/sanswitch/poller.js');
  const { registerSanSwitch } = await import('../src/routes/api/sanSwitch.js');
  const central = reg.saveDevice({ type: 'brocade', name: 'real-sw', host: '127.0.0.1', sshPort: PORT, username: 'admin', password: 'p' });
  const edge = reg.saveDevice({ type: 'brocade', name: 'edge-sw', host: '10.77.0.5', username: 'admin', password: 'p', agent: 'edge-x' });
  assert.ok(central.ok !== false && edge.ok !== false, JSON.stringify({ central, edge }));
  const cid = reg.listDevices().find((d) => d.name === 'real-sw').id;
  const eid = reg.listDevices().find((d) => d.name === 'edge-sw').id;

  // 모듈 수준: collectDeviceNow(demoOnly) 는 접속하지 않고 skipped 를 돌려준다.
  const c0 = conns;
  const r = await poller.collectDeviceNow(cid, { demoOnly: true });
  assert.equal(r?.skipped, true, JSON.stringify(r));
  assert.equal(conns - c0, 0, '데모 계정 단건 수집이 실장비에 접속했다');

  const demo = await appWith(DEMO_USER, [registerSanSwitch]);
  try {
    const c1 = conns;
    const one = await demo.post(`/api/tools/sanswitch/devices/${cid}/collect`);
    assert.equal(one.status, 403); assert.equal(one.body?.demoGuest, true);
    const oneEdge = await demo.post(`/api/tools/sanswitch/devices/${eid}/collect`);
    assert.equal(oneEdge.status, 403);
    assert.equal(req.hasPendingRequest(eid), false, '데모 계정이 엣지 재수집 요청을 등록했다');
    const all = await demo.post('/api/tools/sanswitch/collect-all');
    assert.equal(all.status, 200, JSON.stringify(all.body));
    assert.equal(all.body.requested, 0, '데모 계정 전체 수집이 엣지 요청을 등록했다');
    assert.ok(all.body.skippedNonDemo >= 2, JSON.stringify(all.body));
    assert.equal(req.hasPendingRequest(eid), false);
    const perf = await demo.post('/api/tools/sanswitch/perf/collect');
    assert.equal(perf.status, 200, JSON.stringify(perf.body));
    assert.deepEqual(perf.body.requested, [], '데모 계정 포트 사용량 수집이 엣지 요청을 등록했다');
    assert.equal(req.hasPendingPerfRequest('edge-x'), false);
    assert.equal(perf.body.result?.skippedNonDemo >= 1, true, JSON.stringify(perf.body.result));
    assert.equal(conns - c1, 0, '데모 계정 수집이 사람이 등록한 스위치에 접속했다');
  } finally { await demo.close(); }

  // 대조: 일반 관리자는 예전처럼 엣지 재수집 요청을 등록한다(가드는 데모 계정에만).
  const admin = await appWith(ADMIN_USER, [registerSanSwitch]);
  try {
    const one = await admin.post(`/api/tools/sanswitch/devices/${eid}/collect`);
    assert.equal(one.status, 202, JSON.stringify(one.body));
    assert.equal(req.hasPendingRequest(eid), true);
  } finally { await admin.close(); }
});

// ── ④ PDU · CVP 엣지 위임 분기(R1-06) ───────────────────────────────────────────────────────────
test('④ R1-06 — PDU 단건·CVP 지금 수집의 엣지 위임 분기도 데모 계정은 데모 장비만', async () => {
  const preg = await import('../src/pdu/registry.js');
  const preq = await import('../src/pdu/collectRequests.js');
  const { registerPdu } = await import('../src/routes/api/pdu.js');
  const s = preg.saveDevice({ name: 'edge-pdu', host: '10.77.0.9', username: 'apc', password: 'p', agent: 'edge-x' });
  assert.ok(s.ok !== false, JSON.stringify(s));
  const pid = preg.listDevices().find((d) => d.name === 'edge-pdu').id;
  const creg = await import('../src/cvp/registry.js');
  const creq = await import('../src/cvp/collectRequests.js');
  const { registerCvp } = await import('../src/routes/api/cvp.js');
  creg.saveServer({ name: 'edge-cvp', host: 'https://10.77.0.10', username: 'cvp', password: 'p', agent: 'edge-x', authMode: 'password' });
  const cvpId = creg.listServers().find((x) => x.name === 'edge-cvp')?.id;
  assert.ok(cvpId, 'CVP 등록 실패');

  const demo = await appWith(DEMO_USER, [registerPdu, registerCvp]);
  try {
    const r = await demo.post(`/api/tools/pdu/devices/${pid}/collect`);
    assert.equal(r.status, 403, JSON.stringify(r.body)); assert.equal(r.body?.demoGuest, true);
    assert.equal(preq.hasPendingRequest(pid), false, '데모 계정이 PDU 엣지 재수집 요청을 등록했다');
    const c = await demo.post('/api/tools/cvp/collect', { cvpId });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.requested, 0); assert.equal(c.body.skippedNonDemo, 1);
    assert.equal(creq.hasPendingCvpRequest(cvpId), false, '데모 계정이 CVP 엣지 재수집 요청을 등록했다');
  } finally { await demo.close(); }
});

// ── ⑤ 베어메탈 스토리지 · 사용률(R1-03·B2-01) ──────────────────────────────────────────────────────
test('⑤ 베어메탈 스토리지 — 데모 계정 지금 수집은 사람이 등록한 서버에 접속하지 않는다', async () => {
  const B = await import('../src/bmstor/registry.js');
  const sv = B.saveBmServer({ name: 'bm-human', host: '127.0.0.1', port: PORT, username: 'root', password: 'x', mounts: ['/'], enabled: true });
  assert.ok(sv.ok !== false, JSON.stringify(sv));
  const { registerBmStorage } = await import('../src/routes/api/bmstor.js');
  const demo = await appWith(DEMO_USER, [registerBmStorage]);
  try {
    const c0 = conns;
    const r = await demo.post('/api/tools/bm-storage/collect');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.skippedNonDemo, 1, JSON.stringify(r.body));
    assert.equal(conns - c0, 0, '데모 계정 수집이 실서버에 접속했다');
  } finally { await demo.close(); }
});

test('⑥ 베어메탈 사용률 — demoOnly 면 실등록 서버를 수집하지 않고 뺀 대수를 밝힌다', async () => {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [
    { id: 'mock-bmsrv-x-db01', name: 'demo-db01', host: '10.9.9.9', username: 'root', password: 'p' },
    { id: 'real-idrac-01', name: 'real-db01', host: `127.0.0.1:${PORT}`, username: 'root', password: 'p' },
  ] }));
  const poller = await import('../src/bmusage/poller.js');
  const { saveBmUsageSettings } = await import('../src/bmusage/settings.js');
  saveBmUsageSettings({ enabled: true, includeUnassigned: true, idracTelemetry: true });
  poller._setFleetForTest(async () => ({
    bareMetal: [
      { serverId: 'mock-bmsrv-x-db01', name: 'demo-db01', serviceTag: 'DEMOTAG1' },
      { serverId: 'real-idrac-01', name: 'real-db01', serviceTag: 'REALTAG1' },
    ],
    virtualizationHosts: [],
  }));
  try {
    const c0 = conns;
    const r = await poller.pollBmUsageOnce({ trigger: 'manual', demoOnly: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.skippedNonDemo, 1, JSON.stringify(r));
    assert.equal(r.failCount, 0, `실등록 서버를 시도했다: ${JSON.stringify(r)}`);
    assert.equal(conns - c0, 0, '실등록 iDRAC 에 접속했다');
  } finally { poller._setFleetForTest(null); }
});

// ── ⑦ B1-02: CVP KPI 는 확인 불가 장비를 합산하지 않는다 — 서버·웹 같은 규칙 ─────────────────────────
const NOW = 1_790_000_000_000;   // 고정 기준 시각(경계에서 떨어뜨림 — Date.now() 를 쓰지 않는다)
const IV = 300_000;
function dev(over = {}) {
  return { cvpId: 'c1', key: 'SN', hostname: 'sw', collectedAt: NOW - 60_000, streaming: true, telemetry: 'ok', cpuPct: 95, memPct: 50,
    partsList: [{ kind: 'psu', name: 'PSU1', state: 'fault' }], bgpPeers: [{ peer: '10.0.0.1', state: 'Idle' }], ports: { total: 48, up: 40, down: 3 }, ...over };
}

test('⑦ B1-02 — cvpTotals: 낡음·스트리밍 아님·텔레메트리 실패 장비의 남은 값을 합산하지 않고 따로 센다', async () => {
  const { cvpTotals, cvpDeviceConfirm } = await import('../src/routes/api/cvp.js');
  const opts = { now: NOW, intervalMs: IV };
  const rows = [
    dev({ key: 'fresh' }),
    dev({ key: 'stale', collectedAt: NOW - 3 * 86_400_000 }),
    dev({ key: 'nostream', streaming: false }),
    dev({ key: 'telfail', telemetry: 'failed' }),
  ];
  const t = cvpTotals(rows, opts);
  assert.equal(t.devices, 4);
  assert.equal(t.unconfirmed, 3);
  assert.deepEqual(t.unconfirmedBy, { never: 0, stale: 1, 'not-streaming': 1, 'telemetry-failed': 1 });
  // 지금 값으로 셀 수 있는 장비는 fresh 하나뿐이다.
  assert.equal(t.partsFault, 1); assert.equal(t.bgpDown, 1); assert.equal(t.portsDown, 3); assert.equal(t.cpuHigh, 1); assert.equal(t.streaming, 1);
  // 판정은 Overview 와 같다.
  const { deviceHealth, freshnessBounds } = await import('../src/cvp/overview.js');
  for (const r of rows) {
    const h = deviceHealth(r, { now: NOW, staleMs: freshnessBounds(IV).staleMs, intervalMs: IV });
    assert.equal(cvpDeviceConfirm(r, opts).unconfirmed, h.state === 'unknown' ? h.reasons[0] : null, r.key);
  }
  // 아무것도 못 읽은 장비(unread)는 지금 수집은 된 것 — 항목별 '못 읽음' 칸이 센다.
  const u = cvpTotals([dev({ partsList: null, bgpPeers: null, ports: null, cpuPct: null, memPct: null })], opts);
  assert.equal(u.unconfirmed, 0); assert.equal(u.partsUnread, 1); assert.equal(u.bgpUnread, 1); assert.equal(u.portsUnread, 1);
  // 부품 목록만 낡은 장비는 부품만 뺀다.
  const ps = cvpTotals([dev({ partsAt: NOW - 30 * 86_400_000 })], opts);
  assert.equal(ps.partsStale, 1); assert.equal(ps.partsFault, 0); assert.equal(ps.bgpDown, 1);
});

test('⑦-b B1-02 — 웹 totalsFromDevices 는 서버 판정(장비 목록의 unconfirmed·partsStale)을 읽어 같은 합계를 낸다', async () => {
  const { cvpTotals, cvpDeviceConfirm } = await import('../src/routes/api/cvp.js');
  const { partsSummary, bgpSummary } = await import('../src/cvp/parse.js');
  const W = await import('../../web/src/views/tools/cvpText.js');
  const opts = { now: NOW, intervalMs: IV };
  const rows = [dev({ key: 'a' }), dev({ key: 'b', collectedAt: NOW - 3 * 86_400_000 }), dev({ key: 'c', streaming: false }),
    dev({ key: 'd', partsAt: NOW - 30 * 86_400_000 }), dev({ key: 'e', cpuPct: 10, ports: null })];
  // 장비 목록 응답(publicDevice) 모양 — 요약 + 서버 판정.
  const list = rows.map((d) => ({ ...cvpDeviceConfirm(d, opts), streaming: d.streaming, parts: partsSummary(d.partsList),
    bgp: d.bgpPeers ? bgpSummary(d.bgpPeers) : null, ports: d.ports, cpuPct: d.cpuPct, memPct: d.memPct, info: null }));
  const s = cvpTotals(rows, opts); const w = W.totalsFromDevices(list);
  for (const k of ['devices', 'streaming', 'partsFault', 'partsWarn', 'partsUnread', 'partsStale', 'bgpDown', 'bgpUnread', 'portsDown', 'portsUnread',
    'cpuHigh', 'memHigh', 'sysUnread', 'cpuMax', 'memMax', 'unconfirmed']) assert.equal(w[k], s[k], k);
  assert.deepEqual(w.unconfirmedBy, s.unconfirmedBy);
  assert.match(W.unconfirmedNote(s), /확인 불가 장비 \*\*2대\*\*/);
  assert.equal(W.unconfirmedNote({ unconfirmed: 0, partsStale: 0 }), null);
  assert.doesNotMatch(W.unconfirmedNote(s), /`/);
});
