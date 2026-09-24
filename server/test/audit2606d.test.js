/**
 * v2.606 감사 그룹 d — 엣지 push·원격 전력·스캔 대역 회귀.
 *
 * RECENT2606-02 원격 전력 호스트명 충돌은 신선한·활성 항목끼리만 + 충돌 결정은 DB 계열 존재로 영속 ·
 * RECENT2606-03 fleet 보류 시한은 마지막 온전한 push 기준 + min(시한, TTL − 2×주기) ·
 * EDGE2606-03 curuser·gpu-guest·fleet·inventory·agent-config push 가 중앙 응답의 '일부만 받음' 을 상태에 싣는다 ·
 * EDGE2606-02 svcmon 재시작 예열 중 완결 스냅샷으로 중앙이 행·메타를 GC 하지 않는다 ·
 * EDGE2606-04 SAN push 청크 실패 시 한 번 전체 재전송 + '중앙 목록 부분 상태' 명시 ·
 * LEFT2606-02 iDRAC 스캔 대역·엣지·계정이 바뀌고 새 비밀번호가 없으면 저장 비밀번호를 폐기한다.
 * 엣지 push 는 목 HTTP 중앙으로 **실제 호출**한다. 판정 기준 시각은 고정값 T0 를 주입한다(Date.now() 를 기준으로 쓰지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2606d-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2606d', AGENT_NAME: 'e1', DATA_SOURCE: 'live',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true', SANSW_PUSH_CHUNK_BYTES: '65536',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

// ── 목 중앙: 경로별 응답을 바꿀 수 있다 ──
const got = [];
const replies = new Map(); // path -> (body) => { status, json }
const central = http.createServer((q, r) => {
  const ch = []; q.on('data', (c) => ch.push(c));
  q.on('end', () => {
    let b = Buffer.concat(ch);
    try { if (q.headers['content-encoding'] === 'gzip') b = zlib.gunzipSync(b); } catch { /* */ }
    let body = null; try { body = JSON.parse(b.toString('utf8') || 'null'); } catch { body = null; }
    const p = q.url.split('?')[0];
    got.push({ path: p, body });
    const fn = replies.get(p);
    const out = fn ? fn(body) : { status: 200, json: { ok: true } };
    r.writeHead(out.status, { 'content-type': 'application/json' }); r.end(JSON.stringify(out.json));
  });
});
await new Promise((r) => central.listen(0, '127.0.0.1', r));
const CENTRAL = `http://127.0.0.1:${central.address().port}`;
test.after(() => central.close());

const { config } = await import('../src/config.js');
config.agent.centralUrl = CENTRAL;
config.agent.centralToken = 'shared-2606d';
config.agent.name = 'e1';
config.agent.pushCurUser = true;
const quiet = async (fn) => { const w = console.warn; const l = console.log; console.warn = () => {}; console.log = () => {}; try { return await fn(); } finally { console.warn = w; console.log = l; } };
const T0 = 1_780_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────
test('LEFT2606-02: 대역·엣지·계정이 바뀌고 새 비밀번호가 없으면 저장 비밀번호를 승계하지 않는다', async () => {
  const sr = await import('../src/idrac/scanRanges.js');
  const a = sr.saveScanRanges({ datacenterId: 'dc1', ranges: ['10.0.0.0/28'], username: 'root', password: 'SECRET' });
  assert.equal(a.ok, true); assert.equal(a.hasPassword, true);
  // 같은 대역(순서·대소문자만 다름) + 빈 비밀번호 → 유지
  const same = sr.saveScanRanges({ id: a.id, datacenterId: 'dc1', ranges: ['10.0.0.0/28'], password: '' });
  assert.equal(same.hasPassword, true); assert.equal(same.droppedSecrets, undefined);
  // 대역만 바꿔 저장 → 폐기(수정 전: hasPassword=true, 다음 스캔이 새 대역으로 비밀번호를 보냈다)
  const moved = sr.saveScanRanges({ id: a.id, datacenterId: 'dc1', ranges: ['203.0.113.0/30'], password: '' });
  assert.equal(moved.hasPassword, false);
  assert.deepEqual(moved.droppedSecrets, ['password']);
  assert.match(moved.skipped[0].reason, /비밀번호를 폐기/);
  assert.equal(sr.getScanRangeRaw(a.id).password, '');
  assert.equal(sr.enabledScanRanges().some((e) => e.id === a.id), false, '비밀번호가 없으면 스캔 보류');
  // 새 비밀번호와 함께 바꾸면 그대로 저장
  const withPw = sr.saveScanRanges({ id: a.id, datacenterId: 'dc1', ranges: ['203.0.113.0/29'], password: 'NEW' });
  assert.equal(withPw.hasPassword, true); assert.equal(withPw.droppedSecrets, undefined);
  // 수행 엣지(agent) 변경도 접속처 변경이다
  const ag = sr.saveScanRanges({ id: a.id, datacenterId: 'dc1', agent: 'edge-x' });
  assert.equal(ag.hasPassword, false); assert.deepEqual(ag.droppedSecrets, ['password']);
  // 이미 비밀번호가 없던 항목은 '폐기' 를 보고하지 않는다
  const again = sr.saveScanRanges({ id: a.id, datacenterId: 'dc1', ranges: ['198.51.100.0/30'] });
  assert.equal(again.droppedSecrets, undefined);
  // 비밀번호와 무관한 필드(서비스명·활성)만 바꾸면 유지
  const b = sr.saveScanRanges({ datacenterId: 'dc2', ranges: ['10.1.0.0/28'], username: 'root', password: 'P2' });
  const svc = sr.saveScanRanges({ id: b.id, datacenterId: 'dc2', service: 'svc', enabled: false, password: '' });
  assert.equal(svc.hasPassword, true);
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2606-03: centralReply 가 응답 모양별 거절 요약을 만든다(0 이면 null)', async () => {
  const cr = await import('../src/agent/centralReply.js');
  assert.equal(cr.dropSummaryOf({ ok: true, records: 3, rejected: [] }), null);
  assert.equal(cr.dropSummaryOf(null), null);
  const c = cr.dropSummaryOf({ ok: true, records: 0, rejected: ['vc-a'] });
  assert.equal(c.rejected, 1); assert.deepEqual(c.rejectedIds, ['vc-a']); assert.match(c.text, /거부 1\(vc-a\)/);
  const g = cr.dropSummaryOf({ ok: true, unregistered: 3, omitted: { hosts: 1, vms: 2 }, unverifiedAgent: true });
  assert.equal(g.unregistered, 3); assert.equal(g.omitted, 3); assert.equal(g.unverifiedAgent, true);
  const inv = cr.dropSummaryOf({ ok: true, rejected: 2, dropped: { notObject: 2 }, held: true });
  assert.equal(inv.rejected, 2); assert.equal(inv.held, true);
  const cf = cr.dropSummaryOf({ ok: true, rejectedFiles: [{ name: 'a.json', reason: 'too-large' }], rejectedFileCount: 7 });
  assert.equal(cf.rejectedFiles, 7);
  const m = cr.mergeDrop(c, cr.dropSummaryOf({ rejected: ['vc-b'] }));
  assert.equal(m.rejected, 2); assert.deepEqual(m.rejectedIds, ['vc-a', 'vc-b']);
});

test('EDGE2606-03: 다섯 push 가 중앙이 일부를 뺀 사실을 상태(last)에 싣는다(목 중앙 실제 호출)', async () => {
  replies.set('/api/central/curuser', () => ({ status: 200, json: { ok: true, records: 0, rejected: ['vc-a'], replaced: 0 } }));
  replies.set('/api/central/gpu-guest-data', () => ({ status: 200, json: { ok: true, hosts: 0, vms: 0, unregistered: 3, omitted: { hosts: 1, vms: 0 } } }));
  replies.set('/api/central/fleet', () => ({ status: 200, json: { ok: true, agent: 'e1', baremetal: 0, omitted: 2, vcenterBlanked: 1 } }));
  replies.set('/api/central/inventory', () => ({ status: 200, json: { ok: true, vcenterId: 'vc-live', hosts: 1, vms: 0, rejected: 2, dropped: { notObject: 2 }, held: true } }));
  replies.set('/api/central/agent-config', () => ({ status: 200, json: { ok: true, agent: 'e1', files: 1, rejectedFiles: [{ name: 'big.json', reason: 'too-large' }], rejectedFileCount: 1 } }));
  try {
    // curuser — 수정 전: last = {records:1, error:null} 이고 거부 흔적 없음
    const cu = await import('../src/agent/curUserPush.js');
    const r1 = await quiet(() => cu.pushCurUserRecords([{ vmId: 'vm-1', vcenterId: 'vc-a', kind: 'ok', ok: true }]));
    assert.equal(r1.ok, true);
    assert.equal(cu.curUserPushStatus().last.centralDropped?.rejected, 1);
    assert.deepEqual(cu.curUserPushStatus().last.centralDropped.rejectedIds, ['vc-a']);
    // gpu-guest
    const gp = await import('../src/agent/gpuGuestPush.js');
    gp._setGuestPollerStatusForTest(() => ({ lastRun: { at: T0 } }));
    const r2 = await quiet(() => gp.pushGpuGuestNow());
    assert.equal(r2.ok, true);
    assert.equal(gp.gpuGuestPushStatus().last.centralDropped?.unregistered, 3);
    gp._setGuestPollerStatusForTest(null);
    // fleet
    const fp = await import('../src/agent/fleetPush.js');
    fp._setFleetWithholdSinceForTest(null, null);
    const r3 = await quiet(() => fp.pushFleetNow());
    assert.equal(r3.ok, true);
    assert.equal(fp.fleetPushStatus().last.centralDropped?.omitted, 2);
    assert.equal(fp.fleetPushStatus().last.centralDropped?.vcenterBlanked, 1);
    // inventory
    const ip = await import('../src/agent/inventoryPush.js');
    const { store } = await import('../src/store.js');
    const orig = store.get;
    store.get = () => ({ generatedAt: T0, vcenters: [{ id: 'vc-live', status: 'connected' }], hosts: [{ id: 'h1', vcenterId: 'vc-live' }], vms: [], datastores: [], networks: [], alarms: [] });
    try {
      const r4 = await quiet(() => ip.pushInventoryNow());
      assert.equal(r4.sent, 1);
      const d = ip.inventoryPushStatus().last.centralDropped?.['vc-live'];
      assert.equal(d?.rejected, 2); assert.equal(d?.held, true);
    } finally { store.get = orig; }
    // agent-config
    const cp = await import('../src/agent/configPush.js');
    cp._resetConfigPush();
    const r5 = await quiet(() => cp.pushConfigNow());
    assert.equal(r5, true);
    const lc = cp.configPushStatus().last.centralDropped;
    assert.equal(lc?.rejectedFiles, 1); assert.deepEqual(lc.rejectedFileNames, ['big.json:too-large']);
  } finally {
    for (const k of ['/api/central/curuser', '/api/central/gpu-guest-data', '/api/central/fleet', '/api/central/inventory', '/api/central/agent-config']) replies.delete(k);
  }
});

test('EDGE2606-03: 중앙이 아무것도 빼지 않으면 centralDropped 를 싣지 않는다', async () => {
  const cu = await import('../src/agent/curUserPush.js');
  const r = await quiet(() => cu.pushCurUserRecords([{ vmId: 'vm-1', vcenterId: 'vc-a' }]));
  assert.equal(r.ok, true);
  assert.equal(cu.curUserPushStatus().last.centralDropped, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
test('RECENT2606-03: fleet 보류 시한은 마지막 온전한 push 부터 · 상한은 min(시한, TTL − 2×주기)', async () => {
  const fp = await import('../src/agent/fleetPush.js');
  const MIN = 60_000;
  assert.equal(fp.fleetWithholdMaxMs(60_000, 30 * MIN, 20 * MIN), 20 * MIN, '기본 60초 주기는 예전과 같다');
  assert.equal(fp.fleetWithholdMaxMs(10 * MIN, 30 * MIN, 20 * MIN), 10 * MIN);
  assert.equal(fp.fleetWithholdMaxMs(20 * MIN, 30 * MIN, 20 * MIN), 0, '주기가 TTL 절반 이상이면 보류하지 않는다');
  // 주기 10분 시뮬레이션: 마지막 온전한 push t=0, t=10 부터 못 읽음 → 첫 부분 전송 시각이 중앙 TTL(30분) 안이어야 한다.
  const iv = 10 * MIN; const maxMs = fp.fleetWithholdMaxMs(iv, 30 * MIN, 20 * MIN);
  let since = null; let firstPartial = null;
  for (let t = iv; t <= 60 * MIN; t += iv) {
    const d = fp.fleetWithholdDecision(['vcX'], since, T0 + t, maxMs, T0);
    since = d.since;
    if (d.mode === 'partial') { firstPartial = t; break; }
  }
  assert.ok(firstPartial != null && firstPartial < 30 * MIN, `첫 부분 전송 ${firstPartial / MIN}분 — 수정 전 40분(TTL 뒤)`);
  // 부분 전송은 기준을 옮기지 않는다 — 다음 주기도 부분 전송(보류로 되돌아가지 않는다)
  assert.equal(fp.fleetWithholdDecision(['vcX'], since, T0 + firstPartial + iv, maxMs, T0).mode, 'partial');
  // 기존 계약(lastFullOkAt 없음)은 그대로
  assert.equal(fp.fleetWithholdDecision(['vcD'], T0, T0 + fp.FLEET_WITHHOLD_MAX_MS).mode, 'withhold');
});

test('RECENT2606-03: pushFleetNow — 마지막 온전한 push 가 시한보다 오래됐으면 첫 보류 판정에서 곧바로 부분 전송', async () => {
  const fp = await import('../src/agent/fleetPush.js');
  fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcA', name: 'vcA', host: 'https://10.0.0.1', username: 'u', password: 'p' }] }));
  const before = got.length;
  try {
    fp._setFleetWithholdSinceForTest(null, Date.now() - fp.FLEET_WITHHOLD_MAX_MS - 5 * 60_000);
    const r = await quiet(() => fp.pushFleetNow());
    assert.equal(r.ok, true, '수정 전: 보류 시작(since)=지금 이라 withhold');
    assert.equal(r.partial, true);
    const sent = got.slice(before).filter((g) => g.path === '/api/central/fleet');
    assert.equal(sent.length, 1); assert.equal(sent[0].body.partial, true);
  } finally {
    fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
    fp._setFleetWithholdSinceForTest(null, null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2606-02: 중앙은 예열 중(warmingUp) 완결로 재시작 전 행·메타를 GC 하지 않는다 — 시한 뒤에는 정리한다', async () => {
  const se = await import('../src/central/svcmonEdge.js');
  se._resetEdgeCache();
  const rows = ['t1', 't2', 't3', 't4', 't5'].map((i) => ({ i, s: 'ok', r: '', m: 1, k: 1, a: 0 }));
  const meta = rows.map((r) => ({ i: r.i, p: '/p', n: 'n', h: 'h', t: 't', y: 'ping', iv: 60 }));
  const rep = (snapId, extra, at) => se.ingestReport('edge-w', { v: 1, snapId, seq: 1, total: 1, items: 5, ...extra }, at);
  rep(1, { reported: 5, rows, meta, metaSig: 's' }, T0);
  rep(2, { reported: 5, rows, metaSig: 's' }, T0 + 60_000);
  assert.equal(se.getAgentRaw('edge-w').rows.size, 5);
  // 재시작 → 예열 완결 2회(수정 전: 두 번째에 rows 0 · meta 0)
  rep(3, { reported: 0, rows: [], warmingUp: true }, T0 + 120_000);
  rep(4, { reported: 2, rows: rows.slice(0, 2), warmingUp: true }, T0 + 180_000);
  assert.equal(se.getAgentRaw('edge-w').rows.size, 5, '예열 중에는 지우지 않는다');
  assert.equal(se.getAgentRaw('edge-w').meta.size, 5);
  // 구버전 엣지(플래그 없음) — 항목은 있는데 보고 0 이면 같은 보류
  rep(5, { reported: 0, rows: [] }, T0 + 240_000);
  assert.equal(se.getAgentRaw('edge-w').rows.size, 5);
  // 보류 시한을 넘기면 예전대로 정리한다(시한 없는 보류 금지)
  rep(6, { reported: 0, rows: [], warmingUp: true }, T0 + 120_000 + se.WARM_GC_HOLD_MS + 1);
  rep(7, { reported: 0, rows: [], warmingUp: true }, T0 + 120_000 + se.WARM_GC_HOLD_MS + 60_000);
  assert.equal(se.getAgentRaw('edge-w').rows.size, 0);
  // 예열이 아닌 정상 완결은 삭제된 항목을 그대로 정리한다
  se._resetEdgeCache();
  rep(10, { reported: 5, rows, meta, metaSig: 's' }, T0);
  rep(11, { reported: 4, rows: rows.slice(0, 4) }, T0 + 60_000);
  rep(12, { reported: 4, rows: rows.slice(0, 4) }, T0 + 120_000);
  assert.equal(se.getAgentRaw('edge-w').rows.size, 4);
  se._resetEdgeCache();
});

test('EDGE2606-02: 엣지는 첫 sweep 이 전 항목을 덮기 전 warmingUp 을 싣는다(목 중앙 실제 호출)', async () => {
  const pol = await import('../src/svcmon/poller.js');
  assert.equal(pol.warmingUpOf({ covered: false, items: 5, reported: 2, startedAt: T0, now: T0 + 1000 }), true);
  assert.equal(pol.warmingUpOf({ covered: false, items: 5, reported: 5, startedAt: T0, now: T0 + 1000 }), false);
  assert.equal(pol.warmingUpOf({ covered: true, items: 5, reported: 0, startedAt: T0, now: T0 + 1000 }), false);
  assert.equal(pol.warmingUpOf({ covered: false, items: 5, reported: 0, startedAt: T0, now: T0 + pol.WARM_MAX_MS }), false, '시한 뒤에는 예열이 아니다');
  const items = ['a', 'b', 'c'].map((id) => ({ test: { id, name: id, type: 'ping', intervalSec: 60 }, host: 'h', target: { path: '/', name: 't', host: 'h' } }));
  replies.set('/api/central/svcmon-report', () => ({ status: 200, json: { ok: true, accepted: 1, dropped: 0 } }));
  const sp = await import('../src/agent/svcmonPush.js');
  try {
    pol._setPollerStateForTest({ items, res: [['a', { status: 'ok', reply: '', ms: 1, ts: Date.now(), streak: 1 }]], startedAt: Date.now() });
    const before = got.length;
    const r = await quiet(() => sp.pushSvcmonNow());
    assert.equal(r.ok, true, JSON.stringify(r));
    const env = got.slice(before).find((g) => g.path === '/api/central/svcmon-report')?.body;
    assert.equal(env?.warmingUp, true, '수정 전: 필드 없음 — 중앙이 완결로 GC');
    assert.equal(env.items, 3); assert.equal(env.reported, 1);
    // 전 항목을 한 번 덮으면 이후로는 예열이 아니다
    pol._setPollerStateForTest({ items, res: items.map(({ test: t }) => [t.id, { status: 'ok', reply: '', ms: 1, ts: Date.now(), streak: 1 }]), startedAt: Date.now() });
    const before2 = got.length;
    await quiet(() => sp.pushSvcmonNow());
    const env2 = got.slice(before2).find((g) => g.path === '/api/central/svcmon-report')?.body;
    assert.equal(env2?.warmingUp, undefined);
  } finally { replies.delete('/api/central/svcmon-report'); pol._setPollerStateForTest({}); }
});

// ─────────────────────────────────────────────────────────────────────────────
test('EDGE2606-04: SAN push 뒤 청크가 실패하면 한 번 전체 재전송하고, 그래도 실패하면 중앙 목록이 부분 상태임을 밝힌다', async () => {
  const store = await import('../src/sanswitch/store.js');
  const push = await import('../src/sanswitch/push.js');
  const pad = 'x'.repeat(40_000);
  for (const id of ['sw1', 'sw2', 'sw3']) store.putSnapshot({ deviceId: id, name: id, ok: true, collectedAt: T0, ports: { total: 0, list: [] }, extra: { pad } });
  let chunk1Fails = 1;
  replies.set('/api/central/sanswitch-data', (b) => {
    if (b?.chunk === 1 && chunk1Fails > 0) { chunk1Fails -= 1; return { status: 400, json: { ok: false, reason: 'x' } }; }
    return { status: 200, json: { ok: true } };
  });
  try {
    const before = got.length;
    const r1 = await quiet(() => push.pushSanSwitchNow());
    assert.equal(r1.ok, true, `한 번 재전송으로 복구 — ${r1.reason || ''}`);
    assert.equal(push.sanSwitchPushStatus().resent, true);
    const c0 = got.slice(before).filter((g) => g.path === '/api/central/sanswitch-data' && g.body?.chunk === 0);
    assert.equal(c0.length, 2, '청크 0 부터 전체를 다시 보냈다(수정 전: 1회 후 throw)');
    // 계속 실패 → 부분 상태 명시
    chunk1Fails = 99;
    const r2 = await quiet(() => push.pushSanSwitchNow());
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /중앙 목록이 부분 상태/);
    assert.equal(r2.centralPartial.receivedChunks, 1);
    assert.equal(r2.centralPartial.chunks, 3);
    assert.equal(push.sanSwitchPushStatus().centralPartial.receivedDevices, 1);
    // 첫 청크 실패는 중앙 목록이 그대로임을 말한다(재전송하지 않는다)
    replies.set('/api/central/sanswitch-data', () => ({ status: 400, json: { ok: false } }));
    const before3 = got.length;
    const r3 = await quiet(() => push.pushSanSwitchNow());
    assert.match(r3.reason, /직전 push 그대로/);
    assert.equal(got.slice(before3).filter((g) => g.path === '/api/central/sanswitch-data').length, 1);
  } finally {
    replies.delete('/api/central/sanswitch-data');
    for (const id of ['sw1', 'sw2', 'sw3']) store.dropSnapshot(id);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('RECENT2606-02: remoteSeriesKey — DB 에 전용 계열이 있으면 그 키(영속), 신선한 타 수집기 보고가 있으면 분리, 아니면 예전 키', async () => {
  const st = await import('../src/collector/state.js');
  assert.deepEqual(st.remoteSeriesKey('A', 'esx01', new Set()).key, 'rmt:esx01');
  assert.equal(st.remoteSeriesKey('A', 'esx01', new Set(['esx01'])).key, 'rmt:A:esx01');
  assert.equal(st.remoteSeriesKey('A', 'esx01', new Set(), (k) => k === 'rmt:A:esx01').key, 'rmt:A:esx01');
  // 신선도: 3일 된 타 수집기 항목은 충돌이 아니다
  st.setRemoteHost('esx-old', { watts: 1, ts: T0 - 3 * 86_400_000, collectorId: 'edgeA' });
  st.setRemoteHost('esx-new', { watts: 1, ts: T0 - 60_000, collectorId: 'edgeA' });
  const others = st.hostsOfOtherCollectors('edgeB', { now: T0 });
  assert.equal(others.has('esx-old'), false, '수정 전: 며칠 전 죽은 엣지 잔재도 충돌');
  assert.equal(others.has('esx-new'), true);
  assert.equal(st.hostsOfOtherCollectors('edgeB', { now: T0, activeIds: new Set(['edgeB']) }).has('esx-new'), false, '비활성 수집기 항목은 충돌이 아니다');
  st.setRemoteHost('esx-old', { watts: 1, ts: T0 - 3 * 86_400_000, collectorId: 'edgeB' });
  assert.equal(st.remoteHostConflicts({ now: T0 }).some((x) => x.host === 'esx-old'), false);
  st.clearCollectorHosts('edgeA'); st.clearCollectorHosts('edgeB');
});

test('RECENT2606-02(pull): 죽은 엣지 잔재로 키가 바뀌지 않고, 재시작 뒤 첫 pull 도 영속된 분리 키를 쓴다', async () => {
  const express = (await import('express')).default;
  const { addCollector } = await import('../src/collector/registry.js');
  const puller = await import('../src/collector/puller.js');
  const st = await import('../src/collector/state.js');
  const now = Date.now(); // 표본 시각(신선도 컷 안) — 판정 기준이 아니다
  const edge = async (payload) => {
    const ea = express(); ea.get('/api/collector/export', (_q, s) => s.json(payload()));
    const s = await new Promise((r) => { const x = ea.listen(0, '127.0.0.1', () => r(x)); });
    test.after(() => s.close());
    return `http://127.0.0.1:${s.address().port}`;
  };
  let tsA = now - 5000; let tsB = now - 4000;
  const urlA = await edge(() => ({ version: '2.606.0', agent: 'ra', datacenter: 'A', power: { byHost: [{ host: 'esx-r', watts: 300, ts: tsA, serverId: 1 }] } }));
  const urlB = await edge(() => ({ version: '2.606.0', agent: 'rb', datacenter: 'B', power: { byHost: [{ host: 'esx-r', watts: 900, ts: tsB, serverId: 1 }] } }));
  // ① 비활성 수집기 rdead 의 신선한 잔재 + 며칠 된 잔재 → rb 는 예전 키
  addCollector({ id: 'rdead', name: 'rdead', url: 'http://127.0.0.1:1', token: 't', enabled: false });
  st.setRemoteHost('esx-r', { watts: 5, ts: now - 1000, collectorId: 'rdead' });
  st.setRemoteHost('esx-r', { watts: 5, ts: now - 3 * 86_400_000, collectorId: 'rold' });
  addCollector({ id: 'rb', name: 'rb', url: urlB, token: 't', enabled: true });
  assert.equal(await quiet(() => puller.pullCollectorByAgent('rb')), true);
  const eB = st.remotePowerEntries().find((x) => x.collectorId === 'rb' && x.host === 'esx-r');
  assert.equal(eB.dbKey, 'rmt:esx-r', '수정 전: rmt:rb:esx-r(죽은·비활성 엣지 잔재를 충돌로 셌다)');
  st.clearCollectorHosts('rdead'); st.clearCollectorHosts('rold');
  // ② 진짜 충돌: ra 가 같은 호스트명을 보고 → ra 는 분리 키
  addCollector({ id: 'ra', name: 'ra', url: urlA, token: 't', enabled: true });
  assert.equal(await quiet(() => puller.pullCollectorByAgent('ra')), true);
  assert.equal(st.remotePowerEntries().find((x) => x.collectorId === 'ra').dbKey, 'rmt:ra:esx-r');
  // ③ '재시작' — 인메모리 상태가 빈 채로 ra 가 먼저 pull 해도 DB 에 전용 계열이 있으므로 예전 키에 쓰지 않는다
  st.clearCollectorHosts('ra'); st.clearCollectorHosts('rb');
  tsA = now - 2000;
  assert.equal(await quiet(() => puller.pullCollectorByAgent('ra')), true);
  assert.equal(st.remotePowerEntries().find((x) => x.collectorId === 'ra').dbKey, 'rmt:ra:esx-r', '수정 전: 재시작 첫 pull 이 rmt:esx-r 에 썼다');
  st.clearCollectorHosts('ra'); st.clearCollectorHosts('rb');
});
