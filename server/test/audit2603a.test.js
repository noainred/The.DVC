// v2.603 감사 수정 — 그룹 a(중앙 메모리 상한 · IPAM). 실제 central 라우터를 express 에 띄워 상태코드·응답·저장 결과로 보고,
//   모듈은 실제 함수를 불러 동작으로 본다(소스 grep 이 아니다).
//   CEN2603-01 gpu byVm·byHost 상한 · CEN2603-02 스캔 결과 전체 상한 · CEN2603-03 원장 push 인자 상한 ·
//   CEN2603-04 agentIdentity 상한 · CEN2603-05 toString/valueOf 객체 → 500 · CEN2603-06 ping-result 등록 vCenter 만 ·
//   DB2603-01 ipam.db 열 추가가 잠금을 '이미 있음' 으로 삼키던 것
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOKEN = 'tok-2603a-shared';
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2603a-'));
process.env.CONFIG_DIR = CFG;
process.env.CENTRAL_TOKEN = TOKEN;
process.env.DATA_SOURCE = 'live';
process.env.AUTH_ENABLED = 'true';
process.env.IPAM_WRITE_DEBOUNCE_MS = '600000';
process.env.IPAM_WRITE_WORKER = '0';
process.env.IPAM_DB_LOCK_RETRY_MS = '300';
// 상한을 작게 — 동작(받지 않고 밝힌다 · 검증된 항목은 밀지 않는다)을 짧은 입력으로 본다.
process.env.GUEST_GPU_MAX_VMS = '100';
process.env.GUEST_GPU_MAX_VMS_PER_AGENT = '40';
process.env.GUEST_GPU_MAX_HOSTS = '50';
process.env.GUEST_GPU_MAX_HOSTS_PER_AGENT = '20';
process.env.IPAM_SCAN_RESULTS_MAX = '50';
process.env.CENTRAL_AGENT_IDENTITY_MAX = '10';
process.env.CENTRAL_AGENT_IDENTITY_UNVERIFIED_MAX = '3';
process.env.CENTRAL_VCENTER_OWNER_NOTE_MAX = '5';
fs.writeFileSync(path.join(CFG, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-a', name: 'A', host: 'https://10.0.0.1', collectMode: 'site' },
  { id: 'vc-d', name: 'D', host: 'https://10.0.0.9', collectMode: 'direct' },
] }));

// DB2603-01 준비: 새 열이 없는 옛 스키마의 ipam.db (import 전에 만든다)
const { DatabaseSync } = await import('node:sqlite');
const IPAM_DB = path.join(CFG, 'ipam.db');
{
  const old = new DatabaseSync(IPAM_DB);
  old.exec(`CREATE TABLE ip_records (ip TEXT NOT NULL, ip_num INTEGER, vcenter_id TEXT NOT NULL, vcenter_name TEXT, owner_type TEXT NOT NULL,
    owner_name TEXT NOT NULL, power_state TEXT, guest_os TEXT, host_name TEXT, cluster TEXT, multi_homed INTEGER DEFAULT 0,
    duplicate INTEGER DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE INDEX idx_ip_records_ip ON ip_records (ip); CREATE INDEX idx_ip_records_vc ON ip_records (vcenter_id);
    INSERT INTO ip_records (ip,vcenter_id,owner_type,owner_name,updated_at) VALUES ('10.0.0.1','vc','vm','a','x');`);
  old.close();
}

let srv; let base; let AGENT_TOKEN_G; let AGENT_TOKEN_S;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ ok: false, error: 'internal error', message: err.message }));
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api/central`;
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  AGENT_TOKEN_G = issueAgentToken('edgeG').token;
  AGENT_TOKEN_S = issueAgentToken('edgeS').token;
});
after(() => { srv?.close(); });

const post = (p, body, { token = TOKEN, headers = {} } = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Central-Token': token } : {}), ...headers },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const vmsOf = (prefix, n, from = 0) => Array.from({ length: n }, (_, i) => ({ vmId: `${prefix}:vm-${from + i}`, utilPct: 10 }));
const hostsOf = (prefix, n) => Array.from({ length: n }, (_, i) => ({ hostId: `${prefix}:host-${i}`, utilPct: 10 }));

// ── CEN2603-01 ───────────────────────────────────────────────────────────────
test('CEN2603-01 — gpu 오버레이: 엣지 보고는 교체 · 엣지별/전체 상한 · 이미 있는 다른 엣지 항목은 밀지 않는다 · 뺀 개수를 돌려준다', async () => {
  const g = await import('../src/gpu/store.js');
  g._resetGuestGpuForTest();
  // 엣지별 상한(40): 60개 중 40개만, 20개는 omitted
  let r = g.setGuestGpu({ vms: vmsOf('vc-a', 60), hosts: hostsOf('vc-a', 30), agent: 'A' });
  assert.deepEqual(r, { hosts: 20, vms: 40, omittedHosts: 10, omittedVms: 20 });
  // 같은 엣지가 다시 보내면 교체 — 쌓이지 않는다(예전: 매 push 가 새 id 면 무한 누적)
  r = g.setGuestGpu({ vms: vmsOf('vc-a', 60, 1000), agent: 'A' });
  assert.equal(g.guestGpuCounts().vms, 40, '교체라 40 그대로');
  assert.equal(g.getGuestGpuVms().filter((v) => v.vmId.startsWith('vc-a:vm-0')).length, 0, '이전 push 의 항목은 지워졌다');
  // 전체 상한(100): B 40 + C 는 20 만 들어가고 A 는 그대로 남는다
  g.setGuestGpu({ vms: vmsOf('vc-b', 40), agent: 'B' });
  r = g.setGuestGpu({ vms: vmsOf('vc-c', 40), agent: 'C' });
  assert.equal(r.vms, 20); assert.equal(r.omittedVms, 20);
  assert.equal(g.guestGpuCounts().vms, 100);
  assert.equal(g.getGuestGpuVms().filter((v) => v.agent === 'A').length, 40, '먼저 들어 있던 엣지의 항목은 밀리지 않는다');
  // 미검증 이름은 엣지별 상한의 1/10(=4)
  g._resetGuestGpuForTest();
  r = g.setGuestGpu({ vms: vmsOf('vc-a', 10), agent: 'ghost', verified: false });
  assert.equal(r.vms, 4); assert.equal(r.omittedVms, 6);
  // 로컬 폴러(agent='')는 교체하지 않는다 — vCenter 단위로 나눠 부르므로 두 번째 호출이 첫 번째를 지우면 안 된다
  g._resetGuestGpuForTest();
  g.setGuestGpu({ vms: vmsOf('vc-x', 5) });
  g.setGuestGpu({ vms: vmsOf('vc-y', 5) });
  assert.equal(g.guestGpuCounts().vms, 10);
  g._resetGuestGpuForTest();
});

test('CEN2603-01 — /gpu-guest-data: 등록되지 않은 vCenter 접두는 버리고 상한 초과분을 응답에 밝힌다', async () => {
  const g = await import('../src/gpu/store.js');
  g._resetGuestGpuForTest();
  const r = await post('/gpu-guest-data', { agent: 'edgeG', vms: [...vmsOf('vc-a', 60), ...vmsOf('vc-zzz', 5)], hosts: [] }, { token: AGENT_TOKEN_G });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.vms, 40);
  assert.deepEqual(r.body.omitted, { hosts: 0, vms: 20 });
  assert.equal(r.body.unregistered, 5, '등록부에 없는 vCenter 접두(vc-zzz)는 받지 않는다');
  assert.equal(g.getGuestGpuVms().filter((v) => v.vmId.startsWith('vc-zzz')).length, 0);
  // 공유 토큰 + 중앙이 모르는 이름 = 미검증(작은 상한)
  const s = await post('/gpu-guest-data', { agent: 'nobody-knows', vms: vmsOf('vc-a', 10, 500), hosts: [] });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.unverifiedAgent, true);
  assert.equal(s.body.vms, 4);
  g._resetGuestGpuForTest();
});

// ── CEN2603-02 ───────────────────────────────────────────────────────────────
test('CEN2603-02 — 스캔 결과·이력 전체 상한: 새 IP 는 상한 안에서만 받고 개수를 돌려준다 · 기존 IP 갱신은 계속 받는다', async () => {
  const ss = await import('../src/ipam/scanStore.js');
  assert.equal(ss.MAX_SCAN_IPS, 50);
  const TS = 1_700_000_000_000;
  const ips = Array.from({ length: 80 }, (_, i) => ({ ip: `10.70.0.${i + 1}`, openPorts: [22] }));
  const r = ss.mergeScanResults(ips, TS, 'e1');
  assert.deepEqual(r, { merged: 50, capped: 30 });
  assert.equal(Object.keys(ss.getScanResults()).length, 50);
  assert.equal(ss.getScanResults()['10.70.0.60'], undefined);
  // 상한에 닿아도 이미 있는 IP 의 갱신은 받는다(다른 엣지 것도 밀지 않는다)
  const u = ss.mergeScanResults([{ ip: '10.70.0.1', openPorts: [22, 443] }], TS + 1000, 'e1');
  assert.deepEqual(u, { merged: 1, capped: 0 });
  assert.deepEqual(ss.getScanResults()['10.70.0.1'].openPorts, [22, 443]);
  assert.equal(ss.scanInfo().max, 50);
  // prune 이 지우면 다시 받을 자리가 생긴다(개수 캐시가 삭제를 따라간다)
  ss.pruneScanResults(0.00001); // 보존 약 1초 — TS 는 과거라 전부 지워진다
  assert.equal(Object.keys(ss.getScanResults()).length, 0);
  const again = ss.mergeScanResults([{ ip: '10.70.1.1' }], TS + 2000, 'e1');
  assert.equal(again.capped, 0);
});

test('CEN2603-02 — /ip-scan-result: 배정 범위가 없는 개별 토큰은 409 · 배정이 있으면 받고 상한 초과는 capped 로 밝힌다', async () => {
  const r = await post('/ip-scan-result', { agent: 'edgeS', alive: [{ ip: '10.80.0.1' }] }, { token: AGENT_TOKEN_S });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.unassigned, true);
  const ss = await import('../src/ipam/scanStore.js');
  ss.saveScanSettings('edgeS', { enabled: true, ranges: ['10.80.0.0/24'] });
  const before = Object.keys(ss.getScanResults()).length;
  const alive = Array.from({ length: 70 }, (_, i) => ({ ip: `10.80.0.${i + 1}` }));
  const ok = await post('/ip-scan-result', { agent: 'edgeS', alive }, { token: AGENT_TOKEN_S });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const room = 50 - before;
  assert.equal(ok.body.merged, room);
  assert.equal(ok.body.capped, 70 - room);
  assert.equal(Object.keys(ss.getScanResults()).length, 50);
});

// ── CEN2603-03 ───────────────────────────────────────────────────────────────
test('CEN2603-03 — 원장 행이 14만이어도 buildIpamRows 가 RangeError 로 죽지 않는다(push 전개 인자 상한)', () => {
  // 상한이 큰 별도 프로세스(이 파일은 상한 50으로 돈다)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'dvc-2603a-led-'));
  const script = `
    const ss = await import(${JSON.stringify(path.join(here, '../src/ipam/scanStore.js'))});
    const N = 140000; let batch = [];
    for (let i = 0; i < N; i++) { batch.push({ ip: '10.' + ((i >> 16) & 255) + '.' + ((i >> 8) & 255) + '.' + (i & 255) }); if (batch.length === 20000) { ss.mergeScanResults(batch, 1700000000000, 'e'); batch = []; } }
    const { buildIpamRows } = await import(${JSON.stringify(path.join(here, '../src/ipam/ledger.js'))});
    try { const r = buildIpamRows({ hosts: [], vms: [], vcenters: [], datastores: [], networks: [], generatedAt: 'g1' }); console.log('ROWS=' + r.rows.length); }
    catch (e) { console.log('ERR=' + e.constructor.name + ':' + e.message); }
    process.exit(0);`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: cfg, IPAM_SCAN_RESULTS_MAX: '300000' }, encoding: 'utf8', timeout: 60_000,
  });
  assert.match(out.stdout, /ROWS=140000/, `${out.stdout}\n${out.stderr}`);
});

// ── CEN2603-04 ───────────────────────────────────────────────────────────────
test('CEN2603-04 — agentIdentity: 글자 128자 · 미검증 이름은 작은 링 · 검증된 항목은 밀지 않고 새 항목을 센다 · owners 상한', async () => {
  const m = await import('../src/central/agentIdentity.js');
  m._resetForTest();
  const long = 'h'.repeat(10_000);
  const r0 = m.noteAgentIdentity('v0', { hostname: long, peer: long });
  assert.equal(r0.hostname.length, 128); assert.equal(r0.peer.length, 128);
  for (let i = 1; i < 5; i++) m.noteAgentIdentity(`v${i}`, { verified: true });
  for (let i = 0; i < 5; i++) m.noteAgentIdentity(`u${i}`, { verified: false });
  let sum = m.agentIdentitySummary();
  assert.equal(Object.keys(sum.byAgent).length, 8, '검증 5 + 미검증 링 3');
  assert.ok(!sum.byAgent.u0 && !sum.byAgent.u1 && sum.byAgent.u4, '가장 오래된 미검증부터 밀린다');
  for (let i = 5; i < 12; i++) m.noteAgentIdentity(`v${i}`, { verified: true });
  sum = m.agentIdentitySummary();
  assert.equal(Object.keys(sum.byAgent).length, 10);
  assert.ok(Object.keys(sum.byAgent).every((k) => k.startsWith('v')), '전체 상한에 닿으면 미검증부터 밀린다');
  assert.ok(sum.byAgent.v0, '검증된 항목은 밀리지 않는다');
  assert.equal(sum.omitted.agents, 2, '검증된 것만 남으면 새 항목을 받지 않고 센다');
  assert.equal(m.noteAgentIdentity('v99', { verified: true }), null);
  // 이미 있는 이름의 갱신은 상한과 무관
  assert.ok(m.noteAgentIdentity('v3', { hostname: 'hh' }));
  for (let i = 0; i < 7; i++) m.noteVcenterOwner(`vc-${i}`, 'v0');
  sum = m.agentIdentitySummary();
  assert.equal(sum.omitted.owners, 2);
  m._resetForTest();
});

test('CEN2603-04 — /inventory 는 공유 토큰 + 모르는 이름을 미검증으로 기록한다', async () => {
  const m = await import('../src/central/agentIdentity.js');
  m._resetForTest();
  const r = await post('/inventory', { agent: 'ghost-1', vcenterId: 'vc-a', vcenter: { id: 'vc-a', name: 'A' }, source: 'mock', hosts: [], vms: [] }, { headers: { 'X-Agent-Hostname': 'x'.repeat(5000) } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  const e = m.agentIdentitySummary().byAgent['ghost-1'];
  assert.equal(e.verified, false);
  assert.equal(e.hostname.length, 128);
  m._resetForTest();
});

// ── CEN2603-05 ───────────────────────────────────────────────────────────────
test('CEN2603-05 — toString/valueOf 객체 값이 수신 경로를 500 으로 만들지 않는다(16경로 × 필드 × 공유·개별 토큰)', async () => {
  const T = { toString: 1, valueOf: 1 };
  const spec = {
    '/capacity-report': ['rows', 'meta'], '/guest-disk': ['vcenterId', 'agent', 'vcenterName', 'vms', 'spikes', 'cover', 'cursors', 'historicalInterval'],
    '/vmseries': ['vcenterId', 'vcenterName', 'generatedAt', 'chunk', 'chunks', 'records'], '/curuser': ['chunk', 'vcenterIds', 'generatedAt', 'chunks'],
    '/fleet': ['baremetal', 'generatedAt'], '/idrac-scan-progress': ['reqId'], '/idrac-scan-result': ['reqId', 'registered'],
    '/sanswitch-test-result': ['id', 'result'], '/rma-poll': ['instance', 'info', 'results', 'wait', 'assignKey', 'scheduleVersion'],
    '/rma-credential': ['credentialId', 'host', 'instance'], '/rma-result': ['reqId', 'result'], '/sanswitch-data': ['devices', 'chunk', 'chunks'],
    '/ping-result': ['vcenterId', 'results'], '/log-query-result': ['reqId'], '/capture-result': ['reqId', 'result'], '/bmstor-result': ['reqId', 'results'],
  };
  const { issueAgentToken } = await import('../src/central/agentTokens.js');
  const A = issueAgentToken('edgeT').token;
  const fails = [];
  for (const [p, fields] of Object.entries(spec)) {
    const bodies = [];
    for (const k of fields) {
      bodies.push({ agent: 'edgeT', [k]: T }, { agent: 'edgeT', [k]: [T] }, { agent: 'edgeT', [k]: { hostname: T, id: T, reqId: T } });
    }
    const all = { agent: 'edgeT' }; for (const k of fields) all[k] = [T]; bodies.push(all);
    for (const token of [TOKEN, A]) {
      for (const b of bodies) {
        const r = await post(p, b, { token });
        if (r.status >= 500) fails.push(`${r.status} ${p} ${JSON.stringify(b).slice(0, 80)} ${r.body?.message || ''}`);
      }
    }
  }
  assert.deepEqual(fails, []);
});

test('CEN2603-05 — stripCoercionTraps · strOf 단위 동작', async () => {
  const { stripCoercionTraps, strOf } = await import('../src/util/coercionTrap.js');
  const b = { a: { toString: 1 }, list: [{ valueOf: {} }, 'x', { deep: { toString: [1] } }], ok: { name: 'n' } };
  assert.equal(stripCoercionTraps(b), 3);
  assert.doesNotThrow(() => String(b.a) + String(b.list) + `${b.list[2].deep}`);
  assert.deepEqual(b.ok, { name: 'n' });
  assert.equal(strOf({ toString: 1 }), '');
  assert.equal(strOf(['a']), '');
  assert.equal(strOf(12), '12');
  assert.equal(strOf('x'.repeat(10), 4), 'xxxx');
  assert.equal(strOf(Infinity), '');
});

// ── CEN2603-06 ───────────────────────────────────────────────────────────────
test('CEN2603-06 — /ping-result 는 사이트 위임으로 등록된 vCenter 만 받는다(새 id 로 결과 Map 을 밀어내지 못한다)', async () => {
  const r = await post('/ping-result', { vcenterId: 'fake-unreg-1', results: [{ ip: '10.0.0.1', alive: true }] });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  const ok = await post('/ping-result', { vcenterId: 'vc-a', results: [{ ip: '10.0.0.1', alive: true, rttMs: 1 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const { getPingResults } = await import('../src/central/pingJobs.js');
  assert.equal(getPingResults('vc-a', ['10.0.0.1'])['10.0.0.1'].state, 'up');
  for (let i = 0; i < 300; i++) await post('/ping-result', { vcenterId: `fake-${i}`, results: [{ ip: '10.0.0.2', alive: true }] });
  assert.equal(getPingResults('vc-a', ['10.0.0.1'])['10.0.0.1'].state, 'up', '등록되지 않은 id 가 실제 vCenter 결과를 밀어내지 못한다');
});

// ── DB2603-01 ────────────────────────────────────────────────────────────────
test('DB2603-01 — 열 추가 중 외부 잠금이면 NDJSON 으로 굳지 않고, 잠금이 풀리면 SQLite 로 동기화한다', async () => {
  const db = await import('../src/ipam/db.js');
  // 외부 리더가 읽기 트랜잭션(SHARED 잠금)을 쥔다 — 같은 프로세스의 다른 연결(파일 잠금은 연결 단위). 인덱스까지 있는 옛 스키마라
  //   잠금에 걸리는 첫 쓰기가 바로 ALTER TABLE 이다(감사 재현과 같은 지점).
  const reader = new DatabaseSync(IPAM_DB);
  reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM ip_records').get();
  const ok1 = await db.syncLedger([]);
  assert.equal(ok1, false, '잠금 중에는 실패로 보고한다');
  const info1 = await db.ledgerInfo();
  assert.equal(info1.kind, 'sqlite', 'NDJSON 폴백으로 바뀌지 않는다');
  assert.equal(info1.locked, true);
  assert.equal(info1.count, null, '개수를 지어내지 않는다');
  reader.exec('COMMIT'); reader.close();
  await new Promise((r) => setTimeout(r, 400)); // 재시도 시각(IPAM_DB_LOCK_RETRY_MS=300) 뒤
  const ok2 = await db.syncLedger([]);
  assert.equal(ok2, true);
  const info2 = await db.ledgerInfo();
  assert.equal(info2.kind, 'sqlite');
  const chk = new DatabaseSync(IPAM_DB);
  const cols = chk.prepare('PRAGMA table_info(ip_records)').all().map((c) => c.name);
  chk.close();
  for (const c of db.MIGRATE_COLUMNS) assert.ok(cols.includes(c), `열 ${c} 이 추가돼야 한다`);
  assert.equal(fs.existsSync(path.join(CFG, 'ipam.ndjson')), false);
});

test('DB2603-01 — migrateIpRecordColumns: 없는 열만 추가 · 이미 있으면 아무것도 안 함 · 그 밖의 오류는 던진다', async () => {
  const { migrateIpRecordColumns, MIGRATE_COLUMNS } = await import('../src/ipam/db.js');
  const mem = new DatabaseSync(':memory:');
  mem.exec('CREATE TABLE ip_records (ip TEXT, scope TEXT)');
  assert.deepEqual(migrateIpRecordColumns(mem), MIGRATE_COLUMNS.filter((c) => c !== 'scope'));
  assert.deepEqual(migrateIpRecordColumns(mem), []);
  const noTable = new DatabaseSync(':memory:');
  assert.throws(() => migrateIpRecordColumns(noTable), /no such table/);
  mem.close(); noTable.close();
});
