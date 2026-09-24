// v2.606 감사 그룹 c — 수집기.
//   COL2606-01 현재 사용자 quser 원문 절단 · COL2606-02 NSX 그룹 멤버 페이징·실패 · COL2606-03/06 Capacity 처리량·디스크 ·
//   COL2606-04 + WEB2606-09 Horizon 세션 절단·상태 미확인 · COL2606-05 vCenter REST 폴백 · RECENT2606-01 Isilon mixed 표지 ·
//   EDGE2606-01 GPU 게스트 push 보류 · LEFT2606-01 GPU 게스트 고정 IP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2606c-'));
process.env.CONFIG_DIR = TMP;
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.DATA_SOURCE = 'live';
process.env.CURUSER_DB_PATH = path.join(TMP, 'curuser.db');

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const json = (r, o, s = 200) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
let _tls = null;
function tlsOpts() {
  if (_tls) return _tls;
  const dir = path.join(TMP, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  _tls = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  return _tls;
}

// ── COL2606-01 ────────────────────────────────────────────────────────────────
async function truncatedGuestInfo(nSessions) {
  const { CHUNK, MAX_CHUNKS } = await import('../src/curuser/agentScript.js');
  const pad = (s, n) => s.padEnd(n);
  const hdr = ' USERNAME              SESSIONNAME        ID  STATE   IDLE TIME  LOGON TIME';
  const rows = [];
  for (let i = 0; i < nSessions; i++) rows.push(' ' + pad('user' + i, 22) + pad('rdp-tcp#' + i, 17) + String(i + 2).padStart(3) + '  Active          .  9/24/2026 10:00 AM');
  const raw = [hdr, ...rows].join('\r\n');
  let b = Buffer.from(raw, 'utf8').toString('base64'); let om = 0; const max = CHUNK * MAX_CHUNKS;
  if (b.length > max) { b = b.slice(0, max); om = 1; }
  const m = {}; const P = 'guestinfo.curuser.';
  let n = 0; for (let i = 0; i < b.length; i += CHUNK) { m[P + 'd' + n] = b.slice(i, i + CHUNK); n++; }
  Object.assign(m, { [P + 'n']: String(n), [P + 'v']: '1', [P + 'omitted']: String(om), [P + 'host']: 'h', [P + 'err']: '-', [P + 'at']: String(Math.floor(Date.now() / 1000)) });
  return m;
}

test('COL2606-01: 발행기가 원문을 자르면 잘린 마지막 줄을 버리고 하한(usersLowerBound)으로 밝힌다', async () => {
  const { readGuestInfo } = await import('../src/curuser/guestinfoSource.js');
  const { aggregateAll } = await import('../src/curuser/aggregate.js');
  const r = readGuestInfo(await truncatedGuestInfo(120));
  assert.equal(r.omitted, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.usersLowerBound, true);
  assert.equal(r.other, 0, '잘린 마지막 줄이 가짜 other 세션이 되면 안 된다');
  assert.ok(r.sessions > 30 && r.sessions < 120);
  assert.equal(r.noUsers, false);
  const agg = aggregateAll([{ ...r, vmId: 'vm-1', vcenterId: 'vc-a' }]);
  assert.equal(agg.total.usersLowerBound, true);
  assert.equal(agg.total.vmsTruncated, 1);
  assert.equal(agg.vcenters[0].usersLowerBound, true);
  assert.equal(agg.total.usersByVcSumLowerBound, true);
  // 절단 없는 정상 원문은 그대로
  const ok = readGuestInfo(await truncatedGuestInfo(5));
  assert.equal(ok.truncated, false);
  assert.equal(ok.sessions, 5);
  assert.equal(aggregateAll([{ ...ok, vmId: 'vm-2', vcenterId: 'vc-a' }]).total.usersLowerBound, false);
});

test('COL2606-01: 최신값 DB 가 절단 표지를 보존한다(화면이 latestRecords 로 다시 집계한다)', async () => {
  const { readGuestInfo } = await import('../src/curuser/guestinfoSource.js');
  const db = await import('../src/curuser/db.js');
  const r = readGuestInfo(await truncatedGuestInfo(120));
  const c = await db.commitCurUser({ ts: Date.now(), records: [{ ...r, vmId: 'vm-1', vcenterId: 'vc-a', name: 'rds' }], replaceVcenters: ['vc-a'] });
  assert.equal(c.ok, true, JSON.stringify(c));
  const rows = await db.latestRecords('vc-a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].truncated, true);
  assert.equal(rows[0].usersLowerBound, true);
});

// ── COL2606-02 ────────────────────────────────────────────────────────────────
test('COL2606-02: NSX 그룹 멤버는 cursor 를 따라가고 result_count 를 쓰며, 한쪽 실패는 0 이 아니라 null + 사유다', async () => {
  const hits = [];
  const srv = https.createServer(tlsOpts(), (q, r) => {
    hits.push(q.url);
    if (q.url.includes('virtual-machines')) {
      const page = q.url.includes('cursor=') ? 2 : 1;
      const res = Array.from({ length: page === 1 ? 1000 : 400 }, (_, i) => ({ display_name: `vm${page}-${i}` }));
      return json(r, page === 1 ? { results: res, cursor: 'c1', result_count: 2400 } : { results: res, result_count: 2400 });
    }
    r.statusCode = 500; r.end('err');
  });
  const port = await listen(srv);
  try {
    const { fetchGroupMembers } = await import('../src/nsx/client.js');
    const d = await fetchGroupMembers({ host: `https://127.0.0.1:${port}`, username: 'u', password: 'p' }, 'g1');
    assert.equal(d.vmCount, 2400, 'result_count 를 쓴다');
    assert.ok(hits.some((h) => h.includes('cursor=c1')), 'cursor 를 따라간다');
    assert.equal(d.ipCount, null, '실패한 쪽은 0 이 아니라 null');
    assert.match(d.ipError, /500/);
    assert.equal(d.vmError, '');
    assert.equal(d.vmTruncated, false);
  } finally { srv.close(); }
});

// ── COL2606-03 / 06 ───────────────────────────────────────────────────────────
test('COL2606-03: 처리량은 선로 인터페이스만(bond 슬레이브·VLAN 제외) 더하고 음수 델타는 null', async () => {
  const { sumWireNetBytes, counterBps, collectors } = await import('../src/capacity/collectors.js');
  const dev = 'Inter-|   Receive |  Transmit\n face |bytes\n  eno1: 125000000 0 0 0 0 0 0 0 7 0\n  eno2: 0 0 0 0 0 0 0 0 0 0\n'
    + ' bond0: 125000000 0 0 0 0 0 0 0 7 0\nbond0.100: 125000000 0 0 0 0 0 0 0 7 0\n    lo: 999 0 0 0 0 0 0 0 999 0';
  const cls = { eno1: { device: true, bonding: false, masterIsBond: true }, eno2: { device: true, bonding: false, masterIsBond: true },
    bond0: { device: false, bonding: true, masterIsBond: false }, 'bond0.100': { device: false, bonding: false, masterIsBond: false } };
  const r = sumWireNetBytes(dev, (i) => cls[i] || null);
  assert.equal(r.rx, 125000000, '예전 규칙은 3배(375,000,000)');
  assert.equal(r.mode, 'sys');
  // /sys 가 없으면 폴백 — VLAN(이름.번호)은 빼고 더한다
  const fb = sumWireNetBytes(dev, () => null);
  assert.equal(fb.mode, 'fallback');
  assert.equal(fb.rx, 250000000);
  assert.equal(counterBps(100, 200, 1000), null, '카운터 리셋은 0 bps 가 아니다');
  assert.equal(counterBps(1125, 1000, 1000), 1000);
  // 수집기 경로(sample)도 같은 규칙
  const orig = fs.readFileSync;
  let rx = 1000;
  fs.readFileSync = (p, ...a) => (p === '/proc/net/dev' ? `Inter-|\n face |\nzz9: ${rx} 0 0 0 0 0 0 0 0 0` : orig(p, ...a));
  try {
    const c = Object.fromEntries(collectors().map((x) => [x.key, x]));
    const ctx = { prev: {}, now: 0, cores: 4 };
    c.net_rx.sample(ctx);
    ctx.now = 1000; rx = 500;
    assert.equal(c.net_rx.sample(ctx), null, '감소(리셋)는 null');
  } finally { fs.readFileSync = orig; }
});

test('COL2606-06: 디스크 사용률은 df 정의 used/(used+avail)', async () => {
  const { dfUsedPct, collectors } = await import('../src/capacity/collectors.js');
  assert.equal(dfUsedPct({ blocks: 1000, bsize: 4096, bfree: 50, bavail: 0 }), 100);
  assert.equal(dfUsedPct({ blocks: 1000, bfree: 1000, bavail: 950 }), 0);
  assert.equal(dfUsedPct({ blocks: 0, bfree: 0, bavail: 0 }), null);
  const origS = fs.statfsSync;
  fs.statfsSync = () => ({ blocks: 1000, bsize: 4096, bfree: 50, bavail: 0 });
  try {
    const c = Object.fromEntries(collectors().map((x) => [x.key, x]));
    assert.equal(c.disk_used.sample({ prev: {}, now: 0 }), 100, '예전 식은 95');
  } finally { fs.statfsSync = origS; }
});

// ── COL2606-04 + WEB2606-09 ───────────────────────────────────────────────────
test('COL2606-04: 페이지 상한에 걸린 서버가 있으면 합계는 하한이고 추이에는 부분 합을 적재하지 않는다', async () => {
  const { normalizeSessions, combineServers, seriesRow } = await import('../src/horizon/sessions.js');
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ user_name: `D\\u${i % 1500}`, session_state: 'CONNECTED' }));
  const a = { ok: true, serverId: 'A', truncated: true, pages: 20, ...normalizeSessions(mk(10000)) };
  const b = { ok: true, serverId: 'B', truncated: false, ...normalizeSessions(mk(10)) };
  const t = combineServers([a, b]);
  assert.equal(t.truncated, true);
  assert.equal(t.serversTruncated, 1);
  assert.equal(t.sessionsLowerBound, true);
  assert.equal(t.usersLowerBound, true);
  assert.equal(t.connectedLowerBound, true);
  const row = seriesRow(t);
  assert.equal(row.sessions, null, '부분 합(10,010)을 전체로 적재하지 않는다');
  assert.equal(row.users, null);
  assert.equal(row.connected, null);
  assert.equal(seriesRow(a).sessions, null, '서버 행도 같다');
  const full = combineServers([b]);
  assert.equal(full.truncated, false);
  assert.equal(seriesRow(full).sessions, 10);
});

test('WEB2606-09: 상태를 못 읽은 세션이 있으면 stateUnknown 을 합산하고 접속 중 수는 하한이다', async () => {
  const { normalizeSessions, combineServers, seriesRow } = await import('../src/horizon/sessions.js');
  const n = normalizeSessions([{ user_name: 'a', session_state: 'CONNECTED' }, { user_name: 'b' }, { user_name: 'c' }]);
  const t = combineServers([{ ok: true, serverId: 'A', ...n }]);
  assert.equal(t.connected, 1);
  assert.equal(t.stateUnknown, 2);
  assert.equal(t.connectedLowerBound, true);
  const row = seriesRow(t);
  assert.equal(row.connected, null);
  assert.equal(row.usersConnected, null);
  assert.equal(row.sessions, 3, '세션 수는 확정값');
});

// ── COL2606-05 ────────────────────────────────────────────────────────────────
test('COL2606-05: vCenter REST 폴백은 모르는 필드를 null 로 두고 저품질 표지를 싣는다', async () => {
  const srv = https.createServer(tlsOpts(), (q, r) => {
    const u = q.url;
    if (u === '/api/session') return q.method === 'DELETE' ? json(r, {}) : json(r, 'tok');
    if (u === '/api/vcenter/host') return json(r, [{ host: 'host-1', name: 'esx1', connection_state: 'CONNECTED', power_state: 'POWERED_ON' }]);
    if (u === '/api/vcenter/vm') return json(r, Array.from({ length: 4 }, (_, i) => ({ vm: `vm-${i}`, name: `v${i}`, power_state: 'POWERED_ON', cpu_count: 2, memory_size_MiB: 1024 })));
    if (u === '/api/vcenter/datastore') return json(r, []);
    if (u === '/api/vcenter/cluster') return json(r, []);
    if (u === '/api/vcenter/network') return json(r, []);
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  try {
    const { config } = await import('../src/config.js');
    const prev = config.vcSoapMetrics;
    config.vcSoapMetrics = false;
    try {
      const { collectFromVCenter } = await import('../src/vcenter/restClient.js');
      const s = await collectFromVCenter({ id: 'vc-r', name: 'R', host: `https://127.0.0.1:${port}`, username: 'u', password: 'p' });
      assert.equal(s.hosts[0].cluster, null, "'standalone' 을 지어내지 않는다");
      assert.equal(s.hosts[0].vmCount, null, 'VM 배치를 모르면 0 이 아니다');
      assert.equal(s.vcenter.collectSource, 'rest');
      assert.equal(s.vcenter.alarmsUnknown, true);
      assert.deepEqual(s.vcenter.restUnknown, ['cluster', 'vmPlacement', 'alarms']);
      assert.ok(Array.isArray(s.alarms), '소비처 호환 — 배열은 유지');
    } finally { config.vcSoapMetrics = prev; }
  } finally { srv.close(); }
});

// ── RECENT2606-01 ─────────────────────────────────────────────────────────────
test('RECENT2606-01: mixed 표지는 시한 뒤 사라지고, mixed 장비는 정확 값 칸을 가리지 않는다', async () => {
  const { markMixedBasis, _resetApproxSeenForTest, MIXED_HOLD_MS } = await import('../src/storage/collectors/isilonSsh.js');
  const { growthMatrix } = await import('../src/storage/growth.js');
  _resetApproxSeenForTest();
  const P = 2 ** 50 / 10;
  const T = 1_800_000_000_000;
  const rounded = () => ({ sections: { capacity: 'ok' }, extra: { capacityApprox: { source: 'isi-status', resolutionBytes: P } } });
  const exact = () => ({ sections: { capacity: 'ok' }, extra: {} });
  markMixedBasis(rounded(), 'dev-1', T);
  const s1 = markMixedBasis(exact(), 'dev-1', T + 86_400_000);
  assert.equal(s1.extra.capacityApprox?.mixed, true);
  const s2 = markMixedBasis(exact(), 'dev-1', T + MIXED_HOLD_MS + 1);
  assert.equal(s2.extra.capacityApprox, undefined, '표지에는 시한이 있다');
  assert.equal(markMixedBasis(exact(), 'dev-1', T + MIXED_HOLD_MS + 2).extra.capacityApprox, undefined, '지운 뒤 다시 붙지 않는다');
  // growthMatrix: 40일 전부 정확 행, 하루 +10TB
  const rows = [];
  for (let d = 0; d < 40; d++) rows.push({ device_id: 'dev-1', day: 1000 + d, total_bytes: 1e16, used_bytes: 1e15 + d * 1e13, samples: 1, last_ts: d });
  const g = growthMatrix(rows, { asOfDay: 1039, meta: { 'dev-1': { capacityApprox: { source: 'mixed', mixed: true, resolutionBytes: P } } } });
  const c = g.devices[0].growth['1d'];
  assert.equal(c.bytes, 1e13);
  assert.equal(c.belowResolution, false, '양끝이 정확 값일 수 있는 mixed 칸을 가리지 않는다');
  assert.equal(c.mixed, true);
  assert.equal(c.resolutionBytes, P);
  // 전부 반올림(mixed 아님) 장비는 예전대로 가린다
  const g2 = growthMatrix(rows, { asOfDay: 1039, meta: { 'dev-1': { capacityApprox: { source: 'isi-status', resolutionBytes: P } } } });
  assert.equal(g2.devices[0].growth['1d'].belowResolution, true);
});

// ── EDGE2606-01 ───────────────────────────────────────────────────────────────
test('EDGE2606-01: 인벤토리를 못 읽은 vCenter 는 unread 이고, push 보류는 전부 읽은 폴에만 풀린다', async () => {
  const { inventoryUnreadReason } = await import('../src/gpu/poller.js');
  assert.match(inventoryUnreadReason({ vcenters: [], hosts: [] }, 'vc-a'), /인벤토리 미수집/);
  assert.match(inventoryUnreadReason({ vcenters: [{ id: 'vc-a', status: 'pending' }], hosts: [] }, 'vc-a'), /pending/);
  assert.match(inventoryUnreadReason({ vcenters: [{ id: 'vc-a', status: 'connected' }], hosts: [] }, 'vc-a'), /호스트 0/);
  assert.equal(inventoryUnreadReason({ vcenters: [{ id: 'vc-a', status: 'connected' }], hosts: [{ vcenterId: 'vc-a', name: 'h' }] }, 'vc-a'), '');
  const gp = await import('../src/agent/gpuGuestPush.js');
  const T = 1_800_000_000_000;
  const unread = { at: T, unreadVcenters: [{ vcId: 'vc-a', reason: '인벤토리 미수집' }] };
  const w = gp.gpuGuestPushWithhold(unread, null, T);
  assert.equal(w.withhold, true, '못 읽은 vCenter 가 있는 폴은 빈 목록을 보내지 않는다');
  assert.equal(w.reason, 'unread-vcenters');
  assert.equal(gp.gpuGuestPushWithhold(unread, T, T + gp.GPU_GUEST_PUSH_WITHHOLD_MAX_MS + 1).withhold, false, '보류에는 시한');
  assert.equal(gp.gpuGuestPushWithhold({ at: T, unreadVcenters: [] }, T, T).withhold, false);
  assert.equal(gp.gpuGuestPushWithhold({ at: T }, T, T).withhold, false, '예전 모양(필드 없음)도 통과');
});

// ── LEFT2606-01 ───────────────────────────────────────────────────────────────
test('LEFT2606-01: 고정 IP 는 그 VM 이 보고한 IP 일 때만 — 폴러 판정과 저장 거부', async () => {
  const { pinnedIpCheck, unknownPinnedIps, guestIps } = await import('../src/gpu/sshCollect.js');
  const vm = { id: 'vc-a:vm-1', vcenterId: 'vc-a', ipAddresses: ['10.1.1.5'] };
  const bad = pinnedIpCheck(vm, '203.0.113.9');
  assert.equal(bad.ok, false);
  assert.equal(bad.ip, '');
  assert.deepEqual(guestIps(vm, bad.ip), ['10.1.1.5'], '핀을 버리면 VM 이 보고한 IP 로만');
  assert.equal(pinnedIpCheck(vm, '10.1.1.5').ip, '10.1.1.5');
  const body = { vcenters: { 'vc-a': { vmIps: { 'vc-a:vm-1': '203.0.113.9', 'vc-a:vm-9': '198.51.100.1' } } } };
  const out = unknownPinnedIps(body, { vms: [vm] });
  assert.equal(out.length, 1, '스냅샷에 없는 VM 은 판정 근거가 없어 받는다');
  assert.equal(out[0].ip, '203.0.113.9');
  // 이미 저장돼 있던 값은 다른 설정 저장을 막지 않는다
  assert.equal(unknownPinnedIps(body, { vms: [vm] }, body).length, 0);
  // 폴러가 이 판정을 실제로 쓴다(소스 — pollLive 는 vCenter 로그인이 필요해 단위로 부를 수 없다)
  const src = fs.readFileSync(new URL('../src/gpu/poller.js', import.meta.url), 'utf8');
  assert.match(src, /pinnedIpCheck\(v, resolveVmIp\(s, vc\.id, v\.id\)\)/);
  assert.match(src, /preferIp: pin\.ip/);
  const route = fs.readFileSync(new URL('../src/routes/admin/gpuGuest.js', import.meta.url), 'utf8');
  assert.match(route, /unknownPinnedIps\(req\.body/);
});
