/**
 * v2.607 수정 그룹 b — 중앙 수신 정제·소유권·계측 문자열(감사 CEN2607-01~06 · TIM2607-01(+LEFT2607-05) ·
 * LEFT2607-01·02 · EDGE2607-02(중앙 측) · RECENT2607-01).
 *
 * ⚠ 저장소 server/config 오염 방지 — **모듈 import 전에** CONFIG_DIR 을 임시 폴더로 고정한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2607b-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2607b-token-xyz', DATA_SOURCE: 'live', AUTH_ENABLED: 'false',
  SVCMON_EDGE_MAX_ROWS: '50',
});
// 중앙 vCenter 등록부 — direct 1개 · site 1개(edgeA 담당)
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-direct-1', name: 'direct', host: 'vc-d.invalid', collectMode: 'direct' },
  { id: 'vc-site-1', name: 'site', host: 'vc-s.invalid', collectMode: 'site', remoteAgent: 'edgeA' },
] }));
// 수집 서버 등록부 — edgeA 만(통신 점검 링크 집합의 근거)
fs.writeFileSync(path.join(CFG, 'collectors.json'), JSON.stringify({ collectors: [
  { id: 'edgeA', name: 'edgeA', url: 'https://10.20.30.40:4000', token: 'coltok-aaaaaaaaaaaa' },
] }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRCDIR = path.join(HERE, '..', 'src');
const SRC = (p) => fs.readFileSync(path.join(SRCDIR, p), 'utf8');

async function withCentral(fn) {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express(); app.use(express.json({ limit: '20mb' })); app.use('/api/central', centralRouter);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/central`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Central-Token': process.env.CENTRAL_TOKEN }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch { /* */ }
    return { status: r.status, body: j };
  };
  try { return await fn(post); } finally { srv.close(); }
}

/* ── CEN2607-01 ─────────────────────────────────────────────────────────── */
test('CEN2607-01: 엣지 원소 하나(psuDetail:[null])가 시리얼 조회의 SAN 구획 전체를 지우지 않는다', async () => {
  const { saveEdgeSanSwitch, _resetForTest } = await import('../src/central/sanSwitchEdge.js');
  const { buildSerialIndex } = await import('../src/insights/serialLookup.js');
  _resetForTest();
  const now = Date.now();
  saveEdgeSanSwitch('edgeA', [{ deviceId: 'sw-good', ok: true, collectedAt: now, serial: 'GOODSER1', health: { psuDetail: [{ unit: 1, serial: 'PSU-A' }] } }]);
  saveEdgeSanSwitch('edgeB', [{ deviceId: 'sw-bad', ok: true, collectedAt: now, serial: 'BADSER', health: { psuDetail: [null], psus: { ok: '2', total: 'x' }, fans: 'oops', status: { d: 4 } } }]);
  const req = { user: { username: 'admin', role: 'admin' } };
  const r = buildSerialIndex(req);
  assert.ok(!r.sources.sanswitch.error, JSON.stringify(r.sources.sanswitch));
  assert.ok(r.sources.sanswitch.rows >= 2, '정상 스위치 + 형식 오류 스위치의 섀시 시리얼 모두 남아야 한다');
  const serials = r.rows.map((x) => x.serial || x.value || x.key).join(',');
  assert.ok(/GOODSER1/.test(JSON.stringify(r.rows)), serials);
  // health 정제 결과
  const { edgeSanSwitchSnapshots } = await import('../src/central/sanSwitchEdge.js');
  const bad = edgeSanSwitchSnapshots().find((d) => d.deviceId === 'sw-bad');
  assert.deepEqual(bad.health.psuDetail, []);
  assert.equal(bad.health.psus.ok, 2);
  assert.equal(bad.health.psus.total, null);
  assert.equal(bad.health.fans, null);
  assert.equal(bad.health.status, null);
});

test('CEN2607-01: 시리얼 조회는 장비 단위로 실패를 격리한다(정제를 우회한 형식 오류 — 개수를 밝힌다)', async () => {
  const { saveEdgeSanSwitch, _resetForTest } = await import('../src/central/sanSwitchEdge.js');
  const { buildSerialIndex } = await import('../src/insights/serialLookup.js');
  _resetForTest();
  const now = Date.now();
  saveEdgeSanSwitch('edgeA', [{ deviceId: 'sw-good2', ok: true, collectedAt: now, serial: 'GOODSER2' }]);
  // 템플릿 리터럴이 던지는 값(toString 이 함수가 아닌 객체) — 객체 원소라 정제는 통과한다.
  saveEdgeSanSwitch('edgeB', [{ deviceId: 'sw-trap', ok: true, collectedAt: now, serial: 'TRAPSER', health: { psuDetail: [{ unit: { toString: 'x' }, serial: 'PSU-T' }] } }]);
  const r = buildSerialIndex({ user: { username: 'admin', role: 'admin' } });
  assert.match(JSON.stringify(r.rows), /GOODSER2/, '한 장비 실패가 다른 장비 시리얼을 지우면 안 된다');
  assert.ok(r.sources.sanswitch.rows >= 1);
  assert.match(String(r.sources.sanswitch.error || ''), /1대/, '건너뛴 장비 수를 밝힌다');
});

/* ── CEN2607-02 ─────────────────────────────────────────────────────────── */
test('CEN2607-02: SAN·스토리지의 화면 표시 글자 필드는 객체면 null 로 좁힌다', async () => {
  const san = await import('../src/central/sanSwitchEdge.js');
  san._resetForTest();
  san.saveEdgeSanSwitch('edgeA', [{ deviceId: 'sw-disp', ok: true, collectedAt: Date.now(), fabricOs: { a: 1 }, domainId: { b: 2 }, switchState: ['x'], switchName: 'ok-name', extra: { switchType: { c: 3 }, chassisId: 'CID' } }]);
  const d = san.edgeSanSwitchSnapshots().find((x) => x.deviceId === 'sw-disp');
  assert.equal(d.fabricOs, null); assert.equal(d.domainId, null); assert.equal(d.switchState, null);
  assert.equal(d.switchName, 'ok-name');
  assert.equal(d.extra.switchType, null); assert.equal(d.extra.chassisId, 'CID');
  const st = await import('../src/central/storageEdge.js');
  const n = st.narrowStorageSnapshot({ deviceId: 's1', extra: { alertsNote: { a: 1 }, healthState: ['x'], clusterHealth: 'OK', versionRaw: { v: 1 }, capacityBasisNote: 'x'.repeat(1000) } });
  assert.equal(n.snap.extra.alertsNote, null); assert.equal(n.snap.extra.healthState, null); assert.equal(n.snap.extra.versionRaw, null);
  assert.equal(n.snap.extra.clusterHealth, 'OK');
  assert.equal(n.snap.extra.capacityBasisNote.length, 1000, '긴 설명문은 자르지 않는다');
  assert.equal(n.narrowed, 3);
});

/* ── CEN2607-05 ─────────────────────────────────────────────────────────── */
test('CEN2607-05: 점검·조닝이 순회하는 나머지 중첩 배열을 좁혀 checkDevice·zonesFromCompact 가 던지지 않는다', async () => {
  const { narrowSanSnapshot } = await import('../src/central/sanSwitchEdge.js');
  const { checkDevice } = await import('../src/sanswitch/healthCheck.js');
  const { zonesFromCompact } = await import('../src/sanswitch/zoning.js');
  const raw = {
    deviceId: 'sw-n', ok: true,
    ports: { list: [{ index: 1, attached: { a: 1 } }, { index: 2, attached: ['10:00:00:00:00:00:00:01', 5] }] },
    zoning: { zones: [{ name: 'z1', members: { a: 1 } }, { name: 'z2', members: ['a', null] }] },
    extra: {
      isl: { parsed: true, count: 1, list: 'x' }, raslog: { parsed: true, counts: { total: 1 }, list: [null] },
      lsan: { parsed: true, count: 1, zones: [null, { name: 'L', members: 'x' }] },
      fabricMembers: { parsed: true, count: 2 }, bottleneck: { parsed: true, ports: 'x' },
      trunk: { parsed: true, count: 1, groups: [{ group: 1, members: 'x' }] },
    },
  };
  const { snap } = narrowSanSnapshot(raw);
  assert.doesNotThrow(() => checkDevice(snap));
  assert.doesNotThrow(() => zonesFromCompact(snap.zoning));
  assert.deepEqual(snap.ports.list[0].attached, []);
  assert.deepEqual(snap.ports.list[1].attached, ['10:00:00:00:00:00:00:01']);
  assert.deepEqual(snap.zoning.zones[0].members, []);
  assert.deepEqual(snap.extra.isl.list, []);
  assert.deepEqual(snap.extra.fabricMembers.switches, []);
  assert.deepEqual(snap.extra.trunk.groups[0].members, []);
  // 정상 값은 그대로(같은 참조가 아니어도 내용 동일)
  const ok = { deviceId: 'sw-ok', zoning: { zones: [{ name: 'z', members: ['a', 'b'] }] }, ports: { list: [{ index: 1, attached: ['w'] }] } };
  assert.deepEqual(narrowSanSnapshot(ok).snap, ok);
  assert.equal(narrowSanSnapshot(ok).narrowed, 0);
});

/* ── RECENT2607-01 ──────────────────────────────────────────────────────── */
test('RECENT2607-01: 청크 push 에서 같은 collectedAt 은 작업 로그에 한 번만 기록된다', async () => {
  const san = await import('../src/central/sanSwitchEdge.js');
  const act = await import('../src/sanswitch/activityLog.js');
  san._resetForTest(); act._resetForTest?.();
  const ca = Date.now() - 1000;
  const dv = (id) => ({ deviceId: id, ok: true, collectedAt: ca });
  for (let c = 0; c < 3; c++) {
    san.saveEdgeSanSwitch('edgeR', [dv('r-sw1'), dv('r-sw2')], { chunk: 0, chunks: 2 });
    san.saveEdgeSanSwitch('edgeR', [dv('r-sw3'), dv('r-sw4')], { chunk: 1, chunks: 2 });
  }
  const ev = (act.listActivity({ limit: 500 })?.events || act.listActivity() || []);
  const list = Array.isArray(ev) ? ev : (ev.events || []);
  const counts = {};
  for (const e of list) if (/^r-sw/.test(e.deviceId)) counts[e.deviceId] = (counts[e.deviceId] || 0) + 1;
  assert.deepEqual(counts, { 'r-sw1': 1, 'r-sw2': 1, 'r-sw3': 1, 'r-sw4': 1 }, JSON.stringify(counts));
});

/* ── CEN2607-03 · CEN2607-06 · EDGE2607-02(ip-scan) ─────────────────────── */
test('CEN2607-03: 공유 토큰도 중앙 직접 수집 장비의 스냅샷을 쓸 수 없다(notOwned 로 밝힌다)', async () => {
  const sreg = await import('../src/storage/registry.js');
  const wreg = await import('../src/sanswitch/registry.js');
  const preg = await import('../src/pdu/registry.js');
  sreg.saveDevice({ name: 'unity-direct', type: 'unity480', host: '10.1.1.1', username: 'u', password: 'p', agent: '' });
  sreg.saveDevice({ name: 'unity-edge', type: 'unity480', host: '10.1.1.2', username: 'u', password: 'p', agent: 'edgeA' });
  const sDirect = sreg.listDevices().find((d) => d.name === 'unity-direct').id;
  const sEdge = sreg.listDevices().find((d) => d.name === 'unity-edge').id;
  wreg.saveDevice({ type: 'brocade', name: 'sw-direct', host: '10.2.2.1', username: 'u', password: 'p' });
  wreg.saveDevice({ type: 'brocade', name: 'sw-edge', host: '10.2.2.2', username: 'u', password: 'p', agent: 'edgeA' });
  const wDirect = wreg.listDevices().find((d) => d.name === 'sw-direct').id;
  const wEdge = wreg.listDevices().find((d) => d.name === 'sw-edge').id;
  preg.saveDevice({ name: 'pdu-direct', host: '10.3.3.1', username: 'u', password: 'p' });
  preg.saveDevice({ name: 'pdu-edge', host: '10.3.3.2', username: 'u', password: 'p', agent: 'edgeA' });
  const pDirect = preg.listDevices().find((d) => d.name === 'pdu-direct').id;
  const pEdge = preg.listDevices().find((d) => d.name === 'pdu-edge').id;
  await withCentral(async (post) => {
    const cap = { totalBytes: 9e15, usedBytes: 1 };
    const s = await post('/storage-data', { agent: 'spoof', devices: [{ deviceId: sDirect, ok: true, capacity: cap }, { deviceId: 'nope', ok: true }, { deviceId: sEdge, ok: true, capacity: { totalBytes: 1e12, usedBytes: 5e11 } }] });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.saved, 2, '등록부에 없는 id 는 여기서 거절하지 않는다(고아 TTL)');
    assert.equal(s.body.dropped?.notOwned, 1, JSON.stringify(s.body));
    const se = await import('../src/central/storageEdge.js');
    assert.ok(!se.edgeStorageSnapshots().some((d) => d.deviceId === sDirect), '중앙 직접 수집 장비를 엣지 값으로 덮으면 안 된다');
    const db = await import('../src/storage/db.js');
    const hist = await db.capacityHistory(sDirect, 0).catch(() => []);
    assert.ok(!(hist || []).some((h) => Number(h.total_bytes) === 9e15), '용량 이력이 오염되면 안 된다');
    const w = await post('/sanswitch-data', { agent: 'spoof', devices: [{ deviceId: wDirect, ok: true }, { deviceId: wEdge, ok: true }] });
    assert.equal(w.status, 200); assert.equal(w.body.saved, 1); assert.equal(w.body.dropped?.notOwned, 1);
    const p = await post('/pdu-data', { agent: 'spoof', snapshots: [{ id: pDirect, ok: true }, { id: pEdge, ok: true }] });
    assert.equal(p.status, 200); assert.equal(p.body.dropped?.notOwned, 1, JSON.stringify(p.body));
  });
});

test('CEN2607-06: /inventory 도 중앙 직접 수집(direct) vCenter 는 받지 않는다(mock 판정은 그대로 먼저)', async () => {
  const inv = await import('../src/central/inventory.js');
  await withCentral(async (post) => {
    const vc = (id) => ({ agent: 'edgeX', vcenterId: id, vcenter: { id, name: `real-${id}`, status: 'ok' }, hosts: [], vms: [] });
    const d = await post('/inventory', vc('vc-direct-1'));
    assert.equal(d.status, 403, JSON.stringify(d.body));
    // 등록부에 없는 id 는 여기서 막지 않는다(형제 판정과 같은 기준 — 등록부 prune 이 정리한다)
    const u = await post('/inventory', vc('vc-unregistered'));
    assert.notEqual(u.status, 403, JSON.stringify(u.body));
    assert.ok(!inv.listInventory().some((e) => e.vcenterId === 'vc-direct-1'), 'direct vCenter 인벤토리가 저장되면 안 된다');
    const ok = await post('/inventory', vc('vc-site-1'));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const m = await post('/inventory', { ...vc('vc-direct-1'), source: 'mock' });
    assert.equal(m.status, 400); assert.equal(m.body.mockBlocked, true, 'mock 거부의 종류가 바뀌면 안 된다(v2.570)');
  });
});

test('EDGE2607-02: ip-scan-result 는 alive 상한으로 버린 수를 omitted 로 돌려주고, part-faults 응답에 partsOmitted 가 있다', async () => {
  await withCentral(async (post) => {
    const alive = Array.from({ length: 8003 }, (_, i) => ({ ip: `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` }));
    const r = await post('/ip-scan-result', { agent: 'edgeScan', alive, scanned: 8003 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.omitted, 3);
  });
  const src = stripComments(SRC('routes/central.js'));
  const pf = src.slice(src.indexOf("centralRouter.post('/part-faults'"), src.indexOf("centralRouter.get('/edge-log-jobs'"));
  assert.match(pf, /partsOmitted/, 'part-faults 응답에 partsOmitted');
});

/* ── CEN2607-04 ─────────────────────────────────────────────────────────── */
test('CEN2607-04: svcmon 메타는 상한을 넘겨 쌓이지 않고 넘친 개수를 센다(결과 있는 id 는 계속 받는다)', async () => {
  const m = await import('../src/central/svcmonEdge.js');
  m._resetEdgeCache();
  assert.equal(m.MAX_ROWS_PER_AGENT, 50);
  let id = 0;
  for (let p = 0; p < 5; p++) {
    const meta = Array.from({ length: 40 }, () => ({ i: `x${id++}`, p: 'P', n: 'n' }));
    m.ingestReport('edgeM', { snapId: 1000 + p, seq: 1, total: 2, rows: [], meta, metaSig: 's' });
  }
  const a = m.getAgentRaw('edgeM');
  assert.ok(a.meta.size <= 50, `meta ${a.meta.size}`);
  assert.equal(a.counters.metaOverflow, 200 - 50);
  // 결과 행이 있는 id 의 메타는 상한이어도 받는다(PR-4 호환)
  m.ingestReport('edgeM', { snapId: 2000, seq: 1, total: 2, rows: [{ i: 'r1', s: 'ok', a: 0 }], meta: [{ i: 'r1', p: 'P', n: 'n' }] });
  const b = m.getAgentRaw('edgeM');
  assert.ok(b.rows.has('r1'), 'rows 에 r1');
  assert.ok(b.meta.has('r1'), '결과 행이 있는 id 의 메타는 상한에서도 받는다');
});

/* ── LEFT2607-01 ────────────────────────────────────────────────────────── */
test('LEFT2607-01: 통신 점검 보고는 중앙이 그 엣지에 내려준 링크 id 만 받는다', async () => {
  const dbm = await import('../src/linkcheck/db.js');
  const { putEdgeLinkReport } = await import('../src/central/linkCheckEdge.js');
  const v = (ok) => ({ ok, phase: ok ? 'identity' : 'tcp' });
  const bogus = Array.from({ length: 30 }, (_, i) => ({ link: { id: `edge->vcenter|edgeA|bogus-${i}`, kind: 'edge->vcenter', from: 'edgeA', to: `bogus-${i}` }, verdict: v(true) }));
  const r = await putEdgeLinkReport('edgeA', { results: [
    ...bogus,
    { link: { id: 'edge->central|edgeA|central', kind: 'edge->central', from: 'edgeA', to: 'central' }, verdict: v(true) },
    { link: { id: 'edge->vcenter|edgeA|vc-site-1', kind: 'edge->vcenter', from: 'edgeA', to: 'vc-site-1' }, verdict: v(true) },
  ] });
  assert.equal(r.stored, 2, JSON.stringify(r));
  assert.equal(r.rejected, 30);
  assert.equal(r.notAssigned, 30);
  const ids = (await dbm.latestAll()).map((x) => x.link_id);
  assert.ok(!ids.some((x) => /bogus/.test(x)));
  // 폴러가 고아 정리에 현재 링크 집합을 넘긴다
  const poller = stripComments(SRC('linkcheck/poller.js'));
  assert.match(poller, /pruneLinkCheck\(\{[^}]*currentIds/, 'pruneLinkCheck 에 currentIds 를 넘긴다');
});

/* ── LEFT2607-02 ────────────────────────────────────────────────────────── */
test('LEFT2607-02: fleet 부분 전송 요약이 통합 인벤토리·베어메탈 사용률 응답에 실린다', async () => {
  const fleet = await import('../src/central/fleet.js');
  fleet.resetEdgeFleet();
  fleet.setEdgeFleet('edgeF', [{ fleetId: 'f1', name: 'bm1' }], null, { partial: { partial: true, unreadVcenters: ['vc-x'], withheldItems: 3 } });
  const s = fleet.fleetPartialsSummary();
  assert.equal(s.partialEdges, 1);
  assert.equal(s.withheldItems, 3);
  assert.deepEqual(s.partials[0].unreadVcenters, ['vc-x']);
  const ins = stripComments(SRC('routes/insights.js'));
  assert.match(ins.slice(ins.indexOf("insightsRouter.get('/fleet'"), ins.indexOf("insightsRouter.put('/fleet/tag'")), /fleetPartials/);
  const bm = stripComments(SRC('routes/api/bmUsage.js'));
  assert.match(bm, /fleetPartials:\s*allowed\s*\?\s*null\s*:\s*fleetPartialsSummary\(\)/, '범위 계정에는 null');
});

/* ── TIM2607-01 · LEFT2607-05 ───────────────────────────────────────────── */
test('TIM2607-01: 상주 레코드 문자열은 원문을 붙잡지 않는다(실측 — 잔존 힙)', () => {
  const script = `
    const S = ${JSON.stringify(SRCDIR)};
    const fleet = await import(S + '/central/fleet.js');
    const perf = await import(S + '/central/sanSwitchPerfEdge.js');
    const rma = await import(S + '/rma/jobs.js');
    const gdiag = await import(S + '/central/gpuGuestDiag.js');
    const big = () => JSON.parse(JSON.stringify('A'.repeat(2 * 1024 * 1024)));
    globalThis.gc(); const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 6; i++) {
      fleet.setEdgeFleet('e' + i, [{ fleetId: 'f' + i, name: big() }], null, { verified: true });
      perf.normalizeEdgePerfStatus && (globalThis['p' + i] = perf.normalizeEdgePerfStatus({ pushError: big(), version: big(), devices: [{ id: 'd', error: big() }] }));
      rma.noteHeartbeat('ra' + i, 'inst', { hostname: big(), os: big(), comment: big() });
      gdiag.setGpuGuestDiag('g' + i, { vcenters: [{ vcenterId: big() }] }, {});
    }
    globalThis.gc(); const h1 = process.memoryUsage().heapUsed;
    console.log('@@' + JSON.stringify({ mb: (h1 - h0) / 1e6 }));
    process.exit(0);
  `;
  const out = execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'audit2607b-heap-')) }, encoding: 'utf8', timeout: 60_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('@@'));
  const { mb } = JSON.parse(line.slice(2));
  // 수정 전: 6 × (2MB × 약 8개) ≈ 100MB 이상 잔존. 수정 후: 수 MB.
  assert.ok(mb < 20, `잔존 힙 ${mb.toFixed(1)}MB — 잘린 문자열이 원문을 붙잡고 있다`);
});

test('TIM2607-01: central/* · rma/jobs.js 에 상주 문자열 .slice 절단이 남지 않는다(스윕 · 허용 목록 사유)', () => {
  /*
   * 금지 형태 — 외부 문자열을 `.slice(0, N)` 로 잘라 보관하는 세 모양:
   *   String(x).slice(0, N) · (typeof v === 'string' ? v.slice(0, N) …) · t(x).slice(0, N)
   * 허용 목록(파일 → 사유): 콘솔 경고 문구 안의 절단은 보관되지 않는다(로그 줄로 나가고 버려진다).
   */
  const ALLOW_LINE = [/console\.(warn|log|error)\(/];
  const files = fs.readdirSync(path.join(SRCDIR, 'central')).filter((f) => f.endsWith('.js')).map((f) => `central/${f}`).concat(['rma/jobs.js']);
  const bad = [];
  for (const f of files) {
    const lines = stripComments(SRC(f)).split('\n');
    lines.forEach((ln, i) => {
      if (ALLOW_LINE.some((re) => re.test(ln))) return;
      if (/String\([^;]*?\)\.slice\(0,/.test(ln) || /\?\s*[A-Za-z_$][\w$]*\.slice\(0,\s*[A-Za-z_$\d]/.test(ln) && /typeof [A-Za-z_$][\w$]* === 'string'/.test(ln) || /\bt\([^()]*\)\.slice\(0,/.test(ln)) {
        bad.push({ at: `${f}:${i + 1}`, ln: ln.trim() });
      }
    });
  }
  // 허용(사유): ① 로컬 예외 문구(e.message) — 외부 본문이 아니다 ② 조회 키로만 쓰고 보관하지 않는다(idracScanJobs agentPolls.get)
  //   ③ 배열 절단(errors.slice) — 문자열이 아니다(정규식 오탐).
  const ALLOW = [
    /String\(e\?\.message \|\| e\)\.slice/,
    /agentPolls\.get\(String\(agentName/,
    /errors\.slice\(0, 20\)\.map/,
  ];
  const left = bad.filter((b) => !ALLOW.some((re) => re.test(b.ln))).map((b) => `${b.at}: ${b.ln.slice(0, 160)}`);
  assert.deepEqual(left, [], `capStr/capTrim 으로 바꿀 것(util/capStr.js):\n${left.join('\n')}`);
});
