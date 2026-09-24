/**
 * v2.606 감사 그룹 a — 중앙 수신 계약·계측 문자열·RMA·통신 점검 회귀.
 *
 * CEN2606-01 통신 점검 엣지 보고의 link.id 재계산 대조 + 길이 상한 + link_latest 정리 ·
 * CEN2606-02 PDU units·sensors·banks·phases 좁힘 + /tools/pdu 장비별 방어 ·
 * CEN2606-03 SAN ports.list·extra.sensors.list·zoning.zones 좁힘 + healthcheck-all 장비별 방어 ·
 * CEN2606-04 스토리지 extra.appliances 좁힘 + storage-summary 방어 ·
 * TIM2606-02 util/capStr — SlicedString 이 원문을 붙잡지 않는다(--expose-gc 힙 실측) ·
 * TIM2606-05 _lastRec 정리 · RECENT2606-06 /rma-poll 거절 응답 + 거절 수 ·
 * RECENT2606-03(중앙 부분) /fleet partial 보관 · DB2606-06 link-check events limit 정수화.
 * 실제 함수·실제 라우터를 호출해 동작으로 본다. 기준 시각은 고정값이거나 모듈이 찍은 값이다(Date.now() 기준 금지 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const ROOT = path.resolve(SRC, '..');
const J = (p) => JSON.stringify(path.join(SRC, p));

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2606a-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2606a', DATA_SOURCE: 'live', AUTH_ENABLED: 'true',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const express = (await import('express')).default;
const { centralRouter } = await import('../src/routes/central.js');
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/api/central', centralRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/central`;
test.after(() => srv.close());
const H = { 'Content-Type': 'application/json', 'X-Central-Token': 'shared-2606a' };

/** 자식 프로세스(별도 CONFIG_DIR · 선택적 --expose-gc)에서 스크립트를 돌리고 '@@' 줄의 JSON 을 돌려준다. */
function runChild(script, { gc = false, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2606a-'));
  const r = spawnSync(process.execPath, [...(gc ? ['--expose-gc'] : []), '--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: ROOT, timeout: 180_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${r.stderr?.slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-1500)} ${r.stderr?.slice(-1500)}`);
  return JSON.parse(line.slice(2));
}

/* ── CEN2606-01 ───────────────────────────────────────────────────────────── */

test('CEN2606-01: 엣지는 자기 링크 id 로만 보고할 수 있다 — 남의 링크 id·임의 id·긴 id 는 거절', async () => {
  const { putEdgeLinkReport } = await import('../src/central/linkCheckEdge.js');
  const { latestAll } = await import('../src/linkcheck/db.js');
  const v = (ok) => ({ ok, phase: ok ? 'identity' : 'tcp' });
  // edgeB 가 자기 push 링크를 실패로 보고.
  const b = await putEdgeLinkReport('edgeB', { results: [{ link: { id: 'edge->central|edgeB|central', kind: 'edge->central', from: 'edgeB', to: 'central' }, verdict: v(false) }] });
  assert.equal(b.stored, 1);
  // edgeA 가 edgeB 의 링크 id 로 ok 를 보고 → 거절(수정 전: stored 1 · 행이 ok=1, by_node=edgeA 로 덮였다).
  const a = await putEdgeLinkReport('edgeA', { results: [{ link: { id: 'edge->central|edgeB|central', kind: 'edge->central', from: 'edgeA', to: 'central' }, verdict: v(true) }] });
  assert.equal(a.stored, 0, JSON.stringify(a));
  assert.equal(a.rejected, 1);
  const row = (await latestAll()).find((r) => r.link_id === 'edge->central|edgeB|central');
  assert.equal(row.ok, 0, '죽은 엣지의 링크가 남의 보고로 정상이 되면 안 된다');
  assert.equal(row.by_node, 'edgeB');
  // 임의 id(형식은 맞아도 재계산 id 와 다르다) 거절.
  const junk = await putEdgeLinkReport('edgeA', { results: Array.from({ length: 20 }, (_, i) => ({ link: { id: `edge->central|edgeA|junk${i}x`, kind: 'edge->central', from: 'edgeA', to: 'central' }, verdict: v(true) })) });
  assert.equal(junk.stored, 0); assert.equal(junk.rejected, 20);
  // 길이 상한 — to 가 128자를 넘으면 id 가 맞아도 거절.
  const longTo = 'v'.repeat(200);
  const lg = await putEdgeLinkReport('edgeA', { results: [{ link: { id: `edge->vcenter|edgeA|${longTo}`, kind: 'edge->vcenter', from: 'edgeA', to: longTo }, verdict: v(true) }] });
  assert.equal(lg.stored, 0);
  // 정상 보고 — 대소문자만 다른 표기(등록부 remoteAgent 가 'EdgeA')도 받는다.
  const ok = await putEdgeLinkReport('edgeA', { results: [
    { link: { id: 'edge->central|EdgeA|central', kind: 'edge->central', from: 'EdgeA', to: 'central' }, verdict: v(true) },
    { link: { id: 'edge->vcenter|edgeA|vc-1', kind: 'edge->vcenter', from: 'edgeA', to: 'vc-1' }, verdict: v(true) },
  ] });
  assert.equal(ok.stored, 2, JSON.stringify(ok));
  assert.equal(ok.rejected, 0);
});

test('CEN2606-01: link_latest 는 보존일보다 오래 갱신되지 않은 행과(현재 목록이 주어지면) 목록에 없는 오래된 행을 정리한다', async () => {
  const { insertResults, pruneLinkCheck, latestAll } = await import('../src/linkcheck/db.js');
  const now = Date.now();
  const mk = (id, ts) => ({ link: { id }, ts, verdict: { ok: true, phase: 'identity' }, steps: {}, byNode: 'x' });
  await insertResults([
    mk('stale|old|x', now - 100 * 86_400_000),     // 원시 보존(90일)보다 오래 → 지운다
    mk('orphan|2d|x', now - 2 * 86_400_000),       // 현재 목록에 없고 1일 넘음 → 지운다(목록이 주어질 때)
    mk('current|2d|x', now - 2 * 86_400_000),      // 현재 목록에 있음 → 남긴다
    mk('orphan|fresh|x', now - 60_000),            // 목록에 없지만 방금 → 남긴다
  ]);
  const before = new Set((await latestAll()).map((r) => r.link_id));
  assert.ok(before.has('stale|old|x'));
  const r = await pruneLinkCheck({ force: true, sampleDays: 90, currentIds: ['CURRENT|2d|x'] });
  assert.ok(r.ok, JSON.stringify(r));
  const after = new Set((await latestAll()).map((x) => x.link_id));
  assert.ok(!after.has('stale|old|x'), '수정 전: link_latest 는 정리 대상이 아니라 영구 누적됐다');
  assert.ok(!after.has('orphan|2d|x'));
  assert.ok(after.has('current|2d|x'), '현재 링크(대소문자 무시)는 남긴다');
  assert.ok(after.has('orphan|fresh|x'), '방금 갱신된 행은 남긴다');
  assert.ok(r.latest >= 2);
});

/* ── DB2606-06 ────────────────────────────────────────────────────────────── */

test('DB2606-06: eventsOf 는 소수 limit 에도 datatype mismatch 없이 정수 상한으로 조회한다', async () => {
  const { insertResults, eventsOf } = await import('../src/linkcheck/db.js');
  const now = Date.now();
  await insertResults([1, 2, 3].map((i) => ({ link: { id: `ev|${i}|x` }, ts: now - i * 1000, verdict: { ok: false, phase: 'tcp' }, steps: {}, byNode: 'x' })));
  const r = await eventsOf({ limit: 1.5 });
  assert.equal(r.error, undefined, `수정 전: ${r.error}`);
  assert.equal(r.rows.length, 1);
  assert.equal(r.truncated, true);
  // 라우트도 pageArgs 로 좁힌다(규약 — v2.594 SEC-2594). 두 겹 방어이므로 라우트는 소스로도 고정한다.
  const src = fs.readFileSync(path.join(SRC, 'routes/api/linkCheck.js'), 'utf8');
  const seg = src.slice(src.indexOf("'/tools/link-check/events'"), src.indexOf("'/tools/link-check/event/:id'"));
  assert.match(seg, /pageArgs\(req\.query/);
});

/* ── CEN2606-02 / 03 / 04 (정제 — 순수) ──────────────────────────────────── */

test('CEN2606-02: PDU 엣지 스냅샷의 units·sensors·banks·phases 는 객체 배열 + 수치로 좁혀진다', async () => {
  const { saveEdgePdu, edgePduSnapshots, sanitizePduSnapshot } = await import('../src/central/pduEdge.js');
  const { summarize } = await import('../src/pdu/types.js');
  const r = saveEdgePdu('edge-pdu', [
    { id: 'p1', ok: true, units: [{ index: 1, powerW: '1200', banks: [null, { index: 1, currentA: '3.5' }], phases: 'x' }, { index: '2', powerW: '800' }], sensors: [null, { index: 1, tempC: '24.5', name: { a: 1 } }], notes: ['ok', { x: 1 }] },
    { id: 'p2', ok: true, units: 'x' },
    { id: 'p3', ok: true, units: [null], sensors: 'y' },
  ]);
  assert.equal(r.ok, true);
  assert.ok(r.narrowed >= 6, JSON.stringify(r));
  const by = new Map(edgePduSnapshots().map((s) => [s.id, s]));
  assert.equal(summarize(by.get('p1')).powerW, 2000, "수정 전: '01200800'(글자 이어붙이기)");
  assert.equal(by.get('p1').units[0].banks.length, 1);
  assert.equal(by.get('p1').units[0].banks[0].currentA, 3.5);
  assert.deepEqual(by.get('p1').units[0].phases, []);
  assert.equal(by.get('p1').sensors[0].tempC, 24.5);
  assert.equal(by.get('p1').sensors[0].name, '');
  assert.deepEqual(by.get('p1').notes, ['ok']);
  for (const id of ['p2', 'p3']) assert.doesNotThrow(() => summarize(by.get(id)), id);
  // 못 읽은 값은 0 이 아니라 null.
  assert.equal(sanitizePduSnapshot({ units: [{ powerW: '' }] }).snap.units[0].powerW, null);
});

test('CEN2606-03: SAN 엣지 스냅샷의 ports.list·extra.sensors.list·zoning.zones 는 객체 원소 배열로 좁혀진다', async () => {
  const { saveEdgeSanSwitch, edgeSanSwitchSnapshots } = await import('../src/central/sanSwitchEdge.js');
  const { checkDevice, checkPorts } = await import('../src/sanswitch/healthCheck.js');
  const info = {};
  saveEdgeSanSwitch('edge-san', [
    { deviceId: 's1', ok: true, ports: { list: [null, { index: 0, state: 'Online' }] } },
    { deviceId: 's2', ok: true, ports: { list: 'abc' } },
    { deviceId: 's3', ok: true, ports: { list: [] }, extra: { sensors: { parsed: true, list: 'x', counts: { total: 0, ok: 0 } } } },
    { deviceId: 's4', ok: true, zoning: { zones: [null, { name: 'z1', members: [] }] } },
  ], { info });
  assert.ok(info.narrowed >= 4, JSON.stringify(info));
  const by = new Map(edgeSanSwitchSnapshots().map((s) => [s.deviceId, s]));
  assert.equal(by.get('s1').ports.list.length, 1);
  assert.deepEqual(by.get('s2').ports.list, []);
  assert.deepEqual(by.get('s3').extra.sensors.list, []);
  assert.equal(by.get('s4').zoning.zones.length, 1);
  for (const id of ['s1', 's2', 's3']) {
    assert.doesNotThrow(() => checkDevice(by.get(id)), `checkDevice ${id}`);
    assert.doesNotThrow(() => checkPorts(by.get(id)), `checkPorts ${id}`);
  }
});

test('CEN2606-04: 스토리지 엣지 스냅샷의 extra.appliances 는 객체 배열(글자 필드)로 좁혀진다', async () => {
  const { saveEdgeStorage, edgeStorageSnapshots } = await import('../src/central/storageEdge.js');
  const info = {};
  saveEdgeStorage('edge-st', [
    { deviceId: 'u1', ok: true, extra: { appliances: 'x' } },
    { deviceId: 'u2', ok: true, extra: { appliances: [null, { name: 'a', serviceTag: { t: 1 } }, { name: 'b', serviceTag: 'ST-2' }] } },
  ], info);
  assert.ok(info.narrowed >= 2, JSON.stringify(info));
  const by = new Map(edgeStorageSnapshots().map((s) => [s.deviceId, s]));
  assert.deepEqual(by.get('u1').extra.appliances, []);
  assert.deepEqual(by.get('u2').extra.appliances.map((a) => a.serviceTag), ['', 'ST-2']);
  // 라우트의 요약 루프 식이 던지지 않는다.
  for (const s of by.values()) assert.doesNotThrow(() => (s.extra?.appliances || []).map((a) => a.serviceTag));
});

/* ── TIM2606-05 ───────────────────────────────────────────────────────────── */

test('TIM2606-05: 중복 제거 Map(_lastRec)은 보관 중인 장비 id 만 남긴다', async () => {
  const st = await import('../src/central/storageEdge.js');
  const sw = await import('../src/central/sanSwitchEdge.js');
  const pf = await import('../src/central/sanSwitchPerfEdge.js');
  for (let i = 0; i < 30; i++) {
    st.saveEdgeStorage('edge-churn', [{ deviceId: `st-${i}`, ok: false, collectedAt: 1000 + i }]);
    sw.saveEdgeSanSwitch('edge-churn', [{ deviceId: `sw-${i}`, ok: false, collectedAt: 1000 + i }]);
    pf.saveEdgePerfStatus('edge-churn', { devices: [{ id: `pf-${i}`, ok: true, at: 1000 + i }] });
  }
  const liveSt = st.edgeStorageSnapshots().length;
  const liveSw = sw.edgeSanSwitchSnapshots().length;
  assert.ok(st._lastRecSize() <= liveSt, `수정 전: 30개 이상 누적(${st._lastRecSize()} > ${liveSt})`);
  assert.ok(sw._lastRecSize() <= liveSw, `sanSwitch ${sw._lastRecSize()} > ${liveSw}`);
  assert.ok(pf._lastRecSize() <= 1, `perf ${pf._lastRecSize()}`);
  // dedup 계약은 그대로 — 같은 collectedAt 재push 는 키를 유지한다.
  st.saveEdgeStorage('edge-churn', [{ deviceId: 'st-29', ok: false, collectedAt: 1029 }]);
  assert.ok(st._lastRecSize() >= 1);
});

/* ── RECENT2606-06 ────────────────────────────────────────────────────────── */

test('RECENT2606-06: 인스턴스 상한으로 거절된 RMA 인스턴스는 작업을 받지 않고 사유를 받는다 + 목록이 거절 수를 말한다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const jobs = await import('../src/rma/jobs.js');
  jobs._resetRma();
  const tok = issueAgentToken('edge-rma6').token;
  const HA = { 'Content-Type': 'application/json', 'X-Central-Token': tok };
  for (let i = 0; i < jobs.HEARTBEAT_MAX_INSTANCES; i++) jobs.noteHeartbeat('edge-rma6', `i${i}`, {});
  jobs.enqueueJob('edge-rma6', { cmd: 'uptime' }, { user: 't' });
  const r = await fetch(`${base}/rma-poll`, { method: 'POST', headers: HA, body: JSON.stringify({ instance: 'late', wait: 0 }) });
  const j = await r.json();
  assert.equal(r.status, 403, `수정 전: 200 + 작업 배달 ${JSON.stringify(j)}`);
  assert.equal(j.refused, true);
  assert.ok(/상한/.test(j.reason), j.reason);
  assert.deepEqual(j.jobs, []);
  const g = jobs.listRmaAgents().find((x) => x.agent === 'edge-rma6');
  assert.equal(g.refusedRecent, 1);
  assert.ok(g.refusedCount >= 1);
  assert.deepEqual(g.refusedInstances, ['late']);
  // 온라인 인스턴스는 그대로 폴한다.
  const ok = await fetch(`${base}/rma-poll`, { method: 'POST', headers: HA, body: JSON.stringify({ instance: 'i0', wait: 0 }) });
  assert.equal(ok.status, 200);
  jobs._resetRma();
});

/* ── RECENT2606-03 (중앙 부분) ─────────────────────────────────────────────── */

test('RECENT2606-03: /fleet 는 엣지가 일부를 빼고 보낸 사실(partial·unreadVcenters·withheldItems)을 저장해 밝힌다', async () => {
  const fleet = await import('../src/central/fleet.js');
  const r = await fetch(`${base}/fleet`, { method: 'POST', headers: H, body: JSON.stringify({
    agent: 'edge-fleet6', baremetal: [{ fleetId: 'f1', name: 'bm1' }], partial: true,
    unreadVcenters: ['vc-dead', { x: 1 }, 'x'.repeat(500)], withheldItems: '500',
  }) });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.deepEqual(j.partial?.unreadVcenters?.[0], 'vc-dead', `수정 전: 응답에 partial 없음 ${JSON.stringify(j)}`);
  const row = fleet.listEdgeFleet().find((x) => x.agent === 'edge-fleet6');
  assert.equal(row.partial, true);
  assert.equal(row.withheldItems, 500);
  assert.equal(row.unreadVcenters.length, 2);
  assert.ok(row.unreadVcenters[1].length <= 128);
  assert.ok(fleet.edgeFleetPartials().some((x) => x.agent === 'edge-fleet6'));
  // 전체 목록이 오면 partial 표시가 사라진다.
  await fetch(`${base}/fleet`, { method: 'POST', headers: H, body: JSON.stringify({ agent: 'edge-fleet6', baremetal: [] }) });
  assert.equal(fleet.listEdgeFleet().find((x) => x.agent === 'edge-fleet6').partial, false);
});

/* ── TIM2606-02 (힙 실측 — 자식 프로세스 --expose-gc) ────────────────────── */

test('TIM2606-02: capStr·수신 계측이 긴 본문 문자열을 붙잡지 않는다(잔존 힙)', () => {
  const r = runChild(`
    const { capStr, capTrim, flatStr } = await import(${J('util/capStr.js')});
    const ingest = await import(${J('central/ingestStats.js')});
    const reject = await import(${J('central/ingestReject.js')});
    const pull = await import(${J('central/pullStats.js')});
    const tcp = await import(${J('central/tokenCheckPull.js')});
    const er = await import(${J('central/edgeRecord.js')});
    const big = (i) => String.fromCharCode(65 + (i % 26)) + ('x' + i).repeat(1).padEnd(2_000_000, 'y' + i);
    const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
    const N = 12;
    const out = {};
    const measure = async (name, fn) => { const h0 = heap(); const keep = []; for (let i = 0; i < N; i++) keep.push(await fn(i)); const h1 = heap(); out[name] = Math.round((h1 - h0) / 1048576); globalThis['k_' + name] = keep; };
    await measure('capStr', (i) => capStr(big(i), 64));
    await measure('capTrim', (i) => capTrim('  ' + big(i), 64));
    await measure('ingestStats', (i) => { ingest.recordIngest(big(i), '/x' + big(i + 100), { wireBytes: 1 }); return null; });
    await measure('ingestReject', (i) => { reject.recordReject(big(i + 200), big(i + 300), { status: 400, reason: big(i + 400), vcenterId: big(i + 500) }); return null; });
    await measure('pullStats', (i) => { pull.recordPull(big(i + 600), big(i + 700), { status: 200 }); return null; });
    await measure('tokenCheck', (i) => tcp.sanitizeEnvelope({ node: { agent: big(i + 800), hostname: big(i + 900), centralUrl: big(i + 1000) }, selfProbe: { reason: big(i + 1100) } }));
    await measure('edgeRecord', (i) => { const o = { name: big(i + 1200), model: big(i + 1300) }; er.scalarizeFields(o); return o; });
    out.flatShort = flatStr('abc') === 'abc';
    out.capObj = capStr({ toString() { throw new Error('x'); } }, 10);
    out.capNum = capStr(12345, 3);
    out.capLen = capStr('a'.repeat(100), 64).length;
    console.log('@@' + JSON.stringify(out));
  `, { gc: true });
  // 12 × 2MB = 약 24MB(수정 전 — 잘린 조각이 원문을 붙잡는다). 수정 후에는 조각만 남는다.
  for (const k of ['capStr', 'capTrim', 'ingestStats', 'ingestReject', 'pullStats', 'tokenCheck', 'edgeRecord']) {
    assert.ok(r[k] < 6, `${k}: 잔존 힙 ${r[k]}MB (수정 전 ~24MB 이상)`);
  }
  assert.equal(r.flatShort, true);
  assert.equal(r.capObj, '');
  assert.equal(r.capNum, '123');
  assert.equal(r.capLen, 64);
});

test('TIM2606-02: routes/central.js 의 본문 agent 이름(strAgent)이 원문을 붙잡지 않는다(잔존 힙, 실제 라우터)', () => {
  const r = runChild(`
    const express = (await import('express')).default;
    const { centralRouter } = await import(${J('routes/central.js')});
    const app = express(); app.use(express.json({ limit: '8mb' })); app.use('/api/central', centralRouter);
    const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    const b = 'http://127.0.0.1:' + s.address().port + '/api/central';
    const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
    const H = { 'Content-Type': 'application/json', 'X-Central-Token': 'shared-child' };
    // 워밍업(모듈 지연 로드분이 측정에 섞이지 않게)
    await fetch(b + '/fleet', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'warm', baremetal: [] }) });
    await fetch(b + '/storage-data', { method: 'POST', headers: H, body: JSON.stringify({ agent: 'warm', devices: [{ deviceId: 'w', ok: false }] }) });
    await new Promise((res) => setTimeout(res, 50));
    const h0 = heap();
    const codes = [];
    for (let i = 0; i < 10; i++) {
      const agent = ('edge' + i + '-').padEnd(2_000_000, String.fromCharCode(97 + i));
      // /fleet(저장소 키는 객체 속성 — V8 이 내부화해 복사한다)와 /storage-data(Map 키·장비 값에 이름을 그대로 담는다) 둘 다.
      const r = await fetch(b + '/fleet', { method: 'POST', headers: H, body: JSON.stringify({ agent, baremetal: [] }) });
      codes.push(r.status); await r.text();
      const r2 = await fetch(b + '/storage-data', { method: 'POST', headers: H, body: JSON.stringify({ agent, devices: [{ deviceId: 'd' + i, ok: false }] }) });
      codes.push(r2.status); await r2.text();
    }
    await new Promise((res) => setTimeout(res, 100));
    const h1 = heap();
    s.close();
    console.log('@@' + JSON.stringify({ mb: Math.round((h1 - h0) / 1048576), codes }));
  `, { gc: true, env: { CENTRAL_TOKEN: 'shared-child', DATA_SOURCE: 'live' } });
  assert.ok(r.codes.every((c) => c === 200), JSON.stringify(r.codes));
  // 수정 전: 10 × 2MB 원문이 스토리지 엣지 보관 Map 키·장비 값으로 상주(약 20MB). 수정 후: 이름 64자만.
  assert.ok(r.mb < 8, `잔존 힙 ${r.mb}MB`);
});

/* ── 라우트 장비별 방어(CEN2606-02·03·04) — 자식 프로세스에 api 라우터를 띄운다 ── */

test('CEN2606-02·03·04: 한 장비의 깨진 스냅샷이 /tools/pdu · healthcheck-all · storage-summary 전체를 500 으로 만들지 않는다', () => {
  const r = runChild(`
    const express = (await import('express')).default;
    const { store } = await import(${J('store.js')});
    const { api } = await import(${J('routes/api.js')});
    const sanReg = await import(${J('sanswitch/registry.js')});
    const pduReg = await import(${J('pdu/registry.js')});
    const { SAN_SWITCH_TYPES } = await import(${J('sanswitch/types.js')});
    const pduEdge = await import(${J('central/pduEdge.js')});
    const sanEdge = await import(${J('central/sanSwitchEdge.js')});
    const stEdge = await import(${J('central/storageEdge.js')});
    await store.refresh({ force: true });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.user = { username: 'admin', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const s = await new Promise((res) => { const x = app.listen(0, '127.0.0.1', () => res(x)); });
    const b = 'http://127.0.0.1:' + s.address().port + '/api';
    const get = async (p) => { const r = await fetch(b + p); let j = null; try { j = await r.json(); } catch {} return { status: r.status, body: j }; };
    const swType = SAN_SWITCH_TYPES.find((t) => t.implemented)?.type || SAN_SWITCH_TYPES[0].type;
    pduReg.saveDevice({ name: 'PDU-A', host: '10.66.0.1', username: 'apc', password: 'p', agent: 'edge-x' });
    pduReg.saveDevice({ name: 'PDU-B', host: '10.66.0.2', username: 'apc', password: 'p', agent: 'edge-x' });
    sanReg.saveDevice({ type: swType, name: 'SW-A', host: '10.66.0.3', username: 'u', password: 'p', agent: 'edge-x' });
    sanReg.saveDevice({ type: swType, name: 'SW-B', host: '10.66.0.4', username: 'u', password: 'p', agent: 'edge-x' });
    const [pA, pB] = pduReg.listDevices(); const [sA, sB] = sanReg.listDevices();
    pduEdge.saveEdgePdu('edge-x', [{ id: pA.id, ok: true, collectedAt: Date.now(), units: [{ index: 1, powerW: 100 }] }, { id: pB.id, ok: true, collectedAt: Date.now(), units: [{ index: 1, powerW: 50 }] }]);
    sanEdge.saveEdgeSanSwitch('edge-x', [{ deviceId: sA.id, ok: true, collectedAt: Date.now(), ports: { list: [] } }, { deviceId: sB.id, ok: true, collectedAt: Date.now(), ports: { list: [] } }]);
    stEdge.saveEdgeStorage('edge-x', [{ deviceId: 'st-x', ok: true, serial: 'S1', collectedAt: Date.now(), extra: { appliances: [] } }]);
    // 수신 정제를 거친 뒤에도 무언가가 저장본을 깨뜨린 경우(방어선 2) — 저장 객체를 직접 망가뜨린다.
    pduEdge.edgePduSnapshots().find((x) => x.id === pA.id).units = 'x';
    sanEdge.edgeSanSwitchSnapshots().find((x) => x.deviceId === sA.id).ports.list = [null];
    stEdge.edgeStorageSnapshots()[0].extra.appliances = 'x';
    const pdu = await get('/tools/pdu');
    const hc = await get('/tools/sanswitch/healthcheck-all');
    const ss = await get('/tools/sanswitch/perf/storage-summary');
    s.close();
    const pRow = (id) => pdu.body?.devices?.find((d) => d.id === id)?.snapshot;
    console.log('@@' + JSON.stringify({
      pdu: pdu.status, pA: pRow(pA.id), pB: pRow(pB.id)?.summary?.powerW,
      hc: hc.status, hcFailed: hc.body?.failed?.map((x) => x.deviceId), hcSummaryFailed: hc.body?.summary?.failed, hcResults: hc.body?.results?.length, sA: sA.id,
      ss: ss.status,
    }));
  `);
  assert.equal(r.pdu, 200, '수정 전: 한 장비가 PDU 목록 전체를 500 으로');
  assert.equal(r.pA.malformed, true);
  assert.ok(/형식 오류/.test(r.pA.error));
  assert.equal(r.pB, 50, '멀쩡한 장비는 그대로 보인다');
  assert.equal(r.hc, 200, '수정 전: 한 장비가 전체 점검을 500 으로');
  assert.deepEqual(r.hcFailed, [r.sA]);
  assert.equal(r.hcSummaryFailed, 1);
  assert.equal(r.hcResults, 1);
  assert.equal(r.ss, 200, '수정 전: appliances 하나가 요약 전체를 500 으로');
});
