// v2.744 감사 수정 그룹 GD — 엣지 iDRAC 등록부 손상 시 fleet push 의 빈 목록 교체(EDGE-01) · 파트 장애 보고의 '재배정·삭제' 오판(EDGE-01) ·
// 손상 등록부를 자동 경로가 덮어써 '읽지 못함' 표지를 지우던 것(EDGE-03) · 위임 스캔 결과 재전송 창 약 2.6분(TIMING-01).
// 실제 함수 · 실제 centralRouter(express 마운트) · 실제 엣지 워커(가짜 중앙)로 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744d-'));
process.env.CONFIG_DIR = TMP;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2744d';
delete process.env.CENTRAL_URL;
delete process.env.AGENT_IDRAC_SCAN_POLL_MS;

const IDRAC_FILE = path.join(TMP, 'idrac.json');
const corruptIdrac = () => fs.writeFileSync(IDRAC_FILE, '{"servers": [ 손상');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let registry; let config; let central; let centralUrl; let fleetHits = 0;
before(async () => {
  registry = await import('../src/idrac/registry.js');
  ({ config } = await import('../src/config.js'));
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use((req, _res, next) => { if (req.path === '/api/central/fleet') fleetHits++; next(); });
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  centralUrl = `http://127.0.0.1:${await listen(central)}`;
});
after(() => {
  central?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* */ }
});

const seedIdrac = () => registry.importServers([
  { id: 'bm-1', name: 'bm-1', host: '192.0.2.51', username: 'u', password: 'p' },
  { id: 'bm-2', name: 'bm-2', host: '192.0.2.52', username: 'u', password: 'p' },
], 'replace');
const corruptBackups = () => fs.readdirSync(TMP).filter((f) => f.startsWith('idrac.json.corrupt.'));

/* ════════════════════ EDGE-01 — fleet push ════════════════════ */

test('EDGE-01: 엣지 iDRAC 등록부가 손상이면 fleet push 는 빈 목록을 보내지 않는다 — 중앙(2.744+)은 직전 목록을 유지한다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const fp = await import('../src/agent/fleetPush.js');
  const cf = await import('../src/central/fleet.js');
  const tok = issueAgentToken('edge-gd2744');
  assert.equal(tok.ok, true);
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  try {
    config.agent.centralUrl = centralUrl; config.agent.centralToken = tok.token; config.agent.name = 'edge-gd2744';
    fp._setFleetStatusOnlySupportForTest(() => ({ ok: true }));
    seedIdrac();
    const r1 = await fp.pushFleetNow();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    const row = () => cf.listEdgeFleet().find((x) => x.agent === 'edge-gd2744');
    const n0 = row()?.baremetal;
    assert.ok(n0 >= 1, `정상 push 가 중앙 목록을 만든다: ${JSON.stringify(row())}`);

    corruptIdrac();
    assert.ok(registry.registryLoadError(), '손상이면 등록부가 읽지 못함을 말한다');
    const hits0 = fleetHits;
    const r2 = await fp.pushFleetNow();
    assert.equal(r2.ok, false); assert.equal(r2.skipped, true); assert.equal(r2.registryUnreadable, true);
    assert.equal(r2.statusOnly, true, `중앙 2.744+ 에는 상태 전용 보고를 보낸다: ${JSON.stringify(r2)}`);
    assert.equal(fleetHits, hits0 + 1);
    assert.equal(row()?.baremetal, n0, '중앙 목록이 빈 목록으로 교체되지 않는다(직전 목록 유지)');
    assert.ok(row()?.registryUnreadable?.reason, '중앙 행이 등록부 손상 보류를 말한다');
    const st = fp.fleetPushStatus().last;
    assert.ok(st?.registryUnreadable?.reason, '엣지 상태가 사유를 싣는다(무음 금지)');
    assert.equal(st.statusOnly, true);

    // 구버전·버전 미상 중앙: 상태 전용 보고도 보내지 않는다(v2.613 EDGE2613-04 — 구버전은 목록 없는 본문을 빈 목록 교체로 받는다).
    fp._setFleetStatusOnlySupportForTest(() => ({ ok: false, reason: 'old-central', text: '중앙 2.743.0 은 상태 전용 보고를 모릅니다' }));
    const hits1 = fleetHits;
    const r3 = await fp.pushFleetNow();
    assert.equal(r3.skipped, true);
    assert.equal(fleetHits, hits1, '구버전 중앙에는 아무것도 보내지 않는다');
    assert.equal(row()?.baremetal, n0);
    assert.equal(fp.fleetPushStatus().last?.statusOnly, false);
    assert.equal(fp.fleetPushStatus().last?.statusOnlyReason, 'old-central');

    // 관리자가 등록을 다시 저장하면 표지가 풀리고 다음 push 가 목록을 다시 보낸다.
    fp._setFleetStatusOnlySupportForTest(() => ({ ok: true }));
    seedIdrac();
    assert.equal(registry.registryLoadError(), null);
    const r4 = await fp.pushFleetNow();
    assert.equal(r4.ok, true, JSON.stringify(r4));
    assert.equal(row()?.registryUnreadable, null, '정상 push 가 보류 표지를 지운다');
  } finally {
    fp._setFleetStatusOnlySupportForTest(null);
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
  }
});

test('EDGE-01: 중앙 holdEdgeFleet — 시한(UNREADABLE_HOLD_MS)이 지나면 만료를 미루지 않고 · 보관분 없음 · 이름 미검증 보고는 아무것도 바꾸지 않는다', async () => {
  const cf = await import('../src/central/fleet.js');
  cf.setEdgeFleet('edge-hold', [{ fleetId: 'f1', name: 'x', serviceTag: 'T1', vcenterId: '', source: 'idrac' }], null, { verified: true });
  const t0 = Date.now();
  const h1 = cf.holdEdgeFleet('edge-hold', { registryUnreadable: { at: t0, reason: '형식 오류' }, now: t0 });
  assert.equal(h1.kept, 1); assert.equal(h1.changed, true); assert.equal(h1.holdExpired, undefined);
  const h2 = cf.holdEdgeFleet('edge-hold', { registryUnreadable: { at: t0, reason: '형식 오류' }, now: t0 + 60_000 });
  assert.equal(h2.changed, false, '같은 보류가 이어지면 콘솔에 다시 쓰지 않는다');
  const late = cf.holdEdgeFleet('edge-hold', { registryUnreadable: { at: t0, reason: '형식 오류' }, now: t0 + cf.UNREADABLE_HOLD_MS + 60_000 });
  assert.equal(late.holdExpired, true, '보류에는 시한이 있다');
  assert.deepEqual(cf.holdEdgeFleet('edge-none', { registryUnreadable: { reason: 'x' } }), { kept: 0, noPrior: true });

  // 공유 토큰 + 모르는 이름의 상태 전용 보고 — 보관분을 붙잡지 않는다.
  const res = await fetch(`${centralUrl}/api/central/fleet`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Central-Token': 'ctok-2744d' },
    body: JSON.stringify({ agent: 'edge-hold', statusOnly: true, status: { registryUnreadable: { reason: 'x' } } }),
  });
  const b = await res.json();
  assert.equal(res.status, 200);
  assert.equal(b.unverifiedAgent, true, JSON.stringify(b));
  assert.equal(b.kept, 0);
});

/* ════════════════════ EDGE-01 — 파트 장애 보고 ════════════════════ */

test('EDGE-01: 등록부를 읽지 못한 장비군의 열린 장애는 unassigned 가 아니라 registry-unreadable 로 보류한다(엣지 보고 · 중앙 로컬)', async () => {
  const { runScan } = await import('../src/partfault/scan.js');
  const { buildPayload } = await import('../src/partfault/push.js');
  const pfe = await import('../src/central/partFaultEdge.js');
  const { transition } = await import('../src/partfault/transition.js');
  corruptIdrac();
  const scan = await runScan();
  assert.ok(scan.registryUnreadable?.idrac?.reason, `스캔이 iDRAC 등록부 손상을 싣는다: ${JSON.stringify(scan.registryUnreadable)}`);
  assert.equal(scan.registryUnreadable.storage, undefined, '읽은 장비군은 싣지 않는다');
  const payload = buildPayload(scan, { agent: 'edge-pf2744', version: '2.744.0' });
  assert.ok(payload.registryUnreadable?.idrac, 'push 본문이 표지를 싣는다');

  pfe._resetForTest(null);
  const put = await pfe.putEdgeReport('edge-pf2744', payload);
  assert.equal(put.ok, true, JSON.stringify(put));
  const edge = pfe.mergeEdgeReports();
  assert.ok(edge.scopeUnreadable['edge-pf2744|idrac'], JSON.stringify(edge.scopeUnreadable));

  const open = [
    { agent: 'edge-pf2744', partKey: 'idrac:SVC1:psu:PSU1', scope: 'idrac', deviceId: 'srv-1', kind: 'psu', partId: 'PSU1', state: 'fault', firstSeenAt: 1 },
    { agent: 'edge-pf2744', partKey: 'storage:arr-1:disk:D1', scope: 'storage', deviceId: 'arr-1', kind: 'disk', partId: 'D1', state: 'fault', firstSeenAt: 1 },
    { agent: '', partKey: 'idrac:SVC9:fan:F1', scope: 'idrac', deviceId: 'srv-9', kind: 'fan', partId: 'F1', state: 'fault', firstSeenAt: 1 },
  ];
  const scopeUnreadable = { ...edge.scopeUnreadable, '|idrac': '중앙 로컬 손상' };
  const tr = transition({ open, observed: edge.observed, scan: { deviceOk: edge.deviceOk, kindFailed: edge.kindFailed, agentsReported: new Set(['', 'edge-pf2744']), deviceReason: edge.deviceReason, scopeUnreadable } });
  const hold = Object.fromEntries(tr.held.map((h) => [h.partKey, h.holdReason]));
  assert.equal(hold['idrac:SVC1:psu:PSU1'], 'registry-unreadable', '엣지 iDRAC 등록부 손상 — 재배정·삭제가 아니다');
  assert.equal(hold['idrac:SVC9:fan:F1'], 'registry-unreadable', '중앙 로컬(agent 빈 값)도 같은 규칙');
  assert.equal(hold['storage:arr-1:disk:D1'], 'unassigned', '읽은 장비군은 예전 판정 그대로(장비군 단위)');
  assert.equal(tr.closed.length, 0, '닫지 않는다');
  assert.equal(tr.stats.heldRegistryUnreadable, 2);

  // 오래된 보고의 표지는 쓰지 않는다(지금도 그런지 모른다 — 그 장비는 edge-stale 로 보류된다).
  const stale = pfe.mergeEdgeReports({ now: Date.now() + 4 * 3_600_000 });
  assert.deepEqual(stale.scopeUnreadable, {});
  // 중앙 폴러가 엣지 표지와 자기(로컬) 표지를 함께 전이에 넘긴다(소스 — runOnce 는 DB·알림까지 돌아 단위로 부르지 않는다).
  const { stripComments } = await import('./_stripComments.js');
  const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const poller = stripComments(fs.readFileSync(path.join(SRC, 'partfault/poller.js'), 'utf8'));
  assert.match(poller, /edge\.scopeUnreadable/);
  assert.match(poller, /local\.registryUnreadable/);
  assert.match(poller, /transition\(\{[^}]*scan:\s*\{[^}]*scopeUnreadable/);
  seedIdrac();
});

/* ════════════════════ EDGE-03 — 자동 경로는 손상 등록부에 쓰지 않는다 ════════════════════ */

test('EDGE-03: registerScanned(auto) 는 손상 등록부에 저장하지 않는다 — 표지·보존본 유지, 관리자 저장(auto 없음)만 표지를 지운다', () => {
  corruptIdrac();
  assert.ok(registry.registryLoadError());
  const r = registry.registerScanned([{ ip: '192.0.2.61', serviceTag: 'T61', hostName: 'h61', vendor: 'dell' }], 'root', 'pw', 'merge', '', 'DC1', { auto: true });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'registry-unreadable');
  assert.equal(r.refused, 1);
  assert.match(r.reason, /자동으로 저장하지 않았습니다/);
  assert.ok(registry.registryLoadError(), '읽지 못함 표지가 그대로다(다음 export·fleet·파트 장애 보호가 유지된다)');
  assert.equal(fs.existsSync(IDRAC_FILE), false, '손상 자리에 새 파일을 쓰지 않는다');
  assert.ok(corruptBackups().length >= 1, '손상 보존본이 남는다');
  // 관리자 화면 저장(auto 없음)은 예전 그대로 저장하고 표지를 지운다.
  const m = registry.registerScanned([{ ip: '192.0.2.61', serviceTag: 'T61', hostName: 'h61', vendor: 'dell' }], 'root', 'pw', 'merge', '', 'DC1');
  assert.equal(m.ok, true, JSON.stringify(m));
  assert.equal(registry.registryLoadError(), null);
  seedIdrac();
});

test('EDGE-03: 자동 호출부(위임 워커·엣지 스캐너·로컬 스캔·주기 스캔)는 auto 를 넘기고, 관리자 라우트만 넘기지 않는다(소스)', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const read = (p) => stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));
  for (const p of ['agent/idracScanWorker.js', 'agent/scanner.js', 'idrac/localScan.js', 'idrac/scanPoller.js']) {
    const calls = read(p).match(/registerScanned\([\s\S]*?\);/g) || [];
    assert.ok(calls.length >= 1, `${p} 에 호출이 있다`);
    for (const c of calls) assert.match(c, /auto:\s*true/, `${p}: ${c.slice(0, 120)}`);
  }
  const route = read('routes/admin/idracScan.js').match(/registerScanned\([\s\S]*?\);/g) || [];
  for (const c of route) assert.doesNotMatch(c, /auto:\s*true/, '관리자 등록은 사람의 저장이다');
});

// v2.744(회귀 검토 GD-R3): 등록 잡은 중앙 관리자가 누른 '등록' 이라 사유가 '자동' 이 아니라 사람 요청 거절(그 엣지에서 할 조치)이다 —
//   손상 등록부에 쓰지 않는 것은 그대로다. 문구 단언을 그 사유로 바꿨다(자세한 회귀는 audit2744rd.test.js).
test('EDGE-03: 위임 등록 잡은 손상 등록부에 쓰지 않고 사유를 회신·상태에 싣는다', async () => {
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  let jobsServed = false; const results = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/idrac-scan-jobs')) {
        const jobs = jobsServed ? [] : [{ reqId: 'rq-reg', action: 'register', found: [{ ip: '192.0.2.71', serviceTag: 'T71', hostName: 'h71', vendor: 'dell' }], username: 'u', password: 'p', mode: 'merge' }];
        jobsServed = true;
        return res.end(JSON.stringify({ jobs }));
      }
      if (req.url.startsWith('/api/central/idrac-scan-result')) { try { results.push(JSON.parse(body)); } catch { /* */ } return res.end('{"ok":true}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  const port = await listen(fake);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edge-gd2744w';
    corruptIdrac();
    const W = await import('../src/agent/idracScanWorker.js');
    await W.runIdracScanWorkerOnce();
    assert.equal(results.length, 1, JSON.stringify(results));
    assert.equal(results[0].registered, 0);
    assert.match(String(results[0].error || ''), /요청한 등록을 저장하지 않았습니다/);
    assert.ok(registry.registryLoadError(), '잡이 표지를 지우지 않았다');
    const st = W.getIdracScanWorkerStatus();
    assert.ok(st.last?.registerError, JSON.stringify(st.last));
    // 중앙 정제가 그 사유를 버리지 않는다(새 결과 필드는 수신 화이트리스트에도 — v2.611 CEN2611-01).
    const { sanitizeIdracScanData } = await import('../src/central/idracScanJobs.js');
    assert.match(sanitizeIdracScanData({ registerError: results[0].error }).registerError, /요청한 등록을 저장하지 않았습니다/);
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
    await new Promise((r) => fake.close(r));
    seedIdrac();
  }
});

test('EDGE-03: 스토리지·SAN·PDU·CVP 설정 pull 은 손상 등록부를 중앙 배포분으로 다시 쓰되 그 사실을 남긴다(pullRecoveryNote)', async () => {
  const { pullRecoveryNote } = await import('../src/util/registryCore.js');
  assert.equal(pullRecoveryNote(null), null, '읽을 수 있으면 기록하지 않는다');
  const n = pullRecoveryNote({ at: 1000, reason: '형식 오류' }, { what: '스토리지 등록부(storage-devices.json)', restored: 3 });
  assert.equal(n.restored, 3); assert.equal(n.lostAt, 1000); assert.equal(n.reason, '형식 오류');
  assert.match(n.note, /중앙 배포분 3건으로 다시 썼습니다/);
  assert.match(n.note, /손상 보존본/);
  assert.doesNotMatch(n.note, /`|\*\*/, '문구에 백틱·별표가 없다');
  const { stripComments } = await import('./_stripComments.js');
  const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  for (const [p, call] of [['agent/storageConfigPull.js', 'applyPulledDevices('], ['agent/sanSwitchConfigPull.js', 'applyPulledDevices('], ['agent/pduConfigPull.js', 'applyPulledDevices('], ['agent/cvpConfigPull.js', 'applyPulledServers(']]) {
    const s = stripComments(fs.readFileSync(path.join(SRC, p), 'utf8'));
    const i = s.indexOf(call);
    assert.ok(i > 0, p);
    const before = s.slice(Math.max(0, i - 300), i);
    assert.match(before, /registryLoadError\(\)/, `${p}: 적용 직전에 손상 여부를 본다`);
    assert.match(s, /registryRecovered/, `${p}: 상태에 싣는다`);
  }
});

/* ════════════════════ TIMING-01 — 재전송 창은 나이로 끊는다 ════════════════════ */

test('TIMING-01: 미전송 결과 회신은 처음 보낸 뒤 30분 동안 다시 보낸다(시도 횟수 상한이 먼저 걸리지 않는다)', async () => {
  const prev = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name };
  let jobsServed = false; let resultHits = 0;
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/api/central/idrac-scan-jobs')) {
        const jobs = jobsServed ? [] : [{ reqId: 'rq-t1', action: 'register', found: [], username: 'u', password: 'p', mode: 'merge' }];
        jobsServed = true;
        return res.end(JSON.stringify({ jobs }));
      }
      if (req.url.startsWith('/api/central/idrac-scan-result')) { resultHits++; res.statusCode = 503; return res.end('{"ok":false}'); }
      res.statusCode = 404; res.end('{}');
    });
  });
  const port = await listen(fake);
  try {
    config.agent.centralUrl = `http://127.0.0.1:${port}`; config.agent.centralToken = 'tok'; config.agent.name = 'edge-gd2744t';
    const W = await import('../src/agent/idracScanWorker.js');
    const win = W.UNSENT_RETRY_WINDOW;
    assert.equal(win.pollMs, 5_000, '이 표는 기본 폴 주기(5초) 기준이다');
    assert.ok(win.maxAgeMs >= 20 * 60_000, '중앙이 늦은 결과를 받는 창(약 20분)보다 짧지 않다');
    await W.runIdracScanWorkerOnce();
    assert.equal(resultHits, 1);
    const first = W.getIdracScanWorkerStatus().unsentResults.find((x) => x.reqId === 'rq-t1');
    assert.ok(first, '미전송 목록에 둔다');
    const firstAt = first.nextAt - win.pollMs;
    const offsets = [Math.round((first.nextAt - firstAt) / 1000)];
    let dropped = null;
    for (let guard = 0; guard < 60 && !dropped; guard++) {
      const item = W.getIdracScanWorkerStatus().unsentResults.find((x) => x.reqId === 'rq-t1');
      if (!item) break;
      const r = await W.flushUnsentResults(item.nextAt);
      if (r.dropped) { dropped = W.getIdracScanWorkerStatus().unsentDropped; break; }
      const nx = W.getIdracScanWorkerStatus().unsentResults.find((x) => x.reqId === 'rq-t1');
      offsets.push(Math.round((nx.nextAt - firstAt) / 1000));
    }
    // 처음(+0) 뒤 +5·+15·+35·+75·+155·+315·+615·+915·+1215·+1515 초, 마지막은 나이 상한에 맞춘 +1800초.
    assert.deepEqual(offsets, [5, 15, 35, 75, 155, 315, 615, 915, 1215, 1515, 1800], JSON.stringify(offsets));
    assert.ok(dropped, '30분이 지나면 버린다');
    assert.equal(dropped.reqId, 'rq-t1');
    assert.equal(dropped.attempts, 12, JSON.stringify(dropped));
    assert.ok(dropped.ageMs >= 20 * 60_000, `버리는 나이: ${dropped.ageMs}`);
    assert.equal(resultHits, 12, '처음 포함 12번 보냈다');
  } finally {
    config.agent.centralUrl = prev.url; config.agent.centralToken = prev.tok; config.agent.name = prev.name;
    await new Promise((r) => fake.close(r));
  }
});
