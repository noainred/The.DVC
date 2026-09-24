/**
 * v2.604 감사 그룹 a — 중앙 수신·자기등록·엣지 push 회귀.
 *
 * RECENT2604-01 스캔 배정·결과가 같은 키(대소문자 무시) · CEN2604-01 자기등록 검증 ping 응답 크기 상한·형식 검사 ·
 * CEN2604-03 엣지 bm-usage 보관분 정제 · CEN2604-04 공유 토큰 자기등록 상한 + 미검증 이름은 '아는 엣지' 가 아님 ·
 * CEN2604-05 SAN 테스트 회신 snap 정제 · TIM2604-04 iDRAC 스캔 폴링 기록 상한 ·
 * EDGE2604-01 fleet push 가 호스트를 못 읽은 주기를 보내지 않음 · EDGE2604-02 0 vCenter 조기 반환도 상태를 남김.
 * 전부 실제 함수·실제 라우터를 호출해 동작으로 본다(기준 시각에 Date.now() 를 쓰지 않는다).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2604a-'));
Object.assign(process.env, {
  CONFIG_DIR: CFG, CENTRAL_TOKEN: 'shared-2604a', DATA_SOURCE: 'live', AUTH_ENABLED: 'true',
  IPAM_WRITE_WORKER: '0', SSRF_ALLOW_LOOPBACK: 'true',
});
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));

const express = (await import('express')).default;
const { centralRouter } = await import('../src/routes/central.js');
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use('/api/central', centralRouter);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}/api/central`;
test.after(() => srv.close());

// 닫힌 포트 — urlHint 검증이 즉시 실패(ECONNREFUSED)하게.
const closedPort = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const J = { 'Content-Type': 'application/json' };

test('RECENT2604-01: 토큰 이름과 스캔 설정 키가 대소문자만 달라도 배정과 결과가 같은 설정을 본다', async () => {
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const ss = await import('../src/ipam/scanStore.js');
  const tok = issueAgentToken('Edge-Seoul').token;
  ss.saveScanSettings('edge-seoul', { enabled: true, ranges: ['10.80.0.0/24'] });
  const h = { ...J, 'X-Central-Token': tok };
  const a = await fetch(`${base}/ip-scan-assignment?agent=Edge-Seoul`, { headers: h });
  const aj = await a.json();
  assert.equal(a.status, 200);
  assert.equal(aj.assigned, true);
  const r = await fetch(`${base}/ip-scan-result`, { method: 'POST', headers: h, body: JSON.stringify({ agent: 'edge-seoul', alive: [{ ip: '10.80.0.5' }, { ip: '10.99.0.5' }] }) });
  const rj = await r.json();
  assert.equal(r.status, 200, `수정 전에는 409 unassigned: ${JSON.stringify(rj)}`);
  assert.equal(rj.merged, 1); // 범위 밖 10.99.0.5 는 여전히 드롭
  // 대소문자만 다른 이름으로 저장하면 기존 키를 갱신한다(두 벌로 갈라지지 않는다)
  ss.saveScanSettings('EDGE-SEOUL', { ranges: ['10.81.0.0/24'] });
  assert.deepEqual(ss.loadScanSettings('edge-seoul').ranges, ['10.81.0.0/24']);
  assert.equal(ss.listScanAgents().filter((x) => x.name.toLowerCase() === 'edge-seoul').length, 1);
});

function streamResponse(bytes, { status = 200, fill = ' ' } = {}) {
  const chunk = new TextEncoder().encode(fill.repeat(16_384));
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent >= bytes) { c.close(); return; } c.enqueue(chunk); sent += chunk.byteLength; },
  });
  const res = new Response(body, { status, headers: { 'content-type': 'application/json' } });
  res.sentBytes = () => sent;
  return res;
}

test('CEN2604-01: 자기등록 검증은 ping 응답을 상한까지만 읽고, JSON 아님·ok 아님·agent 없음은 검증 실패다', async () => {
  const { verifyDerivedCollectorUrl, VERIFY_PING_MAX_BYTES } = await import('../src/collector/registry.js');
  assert.equal(VERIFY_PING_MAX_BYTES, 64 * 1024);
  // 50MB 공백 본문 — 수정 전에는 pr.json() 이 전량을 읽고(파싱 실패 → {}) ok:true 였다.
  let big;
  const v1 = await verifyDerivedCollectorUrl({ url: 'http://edge.example:4000', name: 'edge-B', token: 't' }, async () => { big = streamResponse(50 * 1048576); return big; });
  assert.equal(v1.ok, false);
  assert.match(v1.reason, /읽지 못함/);
  assert.ok(big.sentBytes() < 1048576, `상한에서 멈춰야 한다(읽은 바이트 ${big.sentBytes()})`);
  // 작은 비-JSON → 검증 실패(예전: {} → identityIssue null → ok:true)
  const v2 = await verifyDerivedCollectorUrl({ url: 'http://e', name: 'edge-B', token: 't' }, async () => new Response('<html>hi</html>', { status: 200 }));
  assert.equal(v2.ok, false);
  // ok:true 이지만 agent 없음 → 실패
  const v3 = await verifyDerivedCollectorUrl({ url: 'http://e', name: 'edge-B', token: 't' }, async () => Response.json({ ok: true }));
  assert.equal(v3.ok, false);
  assert.match(v3.reason, /이름\(agent\)/);
  // agent 가 객체 → 실패(던지지 않는다)
  const v4 = await verifyDerivedCollectorUrl({ url: 'http://e', name: 'edge-B', token: 't' }, async () => Response.json({ ok: true, agent: { toString: 1 } }));
  assert.equal(v4.ok, false);
  // 정상 ping → 통과
  const v5 = await verifyDerivedCollectorUrl({ url: 'http://e', name: 'edge-B', token: 't' }, async () => Response.json({ ok: true, agent: 'edge-B', hostname: 'h' }));
  assert.deepEqual(v5, { ok: true });
  // 다른 엣지 → 실패(기존 동작 유지)
  const v6 = await verifyDerivedCollectorUrl({ url: 'http://e', name: 'edge-B', token: 't' }, async () => Response.json({ ok: true, agent: 'edge-A' }));
  assert.equal(v6.ok, false);
});

test('CEN2604-04: 공유 토큰의 미검증 자기등록은 개수 상한(429)이고, 그 이름은 /fleet 에서 미검증으로 다뤄진다', async () => {
  const reg = await import('../src/collector/registry.js');
  const h = { ...J, 'X-Central-Token': 'shared-2604a' };
  const codes = [];
  for (let i = 0; i < reg.SELF_REG_UNVERIFIED_MAX + 3; i++) {
    const r = await fetch(`${base}/register-collector`, { method: 'POST', headers: h, body: JSON.stringify({ name: `ghost${i}`, urlHint: `http://127.0.0.1:${closedPort}`, collectorToken: 'x' }) });
    codes.push(r.status);
  }
  assert.equal(codes.filter((c) => c === 200).length, reg.SELF_REG_UNVERIFIED_MAX, `수정 전에는 전부 200: ${codes.join(',')}`);
  assert.equal(codes.filter((c) => c === 429).length, 3);
  const list = reg.loadCollectors();
  assert.equal(list.filter((c) => /^ghost/.test(c.id)).length, reg.SELF_REG_UNVERIFIED_MAX);
  assert.ok(list.find((c) => c.id === 'ghost0').selfRegUnverified);
  // 이미 있는 이름의 갱신은 상한과 무관하다
  const again = await fetch(`${base}/register-collector`, { method: 'POST', headers: h, body: JSON.stringify({ name: 'ghost0', urlHint: `http://127.0.0.1:${closedPort}`, collectorToken: 'y' }) });
  assert.equal(again.status, 200);
  // 미검증 자기등록 이름은 '아는 엣지' 가 아니다 → unverifiedAgent
  const f = await fetch(`${base}/fleet`, { method: 'POST', headers: h, body: JSON.stringify({ agent: 'ghost7', baremetal: [{ fleetId: 'f1', name: 'n1' }] }) });
  const fj = await f.json();
  assert.equal(f.status, 200);
  assert.equal(fj.unverifiedAgent, true, `수정 전에는 unverifiedAgent 가 없었다: ${JSON.stringify(fj)}`);
  // 관리자 등록(managed) 이름은 여전히 '아는 엣지'
  const add = reg.addCollector({ id: 'managed-edge', name: 'managed-edge', url: 'http://10.1.2.3:4000', token: 'z' }, { managed: true });
  assert.equal(add.ok, true);
  await new Promise((r) => setTimeout(r, 5_100)); // edgeNameKnown 5초 캐시
  const f2 = await (await fetch(`${base}/fleet`, { method: 'POST', headers: h, body: JSON.stringify({ agent: 'managed-edge', baremetal: [] }) })).json();
  assert.equal(f2.unverifiedAgent, undefined);
  // pull 이 성공한(상태 ok) 자기등록 항목은 '아는 엣지' 로 승격된다
  const { setCollectorStatus } = await import('../src/collector/state.js');
  setCollectorStatus('ghost3', { ok: true });
  await new Promise((r) => setTimeout(r, 5_100));
  const f3 = await (await fetch(`${base}/fleet`, { method: 'POST', headers: h, body: JSON.stringify({ agent: 'ghost3', baremetal: [] }) })).json();
  assert.equal(f3.unverifiedAgent, undefined);
});

test('CEN2604-03: 엣지 bm-usage 보관분은 아는 필드·타입만 담는다(객체 key·node.agent 가 화면을 죽이지 않게)', async () => {
  const m = await import('../src/central/bmUsageEdgePull.js');
  m._resetForTest();
  const evil = { toString: 1 };
  const rec = m.putEdgeBmUsage('fe', { ok: true, ms: 5, snap: {
    ok: true, node: { agent: { a: 1 }, version: '2.603.0' }, enabled: true,
    targets: [{ key: evil, name: 'srv1', vcenterId: 'vc1', license: { tier: 'enterprise', names: ['a', { x: 1 }] }, missing: ['no-os-cred'] }, 'x', null],
    rows: [{ key: 'k1', cpu_pct: 12.5, mem_pct: 'oops', extra: { deep: { deeper: 1 } } }],
    counts: { targets: 1, byReason: { 'no-idrac': 2, bad: 'x' } },
    authStops: [{ key: 'k1', path: 'os', attempts: 3, since: 1, reason: { r: 1 } }],
    settings: { intervalMs: 300000, corps: ['vc1', { x: 1 }] },
    truncated: 'nope',
  } });
  const s = rec.snap;
  assert.equal(s.node.agent, '');
  assert.equal(s.node.version, '2.603.0');
  assert.equal(s.targets.length, 1);
  assert.equal(s.sanitizeDropped, 2);
  assert.equal(s.targets[0].key, '');
  assert.doesNotThrow(() => String(s.targets[0].key));
  assert.deepEqual(s.targets[0].license.names, ['a']);
  assert.deepEqual(s.targets[0].missing, ['no-os-cred']);
  assert.equal(s.rows[0].cpu_pct, 12.5);
  assert.equal(s.rows[0].mem_pct, 'oops'.slice(0, 512)); // 글자는 글자로(원시값) — 숫자로 둔갑시키지 않는다
  assert.equal(typeof s.rows[0].extra.deep, 'undefined'); // 두 단계 이상 중첩은 버린다
  assert.deepEqual(s.counts, { targets: 1, byReason: { 'no-idrac': 2 } });
  assert.equal(s.authStops[0].reason, '');
  assert.deepEqual(s.settings.corps, ['vc1']);
  assert.equal(s.truncated, 0);
  // 형식이 아닌 snap → null(보관분으로 쓰지 않는다)
  assert.equal(m.sanitizeBmUsageSnap('x'), null);
  assert.equal(m.sanitizeBmUsageSnap([1]), null);
});

test('CEN2604-05: SAN 스위치 테스트 회신의 snap 은 화면이 쓰는 필드만 담고 ports 는 항상 객체다', async () => {
  const tr = await import('../src/sanswitch/testRuns.js');
  tr._resetForTest();
  const { id } = tr.startTestRun({ host: '10.9.9.9', agent: 'edge-san', collectMethod: 'ssh' });
  assert.equal(tr.takeTestRequestsForAgent('edge-san').length, 1);
  const big = 'x'.repeat(500_000);
  const c = tr.completeTestRun(id, 'EDGE-SAN', { ok: true, snap: { name: { evil: 1 }, model: big, domainId: '7', sections: { ns: 'ok', raslog: { x: 1 }, __proto__: 'x' } } });
  assert.equal(c.ok, true);
  const snap = tr.getTestRun(id).result.snap;
  assert.equal(snap.name, '');
  assert.equal(snap.model.length, 128);
  assert.equal(snap.domainId, 7);
  assert.deepEqual(snap.ports, { total: null, licensed: null, online: null, free: null, usedPct: null });
  assert.deepEqual(snap.sections, { ns: 'ok' });
  assert.equal(tr.sanitizeTestSnap('x'), undefined);
  tr._resetForTest();
});

test('TIM2604-04: iDRAC 스캔 잡 폴링 기록은 이름 길이·개수를 묶는다', async () => {
  const j = await import('../src/central/idracScanJobs.js');
  for (let i = 0; i < j.AGENT_POLLS_MAX + 200; i++) j.takeIdracScanJobs(`bogus-${i}-${'y'.repeat(300)}`);
  assert.ok(j._agentPollsSizeForTest() <= j.AGENT_POLLS_MAX, `수정 전에는 ${j.AGENT_POLLS_MAX + 200}개가 남았다(${j._agentPollsSizeForTest()})`);
  j.takeIdracScanJobs('Real-Edge');
  assert.ok(j.agentLastScanPoll('real-edge') > 0);
  assert.ok(j.recentPollingAgents(60_000).every((n) => n.length <= 128));
});

test('EDGE2604-01: 호스트를 읽지 못한 vCenter 가 있으면 fleet push 는 그 주기를 보내지 않고 사유를 남긴다', async () => {
  const fp = await import('../src/agent/fleetPush.js');
  // 순수 판정
  const reg = [{ id: 'vc1' }, { id: 'vc2' }, { id: 'vc3', enabled: false }, { id: 'vc4', collectMode: 'site' }];
  assert.deepEqual(fp.unreadHostVcenters({ vcenters: [], hosts: [] }, reg), ['vc1', 'vc2']); // 부팅 직후(첫 수집 전)
  assert.deepEqual(fp.unreadHostVcenters({ vcenters: [{ id: 'vc1', status: 'ok' }, { id: 'vc2', status: 'unreachable' }], hosts: [{ vcenterId: 'vc1' }] }, reg), ['vc2']);
  assert.deepEqual(fp.unreadHostVcenters({ vcenters: [{ id: 'vc1', status: 'ok' }, { id: 'vc2', status: 'unreachable' }], hosts: [{ vcenterId: 'vc1' }, { vcenterId: 'vc2' }] }, reg), []); // lastGood 로 호스트가 있으면 보낸다
  assert.deepEqual(fp.unreadHostVcenters({ vcenters: [{ id: 'vc1', status: 'maintenance' }], hosts: [] }, [{ id: 'vc1' }]), ['vc1']);
  assert.deepEqual(fp.unreadHostVcenters({ vcenters: [], hosts: [] }, []), []); // vCenter 없는 엣지(iDRAC 만) 는 보낸다
  // 실제 push — 등록부에 vCenter 가 있는데 스냅샷이 비어 있다(부팅 30초 뒤 첫 push 상황)
  const { config } = await import('../src/config.js');
  const prevUrl = config.agent.centralUrl;
  config.agent.centralUrl = `http://127.0.0.1:${closedPort}`;
  fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'vcA', name: 'vcA', host: 'https://10.0.0.1', username: 'u', password: 'p' }] }));
  try {
    const r = await fp.pushFleetNow();
    assert.equal(r.skipped, true, `수정 전에는 빈 호스트 스냅샷으로 전송을 시도했다: ${JSON.stringify(r)}`);
    const st = fp.fleetPushStatus().last;
    assert.equal(st.skipped, true);
    assert.deepEqual(st.unreadVcenters, ['vcA']);
    assert.match(st.note, /베어메탈/);
  } finally {
    config.agent.centralUrl = prevUrl;
    fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [] }));
  }
});

test('EDGE2604-02: vCenter 0개로 조기 반환해도 인벤토리·게스트 디스크 push 상태(last)를 갱신한다', async () => {
  const inv = await import('../src/agent/inventoryPush.js');
  const gd = await import('../src/agent/guestDiskPush.js');
  const r1 = await inv.pushInventoryNow();
  assert.equal(r1.ok, false);
  const l1 = inv.inventoryPushStatus().last;
  assert.ok(l1, '수정 전에는 last 가 null 로 남았다');
  assert.equal(l1.sent, 0);
  assert.match(l1.note, /vCenter 가 없습니다/);
  const r2 = await gd.pushGuestDiskNow();
  assert.equal(r2.ok, false);
  const l2 = gd.guestDiskPushStatus().last;
  assert.ok(l2);
  assert.match(l2.note, /vCenter 가 없습니다/);
});
