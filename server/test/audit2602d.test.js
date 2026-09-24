// v2.602 감사 그룹 d — 수집기·파서 정확성 + 정규식 선형성.
//   RECENT2602-02 PowerMax '미수집' 경보 · LEFT2602-04 iDRAC 섀시 Power 부분 합 · COL-2602-01 NSX 클러스터 상태 실패 ·
//   COL-2602-04 XtremIO 33번째 이후 클러스터 · SEC2602-02 PDU parseCode · SEC2602-03 bmstor sanitizeMounts ·
//   EDGE2602-05 PDU '지금 수집' 실패도 즉시 push.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2602d-'));
process.env.CONFIG_DIR = TMP;
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv.address().port)));
const json = (r, o, s = 200) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };

test('SEC2602-02: PDU parseCode 는 빈 줄 8만 개에서도 선형이고 결과는 예전과 같다', async () => {
  const { parseCode, parseReading } = await import('../src/pdu/parse.js');
  const t0 = performance.now();
  const r = parseCode('\n'.repeat(80000) + 'x');
  const ms = performance.now() - t0;
  assert.deepEqual(r, { code: '', ok: false, message: '' });
  assert.ok(ms < 150, `parseCode ${ms.toFixed(1)}ms`);
  const t1 = performance.now();
  parseReading(' \r\n'.repeat(40000) + 'x');
  assert.ok(performance.now() - t1 < 150);
  // 동작 보존
  assert.deepEqual(parseCode('apc>tempReading 1:C\nE000: Success\n22.9 C'), { code: 'E000', ok: true, message: 'Success' });
  assert.deepEqual(parseCode('  E102: Parameter Error\r\n'), { code: 'E102', ok: false, message: 'Parameter Error' });
  assert.equal(parseReading('apc>devReading 1:power\nE000: Success\n1.98 kW').value, 1.98);
});

test('SEC2602-03: bmstor sanitizeMounts 는 길이를 먼저 보고 긴 슬래시 입력에서 선형이다', async () => {
  const { sanitizeMounts } = await import('../src/bmstor/collect.js');
  const t0 = performance.now();
  const r = sanitizeMounts(['/'.repeat(80000) + 'x']);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `sanitizeMounts ${ms.toFixed(1)}ms`);
  assert.equal(r.mounts.length, 0);
  assert.match(r.errors[0], /너무 김/);
  const t1 = performance.now();
  sanitizeMounts(['/a' + '/'.repeat(200)]);   // 256 이하 — 정상 경로
  assert.ok(performance.now() - t1 < 150);
  // 동작 보존: 끝 슬래시 제거 · 루트 유지 · 슬래시만 있는 값은 버림 · 금지 문자 거부
  assert.deepEqual(sanitizeMounts('/data/,/,//,/var/log//').mounts, ['/data', '/', '/var/log']);
  assert.equal(sanitizeMounts(['/a;rm']).errors.length, 1);
});

test('LEFT2602-04: iDRAC 섀시 하나의 Power 조회 실패는 부분 합으로 밝힌다(404 는 정상 건너뜀)', async () => {
  const { fetchPower } = await import('../src/idrac/redfish.js');
  let bStatus = 503;
  const srv = http.createServer((q, r) => {
    if (q.url === '/redfish/v1/Chassis') return json(r, { Members: [{ '@odata.id': '/redfish/v1/Chassis/A' }, { '@odata.id': '/redfish/v1/Chassis/B' }] });
    if (q.url === '/redfish/v1/Chassis/A/Power') return json(r, { PowerControl: [{ PowerConsumedWatts: 300 }] });
    if (q.url === '/redfish/v1/Chassis/B/Power') return json(r, { error: 'x' }, bStatus);
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  try {
    const host = `http://127.0.0.1:${port}`;
    const p = await fetchPower({ host, username: 'u', password: 'p' });
    assert.equal(p.watts, 300);
    assert.equal(p.partial, true);
    assert.equal(p.failedChassis, 1);
    bStatus = 404;   // Power 가 없는 섀시 — 부분 합이 아니다
    const q = await fetchPower({ host, username: 'u', password: 'p' });
    assert.equal(q.watts, 300);
    assert.equal(q.partial, undefined);
  } finally { srv.close(); }
});

test('COL-2602-01: NSX cluster/status 실패는 connected·노드 1 이 아니라 unknown·null 이고 listsFailed 에 실린다', async () => {
  const { collectFromNsx, clusterHealth, clusterNodeCount } = await import('../src/nsx/client.js');
  const srv = http.createServer((q, r) => {
    if (q.url.startsWith('/api/v1/node')) return json(r, { node_version: '4.1' });
    r.statusCode = 500; r.end('boom');
  });
  const port = await listen(srv);
  try {
    const s = await collectFromNsx({ id: 'm1', name: 'm1', host: `http://127.0.0.1:${port}`, username: 'a', password: 'b' });
    assert.equal(s.manager.status, 'unknown');
    assert.equal(s.manager.nodeCount, null);
    assert.ok(s.manager.listsFailed.includes('clusterStatus'));
  } finally { srv.close(); }
  // 응답은 왔는데 상태 필드가 없는 구버전 페이로드는 예전대로
  assert.equal(clusterHealth({}), 'connected');
  assert.equal(clusterNodeCount({}), 1);
  assert.equal(clusterHealth({ mgmt_cluster_status: { status: 'STABLE', online_nodes: [1, 2, 3] } }), 'connected');
  assert.equal(clusterNodeCount({ mgmt_cluster_status: { status: 'STABLE', online_nodes: [1, 2, 3] } }), 3);
});

test('COL-2602-04: XtremIO 33번째 이후 클러스터도 합계에 들어가고 표시에서 뺀 개수·조회 상한 초과를 밝힌다', async () => {
  const { normalizeXtremio } = await import('../src/storage/collectors/xtremio.js');
  const clusters = Array.from({ length: 34 }, (_, i) => ({ name: `c${i}`, 'ud-ssd-space': 1000, 'ud-ssd-space-in-use': 500 }));
  const s = normalizeXtremio({ id: 'x', type: 'xtremio', host: 'h' }, { clusters });
  assert.equal(s.capacity.totalBytes, 34 * 1000 * 1024);
  assert.equal(s.capacity.usedBytes, 34 * 500 * 1024);
  assert.equal(s.pools.length, 32);
  assert.equal(s.extra.poolsOmitted, 2);
  // collect 의 조회 상한(8)으로 조회하지 않은 클러스터는 합계에서 빠졌다고 밝힌다
  const s2 = normalizeXtremio({ id: 'x', type: 'xtremio', host: 'h' }, { clusters: clusters.slice(0, 8), clustersNotQueried: 3 });
  assert.equal(s2.extra.clustersNotQueried, 3);
  assert.equal(s2.extra.poolsUnreadable, 3);
  assert.equal(s2.extra.poolsOmitted, undefined);
});

test('RECENT2602-02: PowerMax 경보 개수를 못 찾으면 섹션 사유가 출력에 닿고 unresolved 는 null 이다', async () => {
  const dir = path.join(TMP, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem')], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (q, r) => {
    const u = q.url;
    if (u === '/univmax/restapi/version') return json(r, { version: 'V10.0.0.0' });
    if (/\/system\/symmetrix$/.test(u)) return json(r, { symmetrixId: [] });
    if (/\/system\/alert/.test(u)) return json(r, { symmAlertSummary: [{ alert_count: 5 }] });   // 미확인 개수 없음
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  process.env.STORAGE_UNISPHERE_PORT = String(port);
  try {
    const { collect } = await import('../src/storage/collectors/powermax.js');
    const out = await collect({ id: 'pm', type: 'powermax', host: '127.0.0.1', username: 'u', password: 'p' });
    assert.match(String(out.sections.alerts), /^미수집/);
    assert.equal(out.alerts.unresolved, null);
  } finally { srv.close(); delete process.env.STORAGE_UNISPHERE_PORT; }
});

test('EDGE2602-05: PDU 지금 수집이 실패해도 결과(실패 스냅샷)를 즉시 push 한다', async () => {
  const { config } = await import('../src/config.js');
  const posts = [];
  const srv = http.createServer((q, r) => {
    if (q.method === 'GET' && q.url.startsWith('/api/central/pdu-config')) {
      return json(r, {
        devices: [{ id: 'pdu-a', name: 'a', host: '127.0.0.1', sshPort: 1, username: 'u', password: 'p', agent: 'edge-d' }],
        collectNow: ['pdu-a'],
      });
    }
    if (q.method === 'POST') { q.resume(); q.on('end', () => { posts.push(q.url); json(r, { ok: true }); }); return; }
    return json(r, {}, 404);
  });
  const port = await listen(srv);
  const prev = { ...config.agent };
  config.agent.centralUrl = `http://127.0.0.1:${port}`;
  config.agent.centralToken = 'tok';
  config.agent.name = 'edge-d';
  try {
    const { pullPduConfigNow } = await import('../src/agent/pduConfigPull.js');
    const res = await pullPduConfigNow();
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.collected, 0);          // 수집은 실패했다(닫힌 포트)
    assert.ok(posts.some((u) => u.startsWith('/api/central/pdu-data')), `push 없음: ${JSON.stringify(posts)}`);
  } finally { Object.assign(config.agent, prev); srv.close(); }
});
